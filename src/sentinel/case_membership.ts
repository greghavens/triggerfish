/** Resolve explicitly selected defensive case members from one saved inventory. */
import { isDeepStrictEqual } from "node:util";
import { isSentinelCaseId } from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";

const maxMembers = 128;

export type SentinelCaseMembershipSelector =
  | { readonly kind: "assets"; readonly assetIds: readonly string[] }
  | { readonly kind: "organization"; readonly organizationId: string };

export interface SentinelCaseMembershipScope {
  readonly caseId: string;
  readonly evidenceRevision: number;
}

export interface SentinelCaseMembershipProof
  extends SentinelCaseMembershipScope {
  readonly snapshotDigest: string;
  readonly selector: SentinelCaseMembershipSelector;
  readonly assetIds: readonly string[];
  readonly sources: readonly {
    readonly assetId: string;
    readonly organization?: { readonly id: string; readonly label: string };
  }[];
}

function exactId(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit &&
    !value.includes("\0");
}

function normalizeSelector(
  value: unknown,
): SentinelCaseMembershipSelector | undefined {
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
    const requested = new Set(
      selector.kind === "assets" ? selector.assetIds : [],
    );
    const selected = selector.kind === "organization"
      ? assets.filter((asset) =>
        asset.organization?.id === selector.organizationId
      )
      : assets.filter((asset) => requested.has(asset.id));
    if (
      (selector.kind === "assets"
        ? selected.length !== requested.size
        : !selected.length) ||
      selected.length > maxMembers ||
      selected.some(({ id }) => !exactId(id, 512))
    ) return undefined;
    const sources = selected.map(({ id, organization }) => ({
      assetId: id,
      ...(organization && {
        organization: { id: organization.id, label: organization.label },
      }),
    })).sort((a, b) =>
      a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0
    );
    return {
      caseId,
      evidenceRevision,
      snapshotDigest: digestSentinelSnapshot(graph),
      selector,
      assetIds: sources.map(({ assetId }) => assetId),
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
