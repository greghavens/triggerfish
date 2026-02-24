/**
 * Chat session factory and channel routing.
 *
 * Owns the shared orchestrator and serializes access via a processing
 * mutex. Both CLI (via gateway WebSocket) and Tidepool (via browser
 * WebSocket) call into the same ChatSession instance.
 *
 * Channels register via `registerChannel` and route messages through
 * `handleChannelMessage`. Owner messages use the main daemon session;
 * non-owner messages get independent per-user sessions managed here.
 *
 * `handleChannelMessage` is the single authority for all non-owner
 * access control: pairing enforcement, respondToUnclassified gating,
 * and send-event construction. Adapters are dumb pipes.
 *
 * Types and interfaces live in `chat_types.ts`.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import { createOrchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { Orchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { ChannelAdapter, ChannelMessage } from "../channels/types.ts";
import {
  createUserSessionManager,
  parseUserOverrides,
} from "../channels/user_sessions.ts";
import type { UserSessionManager } from "../channels/user_sessions.ts";
import { createUserRateLimiter } from "../channels/rate_limiter.ts";
import type { UserRateLimiter } from "../channels/rate_limiter.ts";

import type {
  ChannelRegistrationConfig,
  ChatEventSender,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";

import { buildSendEvent } from "./chat_event_sender.ts";
import { checkNonOwnerAccess, preloadPairedUsers } from "./chat_access_control.ts";
import {
  assembleOrchestratorConfig,
  applyTaintEscalation,
  resolveSessionTaint,
  runOwnerAgentTurn,
  runNonOwnerAgentTurn,
} from "./chat_turn_execution.ts";
import type { ChatSessionMutableState } from "./chat_turn_execution.ts";

// ─── Barrel re-exports from chat_types.ts ───────────────────────────────────

export type {
  ChannelClassificationConfig,
  ChannelRegistrationConfig,
  ChatClientMessage,
  ChatEvent,
  ChatEventSender,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";

export { buildSendEvent } from "./chat_event_sender.ts";

const chatLog = createLogger("chat");

// ─── Internal per-channel state ─────────────────────────────────────────────

/** Internal per-channel state tracked by ChatSession. */
interface ChannelState {
  readonly userSessions: UserSessionManager;
  readonly adapter: ChannelAdapter;
  readonly channelName: string;
  readonly respondToUnclassified: boolean;
  readonly pairing: boolean;
  readonly pairingClassification: ClassificationLevel;
  readonly rateLimiter?: UserRateLimiter;
}

// ─── Channel registration ───────────────────────────────────────────────────

/** Build a ChannelState from registration config and persist it. */
async function registerChannelState(
  channelStates: Map<string, ChannelState>,
  pairingService: ChatSessionConfig["pairingService"],
  channelType: string,
  channelConfig: ChannelRegistrationConfig,
): Promise<void> {
  const mgr = createUserSessionManager({
    channelDefault: channelConfig.classification,
    userOverrides: parseUserOverrides(channelConfig.userClassifications),
  });
  const pairingCls = channelConfig.pairingClassification ??
    "INTERNAL" as ClassificationLevel;
  if (channelConfig.pairing) {
    await preloadPairedUsers(pairingService, channelType, mgr, pairingCls);
  }
  const rateLimiter = channelConfig.nonOwnerRateLimit
    ? createUserRateLimiter(channelConfig.nonOwnerRateLimit)
    : undefined;
  channelStates.set(channelType, {
    userSessions: mgr,
    adapter: channelConfig.adapter,
    channelName: channelConfig.channelName,
    respondToUnclassified: channelConfig.respondToUnclassified ?? true,
    pairing: channelConfig.pairing ?? false,
    pairingClassification: pairingCls,
    rateLimiter,
  });
}

// ─── Channel message routing ────────────────────────────────────────────────

/** Route a channel message to the owner or non-owner turn handler. */
async function routeChannelMessage(
  state: ChatSessionMutableState,
  orchestrator: Orchestrator,
  getSession: () => SessionState,
  ownerTargetClassification: ClassificationLevel,
  channelStates: Map<string, ChannelState>,
  pairingService: ChatSessionConfig["pairingService"],
  msg: ChannelMessage,
  channelType: string,
  signal?: AbortSignal,
): Promise<void> {
  const channelState = channelStates.get(channelType);
  if (!channelState) {
    chatLog.error("Channel config not registered for routing", {
      operation: "routeChannelMessage",
      channelType,
    });
    return;
  }

  if (msg.isOwner !== false) {
    return runOwnerAgentTurn(
      state,
      orchestrator,
      getSession,
      msg.content,
      ownerTargetClassification,
      buildSendEvent(channelState.adapter, channelState.channelName, msg),
      signal,
    );
  }

  const senderId = msg.senderId ?? "";

  // Per-user rate limiting for non-owner senders
  const effectiveSenderId = senderId || "unknown";
  if (channelState.rateLimiter && !channelState.rateLimiter.isAllowed(effectiveSenderId)) {
    chatLog.warn("Rate limit exceeded for non-owner sender", {
      operation: "routeChannelMessage",
      channelType,
      senderId: effectiveSenderId,
    });
    return;
  }

  const allowed = await checkNonOwnerAccess(
    msg,
    channelType,
    senderId,
    channelState,
    pairingService,
  );
  if (!allowed) return;

  await runNonOwnerAgentTurn(
    state,
    orchestrator,
    msg,
    channelType,
    channelState,
    signal,
  );
}

// ─── History compaction ─────────────────────────────────────────────────────

