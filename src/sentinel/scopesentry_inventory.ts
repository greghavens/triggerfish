/** Project retained ScopeSentry results into Sentinel's typed inventory. */
import {
  assetText,
  canonicalAssetDomain,
  canonicalAssetIp,
  canonicalAssetUrl,
  parseSentinelAssetProperties,
} from "./asset_properties.ts";
import {
  assetIdentityIndex,
  type GraphNode,
  loadSentinelGraph,
} from "./graph.ts";
import { createHash } from "node:crypto";

type Asset = Extract<GraphNode, { kind: "asset" }>;
type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
export const scopeSentryKinds = ["subdomain", "app", "asset"] as const;
type Kind = typeof scopeSentryKinds[number];

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function optional(
  value: unknown,
  canonicalize: (value: string) => string | undefined = (value) => value,
) {
  const input = assetText(value);
  const text = input && canonicalize(input);
  return text ? [text] : undefined;
}

function candidates(value: unknown, kind: Kind): Asset[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const reportedDomain = optional(
    kind === "subdomain" ? row.host : row.domain,
    canonicalAssetDomain,
  );
  const url = optional(row.url, canonicalAssetUrl);
  if (kind === "asset" && row.url && !url) return [];
  const domain = url
    ? optional(new URL(url[0]).hostname, canonicalAssetDomain)
    : reportedDomain;
  const ipValues = Array.isArray(row.ip) ? row.ip.slice(0, 12) : [row.ip];
  const ip = ipValues.flatMap((value) =>
    optional(value, canonicalAssetIp) ?? []
  );
  const name = assetText(row.name);
  const service = optional(row.service);
  const port = typeof row.port === "string" && /^\d{1,5}$/.test(row.port)
    ? Number(row.port)
    : row.port;
  const numberIn = (value: unknown, min: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) &&
      value >= min && value <= max
      ? [value]
      : undefined;
  const technology = Array.isArray(row.products)
    ? row.products.slice(0, 12).flatMap((item) => optional(item) ?? [])
    : [];
  let fields: Record<string, unknown>;
  let label: string | undefined;
  let assetType: Asset["assetType"];
  switch (kind) {
    case "subdomain":
      label = domain?.[0];
      assetType = "subdomain";
      fields = {
        domain,
        recordType: optional(
          row.type,
          (value) => /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value : undefined,
        ),
      };
      break;
    case "app":
      label = name;
      assetType = "application";
      fields = {
        appName: optional(row.name),
        category: optional(row.category),
        registrationId: optional(row.icp),
        appRegistrationId: optional(row.icp),
      };
      break;
    case "asset":
      label = url?.[0] ??
        ((domain?.[0] || ip[0]) && numberIn(port, 1, 65535)
          ? `${domain?.[0] || ip[0]}:${port}`
          : undefined);
      assetType = "service";
      fields = {
        domain,
        url,
        service,
        serviceType: [url ? "http" : "other"],
        port: numberIn(port, 1, 65535),
        status: numberIn(row.status, 100, 599),
        title: optional(row.title),
        technology: technology.length ? technology : undefined,
      };
      break;
  }
  const assets: Asset[] = [];
  const properties = parseSentinelAssetProperties(Object.fromEntries(
    Object.entries(fields).filter(([, item]) => item !== undefined),
  ));
  if (label) {
    assets.push({
      kind: "asset",
      id: `scopesentry:${assetType}:${digest(label)}`,
      assetType,
      label,
      ...(properties && { properties }),
    });
  }
  if (kind !== "app") {
    for (const address of ip) {
      assets.push({
        kind: "asset",
        id: `scopesentry:ip:${digest(address)}`,
        assetType: "ip",
        label: address,
        properties: { ip: [address] },
      });
    }
  }
  return assets;
}

export function stageScopeSentryInventory(
  snapshot: Snapshot,
  selections: readonly {
    readonly kind: Kind;
    readonly page: number;
    readonly text: string;
  }[],
  { dimension, sourceId }: {
    readonly dimension: string;
    readonly sourceId: string;
  },
  permitted: (asset: Asset) => boolean,
) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const identities = assetIdentityIndex(
    snapshot.nodes.filter((node): node is Asset => node.kind === "asset").map(
      (asset) => ({
        id: asset.id,
        aliases: [...asset.aliases ?? [], asset.label],
      }),
    ),
  );
  const edges = new Map(
    snapshot.edges.map((edge) => [JSON.stringify(edge), edge]),
  );
  let imported = 0;
  for (const { kind, page, text } of selections) {
    if (text.length > 500_000) return;
    const response = JSON.parse(text);
    if (!Array.isArray(response?.list) || response.list.length > 100) return;
    for (const [index, value] of response.list.entries()) {
      const admitted = candidates(value, kind).filter(permitted).flatMap(
        (asset) => {
          const match = identities.get(asset.label);
          if (match === null) return [];
          const id = match ?? asset.id;
          const existing = nodes.get(id);
          if (
            existing && (existing.kind !== "asset" || !permitted(existing) ||
              (existing.assetType && existing.assetType !== asset.assetType))
          ) return [];
          return [{ ...asset, id }];
        },
      );
      if (!admitted.length) continue;
      const source = digest({
        dimension,
        sourceId,
        kind,
        page,
        index,
        admitted,
      });
      const evidenceId = `scopesentry:evidence:${source}`;
      if (!nodes.has(evidenceId)) imported++;
      nodes.set(evidenceId, {
        id: evidenceId,
        kind: "evidence",
        label:
          `ScopeSentry ${dimension} ${sourceId} · ${kind} page ${page} record ${
            index + 1
          } · ${source}`,
      });
      for (const asset of admitted) {
        const existing = nodes.get(asset.id);
        if (existing?.kind === "asset") {
          if (asset.properties) {
            nodes.set(asset.id, {
              ...existing,
              properties: { ...existing.properties, ...asset.properties },
            });
          }
        } else {
          nodes.set(asset.id, asset);
          identities.set(asset.label, asset.id);
          identities.set(asset.id, asset.id);
        }
        const edge = {
          from: evidenceId,
          to: asset.id,
          relation: "observed_on" as const,
        };
        edges.set(JSON.stringify(edge), edge);
      }
    }
  }
  return {
    imported,
    snapshot: loadSentinelGraph({
      version: 1,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
    }).snapshot(),
  };
}
