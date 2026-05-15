/**
 * Triggerfish Gateway request/response building and parsing.
 *
 * Handles content formatting, request body construction, response parsing,
 * and retry logic for the Triggerfish Gateway LLM provider.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import type { LlmCompletionResult, LlmMessage } from "../llm.ts";
import type { ContentBlock } from "../../core/image/content.ts";

const log = createLogger("triggerfish-cloud");

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Frequency penalty applied to thinking/reasoning requests only.
 *
 * Open-source models (KimiK2.5, etc.) are prone to degenerate repetition
 * loops when reasoning. A modest penalty discourages token-level repetition
 * in that mode. Not applied to tool-calling requests — code generation
 * relies on heavy reuse of punctuation tokens (`,`, `.`, `(`, `)`), which
 * a frequency penalty corrupts.
 */
const THINKING_FREQUENCY_PENALTY = 0.3;

/**
 * Temperature used when tool calling is active (thinking disabled).
 * Lower temperature for precise, deterministic tool usage.
 */
const TOOL_CALLING_TEMPERATURE = 0.6;

/**
 * Temperature used when thinking is active (no tools).
 * KimiK2.5/Fireworks requires temperature = 1.0 when thinking is enabled.
 */
const THINKING_TEMPERATURE = 1.0;

/** Budget for thinking tokens when reasoning mode is active. */
const THINKING_BUDGET_TOKENS = 4096;

/** Maximum retries for transient failures (502, 503, 429). */
export const MAX_RETRIES = 2;

// ─── Content formatting ──────────────────────────────────────────────────────

/** Convert content blocks to OpenAI-compatible multimodal format. */
function toOpenAiContent(content: string | unknown): string | unknown[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return (content as ContentBlock[]).map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      };
    }
    return block;
  });
}

/**
 * Strip reasoning_content from message history.
 *
 * The gateway model injects `reasoning_content` into assistant responses
 * when thinking is enabled. Sending it back in follow-up requests confuses
 * the model — it tries to continue reasoning instead of acting.
 */
function stripReasoningContent(
  msg: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
  if (msg.name) clean.name = msg.name;
  return clean;
}

// ─── Request building ────────────────────────────────────────────────────────

/** Options for building a chat request body. */
export interface ChatRequestOptions {
  readonly maxTokens: number;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly unknown[];
  readonly streaming: boolean;
}

/** Build the chat request body with proper thinking/tool mode. */
export function buildChatRequestBody(
  opts: ChatRequestOptions,
): Record<string, unknown> {
  const { maxTokens, messages, tools, streaming } = opts;
  const openaiMessages = messages.map((m) => {
    const ext = m as LlmMessage & {
      readonly tool_calls?: readonly unknown[];
      readonly tool_call_id?: string;
    };
    return stripReasoningContent({
      role: m.role,
      content: toOpenAiContent(m.content),
      ...(ext.tool_calls ? { tool_calls: ext.tool_calls } : {}),
      ...(ext.tool_call_id ? { tool_call_id: ext.tool_call_id } : {}),
    });
  });

  const hasTools = Array.isArray(tools) && tools.length > 0;

  const body: Record<string, unknown> = {
    max_tokens: maxTokens,
    messages: openaiMessages,
  };

  if (hasTools) {
    body.tools = tools;
    body.temperature = TOOL_CALLING_TEMPERATURE;
    body.thinking = { type: "disabled" };
    body.reasoning_history = "disabled";
  } else {
    body.temperature = THINKING_TEMPERATURE;
    body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS };
    body.reasoning_history = "interleaved";
    body.frequency_penalty = THINKING_FREQUENCY_PENALTY;
  }

  if (streaming) body.stream = true;

  log.debug("Request body built", {
    operation: "buildChatRequestBody",
    messageCount: openaiMessages.length,
    hasTools,
    toolCount: hasTools ? (tools as unknown[]).length : 0,
    temperature: body.temperature,
    thinking: body.thinking,
    streaming,
  });

  return body;
}

/** Build request headers with auth and session affinity. */
export function buildHeaders(
  licenseKey: string,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${licenseKey}`,
  };
  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }
  return headers;
}

// ─── Response parsing ────────────────────────────────────────────────────────

/** Parse a non-streaming completion response. */
export function parseCompletionResponse(
  data: Record<string, unknown>,
): LlmCompletionResult {
  const choices = data.choices as Record<string, unknown>[] | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const usage = data.usage as Record<string, unknown> | undefined;
  const finishReason = choices?.[0]?.finish_reason as string | undefined;
  return {
    content: (message?.content as string) ?? "",
    toolCalls: (message?.tool_calls as unknown[]) ?? [],
    usage: {
      inputTokens: (usage?.prompt_tokens as number) ?? 0,
      outputTokens: (usage?.completion_tokens as number) ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Log budget-related response headers at debug level. */
export function logBudgetHeaders(headers: Headers): void {
  const daily = headers.get("X-Daily-Budget-Remaining-Cents");
  const session = headers.get("X-Session-Budget-Remaining-Cents");
  const provider = headers.get("X-Provider");
  if (daily !== null || session !== null) {
    log.debug(
      `budget: daily=${daily ?? "?"}c session=${session ?? "?"}c provider=${
        provider ?? "?"
      }`,
    );
  }
}

/** Check if an HTTP status is transiently retriable. */
export function isRetriableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 429;
}
