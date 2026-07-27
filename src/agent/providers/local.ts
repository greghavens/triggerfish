/**
 * Local LLM provider implementation.
 *
 * Connects to any OpenAI-compatible local endpoint such as Ollama,
 * LM Studio, or llama.cpp server. No authentication required.
 *
 * Multimodal content (images) is passed through in OpenAI format.
 * Whether it works depends on the local model — vision models
 * (LLaVA, Qwen-VL, etc.) will handle it; text-only models will
 * return an error from the local server.
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
import { discoverLocalModelLimits } from "./local_discovery.ts";
import type { ContentBlock } from "../../core/image/content.ts";
import { createLogger } from "../../core/logger/mod.ts";
import { withReasoningContent } from "./reasoning_history.ts";

const log = createLogger("local-provider");

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

/** Configuration for the local LLM provider. */
export interface LocalConfig {
  /** Provider name. Default: "ollama". Use "lmstudio" for LM Studio. */
  readonly name?: string;
  /** Endpoint URL. Default: http://localhost:11434 (Ollama). LM Studio uses http://localhost:1234. */
  readonly endpoint?: string;
  /** Model name. e.g. "llama3", "mistral", "codellama" */
  readonly model: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/**
 * Frequency penalty for local model requests.
 * Local/open-source models are especially prone to repetition loops.
 */
const FREQUENCY_PENALTY = 0.3;

/** Temperature for thinking mode (no tools). Reasoning models require 1.0. */
const THINKING_TEMPERATURE = 1.0;

function buildLocalRequestBody(
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
    body.tool_choice = "auto";
  }

  if (supportsThinking) {
    // Reasoning models interleave thinking with tool calls and need that
    // reasoning replayed on the next request. Kimi K2.5 rejects a tool-call
    // turn whose reasoning_content is missing, and GLM-4.7 loses its plan
    // between actions without it. Thinking stays on either way.
    body.reasoning_effort = "high";
    body.temperature = THINKING_TEMPERATURE;
  }

  if (!hasTools) {
    body.frequency_penalty = FREQUENCY_PENALTY;
  }

  return body;
}

function parseLocalCompletionResponse(
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

async function completeLocal(
  endpoint: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): Promise<LlmCompletionResult> {
  const signal = options.signal as AbortSignal | undefined;
  const body = buildLocalRequestBody(model, maxTokens, messages, tools, false);

  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local LLM request failed (${response.status}): ${text}`);
  }

  return parseLocalCompletionResponse(await response.json());
}

async function* streamLocal(
  endpoint: string,
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  options: Record<string, unknown>,
): AsyncIterable<LlmStreamChunk> {
  const signal = options.signal as AbortSignal | undefined;
  const body = buildLocalRequestBody(model, maxTokens, messages, tools, true);

  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local LLM stream failed (${response.status}): ${text}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  yield* parseSseStream(response.body);
}

/**
 * Create a local LLM provider using an OpenAI-compatible API.
 *
 * Works with Ollama (default), LM Studio, llama.cpp server, and any
 * other local server exposing the /v1/chat/completions endpoint.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by a local LLM server
 */
export function createLocalProvider(config: LocalConfig): LlmProvider {
  const endpoint = config.endpoint ?? "http://localhost:11434";
  const model = config.model;
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  // Mutable holder so server-reported context_length can replace the registry
  // default. Output limit stays as configured; local servers don't separately
  // advertise a completion-token cap — the context window IS the budget.
  const limits = { contextWindow: resolveModelInfo(model).contextWindow };

  // Run discovery once per provider, cached for subsequent calls via the
  // module-level cache in local_discovery.ts. Awaiting before each request
  // means the first complete/stream pays the probe cost; later ones are free.
  async function ensureLimitsDiscovered(): Promise<void> {
    const info = await discoverLocalModelLimits(endpoint, model).catch(
      (err) => {
        log.debug("local limits discovery threw", { err });
        return null;
      },
    );
    if (info) limits.contextWindow = info.contextLength;
  }

  return {
    name: config.name ?? "ollama",
    supportsStreaming: true,
    get contextWindow() {
      return limits.contextWindow;
    },
    complete: async (messages, tools, options) => {
      await ensureLimitsDiscovered();
      return completeLocal(
        endpoint,
        model,
        maxTokens,
        messages,
        tools,
        options,
      );
    },
    stream: async function* (messages, tools, options) {
      await ensureLimitsDiscovered();
      yield* streamLocal(endpoint, model, maxTokens, messages, tools, options);
    },
  };
}
