/**
 * Vault security — path confinement, classification mapping, vault discovery.
 *
 * Every file operation in the Obsidian module MUST go through these functions
 * to prevent path traversal, symlink escapes, and classification violations.
 *
 * @module
 */

import { join, SEPARATOR } from "@std/path";
import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import type { ObsidianVaultConfig } from "./types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("security");

/** Resolved vault context used by all note operations. */
export interface VaultContext {
  /** Original configuration. */
  readonly config: ObsidianVaultConfig;
  /** Resolved absolute path to vault root (symlinks resolved). */
  readonly realVaultPath: string;
  /** Folders always excluded from operations. */
  readonly excludeFolders: readonly string[];
  /** Per-folder classification overrides, sorted most-specific-first. */
  readonly folderClassifications: readonly [string, ClassificationLevel][];
}

/** Folders always excluded regardless of configuration. */
const ALWAYS_EXCLUDED = [".obsidian", ".trash"];

/**
 * Create a VaultContext from configuration.
 *
 * Resolves the vault path to an absolute real path, verifies the `.obsidian/`
 * marker directory exists (proving this is actually an Obsidian vault).
 */
export async function createVaultContext(
  config: ObsidianVaultConfig,
): Promise<Result<VaultContext, string>> {
  let realVaultPath: string;
  try {
    realVaultPath = await Deno.realPath(config.vaultPath);
  } catch {
    return {
      ok: false,
      error: `Vault path does not exist: ${config.vaultPath}`,
    };
  }

  // Verify .obsidian marker exists
  try {
    const stat = await Deno.stat(join(realVaultPath, ".obsidian"));
    if (!stat.isDirectory) {
      return {
        ok: false,
        error:
          `Not an Obsidian vault (no .obsidian/ directory): ${realVaultPath}`,
      };
    }
  } catch {
    return {
      ok: false,
      error:
        `Not an Obsidian vault (no .obsidian/ directory): ${realVaultPath}`,
    };
  }

  // Build exclude list
  const userExcludes = config.excludeFolders ?? [];
  const excludeFolders = [...new Set([...ALWAYS_EXCLUDED, ...userExcludes])];

  // Sort folder classifications by path depth (most specific first)
  const folderClassifications: [string, ClassificationLevel][] = [];
  if (config.folderClassifications) {
    for (
      const [folder, level] of Object.entries(config.folderClassifications)
    ) {
      folderClassifications.push([folder, level]);
    }
    folderClassifications.sort((a, b) =>
      b[0].split("/").length - a[0].split("/").length
    );
  }

  return {
    ok: true,
    value: {
      config,
      realVaultPath,
      excludeFolders,
      folderClassifications,
    },
  };
}

/**
 * Resolve a vault-relative path to an absolute path with confinement checks.
 *
 * Rejects paths containing `..` components. Resolves the final path via
 * `Deno.realPath()` and verifies it stays within the vault root.
 */
export async function resolveVaultPath(
  ctx: VaultContext,
  relativePath: string,
): Promise<Result<string, string>> {
  // Reject obvious traversal attempts
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") || normalized.startsWith("..") ||
    normalized.includes("/../") || normalized.endsWith("/..")
  ) {
    log.warn("Path traversal rejected", { relativePath });
    return { ok: false, error: `Path traversal rejected: ${relativePath}` };
  }

  // Split and check each component
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "..") {
      log.warn("Path traversal rejected", { relativePath });
      return { ok: false, error: `Path traversal rejected: ${relativePath}` };
    }
  }

  const absolutePath = join(ctx.realVaultPath, ...normalized.split("/"));

  // For existing paths, verify the real path stays within vault
  try {
    const realPath = await Deno.realPath(absolutePath);
    if (
      !realPath.startsWith(ctx.realVaultPath + SEPARATOR) &&
      realPath !== ctx.realVaultPath
    ) {
      log.warn("Path escapes vault boundary", {
        relativePath,
        resolvedPath: realPath,
      });
      return {
        ok: false,
        error: `Path escapes vault boundary: ${relativePath}`,
      };
    }
    return { ok: true, value: realPath };
  } catch {
    // Path doesn't exist yet — check that parent exists and is within vault
    const parentParts = parts.slice(0, -1);
    if (parentParts.length > 0) {
      const parentPath = join(ctx.realVaultPath, ...parentParts);
      try {
        const realParent = await Deno.realPath(parentPath);
        if (
          !realParent.startsWith(ctx.realVaultPath + SEPARATOR) &&
          realParent !== ctx.realVaultPath
        ) {
          return {
            ok: false,
            error: `Path escapes vault boundary: ${relativePath}`,
          };
        }
      } catch {
        // Parent doesn't exist either — that's fine for creates that make dirs
      }
    }
    return { ok: true, value: absolutePath };
  }
}

/**
 * Check if a relative path falls within an excluded folder.
 */
export function isExcluded(ctx: VaultContext, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const excluded of ctx.excludeFolders) {
    if (normalized === excluded || normalized.startsWith(excluded + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Get the classification level for a vault-relative path.
 *
 * Matches against folderClassifications (most specific path wins),
 * then falls back to the vault default classification.
 */
export function resolveClassificationForPath(
  ctx: VaultContext,
  relativePath: string,
): ClassificationLevel {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const [folder, level] of ctx.folderClassifications) {
    if (normalized === folder || normalized.startsWith(folder + "/")) {
      return level;
    }
  }
  return ctx.config.classification;
}

/** @deprecated Use resolveClassificationForPath instead */
export const getClassificationForPath = resolveClassificationForPath;
