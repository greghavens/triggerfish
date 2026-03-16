/**
 * Anthropic LLM provider implementation.
 *
 * Uses API key authentication for all Anthropic models.
 *
 * @module
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import { resolveModelInfo } from "../models.ts";

/** Configuration for the Anthropic provider. */
export interface AnthropicConfig {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  readonly apiKey?: string;
  /** Model to use. Default: claude-sonnet-4-5-20250929 */
  readonly model?: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** OpenAI-format tool definition shape. */
interface OpenAiToolDef {
  readonly type: string;
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** Convert OpenAI-format tool definitions to Anthropic's native format. */
function convertToolsToAnthropicFormat(
  tools: readonly unknown[],
  // deno-lint-ignore no-explicit-any
): any[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .filter((t): t is OpenAiToolDef => {
      const td = t as Record<string, unknown>;
      return td !== null && typeof td === "object" &&
        typeof td.function === "object";
    })
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
}

/** Extract system prompt string from LLM messages. */
function extractAnthropicSystemPrompt(
  messages: readonly LlmMessage[],
): string | undefined {
  const systemMessage = messages.find((m) => m.role === "system");
  if (!systemMessage) return undefined;
  return typeof systemMessage.content === "string"
    ? systemMessage.content
    : JSON.stringify(systemMessage.content);
}

/** Convert LLM messages to Anthropic MessageParam format (excluding system). */
function convertToAnthropicMessages(
  messages: readonly LlmMessage[],
): MessageParam[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as MessageParam["content"],
    }));
}

/** Build Anthropic request parameters from messages and tools. */
function buildAnthropicRequestParams(
  model: string,
  maxTokens: number,
  messages: readonly LlmMessage[],
  tools: readonly unknown[],
): MessageCreateParamsNonStreaming {
  const systemPrompt = extractAnthropicSystemPrompt(messages);
  const anthropicMessages = convertToAnthropicMessages(messages);
  const anthropicTools = convertToolsToAnthropicFormat(tools);
  return {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
  };
}

/** Extract text and tool use blocks from an Anthropic response. */
function parseAnthropicCompletionResponse(
  content: readonly { type: string; text?: string }[],
  usage: { readonly input_tokens: number; readonly output_tokens: number },
  stopReason?: string,
): LlmCompletionResult {
  const textContent = content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? (block.text ?? "") : "")
    .join("");
  // Normalize Anthropic's stop_reason to OpenAI-style finish_reason
  const finishReason = stopReason === "max_tokens"
    ? "length"
    : stopReason === "end_turn"
    ? "stop"
    : stopReason === "tool_use"
    ? "tool_calls"
    : stopReason ?? undefined;
  return {
    content: textContent,
    toolCalls: content.filter((block) => block.type === "tool_use"),
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    },
    ...(finishReason ? { finishReason } : {}),
  };
}

/**
 * Create an Anthropic LLM provider.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Anthropic API
 */
export function createAnthropicProvider(
  config: AnthropicConfig = {},
): LlmProvider {
  const model = config.model ?? "claude-sonnet-4-5-20250929";
  const maxTokens = config.maxTokens ?? resolveModelInfo(model).outputLimit;

  // Defer client creation to first use — avoids throwing during
  // provider registration when credentials aren't yet available.
  let client: Anthropic | undefined;

  function getClient(): Anthropic {
    if (!client) {
      const apiKey = config.apiKey ?? Deno.env.get("ANTHROPIC_API_KEY");

      if (!apiKey) {
        throw new Error(
          "Anthropic API key not configured. " +
            "Set apiKey in triggerfish.yaml under models.providers.anthropic, " +
            "or run 'triggerfish dive' to reconfigure.",
        );
      }

      client = new Anthropic({ apiKey });
    }
    return client;
  }

  return {
    name: "anthropic",
    supportsStreaming: true,
    contextWindow: resolveModelInfo(model).contextWindow,

    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): Promise<LlmCompletionResult> {
      const signal = options.signal as AbortSignal | undefined;
      const params = buildAnthropicRequestParams(
        model,
        maxTokens,
        messages,
        tools,
      );
      const response = await getClient().messages.create(
        params,
        signal ? { signal } : undefined,
      );
      return parseAnthropicCompletionResponse(
        response.content,
        response.usage,
        response.stop_reason ?? undefined,
      );
    },

    async *stream(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): AsyncIterable<LlmStreamChunk> {
      const signal = options.signal as AbortSignal | undefined;
      const params = buildAnthropicRequestParams(
        model,
        maxTokens,
        messages,
        tools,
      );
      const stream = getClient().messages.stream(
        params,
        signal ? { signal } : undefined,
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && "delta" in event) {
          const delta = event.delta as { type: string; text?: string };
          if (delta.type === "text_delta" && delta.text) {
            yield { text: delta.text, done: false };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      const toolUseBlocks = finalMessage.content
        .filter((block: { type: string }) => block.type === "tool_use");
      const stopReason = finalMessage.stop_reason;
      const finishReason = stopReason === "max_tokens"
        ? "length"
        : stopReason === "end_turn"
        ? "stop"
        : stopReason === "tool_use"
        ? "tool_calls"
        : stopReason ?? undefined;
      yield {
        text: "",
        done: true,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
        ...(toolUseBlocks.length > 0 ? { toolCalls: toolUseBlocks } : {}),
        ...(finishReason ? { finishReason } : {}),
      };
    },
  };
}
