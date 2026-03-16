/**
 * Classification-aware path resolution for agent workspaces.
 *
 * Handles extracting classification prefixes from paths, determining
 * readable levels for a session taint, and resolving paths with
 * proper classification enforcement (no write-down, no read-up).
 *
 * @module
 */

import { join, resolve } from "@std/path";
import type {
  ClassificationLevel,
  Result,
} from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import { CLASSIFICATION_DIRS } from "../core/security/constants.ts";
import { isWithinJail } from "../core/security/path_jail.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { ClassifiedPathResult } from "./workspace_types.ts";

const log = createLogger("security");

/** Reverse lookup: directory name → classification level */
const DIR_TO_LEVEL: ReadonlyMap<string, ClassificationLevel> = new Map(
  Object.entries(CLASSIFICATION_DIRS).map(([level, dir]) => [
    dir,
    level as ClassificationLevel,
  ]),
);

/**
 * Extract the first path segment and check if it's a classification directory.
 * Returns the classification level and remaining path if matched.
 */
export function extractClassificationPrefix(
  relativePath: string,
): { level: ClassificationLevel; rest: string } | null {
  const normalized = relativePath.replace(/\\/g, "/");
  const firstSlash = normalized.indexOf("/");
  const firstSegment = firstSlash === -1
    ? normalized
    : normalized.slice(0, firstSlash);
  const rest = firstSlash === -1 ? "" : normalized.slice(firstSlash + 1);

  const level = DIR_TO_LEVEL.get(firstSegment);
  if (level) {
    return { level, rest };
  }
  return null;
}

/**
 * Get readable classification levels for a given session taint, ordered highest first.
 * A session can read at its own level and all levels below.
 */
export function resolveReadableLevels(
  sessionTaint: ClassificationLevel,
): readonly (Exclude<ClassificationLevel, "PUBLIC">)[] {
  const allLevels: readonly (Exclude<ClassificationLevel, "PUBLIC">)[] = [
    "RESTRICTED",
    "CONFIDENTIAL",
    "INTERNAL",
  ];
  const readableLevels = allLevels.filter((level) =>
    canFlowTo(level, sessionTaint)
  );
  log.debug("Computed readable classification levels", {
    sessionTaint,
    readableLevels,
  });
  return readableLevels;
}

/** Check if a relative path contains traversal (..) or absolute (/) components. */
export function containsPathTraversal(relativePath: string): boolean {
  if (relativePath.startsWith("/")) return true;
  const segments = relativePath.replace(/\\/g, "/").split("/");
  return segments.some((s) => s === "..");
}

/** Validate that a resolved absolute path stays within the workspace. */
export function enforcePathInWorkspace(
  absPath: string,
  workspacePath: string,
  relativePath: string,
): Result<true, string> {
  if (!isWithinJail(absPath, workspacePath)) {
    log.warn("Workspace path escape detected", {
      absPath,
      workspacePath,
      relativePath,
    });
    return {
      ok: false,
      error: `Path "${relativePath}" escapes the workspace directory`,
    };
  }
  return { ok: true, value: true };
}

/** @deprecated Use resolveReadableLevels instead */
export const getReadableLevels = resolveReadableLevels;

/** @deprecated Use enforcePathInWorkspace instead */
export const validatePathInWorkspace = enforcePathInWorkspace;

/** Options for resolving an explicit classification-prefixed path. */
interface ExplicitPathResolutionOptions {
  readonly prefix: { level: ClassificationLevel; rest: string };
  readonly relativePath: string;
  readonly sessionTaint: ClassificationLevel;
  readonly operation: "read" | "write";
  readonly levelToDirPath: Record<string, string>;
  readonly workspacePath: string;
}

/** Resolve a path with an explicit classification prefix (e.g., "internal/foo.txt"). */
export function resolveExplicitClassifiedPath(
  options: ExplicitPathResolutionOptions,
): Result<ClassifiedPathResult, string> {
  const { prefix, relativePath, sessionTaint, operation } = options;
  const { levelToDirPath, workspacePath } = options;
  const { level, rest } = prefix;
  const absPath = resolve(join(levelToDirPath[level], rest));
  const traversalCheck = enforcePathInWorkspace(
    absPath,
    workspacePath,
    relativePath,
  );
  if (!traversalCheck.ok) return traversalCheck;

  if (operation === "read" && !canFlowTo(level, sessionTaint)) {
    log.warn("Workspace read blocked: insufficient taint level", {
      path: relativePath,
      pathClassification: level,
      sessionTaint,
    });
    return {
      ok: false,
      error:
        `Cannot read ${level} path from ${sessionTaint} session (insufficient taint level)`,
    };
  }
  if (operation === "write" && !canFlowTo(sessionTaint, level)) {
    log.warn("Workspace write-down blocked", {
      path: relativePath,
      sessionTaint,
      targetClassification: level,
    });
    return {
      ok: false,
      error:
        `Write-down: ${sessionTaint} session cannot write to ${level} directory`,
    };
  }
  log.debug("Workspace classified path resolved", {
    path: relativePath,
    level,
    sessionTaint,
    operation,
  });
  return { ok: true, value: { absolutePath: absPath, classification: level } };
}

/** Options for searching readable levels for a file. */
interface ReadableLevelSearchOptions {
  readonly relativePath: string;
  readonly sessionTaint: Exclude<ClassificationLevel, "PUBLIC">;
  readonly levelToDirPath: Record<string, string>;
  readonly workspacePath: string;
}

/** Search readable classification levels (highest first) for an existing file. */
export function searchReadableLevelsForFile(
  options: ReadableLevelSearchOptions,
): Result<ClassifiedPathResult, string> {
  const { relativePath, sessionTaint, levelToDirPath, workspacePath } = options;
  const readableLevels = resolveReadableLevels(sessionTaint);
  for (const level of readableLevels) {
    const absPath = resolve(join(levelToDirPath[level], relativePath));
    if (!isWithinJail(absPath, workspacePath)) continue;
    try {
      Deno.statSync(absPath);
      return {
        ok: true,
        value: { absolutePath: absPath, classification: level },
      };
    } catch (err) {
      log.debug("Classified path stat failed, trying next level", {
        level,
        absPath,
        err,
      });
    }
  }
  const fallbackPath = resolve(
    join(levelToDirPath[sessionTaint], relativePath),
  );
  const check = enforcePathInWorkspace(
    fallbackPath,
    workspacePath,
    relativePath,
  );
  if (!check.ok) return check;
  return {
    ok: true,
    value: { absolutePath: fallbackPath, classification: sessionTaint },
  };
}
