/**
 * Fireworks AI model-metadata discovery.
 *
 * Queries Fireworks' native control-plane API
 * (`GET /v1/{model_resource_name}`) to retrieve the actual context
 * window advertised for a deployed model. Replaces static registry
 * values with the limit the upstream provider reports.
 *
 * Use the NATIVE `/v1/` API, NOT the OpenAI-compatible `/inference/v1/`
 * shim — the native API exposes model metadata fields the shim does not.
 *
 * Discovery results are cached at module scope, keyed by model name.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("fireworks-discovery");

/** Limits advertised by Fireworks for a specific model. */
export interface DiscoveredFireworksLimits {
  /** Total context window in tokens. */
  readonly contextLength: number;
}

/** Fireworks native control-plane base URL. */
const FIREWORKS_NATIVE_BASE = "https://api.fireworks.ai/v1";

/** Cached promises keyed by model resource name. */
const cache = new Map<string, Promise<DiscoveredFireworksLimits | null>>();

/** Shape of the Fireworks model details response (only fields we use). */
interface FireworksModelResponse {
  readonly contextLength?: number;
  readonly context_length?: number;
}

/** Probe Fireworks for a specific model's metadata. */
async function probeFireworks(
  apiKey: string,
  model: string,
): Promise<DiscoveredFireworksLimits | null> {
  try {
    const res = await fetch(`${FIREWORKS_NATIVE_BASE}/${model}`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      log.debug(
        `fireworks /v1/${model} returned ${res.status}; falling back to registry`,
      );
      return null;
    }
    const data = (await res.json()) as FireworksModelResponse;
    const ctx = data.contextLength ?? data.context_length;
    if (typeof ctx !== "number" || ctx <= 0) return null;
    return { contextLength: ctx };
  } catch (err) {
    log.debug("fireworks model discovery failed", { err });
    return null;
  }
}

/**
 * Discover context limits for a Fireworks model.
 *
 * Returns null if the model is not retrievable or the request fails —
 * caller should fall back to static registry values.
 */
export function discoverFireworksModelLimits(
  apiKey: string,
  model: string,
): Promise<DiscoveredFireworksLimits | null> {
  const cached = cache.get(model);
  if (cached) return cached;
  const promise = probeFireworks(apiKey, model);
  cache.set(model, promise);
  return promise;
}

/** Reset the module-level cache. Test-only. */
export function resetFireworksDiscoveryCache(): void {
  cache.clear();
}
