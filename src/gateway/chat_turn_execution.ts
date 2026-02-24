/**
 * Turn execution and taint management for chat sessions.
 *
 * Contains the mutable session state interface, taint resolution and
 * escalation helpers, orchestrator config assembly, mutex acquisition,
 * and the owner/non-owner turn runners.
 *
 * @module
 */

import type {
  Orchestrator,
  OrchestratorConfig,
} from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import { updateTaint } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { MessageContent } from "../core/image/content.ts";
import type { ChannelAdapter, ChannelMessage } from "../channels/types.ts";
import type { UserSessionManager } from "../channels/user_sessions.ts";
import type {
  ChatEvent,
  ChatEventSender,
  ChatSessionConfig,
} from "./chat_types.ts";
import { buildSendEvent } from "./chat_event_sender.ts";
import { filterToolsForRole } from "./tools/defs/role_filter.ts";

// ─── Mutable chat session state ─────────────────────────────────────────────

/** Mutable state shared across chat session helpers via parameter passing. */
export interface ChatSessionMutableState {
  activeSend: ChatEventSender | null;
  activeSessionId: string;
  activeNonOwnerCeiling: ClassificationLevel | null;
  mutex: Promise<void>;
  readonly ownerSessionId: string;
  readonly sessionStates: Map<string, SessionState>;
}

// ─── Taint helpers ──────────────────────────────────────────────────────────

/** Resolve the current taint level for the active session. */
export function resolveSessionTaint(
  state: ChatSessionMutableState,
  ownerGetTaint: (() => ClassificationLevel) | undefined,
): ClassificationLevel {
  if (state.activeSessionId === state.ownerSessionId && ownerGetTaint) {
    return ownerGetTaint();
  }
  return state.sessionStates.get(state.activeSessionId)?.taint ?? "PUBLIC";
}

/** Escalate taint for the active session and emit a taint_changed event. */
export function applyTaintEscalation(
  state: ChatSessionMutableState,
  level: ClassificationLevel,
  reason: string,
  ownerGetTaint: (() => ClassificationLevel) | undefined,
  ownerEscalateTaint:
    | ((level: ClassificationLevel, reason: string) => void)
    | undefined,
): void {
  const prevTaint = resolveSessionTaint(state, ownerGetTaint);
  if (state.activeSessionId === state.ownerSessionId && ownerEscalateTaint) {
    ownerEscalateTaint(level, reason);
  } else {
    const s = state.sessionStates.get(state.activeSessionId);
    if (s) {
      state.sessionStates.set(
        state.activeSessionId,
        updateTaint(s, level, reason),
      );
    }
  }
  const newTaint = resolveSessionTaint(state, ownerGetTaint);
  if (newTaint !== prevTaint && state.activeSend) {
    state.activeSend({ type: "taint_changed", level: newTaint });
  }
}

// ─── Orchestrator config assembly ───────────────────────────────────────────

/** Assemble the OrchestratorConfig from ChatSessionConfig and taint closures. */
export function assembleOrchestratorConfig(
  config: ChatSessionConfig,
  state: ChatSessionMutableState,
  getSessionTaint: () => ClassificationLevel,
  escalateTaint: (level: ClassificationLevel, reason: string) => void,
): OrchestratorConfig {
  return {
    hookRunner: config.hookRunner,
    providerRegistry: config.providerRegistry,
    spinePath: config.spinePath,
    tools: config.tools,
    getExtraTools: config.getExtraTools,
    getExtraSystemPromptSections: config.getExtraSystemPromptSections,
    toolExecutor: config.toolExecutor,
    onEvent: (event) => {
      if (state.activeSend) state.activeSend(event as ChatEvent);
    },
    compactorConfig: config.compactorConfig,
    systemPromptSections: config.systemPromptSections,
    planManager: config.planManager,
    enableStreaming: config.enableStreaming,
    debug: config.debug,
    visionProvider: config.visionProvider,
    toolClassifications: config.toolClassifications,
    getSessionTaint,
    escalateTaint,
    isOwnerSession: () => state.activeSessionId === state.ownerSessionId,
    getNonOwnerCeiling: () => state.activeNonOwnerCeiling,
    pathClassifier: config.pathClassifier,
    domainClassifier: config.domainClassifier,
    toolFloorRegistry: config.toolFloorRegistry,
    secretStore: config.secretStore,
    getActiveSkillContext: config.getActiveSkillContext,
    filterTools: filterToolsForRole,
  };
}

// ─── Mutex acquisition ──────────────────────────────────────────────────────

