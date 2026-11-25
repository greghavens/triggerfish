import {
  backgroundGoalStateArgs,
  backgroundGoalStateTool,
  backgroundGoalUnavailable,
} from "./background_goal_state.ts";
import {
  projectEmittedGoalState,
  readRecoveredGoalState,
} from "./recovered_goal_state.ts";
/** Durable handling for one recovered goal evidence submission. */
import { join } from "@std/path";
import type { AgentRecoveryPolicy } from "../../../core/agent_recovery.ts";
import { GoalCompletionStore } from "../../../core/goal_completion.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExecutionTraceRole } from "../../../core/execution_traces.ts";
import { openExecutionTraces } from "../../../core/execution_traces.ts";
import { readCommittedRecoveryEvidence } from "../../../core/committed_recovery_evidence.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import { managedGoalTraceKind } from "./managed_goal_trace_evidence.ts";

export const delegatedGoalReportName = "delegated_goal_report";
export const scheduledGoalReportName = "scheduled_goal_report";
type RecoveredGoalFamily = "delegated" | "scheduler";
export const recoveredScheduledGoalUnavailable =
  "Error: Scheduled goal criterion is unavailable.";
export const recoveredGoalUnavailable =
  "Error: Delegated goal criterion is unavailable.";

export function parseRecoveredGoalReport(
  args: Readonly<Record<string, unknown>>,
) {
  const { scope, criterion, sourceCallId, requestId } = args;
  if (
    Object.keys(args).length !== 4 || typeof scope !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,120}$/.test(scope) || typeof criterion !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,120}$/.test(criterion) ||
    typeof sourceCallId !== "string" ||
    !/^[1-9][0-9]{0,3}:(?:0|[1-9][0-9]{0,2})$/.test(sourceCallId) ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)
  ) return;
  return { scope, criterion, sourceCallId, requestId };
}

