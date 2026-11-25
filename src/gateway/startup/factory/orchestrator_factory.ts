import {
  createScheduledObservationRead,
  scheduledObservationTool,
  selectAgentObservationRead,
} from "../../scheduled_observation_tool.ts";
import { buildExecutionTracePayloadAuthorizer } from "./agent_recovery.ts";
import { configuredSentinelWorkflowReader } from "./sentinel_workflow_source.ts";
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
import { sentinelLocalObservationKind } from "../../../core/config_types.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import {
  createSession,
  OWNER_MEMORY_AGENT_ID,
  restoreSession,
  updateTaint,
} from "../../../core/types/session.ts";
import type {
  ChannelId,
  SessionId,
  SessionState,
  UserId,
} from "../../../core/types/session.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import { createOrchestrator } from "../../../agent/orchestrator/orchestrator.ts";
import type { OrchestratorConfig } from "../../../agent/orchestrator/orchestrator_config.ts";
import { createSavedSourceAuthorization } from "../../../agent/dispatch/saved_source_authorization.ts";
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
import { isValidSessionId } from "../tools/tool_infra_session.ts";
import { buildDelegatedGoalCompletion } from "./delegated_goal_completion.ts";

const log = createLogger("orchestrator-factory");

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
  const delegatedGoals = buildDelegatedGoalCompletion(
    baseDir,
    config.delegated_goal_completion,
    storage ? createMessageStore(storage) : undefined,
  );
  const skillState = { discovered: false, prompt: "" };
  let cachedAvailability: ServiceAvailability | undefined = serviceAvailability;

  return {
    ...(delegatedGoals && {
      runDelegatedGoalCommand: delegatedGoals.runCommand,
    }),
    async create(channelId: string, options?: OrchestratorCreateOptions) {
      await discoverSkillsOnce(infra.skillLoader, skillState);
      if (!cachedAvailability) {
        cachedAvailability = await detectServiceAvailability(
          config,
          infra.keychain,
        );
      }

      const isTrigger = options?.isTrigger ?? false;
      const ceiling = options?.ceiling ?? null;
      const recoverySessionId = options?.recoverySessionId;
      const recoveryTaint = options?.recoverySessionTaint;
      if (
        recoverySessionId !== undefined && !isValidSessionId(recoverySessionId)
      ) {
        throw new Error("Invalid trusted recovery session ID");
      }
      if (
        recoveryTaint !== undefined &&
        (!recoverySessionId || !ceiling || !canFlowTo(recoveryTaint, ceiling))
      ) {
        throw new Error("Invalid trusted recovery session taint");
      }
      const observationGrant = selectAgentObservationRead(
        config.sentinel,
        options,
      );
      const teamObservation = options?.teamObservation;
      if (teamObservation && !observationGrant) {
        throw new Error("Invalid trusted team observation grant");
      }
      const agentId = teamObservation
        ? `recovery-team-${teamObservation.source.deliveryId}`
        : recoverySessionId
        ? `recovery-${recoverySessionId}`
        : `scheduler-${channelId}-${Date.now()}`;
      if (isTrigger || ceiling !== null) {
        log.info("Ceiling-enforced machine session created", {
          operation: "createSchedulerOrchestrator",
          channelId,
          isTrigger,
          ceiling,
        });
      }

      const workspace = options?.workspace ?? await createWorkspace({
        agentId,
        basePath: join(baseDir, "workspaces"),
      });
      if (!options?.workspace) {
        await symlinkSpineToWorkspace(infra.spinePath, workspace.path);
      }

      let session = recoverySessionId
        ? restoreSession({
          id: recoverySessionId,
          userId: "owner" as UserId,
          channelId: channelId as ChannelId,
        })
        : await resolveFactorySession(channelId, {
          persistent: options?.persistent ?? false,
          storage,
        });
      if (recoveryTaint !== undefined) {
        session = updateTaint(
          session,
          recoveryTaint,
          "Restore trusted recovery scope",
        );
      }

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

      // A delivery grant has its own durable turn journal and scratch space.
      // Do not copy its messages into the member's shared session history.
      const factoryMessageStore = storage && !teamObservation
        ? createMessageStore(storage)
        : undefined;
      const factoryLineageStore = storage && !teamObservation
        ? createLineageStore(storage)
        : undefined;

      const localObservation = observationGrant &&
        sentinelLocalObservationKind(observationGrant.observation_id);
      const authorizeObservation = observationGrant
        ? buildExecutionTracePayloadAuthorizer(config, infra.keychain)
        : undefined;
      const readObservation =
        observationGrant && (localObservation || authorizeObservation)
          ? createScheduledObservationRead(
            baseDir,
            observationGrant,
            authorizeObservation,
            teamObservation?.authorizeScope,
            localObservation === "finding_recheck"
              ? configuredSentinelWorkflowReader(
                config,
                baseDir,
                () => infra.keychain,
              )
              : undefined,
          )
          : undefined;
      const toolExecutor = assembleSchedulerToolExecutor({
        infra,
        session,
        workspace,
        cronManager,
        storage,
        ...(options?.executionChecklistRunId && {
          executionChecklist: {
            path: join(baseDir, "execution-traces.db"),
            role: options.delegatedKind === "subagent"
              ? "delegated"
              : "scheduled",
            runId: options.executionChecklistRunId,
            allowLegacySessionList: recoverySessionId !== undefined,
          },
        }),
        enhancedSessionManager,
        agentId,
        githubExecutor,
        skillContextTracker,
        getSessionTaint: () => session.taint,
        memoryAgentId: isTrigger ? OWNER_MEMORY_AGENT_ID : undefined,
        lineageStore: factoryLineageStore,
      });

      const delegated = options?.delegatedKind !== undefined;
      const baseProfileName = delegated
        ? "subagent"
        : isTrigger
        ? "triggerSession"
        : "cronJob";
      const toolProfile = filterProfileByAvailability(
        TOOL_PROFILES[baseProfileName],
        cachedAvailability,
      );

      const tools = [
        ...resolveToolsForProfile(toolProfile),
        ...(readObservation ? [scheduledObservationTool] : []),
      ];
      const delegatedTools = delegated &&
        new Set(tools.map(({ name }) => name));
      const scopedToolExecutor: typeof toolExecutor = (
        name,
        input,
        context,
      ) => {
        if (delegatedTools && !delegatedTools.has(name)) {
          return Promise.resolve("Error: Tool is outside the delegated role.");
        }
        return readObservation && name === scheduledObservationTool.name
          ? readObservation(
            input,
            createSavedSourceAuthorization(orchestratorConfig, session),
          )
          : toolExecutor(name, input, context);
      };

      const workspacePaths = {
        publicPath: workspace.publicPath,
        internalPath: workspace.internalPath,
        confidentialPath: workspace.confidentialPath,
        restrictedPath: workspace.restrictedPath,
      };

      const orchestratorConfig: OrchestratorConfig = {
        hookRunner: infra.hookRunner,
        providerRegistry: infra.registry,
        spinePath: infra.spinePath,
        maxIterations: options?.maxIterations,
        maxToolResponseChars: isTrigger ? 8_000 : undefined,
        tools,
        toolExecutor: scopedToolExecutor,
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
        toolClassifications: readObservation
          ? new Map([...infra.toolClassifications ?? [], [
            scheduledObservationTool.name,
            "INTERNAL" as const,
          ]])
          : infra.toolClassifications,
        integrationClassifications: infra.integrationClassifications,
        classifyGitHubRepo: infra.classifyGitHubRepo,
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
        // Any session created with a ceiling is a non-owner machine session:
        // the ceiling is an enforced read/tool gate, not just an output gate.
        ...(isTrigger || ceiling !== null
          ? {
            isTriggerSession: () => true,
            getNonOwnerCeiling: () => ceiling,
          }
          : {}),
      };
      const orchestrator = createOrchestrator(orchestratorConfig);

      return {
        orchestrator: options?.delegatedKind && delegatedGoals
          ? delegatedGoals.wrap(orchestrator, options.delegatedKind, session.id)
          : orchestrator,
        session,
        toolExecutor: delegated ? scopedToolExecutor : toolExecutor,
        // Live taint accessor: `session` is reassigned by escalateTaint, so
        // callers must read taint here, not from the creation-time snapshot.
        getSessionTaint: () => session.taint,
      };
    },
  };
}

