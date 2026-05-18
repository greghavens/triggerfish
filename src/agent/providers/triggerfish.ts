/**
 * Triggerfish Gateway LLM provider implementation.
 *
 * Routes LLM requests through the Triggerfish Gateway, which handles
 * model selection, provider failover, and token clamping internally.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import type { LlmMessage, LlmProvider, LlmStreamChunk } from "../llm.ts";
import { parseSseStream } from "./sse.ts";
import {
  buildChatRequestBody,
  buildHeaders,
  formatGatewayError,
  isRetriableStatus,
  logBudgetHeaders,
  MAX_RETRIES,
  parseCompletionResponse,
} from "./triggerfish_request.ts";

const log = createLogger("triggerfish-cloud");

/**
 * Parse a response body that may be JSON or SSE-formatted.
 *
 * The Triggerfish Gateway occasionally returns SSE `data:` lines even
 * when `stream:false` was requested. When the body isn't valid JSON,
 * extract the last non-[DONE] SSE data line and parse that instead.
 */
// deno-lint-ignore no-explicit-any
function parsePossibleSseResponse(rawText: string): any {
  const trimmed = rawText.trimStart();
  if (!trimmed.startsWith("data:")) {
    return JSON.parse(rawText);
  }
  log.warn("Gateway returned SSE for non-streaming request — extracting last event", {
    operation: "parsePossibleSseResponse",
    rawLen: rawText.length,
  });
  const lines = rawText.split("\n");
  let lastData: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("data: ") && t !== "data: [DONE]") {
      lastData = t.slice(6);
    }
  }
  if (!lastData) {
    throw new Error("Gateway returned SSE with no parseable data events");
  }
  return JSON.parse(lastData);
}

/** Configuration for the Triggerfish Gateway provider. */
export interface TriggerfishConfig {
  /** Gateway base URL. Defaults to production. */
  readonly gatewayUrl?: string;
  /** License key. Falls back to TRIGGERFISH_LICENSE_KEY env var. */
  readonly licenseKey?: string;
  /** Maximum tokens for completion. Default: 16384 */
  readonly maxTokens?: number;
}

/**
 * Create a Triggerfish Gateway LLM provider.
 *
 * Routes all LLM requests through the Triggerfish Gateway.
 * The gateway handles model selection and provider failover — the agent
 * does not send a `model` field. Thinking/reasoning is explicitly
 * controlled: disabled when tools are present, enabled otherwise.
 *
 * @param config - Provider configuration
 * @returns An LlmProvider backed by the Triggerfish Gateway
 */
export function createTriggerfishProvider(
  config: TriggerfishConfig,
): LlmProvider {
  const gatewayUrl = config.gatewayUrl ??
    Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
    "https://api.trigger.fish";
  const licenseKey = config.licenseKey ??
    Deno.env.get("TRIGGERFISH_LICENSE_KEY") ?? "";
  const maxTokens = config.maxTokens ?? 16384;
  const chatUrl = `${gatewayUrl}/v1/llm/chat`;

  if (!licenseKey) {
    log.warn(
      "Triggerfish Gateway license key not configured. " +
        "Run 'triggerfish dive' to set up your subscription, " +
        "or set TRIGGERFISH_LICENSE_KEY in your environment.",
    );
  }

  return {
    name: "triggerfish",
    supportsStreaming: true,
    contextWindow: 200_000,

    async complete(
      messages: readonly LlmMessage[],
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ) {
      const signal = options.signal as AbortSignal | undefined;
      const sessionId = options.sessionId as string | undefined;
      const body = buildChatRequestBody({
        maxTokens,
        messages,
        tools,
        streaming: false,
      });
      const requestBody = JSON.stringify(body);
      const headers = buildHeaders(licenseKey, sessionId);

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

        logBudgetHeaders(response.headers);

        if (!response.ok) {
          const text = await response.text();
          const friendly = formatGatewayError(response.status, text);
          if (isRetriableStatus(response.status) && attempt < MAX_RETRIES) {
            log.debug(`HTTP ${response.status}: ${text.slice(0, 200)}`);
            lastError = friendly;
            continue;
          }
          throw new Error(friendly);
        }

        const rawText = await response.text();
        log.trace(`status=${response.status} rawLen=${rawText.length}`);

        const data = parsePossibleSseResponse(rawText);

        if (data.error) {
          const code = data.error.code;
          const friendly = formatGatewayError(
            typeof code === "number" ? code : 0,
            JSON.stringify(data.error),
          );
          if (isRetriableStatus(code) && attempt < MAX_RETRIES) {
            log.debug(
              `API error ${code}: ${JSON.stringify(data.error).slice(0, 200)}`,
            );
            lastError = friendly;
            continue;
          }
          throw new Error(friendly);
        }

        return parseCompletionResponse(data);
      }

      throw new Error(
        `Triggerfish Gateway request failed after ${MAX_RETRIES} retries: ${
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
      const body = buildChatRequestBody({
        maxTokens,
        messages,
        tools,
        streaming: true,
      });
      const headers = buildHeaders(licenseKey, sessionId);

      const response = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

      logBudgetHeaders(response.headers);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(formatGatewayError(response.status, text));
      }

      if (!response.body) {
        throw new Error("No response body for streaming");
      }

      yield* parseSseStream(response.body);
    },
  };
}
