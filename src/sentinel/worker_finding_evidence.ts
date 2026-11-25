/** Match retained control verification to the exact finding and affected asset. */

import { isSentinelCaseId } from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";
import { readSentinelCaseFindingReceipts } from "./worker_finding_store.ts";

export interface SentinelWorkerFindingRecheckScope {
  readonly caseId: string;
  readonly evidenceRevision: number;
  readonly evaluatedAt: string;
}

export interface SentinelWorkerFindingRecheckClaim {
  readonly findingId: string;
  readonly assetId: string;
  readonly controlId: string;
  readonly evidenceId: string;
}

export interface SentinelWorkerFindingRecheckReceipt
  extends SentinelWorkerFindingRecheckScope, SentinelWorkerFindingRecheckClaim {
  readonly snapshotDigest: string;
  readonly outcome: "pass" | "fail";
  readonly observedAt: string;
  readonly validUntil: string;
}

type Graph = ReturnType<typeof loadSentinelGraph>;
type Snapshot = ReturnType<Graph["snapshot"]>;
type Node = Snapshot["nodes"][number];
type Evidence = Extract<Node, { kind: "evidence" }>;
type Verification = NonNullable<Evidence["controlVerification"]>;

/** Resolve only a uniquely linked asset for an imported verification receipt. */
export function executionFindingAsset(
  snapshot: Snapshot,
  evidenceId: string,
): string | undefined {
  if (
    !snapshot.nodes.some((node) =>
      node.id === evidenceId &&
      node.kind === "evidence" &&
      (node.executionSource || node.nativeWorkflowSource) &&
      node.controlVerification
    )
  ) return;
  const assets = new Set(
    snapshot.edges.flatMap(({ from, to, relation }) =>
      from === evidenceId && relation === "observed_on" ? [to] : []
    ),
  );
  return assets.size === 1 ? assets.values().next().value : undefined;
}

export const MAX_SENTINEL_WORKER_FINDING_RECHECK_PAGE = 20;

function exactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 4096 && value.trim() === value && !value.includes("\x00");
}

function verifyScope(scope: SentinelWorkerFindingRecheckScope): boolean {
  return typeof scope.caseId === "string" && isSentinelCaseId(scope.caseId) &&
    Number.isSafeInteger(scope.evidenceRevision) &&
    scope.evidenceRevision > 0 &&
    typeof scope.evaluatedAt === "string";
}

function compareChecks(
  left: { readonly evidenceId: string; readonly verification: Verification },
  right: { readonly evidenceId: string; readonly verification: Verification },
): number {
  return right.verification.observedAt.localeCompare(
    left.verification.observedAt,
  ) ||
    left.verification.outcome.localeCompare(right.verification.outcome) ||
    right.verification.validUntil.localeCompare(left.verification.validUntil) ||
    (left.evidenceId < right.evidenceId
      ? -1
      : left.evidenceId === right.evidenceId
      ? 0
      : 1);
}

function matchSnapshot(
  input: unknown,
  scope: SentinelWorkerFindingRecheckScope,
  findingId: string,
  assetId: string,
  controlId?: string,
  withinBranch?: (node: Evidence) => boolean,
) {
  if (
    !verifyScope(scope) || !exactId(findingId) || !exactId(assetId) ||
    (controlId !== undefined && !exactId(controlId))
  ) return undefined;
  const graph = loadSentinelGraph(input);
  const snapshot = graph.snapshot();
  if (
    !snapshot.edges.some(({ relation, from, to }) =>
      relation === "affects" && from === findingId && to === assetId
    )
  ) return undefined;
  const { asOf: evaluatedAt } = graph.controlCoverage(
    findingId,
    scope.evaluatedAt,
  );
  const controls = new Set(
    snapshot.edges.flatMap(({ relation, from, to }) =>
      relation === "mitigates" && to === findingId &&
        (controlId === undefined || from === controlId)
        ? [from]
        : []
    ),
  );
  const observed = new Set(
    snapshot.edges.flatMap(({ relation, from, to }) =>
      relation === "observed_on" && to === assetId ? [from] : []
    ),
  );
  const checks = new Map(
    snapshot.nodes.flatMap((node) =>
      node.kind === "evidence" && node.controlVerification &&
        node.controlVerification.observedAt <= evaluatedAt &&
        observed.has(node.id) && (!withinBranch || withinBranch(node))
        ? [[node.id, node.controlVerification] as const]
        : []
    ),
  );
  const latest = new Map<
    string,
    { evidenceId: string; verification: Verification }
  >();
  for (const { relation, from, to } of snapshot.edges) {
    if (relation !== "verifies" || !controls.has(to)) continue;
    const verification = checks.get(from);
    if (!verification) continue;
    const candidate = { evidenceId: from, verification };
    const previous = latest.get(to);
    if (!previous || compareChecks(candidate, previous) < 0) {
      latest.set(to, candidate);
    }
  }
  const snapshotDigest = digestSentinelSnapshot(snapshot);
  const receipts: SentinelWorkerFindingRecheckReceipt[] = [];
  for (const id of [...latest.keys()].sort()) {
    const check = latest.get(id)!;
    if (evaluatedAt >= check.verification.validUntil) continue;
    receipts.push({
      caseId: scope.caseId,
      evidenceRevision: scope.evidenceRevision,
      evaluatedAt,
      snapshotDigest,
      findingId,
      assetId,
      controlId: id,
      evidenceId: check.evidenceId,
      ...check.verification,
    });
  }
  return { receipts, snapshotDigest, evaluatedAt };
}

