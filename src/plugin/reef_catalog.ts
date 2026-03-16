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

/** Parse and validate a registry URL uses HTTPS and matches expected host. */
export function parseRegistryUrl(
  url: string,
  baseUrl: string,
): Result<URL, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Registry URL parse failed: ${url}` };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: `Registry URL must use HTTPS: ${url}` };
  }
  let expectedHost: string;
  try {
    expectedHost = new URL(baseUrl).hostname;
  } catch {
    return { ok: false, error: `Registry base URL parse failed: ${baseUrl}` };
  }
  if (parsed.hostname !== expectedHost) {
    return {
      ok: false,
      error:
        `Registry URL hostname mismatch: expected ${expectedHost}, got ${parsed.hostname}`,
    };
  }
  return { ok: true, value: parsed };
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
    const response = await fetchFn(url);
    if (!response.ok) {
      if (cache.catalog) {
        log.warn("Plugin catalog fetch failed, serving stale cache", {
          operation: "fetchCatalog",
          status: response.status,
        });
        return { ok: true, value: cache.catalog };
      }
      return {
        ok: false,
        error: `Plugin catalog fetch returned ${response.status}`,
      };
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.entries)) {
      return { ok: false, error: "Plugin catalog missing entries array" };
    }
    cache.catalog = body as ReefPluginCatalog;
    cache.fetchedAt = Date.now();
    return { ok: true, value: cache.catalog };
  } catch (err) {
    if (cache.catalog) {
      log.warn("Plugin catalog fetch exception, serving stale cache", {
        operation: "fetchCatalog",
        err,
      });
      return { ok: true, value: cache.catalog };
    }
    return {
      ok: false,
      error: `Plugin catalog fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
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
