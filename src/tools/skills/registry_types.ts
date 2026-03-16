/**
 * Reef registry types, constants, and input validation.
 *
 * Shared across catalog, install, and publish modules.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";

// Re-export shared types from core so existing importers continue to work.
export type {
  ReefRegistry,
  ReefSearchOptions,
  ReefSkillListing,
} from "../../core/types/skills.ts";

/** Default base URL for The Reef static site (GitHub Pages). */
export const DEFAULT_BASE_URL = "https://greghavens.github.io/reef-registry";

/** Default catalog cache TTL in milliseconds (1 hour). */
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

/** Options for creating a Reef registry client. */
export interface ReefRegistryOptions {
  /** Base URL for The Reef static site. */
  readonly baseUrl?: string;
  /** Catalog cache TTL in milliseconds (default: 1 hour). */
  readonly cacheTtlMs?: number;
  /** Override fetch for testing. Defaults to globalThis.fetch. */
  readonly fetchFn?: typeof fetch;
}

/** Entry in the Reef catalog index (/index/catalog.json). */
export interface ReefCatalogEntry {
  /** Skill name. */
  readonly name: string;
  /** Skill version (semver). */
  readonly version: string;
  /** Skill description. */
  readonly description: string;
  /** Author identifier. */
  readonly author: string;
  /** Tags for categorization. */
  readonly tags: readonly string[];
  /** Category. */
  readonly category: string;
  /** Classification ceiling as string. */
  readonly classificationCeiling: string;
  /** SHA-256 hex digest of SKILL.md content. */
  readonly checksum: string;
  /** ISO 8601 publish timestamp. */
  readonly publishedAt: string;
}

/** Full catalog structure served at /index/catalog.json. */
export interface ReefCatalog {
  /** All skill entries in the catalog. */
  readonly entries: readonly ReefCatalogEntry[];
  /** ISO 8601 timestamp when the catalog was generated. */
  readonly generatedAt: string;
}

/** Metadata file served at /skills/{name}/{version}/metadata.json. */
export interface ReefSkillMetadata {
  /** Skill name. */
  readonly name: string;
  /** Skill version (semver). */
  readonly version: string;
  /** Skill description. */
  readonly description: string;
  /** Author identifier. */
  readonly author: string;
  /** Tags for categorization. */
  readonly tags: readonly string[];
  /** Category. */
  readonly category: string;
  /** Classification ceiling as string. */
  readonly classificationCeiling: string;
  /** SHA-256 hex digest of SKILL.md content. */
  readonly checksum: string;
  /** ISO 8601 publish timestamp. */
  readonly publishedAt: string;
  /** Tools required by this skill (null = unrestricted). */
  readonly requiresTools: readonly string[] | null;
  /** Network domains this skill needs (null = unrestricted). */
  readonly networkDomains: readonly string[] | null;
}

/**
 * In-memory catalog cache with TTL tracking.
 *
 * Mutable: intentionally shared state for cache invalidation across
 * registry operations. The cache object is passed by reference as a
 * deliberate shared-state optimization so that search, install, and
 * checkUpdates calls within the same registry instance share one
 * cached catalog without redundant network fetches.
 */
export interface CatalogCache {
  catalog: ReefCatalog | null;
  fetchedAt: number;
}

// ─── Input validation ─────────────────────────────────────────────────────────

/** Pattern for valid skill names: lowercase alphanumeric, may contain hyphens, must start with alphanum. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Pattern for valid semver versions: major.minor.patch with optional pre-release suffix. */
const SEMVER_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

/**
 * Validate a skill name is safe for use in filesystem paths and URLs.
 *
 * Rejects names containing path traversal sequences, slashes, dots,
 * or other characters that could escape the intended directory.
 */
export function enforceSkillName(name: string): Result<string, string> {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        `Skill name contains invalid characters: "${name}" (must match ${SKILL_NAME_PATTERN})`,
    };
  }
  return { ok: true, value: name };
}

/**
 * Validate a version string is safe for use in filesystem paths and URLs.
 *
 * Rejects versions containing path traversal sequences or characters
 * outside of the semver specification.
 */
export function enforceSkillVersion(version: string): Result<string, string> {
  if (!SEMVER_VERSION_PATTERN.test(version)) {
    return {
      ok: false,
      error:
        `Skill version contains invalid characters: "${version}" (must match ${SEMVER_VERSION_PATTERN})`,
    };
  }
  return { ok: true, value: version };
}

// ─── Semver comparison ───────────────────────────────────────────────────────

/**
 * Compare two semver version strings.
 *
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const stripPre = (v: string) => v.replace(/-.*$/, "");
  const partsA = stripPre(a).split(".").map(Number);
  const partsB = stripPre(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** @deprecated Use enforceSkillName instead */
export const validateSkillName = enforceSkillName;
/** @deprecated Use enforceSkillVersion instead */
export const validateSkillVersion = enforceSkillVersion;
