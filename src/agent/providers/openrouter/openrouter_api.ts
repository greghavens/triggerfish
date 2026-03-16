/**
 * OpenRouter API request building, response parsing, and retry logic.
 *
 * Handles content conversion, header construction, payload preparation,
 * request logging, and transient-error retries for the OpenRouter API.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/mod.ts";
import type { LlmCompletionResult, LlmMessage } from "../../llm.ts";
import type { ContentBlock } from "../../../core/image/content.ts";
import {
  formatDataPolicyHint,
  isRetryableStatusCode,
  OPENROUTER_API_URL,
  type OpenRouterApiResponse,
} from "./openrouter_types.ts";

/** Logger type alias for readability. */
type OrLogger = ReturnType<typeof createLogger>;

/** Convert content blocks to OpenAI-compatible multimodal format. */
export function toOpenAiContent(
  content: string | unknown,
): string | unknown[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return (content as ContentBlock[]).map(mapContentBlock);
}

/** Map a single ContentBlock to OpenAI multimodal format. */
function mapContentBlock(
  block: ContentBlock,
): { type: string; text?: string; image_url?: { url: string } } {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    return {
      type: "image_url",
      image_url: {
        url: `data:${block.source.media_type};base64,${block.source.data}`,
      },
    };
  }
  return block as { type: string };
}

/** Build the standard OpenRouter request headers. */
export function buildOpenRouterHeaders(
  apiKey: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "HTTP-Referer": "https://trigger.fish",
    "X-Title": "Triggerfish",
  };
}

/** OpenAI-format message used in payloads. */
interface OpenAiMessage {
  readonly role: string;
  readonly content: string | unknown[];
}

/** Result of preparing an OpenRouter request payload. */
interface PreparedPayload {
  readonly body: string;
  readonly openaiMessages: OpenAiMessage[];
}

/** Options for preparing an OpenRouter request payload. */
export interface PayloadOptions {
  readonly model: string;
  readonly maxTokens: number;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly unknown[];
  readonly stream?: boolean;
}

/** Frequency penalty applied to all OpenRouter requests to discourage repetition loops. */
const FREQUENCY_PENALTY = 0.3;

/** Convert LLM messages to OpenAI format and build the JSON request body. */
export function prepareOpenRouterPayload(
  opts: PayloadOptions,
): PreparedPayload {
  const openaiMessages = opts.messages.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
  }));
  const payload: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: openaiMessages,
    frequency_penalty: FREQUENCY_PENALTY,
  };
  if (opts.stream) payload.stream = true;
  if (Array.isArray(opts.tools) && opts.tools.length > 0) {
    payload.tools = opts.tools;
  }
  return { body: JSON.stringify(payload), openaiMessages };
}

/** Options for logging an outgoing OpenRouter request. */
interface LogRequestOptions {
  readonly orLog: OrLogger;
  readonly model: string;
  readonly openaiMessages: readonly OpenAiMessage[];
  readonly bodyLength: number;
}

/** Log outgoing OpenRouter request details at debug/trace level. */
export function logOpenRouterRequest(opts: LogRequestOptions): void {
  opts.orLog.debug(
    `model=${opts.model} msgs=${opts.openaiMessages.length} body=${opts.bodyLength}chars`,
  );
  for (const m of opts.openaiMessages) {
    const preview = typeof m.content === "string"
      ? m.content.slice(0, 120)
      : "(non-string)";
    opts.orLog.trace(`  ${m.role}: ${preview}…`);
  }
}

/** Extract a completion result from a parsed OpenRouter API response. */
export function extractOpenRouterResult(
  data: OpenRouterApiResponse,
  rawText: string,
  orLog: OrLogger,
): LlmCompletionResult {
  const content = data.choices?.[0]?.message?.content ?? "";
  if (content.length === 0) {
    orLog.warn(
      `empty content! choices=${JSON.stringify(data.choices?.length)} full=${
        rawText.slice(0, 300)
      }`,
    );
  }
  const finishReason = data.choices?.[0]?.finish_reason as string | undefined;
  return {
    content,
    toolCalls: data.choices?.[0]?.message?.tool_calls ?? [],
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Log raw OpenRouter response body at trace level. */
function logOpenRouterResponse(
  orLog: OrLogger,
  status: number,
  rawText: string,
): void {
  orLog.trace(`status=${status} rawLen=${rawText.length}`);
  orLog.trace(
    rawText.length <= 500
      ? `raw: ${rawText}`
      : `raw: ${rawText.slice(0, 500)}…`,
  );
}

/** Options for an OpenRouter API call. */
export interface ApiCallOptions {
  readonly apiKey: string;
  readonly body: string;
  readonly signal: AbortSignal | undefined;
  readonly orLog: OrLogger;
}

/** Execute a single OpenRouter API call and parse the response. */
export async function sendOpenRouterApiCall(
  opts: ApiCallOptions,
): Promise<{ result: LlmCompletionResult } | { retryError: string }> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders(opts.apiKey),
    body: opts.body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) {
    return handleHttpError(response);
  }
  return parseSuccessResponse(response, opts.orLog);
}

/** Handle a non-OK HTTP response, returning a retryable error or throwing. */
async function handleHttpError(
  response: Response,
): Promise<{ retryError: string }> {
  const text = await response.text();
  if (isRetryableStatusCode(response.status)) {
    return {
      retryError: `HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  }
  throw new Error(
    `OpenRouter request failed (${response.status}): ${text}${
      formatDataPolicyHint(text)
    }`,
  );
}

/** Parse a successful API response, checking for embedded API errors. */
async function parseSuccessResponse(
  response: Response,
  orLog: OrLogger,
): Promise<{ result: LlmCompletionResult } | { retryError: string }> {
  const rawText = await response.text();
  logOpenRouterResponse(orLog, response.status, rawText);
  const data = JSON.parse(rawText) as OpenRouterApiResponse;
  if (data.error) {
    const code = data.error.code ?? 0;
    if (isRetryableStatusCode(code)) {
      return {
        retryError: `API ${code}: ${JSON.stringify(data.error).slice(0, 200)}`,
      };
    }
    throw new Error(`OpenRouter API error: ${JSON.stringify(data.error)}`);
  }
  return { result: extractOpenRouterResult(data, rawText, orLog) };
}

/** Execute an OpenRouter completion with retry on transient errors. */
export async function completeOpenRouterWithRetry(
  opts: ApiCallOptions,
): Promise<LlmCompletionResult> {
  const MAX_RETRIES = 2;
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      opts.orLog.debug(`retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const outcome = await sendOpenRouterApiCall(opts);
    if ("result" in outcome) return outcome.result;
    opts.orLog.debug(outcome.retryError);
    lastError = outcome.retryError;
  }
  throw new Error(
    `OpenRouter request failed after ${MAX_RETRIES} retries: ${
      lastError ?? "unknown"
    }`,
  );
}

/** @deprecated Use sendOpenRouterApiCall instead */
export const executeOpenRouterApiCall = sendOpenRouterApiCall;
