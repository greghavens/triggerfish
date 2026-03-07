/**
 * Triggerfish Cloud LLM provider implementation.
 *
 * Routes LLM requests through the Triggerfish Cloud gateway, which handles
 * model selection, provider failover, and token clamping internally.
 * Uses the OpenAI-compatible chat completions format.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import type {
  LlmCompletionResult,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
} from "../llm.ts";
import { parseSseStream } from "./sse.ts";
import type { ContentBlock } from "../../image/content.ts";

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

/** Configuration for the Triggerfish Cloud provider. */
export interface TriggerfishConfig {
  /** Gateway base URL. Defaults to production. */
  readonly gatewayUrl?: string;
  /** License key. Falls back to TRIGGERFISH_LICENSE_KEY env var. */
  readonly licenseKey?: string;
  /** Maximum tokens for completion. Default: 4096 */
  readonly maxTokens?: number;
}

/**
 * Create a Triggerfish Cloud LLM provider.
 *
 * Routes all LLM requests through the Triggerfish Cloud gateway.
 * The gateway handles model selection and provider failover — the agent
 * does not send a `model` field.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Triggerfish Cloud gateway
 */
export function createTriggerfishProvider(
  config: TriggerfishConfig,
): LlmProvider {
  const gatewayUrl = config.gatewayUrl ??
    Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
    "https://api.trigger.fish";
  const licenseKey = config.licenseKey ??
    Deno.env.get("TRIGGERFISH_LICENSE_KEY") ?? "";
  const maxTokens = config.maxTokens ?? 4096;
  const chatUrl = `${gatewayUrl}/v1/llm/chat`;

  if (!licenseKey) {
    throw new Error(
      "Triggerfish Cloud license key not configured. " +
        "Run 'triggerfish dive' to set up your subscription, " +
        "or set TRIGGERFISH_LICENSE_KEY in your environment.",
    );
  }

  const log = createLogger("triggerfish-cloud");

  return {
    name: "triggerfish",
    supportsStreaming: true,
    // Gateway manages model selection; use a generous default context window
    contextWindow: 200_000,

    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): Promise<LlmCompletionResult> {
      const signal = options.signal as AbortSignal | undefined;
      const sessionId = options.sessionId as string | undefined;
      const openaiMessages = messages.map((m) => ({
        role: m.role,
        content: toOpenAiContent(m.content),
      }));

      const body: Record<string, unknown> = {
        max_tokens: maxTokens,
        messages: openaiMessages,
      };
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
      }

      const requestBody = JSON.stringify(body);

      log.debug(`msgs=${openaiMessages.length} body=${requestBody.length}chars`);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${licenseKey}`,
      };
      if (sessionId) {
        headers["X-Session-Id"] = sessionId;
      }

      const MAX_RETRIES = 2;
      let lastError: string | undefined;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delayMs = 1000 * Math.pow(2, attempt - 1);
          log.debug(`retry ${attempt}/${MAX_RETRIES} after ${delayMs}ms`);
          await new Promise((r) => setTimeout(r, delayMs));
        }

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: requestBody,
          ...(signal ? { signal } : {}),
        });

        // Log budget headers
        logBudgetHeaders(response.headers, log);

        if (!response.ok) {
          const text = await response.text();
          if (
            (response.status === 502 || response.status === 503 ||
              response.status === 429) &&
            attempt < MAX_RETRIES
          ) {
            log.debug(`HTTP ${response.status}: ${text.slice(0, 200)}`);
            lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`;
            continue;
          }
          throw new Error(
            `Triggerfish Cloud request failed (${response.status}): ${text}`,
          );
        }

        const rawText = await response.text();
        log.trace(`status=${response.status} rawLen=${rawText.length}`);

        const data = JSON.parse(rawText);

        if (data.error) {
          const code = data.error.code;
          if (
            (code === 502 || code === 503 || code === 429) &&
            attempt < MAX_RETRIES
          ) {
            log.debug(
              `API error ${code}: ${JSON.stringify(data.error).slice(0, 200)}`,
            );
            lastError = `API ${code}: ${
              JSON.stringify(data.error).slice(0, 200)
            }`;
            continue;
          }
          throw new Error(
            `Triggerfish Cloud API error: ${JSON.stringify(data.error)}`,
          );
        }

        const content = data.choices?.[0]?.message?.content ?? "";
        return {
          content,
          toolCalls: data.choices?.[0]?.message?.tool_calls ?? [],
          usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
          },
        };
      }

      throw new Error(
        `Triggerfish Cloud request failed after ${MAX_RETRIES} retries: ${
          lastError ?? "unknown"
        }`,
      );
    },

    async *stream(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ): AsyncIterable<LlmStreamChunk> {
      const signal = options.signal as AbortSignal | undefined;
      const sessionId = options.sessionId as string | undefined;
      const openaiMessages = messages.map((m) => ({
        role: m.role,
        content: toOpenAiContent(m.content),
      }));

      const streamBody: Record<string, unknown> = {
        max_tokens: maxTokens,
        messages: openaiMessages,
        stream: true,
      };
      if (Array.isArray(tools) && tools.length > 0) {
        streamBody.tools = tools;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${licenseKey}`,
      };
      if (sessionId) {
        headers["X-Session-Id"] = sessionId;
      }

      const response = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(streamBody),
        ...(signal ? { signal } : {}),
      });

      // Log budget headers
      logBudgetHeaders(response.headers, log);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Triggerfish Cloud stream failed (${response.status}): ${body}`,
        );
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
      }

      yield* parseSseStream(response.body);
    },
  };
}

/** Log budget-related response headers at debug level. */
function logBudgetHeaders(
  headers: Headers,
  log: ReturnType<typeof createLogger>,
): void {
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