/** Restore or create a session for the orchestrator factory. */
function resolveFactorySession(
  channelId: string,
  opts: { readonly persistent: boolean; readonly storage?: StorageProvider },
): Promise<SessionState> {
  const sessionOpts = {
    userId: "owner" as UserId,
    channelId: channelId as ChannelId,
  };
  if (!opts.persistent || !opts.storage) {
    return Promise.resolve(createSession(sessionOpts));
  }
  return restoreOrCreatePersistedSession(
    channelId,
    sessionOpts,
    opts.storage,
  );
}

/** Parse or migrate a raw persisted session record. Returns session ID or null. */
async function parsePersistedSessionRecord(
  storageKey: string,
  raw: string,
  channelId: string,
  storage: StorageProvider,
): Promise<{ readonly id: string; readonly createdAt?: string } | null> {
  try {
    const record = JSON.parse(raw) as { id: string; createdAt: string };
    if (isValidSessionId(record.id)) return record;
  } catch {
    if (isValidSessionId(raw)) {
      const migrated = JSON.stringify({
        id: raw,
        createdAt: new Date().toISOString(),
      });
      await storage.set(storageKey, migrated);
      log.info("Migrated legacy persisted session ID for channel", {
        operation: "parsePersistedSessionRecord",
        channelId,
        sessionId: raw,
      });
      return { id: raw };
    }
  }
  log.warn("Persisted session record has invalid format, generating new", {
    operation: "parsePersistedSessionRecord",
    channelId,
  });
  return null;
}

/** Restore a persisted session ID from storage, or create and persist a new one. */
async function restoreOrCreatePersistedSession(
  channelId: string,
  sessionOpts: { readonly userId: UserId; readonly channelId: ChannelId },
  storage: StorageProvider,
): Promise<SessionState> {
  const storageKey = `session-id:${channelId}`;
  const raw = await storage.get(storageKey);
  if (raw) {
    const parsed = await parsePersistedSessionRecord(
      storageKey,
      raw,
      channelId,
      storage,
    );
    if (parsed) {
      return restoreSession({
        ...sessionOpts,
        id: parsed.id as SessionId,
        ...(parsed.createdAt ? { createdAt: new Date(parsed.createdAt) } : {}),
      });
    }
  }
  const session = createSession(sessionOpts);
  const record = JSON.stringify({
    id: session.id as string,
    createdAt: new Date().toISOString(),
  });
  await storage.set(storageKey, record);
  log.info("Persisted new session ID for channel", {
    operation: "restoreOrCreatePersistedSession",
    channelId,
    sessionId: session.id,
  });
  return session;
}
