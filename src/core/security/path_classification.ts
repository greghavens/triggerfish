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

import { resolve } from "@std/path";

// Re-export shared types and utilities from path_classification_rules.ts
// for backward compatibility — all external consumers import from this file.
export {
  classifyWorkspacePath,
  expandTilde,
  isHardcodedProtectedPath,
  matchConfiguredPath,
  pathPatternMatches,
  remapSandboxPath,
  resolveHome,
  resolvePathClassification,
} from "./path_classification_rules.ts";
export type {
  FilesystemSecurityConfig,
  PathClassificationResult,
  PathClassifierOptions,
  WorkspacePaths,
} from "./path_classification_rules.ts";

import {
  expandTilde,
  remapSandboxPath,
  resolveHome,
  resolvePathClassification,
} from "./path_classification_rules.ts";
import type {
  FilesystemSecurityConfig,
  PathClassificationResult,
  PathClassifierOptions,
  WorkspacePaths,
} from "./path_classification_rules.ts";

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
