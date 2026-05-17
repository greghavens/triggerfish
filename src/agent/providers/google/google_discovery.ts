/**
 * Google (Gemini) model-metadata discovery.
 *
 * Queries the Generative Language API's
 * `GET /v1beta/models/{model}?key={apiKey}` endpoint to retrieve the
 * `inputTokenLimit` and `outputTokenLimit` Google publishes per model.
 * Both values replace registry defaults: Gemini families share the
 * same context_window across many model IDs, but new variants land
 * frequently and the registry can lag.
 *
 * Results are cached at module scope, keyed by model id.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("google-discovery");

/** Limits advertised by Google for a specific Gemini model. */
export interface DiscoveredGoogleLimits {
  /** Input token limit (context window). */
  readonly inputTokenLimit: number;
  /** Output token limit (max completion tokens). */
  readonly outputTokenLimit?: number;
}

/** Cached promises keyed by model id. */
const cache = new Map<string, Promise<DiscoveredGoogleLimits | null>>();

/** Shape of the Generative Language API model response. */
interface GoogleModelResponse {
  readonly inputTokenLimit?: number;
  readonly outputTokenLimit?: number;
}

/** Build the model details URL for the v1beta endpoint. */
function buildModelUrl(model: string, apiKey: string): string {
  const normalized = model.startsWith("models/") ? model : `models/${model}`;
  return `https://generativelanguage.googleapis.com/v1beta/${normalized}?key=${
    encodeURIComponent(apiKey)
  }`;
}

/** Probe Google for a specific Gemini model's metadata. */
async function probeGoogle(
  apiKey: string,
  model: string,
): Promise<DiscoveredGoogleLimits | null> {
  try {
    const res = await fetch(buildModelUrl(model, apiKey));
    if (!res.ok) {
      log.debug(
        `google /v1beta/models/${model} returned ${res.status}; falling back to registry`,
      );
      return null;
    }
    const data = (await res.json()) as GoogleModelResponse;
    const input = data.inputTokenLimit;
    if (typeof input !== "number" || input <= 0) return null;
    const out = data.outputTokenLimit;
    return {
      inputTokenLimit: input,
      ...(typeof out === "number" && out > 0 ? { outputTokenLimit: out } : {}),
    };
  } catch (err) {
    log.debug("google model discovery failed", { err });
    return null;
  }
}

/**
 * Discover input/output token limits for a Gemini model.
 *
 * Returns null on failure — caller should fall back to registry values.
 */
export function discoverGoogleModelLimits(
  apiKey: string,
  model: string,
): Promise<DiscoveredGoogleLimits | null> {
  const cached = cache.get(model);
  if (cached) return cached;
  const promise = probeGoogle(apiKey, model);
  cache.set(model, promise);
  return promise;
}

/** Reset the module-level cache. Test-only. */
export function resetGoogleDiscoveryCache(): void {
  cache.clear();
}
