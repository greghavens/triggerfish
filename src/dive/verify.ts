/**
 * LLM provider connection verification.
 *
 * Makes a lightweight GET to the provider's model-list endpoint
 * to verify connectivity and authentication without consuming tokens.
 *
 * @module
 */

import type { ProviderChoice } from "./wizard.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of a provider verification attempt. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly error?: string;
}

// ─── Verification URLs ───────────────────────────────────────────────────────

interface ProviderEndpoint {
  readonly url: (apiKey: string, endpoint?: string) => string;
  readonly headers: (apiKey: string) => Record<string, string>;
}

const PROVIDER_ENDPOINTS: Readonly<Record<ProviderChoice, ProviderEndpoint>> = {
  triggerfish: {
    url: () => "https://api.trigger.fish/v1/license/validate",
    headers: (apiKey) => ({ "Authorization": `Bearer ${apiKey}` }),
  },
  anthropic: {
    url: () => "https://api.anthropic.com/v1/models",
    headers: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
  },
  openai: {
    url: () => "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ "Authorization": `Bearer ${apiKey}` }),
  },
  google: {
    url: (apiKey) =>
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    headers: () => ({}),
  },
  ollama: {
    url: (_apiKey, endpoint) => `${endpoint}/v1/models`,
    headers: () => ({}),
  },
  lmstudio: {
    url: (_apiKey, endpoint) => `${endpoint}/v1/models`,
    headers: () => ({}),
  },
  openrouter: {
    url: () => "https://openrouter.ai/api/v1/models",
    headers: (apiKey) => ({ "Authorization": `Bearer ${apiKey}` }),
  },
  zenmux: {
    url: () => "https://zenmux.ai/api/v1/models",
    headers: (apiKey) => ({ "Authorization": `Bearer ${apiKey}` }),
  },
  zai: {
    url: () => "https://api.z.ai/api/coding/paas/v4/models",
    headers: (apiKey) => ({ "Authorization": `Bearer ${apiKey}` }),
  },
};

// ─── Public API ──────────────────────────────────────────────────────────────

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Extract model IDs from a provider's model-list response.
 *
 * Most providers use OpenAI-compatible format: `{ data: [{ id }] }`.
 * Google uses: `{ models: [{ name: "models/..." }] }`.
 */
function extractModelIds(
  provider: ProviderChoice,
  body: unknown,
): ReadonlyArray<string> {
  if (typeof body !== "object" || body === null) return [];

  if (provider === "google") {
    const g = body as { models?: ReadonlyArray<{ name?: string }> };
    if (!Array.isArray(g.models)) return [];
    return g.models
      .map((m) => typeof m.name === "string" ? m.name.replace(/^models\//, "") : "")
      .filter((id) => id.length > 0);
  }

  // OpenAI-compatible: { data: [{ id }] }
  const o = body as { data?: ReadonlyArray<{ id?: string }> };
  if (!Array.isArray(o.data)) return [];
  return o.data
    .map((m) => typeof m.id === "string" ? m.id : "")
    .filter((id) => id.length > 0);
}

/**
 * Check whether the requested model appears in the list.
 *
 * For Ollama, `llama3` matches `llama3:latest` (tag-less input matches
 * the `:latest` variant).
 */
function modelInList(
  model: string,
  ids: ReadonlyArray<string>,
  provider: ProviderChoice,
): boolean {
  if (ids.includes(model)) return true;

  // Ollama lists models with a tag suffix (e.g. "llama3:latest")
  if (provider === "ollama" && !model.includes(":")) {
    return ids.some((id) => id === `${model}:latest`);
  }

  return false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify LLM provider connectivity, authentication, and model availability.
 *
 * Makes a GET to the provider's model-list endpoint, checks the response
 * for the requested model. No tokens are consumed.
 *
 * @param provider - The LLM provider to verify
 * @param apiKey - API key (ignored for local provider)
 * @param model - Model name the user entered
 * @param endpoint - Custom endpoint URL (only used for "ollama" provider)
 * @param fetcher - Injected fetch for testing (defaults to global fetch)
 */
export async function verifyProvider(
  provider: ProviderChoice,
  apiKey: string,
  model: string,
  endpoint?: string,
  fetcher: typeof fetch = fetch,
): Promise<VerifyResult> {
  const config = PROVIDER_ENDPOINTS[provider];
  const url = config.url(apiKey, endpoint);
  const headers = config.headers(apiKey);

  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error:
          "API key was not accepted. Check that your key is correct and active.",
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `Server returned an error (HTTP ${response.status}).`,
      };
    }

    // Parse model list and verify the requested model exists
    const body: unknown = await response.json();
    const ids = extractModelIds(provider, body);

    if (ids.length > 0 && !modelInList(model, ids, provider)) {
      return {
        ok: false,
        error: `Model "${model}" was not found. Available models include: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", ..." : ""}.`,
      };
    }

    return { ok: true };
  } catch (err: unknown) {
    const displayUrl = provider === "ollama" || provider === "lmstudio" ? (endpoint ?? url) : url;

    if (err instanceof DOMException && err.name === "TimeoutError") {
      return {
        ok: false,
        error: `Connection timed out reaching ${displayUrl}.`,
      };
    }

    if (err instanceof TypeError) {
      return {
        ok: false,
        error:
          `Could not reach ${displayUrl}. Check the address and your internet connection.`,
      };
    }

    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        ok: false,
        error: `Connection timed out reaching ${displayUrl}.`,
      };
    }

    return {
      ok: false,
      error:
        `Could not reach ${displayUrl}. Check the address and your internet connection.`,
    };
  }
}
