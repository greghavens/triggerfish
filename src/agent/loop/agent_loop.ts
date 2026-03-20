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
import type { SessionState } from "../../core/types/session.ts";
import type {
  HistoryEntry,
  ProcessMessageResult,
} from "../orchestrator/orchestrator_types.ts";
import { MAX_TOOL_ITERATIONS } from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import type { AgentLoopContext } from "./loop_types.ts";
import { buildLlmMessages } from "./loop_types.ts";
import {
  callLlmAndRecordUsage,
  dispatchIterationOutcome,
} from "./loop_iteration.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("agent-loop");

/** Options for running the agent loop. */
export interface AgentLoopOptions {
  readonly state: OrchestratorState;
  readonly session: SessionState;
  readonly systemPrompt: string;
  readonly history: HistoryEntry[];
  readonly sessionKey: string;
  readonly targetClassification: ClassificationLevel;
  readonly signal: AbortSignal | undefined;
}

/** Build the agent loop context from options. */
function buildAgentLoopContext(opts: AgentLoopOptions): AgentLoopContext {
  return {
    ...opts,
    tokens: { inputTokens: 0, outputTokens: 0 },
    nudge: { count: 0 },
    toolCallHistory: { calls: new Map() },
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
  const llmResult = await callLlmAndRecordUsage(ctx, iteration);
  if (!llmResult.ok) return { done: true, result: llmResult.result };
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
  const messages = buildLlmMessages(ctx.systemPrompt, ctx.history);
  const completion = await provider.complete(messages, [], {
    sessionId: ctx.sessionKey,
  });
  const response = completion.content.trim();
  log.debug("Forced text-only response at iteration limit", {
    operation: "forceTextOnlyResponse",
    responseLength: response.length,
  });
  if (response.length > 0) {
    return {
      ok: true,
      value: {
        response,
        tokenUsage: {
          inputTokens: ctx.tokens.inputTokens + completion.usage.inputTokens,
          outputTokens: ctx.tokens.outputTokens + completion.usage.outputTokens,
        },
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
  for (let i = 1; i <= limit; i++) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    const step = await executeIteration(ctx, i);
    if (!step.done) continue;
    if ("forceTextOnly" in step) {
      log.info("Nudges exhausted after tool calls — forcing text-only response", {
        operation: "runAgentLoop",
        iteration: i,
        toolCallsMade: ctx.toolCallHistory.calls.size,
      });
      return forceTextOnlyResponse(ctx);
    }
    return step.result;
  }
  return forceTextOnlyResponse(ctx);
}

/** @deprecated Use orchestrateAgentLoop instead */
export const runAgentLoop = orchestrateAgentLoop;
