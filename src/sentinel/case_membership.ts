/** Resolve explicitly selected defensive case members from one saved inventory. */
import { isDeepStrictEqual } from "node:util";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { isSentinelCaseId } from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";

import { assetText } from "./asset_properties.ts";
import {
  parseSentinelScopeRules,
  sentinelScopeMatcher,
  type SentinelScopeRule,
} from "./scope_rules.ts";

const maxMembers = 128;

type ExactSentinelCaseMembershipSelector =
  | { readonly kind: "assets"; readonly assetIds: readonly string[] }
  | { readonly kind: "organization"; readonly organizationId: string };

export type SentinelCaseMembershipSelector =
  | ExactSentinelCaseMembershipSelector
  | {
    readonly kind: "rules";
    readonly organizationId?: string;
    readonly rules: readonly SentinelScopeRule[];
    readonly reason: string;
  }
  | {
    readonly kind: "addition";
    readonly baselineAssetIds: readonly string[];
    readonly addition: ExactSentinelCaseMembershipSelector;
    readonly reason: string;
  };

export interface SentinelCaseMembershipScope {
  readonly caseId: string;
  readonly evidenceRevision: number;
}

export interface SentinelCaseMembershipProof
  extends SentinelCaseMembershipScope {
  readonly snapshotDigest: string;
  readonly selector: SentinelCaseMembershipSelector;
  readonly assetIds: readonly string[];
  readonly overflow?: true;
  readonly sources: readonly {
    readonly assetId: string;
    readonly organization?: { readonly id: string; readonly label: string };
  }[];
}

function exactId(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit &&
    !value.includes("\0");
}

function normalizeExactSelector(
  value: unknown,
): ExactSentinelCaseMembershipSelector | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const selector = value as Record<string, unknown>;
  if (Object.keys(selector).length !== 2) return;
  if (
    selector.kind === "assets" && Array.isArray(selector.assetIds) &&
    selector.assetIds.length <= maxMembers &&
    selector.assetIds.every((id) => exactId(id, 512))
  ) {
    return {
      kind: "assets",
      assetIds: [...new Set<string>(selector.assetIds)].sort(),
    };
  }
  if (
    selector.kind === "organization" && exactId(selector.organizationId, 256)
  ) {
    return { kind: "organization", organizationId: selector.organizationId };
  }
  return;
}

function normalizeSelector(
  value: unknown,
): SentinelCaseMembershipSelector | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const selector = value as Record<string, unknown>;
  if (selector.kind === "rules") {
    const rules = parseSentinelScopeRules(selector.rules);
    const reason = assetText(selector.reason);
    if (
      !rules || !reason || Object.keys(selector).some((key) =>
        !["kind", "organizationId", "rules", "reason"].includes(key)
      ) ||
      (selector.organizationId !== undefined &&
        !assetText(selector.organizationId, 256))
    ) {
      return;
    }
    return {
      kind: "rules",
      ...(typeof selector.organizationId === "string" && {
        organizationId: selector.organizationId,
      }),
      rules,
      reason,
    };
  }
  if (selector.kind !== "addition") return normalizeExactSelector(value);
  const addition = normalizeExactSelector(selector.addition);
  const baseline = normalizeExactSelector({
    kind: "assets",
    assetIds: selector.baselineAssetIds,
  });
  if (
    Object.keys(selector).length !== 4 || !addition ||
    baseline?.kind !== "assets" ||
    !exactId(selector.reason, 512) ||
    selector.reason.trim() !== selector.reason ||
    /[\p{Cc}\p{Cf}]/u.test(selector.reason) ||
    redactCredentialText(selector.reason) !== selector.reason
  ) return;
  return {
    kind: "addition",
    baselineAssetIds: baseline.assetIds,
    addition,
    reason: selector.reason,
  };
}

/** Source entries are exact declarations beneath the proof's case and snapshot. */
export function resolveSentinelCaseMembership(
  snapshot: unknown,
  input: SentinelCaseMembershipScope & { readonly selector: unknown },
): SentinelCaseMembershipProof | undefined {
  const { caseId, evidenceRevision } = input;
  if (
    !isSentinelCaseId(caseId) || !Number.isSafeInteger(evidenceRevision) ||
    evidenceRevision < 1
  ) return undefined;
  const selector = normalizeSelector(input.selector);
  if (!selector) return undefined;
  try {
    const graph = loadSentinelGraph(snapshot).snapshot();
    const assets = graph.nodes.filter((node) => node.kind === "asset");
    const baseIds = selector.kind === "addition"
      ? selector.baselineAssetIds
      : [];
    const requested = selector.kind === "addition"
      ? selector.addition
      : selector;
    const requestedIds = new Set(
      requested.kind === "assets" ? requested.assetIds : [],
    );
    const company = requested.kind === "rules" && requested.organizationId;
    const declaredCompany = company
      ? assets.find((asset) => asset.organization?.id === company)?.organization
      : undefined;
    const companyIsCurrent = !company || !!declaredCompany &&
        !assets.some((asset) =>
          asset.organization?.id === company &&
          asset.organization.label !== declaredCompany.label
        );
    const matches = requested.kind === "rules"
      ? sentinelScopeMatcher(requested.rules, !!company)
      : undefined;
    const additions = requested.kind === "rules"
      ? assets.filter((asset) =>
        companyIsCurrent &&
        (!company || !asset.organization ||
          asset.organization.id === company) &&
        matches?.(asset) === true
      )
      : requested.kind === "organization"
      ? assets.filter((asset) =>
        asset.organization?.id === requested.organizationId
      )
      : assets.filter((asset) => requestedIds.has(asset.id));
    if (
      requested.kind === "assets"
        ? additions.length !== requestedIds.size
        : requested.kind === "organization" && !additions.length
    ) return;
    const selectedIds = new Set([...baseIds, ...additions.map(({ id }) => id)]);
    const selected = assets.filter(({ id }) => selectedIds.has(id));
    const overflow = selector.kind === "rules" && selected.length > maxMembers;
    if (
      selected.length !== selectedIds.size ||
      (!overflow && selected.length > maxMembers) ||
      (selector.kind === "addition" && selected.length === baseIds.length) ||
      selected.some(({ id }) => !exactId(id, 512))
    ) return;
    const sources = (overflow ? [] : selected).map(
      ({ id, organization: declared }) => {
        const organization = declared ?? declaredCompany;
        return {
          assetId: id,
          ...(organization && {
            organization: { id: organization.id, label: organization.label },
          }),
        };
      },
    ).sort((a, b) =>
      a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0
    );
    return {
      caseId,
      evidenceRevision,
      snapshotDigest: digestSentinelSnapshot(graph),
      selector,
      assetIds: sources.map(({ assetId }) => assetId),
      ...(overflow && { overflow: true as const }),
      sources,
    };
  } catch {
    return undefined;
  }
}

/** Rebuild all source declarations in the independently selected saved scope. */
export function verifySentinelCaseMembership(
  snapshot: unknown,
  proof: unknown,
  scope: SentinelCaseMembershipScope,
): boolean {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const record = proof as Record<string, unknown>;
  if (
    record.caseId !== scope.caseId ||
    record.evidenceRevision !== scope.evidenceRevision
  ) {
    return false;
  }
  const exact = resolveSentinelCaseMembership(snapshot, {
    ...scope,
    selector: record.selector,
  });
  return exact !== undefined && isDeepStrictEqual(exact, proof);
}
