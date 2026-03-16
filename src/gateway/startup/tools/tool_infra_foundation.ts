/**
 * LLM provider and workspace foundation initialization.
 *
 * Builds the LLM provider registry, workspace paths, path classifier,
 * exec tools, and base tool dependencies needed by the tool infrastructure.
 *
 * @module
 */

import { createExecTools } from "../../../exec/tools.ts";
import { createTodoManager } from "../../../tools/mod.ts";
import { mapToolPrefixClassifications } from "../../../agent/orchestrator/orchestrator_types.ts";
import { createFilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import { initializeLlmProviders } from "../infra/storage.ts";
import {
  buildMainPathClassifier,
  initializeMainWorkspace,
} from "../infra/workspace_init.ts";
import type { WorkspacePaths } from "./tool_executor.ts";
import { resolveWorkspacePathForTaint } from "./tool_executor.ts";
import { buildWebTools as buildWebToolsFn } from "../factory/web_tools.ts";

/** Build LLM, workspace, and path classifier foundation. */
export async function buildLlmAndWorkspaceFoundation(
  bootstrap: BootstrapResult,
) {
  const { registry, hookRunner } = initializeLlmProviders(
    bootstrap.config,
    bootstrap.log,
  );
  const { spinePath, mainWorkspace } = await initializeMainWorkspace(
    bootstrap.baseDir,
  );
  return { registry, hookRunner, spinePath, mainWorkspace };
}

/** Initialize LLM providers, workspace, and base tool dependencies. */
export async function initializeBaseToolDeps(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
) {
  const { loadBumpersPreference } = await import("./tool_infra_types.ts");
  const { initializeMainSessionState } = await import(
    "./tool_infra_session.ts"
  );
  const foundation = await buildLlmAndWorkspaceFoundation(bootstrap);
  const bumpersDefault = await loadBumpersPreference(coreInfra.storage);
  const { state, cliSecretPrompt, cliCredentialPrompt } =
    initializeMainSessionState({ bumpersEnabled: bumpersDefault });
  const workspace = foundation.mainWorkspace;
  const workspacePaths: WorkspacePaths = {
    publicPath: workspace.publicPath,
    internalPath: workspace.internalPath,
    confidentialPath: workspace.confidentialPath,
    restrictedPath: workspace.restrictedPath,
  };
  const resolveTaintCwd = () =>
    resolveWorkspacePathForTaint(state.session.taint, workspacePaths);
  const pathClassifier = buildMainPathClassifier(
    coreInfra.fsPathMap,
    coreInfra.fsDefault,
    workspace,
    { resolveCwd: resolveTaintCwd },
  );
  const execTools = createExecTools(workspace, {
    cwdOverride: resolveTaintCwd,
  });
  const filesystemSandbox = createFilesystemSandbox({
    resolveWorkspacePath: resolveTaintCwd,
  });
  const todoManager = createTodoManager({
    storage: coreInfra.storage,
    agentId: "main-session",
  });
  return {
    ...foundation,
    pathClassifier,
    execTools,
    filesystemSandbox,
    todoManager,
    ...buildWebToolsFn(bootstrap.config),
    state,
    cliSecretPrompt,
    cliCredentialPrompt,
    ...(() => {
      const { all, integrations } = mapToolPrefixClassifications(
        bootstrap.config,
      );
      return {
        toolClassifications: all,
        integrationClassifications: integrations,
      };
    })(),
  };
}
