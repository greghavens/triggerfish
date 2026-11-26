/** Verify a fresh, same-assignment repository observation against reviewed control evidence. */
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "@std/path";
import { branchExecutionEvidenceId } from "../sentinel/case_execution_evidence.ts";
import {
  type AdaptiveTask,
  readAdaptiveRepositoryVisibility,
  readSentinelDedicatedRecheckSettlements,
} from "../sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import { createSentinelFindingRemediationReader } from "../sentinel/finding_remediation.ts";
import {
  nativeRepositoryVisibilityEvidenceId,
  repositoryControlOutcome,
  type SentinelRepositoryVisibilityReference,
} from "../sentinel/github_repository_visibility.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import {
  verifyWorkerFindingRecheck,
  withRepositoryVisibilityVerification,
} from "../sentinel/worker_finding_evidence.ts";
import {
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingHistory,
  type SentinelWorkerFindingRecord,
} from "../sentinel/worker_finding_store.ts";

/** Offer exact selectors only; no verdict is exposed in the planner prompt. */
export function listSentinelNativeRepositoryVerdictSelectors(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
) {
  const runId = state.plan.runId;
  const snapshot = state.result?.sharedGraph.snapshot;
  const caseId = locateSentinelCase(path)?.caseId;
  if (!state.active || state.paused || !runId || !caseId || !snapshot) {
    return [];
  }
  const policy = readSentinelOperatingConstraints(path, runId)?.constraints;
  const settled = readSentinelDedicatedRecheckSettlements(
    join(dirname(path), "sentinel-adaptive.db"),
    runId,
    state.revision,
  );
  return readSentinelWorkerFindingHistory(path, state.revision).flatMap(
    (record) => {
      if (
        record.kind !== "recheck" || !record.nativeRepositoryVisibility ||
        record.evidenceRevision !== state.revision || record.runId !== runId ||
        record.caseId !== caseId ||
        Date.parse(record.validUntil) <= Date.now() ||
        !sentinelOperatingConstraintsAllow(policy, {
          kind: "review_evidence",
          nodeId: record.targetId,
        }, snapshot)
      ) return [];
      const assignment = settled.get(record.taskId);
      return assignment?.completed &&
          assignment.findingId === record.findingId &&
          assignment.evidenceId === record.evidenceId
        ? [{ id: record.id, taskId: record.taskId, assetId: record.targetId }]
        : [];
    },
  ).slice(0, 6);
}

/** Resolve an active typed verdict; callers must still authorize both sources. */
export function readExactSentinelNativeRepositoryVerdict(
  path: string,
  runId: string,
  revision: number,
  assetId: string,
  verdictId: string,
) {
  const state = readSentinelAssessment(path);
  const snapshot = state?.result?.sharedGraph.snapshot;
  if (
    !state?.active || state.paused || !snapshot ||
    state.plan.runId !== runId || state.revision !== revision
  ) return;
  return readSentinelNativeRepositoryVerdict(
    path,
    runId,
    revision,
    assetId,
    verdictId,
    snapshot,
    false,
  );
}

/** Historical inspection addresses one retained revision and uses saved/current scope. */
export function readRetainedSentinelNativeRepositoryVerdict(
  path: string,
  runId: string,
  revision: number,
  assetId: string,
  verdictId: string,
) {
  if (readSentinelRunIdForRevision(path, revision) !== runId) return;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  return snapshot && readSentinelNativeRepositoryVerdict(
    path,
    runId,
    revision,
    assetId,
    verdictId,
    snapshot,
    true,
  );
}

