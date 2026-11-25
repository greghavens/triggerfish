/**
 * Composite tool executor assembly and final result construction.
 *
 * Combines all executor outputs into the composite tool executor,
 * and assembles the final ToolInfraResult from sub-phase outputs.
 *
 * @module
 */

import { join } from "@std/path";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import { buildIntegrationExecutors } from "../services/integration_init.ts";
import {
  assembleMainToolExecutor,
  resolveWorkspacePathForTaint,
} from "./tool_executor.ts";
import { createSimulateToolExecutor } from "../../tools/simulate/mod.ts";
import { createTriggerManageExecutor } from "../../tools/trigger/trigger_manage_executor.ts";
import type { ServiceAvailability } from "../../tools/defs/tool_profiles.ts";
import { buildTeamExecutor } from "../factory/team_executor.ts";
import { buildWorkflowRecoveryExecutor } from "../factory/agent_recovery.ts";
import type { WorkflowRunRegistry } from "../../../workflow/mod.ts";
import {
  createPluginExecutor,
  createPluginRegistry,
  createPluginScanner,
  createPluginToolExecutor,
} from "../../../plugin/mod.ts";
import type { PluginRegistry, PluginTrustLevel } from "../../../plugin/mod.ts";
import type { initializeBaseToolDeps } from "./tool_infra_foundation.ts";
import { createConfigManageExecutor } from "../../tools/executor/executor_config_manage.ts";
import { createMcpManageExecutor } from "../../tools/executor/executor_mcp_manage.ts";
import { createDaemonManageExecutor } from "../../tools/executor/executor_daemon_manage.ts";
import { resolveConfigPath } from "../../../cli/config/paths.ts";
import { fetchDaemonStatus } from "../../../cli/daemon/lifecycle_status.ts";
import { createSpineManageExecutor } from "../../tools/executor/executor_spine_manage.ts";

/** Combine all executor outputs into the composite tool executor. */
export function buildCompositeToolExecutor(
  bootstrap: BootstrapResult,
  baseDeps: Awaited<ReturnType<typeof initializeBaseToolDeps>>,
  coreInfra: CoreInfraResult,
  sessionExecs: Awaited<
    ReturnType<
      typeof import("./tool_infra_session.ts").buildSessionScopedExecutors
    >
  >,
  integrations: Awaited<ReturnType<typeof buildIntegrationExecutors>>,
  workflowRunRegistry: WorkflowRunRegistry,
  pluginRegistry?: PluginRegistry,
) {
  const simulateExecutor = createSimulateToolExecutor({
    getSessionTaint: () => baseDeps.state.session.taint,
    isOwner: () => true,
    isTrigger: () => false,
    toolClassifications: baseDeps.toolClassifications,
    integrationClassifications: baseDeps.integrationClassifications,
    pathClassifier: baseDeps.pathClassifier,
    domainClassifier: baseDeps.domainClassifier,
    toolFloorRegistry: coreInfra.toolFloorRegistry,
    getWorkspacePath: () =>
      resolveWorkspacePathForTaint(baseDeps.state.session.taint, {
        publicPath: baseDeps.mainWorkspace.publicPath,
        internalPath: baseDeps.mainWorkspace.internalPath,
        confidentialPath: baseDeps.mainWorkspace.confidentialPath,
        restrictedPath: baseDeps.mainWorkspace.restrictedPath,
      }),
  });
  const sched = bootstrap.config.scheduler?.trigger;
  const triggerManageExecutor = createTriggerManageExecutor({
    triggerMdPath: join(bootstrap.baseDir, "TRIGGER.md"),
    triggerConfig: {
      enabled: (sched?.enabled ?? true) &&
        (sched?.interval_minutes ?? 30) !== 0,
      intervalMinutes: sched?.interval_minutes ?? 30,
      classificationCeiling: (sched?.classification_ceiling ??
        "CONFIDENTIAL") as ClassificationLevel,
    },
    triggerStore: coreInfra.triggerStore,
    memoryStore: sessionExecs.memoryStore,
    agentId: "main-session",
    getSessionTaint: () => baseDeps.state.session.taint,
    getSessionId: () => baseDeps.state.session.id,
  });
  const teamRecovery = bootstrap.config.agent_recovery?.team === true
    ? buildWorkflowRecoveryExecutor(
      bootstrap.config,
      bootstrap.baseDir,
      integrations.mainKeychain,
    )
    : undefined;
  const primary = bootstrap.config.models.primary;
  const teamExecutor = buildTeamExecutor({
    storage: coreInfra.storage,
    orchestratorFactory: coreInfra.factory,
    sessionManager: coreInfra.enhancedSessionManager,
    callerSessionId: baseDeps.state.session.id,
    getCallerTaint: () => baseDeps.state.session.taint,
    ...(teamRecovery && {
      recovery: {
        path: join(bootstrap.baseDir, "team-recovery.db"),
        profileBinding: JSON.stringify([primary.provider, primary.model]),
        run: teamRecovery,
      },
    }),
  });
  const execute = assembleMainToolExecutor({
    execTools: baseDeps.execTools,
    filesystemSandbox: baseDeps.filesystemSandbox,
    cronManager: coreInfra.cronManager,
    todoManager: baseDeps.todoManager,
    searchProvider: baseDeps.searchProvider,
    webFetcher: baseDeps.webFetcher,
    memoryExecutor: sessionExecs.memoryExecutor,
    planExecutor: sessionExecs.mainPlanExecutor,
    browserExecutor: sessionExecs.browserHandle.executor,
    tidepoolExecutor: sessionExecs.tidepoolExecutor,
    imageExecutor: sessionExecs.imageExecutor,
    sessionExecutor: sessionExecs.sessionExecutor,
    exploreExecutor: integrations.exploreExecutor,
    state: baseDeps.state,
    githubExecutor: integrations.githubExecutor,
    caldavExecutor: integrations.caldavExecutor,
    notionExecutor: integrations.notionExecutor,
    xExecutor: integrations.xExecutor,
    obsidianExecutor: integrations.obsidianExecutor,
    registry: baseDeps.registry,
    storage: coreInfra.storage,
    skillLoader: integrations.skillLoader,
    claudeExecutor: integrations.claudeExecutor,
    mcpExecutor: integrations.mcpExecutor,
    subagentFactory: integrations.subagentFactory,
    secretExecutor: integrations.secretExecutor,
    triggerExecutor: integrations.triggerExecutor,
    triggerManageExecutor,
    skillExecutor: integrations.skillExecutor,
    skillContextTracker: integrations.skillContextTracker,
    simulateExecutor,
    teamExecutor,
    workflowRunRegistry,
    pluginExecutor: pluginRegistry
      ? createPluginExecutor(pluginRegistry)
      : undefined,
    pluginToolExecutor: pluginRegistry
      ? createPluginToolExecutor({
        registry: pluginRegistry,
        getSessionTaint: () => baseDeps.state.session.taint,
        pluginsConfig: (bootstrap.config.plugins ?? {}) as Record<
          string,
          | {
            enabled?: boolean;
            trust?: PluginTrustLevel;
            classification?: string;
          }
          | undefined
        >,
        toolClassifications: baseDeps.toolClassifications,
        integrationClassifications: baseDeps.integrationClassifications,
        scanPlugin: createPluginScanner(),
      })
      : undefined,
    configManageExecutor: createConfigManageExecutor({
      configPath: resolveConfigPath(bootstrap.baseDir),
    }),
    mcpManageExecutor: createMcpManageExecutor({
      configPath: resolveConfigPath(bootstrap.baseDir),
      getConfirmPrompt: () => baseDeps.state.activeConfirmPrompt,
    }),
    daemonManageExecutor: createDaemonManageExecutor({
      getDaemonStatus: fetchDaemonStatus,
      getConfirmPrompt: () => baseDeps.state.activeConfirmPrompt,
    }),
    spineManageExecutor: createSpineManageExecutor({
      spinePath: join(bootstrap.baseDir, "SPINE.md"),
    }),
  });
  return Object.assign(execute, {
    runTeamRecoveryCommand: teamExecutor.runRecoveryCommand,
  });
}

