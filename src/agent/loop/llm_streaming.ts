/**
 * LLM provider streaming and call orchestration.
 *
 * Consumes provider streams with repetition detection,
 * runs LLM provider calls with provider selection, and
 * accumulates token usage across iterations.
 *
 * @module
 */

import type {
  LlmCompletionResult,
  LlmStreamChunk,
} from "../../core/types/llm.ts";
import { convertToolsToNativeFormat } from "../dispatch/tool_format.ts";
import { detectRepetition } from "../dispatch/response_quality.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("llm-streaming");
import type { OrchestratorEventCallback } from "../orchestrator/orchestrator_types.ts";
import { MAX_TOOL_ITERATIONS } from "../orchestrator/orchestrator_types.ts";
import type { AgentLoopContext, LlmCallOutcome } from "./loop_types.ts";
import {
  buildLlmMessages,
  CANCELLED_RESULT,
  logFirstIterationDetails,
  resolveActiveToolList,
  traceLog,
} from "./loop_types.ts";

/**
 * Characters of new content between repetition detection checks.
 * Balances early detection (~500 chars of looping) vs. CPU cost.
 */
const STREAMING_REPETITION_CHECK_INTERVAL = 500;

/** Options for consuming a provider stream. */
interface ConsumeStreamOptions {
  /** Abort signal — checked each chunk to honour ESC/Ctrl+C during streaming. */
  readonly signal?: AbortSignal;
}

/** Consume a provider stream, emitting response_chunk events, and return a completion result. */
export async function consumeProviderStream(
  stream: AsyncIterable<LlmStreamChunk>,
  emit: OrchestratorEventCallback,
  options?: ConsumeStreamOptions,
): Promise<LlmCompletionResult> {
  let content = "";
  let toolCalls: readonly unknown[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason: string | undefined;
  let lastRepetitionCheckLen = 0;
  const signal = options?.signal;

  for await (const chunk of stream) {
    if (signal?.aborted) {
      finishReason = "cancelled";
      emit({ type: "response_chunk", text: "", done: true });
      break;
    }

    if (chunk.reasoning) {
      emit({ type: "reasoning_chunk", text: chunk.reasoning, done: false });
    }
    content += chunk.text;
    if (chunk.text) {
      emit({ type: "response_chunk", text: chunk.text, done: false });
    }

    // Detect repetition loops during streaming to abort early.
    const sinceLastCheck = content.length - lastRepetitionCheckLen;
    if (sinceLastCheck >= STREAMING_REPETITION_CHECK_INTERVAL) {
      lastRepetitionCheckLen = content.length;
      const deduped = detectRepetition(content);
      if (deduped !== null) {
        content = deduped;
        finishReason = "repetition";
        emit({ type: "response_chunk", text: "", done: true });
        break;
      }
    }

    if (chunk.done) {
      if (chunk.usage) usage = chunk.usage;
      if (chunk.toolCalls) toolCalls = chunk.toolCalls;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      emit({ type: "response_chunk", text: "", done: true });
    }
  }
  return {
    content,
    toolCalls,
    usage,
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Accumulate token usage and log iteration stats. */
function accumulateTokenUsage(
  ctx: AgentLoopContext,
  completion: { usage: { inputTokens: number; outputTokens: number } },
  iterations: number,
): void {
  ctx.tokens.inputTokens += completion.usage.inputTokens;
  ctx.tokens.outputTokens += completion.usage.outputTokens;
  ctx.state.orchLog.debug(
    `iter${iterations} tokens — input: ${completion.usage.inputTokens}, output: ${completion.usage.outputTokens}, cumulative: ${ctx.tokens.inputTokens}+${ctx.tokens.outputTokens}`,
  );
}

/** Run a single LLM provider call and return the raw completion. */
async function runLlmProviderCall(
  ctx: AgentLoopContext,
  iterations: number,
) {
  const taint = ctx.state.config.getSessionTaint?.() ?? "PUBLIC";
  const classificationProvider = ctx.state.config.providerRegistry
    .getForClassification(taint);
  const provider = classificationProvider ??
    ctx.state.config.providerRegistry.getDefault()!;
  ctx.state.orchLog.debug("Provider selected for LLM call", {
    operation: "runLlmProviderCall",
    iteration: iterations,
    taint,
    provider: provider.name,
    usedClassificationOverride: classificationProvider !== undefined,
  });
  traceLog(
    ctx.state,
    `iter${iterations} provider`,
    `taint=${taint} provider=${provider.name}`,
  );
  const messages = buildLlmMessages(ctx.systemPrompt, ctx.history);
  traceLog(
    ctx.state,
    `iter${iterations} sending`,
    `${messages.length} msgs, sysPrompt=${ctx.systemPrompt.length}chars, history=${ctx.history.length} entries`,
  );
  if (iterations === 1) {
    logFirstIterationDetails(ctx.state, ctx.systemPrompt, ctx.history);
  }
  const tools = resolveActiveToolList(ctx.state);
  const nativeTools = (tools.length > 0 && ctx.state.toolExecutor)
    ? convertToolsToNativeFormat(tools)
    : [];
  const callOptions = {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    sessionId: ctx.sessionKey,
  };

  const useStreaming = ctx.state.config.enableStreaming !== false &&
    provider.stream !== undefined;
  try {
    if (useStreaming) {
      const stream = provider.stream!(messages, nativeTools, callOptions);
      const completion = await consumeProviderStream(stream, ctx.state.emit, {
        signal: ctx.signal,
      });
      return { completion, tools };
    }

    const completion = await provider.complete(
      messages,
      nativeTools,
      callOptions,
    );
    return { completion, tools };
  } catch (err) {
    log.error("LLM provider call failed", {
      operation: "runLlmProviderCall",
      provider: provider.name,
      iteration: iterations,
      streaming: useStreaming,
      err,
    });
    throw err;
  }
}

/** Emit event, call LLM, accumulate tokens, and check abort. */
export async function callLlmAndRecordUsage(
  ctx: AgentLoopContext,
  iterations: number,
): Promise<LlmCallOutcome> {
  const maxIter = ctx.state.config.maxIterations ?? MAX_TOOL_ITERATIONS;
  ctx.state.emit({
    type: "llm_start",
    iteration: iterations,
    maxIterations: maxIter,
  });
  const { completion, tools } = await runLlmProviderCall(ctx, iterations);
  accumulateTokenUsage(ctx, completion, iterations);
  if (ctx.signal?.aborted) return CANCELLED_RESULT;
  traceLog(ctx.state, `iter${iterations} raw`, completion.content);
  return { ok: true, completion, tools };
}