/** Compact conversation history and emit status events. */
async function compactChatHistory(
  orchestrator: Orchestrator,
  getSession: () => SessionState,
  sendEvent: ChatEventSender,
): Promise<void> {
  sendEvent({ type: "compact_start" });
  try {
    const result = await orchestrator.compactHistory(getSession().id);
    sendEvent({
      type: "compact_complete",
      messagesBefore: result.messagesBefore,
      messagesAfter: result.messagesAfter,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });
  } catch (err: unknown) {
    sendEvent({
      type: "error",
      message: `Compact failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

// ─── Secret prompt helpers ──────────────────────────────────────────────────

/** Resolve a pending secret prompt by nonce. */
function resolveSecretPrompt(
  pendingSecretPrompts: Map<string, (value: string | null) => void>,
  nonce: string,
  value: string | null,
): void {
  const resolve = pendingSecretPrompts.get(nonce);
  if (resolve) {
    pendingSecretPrompts.delete(nonce);
    resolve(value);
  }
}

/** Create a secret prompt callback for Tidepool mode. */
function buildTidepoolSecretPrompt(
  pendingSecretPrompts: Map<string, (value: string | null) => void>,
  sendEvent: ChatEventSender,
): (name: string, hint?: string) => Promise<string | null> {
  return (name, hint) => {
    const nonce = crypto.randomUUID();
    return new Promise<string | null>((resolve) => {
      pendingSecretPrompts.set(nonce, resolve);
      sendEvent(
        hint !== undefined
          ? { type: "secret_prompt", nonce, name, hint }
          : { type: "secret_prompt", nonce, name },
      );
    });
  };
}

// ─── createChatSession ──────────────────────────────────────────────────────

/**
 * Create a chat session that owns the orchestrator and serializes access.
 *
 * The orchestrator's `onEvent` callback forwards events to whichever
 * client is currently being served. A promise-chain mutex ensures only
 * one message is processed at a time.
 *
 * Taint closures are session-aware: an `activeSessionId` ref determines
 * which session's taint is read/written. For owner messages it points to
 * the owner session; for non-owner messages it points to the user session.
 * The mutex guarantees no concurrent access.
 */
export function createChatSession(config: ChatSessionConfig): ChatSession {
  const ownerSessionId = config.session.id as string;
  const ownerTargetClassification = config.targetClassification ??
    "INTERNAL" as ClassificationLevel;
  const channelStates = new Map<string, ChannelState>();
  const pairingService = config.pairingService;
  const ownerGetTaint = config.getSessionTaint;
  const ownerEscalateTaint = config.escalateTaint;

  const state: ChatSessionMutableState = {
    activeSend: null,
    activeSessionId: ownerSessionId,
    activeNonOwnerCeiling: null,
    mutex: Promise.resolve(),
    ownerSessionId,
    sessionStates: new Map<string, SessionState>([
      [ownerSessionId, config.session],
    ]),
  };

  const getSessionTaint = (): ClassificationLevel =>
    resolveSessionTaint(state, ownerGetTaint);

  const escalateTaint = (level: ClassificationLevel, reason: string): void =>
    applyTaintEscalation(
      state,
      level,
      reason,
      ownerGetTaint,
      ownerEscalateTaint,
    );

  const orchestratorConfig = assembleOrchestratorConfig(
    config,
    state,
    getSessionTaint,
    escalateTaint,
  );
  const orchestrator = createOrchestrator(orchestratorConfig);

  const initialSession = config.session;
  const getSession = (): SessionState =>
    config.getSession?.() ?? initialSession;
  const providerName = config.providerRegistry.getDefault()?.name ?? "unknown";
  const modelName = config.primaryModelName ??
    config.providerRegistry.getDefault()?.name ?? "unknown";
  const pendingSecretPrompts = new Map<
    string,
    (value: string | null) => void
  >();

  let mcpStatusConnected = -1;
  let mcpStatusConfigured = 0;

  return {
    executeAgentTurn: (content, sendEvent, signal) =>
      runOwnerAgentTurn(
        state,
        orchestrator,
        getSession,
        content,
        ownerTargetClassification,
        sendEvent,
        signal,
      ),
    registerChannel: (channelType, channelConfig) =>
      registerChannelState(
        channelStates,
        pairingService,
        channelType,
        channelConfig,
      ),
    handleChannelMessage: (msg, channelType, signal) =>
      routeChannelMessage(
        state,
        orchestrator,
        getSession,
        ownerTargetClassification,
        channelStates,
        pairingService,
        msg,
        channelType,
        signal,
      ),
    clear() {
      orchestrator.clearHistory(getSession().id);
      if (config.resetSession) config.resetSession();
    },
    compact: (sendEvent) =>
      compactChatHistory(orchestrator, getSession, sendEvent),
    handleSecretPromptResponse: (nonce, value) =>
      resolveSecretPrompt(pendingSecretPrompts, nonce, value),
    createTidepoolSecretPrompt: (sendEvent) =>
      buildTidepoolSecretPrompt(pendingSecretPrompts, sendEvent),
    getMcpStatus() {
      if (mcpStatusConnected < 0 || mcpStatusConfigured === 0) return null;
      return { connected: mcpStatusConnected, configured: mcpStatusConfigured };
    },
    setMcpStatus(connected, configured) {
      mcpStatusConnected = connected;
      mcpStatusConfigured = configured;
    },
    get providerName() {
      return providerName;
    },
    get modelName() {
      return modelName;
    },
    get sessionTaint() {
      return getSessionTaint();
    },
  };
}
