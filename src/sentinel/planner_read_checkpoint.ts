/** Durable planner continuation for one approved, exact graph-fact exchange. */
import { createHash } from "node:crypto";
import { isModelRouteIdentity } from "../core/model_route_identity.ts";
import type { AgentTurnCheckpoint } from "../core/types/orchestrator.ts";
import { SENTINEL_GOAL_GRAPH_FACT_READ } from "./worker_goal_recovery.ts";

export interface SentinelPlannerReadCheckpoint {
  readonly factId: string;
  readonly resultSha256: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelRouteIdentity?: string;
}

export function parsePlannerReadCheckpoint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    factId,
    resultSha256,
    inputTokens,
    outputTokens,
    modelRouteIdentity,
  } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== (modelRouteIdentity === undefined ? 4 : 5) ||
    typeof factId !== "string" ||
    !/^worker-graph-fact:[a-f0-9]{64}$/.test(factId) ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256) ||
    typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 || typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
    (modelRouteIdentity !== undefined &&
      !isModelRouteIdentity(modelRouteIdentity))
  ) return;
  return {
    factId,
    resultSha256,
    inputTokens,
    outputTokens,
    ...(modelRouteIdentity && { modelRouteIdentity }),
  } satisfies SentinelPlannerReadCheckpoint;
}

export function projectPlannerReadCheckpoint(
  checkpoint: AgentTurnCheckpoint,
  prompt: string,
) {
  const [user, assistant, result] = checkpoint.history;
  if (
    checkpoint.completedIterations !== 1 || checkpoint.history.length !== 3 ||
    checkpoint.nudgeCount !== 0 || checkpoint.eosRetries !== 0 ||
    user?.role !== "user" || user.content !== prompt ||
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
    call.function?.name !== SENTINEL_GOAL_GRAPH_FACT_READ ||
    typeof call.function.arguments !== "string" ||
    call.function.arguments.length > 160
  ) return;
  try {
    const args = JSON.parse(call.function.arguments);
    if (!args || Object.keys(args).length !== 1) return;
    return parsePlannerReadCheckpoint({
      factId: args.id,
      resultSha256: createHash("sha256").update(result.content).digest("hex"),
      ...checkpoint.tokenUsage,
      ...(checkpoint.modelRouteIdentity && {
        modelRouteIdentity: checkpoint.modelRouteIdentity,
      }),
    });
  } catch {
    return;
  }
}

export function reopenPlannerReadCheckpoint(
  checkpoint: SentinelPlannerReadCheckpoint,
  prompt: string,
  projection: string,
): AgentTurnCheckpoint | undefined {
  if (
    checkpoint.resultSha256 !==
      createHash("sha256").update(projection).digest("hex")
  ) return;
  const id = "sentinel-resumed-graph-fact";
  const args = JSON.stringify({ id: checkpoint.factId });
  return {
    history: [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: " ",
        tool_calls: [{
          id,
          type: "function",
          function: { name: SENTINEL_GOAL_GRAPH_FACT_READ, arguments: args },
        }],
      },
      { role: "tool", tool_call_id: id, content: projection },
    ],
    completedIterations: 1,
    tokenUsage: {
      inputTokens: checkpoint.inputTokens,
      outputTokens: checkpoint.outputTokens,
    },
    nudgeCount: 0,
    eosRetries: 0,
    toolCallCounts: [[`${SENTINEL_GOAL_GRAPH_FACT_READ}:${args}`, 1]],
    ...(checkpoint.modelRouteIdentity && {
      modelRouteIdentity: checkpoint.modelRouteIdentity,
    }),
  };
}