function readSentinelNativeRepositoryVerdict(
  path: string,
  runId: string,
  revision: number,
  assetId: string,
  verdictId: string,
  snapshot: NonNullable<
    NonNullable<ReturnType<typeof readSentinelAssessment>>["result"]
  >["sharedGraph"]["snapshot"],
  historical: boolean,
) {
  const caseId = locateSentinelCase(path)?.caseId;
  if (!caseId) return;
  const record = readSentinelCaseFindingReceipts(path, [verdictId]).get(
    verdictId,
  );
  if (
    record?.kind !== "recheck" || !record.nativeRepositoryVisibility ||
    record.nativeRepositoryVisibility.verdictId ||
    record.targetId !== assetId ||
    record.runId !== runId || record.caseId !== caseId ||
    record.evidenceRevision !== revision ||
    (!historical && Date.parse(record.validUntil) <= Date.now())
  ) return;
  const assignment = readSentinelDedicatedRecheckSettlements(
    join(dirname(path), "sentinel-adaptive.db"),
    runId,
    revision,
  ).get(record.taskId);
  if (
    !assignment?.completed || assignment.findingId !== record.findingId ||
    assignment.evidenceId !== record.evidenceId
  ) return;
  const original = readSentinelCaseFindingReceipts(path, [record.findingId])
    .get(record.findingId);
  if (original?.kind !== "finding") return;
  const current = readSentinelOperatingConstraints(path, runId)?.constraints;
  const saved = historical &&
    readSentinelOperatingConstraints(path, runId, revision)?.constraints;
  const policies = saved ? [current, saved] : [current];
  if (
    !policies.every((policy) =>
      sentinelOperatingConstraintsAllow(policy, {
        kind: "review_evidence",
        nodeId: assetId,
      }, snapshot) &&
      sentinelOperatingConstraintsAllow(policy, {
        kind: "review_evidence",
        nodeId: original.evidenceId,
      }, snapshot) &&
      sentinelOperatingConstraintsAllow(policy, {
        kind: "review_finding",
        nodeId: original.graphFindingId,
      }, snapshot)
    )
  ) return;
  const checked = createSentinelFindingRemediationReader(
    path,
    record.caseId,
    revision,
    runId,
    true,
  )(original, [record]);
  if (checked.nativeSource?.id !== record.id) return;
  return {
    original,
    source: record.nativeRepositoryVisibility,
    reference: { ...record.nativeRepositoryVisibility, verdictId },
    verdict: {
      id: record.id,
      findingId: record.findingId,
      outcome: record.outcome,
      evidenceRevision: record.evidenceRevision,
      targetId: record.targetId,
    },
  };
}

export function verifySentinelNativeRepositoryRecheck(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  task: AdaptiveTask,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  authorized: SentinelRepositoryVisibilityReference,
) {
  const followup = task.plannerRound?.findingFollowup;
  const binding = followup?.nativeRepositoryVisibility;
  const snapshot = state.result?.sharedGraph.snapshot;
  if (
    !state.active || state.paused || !snapshot || !binding ||
    followup.findingId !== finding.id ||
    followup.evidenceId !== finding.evidenceId ||
    followup.assignedRevision !== state.revision ||
    followup.sourceRevision !== finding.evidenceRevision ||
    followup.snapshotDigest !== finding.snapshotDigest ||
    state.plan.runId !== finding.runId ||
    task.nodeId !== finding.targetId || authorized.taskId !== task.id ||
    nativeRepositoryVisibilityEvidenceId(task.id) !== evidenceId
  ) return;
  const original = snapshot.nodes.find(({ id }) => id === finding.evidenceId);
  if (
    original?.kind !== "evidence" ||
    original.executionSource?.resultSha256 !== binding.originalSha256 ||
    (binding.branch && branchExecutionEvidenceId(
          finding.runId,
          finding.targetId,
          finding.controlId,
          original.executionSource,
          binding.branch,
          finding.validUntil,
        ) !== original.id)
  ) return;
  const stored = readAdaptiveRepositoryVisibility(
    join(dirname(path), "sentinel-adaptive.db"),
    finding.runId,
    state.revision,
    task.id,
    finding.targetId,
    true,
  );
  const receipt = stored?.receipt;
  if (
    !receipt || !isDeepStrictEqual(authorized, stored.reference) ||
    receipt.repository !== binding.repository ||
    receipt.repositoryId !== binding.repositoryId ||
    receipt.branch !== binding.branch ||
    receipt.observedAt <= finding.observedAt
  ) return;
  const observedAt = receipt.observedAt;
  const validity = Date.parse(finding.validUntil) -
    Date.parse(finding.observedAt);
  const expiry = Date.parse(observedAt) + validity;
  const evaluatedAt = new Date().toISOString();
  if (!Number.isFinite(expiry) || expiry <= Date.parse(evaluatedAt)) return;
  const controlVerification = {
    outcome: repositoryControlOutcome(receipt),
    observedAt,
    validUntil: new Date(expiry).toISOString(),
  };
  const projected = withRepositoryVisibilityVerification(
    snapshot,
    evidenceId,
    finding.targetId,
    finding.controlId,
    controlVerification,
  );
  const proof = verifyWorkerFindingRecheck(projected, {
    caseId: finding.caseId,
    evidenceRevision: state.revision,
    evaluatedAt,
  }, {
    assetId: finding.targetId,
    findingId: finding.graphFindingId,
    controlId: finding.controlId,
    evidenceId,
  }, ({ id }) => id === evidenceId);
  return proof &&
    { ...proof, snapshotDigest: digestSentinelSnapshot(snapshot) };
}
