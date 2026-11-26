/**
 * Agent loop — main LLM iteration cycle.
 *
 * Manages the iterative call-LLM -> parse-tool-calls -> execute -> repeat
 * cycle. Delegates debug logging and types to loop_types.ts, and
 * single-iteration mechanics to loop_iteration.ts.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import type { WorkerBoundaryPhase } from "../../core/types/orchestrator.ts";
import type { SessionState } from "../../core/types/session.ts";
import type {
  AgentTurnCheckpoint,
  HistoryEntry,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "../orchestrator/orchestrator_types.ts";
import { MAX_TOOL_ITERATIONS } from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import {
  deliverFinalResponse,
  evaluatePreOutputHook,
} from "../dispatch/response_handling.ts";
import type { AgentLoopContext } from "./loop_types.ts";
import { buildLlmMessages } from "./loop_types.ts";
import {
  callLlmAndRecordUsage,
  dispatchIterationOutcome,
} from "./loop_iteration.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("agent-loop");
const stoppedWorker = { ok: false, error: "The worker was stopped" } as const;

async function checkWorkerBoundary(
  ctx: AgentLoopContext,
  phase: WorkerBoundaryPhase,
): Promise<"proceed" | "steered" | "stopped"> {
  try {
    if (ctx.signal?.aborted) return "stopped";
    const decision = await ctx.workerBoundary?.(phase);
    if (ctx.signal?.aborted || decision?.stop) return "stopped";
    if (!decision?.instructions?.length) return "proceed";
    ctx.history.push({
      role: "user",
      content: "Operator guidance for this assignment:\n" +
        decision.instructions.join("\n"),
    });
    return "steered";
  } catch {
    return "stopped";
  }
}

/** Options for running the agent loop. */
export interface AgentLoopOptions {
  readonly state: OrchestratorState;
  readonly session: SessionState;
  readonly systemPrompt: string;
  readonly history: HistoryEntry[];
  readonly sessionKey: string;
  readonly targetClassification: ClassificationLevel;
  readonly signal: AbortSignal | undefined;
  readonly resume?: AgentTurnCheckpoint;
  readonly beforeToolBatch?: ProcessMessageOptions["beforeToolBatch"];
  readonly toolPersistence?: ProcessMessageOptions["toolPersistence"];
  readonly workerBoundary?: ProcessMessageOptions["workerBoundary"];
  readonly onToolDispatchOutcome?:
    ProcessMessageOptions["onToolDispatchOutcome"];
  readonly refreshCommittedHistory?: (
    results: Parameters<
      NonNullable<ProcessMessageOptions["refreshCommittedHistory"]>
    >[0],
  ) => Promise<void>;
  readonly onToolBatchCheckpoint?:
    ProcessMessageOptions["onToolBatchCheckpoint"];
}

/** Build the agent loop context from options. */
function buildAgentLoopContext(opts: AgentLoopOptions): AgentLoopContext {
  const resume = opts.resume;
  return {
    ...opts,
    tokens: { ...(resume?.tokenUsage ?? { inputTokens: 0, outputTokens: 0 }) },
    nudge: {
      count: resume?.nudgeCount ?? 0,
      eosRetries: resume?.eosRetries ?? 0,
    },
    toolCallHistory: { calls: new Map(resume?.toolCallCounts) },
  };
}

/** Execute a single iteration: call LLM, dispatch outcome. */
async function executeIteration(
  ctx: AgentLoopContext,
  iteration: number,
): Promise<
  | { done: true; result: Result<ProcessMessageResult, string> }
  | { done: false }
  | { done: true; forceTextOnly: true }
> {
  if (
    ctx.workerBoundary &&
    await checkWorkerBoundary(ctx, "before_model") === "stopped"
  ) return { done: true, result: stoppedWorker };
  const llmResult = await callLlmAndRecordUsage(ctx, iteration);
  if (!llmResult.ok) return { done: true, result: llmResult.result };
  if (ctx.workerBoundary) {
    const decision = await checkWorkerBoundary(ctx, "before_action");
    if (decision === "stopped") return { done: true, result: stoppedWorker };
    if (decision === "steered") return { done: false };
  }
  const outcome = await dispatchIterationOutcome(ctx, {
    completion: llmResult.completion,
    tools: llmResult.tools,
    iteration,
  });
  if (outcome.action === "continue") return { done: false };
  if (outcome.action === "force_text_only") {
    return { done: true, forceTextOnly: true };
  }
  return { done: true, result: outcome.result };
}

/** Resolve the effective iteration limit from orchestrator config. */
function resolveMaxIterations(state: OrchestratorState): number {
  return state.config.maxIterations ?? MAX_TOOL_ITERATIONS;
}