/** Assemble the final ToolInfraResult from sub-phase outputs. */
export function assembleToolInfraResult(
  baseDeps: Awaited<ReturnType<typeof initializeBaseToolDeps>>,
  coreInfra: CoreInfraResult,
  sessionExecs: Awaited<
    ReturnType<
      typeof import("./tool_infra_session.ts").buildSessionScopedExecutors
    >
  >,
  integrations: Awaited<ReturnType<typeof buildIntegrationExecutors>>,
  toolExecutor: ReturnType<typeof buildCompositeToolExecutor>,
  serviceAvailability: ServiceAvailability,
  workflowRunRegistry: WorkflowRunRegistry,
  pluginRegistry?: PluginRegistry,
): import("./tool_infra_types.ts").ToolInfraResult {
  return {
    registry: baseDeps.registry,
    hookRunner: baseDeps.hookRunner,
    spinePath: baseDeps.spinePath,
    mainWorkspace: baseDeps.mainWorkspace,
    pathClassifier: baseDeps.pathClassifier,
    visionProvider: sessionExecs.visionProvider,
    state: baseDeps.state,
    cliSecretPrompt: baseDeps.cliSecretPrompt,
    cliCredentialPrompt: baseDeps.cliCredentialPrompt,
    cliConfirmPrompt: baseDeps.cliConfirmPrompt,
    memoryDb: sessionExecs.memoryDb,
    memoryStore: sessionExecs.memoryStore,
    memorySearchProvider: sessionExecs.memorySearchProvider,
    browserHandle: sessionExecs.browserHandle,
    channelAdapters: sessionExecs.channelAdapters,
    toolClassifications: baseDeps.toolClassifications,
    integrationClassifications: baseDeps.integrationClassifications,
    classifyGitHubRepo: baseDeps.classifyGitHubRepo,
    keychain: integrations.keychain,
    mcpBroadcastRefs: integrations.mcpBroadcastRefs,
    mcpWiring: integrations.mcpWiring,
    toolExecutor,
    runTeamRecoveryCommand: toolExecutor.runTeamRecoveryCommand,
    skillsPrompt: integrations.skillsPrompt,
    triggersPrompt: integrations.triggersPrompt,
    mainKeychain: integrations.mainKeychain,
    domainClassifier: baseDeps.domainClassifier,
    toolFloorRegistry: coreInfra.toolFloorRegistry,
    tidepoolToolsRef: sessionExecs.tidepoolToolsRef,
    skillContextTracker: integrations.skillContextTracker,
    serviceAvailability,
    workflowRunRegistry,
    pluginRegistry: pluginRegistry ?? createPluginRegistry(),
  };
}
