/**
 * Reef catalog fetching, caching, and search.
 *
 * Handles network requests to the Reef static site, validates URLs,
 * manages an in-memory cache with TTL, and provides client-side
 * filtering for skill search.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import { parseClassification } from "../../core/types/classification.ts";
import type { ReefSkillListing } from "../../core/types/skills.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { ReefCatalog, ReefCatalogEntry } from "./registry_types.ts";
import type { CatalogCache } from "./registry_types.ts";
import { compareSemver } from "./registry_types.ts";

const log = createLogger("reef-registry");

// ─── URL validation ──────────────────────────────────────────────────────────

/**
 * Validate that a registry URL uses HTTPS and matches the expected host.
 *
 * SSRF note: The baseUrl is hardcoded to DEFAULT_BASE_URL by default and only
 * overridable via ReefRegistryOptions (code-level, not user input). The fetchFn
 * is also injected at construction time. This validation adds defense-in-depth
 * to ensure that even if baseUrl is misconfigured, only HTTPS requests to known
 * hosts are permitted.
 */
export function enforceRegistryUrl(
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
    return {
      ok: false,
      error: `Registry URL must use HTTPS, got ${parsed.protocol} for ${url}`,
    };
  }
  let expectedHost: string;
  try {
    expectedHost = new URL(baseUrl).hostname;
  } catch {
    return {
      ok: false,
      error: `Registry base URL parse failed: ${baseUrl}`,
    };
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

// ─── Cache helpers ───────────────────────────────────────────────────────────

/** Check whether the catalog cache is still valid. */
function isCacheValid(cache: CatalogCache, cacheTtlMs: number): boolean {
  return cache.catalog !== null && (Date.now() - cache.fetchedAt) < cacheTtlMs;
}

/** Fetch catalog JSON from the network. */
async function fetchCatalogFromNetwork(
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<ReefCatalog, string>> {
  const catalogUrl = `${baseUrl}/index/catalog.json`;
  const urlCheck = enforceRegistryUrl(catalogUrl, baseUrl);
  if (!urlCheck.ok) return urlCheck;

  const response = await fetchFn(catalogUrl);
  if (!response.ok) {
    return {
      ok: false,
      error: `Catalog fetch returned status ${response.status}`,
    };
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.entries)) {
    return {
      ok: false,
      error: "Catalog response missing entries array",
    };
  }
  return { ok: true, value: body as ReefCatalog };
}

/** Return stale cached catalog or an error if no cache exists. */
function serveStaleCacheOrError(
  cache: CatalogCache,
  errorMessage: string,
  originalError?: unknown,
): Result<ReefCatalog, string> {
  if (cache.catalog) {
    log.warn("Catalog fetch failed, serving stale cache", {
      operation: "fetchCatalog",
      err: originalError ?? errorMessage,
    });
    return { ok: true, value: cache.catalog };
  }
  log.warn("Catalog fetch failed with no stale cache available", {
    operation: "fetchCatalog",
    err: originalError ?? errorMessage,
  });
  return { ok: false, error: errorMessage };
}

/** Fetch the catalog, using cache when valid and falling back to stale cache on error. */
export async function fetchCatalog(options: {
  readonly baseUrl: string;
  readonly cache: CatalogCache;
  readonly cacheTtlMs: number;
  readonly fetchFn: typeof fetch;
}): Promise<Result<ReefCatalog, string>> {
  if (isCacheValid(options.cache, options.cacheTtlMs)) {
    return { ok: true, value: options.cache.catalog! };
  }
  try {
    const result = await fetchCatalogFromNetwork(
      options.baseUrl,
      options.fetchFn,
    );
    if (result.ok) {
      options.cache.catalog = result.value;
      options.cache.fetchedAt = Date.now();
      return result;
    }
    return serveStaleCacheOrError(options.cache, result.error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return serveStaleCacheOrError(
      options.cache,
      `Catalog fetch failed: ${message}`,
      err,
    );
  }
}

// ─── Search helpers ──────────────────────────────────────────────────────────

/** Check whether a catalog entry matches a search query. */
function matchesCatalogQuery(
  entry: ReefCatalogEntry,
  query: string,
): boolean {
  const lower = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(lower) ||
    entry.tags.some((t) => t.toLowerCase().includes(lower)) ||
    entry.category.toLowerCase().includes(lower) ||
    entry.description.toLowerCase().includes(lower)
  );
}

/** Convert a catalog entry to a public skill listing. */
function catalogEntryToListing(entry: ReefCatalogEntry): ReefSkillListing {
  const classResult = parseClassification(entry.classificationCeiling);
  const ceiling: ClassificationLevel = classResult.ok
    ? classResult.value
    : "PUBLIC";
  return {
    name: entry.name,
    description: entry.description,
    version: entry.version,
    author: entry.author,
    tags: entry.tags,
    category: entry.category,
    downloads: 0,
    classificationCeiling: ceiling,
    checksum: entry.checksum,
    publishedAt: entry.publishedAt,
  };
}

// ─── Catalog lookup ──────────────────────────────────────────────────────────

/** Find the latest version of a skill in the catalog by name. */
export function findLatestSkillEntry(
  catalog: ReefCatalog,
  name: string,
): ReefCatalogEntry | null {
  const matches = catalog.entries.filter(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 0) return null;
  return matches.reduce((latest, entry) =>
    compareSemver(entry.version, latest.version) > 0 ? entry : latest
  );
}

/** Execute a catalog search with client-side filtering. */
export async function searchSkillCatalog(options: {
  readonly searchOptions: { readonly query: string; readonly limit?: number };
  readonly baseUrl: string;
  readonly cache: CatalogCache;
  readonly cacheTtlMs: number;
  readonly fetchFn: typeof fetch;
}): Promise<Result<readonly ReefSkillListing[], string>> {
  const catalogResult = await fetchCatalog(options);
  if (!catalogResult.ok) return catalogResult;

  const limit = options.searchOptions.limit ?? 20;
  const results = catalogResult.value.entries
    .filter((e) => matchesCatalogQuery(e, options.searchOptions.query))
    .slice(0, limit)
    .map(catalogEntryToListing);
  return { ok: true, value: results };
}

/** Check installed skills against the catalog for available updates. */
export async function detectSkillUpdates(options: {
  readonly installedSkills: readonly {
    readonly name: string;
    readonly version?: string;
  }[];
  readonly baseUrl: string;
  readonly cache: CatalogCache;
  readonly cacheTtlMs: number;
  readonly fetchFn: typeof fetch;
}): Promise<Result<readonly string[], string>> {
  const catalogResult = await fetchCatalog(options);
  if (!catalogResult.ok) return catalogResult;

  const updatable: string[] = [];
  for (const installed of options.installedSkills) {
    const entry = findLatestSkillEntry(catalogResult.value, installed.name);
    if (!entry) continue;
    const installedVersion = installed.version ?? "0.0.0";
    if (compareSemver(entry.version, installedVersion) > 0) {
      updatable.push(installed.name);
    }
  }

  return { ok: true, value: updatable };
}

/** @deprecated Use enforceRegistryUrl instead */
export const validateRegistryUrl = enforceRegistryUrl;
/** @deprecated Use searchSkillCatalog instead */
export const executeSearch = searchSkillCatalog;
/** @deprecated Use detectSkillUpdates instead */
export const executeCheckUpdates = detectSkillUpdates;
