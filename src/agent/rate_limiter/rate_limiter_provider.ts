/**
 * Rate-limited LLM provider wrapper.
 *
 * Wraps any LlmProvider so that both `complete` and `stream` wait for
 * available capacity before issuing the underlying provider call.
 * Actual token usage is recorded after each call using the usage
 * figures returned by the provider.
 *
 * @module
 */

import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";

import type { RateLimiter } from "./rate_limiter_types.ts";

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Estimate input tokens from messages using a character-length heuristic (div 4). */
function estimateTokenCost(
  messages: readonly LlmMessage[],
  customEstimator?: (messages: readonly LlmMessage[]) => number,
): number {
  if (customEstimator) return customEstimator(messages);
  return messages.reduce((sum, m) => {
    const text = typeof m.content === "string"
      ? m.content
      : JSON.stringify(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

// ---------------------------------------------------------------------------
// Stream attachment
// ---------------------------------------------------------------------------

/** Attach a rate-limited streaming method to the provider if supported. */
function attachRateLimitedStream(
  rateLimitedProvider: LlmProvider,
  provider: LlmProvider,
  limiter: RateLimiter,
  customEstimator?: (messages: readonly LlmMessage[]) => number,
): void {
  if (!provider.stream) return;
  const upstreamStream = provider.stream.bind(provider);
  rateLimitedProvider.stream = async function* (
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): AsyncIterable<LlmStreamChunk> {
    await limiter.waitForCapacity(
      estimateTokenCost(messages, customEstimator),
    );
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const chunk of upstreamStream(messages, tools, options)) {
      if (chunk.done && chunk.usage) lastUsage = chunk.usage;
      yield chunk;
    }
    if (lastUsage) {
      limiter.recordUsage(lastUsage.inputTokens, lastUsage.outputTokens);
    }
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap an LlmProvider with a sliding-window rate limiter.
 *
 * Both `complete` and `stream` will wait for available capacity before
 * issuing the underlying provider call. Actual token usage is recorded
 * after each call using the usage figures returned by the provider.
 */
export function createRateLimitedProvider(
  provider: LlmProvider,
  limiter: RateLimiter,
  estimateInputTokens?: (messages: readonly LlmMessage[]) => number,
): LlmProvider {
  const rateLimitedProvider: LlmProvider = {
    name: provider.name,
    supportsStreaming: provider.supportsStreaming,
    model: provider.model,
    contextWindow: provider.contextWindow,
    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): Promise<LlmCompletionResult> {
      await limiter.waitForCapacity(
        estimateTokenCost(messages, estimateInputTokens),
      );
      const result = await provider.complete(messages, tools, options);
      limiter.recordUsage(result.usage.inputTokens, result.usage.outputTokens);
      return result;
    },
  };
  attachRateLimitedStream(
    rateLimitedProvider,
    provider,
    limiter,
    estimateInputTokens,
  );
  return rateLimitedProvider;
}
