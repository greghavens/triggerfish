/** Durable handling for one recovered delegated goal evidence submission. */
import { join } from "@std/path";
import type { AgentRecoveryPolicy } from "../../../core/agent_recovery.ts";
import { GoalCompletionStore } from "../../../core/goal_completion.ts";
import { createHash } from "node:crypto";

export const delegatedGoalReportName = "delegated_goal_report";
export const recoveredGoalUnavailable =
  "Error: Delegated goal criterion is unavailable.";

export function parseRecoveredDelegatedGoal(
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

export function recoveredDelegatedGoalBinding(
  executionId: string,
  sessionId: string,
  request: NonNullable<ReturnType<typeof parseRecoveredDelegatedGoal>>,
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

export function readRecoveredDelegatedGoal(
  baseDir: string,
  executionId: string,
  sessionId: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const request = parseRecoveredDelegatedGoal(args);
  if (!request) return;
  const store = new GoalCompletionStore(join(baseDir, "goal-completion.db"));
  try {
    const saved = store.readEvidenceSubmission(
      `delegated:${request.scope}`,
      request.requestId,
    );
    if (
      saved?.binding !==
        recoveredDelegatedGoalBinding(executionId, sessionId, request)
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
export function withRecoveredDelegatedGoalPolicy(
  fallback: AgentRecoveryPolicy,
  baseDir: string,
  executionId: string,
  sessionId: string,
  authorizeScope?: () => Promise<boolean>,
): AgentRecoveryPolicy {
  const read = (args: Readonly<Record<string, unknown>>) =>
    readRecoveredDelegatedGoal(baseDir, executionId, sessionId, args);

  return {
    ...fallback,
    projectCall(call) {
      return call.name === delegatedGoalReportName
        ? parseRecoveredDelegatedGoal(call.args)
        : fallback.projectCall(call);
    },
    canReconcile(call) {
      return call.name === delegatedGoalReportName
        ? !!parseRecoveredDelegatedGoal(call.args)
        : fallback.canReconcile?.(call) ?? false;
    },
    async authorizeDispatch(call, approvedRuleId, signal) {
      if (call.name !== delegatedGoalReportName) {
        return await fallback.authorizeDispatch?.(
          call,
          approvedRuleId,
          signal,
        ) ?? false;
      }
      return !!parseRecoveredDelegatedGoal(call.args) && !signal?.aborted &&
        (!authorizeScope || await authorizeScope()) && !signal?.aborted;
    },
    async reconcile(call, signal) {
      if (call.name !== delegatedGoalReportName) {
        return await fallback.reconcile?.(call, signal);
      }
      if (
        signal?.aborted || call.executionId !== executionId ||
        (authorizeScope && !await authorizeScope()) || signal?.aborted
      ) return;
      return read(call.args);
    },
    projectResult(call, text) {
      if (call.name !== delegatedGoalReportName) {
        return fallback.projectResult(call, text);
      }
      return text === recoveredGoalUnavailable || text === read(call.args)
        ? text
        : undefined;
    },
    resultResourceId(text) {
      if (
        text === recoveredGoalUnavailable || JSON.parse(text)?.verified === true
      ) return;
      return fallback.resultResourceId?.(text);
    },
    authorizeSavedProjection(receipt, projection) {
      if (receipt.name !== delegatedGoalReportName) {
        return fallback.authorizeSavedProjection?.(receipt, projection) ?? true;
      }
      return projection === recoveredGoalUnavailable ||
        projection === read(receipt.args);
    },
    async authorize(receipt, authorization) {
      if (receipt.name !== delegatedGoalReportName) {
        return await fallback.authorize(receipt, authorization);
      }
      if (authorizeScope && !await authorizeScope()) return false;
      const saved = read(receipt.args);
      return receipt.resultSha256 === digest(recoveredGoalUnavailable) ||
        (saved !== undefined && receipt.resultSha256 === digest(saved));
    },
  };
}
