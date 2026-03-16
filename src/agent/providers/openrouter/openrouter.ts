/**
 * OpenRouter LLM provider factory.
 *
 * Routes to any model available on OpenRouter via their OpenAI-compatible API.
 * Requires an OpenRouter API key.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/mod.ts";
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../../llm.ts";
import { resolveModelInfo } from "../../models.ts";
import { parseSseStream } from "../sse.ts";
import {
  formatDataPolicyHint,
  OPENROUTER_API_URL,
} from "./openrouter_types.ts";
import {
  buildOpenRouterHeaders,
  completeOpenRouterWithRetry,
  logOpenRouterRequest,
  prepareOpenRouterPayload,
} from "./openrouter_api.ts";

export type { OpenRouterConfig } from "./openrouter_types.ts";

/** Resolved OpenRouter provider dependencies. */
interface OpenRouterDeps {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly orLog: ReturnType<typeof createLogger>;
}

/** Bundled request parameters for internal dispatch. */
interface OpenRouterRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly unknown[];
  readonly options: Record<string, unknown>;
}

/** Resolve the OpenRouter API key from config or environment. */
function resolveOpenRouterApiKey(configKey?: string): string {
  const apiKey = configKey ?? Deno.env.get("OPENROUTER_API_KEY") ?? "";
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. " +
        "Set apiKey in triggerfish.yaml under models.providers.openrouter, " +
        "or run 'triggerfish dive' to reconfigure.",
    );
  }
  return apiKey;
}

/** Execute a non-streaming OpenRouter completion. */
// deno-lint-ignore require-await
async function completeOpenRouter(
  deps: OpenRouterDeps,
  req: OpenRouterRequest,
): Promise<LlmCompletionResult> {
  const signal = req.options.signal as AbortSignal | undefined;
  const { body, openaiMessages } = prepareOpenRouterPayload({
    model: deps.model,
    maxTokens: deps.maxTokens,
    messages: req.messages,
    tools: req.tools,
  });
  logOpenRouterRequest({
    orLog: deps.orLog,
    model: deps.model,
    openaiMessages,
    bodyLength: body.length,
  });
  return completeOpenRouterWithRetry({
    apiKey: deps.apiKey,
    body,
    signal,
    orLog: deps.orLog,
  });
}

/** Options for initiating a streaming fetch request. */
interface StreamFetchOptions {
  readonly apiKey: string;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
}

/** Fetch a streaming response from OpenRouter, validating the result. */
async function fetchOpenRouterStream(
  opts: StreamFetchOptions,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(opts.apiKey),
    body: opts.body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `OpenRouter stream failed (${response.status}): ${errBody}${
        formatDataPolicyHint(errBody)
      }`,
    );
  }
  if (!response.body) throw new Error("No response body for streaming");
  return response.body;
}

/** Execute a streaming OpenRouter request and yield SSE chunks. */
async function* streamOpenRouter(
  deps: OpenRouterDeps,
  req: OpenRouterRequest,
): AsyncIterable<LlmStreamChunk> {
  const signal = req.options.signal as AbortSignal | undefined;
  const { body } = prepareOpenRouterPayload({
    model: deps.model,
    maxTokens: deps.maxTokens,
    messages: req.messages,
    tools: req.tools,
    stream: true,
  });
  const stream = await fetchOpenRouterStream({
    apiKey: deps.apiKey,
    body,
    signal,
  });
  yield* parseSseStream(stream);
}

/**
 * Create an OpenRouter LLM provider.
 *
 * OpenRouter provides a unified API for many different LLM providers.
 * Uses the OpenAI-compatible chat completions format.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the OpenRouter API
 */
export function createOpenRouterProvider(
  config: {
    readonly apiKey?: string;
    readonly model: string;
    readonly maxTokens?: number;
  },
): LlmProvider {
  const deps: OpenRouterDeps = {
    apiKey: resolveOpenRouterApiKey(config.apiKey),
    model: config.model,
    maxTokens: config.maxTokens ?? resolveModelInfo(config.model).outputLimit,
    orLog: createLogger("openrouter"),
  };

  return {
    name: "openrouter",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(deps.model).contextWindow,
    complete: (m, t, o) =>
      completeOpenRouter(deps, { messages: m, tools: t, options: o }),
    stream: (m, t, o) =>
      streamOpenRouter(deps, { messages: m, tools: t, options: o }),
  };
}