/** Acquire the promise-chain mutex, returning a release function. */
export async function acquireTurnMutex(
  state: ChatSessionMutableState,
): Promise<() => void> {
  const prev = state.mutex;
  let release: () => void;
  state.mutex = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  return release!;
}

// ─── Error helper ───────────────────────────────────────────────────────────

/** Send an orchestrator error result to the event sender if not aborted. */
export function sendTurnErrorIfNotAborted(
  sendEvent: ChatEventSender,
  err: unknown,
  signal?: AbortSignal,
): void {
  if (!signal?.aborted) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent({ type: "error", message: msg });
  }
}

// ─── Owner turn execution ───────────────────────────────────────────────────

/** Run a single owner agent turn under the mutex. */
export async function runOwnerAgentTurn(
  state: ChatSessionMutableState,
  orchestrator: Orchestrator,
  getSession: () => SessionState,
  content: MessageContent,
  targetClassification: ClassificationLevel,
  sendEvent: ChatEventSender,
  signal?: AbortSignal,
): Promise<void> {
  const release = await acquireTurnMutex(state);
  state.activeSend = sendEvent;
  state.activeSessionId = state.ownerSessionId;
  try {
    const result = await orchestrator.executeAgentTurn({
      session: getSession(),
      message: content,
      targetClassification,
      signal,
    });
    if (!result.ok && !signal?.aborted) {
      sendEvent({ type: "error", message: result.error });
    }
  } catch (err: unknown) {
    sendTurnErrorIfNotAborted(sendEvent, err, signal);
  } finally {
    state.activeSend = null;
    state.activeSessionId = state.ownerSessionId;
    release();
  }
}

// ─── Non-owner turn helpers ─────────────────────────────────────────────────

/** Resolve the non-owner classification ceiling for a sender. */
export function resolveNonOwnerCeiling(
  userSessions: UserSessionManager,
  effectiveSenderId: string,
): ClassificationLevel | null {
  return userSessions.hasExplicitClassification(effectiveSenderId)
    ? userSessions.getClassification(effectiveSenderId)
    : null;
}

/** Persist updated session state back to the user session manager after a turn. */
export function persistNonOwnerSession(
  state: ChatSessionMutableState,
  userSessions: UserSessionManager,
  channelType: string,
  effectiveSenderId: string,
  userSessionId: string,
): void {
  const updated = state.sessionStates.get(userSessionId);
  if (updated) {
    userSessions.updateSession(channelType, effectiveSenderId, updated);
  }
}

// ─── Non-owner turn execution ───────────────────────────────────────────────

/** Internal per-channel state needed for non-owner turn execution. */
export interface TurnChannelState {
  readonly userSessions: UserSessionManager;
  readonly adapter: ChannelAdapter;
  readonly channelName: string;
}

/** Run a single non-owner agent turn under the mutex. */
export async function runNonOwnerAgentTurn(
  state: ChatSessionMutableState,
  orchestrator: Orchestrator,
  msg: ChannelMessage,
  channelType: string,
  channelState: TurnChannelState,
  signal?: AbortSignal,
): Promise<void> {
  const senderId = msg.senderId ?? "";
  const effectiveSenderId = senderId || "unknown";
  const userSessions = channelState.userSessions;
  const userSession = userSessions.getOrCreate(channelType, effectiveSenderId);
  const userCls = userSessions.getClassification(effectiveSenderId);
  const sendEvent = buildSendEvent(
    channelState.adapter,
    channelState.channelName,
    msg,
  );

  const release = await acquireTurnMutex(state);
  const userSessionId = userSession.id as string;
  state.sessionStates.set(userSessionId, userSession);
  state.activeSend = sendEvent;
  state.activeSessionId = userSessionId;
  state.activeNonOwnerCeiling = resolveNonOwnerCeiling(
    userSessions,
    effectiveSenderId,
  );

  try {
    const result = await orchestrator.executeAgentTurn({
      session: userSession,
      message: msg.content,
      targetClassification: userCls,
      signal,
    });
    if (!result.ok && !signal?.aborted) {
      sendEvent({ type: "error", message: result.error });
    }
  } catch (err: unknown) {
    sendTurnErrorIfNotAborted(sendEvent, err, signal);
  } finally {
    persistNonOwnerSession(
      state,
      userSessions,
      channelType,
      effectiveSenderId,
      userSessionId,
    );
    state.activeSend = null;
    state.activeSessionId = state.ownerSessionId;
    state.activeNonOwnerCeiling = null;
    release();
  }
}
