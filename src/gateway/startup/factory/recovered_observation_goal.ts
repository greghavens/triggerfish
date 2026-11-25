import type { DelegatedAgentKind } from "../../../core/delegated_goal_config.ts";
import type { ResolveManagedDelegatedObservationGrant } from "./managed_delegated_observation_grant.ts";
/** Exact opaque proof for one committed, grant-authorized scheduled receipt. */
import { join } from "@std/path";
import { readCommittedManagedObservation } from "../../../core/committed_recovery_evidence.ts";
import { openExecutionTraces } from "../../../core/execution_traces.ts";
import type {
  GoalEvidence,
  ManagedGoalTraceAccess,
} from "../../../core/goal_completion.ts";
import type { ManagedTranscriptGrantReader } from "../../../core/conversation/managed_evidence.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import { recoverySessionId } from "../../../scheduler/service_execution.ts";

export const committedObservationProofTool = "read_committed_observation";

type ScheduledKind = "cron" | "trigger" | "webhook";

export function recoveredObservationGoalSource(
  kind: ScheduledKind,
  sourceId: string,
) {
  return `scheduler-observation:${kind}:${sourceId}`;
}

export async function findRecoveredObservationGoalEvidence(
  executionId: string,
  sessionId: string,
  kind: ScheduledKind,
  sourceId: string,
  callId: string,
  resultSha256: string,
  authorization: SavedSourceAuthorization,
) {
  if (
    !new RegExp(`^scheduler-${kind}-[a-f0-9]{64}$`).test(executionId) ||
    recoverySessionId(executionId) !== sessionId
  ) return;
  const committed = await readCommittedManagedObservation(
    executionId,
    sessionId,
    callId,
    authorization,
  );
  if (
    !committed || committed.classification !== "INTERNAL" ||
    committed.resultSha256 !== resultSha256
  ) return;
  return {
    source: recoveredObservationGoalSource(kind, sourceId),
    reference: `${executionId}:${callId}:${committed.projection}`,
    classification: committed.classification,
    recordedAt: new Date(committed.recordedAt).toISOString(),
  };
}

export async function authorizeRecoveredObservationGoalEvidence(
  baseDir: string,
  evidence: GoalEvidence,
  rule: { kind: ScheduledKind; sourceId: string; resultSha256: string },
  createdAt: string,
  ceiling: ClassificationLevel,
  access?: ManagedGoalTraceAccess,
  resolveGrant?: ManagedTranscriptGrantReader,
) {
  const locator =
    /^(scheduler-(?:cron|trigger|webhook)-[a-f0-9]{64}):([1-9][0-9]{0,3}:(?:0|[1-9][0-9]{0,2})):([a-f0-9]{64})$/
      .exec(evidence.reference);
  if (
    !locator || !access?.current() || !access.authorizeRecoveryObservation ||
    !resolveGrant || ceiling === "PUBLIC" ||
    evidence.classification !== "INTERNAL" ||
    evidence.source !==
      recoveredObservationGoalSource(rule.kind, rule.sourceId) ||
    !locator[1].startsWith(`scheduler-${rule.kind}-`)
  ) return false;
  const [, executionId, , grantDigest] = locator;
  const sessionId = recoverySessionId(executionId);
  const journal = openExecutionTraces(join(baseDir, "execution-traces.db"));
  try {
    const read = () => journal.readRun("scheduled", executionId, ceiling);
    const run = read();
    if (
      !run || run.operatorCancelled ||
      (run.status !== "running" && run.status !== "completed") ||
      run.scope.sourceId !== rule.sourceId ||
      run.scope.sessionId !== sessionId ||
      run.admittedAt < createdAt
    ) return false;
    const approved = await access.authorizeRecoveryObservation({
      executionId,
      sessionId,
      admittedAt: run.admittedAt,
      source: `scheduler:${rule.kind}:${rule.sourceId}`,
      grantDigest,
      classification: evidence.classification,
      ceiling: run.scope.classification ?? "INTERNAL",
      resultSha256: rule.resultSha256,
    }, resolveGrant);
    const current = read();
    return approved && access.current() && !!current &&
      !current.operatorCancelled && current.status === run.status &&
      current.admittedAt === run.admittedAt;
  } catch {
    return false;
  } finally {
    journal.close();
  }
}

export function recoveredDelegatedObservationGoalSource(
  kind: DelegatedAgentKind,
) {
  return `delegated-observation:${kind}`;
}

export async function findRecoveredDelegatedObservationGoalEvidence(
  kind: DelegatedAgentKind,
  executionId: string,
  sessionId: string,
  callId: string,
  resultSha256: string,
  authorization: SavedSourceAuthorization,
) {
  if (!/^[a-f0-9]{64}$/.test(executionId)) return;
  const saved = await readCommittedManagedObservation(
    executionId,
    sessionId,
    callId,
    authorization,
  );
  if (
    !saved || saved.classification !== "INTERNAL" ||
    saved.resultSha256 !== resultSha256
  ) return;
  return {
    source: recoveredDelegatedObservationGoalSource(kind),
    reference: `${executionId}:${callId}:${saved.projection}`,
    classification: saved.classification,
    recordedAt: new Date(saved.recordedAt).toISOString(),
  };
}

export async function authorizeRecoveredDelegatedObservationGoalEvidence(
  baseDir: string,
  evidence: GoalEvidence,
  rule: { kind: DelegatedAgentKind; resultSha256: string },
  createdAt: string,
  ceiling: ClassificationLevel,
  access?: ManagedGoalTraceAccess,
  resolveGrant?: ResolveManagedDelegatedObservationGrant,
) {
  const locator =
    /^([a-f0-9]{64}):([1-9][0-9]{0,3}:(?:0|[1-9][0-9]{0,2})):([a-f0-9]{64})$/
      .exec(evidence.reference);
  if (
    !locator || !access?.current() || !access.authorizeRecoveryObservation ||
    !resolveGrant || ceiling === "PUBLIC" ||
    evidence.classification !== "INTERNAL" ||
    evidence.source !== recoveredDelegatedObservationGoalSource(rule.kind)
  ) return false;
  const [, executionId, , grantDigest] = locator;
  const journal = openExecutionTraces(join(baseDir, "execution-traces.db"));
  try {
    const read = () => journal.readRun("delegated", executionId, ceiling);
    const run = read();
    if (
      !run || run.operatorCancelled ||
      (run.status !== "running" && run.status !== "completed") ||
      run.admittedAt < createdAt
    ) return false;
    const granted = await resolveGrant(
      rule.kind,
      run.scope,
      access.ownerSessionId,
    );
    if (!granted || !access.current()) return false;
    const approved = await access.authorizeRecoveryObservation({
      executionId,
      sessionId: run.scope.sessionId,
      channelId: granted.channelId,
      admittedAt: run.admittedAt,
      source: `delegated:${rule.kind}`,
      grantDigest,
      classification: evidence.classification,
      ceiling: run.scope.classification ?? "INTERNAL",
      resultSha256: rule.resultSha256,
    }, granted.reader);
    const current = read();
    return approved && access.current() && !!current &&
      !current.operatorCancelled &&
      current.status === run.status && current.admittedAt === run.admittedAt;
  } catch {
    return false;
  } finally {
    journal.close();
  }
}