export function recoveredGoalReportBinding(
  executionId: string,
  sessionId: string,
  request: NonNullable<ReturnType<typeof parseRecoveredGoalReport>>,
): string {
  return createHash("sha256").update(JSON.stringify([
    executionId,
    sessionId,
    request.scope,
    request.criterion,
    request.sourceCallId,
    request.requestId,
  ])).digest("hex");
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function readRecoveredGoalReport(
  baseDir: string,
  executionId: string,
  sessionId: string,
  args: Readonly<Record<string, unknown>>,
  family: RecoveredGoalFamily = "delegated",
): string | undefined {
  const request = parseRecoveredGoalReport(args);
  if (!request) return;
  const store = new GoalCompletionStore(join(baseDir, "goal-completion.db"));
  try {
    const saved = store.readEvidenceSubmission(
      `${family}:${request.scope}`,
      request.requestId,
    );
    if (
      saved?.binding !==
        recoveredGoalReportBinding(executionId, sessionId, request)
    ) return;
    return JSON.stringify({
      scope: request.scope,
      criterion: request.criterion,
      verified: true,
      evidenceReference: saved.receipt.proof.reference,
      _classification: saved.receipt.proof.classification,
    });
  } finally {
    store.close();
  }
}

/** Reconcile a completed submission by receipt only, without repeating any call. */
export function withRecoveredGoalPolicy(
  fallback: AgentRecoveryPolicy,
  baseDir: string,
  executionId: string,
  sessionId: string,
  authorizeScope?: () => Promise<boolean>,
  family: RecoveredGoalFamily = "delegated",
): AgentRecoveryPolicy {
  const tool = family === "delegated"
    ? delegatedGoalReportName
    : scheduledGoalReportName;
  const unavailable = family === "delegated"
    ? recoveredGoalUnavailable
    : recoveredScheduledGoalUnavailable;
  const read = (args: Readonly<Record<string, unknown>>) =>
    readRecoveredGoalReport(baseDir, executionId, sessionId, args, family);

  return {
    ...fallback,
    authorizeCommittedEvidence: authorizeScope ??
      fallback.authorizeCommittedEvidence,
    projectCall(call) {
      if (call.name === backgroundGoalStateTool.name) {
        return backgroundGoalStateArgs(call.args);
      }
      return call.name === tool
        ? parseRecoveredGoalReport(call.args)
        : fallback.projectCall(call);
    },
    isReplaySafeRead(call) {
      return call.name === backgroundGoalStateTool.name
        ? !!backgroundGoalStateArgs(call.args)
        : fallback.isReplaySafeRead?.(call) ?? false;
    },
    canReconcile(call) {
      return call.name === tool
        ? !!parseRecoveredGoalReport(call.args)
        : fallback.canReconcile?.(call) ?? false;
    },
    async authorizeDispatch(call, approvedRuleId, signal) {
      if (call.name !== tool) {
        return await fallback.authorizeDispatch?.(
          call,
          approvedRuleId,
          signal,
        ) ?? false;
      }
      return !!parseRecoveredGoalReport(call.args) && !signal?.aborted &&
        (!authorizeScope || await authorizeScope()) && !signal?.aborted;
    },
    async reconcile(call, signal) {
      if (call.name !== tool) {
        return await fallback.reconcile?.(call, signal);
      }
      if (
        signal?.aborted || call.executionId !== executionId ||
        (authorizeScope && !await authorizeScope()) || signal?.aborted
      ) return;
      return read(call.args);
    },
    projectResult(call, text) {
      if (call.name === backgroundGoalStateTool.name) {
        return projectEmittedGoalState(text);
      }
      if (call.name !== tool) {
        return fallback.projectResult(call, text);
      }
      return text === unavailable || text === read(call.args)
        ? text
        : undefined;
    },
    resultResourceId(text) {
      if (text === unavailable || text === backgroundGoalUnavailable) return;
      const result = JSON.parse(text);
      if (result?.verified === true || Array.isArray(result?.criteria)) return;
      return fallback.resultResourceId?.(text);
    },
    authorizeSavedProjection(receipt, projection) {
      if (receipt.name === backgroundGoalStateTool.name) {
        // authorize() independently rederives and compares the approved result.
        return !!backgroundGoalStateArgs(receipt.args);
      }
      if (receipt.name !== tool) {
        return fallback.authorizeSavedProjection?.(receipt, projection) ?? true;
      }
      return projection === unavailable ||
        projection === read(receipt.args);
    },
    async authorize(receipt, authorization) {
      if (receipt.name === backgroundGoalStateTool.name) {
        if (!authorization || (authorizeScope && !await authorizeScope())) {
          return false;
        }
        const status = await readRecoveredGoalState(
          { ...receipt.args },
          authorization,
          Number(receipt.callId.split(":")[0]),
        );
        return receipt.resultSha256 === digest(status);
      }
      if (receipt.name !== tool) {
        return await fallback.authorize(receipt, authorization);
      }
      if (authorizeScope && !await authorizeScope()) return false;
      const saved = read(receipt.args);
      return receipt.resultSha256 === digest(unavailable) ||
        (saved !== undefined && receipt.resultSha256 === digest(saved));
    },
  };
}

export async function findRecoveredGoalTrace(
  baseDir: string,
  locator: {
    role: Exclude<ExecutionTraceRole, "owner_chat">;
    executionId: string;
    sessionId: string;
    sourceId: string;
    callId: string;
  },
  rule: { tool: string; resultSha256: string },
  authorization: SavedSourceAuthorization,
) {
  const { role, executionId, sessionId, sourceId, callId } = locator;
  const source = await readCommittedRecoveryEvidence(
    executionId,
    sessionId,
    callId,
    authorization,
  );
  if (
    !source || source.classification !== "INTERNAL" ||
    source.tool !== rule.tool || source.resultSha256 !== rule.resultSha256 ||
    source.payload.kind !== managedGoalTraceKind(rule.tool)
  ) return;
  const trace = openExecutionTraces(join(baseDir, "execution-traces.db"));
  try {
    const snapshot = trace.archiveSnapshot(role, executionId, "INTERNAL", true);
    if (
      !snapshot || snapshot.run.status !== "running" ||
      snapshot.run.operatorCancelled ||
      snapshot.run.scope.sessionId !== sessionId ||
      snapshot.run.scope.sourceId !== sourceId
    ) return;
    const matches = snapshot.entries.filter(({ step, payload }) =>
      step.tool === source.tool &&
      step.classification === source.classification &&
      step.outcome === "returned" && isDeepStrictEqual(payload, source.payload)
    );
    if (matches.length !== 1) return;
    return matches[0].step;
  } finally {
    trace.close();
  }
}
