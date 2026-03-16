/**
 * Agent loop iteration — tool parsing, recovery nudges, and dispatch.
 *
 * Handles the mechanics of one LLM round-trip after the provider call:
 * parsing tool calls from the response, handling no-tool-call recovery,
 * and dispatching to either tool execution or final-response handling.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { parseNativeToolCalls } from "../dispatch/tool_format.ts";
import {
  BUMPERS_BLOCK_USER_RESPONSE,
  orchestrateToolCallBatch,
} from "../dispatch/tool_dispatch.ts";
import { deliverFinalResponse } from "../dispatch/response_handling.ts";
import {
  buildRecoveryNudge,
  classifyResponseQuality,
  type ResponseQuality,
} from "../dispatch/response_quality.ts";
import type {
  HistoryEntry,
  ParsedToolCall,
  ToolDefinition,
} from "../orchestrator/orchestrator_types.ts";
import { MAX_TOOL_ITERATIONS } from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import type { AgentLoopContext, IterationOutcome } from "./loop_types.ts";
import { recordToolCallsAndDetectLoop, traceLog } from "./loop_types.ts";

// Re-export from llm_streaming for backward compatibility
export {
  callLlmAndRecordUsage,
  consumeProviderStream,
} from "./llm_streaming.ts";

// ─── Per-iteration data ─────────────────────────────────────────────────────

/** Data produced by a single LLM call, passed to dispatch functions. */
interface IterationData {
  readonly completion: {
    content: string;
    toolCalls?: readonly unknown[];
    finishReason?: string;
  };
  readonly tools: readonly ToolDefinition[];
  readonly iteration: number;
}

// ─── Soft-limit helpers ──────────────────────────────────────────────────────

/** Compute the soft limit iteration from max iterations (80% of max). */
function computeSoftLimit(maxIter: number): number {
  return Math.floor(maxIter * 0.8);
}

/** Inject soft limit warning into history when approaching max iterations. */
function injectSoftLimitWarning(
  history: HistoryEntry[],
  iterations: number,
  maxIter: number,
): void {
  if (iterations !== computeSoftLimit(maxIter)) return;
  history.push({
    role: "user",
    content:
      `[SYSTEM] You have used many tool calls (${iterations}/${maxIter}). ` +
      `You have ${maxIter - iterations} remaining iterations. ` +
      "Please provide your best answer now based on the information gathered so far. " +
      "If you cannot find what you're looking for, say so rather than continuing to search.",
  });
}

// ─── Tool call parsing ──────────────────────────────────────────────────────

/** Parse tool calls from completion and determine tool availability. */
function parseCompletionToolCalls(
  completion: { toolCalls?: readonly unknown[] },
  tools: readonly ToolDefinition[],
  state: OrchestratorState,
): { parsedCalls: readonly ParsedToolCall[]; hasTools: boolean } {
  const hasTools = !!(tools.length > 0 && state.toolExecutor) ||
    !!state.planManager;
  let parsedCalls: readonly ParsedToolCall[] = [];
  if (
    hasTools && Array.isArray(completion.toolCalls) &&
    completion.toolCalls.length > 0
  ) {
    parsedCalls = parseNativeToolCalls(completion.toolCalls, state.orchLog);
  }
  return { parsedCalls, hasTools };
}

// ─── No-tool-call recovery ──────────────────────────────────────────────────

/** Regex to strip `<think>...</think>` tags the LLM emits as raw text. */
const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>/g;

/** Attempt recovery nudge for empty/junk, leaked-intent, or trailing-intent responses. */
function attemptRecoveryNudge(
  ctx: AgentLoopContext,
  completion: { content: string },
  quality: ResponseQuality,
): IterationOutcome | null {
  if (ctx.nudge.count >= 2) return null;
  ctx.nudge.count++;
  if (completion.content.trim().length > 0) {
    ctx.history.push({ role: "assistant", content: completion.content });
  }
  ctx.history.push({
    role: "user",
    content: buildRecoveryNudge(quality, ctx.nudge.count),
  });
  return { action: "continue" };
}

