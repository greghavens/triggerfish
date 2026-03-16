/**
 * Plugin Reef registry client.
 *
 * Extends The Reef marketplace model to support plugins alongside skills.
 * Plugins are published as versioned bundles containing mod.ts and any
 * supporting files, with SHA-256 integrity verification and security
 * scanning on install.
 *
 * Uses the same catalog structure as the skill registry, served from
 * a `/plugins/` path on the Reef static site.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { MutableCatalogCache } from "./reef_catalog.ts";
import {
  compareSemver,
  fetchCatalog,
  findLatestEntry,
} from "./reef_catalog.ts";
import { installPlugin, publishPlugin } from "./reef_operations.ts";

/** Re-export catalog utilities. */
export {
  compareSemver,
  computeHash,
  fetchCatalog,
  findLatestEntry,
  parseRegistryUrl,
  validateRegistryUrl,
} from "./reef_catalog.ts";
export type {
  CatalogCache,
  MutableCatalogCache,
  ReefPluginCatalog,
  ReefPluginCatalogEntry,
} from "./reef_catalog.ts";

/** Re-export operations. */
export { installPlugin, publishPlugin } from "./reef_operations.ts";

/** Default base URL for The Reef static site. */
const DEFAULT_BASE_URL = "https://reef.trigger.fish";

/** Default catalog cache TTL in milliseconds (1 hour). */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** Plugin listing from the Reef catalog. */
export interface ReefPluginListing {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly classification: string;
  readonly trust: string;
  readonly tags: readonly string[];
  readonly checksum: string;
  readonly publishedAt: string;
}

/** Options for creating a plugin Reef registry. */
export interface PluginReefOptions {
  readonly baseUrl?: string;
  readonly cacheTtlMs?: number;
  readonly fetchFn?: typeof fetch;
}

/** Plugin Reef registry interface. */
export interface PluginReefRegistry {
  /** Search for plugins by query. */
  readonly search: (
    query: string,
  ) => Promise<Result<readonly ReefPluginListing[], string>>;
  /** Install a plugin from The Reef to the local plugins directory. */
  readonly install: (
    name: string,
    targetDir: string,
  ) => Promise<Result<string, string>>;
  /** Check installed plugins for available updates. */
  readonly checkUpdates: (
    installed: readonly { readonly name: string; readonly version?: string }[],
  ) => Promise<Result<readonly string[], string>>;
  /** Validate and prepare a plugin for Reef publishing. */
  readonly publish: (pluginDir: string) => Promise<Result<string, string>>;
}

/**
 * Create a plugin Reef registry client.
 *
 * Connects to The Reef static site for plugin discovery, installation,
 * update checking, and publishing. Mirrors the skill registry pattern.
 */
export function createPluginReefRegistry(
  options?: PluginReefOptions,
): PluginReefRegistry {
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  const cache: MutableCatalogCache = { catalog: null, fetchedAt: 0 };

  return {
    async search(
      query: string,
    ): Promise<Result<readonly ReefPluginListing[], string>> {
      const catalogResult = await fetchCatalog(
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      );
      if (!catalogResult.ok) return catalogResult;

      const lower = query.toLowerCase();
      const results = catalogResult.value.entries
        .filter((e) =>
          e.name.toLowerCase().includes(lower) ||
          e.description.toLowerCase().includes(lower) ||
          e.tags.some((t) => t.toLowerCase().includes(lower))
        )
        .slice(0, 20)
        .map((e): ReefPluginListing => ({
          name: e.name,
          version: e.version,
          description: e.description,
          author: e.author,
          classification: e.classification,
          trust: e.trust,
          tags: e.tags,
          checksum: e.checksum,
          publishedAt: e.publishedAt,
        }));
      return { ok: true, value: results };
    },

    async install(
      name: string,
      targetDir: string,
    ): Promise<Result<string, string>> {
      const catalogResult = await fetchCatalog(
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      );
      if (!catalogResult.ok) return catalogResult;

      const entry = findLatestEntry(catalogResult.value, name);
      if (!entry) {
        return { ok: false, error: `Plugin "${name}" not found in The Reef` };
      }
      return installPlugin(entry, targetDir, baseUrl, fetchFn);
    },

    async checkUpdates(
      installed: readonly {
        readonly name: string;
        readonly version?: string;
      }[],
    ): Promise<Result<readonly string[], string>> {
      const catalogResult = await fetchCatalog(
        baseUrl,
        cache,
        cacheTtlMs,
        fetchFn,
      );
      if (!catalogResult.ok) return catalogResult;

      const updatable: string[] = [];
      for (const plugin of installed) {
        const entry = findLatestEntry(catalogResult.value, plugin.name);
        if (!entry) continue;
        if (compareSemver(entry.version, plugin.version ?? "0.0.0") > 0) {
          updatable.push(plugin.name);
        }
      }
      return { ok: true, value: updatable };
    },

    publish: publishPlugin,
  };
}
