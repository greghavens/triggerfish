/**
 * Google (Gemini) LLM provider implementation.
 *
 * Supports Gemini models via the Google Generative AI SDK.
 *
 * @module
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../../llm.ts";
import { resolveModelInfo } from "../../models.ts";
import {
  buildGeminiChatParts,
  extractGeminiSystemInstruction,
} from "./google_content.ts";
import type { GeminiPart } from "./google_content.ts";
import {
  buildGeminiModelConfig,
  extractGeminiFunctionCalls,
  extractGeminiResponseText,
} from "./google_tools.ts";
import { wrapGoogleError } from "./google_errors.ts";

/** Configuration for the Google provider. */
export interface GoogleConfig {
  /** Google AI API key. Falls back to GOOGLE_API_KEY env var. */
  readonly apiKey?: string;
  /** Model to use. Default: gemini-2.0-flash */
  readonly model?: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

// ─── Provider context and chat preparation ──────────────────────────────────

/** Shared context for Google provider operations. */
interface GoogleProviderContext {
  readonly genAI: GoogleGenerativeAI;
  readonly modelName: string;
  readonly maxTokens: number;
}

// deno-lint-ignore no-explicit-any
type GeminiChat = any;

/** Prepare a Gemini chat session from messages and tools. */
function prepareGeminiChat(
  ctx: GoogleProviderContext,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
): { chat: GeminiChat; userParts: GeminiPart[] } {
  const systemInstruction = extractGeminiSystemInstruction(messages);
  const modelConfig = buildGeminiModelConfig(systemInstruction, tools);
  const model = ctx.genAI.getGenerativeModel({
    model: ctx.modelName,
    generationConfig: { maxOutputTokens: ctx.maxTokens },
    ...modelConfig,
  });
  const { history, userParts } = buildGeminiChatParts(messages);
  const chat = model.startChat({ history });
  return { chat, userParts };
}

// ─── Abort and usage helpers ────────────────────────────────────────────────

/** Race a promise against an AbortSignal. */
function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Operation cancelled", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new DOMException("Operation cancelled", "AbortError"));
    }, { once: true });
  });
  return Promise.race([promise, abortPromise]);
}

/** Throw an AbortError if the signal is already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Operation cancelled", "AbortError");
  }
}

// deno-lint-ignore no-explicit-any
type GeminiUsageMetadata = any;

/** Build an LlmCompletionResult's usage field from Gemini metadata. */
function buildGeminiUsage(
  meta: GeminiUsageMetadata,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: meta?.promptTokenCount ?? 0,
    outputTokens: meta?.candidatesTokenCount ?? 0,
  };
}

// ─── Completion execution ───────────────────────────────────────────────────

/** Normalize Gemini finishReason to OpenAI-style values. */
function normalizeGeminiFinishReason(
  reason: string | undefined,
): string | undefined {
  if (!reason) return undefined;
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return "stop";
  return reason.toLowerCase();
}

/** Execute a non-streaming Gemini completion. */
async function executeGeminiCompletion(
  ctx: GoogleProviderContext,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  signal: AbortSignal | undefined,
): Promise<LlmCompletionResult> {
  const { chat, userParts } = prepareGeminiChat(ctx, messages, tools);

  // deno-lint-ignore no-explicit-any
  let result: any;
  try {
    result = await raceWithAbortSignal(
      chat.sendMessage(userParts),
      signal,
    );
  } catch (err) {
    throw wrapGoogleError(err, ctx.modelName);
  }
  const response = result.response;
  const finishReason = normalizeGeminiFinishReason(
    response.candidates?.[0]?.finishReason,
  );
  return {
    content: extractGeminiResponseText(response),
    toolCalls: extractGeminiFunctionCalls(response),
    usage: buildGeminiUsage(response.usageMetadata),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Build the final stream chunk with usage and optional tool calls. */
function buildFinalStreamChunk(
  // deno-lint-ignore no-explicit-any
  finalResponse: any,
): LlmStreamChunk {
  const geminiFunctionCalls = extractGeminiFunctionCalls(finalResponse);
  const finishReason = normalizeGeminiFinishReason(
    finalResponse.candidates?.[0]?.finishReason,
  );
  return {
    text: "",
    done: true,
    usage: buildGeminiUsage(finalResponse.usageMetadata),
    ...(geminiFunctionCalls.length > 0
      ? { toolCalls: geminiFunctionCalls }
      : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Execute a streaming Gemini completion, yielding chunks. */
async function* streamGeminiCompletion(
  ctx: GoogleProviderContext,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  signal: AbortSignal | undefined,
): AsyncIterable<LlmStreamChunk> {
  const { chat, userParts } = prepareGeminiChat(ctx, messages, tools);

  let streamResult;
  try {
    streamResult = await chat.sendMessageStream(userParts);
  } catch (err) {
    throw wrapGoogleError(err, ctx.modelName);
  }

  throwIfAborted(signal);

  try {
    for await (const chunk of streamResult.stream) {
      throwIfAborted(signal);
      const text = chunk.text();
      if (text) yield { text, done: false };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw wrapGoogleError(err, ctx.modelName);
  }

  yield buildFinalStreamChunk(await streamResult.response);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Google (Gemini) LLM provider.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Google Generative AI API
 */
export function createGoogleProvider(config: GoogleConfig = {}): LlmProvider {
  const apiKey = config.apiKey ?? Deno.env.get("GOOGLE_API_KEY") ?? "";
  const modelName = config.model ?? "gemini-2.0-flash";
  const ctx: GoogleProviderContext = {
    genAI: new GoogleGenerativeAI(apiKey),
    modelName,
    maxTokens: config.maxTokens ?? resolveModelInfo(modelName).outputLimit,
  };

  return {
    name: "google",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(modelName).contextWindow,
    complete: (messages, tools, options) =>
      executeGeminiCompletion(
        ctx,
        messages,
        tools,
        options.signal as AbortSignal | undefined,
      ),
    stream: (messages, tools, options) =>
      streamGeminiCompletion(
        ctx,
        messages,
        tools,
        options.signal as AbortSignal | undefined,
      ),
  };
}
