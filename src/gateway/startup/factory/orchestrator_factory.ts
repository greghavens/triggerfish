/**
 * Orchestrator factory for scheduler, trigger, and subagent sessions.
 *
 * Creates a fresh workspace, session, and orchestrator per call,
 * capturing shared infrastructure (provider registry, policy engine,
 * hook runner, tool definitions) for execution isolation.
 * @module
 */

import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import {
  createSession,
  OWNER_MEMORY_AGENT_ID,
  updateTaint,
} from "../../../core/types/session.ts";
import type { ChannelId, UserId } from "../../../core/types/session.ts";
import { createOrchestrator } from "../../../agent/orchestrator/orchestrator.ts";
import { createWorkspace } from "../../../exec/workspace.ts";
import type { ToolFloorRegistry } from "../../../core/security/tool_floors.ts";
import { TRIGGER_SESSION_SYSTEM_PROMPT } from "../../tools/trigger/trigger_tools.ts";
import {
  buildWorkspacePrompt,
  resolveWorkspacePathForTaint,
} from "../tools/tool_executor.ts";
import type { EnhancedSessionManager } from "../../sessions.ts";
import type { CronManager } from "../../../scheduler/cron/parser.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import { createMessageStore } from "../../../core/conversation/mod.ts";
import { createLineageStore } from "../../../core/session/lineage.ts";
import type {
  OrchestratorCreateOptions,
  OrchestratorFactory,
} from "../../../scheduler/service_types.ts";
import {
  resolvePromptsForProfile,
  resolveToolsForProfile,
} from "../../tools/agent_tools.ts";
import {
  filterProfileByAvailability,
  TOOL_PROFILES,
} from "../../tools/defs/tool_profiles.ts";
import { TOOL_BEHAVIOR_PROMPT } from "../../../agent/orchestrator/tool_behavior_prompt.ts";
import type { ServiceAvailability } from "../../tools/defs/tool_profiles.ts";
import { detectServiceAvailability } from "../tools/tool_infra.ts";
import {
  assembleSchedulerToolExecutor,
  buildSchedulerGitHubExecutor,
  buildSchedulerPathClassifier,
} from "../tools/scheduler_tool_assembly.ts";
import { createSkillContextTracker } from "../../../tools/skills/mod.ts";
import {
  discoverSkillsOnce,
  initializeFactoryInfra,
  symlinkSpineToWorkspace,
} from "./orchestrator_factory_infra.ts";

/**
 * Create an OrchestratorFactory from config.
 *
 * The factory captures shared infrastructure (provider registry, policy
 * engine, hook runner, tool definitions) and creates a fresh workspace,
 * session, and orchestrator per call for execution isolation.
 */
export function createOrchestratorFactory(
  config: TriggerFishConfig,
  baseDir: string,
  cronManager?: CronManager,
  storage?: StorageProvider,
  enhancedSessionManager?: EnhancedSessionManager,
  fsPathMap?: ReadonlyMap<string, ClassificationLevel>,
  fsDefault?: ClassificationLevel,
  schedulerToolFloorRegistry?: ToolFloorRegistry,
  serviceAvailability?: ServiceAvailability,
): OrchestratorFactory {
  const infra = initializeFactoryInfra(config, baseDir);
  const skillState = { discovered: false, prompt: "" };
  let cachedAvailability: ServiceAvailability | undefined = serviceAvailability;

  return {
    async create(channelId: string, options?: OrchestratorCreateOptions) {
      await discoverSkillsOnce(infra.skillLoader, skillState);
      if (!cachedAvailability) {
        cachedAvailability = await detectServiceAvailability(
          config,
          infra.keychain,
        );
      }

      const isTrigger = options?.isTrigger ?? false;
      const triggerCeiling = options?.ceiling ?? null;
      const agentId = `scheduler-${channelId}-${Date.now()}`;

      const workspace = options?.workspace ?? await createWorkspace({
        agentId,
        basePath: join(baseDir, "workspaces"),
      });
      if (!options?.workspace) {
        await symlinkSpineToWorkspace(infra.spinePath, workspace.path);
      }

      let session = createSession({
        userId: "owner" as UserId,
        channelId: channelId as ChannelId,
      });

      // ── IMPORTANT: infra.keychain for all integration executors ─────────
      // Integration executors access secrets as infrastructure plumbing.
      // NEVER create a gated/classified keychain here.
      const githubExecutor = await buildSchedulerGitHubExecutor({
        keychain: infra.keychain,
        config,
        sessionTaint: session.taint,
        sourceSessionId: session.id,
        workspacePath: workspace.path,
      });

      const skillContextTracker = createSkillContextTracker();

      const factoryMessageStore = storage
        ? createMessageStore(storage)
        : undefined;
      const factoryLineageStore = storage
        ? createLineageStore(storage)
        : undefined;

      const toolExecutor = assembleSchedulerToolExecutor({
        infra,
        session,
        workspace,
        cronManager,
        storage,
        enhancedSessionManager,
        agentId,
        githubExecutor,
        skillContextTracker,
        getSessionTaint: () => session.taint,
        memoryAgentId: isTrigger ? OWNER_MEMORY_AGENT_ID : undefined,
        lineageStore: factoryLineageStore,
      });

      const baseProfileName = isTrigger ? "triggerSession" : "cronJob";
      const toolProfile = filterProfileByAvailability(
        TOOL_PROFILES[baseProfileName],
        cachedAvailability,
      );

      const workspacePaths = {
        publicPath: workspace.publicPath,
        internalPath: workspace.internalPath,
        confidentialPath: workspace.confidentialPath,
        restrictedPath: workspace.restrictedPath,
      };

      const orchestrator = createOrchestrator({
        hookRunner: infra.hookRunner,
        providerRegistry: infra.registry,
        spinePath: infra.spinePath,
        maxIterations: options?.maxIterations,
        maxToolResponseChars: isTrigger ? 8_000 : undefined,
        tools: resolveToolsForProfile(toolProfile),
        toolExecutor,
        messageStore: factoryMessageStore,
        lineageStore: factoryLineageStore,
        systemPromptSections: [
          TOOL_BEHAVIOR_PROMPT,
          ...resolvePromptsForProfile(toolProfile),
          skillState.prompt,
          ...(options?.systemPromptSections ?? []),
          ...(isTrigger ? [TRIGGER_SESSION_SYSTEM_PROMPT] : []),
        ],
        getExtraSystemPromptSections: () => [
          buildWorkspacePrompt(session.taint, workspacePaths),
        ],
        visionProvider: infra.visionProvider,
        toolClassifications: infra.toolClassifications,
        integrationClassifications: infra.integrationClassifications,
        getSessionTaint: () => session.taint,
        escalateTaint: (level: ClassificationLevel, reason: string) => {
          session = updateTaint(session, level, reason);
        },
        pathClassifier: buildSchedulerPathClassifier(
          fsPathMap,
          fsDefault,
          workspace,
          {
            resolveCwd: () =>
              resolveWorkspacePathForTaint(session.taint, workspacePaths),
          },
        ),
        getWorkspacePath: () =>
          resolveWorkspacePathForTaint(session.taint, workspacePaths),
        domainClassifier: infra.domainClassifier,
        toolFloorRegistry: schedulerToolFloorRegistry,
        getActiveSkillContext: () => skillContextTracker.getActive(),
        ...(isTrigger
          ? {
            isTriggerSession: () => true,
            getNonOwnerCeiling: () => triggerCeiling,
          }
          : {}),
      });

      return { orchestrator, session, toolExecutor };
    },
  };
}
