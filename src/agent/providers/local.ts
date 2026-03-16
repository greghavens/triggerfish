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
import { resolveModelInfo } from "../models.ts";
import { parseSseStream } from "./sse.ts";
import type { ContentBlock } from "../../core/image/content.ts";

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

function buildLocalRequestBody(
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
  streaming: boolean,
): Record<string, unknown> {
  const openaiMessages = messages.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
  }));
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: openaiMessages,
    frequency_penalty: FREQUENCY_PENALTY,
  };
  if (streaming) body.stream = true;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
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

  return {
    name: config.name ?? "ollama",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(model).contextWindow,
    complete: (messages, tools, options) =>
      completeLocal(endpoint, model, maxTokens, messages, tools, options),
    stream: (messages, tools, options) =>
      streamLocal(endpoint, model, maxTokens, messages, tools, options),
  };
}
