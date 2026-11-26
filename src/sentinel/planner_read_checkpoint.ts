/** Durable planner continuation for explicitly projected read-only exchanges. */
import { createHash } from "node:crypto";
import { SENTINEL_SAVED_REPOSITORY_VISIBILITY } from "./github_repository_visibility.ts";
import { isModelRouteIdentity } from "../core/model_route_identity.ts";
import type { AgentTurnCheckpoint } from "../core/types/orchestrator.ts";
import {
  SENTINEL_GOAL_GRAPH_FACT_READ,
  sentinelGoalReceiptReadArguments,
} from "./worker_goal_recovery.ts";

const MAX_CHECKPOINT_READS = 4;
const SHA256 = /^[a-f0-9]{64}$/;

export function plannerCheckpointReadSelector(name: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const args = input as Record<string, unknown>;
  if (name === SENTINEL_GOAL_GRAPH_FACT_READ) {
    if (
      Object.keys(args).length !== 1 || typeof args.id !== "string" ||
      !/^worker-graph-fact:[a-f0-9]{64}$/.test(args.id)
    ) return;
    return { name, args: { id: args.id } } as const;
  }
  if (name === SENTINEL_SAVED_REPOSITORY_VISIBILITY) {
    const exact = sentinelGoalReceiptReadArguments(name, args);
    if (
      Object.keys(args).length !== 3 || !exact?.taskId || !exact.asset ||
      !exact.recheckId
    ) return;
    return {
      name,
      args: {
        taskId: exact.taskId,
        asset: exact.asset,
        recheckId: exact.recheckId,
      },
    } as const;
  }
}

type PlannerReadSelector = NonNullable<
  ReturnType<typeof plannerCheckpointReadSelector>
>;

export type PlannerCheckpointExchange = PlannerReadSelector & {
  readonly resultSha256: string;
};

export interface SentinelPlannerReadCheckpoint {
  readonly exchanges: readonly PlannerCheckpointExchange[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelRouteIdentity?: string;
}

export function parsePlannerReadCheckpoint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    factId,
    resultSha256,
    exchanges,
    inputTokens,
    outputTokens,
    modelRouteIdentity,
  } = value as Record<string, unknown>;
  if (
    typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 || typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
    (modelRouteIdentity !== undefined &&
      !isModelRouteIdentity(modelRouteIdentity))
  ) return;
  const legacy = exchanges === undefined;
  if (
    Object.keys(value).length !== (legacy ? 4 : 3) +
        Number(modelRouteIdentity !== undefined)
  ) return;
  const entries = legacy
    ? [{
      name: SENTINEL_GOAL_GRAPH_FACT_READ,
      args: { id: factId },
      resultSha256,
    }]
    : exchanges;
  if (
    !Array.isArray(entries) || entries.length < 1 ||
    entries.length > MAX_CHECKPOINT_READS
  ) return;
  const projected: PlannerCheckpointExchange[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object" || Object.keys(item).length !== 3) {
      return;
    }
    const selector = plannerCheckpointReadSelector(item.name, item.args);
    if (
      !selector || typeof item.resultSha256 !== "string" ||
      !SHA256.test(item.resultSha256)
    ) return;
    projected.push({ ...selector, resultSha256: item.resultSha256 });
  }
  return {
    exchanges: projected,
    inputTokens,
    outputTokens,
    ...(modelRouteIdentity && { modelRouteIdentity }),
  } satisfies SentinelPlannerReadCheckpoint;
}

export function projectPlannerReadCheckpoint(
  checkpoint: AgentTurnCheckpoint,
  prompt: string,
) {
  const [user, ...messages] = checkpoint.history;
  if (
    checkpoint.completedIterations < 1 ||
    checkpoint.completedIterations > MAX_CHECKPOINT_READS ||
    messages.length !== checkpoint.completedIterations * 2 ||
    checkpoint.nudgeCount !== 0 || checkpoint.eosRetries !== 0 ||
    user?.role !== "user" || user.content !== prompt
  ) return;
  const exchanges: PlannerCheckpointExchange[] = [];
  for (let index = 0; index < messages.length; index += 2) {
    const assistant = messages[index];
    const result = messages[index + 1];
    if (
      assistant?.role !== "assistant" || assistant.content !== " " ||
      assistant.reasoning !== undefined ||
      assistant.reasoningBlocks !== undefined ||
      assistant.tool_calls?.length !== 1 ||
      result?.role !== "tool" || typeof result.content !== "string"
    ) return;
    const call = assistant.tool_calls[0] as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    } | undefined;
    if (
      !call || call.type !== "function" || typeof call.id !== "string" ||
      call.id !== result.tool_call_id ||
      typeof call.function?.name !== "string" ||
      typeof call.function.arguments !== "string" ||
      call.function.arguments.length > 512
    ) return;
    try {
      const selector = plannerCheckpointReadSelector(
        call.function.name,
        JSON.parse(call.function.arguments),
      );
      if (!selector) return;
      exchanges.push({
        ...selector,
        resultSha256: createHash("sha256").update(result.content).digest("hex"),
      });
    } catch {
      return;
    }
  }
  return parsePlannerReadCheckpoint({
    exchanges,
    ...checkpoint.tokenUsage,
    ...(checkpoint.modelRouteIdentity && {
      modelRouteIdentity: checkpoint.modelRouteIdentity,
    }),
  });
}

export function reopenPlannerReadCheckpoint(
  checkpoint: SentinelPlannerReadCheckpoint,
  prompt: string,
  projections: readonly string[],
): AgentTurnCheckpoint | undefined {
  const history: AgentTurnCheckpoint["history"][number][] = [
    { role: "user", content: prompt },
  ];
  const counts = new Map<string, number>();
  for (const [index, exchange] of checkpoint.exchanges.entries()) {
    const result = projections[index];
    if (
      result === undefined ||
      exchange.resultSha256 !==
        createHash("sha256").update(result).digest("hex")
    ) return;
    const id = `sentinel-resumed-read-${index}`;
    const args = JSON.stringify(exchange.args);
    const key = `${exchange.name}:${args}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    history.push(
      {
        role: "assistant",
        content: " ",
        tool_calls: [{
          id,
          type: "function",
          function: { name: exchange.name, arguments: args },
        }],
      },
      { role: "tool", tool_call_id: id, content: result },
    );
  }
  return {
    history,
    completedIterations: checkpoint.exchanges.length,
    tokenUsage: {
      inputTokens: checkpoint.inputTokens,
      outputTokens: checkpoint.outputTokens,
    },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: [...counts],
    ...(checkpoint.modelRouteIdentity && {
      modelRouteIdentity: checkpoint.modelRouteIdentity,
    }),
  };
}
