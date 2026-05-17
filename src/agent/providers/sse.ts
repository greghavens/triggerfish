/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible streaming.
 *
 * Parses `data: ...` lines from an SSE response body into typed chunks.
 *
 * @module
 */

import type { LlmStreamChunk } from "../llm.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("llm");

/**
 * Parse an SSE response stream from an OpenAI-compatible endpoint.
 *
 * Yields LlmStreamChunk objects for each content delta.
 * The final chunk has `done: true` and includes usage if available.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<LlmStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | undefined;

  // Accumulate streaming tool call deltas keyed by index
  const toolCallAccum = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          // reasoning_content rides a separate field so downstream code can
          // route it to a thinking UI surface without polluting the visible
          // response stream. Used by OpenAI-compatible servers exposing
          // model thinking (DeepSeek R1, Qwen3, GLM Z1/4.7, Kimi K2.5, etc.).
          if (delta?.reasoning_content) {
            yield { text: "", reasoning: delta.reasoning_content, done: false };
          }
          if (delta?.content) {
            yield { text: delta.content, done: false };
          }
          // Accumulate tool_calls deltas (OpenAI streaming format)
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallAccum.get(idx);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                toolCallAccum.set(idx, {
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason as string;
          }
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens ?? 0;
            outputTokens = parsed.usage.completion_tokens ?? 0;
          }
        } catch (parseErr: unknown) {
          log.debug("SSE line parse failed", {
            error: parseErr instanceof Error
              ? parseErr.message
              : String(parseErr),
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Assemble accumulated tool calls into OpenAI format.
  // Skip entries with no function name (phantom deltas from models that
  // send empty tool_calls fragments in their stream).
  const toolCalls: unknown[] = [];
  for (
    const [_, tc] of [...toolCallAccum.entries()].sort((a, b) => a[0] - b[0])
  ) {
    if (!tc.name) continue;
    toolCalls.push({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    });
  }

  yield {
    text: "",
    done: true,
    usage: { inputTokens, outputTokens },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
