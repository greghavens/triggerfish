/**
 * Local LLM server model-metadata discovery.
 *
 * Probes LM Studio's `/api/v0/models/{id}` and Ollama's `/api/show`
 * native endpoints to retrieve the actual context window the server
 * has loaded for a given model. Both APIs are unauthenticated and
 * return different shapes; the discovery function tries each in turn.
 *
 * For LM Studio, prefer `loaded_context_length` (what's actually
 * usable for this load) over `max_context_length` (the model's max).
 * Users frequently load a model with a smaller context than the model
 * supports; over-requesting causes OOM errors.
 *
 * For Ollama, scan `model_info` for any `*.context_length` entry —
 * the key prefix varies by architecture (`llama.context_length`,
 * `qwen2.context_length`, `gpt_oss.context_length`, etc.).
 *
 * Discovery results are cached at module scope, keyed by
 * `${endpoint}::${model}`, so repeated provider creations don't
 * re-probe.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("local-discovery");

/** Limits advertised by the local server for a specific model. */
export interface DiscoveredLocalLimits {
  /** Total context window in tokens (input + output). */
  readonly contextLength: number;
}

/** Cache of discovery results keyed by `${endpoint}::${model}`. */
const cache = new Map<string, Promise<DiscoveredLocalLimits | null>>();

/** Build the cache key for a (endpoint, model) tuple. */
function cacheKey(endpoint: string, model: string): string {
  return `${endpoint}::${model}`;
}

/** Shape of LM Studio's `/api/v0/models/{id}` response. */
interface LmStudioModelResponse {
  readonly max_context_length?: number;
  readonly loaded_context_length?: number;
}

/** Probe LM Studio's native API. Returns null on any error or missing data. */
async function probeLmStudio(
  endpoint: string,
  model: string,
): Promise<DiscoveredLocalLimits | null> {
  try {
    const res = await fetch(
      `${endpoint}/api/v0/models/${encodeURIComponent(model)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as LmStudioModelResponse;
    const ctx = data.loaded_context_length ?? data.max_context_length;
    if (typeof ctx !== "number" || ctx <= 0) return null;
    return { contextLength: ctx };
  } catch (err) {
    log.debug("lmstudio model discovery failed", { err });
    return null;
  }
}

/** Shape of Ollama's `/api/show` response (only fields we use). */
interface OllamaShowResponse {
  readonly model_info?: Record<string, unknown>;
}

/**
 * Extract `*.context_length` from Ollama's `model_info` map.
 *
 * Ollama keys context length under the architecture name
 * (`llama.context_length`, `qwen2.context_length`, etc.), with a
 * fallback `general.context_length` on some builds.
 */
function extractOllamaContextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | null {
  if (!modelInfo) return null;
  for (const [k, v] of Object.entries(modelInfo)) {
    if (k.endsWith(".context_length") && typeof v === "number" && v > 0) {
      return v;
    }
  }
  return null;
}

/** Probe Ollama's native API. Returns null on any error or missing data. */
async function probeOllama(
  endpoint: string,
  model: string,
): Promise<DiscoveredLocalLimits | null> {
  try {
    const res = await fetch(`${endpoint}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as OllamaShowResponse;
    const ctx = extractOllamaContextLength(data.model_info);
    if (ctx === null) return null;
    return { contextLength: ctx };
  } catch (err) {
    log.debug("ollama model discovery failed", { err });
    return null;
  }
}

/** Execute the LM Studio → Ollama probe chain. */
async function probeLocalServer(
  endpoint: string,
  model: string,
): Promise<DiscoveredLocalLimits | null> {
  const lm = await probeLmStudio(endpoint, model);
  if (lm) {
    log.debug(
      `lmstudio reported context_length=${lm.contextLength} for ${model}`,
    );
    return lm;
  }
  const ollama = await probeOllama(endpoint, model);
  if (ollama) {
    log.debug(
      `ollama reported context_length=${ollama.contextLength} for ${model}`,
    );
    return ollama;
  }
  log.debug(`no local server metadata for ${model} at ${endpoint}`);
  return null;
}

/**
 * Discover the loaded context length for a model from a local server.
 *
 * Tries LM Studio's native `/api/v0/models/{id}` first, then Ollama's
 * `/api/show`. Returns null if neither succeeds; caller should fall back
 * to static registry values.
 */
export function discoverLocalModelLimits(
  endpoint: string,
  model: string,
): Promise<DiscoveredLocalLimits | null> {
  const key = cacheKey(endpoint, model);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = probeLocalServer(endpoint, model);
  cache.set(key, promise);
  return promise;
}

/** Reset the module-level cache. Test-only. */
export function resetLocalDiscoveryCache(): void {
  cache.clear();
}
