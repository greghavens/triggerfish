/** Open a committed, policy-approved result from the current recoverable turn. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRecoveryPolicy } from "./agent_recovery.ts";
import type { AgentRecoveryStore } from "./agent_recovery_store.ts";
import {
  type ExecutionTraceApprovedPayload,
  normalizeApprovedPayload,
} from "./execution_traces.ts";
import { computeContentHash } from "./session/lineage_serde.ts";
import { canFlowTo, type ClassificationLevel } from "./types/classification.ts";
import type { SavedSourceAuthorization } from "./types/orchestrator.ts";

export interface CommittedRecoveryEvidence {
  readonly callId: string;
  readonly tool: string;
  readonly classification: ClassificationLevel;
  readonly resultSha256: string;
  readonly recordedAt: number;
  readonly payload: ExecutionTraceApprovedPayload;
}

interface RecoveryEvidenceScope {
  readonly executionId: string;
  readonly sessionId: string;
  readonly key: string;
  readonly binding: string;
  readonly ceiling: ClassificationLevel;
  readonly signal?: AbortSignal;
  readonly store: AgentRecoveryStore;
  readonly policy: AgentRecoveryPolicy;
  active: boolean;
}

const activeScope = new AsyncLocalStorage<RecoveryEvidenceScope>();

/** Install read authority for the duration of the held recovery lock. */
export async function withCommittedRecoveryEvidence<T>(
  scope: Omit<RecoveryEvidenceScope, "active">,
  task: () => Promise<T>,
): Promise<T> {
  const context = { ...scope, active: true };
  try {
    return await activeScope.run(context, task);
  } finally {
    context.active = false;
  }
}

export async function readCommittedRecoveryEvidence(
  executionId: string,
  sessionId: string,
  callId: string,
  authorization: SavedSourceAuthorization,
): Promise<CommittedRecoveryEvidence | undefined> {
  const scope = activeScope.getStore();
  if (
    !scope || scope.executionId !== executionId ||
    scope.sessionId !== sessionId ||
    !/^[1-9][0-9]{0,3}:(?:0|[1-9][0-9]{0,2})$/.test(callId) ||
    !scope.policy.projectTracePayload
  ) return;
  const current = () => {
    if (
      !scope.active || scope.signal?.aborted || authorization.signal?.aborted
    ) return;
    const record = scope.store.read(scope.key);
    if (
      !record || record.binding !== scope.binding ||
      record.status === "finished" || record.status === "paused"
    ) return;
    const status = scope.store.inspectStatus(scope.key);
    if (status?.status === "pending" && status.pauseRequested) return;
    return record;
  };
  try {
    if (await scope.policy.authorizeCommittedEvidence?.() === false) return;
    const record = current();
    if (!record || Number(callId.split(":")[0]) > record.committedBatch) return;
    const receipt = record.tools.find((entry) => entry.callId === callId);
    if (
      !receipt || receipt.recordedAt === undefined ||
      !canFlowTo(receipt.classification, scope.ceiling)
    ) return;
    const projection = record.checkpoint?.history.find((entry) =>
      entry.role === "tool" &&
      entry.tool_call_id === `recovery_${callId.replace(":", "_")}`
    )?.content;
    if (
      typeof projection !== "string" ||
      await computeContentHash(projection) !== receipt.resultSha256 ||
      scope.policy.authorizeSavedProjection?.(receipt, projection) === false
    ) return;
    const call = { name: receipt.name, args: { ...receipt.args } };
    const projected = scope.policy.projectTracePayload(call, projection);
    const payload = projected && normalizeApprovedPayload(projected);
    if (
      !payload ||
      !await authorization.authorizeSavedCall(call, receipt.classification) ||
      !await scope.policy.authorize(receipt, authorization) ||
      !await authorization.authorizeSavedResponse(
        call.name,
        projection,
        receipt.classification,
      )
    ) return;
    if (await scope.policy.authorizeCommittedEvidence?.() === false) return;
    const check = current();
    if (check?.committedBatch !== record.committedBatch) return;
    return {
      callId,
      tool: receipt.name,
      classification: receipt.classification,
      resultSha256: receipt.resultSha256,
      recordedAt: receipt.recordedAt,
      payload,
    };
  } catch {
    return undefined;
  }
}
