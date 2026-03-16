/**
 * Filesystem path classification resolver.
 *
 * Determines the classification level of a filesystem path using a fixed
 * resolution order (spec §3.4):
 *   1. Resolve to absolute path
 *   2. Check hardcoded protected paths → RESTRICTED
 *   3. Check workspace classification directories
 *   4. Check configured path mappings (first match wins)
 *   5. Apply default classification
 *
 * @module
 */

import { join, resolve } from "@std/path";
import type { ClassificationLevel } from "../types/classification.ts";
import { createLogger } from "../logger/mod.ts";

export {
  classifyWorkspacePath,
  isHardcodedProtectedPath,
  matchConfiguredPath,
  pathPatternMatches,
  remapSandboxPath,
  resolvePathClassification,
} from "./path_classification_rules.ts";

import {
  remapSandboxPath,
  resolvePathClassification,
} from "./path_classification_rules.ts";

const log = createLogger("path-classification");

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of classifying a filesystem path. */
export interface PathClassificationResult {
  readonly classification: ClassificationLevel;
  readonly source: "hardcoded" | "workspace" | "configured" | "default";
  readonly matchedPattern?: string;
}

/** Classifier that resolves a filesystem path to a classification level. */
export interface PathClassifier {
  /** Classify an absolute or relative path (sandbox-aware when resolveCwd is set). */
  classify(absolutePath: string): PathClassificationResult;
  /**
   * Classify a REAL filesystem path — NO sandbox remapping.
   *
   * CRITICAL: run_command operates on the real filesystem, not inside the
   * sandbox. Paths extracted from shell commands (e.g. "/" from "ls -al /")
   * are real paths. Using classify() would remap "/" to the workspace
   * basePath via remapSandboxPath, misclassifying the real root as PUBLIC
   * and bypassing taint escalation entirely.
   *
   * DO NOT REMOVE THIS METHOD. DO NOT ROUTE run_command PATHS THROUGH
   * classify(). This is the ONLY correct way to classify shell command paths.
   */
  classifyRealPath(absolutePath: string): PathClassificationResult;
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

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a path classifier.
 *
 * @param config - Filesystem security configuration (path mappings + default)
 * @param workspacePaths - Optional workspace paths for classification directory detection
 * @param opts - Optional classifier behavior overrides
 * @returns A PathClassifier instance
 */
export function createPathClassifier(
  config: FilesystemSecurityConfig,
  workspacePaths?: WorkspacePaths,
  opts?: PathClassifierOptions,
): PathClassifier {
  const homeDir = resolveHome();

  return {
    classify(inputPath: string): PathClassificationResult {
      const expanded = expandTilde(inputPath);
      const absolutePath = opts?.resolveCwd
        ? remapSandboxPath(expanded, workspacePaths) ??
          resolve(opts.resolveCwd(), expanded)
        : resolve(expanded);
      return resolvePathClassification(
        absolutePath,
        homeDir,
        config,
        workspacePaths,
      );
    },

    /**
     * Classify a REAL filesystem path — bypasses sandbox remapping.
     *
     * CRITICAL — DO NOT REMOVE OR MERGE WITH classify().
     * run_command executes on the real filesystem. "/" means the real root,
     * not the sandbox workspace root. Without this method, remapSandboxPath
     * converts "/" → workspacePaths.basePath → PUBLIC, which lets
     * "ls -al /" succeed in a PUBLIC session without taint escalation.
     * This has regressed multiple times. The separate method exists so it
     * CANNOT regress from changes to sandbox remapping logic.
     */
    classifyRealPath(inputPath: string): PathClassificationResult {
      const expanded = expandTilde(inputPath);
      const absolutePath = resolve(expanded);
      return resolvePathClassification(
        absolutePath,
        homeDir,
        config,
        workspacePaths,
      );
    },
  };
}
