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
import { withReasoningContent } from "./reasoning_history.ts";

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
      readonly reasoning?: string;
    };
    const converted = toOpenAiContent(m.content);
    // OpenAI spec: assistant messages with tool_calls may have null content.
    // The in-memory representation uses a single space for tool-call-only
    // turns (see loop_iteration.ts) to discourage the model from mimicking
    // placeholder text; emit canonical null at the API boundary.
    const content = (ext.tool_calls && typeof converted === "string" &&
        converted.trim().length === 0)
      ? null
      : converted;
    return withReasoningContent({
      role: m.role,
      content,
      ...(ext.tool_calls ? { tool_calls: ext.tool_calls } : {}),
      ...(ext.tool_call_id ? { tool_call_id: ext.tool_call_id } : {}),
    }, ext.reasoning);
  });

  const hasTools = Array.isArray(tools) && tools.length > 0;

  const body: Record<string, unknown> = {
    max_tokens: maxTokens,
    messages: openaiMessages,
  };

  if (hasTools) body.tools = tools;

  // Thinking stays enabled alongside tools. The gateway's upstream serves
  // interleaved thinking with tool calling in a single pass, and Kimi K2.5
  // rejects a tool-call turn whose `reasoning_content` is missing.
  // Temperature must be 1.0 whenever thinking is on.
  body.temperature = THINKING_TEMPERATURE;
  body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS };
  body.reasoning_history = "interleaved";
  // Frequency penalty corrupts code generation, which leans on heavy reuse
  // of punctuation tokens — keep it off whenever tools are in play.
  if (!hasTools) body.frequency_penalty = THINKING_FREQUENCY_PENALTY;

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
  const reasoning = message?.reasoning_content as string | undefined;
  return {
    content: (message?.content as string) ?? "",
    toolCalls: (message?.tool_calls as unknown[]) ?? [],
    ...(reasoning ? { reasoning } : {}),
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

// ─── Error formatting ────────────────────────────────────────────────────────

/** Format an ISO timestamp as a short, human-readable UTC string. */
function formatResetTime(isoString: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

/** Extract the friendly body of a gateway error, without the status prefix. */
function extractFriendlyBody(body: string): string | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(body);
    if (candidate && typeof candidate === "object") {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  if (!parsed) {
    const trimmed = body.trim().slice(0, 200);
    return trimmed.length > 0 ? trimmed : null;
  }

  const code = typeof parsed.error === "string" ? parsed.error : undefined;
  const message = typeof parsed.message === "string"
    ? parsed.message
    : undefined;
  const resetsAt = typeof parsed.resets_at === "string"
    ? parsed.resets_at
    : undefined;
  const upgradeUrl = typeof parsed.upgrade_url === "string"
    ? parsed.upgrade_url
    : undefined;

  if (code === "daily_budget_exhausted") {
    const reset = resetsAt ? ` Resets at ${formatResetTime(resetsAt)}.` : "";
    const upgrade = upgradeUrl ? ` Upgrade: ${upgradeUrl}` : "";
    return `Daily usage limit reached.${reset}${upgrade}`.trim();
  }

  if (code === "session_budget_exhausted") {
    const upgrade = upgradeUrl ? ` Upgrade: ${upgradeUrl}` : "";
    return `Session budget exhausted.${upgrade}`.trim();
  }

  if (message) {
    const upgrade = upgradeUrl ? ` Upgrade: ${upgradeUrl}` : "";
    return `${message}${upgrade}`.trim();
  }

  if (code) return code;

  return null;
}

/**
 * Format a Triggerfish Gateway error response into a friendly, user-facing
 * message.
 *
 * The gateway returns JSON like
 * `{"error":"daily_budget_exhausted","message":"...","resets_at":"...","upgrade_url":"..."}`.
 * The raw JSON is unfriendly to read in a chat UI. This helper extracts the
 * structured fields and produces a one-line message suitable for surfacing to
 * the user.
 *
 * The bare `(status)` parenthesized form is preserved in the output so the
 * outer retry wrapper (see `retry.ts:isRetryableError`) can still detect
 * transient 429/502/503 failures and retry.
 *
 * @param status - HTTP status code (0 if not available, e.g. from a parsed
 *                 `data.error` payload with a non-numeric `code`)
 * @param body - Raw response body text
 * @returns A human-readable error description
 */
export function formatGatewayError(status: number, body: string): string {
  const friendly = extractFriendlyBody(body);
  const prefix = status > 0
    ? `Triggerfish Gateway error (${status})`
    : "Triggerfish Gateway error";
  return friendly ? `${prefix}: ${friendly}` : prefix;
}