/**
 * Force a final text-only LLM call when the iteration limit is reached.
 *
 * Sends the accumulated history with no tools available, so the LLM
 * must produce a text summary of its findings instead of more tool calls.
 */
async function forceTextOnlyResponse(
  ctx: AgentLoopContext,
): Promise<Result<ProcessMessageResult, string>> {
  ctx.history.push({
    role: "user",
    content:
      "[SYSTEM] Iteration limit reached. Respond NOW with your findings " +
      "based on the information gathered so far. Do not attempt any more tool calls.",
  });
  const taint = ctx.state.config.getSessionTaint?.() ?? "PUBLIC";
  const provider = ctx.state.config.providerRegistry
    .getForClassification(taint) ??
    ctx.state.config.providerRegistry.getDefault()!;
  async function complete() {
    const messages = buildLlmMessages(ctx.systemPrompt, ctx.history);
    return await provider.complete(messages, [], {
      sessionId: ctx.sessionKey,
      ...((ctx.toolPersistence || ctx.workerBoundary) &&
        { signal: ctx.signal }),
    });
  }
  let completion;
  try {
    if (
      ctx.workerBoundary &&
      await checkWorkerBoundary(ctx, "before_model") === "stopped"
    ) return stoppedWorker;
    completion = await complete();
    if (ctx.workerBoundary) {
      const decision = await checkWorkerBoundary(ctx, "before_action");
      if (decision === "stopped") return stoppedWorker;
      if (decision === "steered") {
        ctx.tokens.inputTokens += completion.usage.inputTokens;
        ctx.tokens.outputTokens += completion.usage.outputTokens;
        completion = await complete();
        const next = await checkWorkerBoundary(ctx, "before_action");
        if (next === "stopped") return stoppedWorker;
        if (next === "steered") {
          return {
            ok: false,
            error:
              "The worker reached its iteration limit while applying operator guidance",
          };
        }
      }
    }
  } catch (error) {
    if (!ctx.toolPersistence && !ctx.workerBoundary) throw error;
    return { ok: false, error: "The protected model call failed" };
  }
  if (ctx.signal?.aborted) {
    return { ok: false, error: "Operation cancelled by user" };
  }
  const response = completion.content.trim();
  log.debug("Forced text-only response at iteration limit", {
    operation: "forceTextOnlyResponse",
    responseLength: response.length,
  });
  if (response.length > 0) {
    const tokenUsage = {
      inputTokens: ctx.tokens.inputTokens + completion.usage.inputTokens,
      outputTokens: ctx.tokens.outputTokens + completion.usage.outputTokens,
    };
    if (ctx.toolPersistence || ctx.workerBoundary) {
      const guarded = await deliverFinalResponse(
        response,
        { content: response },
        false,
        ctx.nudge.count,
        ctx.state,
        ctx.session,
        ctx.history,
        ctx.targetClassification,
        tokenUsage,
        false,
        ctx.signal,
      );
      return guarded ?? { ok: false, error: "No response generated" };
    }
    const allowed = await evaluatePreOutputHook(
      ctx.state.config,
      ctx.session,
      response,
      ctx.targetClassification,
      true,
    );
    if (!allowed.ok) return allowed;
    if (ctx.signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    ctx.state.emit({ type: "response", text: response });
    return {
      ok: true,
      value: {
        response,
        tokenUsage,
      },
    };
  }
  return {
    ok: false,
    error: "Agent loop exceeded maximum tool call iterations",
  };
}

/** The main agent loop: call LLM, parse tool calls, execute, repeat. */
export async function orchestrateAgentLoop(
  opts: AgentLoopOptions,
): Promise<Result<ProcessMessageResult, string>> {
  const ctx = buildAgentLoopContext(opts);
  const limit = resolveMaxIterations(opts.state);
  for (let i = (opts.resume?.completedIterations ?? 0) + 1; i <= limit; i++) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    const step = await executeIteration(ctx, i);
    if (!step.done) continue;
    if ("forceTextOnly" in step) {
      log.info(
        "Nudges exhausted after tool calls — forcing text-only response",
        {
          operation: "runAgentLoop",
          iteration: i,
          toolCallsMade: ctx.toolCallHistory.calls.size,
        },
      );
      return forceTextOnlyResponse(ctx);
    }
    return step.result;
  }
  return opts.signal?.aborted
    ? { ok: false, error: "Operation cancelled by user" }
    : forceTextOnlyResponse(ctx);
}

/** @deprecated Use orchestrateAgentLoop instead */
export const runAgentLoop = orchestrateAgentLoop;
