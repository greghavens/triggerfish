/**
 * Fireworks AI LLM provider implementation.
 *
 * Routes to any model available on Fireworks AI via their OpenAI-compatible API.
 * Requires a Fireworks API key.
 *
 * @module
 */

import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import { resolveModelInfo } from "../models.ts";
import { parseSseStream } from "./sse.ts";
import type { ContentBlock } from "../../core/image/content.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("fireworks");

/** Configuration for the Fireworks provider. */
export interface FireworksConfig {
  /** Fireworks API key. Configured in triggerfish.yaml or OS keychain. */
  readonly apiKey?: string;
  /** Model identifier (e.g. "accounts/fireworks/models/llama-v3p1-70b-instruct"). */
  readonly model: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** Fireworks AI API endpoint. */
const FIREWORKS_API_URL =
  "https://api.fireworks.ai/inference/v1/chat/completions";

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
 * Frequency penalty applied to all Fireworks requests.
 *
 * Open-source models served by Fireworks are more prone to degenerate
 * repetition loops than frontier models. A modest penalty (0.3 on a
 * -2..2 scale) discourages token-level repetition without degrading
 * code generation quality.
 */
const FREQUENCY_PENALTY = 0.3;

/**
 * Strip reasoning_content from message history.
 *
 * Fireworks injects `reasoning_content` into assistant responses when thinking
 * is enabled. Sending it back in follow-up requests confuses the model —
 * it tries to continue reasoning instead of acting. We keep only `role` and
 * `content` (plus `tool_calls` / `tool_call_id` when present).
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

/**
 * Temperature used when tool calling is active (thinking disabled).
 * Lower temperature for precise, deterministic tool usage.
 */
const TOOL_CALLING_TEMPERATURE = 0.6;

/**
 * Temperature used when thinking is active (no tools).
 * Fireworks requires temperature = 1.0 when thinking is enabled.
 */
const THINKING_TEMPERATURE = 1.0;

/** Budget for thinking tokens when reasoning mode is active. */
const THINKING_BUDGET_TOKENS = 4096;

function buildChatRequestBody(
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  streaming: boolean,
): Record<string, unknown> {
  const openaiMessages = messages.map((m) =>
    stripReasoningContent({
      role: m.role,
      content: toOpenAiContent(m.content),
    })
  );

  const hasTools = Array.isArray(tools) && tools.length > 0;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
    frequency_penalty: FREQUENCY_PENALTY,
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
  }

  if (streaming) body.stream = true;

  log.debug("Fireworks request body built", {
    operation: "buildChatRequestBody",
    model,
    messageCount: openaiMessages.length,
    hasTools,
    toolCount: hasTools ? (tools as unknown[]).length : 0,
    temperature: body.temperature,
    thinking: body.thinking,
    reasoningHistory: body.reasoning_history,
    streaming,
    frequencyPenalty: FREQUENCY_PENALTY,
  });

  return body;
}

function buildFireworksHeaders(
  apiKey: string,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (sessionId) headers["x-session-affinity"] = sessionId;
  return headers;
}

function parseCompletionResponse(
  data: Record<string, unknown>,
): LlmCompletionResult {
  const choices = data.choices as Record<string, unknown>[] | undefined;
  const message = choices?.[0]?.message as
    | Record<string, unknown>
    | undefined;
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

async function completeFireworks(
  apiKey: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): Promise<LlmCompletionResult> {
  const signal = options.signal as AbortSignal | undefined;
  const sessionId = options.sessionId as string | undefined;
  const body = buildChatRequestBody(model, maxTokens, messages, tools, false);

  const response = await fetch(FIREWORKS_API_URL, {
    method: "POST",
    headers: buildFireworksHeaders(apiKey, sessionId),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Fireworks request failed (${response.status}): ${text}`,
    );
  }

  return parseCompletionResponse(await response.json());
}

async function* streamFireworks(
  apiKey: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): AsyncIterable<LlmStreamChunk> {
  const signal = options.signal as AbortSignal | undefined;
  const sessionId = options.sessionId as string | undefined;
  const body = buildChatRequestBody(model, maxTokens, messages, tools, true);

  const response = await fetch(FIREWORKS_API_URL, {
    method: "POST",
    headers: buildFireworksHeaders(apiKey, sessionId),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Fireworks stream failed (${response.status}): ${text}`,
    );
  }

  if (!response.body) {
    throw new Error("Fireworks stream returned no response body");
  }

  yield* parseSseStream(response.body);
}

/**
 * Create a Fireworks AI LLM provider.
 *
 * Fireworks AI provides fast inference for open-source and fine-tuned models.
 * Uses the OpenAI-compatible chat completions format.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Fireworks AI API
 */
export function createFireworksProvider(config: FireworksConfig): LlmProvider {
  const apiKey = config.apiKey ?? "";
  const model = config.model;
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  if (!apiKey) {
    throw new Error(
      "Fireworks API key not configured. " +
        "Set apiKey in triggerfish.yaml under models.providers.fireworks, " +
        "or run 'triggerfish dive' to reconfigure.",
    );
  }

  return {
    name: "fireworks",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(model).contextWindow,
    complete: (messages, tools, options) =>
      completeFireworks(apiKey, model, maxTokens, messages, tools, options),
    stream: (messages, tools, options) =>
      streamFireworks(apiKey, model, maxTokens, messages, tools, options),
  };
}
