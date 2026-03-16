/**
 * The Reef registry client.
 *
 * Facade that re-exports types and creates the registry client.
 * Implementation split across registry_types, registry_catalog,
 * registry_install, and registry_publish.
 *
 * @module
 */

import type { ReefRegistry } from "../../core/types/skills.ts";
import type { CatalogCache, ReefRegistryOptions } from "./registry_types.ts";
import { DEFAULT_BASE_URL, DEFAULT_CACHE_TTL_MS } from "./registry_types.ts";
import { detectSkillUpdates, searchSkillCatalog } from "./registry_catalog.ts";
import { installSkillFromRegistry } from "./registry_install.ts";
import { publishSkillToRegistry } from "./registry_publish.ts";

// Re-export all public types and functions for backwards compatibility.
export { compareSemver } from "./registry_types.ts";
export type {
  ReefCatalog,
  ReefCatalogEntry,
  ReefRegistry,
  ReefRegistryOptions,
  ReefSearchOptions,
  ReefSkillListing,
  ReefSkillMetadata,
} from "./registry_types.ts";

/**
 * Create a Reef registry client.
 *
 * Connects to The Reef static site (GitHub Pages) for skill discovery
 * and management. Caches the catalog in memory with configurable TTL.
 * Falls back gracefully to stale cache when the registry is unavailable.
 */
export function createReefRegistry(
  registryOptions?: ReefRegistryOptions,
): ReefRegistry {
  const baseUrl = registryOptions?.baseUrl ?? DEFAULT_BASE_URL;
  const cacheTtlMs = registryOptions?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchFn = registryOptions?.fetchFn ?? globalThis.fetch;
  const cache: CatalogCache = { catalog: null, fetchedAt: 0 };

  return {
    search: (searchOptions) =>
      searchSkillCatalog({
        searchOptions,
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      }),
    install: (name, targetDir) =>
      installSkillFromRegistry({
        name,
        targetDir,
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      }),
    checkUpdates: (installedSkills) =>
      detectSkillUpdates({
        installedSkills,
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      }),
    publish: publishSkillToRegistry,
  };
}
