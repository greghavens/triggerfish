/** Resolve typed, hook-authorized execution trace proof for managed goals. */
import { createHash } from "node:crypto";
import {
  executionTracePayloadResponse,
  type ExecutionTraceRole,
  normalizeApprovedPayload,
} from "../../../core/execution_traces.ts";
import type {
  GoalEvidence,
  ManagedGoalTraceAccess,
} from "../../../core/goal_completion.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import type { SchedulerGoalCompletionBinding } from "../../../scheduler/service_goal_completion.ts";
import { delegatedSubagentSessionId } from "./delegated_agent_recovery.ts";

const scheduledPattern = /^scheduler-(cron|trigger|webhook)-[a-f0-9]{64}$/;
const delegatedPattern = /^[a-f0-9]{64}$/;
const stepPattern = /^execution-trace:[a-f0-9]{64}$/;

function validRunId(role: ExecutionTraceRole, id: string): boolean {
  return (role === "scheduled" ? scheduledPattern : delegatedPattern).test(id);
}

export function parseManagedGoalTraceLocation(
  reference: string,
  role: ExecutionTraceRole,
) {
  const match = /^([^:]+):([1-9][0-9]{0,5}):(execution-trace:[a-f0-9]{64})$/
    .exec(reference);
  return match && validRunId(role, match[1])
    ? { runId: match[1], ordinal: Number(match[2]) }
    : undefined;
}

export function parseManagedGoalCitation(
  command: string,
  role: ExecutionTraceRole,
) {
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
    typeof value.runId !== "string" || !validRunId(role, value.runId) ||
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

export const delegatedGoalTraceSource = "delegated-trace:subagent";

interface ResultRule {
  readonly tool: string;
  readonly resultSha256: string;
  readonly requirement: string;
}

interface GoalTraceTarget {
  readonly runId: string;
  readonly ordinal: number;
}

export function readScheduledGoalTrace(
  access: ManagedGoalTraceAccess,
  ceiling: ClassificationLevel,
  rule: SchedulerGoalCompletionBinding & ResultRule,
  target: GoalTraceTarget,
  createdAt: string,
): Promise<GoalEvidence | undefined> {
  if (scheduledPattern.exec(target.runId)?.[1] !== rule.kind) {
    return Promise.resolve(undefined);
  }
  return readGoalTrace(access, ceiling, rule, target, createdAt, {
    role: "scheduled",
    sourceId: rule.sourceId,
    proofSource: scheduledGoalTraceSource(rule),
  });
}

export function readDelegatedGoalTrace(
  access: ManagedGoalTraceAccess,
  ceiling: ClassificationLevel,
  rule: ResultRule,
  target: GoalTraceTarget,
  createdAt: string,
): Promise<GoalEvidence | undefined> {
  if (!validRunId("delegated", target.runId)) return Promise.resolve(undefined);
  return readGoalTrace(access, ceiling, rule, target, createdAt, {
    role: "delegated",
    sourceId: access.ownerSessionId,
    sessionId: delegatedSubagentSessionId(target.runId),
    proofSource: delegatedGoalTraceSource,
  });
}

async function readGoalTrace(
  access: ManagedGoalTraceAccess,
  ceiling: ClassificationLevel,
  rule: ResultRule,
  target: GoalTraceTarget,
  createdAt: string,
  binding: {
    role: ExecutionTraceRole;
    sourceId: string;
    sessionId?: string;
    proofSource: string;
  },
): Promise<GoalEvidence | undefined> {
  if (
    !canFlowTo("INTERNAL", ceiling) || !access.current() ||
    rule.tool !== "github_actions"
  ) return;
  try {
    const response = await access.reopen(
      binding.role,
      target.runId,
      target.ordinal,
    );
    if (!access.current() || !response.startsWith("{")) return;
    const { run, step, payload: result } = JSON.parse(response);
    const payload = normalizeApprovedPayload(result);
    if (
      run?.scope?.role !== binding.role ||
      run.scope.runId !== target.runId ||
      run.scope.sourceId !== binding.sourceId ||
      (binding.sessionId !== undefined &&
        run.scope.sessionId !== binding.sessionId) ||
      run.status !== "completed" || run.operatorCancelled ||
      step?.scope?.role !== binding.role || step.scope.runId !== target.runId ||
      step.scope.sessionId !== run.scope.sessionId ||
      step.scope.sourceId !== binding.sourceId || step.outcome !== "returned" ||
      step.ordinal !== target.ordinal || step.tool !== rule.tool ||
      typeof step.id !== "string" || !stepPattern.test(step.id) ||
      typeof step.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(step.recordedAt)) ||
      step.recordedAt < createdAt ||
      payload?.kind !== "github_actions_run_status" ||
      createHash("sha256").update(executionTracePayloadResponse(payload))
          .digest("hex") !== rule.resultSha256
    ) return;
    return {
      source: binding.proofSource,
      reference: `${target.runId}:${target.ordinal}:${step.id}`,
      detail: rule.requirement,
      classification: "INTERNAL",
    };
  } catch {
    return;
  }
}
