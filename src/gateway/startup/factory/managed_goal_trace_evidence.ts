/** Resolve typed, hook-authorized execution trace proof for scheduled goal criteria. */
import { createHash } from "node:crypto";
import {
  executionTracePayloadCall,
  executionTracePayloadResponse,
  normalizeApprovedPayload,
} from "../../../core/execution_traces.ts";
import type { GoalEvidence } from "../../../core/goal_completion.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import type { SchedulerGoalCompletionBinding } from "../../../scheduler/service_goal_completion.ts";

export interface ManagedGoalTraceAccess {
  readonly current: () => boolean;
  readonly reopenScheduled: (runId: string, ordinal: number) => Promise<string>;
}

const runPattern = /^scheduler-(cron|trigger|webhook)-[a-f0-9]{64}$/;
const stepPattern = /^execution-trace:[a-f0-9]{64}$/;

export function parseScheduledGoalTraceLocation(reference: string) {
  const match =
    /^(scheduler-(?:cron|trigger|webhook)-[a-f0-9]{64}):([1-9][0-9]{0,5}):(execution-trace:[a-f0-9]{64})$/
      .exec(
        reference,
      );
  return match
    ? { runId: match[1], ordinal: Number(match[2]), stepId: match[3] }
    : undefined;
}

export function parseScheduledGoalCitation(command: string) {
  const value = JSON.parse(command);
  if (
    !value || typeof value !== "object" ||
    Object.keys(value).some((key) =>
      !["scope", "criterion", "runId", "ordinal"].includes(key)
    ) ||
    typeof value.scope !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.scope) ||
    typeof value.criterion !== "string" || !value.criterion.trim() ||
    value.criterion.length > 256 ||
    typeof value.runId !== "string" || !runPattern.test(value.runId) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 || value.ordinal > 999_999
  ) {
    throw new Error(
      "Expected an exact configured scope, criterion, runId, and ordinal",
    );
  }
  return value as {
    scope: string;
    criterion: string;
    runId: string;
    ordinal: number;
  };
}

export function scheduledGoalTraceSource(rule: SchedulerGoalCompletionBinding) {
  return `scheduler-trace:${rule.kind}:${rule.sourceId}`;
}

export async function readScheduledGoalTrace(
  access: ManagedGoalTraceAccess,
  ceiling: ClassificationLevel,
  rule: SchedulerGoalCompletionBinding & {
    tool: string;
    resultSha256: string;
    requirement: string;
  },
  target: { runId: string; ordinal: number },
  createdAt: string,
): Promise<GoalEvidence | undefined> {
  if (
    !canFlowTo("INTERNAL", ceiling) || !access.current() ||
    rule.tool !== "github_actions" ||
    runPattern.exec(target.runId)?.[1] !== rule.kind
  ) return;
  try {
    const response = await access.reopenScheduled(target.runId, target.ordinal);
    if (!access.current() || !response.startsWith("{")) return;
    const { run, step, payload: result } = JSON.parse(response);
    const payload = normalizeApprovedPayload(result);
    if (
      run?.scope?.role !== "scheduled" ||
      run.scope.runId !== target.runId ||
      run.scope.sourceId !== rule.sourceId ||
      run.status !== "completed" || run.operatorCancelled ||
      step?.scope?.role !== "scheduled" || step.scope.runId !== target.runId ||
      step.scope.sessionId !== run.scope.sessionId ||
      step.scope.sourceId !== rule.sourceId || step.outcome !== "returned" ||
      step.ordinal !== target.ordinal || step.tool !== rule.tool ||
      typeof step.id !== "string" || !stepPattern.test(step.id) ||
      typeof step.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(step.recordedAt)) ||
      step.recordedAt < createdAt ||
      payload?.kind !== "github_actions_run_status" ||
      executionTracePayloadCall(payload).name !== rule.tool ||
      createHash("sha256").update(executionTracePayloadResponse(payload))
          .digest("hex") !== rule.resultSha256
    ) return;
    return {
      source: scheduledGoalTraceSource(rule),
      reference: `${target.runId}:${target.ordinal}:${step.id}`,
      detail: rule.requirement,
      classification: "INTERNAL",
    };
  } catch {
    return;
  }
}