/** Handle the case when no tool calls were returned. */
async function handleNoToolCallsIteration(
  ctx: AgentLoopContext,
  iter: IterationData & { hasTools: boolean },
): Promise<IterationOutcome> {
  const finalText = iter.completion.content.replace(THINK_TAG_REGEX, "").trim();
  traceLog(
    ctx.state,
    `iter${iter.iteration} finalText`,
    finalText || "(EMPTY)",
  );
  if (iter.completion.finishReason) {
    traceLog(
      ctx.state,
      `iter${iter.iteration} finishReason`,
      iter.completion.finishReason,
    );
  }

  const quality = classifyResponseQuality({
    finalText,
    hasTools: iter.hasTools,
    finishReason: iter.completion.finishReason,
  });
  if (quality.isTruncated) {
    ctx.state.orchLog.warn(
      `iter${iter.iteration} response truncated (finish_reason=length) — tool call lost`,
      { operation: "handleNoToolCallsIteration", iteration: iter.iteration },
    );
  }
  if (quality.isDenseNarration) {
    ctx.state.orchLog.warn(
      `iter${iter.iteration} dense narration detected — model narrated without calling tools`,
      { operation: "handleNoToolCallsIteration", iteration: iter.iteration },
    );
  }
  const needsRecovery = quality.isEmptyOrJunk || quality.isLeakedIntent ||
    quality.hasTrailingIntent || quality.isTruncated ||
    quality.isDenseNarration;
  const maxIter = ctx.state.config.maxIterations ?? MAX_TOOL_ITERATIONS;
  if (needsRecovery && iter.iteration < maxIter) {
    const nudgeResult = attemptRecoveryNudge(ctx, iter.completion, quality);
    if (nudgeResult) return nudgeResult;
  }

  const result = await deliverFinalResponse(
    finalText,
    iter.completion,
    iter.hasTools,
    ctx.nudge.count,
    ctx.state,
    ctx.session,
    ctx.history,
    ctx.targetClassification,
    ctx.tokens,
  );
  if (result) return { action: "return", result };
  return {
    action: "return",
    result: { ok: false, error: "No response generated" },
  };
}

// ─── Tool-call iteration ────────────────────────────────────────────────────

/** Sentinel value signaling a bumper-blocked turn should force-end. */
const BUMPERS_BLOCKED_SENTINEL = "__bumpers_blocked__";

/** Append tool call results to history and return early on abort or bumper block. */
async function handleToolCallsIteration(
  ctx: AgentLoopContext,
  iter: IterationData & { parsedCalls: readonly ParsedToolCall[] },
): Promise<Result<void, string>> {
  const cleanedContent = iter.completion.content.replace(THINK_TAG_REGEX, "")
    .trim();
  const assistantContent = cleanedContent.length > 0
    ? cleanedContent
    : `(${iter.parsedCalls.length} tool call(s) executed — see results below)`;
  ctx.history.push({ role: "assistant", content: assistantContent });
  const maxIter = ctx.state.config.maxIterations ?? MAX_TOOL_ITERATIONS;
  injectSoftLimitWarning(ctx.history, iter.iteration, maxIter);

  const batchResult = await orchestrateToolCallBatch(
    iter.parsedCalls,
    ctx.state,
    ctx.session,
    ctx.sessionKey,
    ctx.signal,
  );
  if (!batchResult.ok) return batchResult;

  if (batchResult.value.bumpersBlocked) {
    // Force-end the turn: emit canned response, add to history, stop.
    // The LLM never sees the block result and cannot silently retry.
    ctx.state.emit({
      type: "response",
      text: BUMPERS_BLOCK_USER_RESPONSE,
    });
    ctx.history.push({
      role: "assistant",
      content: BUMPERS_BLOCK_USER_RESPONSE,
    });
    return { ok: false, error: BUMPERS_BLOCKED_SENTINEL };
  }

  ctx.history.push({
    role: "user",
    content: batchResult.value.resultParts.join("\n\n"),
  });

  if (recordToolCallsAndDetectLoop(ctx.toolCallHistory, iter.parsedCalls)) {
    ctx.history.push({
      role: "user",
      content:
        "[SYSTEM] You are calling the same tool with the same arguments repeatedly. " +
        "This is not making progress. Try a different approach or provide your best answer now.",
    });
  }

  return { ok: true, value: undefined };
}

// ─── Iteration dispatch ──────────────────────────────────────────────────────

/** Emit completion event and trace parsed tool call count. */
function emitToolCallParseResult(
  ctx: AgentLoopContext,
  parsedCalls: readonly ParsedToolCall[],
  iterations: number,
): void {
  traceLog(ctx.state, `iter${iterations} parsedCalls`, parsedCalls.length);
  ctx.state.emit({
    type: "llm_complete",
    iteration: iterations,
    hasToolCalls: parsedCalls.length > 0,
  });
}

/** Parse tool calls from LLM output and dispatch to appropriate handler. */
export async function dispatchIterationOutcome(
  ctx: AgentLoopContext,
  iter: IterationData,
): Promise<IterationOutcome> {
  const { parsedCalls, hasTools } = parseCompletionToolCalls(
    iter.completion,
    iter.tools,
    ctx.state,
  );
  emitToolCallParseResult(ctx, parsedCalls, iter.iteration);

  if (parsedCalls.length === 0) {
    return await handleNoToolCallsIteration(ctx, { ...iter, hasTools });
  }

  const toolResult = await handleToolCallsIteration(ctx, {
    ...iter,
    parsedCalls,
  });
  if (!toolResult.ok) {
    // Bumpers-blocked turns are already handled: canned response emitted,
    // history updated. Return success so the caller doesn't treat it as error.
    if (toolResult.error === BUMPERS_BLOCKED_SENTINEL) {
      return {
        action: "return",
        result: {
          ok: true,
          value: {
            response: BUMPERS_BLOCK_USER_RESPONSE,
            tokenUsage: ctx.tokens,
          },
        },
      };
    }
    return { action: "return", result: toolResult };
  }
  return { action: "continue" };
}
