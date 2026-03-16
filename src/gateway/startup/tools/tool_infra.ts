/**
 * Tool infrastructure initialization phase.
 *
 * Wires all tool executors: LLM providers, workspace, memory, browser,
 * tidepool, GitHub, Obsidian, MCP, skills, secrets, triggers, and
 * assembles them into the composite tool executor.
 *
 * @module
 */

import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import { buildIntegrationExecutors } from "../services/integration_init.ts";
import { createWorkflowRunRegistry } from "../../../workflow/mod.ts";

// Re-export types and functions from sub-modules
export type { TidepoolToolsRef, ToolInfraResult } from "./tool_infra_types.ts";
export { detectServiceAvailability } from "./tool_infra_types.ts";
export {
  buildMediaExecutors,
  buildSessionChannelExecutors,
  buildSessionScopedExecutors,
  initializeMainSessionState,
} from "./tool_infra_session.ts";
export {
  buildLlmAndWorkspaceFoundation,
  initializeBaseToolDeps,
} from "./tool_infra_foundation.ts";
export {
  assembleToolInfraResult,
  buildCompositeToolExecutor,
} from "./tool_infra_assembly.ts";
export { initializePlugins } from "./tool_infra_plugins.ts";

/** Wire all tool infrastructure: LLM providers, executors, integrations. */
export async function initializeToolInfrastructure(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
): Promise<import("./tool_infra_types.ts").ToolInfraResult> {
  const { detectServiceAvailability: detect } = await import(
    "./tool_infra_types.ts"
  );
  const { buildSessionScopedExecutors } = await import(
    "./tool_infra_session.ts"
  );
  const { initializeBaseToolDeps } = await import(
    "./tool_infra_foundation.ts"
  );
  const { buildCompositeToolExecutor, assembleToolInfraResult } = await import(
    "./tool_infra_assembly.ts"
  );
  const { initializePlugins } = await import("./tool_infra_plugins.ts");
  const baseDeps = await initializeBaseToolDeps(bootstrap, coreInfra);
  const sessionExecs = await buildSessionScopedExecutors(
    bootstrap,
    coreInfra,
    baseDeps,
  );
  const integrations = await buildIntegrationExecutors(
    bootstrap,
    coreInfra,
    { ...baseDeps, factory: coreInfra.factory },
  );
  const workflowRunRegistry = createWorkflowRunRegistry();
  const pluginRegistry = await initializePlugins(
    bootstrap.config,
    () => baseDeps.state.session.taint,
    baseDeps.toolClassifications,
    baseDeps.integrationClassifications,
  );
  const toolExecutor = buildCompositeToolExecutor(
    bootstrap,
    baseDeps,
    coreInfra,
    sessionExecs,
    integrations,
    workflowRunRegistry,
    pluginRegistry,
  );
  const serviceAvailability = await detect(
    bootstrap.config,
    integrations.keychain,
  );
  return assembleToolInfraResult(
    baseDeps,
    coreInfra,
    sessionExecs,
    integrations,
    toolExecutor,
    serviceAvailability,
    workflowRunRegistry,
    pluginRegistry,
  );
}
