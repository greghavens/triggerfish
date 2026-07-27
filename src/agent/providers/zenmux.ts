/**
 * ZenMux LLM provider implementation.
 *
 * Routes to any model available on ZenMux via their OpenAI-compatible API.
 * Requires a ZenMux API key.
 *
 * @module
 */

import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import {
  modelSupportsThinking,
  resolveModelInfo,
} from "../models.ts";
import { parseSseStream } from "./sse.ts";
import type { ContentBlock } from "../../core/image/content.ts";
import { withReasoningContent } from "./reasoning_history.ts";

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

/** Configuration for the ZenMux provider. */
export interface ZenMuxConfig {
  /** ZenMux API key. Falls back to ZENMUX_API_KEY env var. */
  readonly apiKey?: string;
  /** Model identifier (e.g. "openai/gpt-5", "moonshotai/kimi-k2"). */
  readonly model: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** ZenMux API endpoint. */
const ZENMUX_API_URL = "https://zenmux.ai/api/v1/chat/completions";

/** Frequency penalty applied to all ZenMux requests to discourage repetition loops. */
const FREQUENCY_PENALTY = 0.3;

/** Temperature for thinking mode (no tools). Reasoning models require 1.0. */
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
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const supportsThinking = modelSupportsThinking(model);

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
    const base: Record<string, unknown> = {
      role: m.role,
      content,
      ...(ext.tool_calls ? { tool_calls: ext.tool_calls } : {}),
      ...(ext.tool_call_id ? { tool_call_id: ext.tool_call_id } : {}),
    };
    return withReasoningContent(base, ext.reasoning);
  });

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
  };

  if (streaming) body.stream = true;

  if (hasTools) {
    body.tools = tools;
  }

  if (supportsThinking) {
    // Reasoning models interleave thinking with tool calls and need that
    // reasoning replayed on the next request. Kimi K2.5 rejects a tool-call
    // turn whose reasoning_content is missing, and GLM-4.7 loses its plan
    // between actions without it. Thinking stays on either way.
    body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS };
    body.reasoning_history = "interleaved";
    body.temperature = THINKING_TEMPERATURE;
  }

  if (!hasTools) {
    body.frequency_penalty = FREQUENCY_PENALTY;
  }

  return body;
}

function buildZenMuxHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
}

function parseCompletionResponse(
  data: Record<string, unknown>,
): LlmCompletionResult {
  const choices = data.choices as Record<string, unknown>[] | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const usage = data.usage as Record<string, unknown> | undefined;
  const finishReason = choices?.[0]?.finish_reason as string | undefined;
  return {
    content: (message?.content as string) ?? "",
    toolCalls: (message?.tool_calls as unknown[]) ?? [],
    ...(message?.reasoning_content ?? message?.reasoning
      ? {
        reasoning: (message?.reasoning_content ?? message?.reasoning) as string,
      }
      : {}),
    usage: {
      inputTokens: (usage?.prompt_tokens as number) ?? 0,
      outputTokens: (usage?.completion_tokens as number) ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

async function completeZenMux(
  apiKey: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): Promise<LlmCompletionResult> {
  const signal = options.signal as AbortSignal | undefined;
  const body = buildChatRequestBody(model, maxTokens, messages, tools, false);

  const response = await fetch(ZENMUX_API_URL, {
    method: "POST",
    headers: buildZenMuxHeaders(apiKey),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ZenMux request failed (${response.status}): ${text}`);
  }

  return parseCompletionResponse(await response.json());
}

async function* streamZenMux(
  apiKey: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): AsyncIterable<LlmStreamChunk> {
  const signal = options.signal as AbortSignal | undefined;
  const body = buildChatRequestBody(model, maxTokens, messages, tools, true);

  const response = await fetch(ZENMUX_API_URL, {
    method: "POST",
    headers: buildZenMuxHeaders(apiKey),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ZenMux stream failed (${response.status}): ${text}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  yield* parseSseStream(response.body);
}

/**
 * Create a ZenMux LLM provider.
 *
 * ZenMux provides a unified API for many different LLM providers.
 * Uses the OpenAI-compatible chat completions format.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the ZenMux API
 */
export function createZenMuxProvider(config: ZenMuxConfig): LlmProvider {
  const apiKey = config.apiKey ?? Deno.env.get("ZENMUX_API_KEY") ?? "";
  const model = config.model;
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  if (!apiKey) {
    throw new Error(
      "ZenMux API key not configured. " +
        "Set apiKey in triggerfish.yaml under models.providers.zenmux, " +
        "or run 'triggerfish dive' to reconfigure.",
    );
  }

  return {
    name: "zenmux",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(model).contextWindow,
    complete: (messages, tools, options) =>
      completeZenMux(apiKey, model, maxTokens, messages, tools, options),
    stream: (messages, tools, options) =>
      streamZenMux(apiKey, model, maxTokens, messages, tools, options),
  };
}
