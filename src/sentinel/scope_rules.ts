/** Match reviewed membership rules against properties of already retained assets. */
import { BlockList, isIP } from "node:net";
import {
  assetText,
  canonicalAssetDomain,
  canonicalAssetIp,
  canonicalAssetUrl,
  type SentinelAssetProperties,
  sentinelAssetPropertyValues,
} from "./asset_properties.ts";

export const sentinelScopeRuleKinds = [
  "domain",
  "url",
  "ip",
  "cidr",
  "registrationId",
  "keyword",
] as const;

export interface SentinelScopeRule {
  readonly kind: typeof sentinelScopeRuleKinds[number];
  readonly value: string;
}

function normalizeNetwork(value: string): string | undefined {
  const [address, bits, ...extra] = value.split("/");
  if (extra.length || !bits || !/^\d{1,3}$/.test(bits)) return;
  const canonical = canonicalAssetIp(address);
  const family = canonical ? isIP(canonical) : 0;
  const prefix = Number(bits);
  if (
    !canonical || (family === 4 && (prefix < 16 || prefix > 32)) ||
    (family === 6 && (prefix < 32 || prefix > 128))
  ) return;
  return `${canonical}/${prefix}`;
}

export function parseSentinelScopeRules(
  input: unknown,
): SentinelScopeRule[] | undefined {
  if (!Array.isArray(input) || !input.length || input.length > 32) return;
  const unique = new Map<string, SentinelScopeRule>();
  for (const item of input) {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).length !== 2
    ) return;
    const kind = sentinelScopeRuleKinds.find((candidate) =>
      candidate === item.kind
    );
    const raw = assetText(item.value);
    if (!kind || !raw) return;
    const value = kind === "domain"
      ? canonicalAssetDomain(raw)
      : kind === "url"
      ? canonicalAssetUrl(raw)
      : kind === "ip"
      ? canonicalAssetIp(raw)
      : kind === "cidr"
      ? normalizeNetwork(raw)
      : raw.toLowerCase();
    if (!value || (kind === "keyword" && value.length < 3)) return;
    unique.set(`${kind}:${value}`, { kind, value });
  }
  return [...unique.keys()].sort().map((key) => unique.get(key)!);
}

type ScopeAsset = {
  readonly id: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly properties?: SentinelAssetProperties;
};

/** Compile a bounded OR of reviewed rules. Only case rules use keyword matches. */
export function sentinelScopeMatcher(
  rules: readonly SentinelScopeRule[],
  company = false,
): (asset: ScopeAsset) => boolean {
  const tests = rules.flatMap(
    ({ kind, value }): ((asset: ScopeAsset) => boolean)[] => {
      if (kind === "keyword") {
        return company
          ? []
          : [(asset) =>
            [asset.label, ...(asset.properties?.title ?? [])].some((
              candidate,
            ) => candidate.normalize("NFC").toLowerCase().includes(value))];
      }
      if (kind === "cidr") {
        const [address, bits] = value.split("/");
        const list = new BlockList();
        const family = isIP(address) === 4 ? "ipv4" : "ipv6";
        list.addSubnet(address, Number(bits), family);
        return [
          (asset) =>
            sentinelAssetPropertyValues(asset, "ip").some((ip) =>
              (isIP(ip) === 4 ? "ipv4" : "ipv6") === family &&
              list.check(ip, family)
            ),
        ];
      }
      if (kind === "domain") {
        return [
          (asset) =>
            sentinelAssetPropertyValues(asset, "domain").some((name) =>
              name === value || name.endsWith(`.${value}`)
            ),
        ];
      }
      return [
        (asset) => sentinelAssetPropertyValues(asset, kind).includes(value),
      ];
    },
  );
  return (asset) => tests.some((test) => test(asset));
}
