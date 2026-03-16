/**
 * Agent workspace creation and lifecycle.
 *
 * Each agent gets an isolated workspace directory with subdirectories
 * for scratch work, integrations, and skills. The workspace persists
 * across sessions (unlike the plugin sandbox which is ephemeral).
 *
 * Classification-partitioned directories (internal/, confidential/,
 * restricted/) enforce data isolation between sessions at different
 * taint levels.
 *
 * @module
 */

import { join, resolve } from "@std/path";
import { isWithinJail } from "../core/security/path_jail.ts";
import { sanitizePathForPrompt } from "../core/security/path_sanitization.ts";
import { createLogger } from "../core/logger/logger.ts";
import type {
  ClassificationLevel,
  Result,
} from "../core/types/classification.ts";
import {
  CLASSIFICATION_DIRS,
  WORKSPACE_SUBDIRS,
} from "../core/security/constants.ts";
import type {
  ClassifiedPathResult,
  Workspace,
  WorkspaceOptions,
} from "./workspace_types.ts";
import {
  containsPathTraversal,
  enforcePathInWorkspace,
  extractClassificationPrefix,
  resolveExplicitClassifiedPath,
  searchReadableLevelsForFile,
} from "./workspace_paths.ts";

const log = createLogger("security");

export type { ClassifiedPathResult, Workspace, WorkspaceOptions };

/** Create workspace root, legacy subdirectories, and classification-partitioned dirs. */
async function createWorkspaceDirectories(
  workspacePath: string,
  scratchPath: string,
  integrationsPath: string,
  skillsPath: string,
): Promise<void> {
  await Deno.mkdir(workspacePath, { recursive: true });
  await Deno.mkdir(scratchPath, { recursive: true });
  await Deno.mkdir(integrationsPath, { recursive: true });
  await Deno.mkdir(skillsPath, { recursive: true });
  // Create public/ with standard subdirs (not in CLASSIFICATION_DIRS which excludes PUBLIC)
  for (const subDir of WORKSPACE_SUBDIRS) {
    await Deno.mkdir(join(workspacePath, "public", subDir), {
      recursive: true,
    });
  }
  for (const classDir of Object.values(CLASSIFICATION_DIRS)) {
    for (const subDir of WORKSPACE_SUBDIRS) {
      await Deno.mkdir(join(workspacePath, classDir, subDir), {
        recursive: true,
      });
    }
  }
}

/** Compute all standard workspace paths from a resolved root. */
function computeWorkspacePaths(workspacePath: string): {
  readonly scratchPath: string;
  readonly integrationsPath: string;
  readonly skillsPath: string;
  readonly publicPath: string;
  readonly internalPath: string;
  readonly confidentialPath: string;
  readonly restrictedPath: string;
} {
  return {
    scratchPath: join(workspacePath, "scratch"),
    integrationsPath: join(workspacePath, "integrations"),
    skillsPath: join(workspacePath, "skills"),
    publicPath: join(workspacePath, "public"),
    internalPath: join(workspacePath, CLASSIFICATION_DIRS.INTERNAL),
    confidentialPath: join(workspacePath, CLASSIFICATION_DIRS.CONFIDENTIAL),
    restrictedPath: join(workspacePath, CLASSIFICATION_DIRS.RESTRICTED),
  };
}

/** Build the level-to-directory-path lookup for classification resolution. */
function buildLevelToDirPath(paths: {
  readonly internalPath: string;
  readonly confidentialPath: string;
  readonly restrictedPath: string;
}): Record<string, string> {
  return {
    INTERNAL: paths.internalPath,
    CONFIDENTIAL: paths.confidentialPath,
    RESTRICTED: paths.restrictedPath,
  };
}

/** Resolve a bare (non-prefixed) write path to the session taint directory. */
function resolveBareWritePath(
  relativePath: string,
  sessionTaint: ClassificationLevel,
  levelToDirPath: Record<string, string>,
  workspacePath: string,
): Result<ClassifiedPathResult, string> {
  const absPath = resolve(
    join(levelToDirPath[sessionTaint], relativePath),
  );
  const check = enforcePathInWorkspace(
    absPath,
    workspacePath,
    relativePath,
  );
  if (!check.ok) return check;
  return {
    ok: true,
    value: { absolutePath: absPath, classification: sessionTaint },
  };
}

/**
 * Create an isolated workspace directory for an agent.
 *
 * Creates the workspace root, standard subdirectories, and
 * classification-partitioned directories.
 */
export async function createWorkspace(
  options: WorkspaceOptions,
): Promise<Workspace> {
  const sanitizedAgentId = sanitizePathForPrompt(options.agentId);
  if (sanitizedAgentId.length === 0) {
    log.warn("Workspace agentId rejected: empty after sanitization", {
      originalAgentId: options.agentId,
    });
    throw new Error(
      `Workspace agentId "${options.agentId}" is empty after sanitization`,
    );
  }
  if (sanitizedAgentId !== options.agentId) {
    log.warn("Workspace agentId sanitized: control characters stripped", {
      originalAgentId: options.agentId,
      sanitizedAgentId,
    });
  }
  const workspacePath = resolve(join(options.basePath, sanitizedAgentId));
  const paths = computeWorkspacePaths(workspacePath);
  const levelToDirPath = buildLevelToDirPath(paths);

  await createWorkspaceDirectories(
    workspacePath,
    paths.scratchPath,
    paths.integrationsPath,
    paths.skillsPath,
  );

  return {
    path: workspacePath,
    ...paths,
    agentId: sanitizedAgentId,
    async destroy(): Promise<void> {
      await Deno.remove(workspacePath, { recursive: true });
    },
    containsPath(targetPath: string): boolean {
      return isWithinJail(resolve(workspacePath, targetPath), workspacePath);
    },
    resolveClassifiedPath(
      relativePath: string,
      sessionTaint: ClassificationLevel,
      operation: "read" | "write",
    ): Result<ClassifiedPathResult, string> {
      if (sessionTaint === "PUBLIC") {
        log.warn("Workspace access denied for PUBLIC session", {
          operation,
          relativePath,
        });
        return {
          ok: false,
          error: "PUBLIC sessions cannot access workspace files",
        };
      }
      if (containsPathTraversal(relativePath)) {
        log.warn("Workspace path traversal attempt blocked", {
          operation,
          relativePath,
          sessionTaint,
        });
        return {
          ok: false,
          error:
            `Workspace path "${relativePath}" contains traversal or absolute components`,
        };
      }
      const prefix = extractClassificationPrefix(relativePath);
      if (prefix) {
        return resolveExplicitClassifiedPath({
          prefix,
          relativePath,
          sessionTaint,
          operation,
          levelToDirPath,
          workspacePath,
        });
      }
      if (operation === "write") {
        log.debug("Workspace write routed to session taint directory", {
          relativePath,
          sessionTaint,
        });
        return resolveBareWritePath(
          relativePath,
          sessionTaint,
          levelToDirPath,
          workspacePath,
        );
      }
      return searchReadableLevelsForFile({
        relativePath,
        sessionTaint,
        levelToDirPath,
        workspacePath,
      });
    },
  };
}
