/**
 * OpenAI LLM provider implementation.
 *
 * Supports GPT-4o, o1, o3, and other OpenAI models via API key auth.
 *
 * @module
 */

import OpenAI from "openai";
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import { resolveModelInfo } from "../models.ts";
import type { ContentBlock } from "../../core/image/content.ts";

/** Configuration for the OpenAI provider. */
export interface OpenAiConfig {
  /** OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  readonly apiKey?: string;
  /** Model to use. Default: gpt-4o */
  readonly model?: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** Frequency penalty applied to all OpenAI requests to discourage repetition loops. */
const FREQUENCY_PENALTY = 0.3;

/** Convert content blocks to OpenAI's multimodal format. */
function convertOpenAiContent(content: string | unknown): string | unknown[] {
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

/** Convert LLM messages to OpenAI chat format. */
// deno-lint-ignore no-explicit-any
function convertToOpenAiMessages(messages: readonly LlmMessage[]): any[] {
  return messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: convertOpenAiContent(m.content),
  }));
}

/** Build OpenAI tools parameter, returning empty object if no tools. */
function buildOpenAiToolsParam(
  tools: readonly unknown[],
): { tools?: unknown[] } {
  return (Array.isArray(tools) && tools.length > 0)
    ? { tools: tools as unknown[] }
    : {};
}

/** Accumulate streaming tool_calls deltas into accumulator map. */
function accumulateOpenAiToolCallDelta(
  accum: Map<number, { id?: string; name: string; arguments: string }>,
  // deno-lint-ignore no-explicit-any
  deltas: any[],
): void {
  for (const tc of deltas) {
    const idx = tc.index ?? 0;
    const existing = accum.get(idx);
    if (existing) {
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    } else {
      accum.set(idx, {
        id: tc.id ?? undefined,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      });
    }
  }
}

/** Assemble accumulated tool call deltas into final tool calls array. */
function assembleOpenAiToolCalls(
  accum: Map<number, { id?: string; name: string; arguments: string }>,
): unknown[] {
  return [...accum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([_, tc]) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
}

/** Build the base chat completion request params shared by complete and stream. */
function buildOpenAiRequestParams(
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
):
  & {
    model: string;
    max_tokens: number;
    messages: ReturnType<typeof convertToOpenAiMessages>;
  }
  & Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    messages: convertToOpenAiMessages(messages),
    frequency_penalty: FREQUENCY_PENALTY,
    ...buildOpenAiToolsParam(tools),
  };
}

/** Extract abort signal from provider options. */
function extractOpenAiAbortSignal(
  options: Record<string, unknown>,
): AbortSignal | undefined {
  return options.signal as AbortSignal | undefined;
}

/** Parse an OpenAI chat completion response into an LlmCompletionResult. */
function parseOpenAiCompletionResponse(
  // deno-lint-ignore no-explicit-any
  response: any,
): LlmCompletionResult {
  const choice = response.choices[0];
  const finishReason = choice?.finish_reason as string | undefined;
  return {
    content: choice?.message?.content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

/** Build the final done:true stream chunk from accumulated usage and tool calls. */
function buildOpenAiFinalStreamChunk(
  inputTokens: number,
  outputTokens: number,
  toolCallAccum: Map<number, { id?: string; name: string; arguments: string }>,
): LlmStreamChunk {
  const toolCalls = assembleOpenAiToolCalls(toolCallAccum);
  return {
    text: "",
    done: true,
    usage: { inputTokens, outputTokens },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** Consume an OpenAI streaming response and yield LlmStreamChunks. */
async function* consumeOpenAiStream(
  // deno-lint-ignore no-explicit-any
  stream: AsyncIterable<any>,
): AsyncIterable<LlmStreamChunk> {
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;
  const toolCallAccum = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) yield { text: delta.content, done: false };
    if (Array.isArray(delta?.tool_calls)) {
      accumulateOpenAiToolCallDelta(toolCallAccum, delta.tool_calls);
    }
    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason as string;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }
  }

  const final = buildOpenAiFinalStreamChunk(
    inputTokens,
    outputTokens,
    toolCallAccum,
  );
  yield { ...final, ...(finishReason ? { finishReason } : {}) };
}

/**
 * Create an OpenAI LLM provider.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the OpenAI API
 */
export function createOpenAiProvider(config: OpenAiConfig = {}): LlmProvider {
  const model = config.model ?? "gpt-4o";
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  // Defer client creation to first use — OpenAI SDK throws on instantiation
  // if no API key is available, but the provider may be registered before
  // credentials are configured.
  let client: OpenAI | undefined;
  function getClient(): OpenAI {
    if (!client) {
      const apiKey = config.apiKey ?? Deno.env.get("OPENAI_API_KEY");
      client = new OpenAI({ apiKey });
    }
    return client;
  }

  return {
    name: "openai",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(model).contextWindow,

    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): Promise<LlmCompletionResult> {
      const signal = extractOpenAiAbortSignal(options);
      const params = buildOpenAiRequestParams(
        model,
        maxTokens,
        messages,
        tools,
      );
      const response = await getClient().chat.completions.create(
        params,
        signal ? { signal } : undefined,
      );
      return parseOpenAiCompletionResponse(response);
    },

    async *stream(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): AsyncIterable<LlmStreamChunk> {
      const signal = extractOpenAiAbortSignal(options);
      const params = buildOpenAiRequestParams(
        model,
        maxTokens,
        messages,
        tools,
      );
      const stream = await getClient().chat.completions.create(
        { ...params, stream: true, stream_options: { include_usage: true } },
        signal ? { signal } : undefined,
      );
      yield* consumeOpenAiStream(stream);
    },
  };
}
