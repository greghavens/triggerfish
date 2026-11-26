/** Verify a fresh, same-assignment repository observation against reviewed control evidence. */
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "@std/path";
import {
  type AdaptiveTask,
  readAdaptiveRepositoryVisibility,
} from "../sentinel/adaptive_store.ts";
import type { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import {
  nativeRepositoryVisibilityEvidenceId,
  type SentinelRepositoryVisibilityReference,
} from "../sentinel/github_repository_visibility.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import {
  verifyWorkerFindingRecheck,
  withRepositoryVisibilityVerification,
} from "../sentinel/worker_finding_evidence.ts";
import type { SentinelWorkerFindingRecord } from "../sentinel/worker_finding_store.ts";

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
    original.executionSource?.resultSha256 !== binding.originalSha256
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
    receipt.observedAt <= finding.observedAt
  ) return;
  const observedAt = receipt.observedAt;
  const validity = Date.parse(finding.validUntil) -
    Date.parse(finding.observedAt);
  const expiry = Date.parse(observedAt) + validity;
  const evaluatedAt = new Date().toISOString();
  if (!Number.isFinite(expiry) || expiry <= Date.parse(evaluatedAt)) return;
  const controlVerification = {
    outcome: receipt.visibility === "private"
      ? "pass" as const
      : "fail" as const,
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
