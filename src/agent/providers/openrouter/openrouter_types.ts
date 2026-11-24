/**
 * OpenRouter provider types and constants.
 *
 * Shared configuration, API response shape, endpoint URL,
 * and error-message helpers used by the OpenRouter integration.
 *
 * @module
 */

/** Configuration for the OpenRouter provider. */
export interface OpenRouterConfig {
  /** OpenRouter API key. Set in triggerfish.yaml under models.providers.openrouter. */
  readonly apiKey?: string;
  /** Model identifier (e.g. "anthropic/claude-3.5-sonnet", "openai/gpt-4o"). */
  readonly model: string;
  /** Maximum tokens for completion. Default: model's outputLimit from registry. */
  readonly maxTokens?: number;
}

/** OpenRouter API endpoint. */
export const OPENROUTER_API_URL =
  "https://openrouter.ai/api/v1/chat/completions";

/** Shape of an OpenRouter API response. */
export interface OpenRouterApiResponse {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string;
      readonly tool_calls?: unknown[];
    };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
  readonly error?: {
    readonly code?: number;
  };
}

/**
 * If the error body mentions "data policy", return a hint telling the user
 * how to fix their OpenRouter privacy settings. Otherwise return empty string.
 */
export function formatDataPolicyHint(body: string): string {
  if (body.includes("data policy")) {
    return (
      "\n\n→ Your OpenRouter privacy settings are blocking this model's endpoints.\n" +
      "  Fix: visit https://openrouter.ai/settings/privacy and under\n" +
      '  "Privacy and Guardrails" adjust your settings to allow the\n' +
      "  providers your model requires."
    );
  }
  return "";
}

/** Check if an HTTP status or API error code is retryable. */
export function isRetryableStatusCode(code: number): boolean {
  return code === 502 || code === 503 || code === 429;
}
