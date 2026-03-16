/**
 * Provider retry decorator with exponential backoff.
 *
 * Wraps any LlmProvider to retry transient HTTP failures (429, 502, 503)
 * before surfacing the error. Applied universally during provider registration
 * so all providers get retry automatically.
 *
 * @module
 */

import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("provider-retry");

/** HTTP status codes that indicate transient server-side issues. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);

/** Default retry configuration. */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;

/** Options for the retry decorator. */
export interface RetryOptions {
  /** Maximum number of retries (not counting the initial attempt). Default: 2. */
  readonly maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  readonly baseDelayMs?: number;
}

/** Check whether an error message contains a retryable HTTP status code. */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  for (const code of RETRYABLE_STATUS_CODES) {
    if (err.message.includes(`(${code})`)) return true;
  }
  return false;
}

/** Sleep for the given duration, respecting an optional abort signal. */
function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Execute an async operation with exponential backoff retry on transient errors.
 *
 * Retries when the error message contains a retryable status code (429, 502, 503).
 * Non-retryable errors are thrown immediately.
 */
export async function invokeWithRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly providerName: string;
    readonly operation: string;
    readonly signal?: AbortSignal;
  },
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= opts.maxRetries; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || i === opts.maxRetries) {
        throw err;
      }
      const delayMs = opts.baseDelayMs * Math.pow(2, i);
      log.warn("Provider request failed with retryable error, retrying", {
        operation: opts.operation,
        provider: opts.providerName,
        attempt: i + 1,
        maxAttempts: opts.maxRetries + 1,
        delayMs,
        err,
      });
      await retrySleep(delayMs, opts.signal);
    }
  }
  throw lastError;
}

/**
 * Wrap an LlmProvider with retry logic for transient failures.
 *
 * Both `complete()` and `stream()` are wrapped. For streaming, only the
 * initial connection attempt is retried — once chunks start flowing,
 * mid-stream failures are not retried.
 *
 * @param provider - The provider to wrap
 * @param options - Retry configuration
 * @returns A new LlmProvider with identical interface, plus retry
 */
export function withRetry(
  provider: LlmProvider,
  options?: RetryOptions,
): LlmProvider {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const retryComplete = (
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    opts: Record<string, unknown>,
  ): Promise<LlmCompletionResult> => {
    const signal = opts.signal as AbortSignal | undefined;
    return invokeWithRetry(
      () => provider.complete(messages, tools, opts),
      {
        maxRetries,
        baseDelayMs,
        providerName: provider.name,
        operation: "complete",
        signal,
      },
    );
  };

  const retryStream = provider.stream
    ? (
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      opts: Record<string, unknown>,
    ): AsyncIterable<LlmStreamChunk> => {
      return retryStreamConnection(
        () => provider.stream!(messages, tools, opts),
        {
          maxRetries,
          baseDelayMs,
          providerName: provider.name,
          signal: opts.signal as AbortSignal | undefined,
        },
      );
    }
    : undefined;

  return {
    name: provider.name,
    supportsStreaming: provider.supportsStreaming,
    contextWindow: provider.contextWindow,
    complete: retryComplete,
    ...(retryStream ? { stream: retryStream } : {}),
  };
}

/**
 * Retry the initial stream connection with backoff.
 *
 * The stream factory is called, and we attempt to read the first chunk.
 * If the factory throws a retryable error before yielding, we retry.
 * Once the first chunk arrives, we yield it and pass through the rest.
 */
async function* retryStreamConnection(
  factory: () => AsyncIterable<LlmStreamChunk>,
  opts: {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly providerName: string;
    readonly signal?: AbortSignal;
  },
): AsyncIterable<LlmStreamChunk> {
  let stream: AsyncIterable<LlmStreamChunk> | undefined;
  let iterator: AsyncIterator<LlmStreamChunk> | undefined;
  let firstChunk: LlmStreamChunk | undefined;

  // Retry loop for the initial connection (getting the first chunk)
  let lastError: unknown;
  for (let i = 0; i <= opts.maxRetries; i++) {
    try {
      stream = factory();
      iterator = stream[Symbol.asyncIterator]();
      const result = await iterator.next();
      if (result.done) return;
      firstChunk = result.value;
      break;
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || i === opts.maxRetries) {
        throw err;
      }
      const delayMs = opts.baseDelayMs * Math.pow(2, i);
      log.warn("Provider stream connection failed, retrying", {
        operation: "stream",
        provider: opts.providerName,
        attempt: i + 1,
        maxAttempts: opts.maxRetries + 1,
        delayMs,
        err,
      });
      await retrySleep(delayMs, opts.signal);
    }
  }

  if (!firstChunk || !iterator) throw lastError;

  // Yield the first chunk and pass through the rest
  yield firstChunk;
  while (true) {
    const result = await iterator.next();
    if (result.done) return;
    yield result.value;
  }
}

/** @deprecated Use invokeWithRetry instead */
export const executeWithRetry = invokeWithRetry;
