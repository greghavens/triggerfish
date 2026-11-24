/**
 * Chat session lifecycle callbacks and assembly.
 *
 * Builds the main chat session with session lifecycle callbacks
 * (taint escalation, reset, bumpers) and orchestrator config.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { createSession, updateTaint } from "../../../core/types/session.ts";
import type { ChannelId, UserId } from "../../../core/types/session.ts";
import {
  BUMPER_BLOCK_MESSAGE,
  toggleBumpers,
  wouldBumpersBlock,
} from "../../../core/session/bumpers.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import type { createLogger } from "../../../core/logger/mod.ts";
import type { createAutoLaunchBrowserExecutor } from "../../../tools/browser/mod.ts";
import { createChatSession } from "../../chat.ts";
import {
  resolvePromptsForProfile,
  resolveToolsForProfile,
} from "../../tools/agent_tools.ts";
import {
  buildUnconfiguredServicesPrompt,
  filterProfileByAvailability,
  TOOL_PROFILES,
} from "../../tools/defs/tool_profiles.ts";
import { TOOL_BEHAVIOR_PROMPT } from "../../../agent/orchestrator/tool_behavior_prompt.ts";
import {
  buildExtraSystemPromptGetter,
  buildExtraToolsGetter,
} from "../tools/tool_executor.ts";
import type { MainSessionState } from "../tools/tool_executor.ts";
import { persistSessionRecord } from "../tools/tool_infra_session.ts";

/** Build session lifecycle callbacks (escalate, reset, bumpers). */
export function buildSessionLifecycleCallbacks(
  state: MainSessionState,
  browserHandle: ReturnType<typeof createAutoLaunchBrowserExecutor>,
  log: ReturnType<typeof createLogger>,
  opts?: { readonly storage?: StorageProvider; readonly ownerId?: string },
) {
  return {
    getSessionTaint: () => state.session.taint,
    escalateTaint: (level: ClassificationLevel, reason: string) => {
      state.session = updateTaint(state.session, level, reason);
    },
    resetSession: () => {
      state.session = createSession({
        userId: "owner" as UserId,
        channelId: "daemon" as ChannelId,
      });
      if (opts?.storage) {
        persistSessionRecord(opts.storage, state.session.id as string)
          .catch((err: unknown) => {
            log.error("Main session ID persistence failed after reset", {
              operation: "resetSession",
              err,
            });
          });
      }
      browserHandle.close().catch((err: unknown) => {
        log.debug("Browser close failed during session reset", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    checkBumpersBlock: (level: ClassificationLevel): string | null => {
      if (wouldBumpersBlock(state.session, level)) {
        log.warn("Bumpers blocked taint escalation", {
          operation: "checkBumpersBlock",
          currentTaint: state.session.taint,
          requestedLevel: level,
        });
        return BUMPER_BLOCK_MESSAGE;
      }
      return null;
    },
    toggleSessionBumpers: (): boolean => {
      state.session = toggleBumpers(state.session);
      log.warn("Bumpers toggled", {
        operation: "toggleSessionBumpers",
        bumpersEnabled: state.session.bumpersEnabled,
      });
      if (opts?.storage && opts?.ownerId) {
        const key = `prefs:${opts.ownerId}:bumpers_default`;
        const value = JSON.stringify(state.session.bumpersEnabled);
        opts.storage.set(key, value).catch((err: unknown) => {
          log.error("Bumper preference persistence failed", {
            operation: "toggleSessionBumpers",
            err,
          });
        });
      }
      return state.session.bumpersEnabled;
    },
    getBumpersEnabled: () => state.session.bumpersEnabled,
  };
}

/** Shared deps shape for assembleChatSession. */
export type { ChatSessionDeps } from "./chat_session.ts";

/** Build the dynamic getter and prompt options for the chat session. */
export function buildChatSessionDynamicOptions(
  deps: import("./chat_session.ts").ChatSessionDeps,
) {
  const filteredProfile = filterProfileByAvailability(
    TOOL_PROFILES.cli,
    deps.serviceAvailability,
  );
  const unconfiguredPrompt = buildUnconfiguredServicesPrompt(
    deps.serviceAvailability,
  );
  return {
    getExtraTools: buildExtraToolsGetter(
      deps.mcpWiring,
      deps.isTidepoolCallRef,
      deps.tidepoolToolsRef,
    ),
    getExtraSystemPromptSections: buildExtraSystemPromptGetter(
      deps.mcpWiring,
      deps.isTidepoolCallRef,
      () => deps.state.session.taint,
      deps.workspacePaths,
      deps.personaOptions,
      () => deps.state.session.bumpersEnabled,
    ),
    systemPromptSections: [
      TOOL_BEHAVIOR_PROMPT,
      ...resolvePromptsForProfile(filteredProfile),
      deps.skillsPrompt,
      deps.triggersPrompt,
      ...(unconfiguredPrompt ? [unconfiguredPrompt] : []),
    ],
    ...(deps.streamingPref !== undefined
      ? { enableStreaming: deps.streamingPref === true }
      : {}),
    debug: deps.config.debug === true ||
      Deno.env.get("TRIGGERFISH_DEBUG") === "1",
  };
}

/** Create the main chat session with all orchestrator config. */
export function assembleChatSession(
  deps: import("./chat_session.ts").ChatSessionDeps,
) {
  const lifecycle = buildSessionLifecycleCallbacks(
    deps.state,
    deps.browserHandle,
    deps.log,
    { storage: deps.storage, ownerId: deps.ownerId },
  );
  const filteredProfile = filterProfileByAvailability(
    TOOL_PROFILES.cli,
    deps.serviceAvailability,
  );
  return createChatSession({
    sentinelSnapshotPath: deps.sentinelSnapshotPath,
    sentinelSharedInventoryBaseDir: deps.sentinelSharedInventoryBaseDir,
    resolveSentinelChatCase: deps.resolveSentinelChatCase,
    sentinelWebContainmentConfigured:
      deps.config.web?.domains?.sentinel_containment === true,
    allowSentinelModelAccess: deps.config.sentinel?.allow_model_access === true,
    sentinelOutputLanguage: deps.config.sentinel?.output_language,
    hookRunner: deps.hookRunner,
    providerRegistry: deps.registry,
    spinePath: deps.spinePath,
    tools: resolveToolsForProfile(filteredProfile),
    ...buildChatSessionDynamicOptions(deps),
    toolExecutor: deps.toolExecutor,
    secretStore: deps.mainKeychain,
    session: deps.state.session,
    getSession: () => deps.state.session,
    visionProvider: deps.visionProvider,
    toolClassifications: deps.toolClassifications,
    integrationClassifications: deps.integrationClassifications,
    classifyGitHubRepo: deps.classifyGitHubRepo,
    ...lifecycle,
    pairingService: deps.pairingService,
    pathClassifier: deps.pathClassifier,
    domainClassifier: deps.domainClassifier,
    toolFloorRegistry: deps.toolFloorRegistry,
    primaryModelName: deps.config.models.primary.model,
    getActiveSkillContext: deps.getActiveSkillContext,
    triggerStore: deps.triggerStore,
    broadcastChatEvent: deps.broadcastChatEvent,
    workspacePath: deps.workspacePaths.publicPath,
    getWorkspacePath: deps.getWorkspacePath,
    isOwnerTurnRef: deps.isOwnerTurnRef,
    messageStore: deps.messageStore,
    lineageStore: deps.lineageStore,
  });
}
