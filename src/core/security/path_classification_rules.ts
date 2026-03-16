/**
 * Path classification rule evaluation functions.
 *
 * Pure functions that implement the classification resolution chain:
 * pattern matching, hardcoded path checks, workspace classification,
 * configured path matching, and sandbox remapping.
 *
 * @module
 */

import { basename, join, resolve } from "@std/path";
import type { ClassificationLevel } from "../types/classification.ts";
import { PROTECTED_BASENAMES, PROTECTED_DIR_PATTERNS } from "./constants.ts";
import { createLogger } from "../logger/mod.ts";

const log = createLogger("path-classification");

// ─── Shared Types ─────────────────────────────────────────────────────────────

/** Result of classifying a filesystem path. */
export interface PathClassificationResult {
  readonly classification: ClassificationLevel;
  readonly source: "hardcoded" | "workspace" | "configured" | "default";
  readonly matchedPattern?: string;
}

/** Configuration for filesystem security. */
export interface FilesystemSecurityConfig {
  readonly paths: ReadonlyMap<string, ClassificationLevel>;
  readonly defaultClassification: ClassificationLevel;
}

/** Workspace paths for classification directory detection. */
export interface WorkspacePaths {
  readonly basePath: string;
  readonly publicPath: string;
  readonly internalPath: string;
  readonly confidentialPath: string;
  readonly restrictedPath: string;
}

/** Options for path classifier creation. */
export interface PathClassifierOptions {
  /**
   * Resolve the current working directory for relative path resolution.
   * When provided, relative paths like "." or "subdir" resolve against
   * this directory instead of the daemon's CWD. Should return the
   * taint-appropriate workspace subdirectory.
   */
  readonly resolveCwd?: () => string;
}

// ─── Utility functions ───────────────────────────────────────────────────────

/**
 * Resolve the user's home directory.
 * Prefers HOME (Linux/macOS), falls back to USERPROFILE (Windows).
 */
export function resolveHome(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (!home) return home;
  try {
    return Deno.realPathSync(home);
  } catch (err: unknown) {
    log.debug("Home directory symlink resolution failed, using raw path", {
      operation: "resolveHome",
      home,
      err,
    });
    return home;
  }
}

/**
 * Expand a leading `~` in a path to the resolved home directory.
 */
export function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = resolveHome();
    return join(home, path.slice(2));
  }
  return path;
}

/**
 * Check if a path matches a configured pattern.
 *
 * Patterns ending with `/*` or `/**` are treated as directory prefixes.
 * Other patterns are matched exactly after tilde expansion and resolution.
 */
export function pathPatternMatches(
  pattern: string,
  absolutePath: string,
): boolean {
  const expanded = resolve(expandTilde(pattern));

  // Directory prefix pattern: ~/Documents/finance/* matches anything under that dir
  if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
    // Strip the trailing /* or /** to get the directory prefix
    const dirPrefix = expanded.replace(/\/\*{1,2}$/, "");
    return absolutePath.startsWith(dirPrefix + "/") ||
      absolutePath === dirPrefix;
  }

  // Exact match
  return absolutePath === expanded;
}

/**
 * Check if a path is a hardcoded protected path (always RESTRICTED).
 */
export function isHardcodedProtectedPath(
  absolutePath: string,
  homeDir: string,
): boolean {
  // Check basename matches (triggerfish.yaml, SPINE.md, TRIGGER.md)
  const name = basename(absolutePath);
  if (PROTECTED_BASENAMES.includes(name)) {
    return true;
  }

  // Check directory prefix matches (.triggerfish/config, .triggerfish/data, .triggerfish/logs)
  for (const pattern of PROTECTED_DIR_PATTERNS) {
    const protectedDir = resolve(join(homeDir, pattern));
    if (
      absolutePath.startsWith(protectedDir + "/") ||
      absolutePath === protectedDir
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a path falls within a workspace classification directory.
 */
export function classifyWorkspacePath(
  absolutePath: string,
  workspacePaths?: WorkspacePaths,
): PathClassificationResult | null {
  if (!workspacePaths) return null;

  // Check each classification directory (most restrictive first)
  const checks: readonly {
    readonly path: string;
    readonly level: ClassificationLevel;
  }[] = [
    { path: workspacePaths.restrictedPath, level: "RESTRICTED" },
    { path: workspacePaths.confidentialPath, level: "CONFIDENTIAL" },
    { path: workspacePaths.internalPath, level: "INTERNAL" },
    { path: workspacePaths.publicPath, level: "PUBLIC" },
  ];

  for (const check of checks) {
    if (
      absolutePath.startsWith(check.path + "/") ||
      absolutePath === check.path
    ) {
      return {
        classification: check.level,
        source: "workspace",
      };
    }
  }

  // Workspace basePath contains ALL classification directories (public/,
  // internal/, confidential/, restricted/). Listing it reveals their names
  // and structure. Ancestors are even broader. Classify as RESTRICTED to
  // prevent a PUBLIC session from discovering classified directory layout
  // via `ls ..` or similar commands.
  if (
    absolutePath === workspacePaths.basePath ||
    workspacePaths.basePath.startsWith(absolutePath + "/")
  ) {
    return { classification: "RESTRICTED", source: "workspace" };
  }

  return null;
}

/** Match a path against configured path mappings, returning the first match. */
export function matchConfiguredPath(
  absolutePath: string,
  paths: ReadonlyMap<string, ClassificationLevel>,
): PathClassificationResult | null {
  for (const [pattern, level] of paths) {
    if (pathPatternMatches(pattern, absolutePath)) {
      return {
        classification: level,
        source: "configured",
        matchedPattern: pattern,
      };
    }
  }
  return null;
}

/** Run the full classification resolution chain for a single absolute path. */
export function resolvePathClassification(
  absolutePath: string,
  homeDir: string,
  config: FilesystemSecurityConfig,
  workspacePaths?: WorkspacePaths,
): PathClassificationResult {
  if (isHardcodedProtectedPath(absolutePath, homeDir)) {
    return { classification: "RESTRICTED", source: "hardcoded" };
  }
  const workspaceResult = classifyWorkspacePath(absolutePath, workspacePaths);
  if (workspaceResult) return workspaceResult;
  const configuredResult = matchConfiguredPath(absolutePath, config.paths);
  if (configuredResult) return configuredResult;
  return { classification: config.defaultClassification, source: "default" };
}

/**
 * Remap an absolute sandbox path to a real workspace path.
 *
 * The filesystem sandbox presents the workspace as `/`. Absolute paths
 * like `/` or `/public` from the sandbox must be mapped to the real
 * workspace basePath before classification, otherwise `resolve(cwd, "/")`
 * returns the filesystem root and falls through to the default level.
 *
 * Returns null if no remapping applies (no workspace or non-absolute path).
 */
export function remapSandboxPath(
  expanded: string,
  workspacePaths?: WorkspacePaths,
): string | null {
  if (!workspacePaths || !expanded.startsWith("/")) return null;
  // Check if the path already falls within the real workspace
  if (
    expanded === workspacePaths.basePath ||
    expanded.startsWith(workspacePaths.basePath + "/")
  ) return null;
  // "/" → basePath, "/foo" → basePath/foo
  if (expanded === "/") return workspacePaths.basePath;
  return join(workspacePaths.basePath, expanded);
}
