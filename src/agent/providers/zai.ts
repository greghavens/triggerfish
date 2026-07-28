/**
 * Z.AI LLM provider implementation.
 *
 * Routes to GLM models available on Z.AI's Coding Plan via their
 * OpenAI-compatible API. Requires a Z.AI API key.
 *
 * Vision models (glm-4.5v, glm-4.6v, etc.) support multimodal input
 * via the OpenAI image_url content block format. Non-vision models
 * (glm-5, glm-4.7, etc.) only accept string content.
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
import { hasImages } from "../../core/image/content.ts";
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

/** Check if a Z.AI model name indicates vision support (ends with "v"). */
function isVisionModel(model: string): boolean {
  return /v$/i.test(model) || /\dv\b/i.test(model);
}

/** Configuration for the Z.AI provider. */
export interface ZaiConfig {
  /** Z.AI API key. Falls back to ZAI_API_KEY env var. */
  readonly apiKey?: string;
  /** Model identifier (e.g. "glm-4.7", "glm-4.5v", "glm-5"). */
  readonly model: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** Z.AI Coding Plan API endpoint. */
const ZAI_API_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";

/** Shape of a Z.AI API response. */
interface ZaiApiResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string;
      readonly tool_calls?: unknown[];
      readonly reasoning_content?: string;
      readonly reasoning?: string;
    };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/** Validate that image content is only sent to vision-capable models. */
function validateZaiVisionCapability(
  messages: readonly LlmMessage[],
  model: string,
): void {
  const hasImageContent = messages.some((m) =>
    typeof m.content !== "string" && hasImages(m.content as ContentBlock[])
  );
  if (hasImageContent && !isVisionModel(model)) {
    throw new Error(
      `Model "${model}" does not support images. ` +
        `Use a vision model (e.g. glm-4.5v, glm-4.6v) for image input.`,
    );
  }
}

/** Frequency penalty applied to all Z.AI requests to discourage repetition loops. */
const FREQUENCY_PENALTY = 0.3;

/** Temperature for thinking mode (no tools). Reasoning models require 1.0. */
const THINKING_TEMPERATURE = 1.0;

/** Budget for thinking tokens when reasoning mode is active. */
const THINKING_BUDGET_TOKENS = 4096;

/** Convert LLM messages to OpenAI format and build the JSON request body. */
function prepareZaiPayload(
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options?: { readonly stream?: boolean },
): string {
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

  const payload: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
  };

  if (options?.stream) payload.stream = true;

  if (hasTools) payload.tools = tools;

  if (supportsThinking) {
    // Reasoning models interleave thinking with tool calls and need that
    // reasoning replayed on the next request. Kimi K2.5 rejects a tool-call
    // turn whose reasoning_content is missing, and GLM-4.7 loses its plan
    // between actions without it. Thinking stays on either way.
    payload.thinking = {
      type: "enabled",
      budget_tokens: THINKING_BUDGET_TOKENS,
    };
    payload.temperature = THINKING_TEMPERATURE;
  }

  if (!hasTools) {
    payload.frequency_penalty = FREQUENCY_PENALTY;
  }

  return JSON.stringify(payload);
}

/** Build the standard Z.AI request headers. */
function buildZaiHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
}

/** Extract a completion result from a parsed Z.AI API response. */
function parseZaiCompletionResult(
  data: ZaiApiResponse,
): LlmCompletionResult {
  const finishReason = data.choices?.[0]?.finish_reason;
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    toolCalls: data.choices?.[0]?.message?.tool_calls ?? [],
    ...(data.choices?.[0]?.message?.reasoning_content ??
        data.choices?.[0]?.message?.reasoning
      ? {
        reasoning: (data.choices[0].message.reasoning_content ??
          data.choices[0].message.reasoning) as string,
      }
      : {}),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Send a request to the Z.AI API and return the validated response. */
async function fetchZaiResponse(
  apiKey: string,
  body: string,
  signal: AbortSignal | undefined,
  operationLabel: string,
): Promise<Response> {
  const response = await fetch(ZAI_API_URL, {
    method: "POST",
    headers: buildZaiHeaders(apiKey),
    body,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `Z.AI ${operationLabel} failed (${response.status}): ${errBody}`,
    );
  }
  return response;
}

/**
 * Create a Z.AI LLM provider.
 *
 * Z.AI (Zhipu AI) provides GLM models via an OpenAI-compatible API.
 * Uses the standard chat completions format.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Z.AI Coding Plan API
 */
export function createZaiProvider(config: ZaiConfig): LlmProvider {
  const apiKey = config.apiKey ?? Deno.env.get("ZAI_API_KEY") ?? "";
  const model = config.model;
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  if (!apiKey) {
    throw new Error(
      "Z.AI API key not configured. " +
        "Set apiKey in triggerfish.yaml under models.providers.zai, " +
        "or run 'triggerfish dive' to reconfigure.",
    );
  }

  return {
    name: "zai",
    supportsStreaming: true,
    model,
    contextWindow: resolveModelInfo(model).contextWindow,

    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): Promise<LlmCompletionResult> {
      const signal = options.signal as AbortSignal | undefined;
      validateZaiVisionCapability(messages, model);
      const body = prepareZaiPayload(model, maxTokens, messages, tools);
      const response = await fetchZaiResponse(apiKey, body, signal, "request");
      return parseZaiCompletionResult(
        (await response.json()) as ZaiApiResponse,
      );
    },

    async *stream(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): AsyncIterable<LlmStreamChunk> {
      const signal = options.signal as AbortSignal | undefined;
      validateZaiVisionCapability(messages, model);
      const body = prepareZaiPayload(
        model,
        maxTokens,
        messages,
        tools,
        { stream: true },
      );
      const response = await fetchZaiResponse(apiKey, body, signal, "stream");
      if (!response.body) throw new Error("Z.AI stream response has no body");
      yield* parseSseStream(response.body);
    },
  };
}
