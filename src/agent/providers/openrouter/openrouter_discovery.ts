/**
 * OpenRouter model-metadata discovery.
 *
 * Fetches OpenRouter's public models endpoint to retrieve the actual
 * context window and max completion tokens reported by the upstream
 * provider. Lets us replace static registry values with what OpenRouter
 * currently advertises, which is especially useful when routing to many
 * different backends with varying limits.
 *
 * The endpoint response is cached at module scope: the models list is
 * fetched once per process, parsed into a map keyed by model id, and
 * reused for every subsequent lookup.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("openrouter-discovery");

/** Limits advertised by OpenRouter for a specific model id. */
export interface DiscoveredModelLimits {
  /** Total context window in tokens (input + output). */
  readonly contextLength: number;
  /** Maximum completion tokens, if separately reported. */
  readonly maxCompletionTokens?: number;
}

/** OpenRouter `/api/v1/models` URL. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Shape of one entry in the OpenRouter models response. */
interface OpenRouterModelEntry {
  readonly id?: string;
  readonly context_length?: number;
  readonly top_provider?: {
    readonly context_length?: number;
    readonly max_completion_tokens?: number;
  };
}

/** Shape of the `/api/v1/models` response. */
interface OpenRouterModelsResponse {
  readonly data?: readonly OpenRouterModelEntry[];
}

/** Cached models list promise (process-wide). */
let modelsListPromise: Promise<Map<string, DiscoveredModelLimits>> | null = null;

/** Fetch the full models list and index by model id. */
async function fetchOpenRouterModels(
  apiKey: string,
): Promise<Map<string, DiscoveredModelLimits>> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    log.debug(
      `openrouter /models returned ${res.status}; falling back to registry`,
    );
    return new Map();
  }
  const data = (await res.json()) as OpenRouterModelsResponse;
  const out = new Map<string, DiscoveredModelLimits>();
  for (const m of data.data ?? []) {
    if (!m.id) continue;
    const ctx = m.top_provider?.context_length ?? m.context_length;
    if (ctx === undefined) continue;
    const maxCompletion = m.top_provider?.max_completion_tokens;
    out.set(m.id, {
      contextLength: ctx,
      ...(maxCompletion ? { maxCompletionTokens: maxCompletion } : {}),
    });
  }
  return out;
}

/**
 * Discover context/output limits for a specific OpenRouter model.
 *
 * Returns null if the model is not listed in the API response or the
 * request fails — caller should fall back to static registry values.
 */
export async function discoverOpenRouterModelLimits(
  apiKey: string,
  model: string,
): Promise<DiscoveredModelLimits | null> {
  if (!modelsListPromise) {
    modelsListPromise = fetchOpenRouterModels(apiKey).catch((err) => {
      log.debug("openrouter model discovery failed", { err });
      modelsListPromise = null;
      return new Map<string, DiscoveredModelLimits>();
    });
  }
  const models = await modelsListPromise;
  return models.get(model) ?? null;
}

/** Reset the module-level cache. Test-only. */
export function resetOpenRouterDiscoveryCache(): void {
  modelsListPromise = null;
}