/** Read a bounded sorted page of current checks for one exact affected asset. */
export function readWorkerFindingRechecks(
  snapshot: unknown,
  scope: SentinelWorkerFindingRecheckScope,
  query: {
    readonly findingId: string;
    readonly assetId: string;
    readonly afterControlId?: string;
    readonly snapshotDigest?: string;
    readonly limit?: number;
  },
) {
  const limit = query.limit ?? MAX_SENTINEL_WORKER_FINDING_RECHECK_PAGE;
  if (
    !Number.isSafeInteger(limit) || limit <= 0 ||
    limit > MAX_SENTINEL_WORKER_FINDING_RECHECK_PAGE ||
    (query.afterControlId !== undefined &&
      (!exactId(query.afterControlId) || query.snapshotDigest === undefined))
  ) return undefined;
  const matched = matchSnapshot(
    snapshot,
    scope,
    query.findingId,
    query.assetId,
  );
  if (
    !matched || query.snapshotDigest !== undefined &&
      query.snapshotDigest !== matched.snapshotDigest
  ) return undefined;
  const available = matched.receipts.filter(({ controlId }) =>
    query.afterControlId === undefined || controlId > query.afterControlId
  );
  const receipts = available.slice(0, limit);
  return {
    snapshotDigest: matched.snapshotDigest,
    evaluatedAt: matched.evaluatedAt,
    receipts,
    nextControlId: available.length > limit ? receipts.at(-1)!.controlId : null,
  };
}

/** Derive a check receipt from evidence. Outcome and timestamps are never supplied by the claimant. */
export function verifyWorkerFindingRecheck(
  snapshot: unknown,
  scope: SentinelWorkerFindingRecheckScope,
  claim: SentinelWorkerFindingRecheckClaim,
  withinBranch?: (node: Evidence) => boolean,
): SentinelWorkerFindingRecheckReceipt | undefined {
  if (!exactId(claim.controlId) || !exactId(claim.evidenceId)) return undefined;
  const matched = matchSnapshot(
    snapshot,
    scope,
    claim.findingId,
    claim.assetId,
    claim.controlId,
    withinBranch,
  );
  return matched?.receipts.find(({ evidenceId }) =>
    evidenceId === claim.evidenceId
  );
}

/** Reopen the exact immutable pass and replay it against the supplied snapshot. */
export function readVerifiedPassingFindingRecheck(
  path: string,
  snapshot: Snapshot,
  scope: SentinelWorkerFindingRecheckScope & {
    readonly runId: string;
    readonly targetId: string;
  },
  id: string,
) {
  const receipt = readSentinelCaseFindingReceipts(path, [id]).get(id);
  if (
    receipt?.kind !== "recheck" || receipt.outcome !== "pass" ||
    receipt.caseId !== scope.caseId || receipt.runId !== scope.runId ||
    receipt.evidenceRevision !== scope.evidenceRevision ||
    receipt.targetId !== scope.targetId
  ) return;
  const original = readSentinelCaseFindingReceipts(path, [receipt.findingId])
    .get(receipt.findingId);
  if (
    original?.kind !== "finding" || original.caseId !== receipt.caseId ||
    original.runId !== receipt.runId ||
    original.targetId !== receipt.targetId ||
    original.evidenceRevision > receipt.evidenceRevision ||
    original.graphFindingId !== receipt.graphFindingId ||
    original.controlId !== receipt.controlId
  ) return;
  const verified = verifyWorkerFindingRecheck(snapshot, scope, {
    findingId: receipt.graphFindingId,
    assetId: receipt.targetId,
    controlId: receipt.controlId,
    evidenceId: receipt.evidenceId,
  });
  if (
    verified?.outcome === "pass" &&
    verified.snapshotDigest === receipt.snapshotDigest &&
    verified.observedAt === receipt.observedAt &&
    verified.validUntil === receipt.validUntil
  ) return receipt;
}
