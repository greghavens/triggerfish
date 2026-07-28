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

/**
 * Convert LLM messages to Anthropic MessageParam format (excluding system).
 *
 * The agent loop stores tool interactions in OpenAI Chat Completions shape:
 *   - assistant message carries `tool_calls` (provider-native objects)
 *   - tool results arrive as standalone `role: "tool"` messages with
 *     `tool_call_id` (one per call)
 *
 * Anthropic instead embeds these inline as content blocks:
 *   - assistant message content array contains `tool_use` blocks
 *   - the following user message content array contains `tool_result` blocks
 *
 * This converter performs that rewrap so a history populated by any
 * OpenAI-compatible provider can still be replayed through Anthropic.
 * `tool_use` blocks stored verbatim on `tool_calls` (which is the case when
 * Anthropic itself produced the prior turn) pass through unchanged.
 */
function convertToAnthropicMessages(
  messages: readonly LlmMessage[],
  // deno-lint-ignore no-explicit-any
): any[] {
  const filtered = messages.filter((m) => m.role !== "system");
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  // deno-lint-ignore no-explicit-any
  let pendingToolResults: any[] = [];

  function flushPendingToolResults(): void {
    if (pendingToolResults.length === 0) return;
    out.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  }

  for (const m of filtered) {
    const msg = m as LlmMessage & {
      readonly tool_calls?: readonly unknown[];
      readonly tool_call_id?: string;
      readonly reasoningBlocks?: readonly unknown[];
    };

    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        ...(msg.tool_call_id ? { tool_use_id: msg.tool_call_id } : {}),
        content: typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
      });
      continue;
    }

    flushPendingToolResults();

    if (
      msg.role === "assistant" && Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      const textContent = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);
      // deno-lint-ignore no-explicit-any
      const content: any[] = [];
      // Thinking blocks are signed and must lead the assistant turn,
      // replayed byte-identical — the API rejects edited blocks, and with
      // tool use it requires the current turn's thinking to be present.
      if (msg.reasoningBlocks) content.push(...msg.reasoningBlocks);
      if (textContent && textContent.trim().length > 0) {
        content.push({ type: "text", text: textContent });
      }
      for (const tc of msg.tool_calls) {
        const t = tc as Record<string, unknown>;
        if (t?.type === "tool_use") {
          content.push(t);
          continue;
        }
        const fn = (t?.function ?? {}) as {
          name?: string;
          arguments?: string;
        };
        let input: Record<string, unknown> = {};
        if (typeof fn.arguments === "string") {
          try {
            input = JSON.parse(fn.arguments);
          } catch (_err) {
            input = {};
          }
        }
        content.push({
          type: "tool_use",
          id: typeof t.id === "string" ? t.id : "",
          name: fn.name ?? "",
          input,
        });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    out.push({
      role: msg.role as "user" | "assistant",
      content: msg.content as MessageParam["content"],
    });
  }

  flushPendingToolResults();
  return out;
}

/**
 * Claude generations that take the adaptive thinking parameter.
 *
 * Adaptive thinking arrived with the 4.6 generation; sending it to an older
 * model is rejected. This is a wire-protocol version check, not a
 * capability gate — thinking itself is requested on every model that
 * accepts the parameter, with no per-model allowlist.
 */
const ADAPTIVE_THINKING_MODELS =
  /claude-(?:opus-(?:4-6|4-7|4-8|5)|sonnet-(?:4-6|5)|fable-5|mythos-5)/i;

/**
 * Build the thinking parameter for a Claude model.
 *
 * `display: "summarized"` is explicit because the default is `"omitted"`
 * on Opus 4.7 and later, which returns thinking blocks with empty text and
 * leaves the reasoning UI blank.
 */
function buildAnthropicThinkingConfig(
  model: string,
): Record<string, unknown> {
  if (!ADAPTIVE_THINKING_MODELS.test(model)) return {};
  return { thinking: { type: "adaptive", display: "summarized" } };
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
    ...buildAnthropicThinkingConfig(model),
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
  // Keep the blocks themselves for replay; the joined text is display only.
  const reasoningBlocks = content.filter(
    (block) => block.type === "thinking" || block.type === "redacted_thinking",
  );
  const reasoning = reasoningBlocks
    .map((block) => (block as { thinking?: string }).thinking ?? "")
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
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
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
    model,
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
          const delta = event.delta as {
            type: string;
            text?: string;
            thinking?: string;
          };
          if (delta.type === "text_delta" && delta.text) {
            yield { text: delta.text, done: false };
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { text: "", reasoning: delta.thinking, done: false };
          }
        }
      }

      const finalMessage = await stream.finalMessage();
      const toolUseBlocks = finalMessage.content
        .filter((block: { type: string }) => block.type === "tool_use");
      const thinkingBlocks = finalMessage.content.filter(
        (block: { type: string }) =>
          block.type === "thinking" || block.type === "redacted_thinking",
      );
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
        ...(thinkingBlocks.length > 0
          ? { reasoningBlocks: thinkingBlocks }
          : {}),
        ...(finishReason ? { finishReason } : {}),
      };
    },
  };
}
