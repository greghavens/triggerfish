/**
 * Plugin Reef catalog fetching and lookup utilities.
 *
 * Handles catalog retrieval with caching, semver comparison,
 * registry URL validation, and SHA-256 integrity hashing.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";

/** Catalog entry for a published plugin. */
export interface ReefPluginCatalogEntry {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly classification: string;
  readonly trust: string;
  readonly tags: readonly string[];
  readonly checksum: string;
  readonly publishedAt: string;
  readonly declaredEndpoints: readonly string[];
}

/** Full plugin catalog. */
export interface ReefPluginCatalog {
  readonly entries: readonly ReefPluginCatalogEntry[];
  readonly generatedAt: string;
}

const log = createLogger("plugin-reef");

/** In-memory catalog cache (readonly external contract). */
export interface CatalogCache {
  readonly catalog: ReefPluginCatalog | null;
  readonly fetchedAt: number;
}

/** Mutable internal catalog cache state. */
export interface MutableCatalogCache {
  catalog: ReefPluginCatalog | null;
  fetchedAt: number;
}

/** Compute SHA-256 hex digest of content. */
export async function computeHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function tryParseUrl(url: string, label: string): Result<URL, string> {
  try {
    return { ok: true, value: new URL(url) };
  } catch {
    return { ok: false, error: `${label} parse failed: ${url}` };
  }
}

/** Parse and validate a registry URL uses HTTPS and matches expected host. */
export function parseRegistryUrl(
  url: string,
  baseUrl: string,
): Result<URL, string> {
  const parsed = tryParseUrl(url, "Registry URL");
  if (!parsed.ok) return parsed;
  if (parsed.value.protocol !== "https:") {
    return { ok: false, error: `Registry URL must use HTTPS: ${url}` };
  }
  const base = tryParseUrl(baseUrl, "Registry base URL");
  if (!base.ok) return base;
  if (parsed.value.hostname !== base.value.hostname) {
    return { ok: false, error: `Registry URL hostname mismatch: expected ${base.value.hostname}, got ${parsed.value.hostname}` };
  }
  return parsed;
}

/** @deprecated Use {@link parseRegistryUrl} instead. */
export const validateRegistryUrl = parseRegistryUrl;

/** Compare semver versions. Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const strip = (v: string) => v.replace(/-.*$/, "");
  const pa = strip(a).split(".").map(Number);
  const pb = strip(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

async function fetchRemoteCatalog(
  catalogUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<ReefPluginCatalog, string>> {
  const response = await fetchFn(catalogUrl);
  if (!response.ok) {
    return {
      ok: false,
      error: `Plugin catalog fetch returned ${response.status}`,
    };
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.entries)) {
    return { ok: false, error: "Plugin catalog missing entries array" };
  }
  return { ok: true, value: body as ReefPluginCatalog };
}

function serveStaleCacheOrError(
  cache: MutableCatalogCache,
  err: unknown,
  logMessage: string,
): Result<ReefPluginCatalog, string> {
  if (cache.catalog) {
    log.warn(logMessage, { operation: "fetchCatalog", err });
    return { ok: true, value: cache.catalog };
  }
  return {
    ok: false,
    error: `Plugin catalog fetch failed: ${
      err instanceof Error ? err.message : String(err)
    }`,
  };
}

function applyCatalogUpdate(
  cache: MutableCatalogCache,
  result: Result<ReefPluginCatalog, string>,
): Result<ReefPluginCatalog, string> {
  if (!result.ok) return serveStaleCacheOrError(cache, result.error, "Plugin catalog fetch failed, serving stale cache");
  cache.catalog = result.value;
  cache.fetchedAt = Date.now();
  return result;
}

/** Fetch the plugin catalog from the network or cache. */
export async function fetchCatalog(
  baseUrl: string,
  cache: MutableCatalogCache,
  cacheTtlMs: number,
  fetchFn: typeof fetch,
): Promise<Result<ReefPluginCatalog, string>> {
  if (cache.catalog && (Date.now() - cache.fetchedAt) < cacheTtlMs) {
    return { ok: true, value: cache.catalog };
  }
  const url = `${baseUrl}/plugins/index/catalog.json`;
  const urlCheck = parseRegistryUrl(url, baseUrl);
  if (!urlCheck.ok) return urlCheck;

  try {
    return applyCatalogUpdate(cache, await fetchRemoteCatalog(url, fetchFn));
  } catch (err) {
    return serveStaleCacheOrError(cache, err, "Plugin catalog fetch exception, serving stale cache");
  }
}

/** Find the latest version of a plugin in the catalog. */
export function findLatestEntry(
  catalog: ReefPluginCatalog,
  name: string,
): ReefPluginCatalogEntry | null {
  const matches = catalog.entries.filter(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) return null;
  return matches.reduce((latest, entry) =>
    compareSemver(entry.version, latest.version) > 0 ? entry : latest
  );
}
