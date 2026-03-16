/**
 * Chat session factory — creates and returns the ChatSession interface.
 *
 * Owns the shared orchestrator and serializes access via a processing
 * mutex. Both CLI (via gateway WebSocket) and Tidepool (via browser
 * WebSocket) call into the same ChatSession instance.
 *
 * Types and interfaces live in `chat_types.ts`.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import { createOrchestrator } from "../agent/orchestrator/orchestrator.ts";
import type { SessionState } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type {
  ChatEventSender,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";
import type { ChatHistoryEntry } from "./chat_session_interface.ts";
import { loadChatHistoryEntries } from "./chat_history.ts";

import {
  applyTaintEscalation,
  assembleOrchestratorConfig,
  orchestrateOwnerAgentTurn,
  resolveSessionTaint,
} from "./chat_turn_execution.ts";
import type { ChatSessionMutableState } from "./chat_turn_execution.ts";
import {
  buildTidepoolCredentialPrompt,
  buildTidepoolSecretPrompt,
  resolveCredentialPrompt,
  resolveSecretPrompt,
} from "./chat_prompt_helpers.ts";
import type { CredentialResult } from "./chat_prompt_helpers.ts";
import { acceptTriggerResult } from "./chat_trigger_helpers.ts";
import {
  type ChannelState,
  registerChannelState,
  routeChannelMessage,
} from "./chat_channel_routing.ts";
// ─── Barrel re-exports from chat_types.ts ───────────────────────────────────

export type {
  ChannelClassificationConfig,
  ChannelRegistrationConfig,
  ChatClientMessage,
  ChatEvent,
  ChatEventSender,
  ChatHistoryEntry,
  ChatSession,
  ChatSessionConfig,
} from "./chat_types.ts";

export { buildSendEvent } from "./chat_event_sender.ts";

const chatLog = createLogger("chat");

/** Compact conversation history and emit status events. */
async function compactChatHistory(
  orchestrator: ReturnType<typeof createOrchestrator>,
  getSession: () => SessionState,
  sendEvent: ChatEventSender,
  config: ChatSessionConfig,
): Promise<void> {
  sendEvent({ type: "compact_start" });
  try {
    const result = await orchestrator.compactHistory(getSession().id);

    if (config.messageStore && result.messagesAfter > 0) {
      const sessionId = getSession().id as string;
      const sessionTaint = config.getSessionTaint?.() ??
        "PUBLIC" as ClassificationLevel;
      // Mark all prior records as compacted
      await config.messageStore.markCompacted(
        sessionId,
        0,
        result.messagesBefore - 1,
      );
      await config.messageStore.append({
        session_id: sessionId,
        role: "compaction_summary",
        content:
          `[Compaction] ${result.messagesBefore} → ${result.messagesAfter} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens`,
        classification: sessionTaint,
      });
    }

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

/**
 * Create a chat session that owns the orchestrator and serializes access.
 *
 * The orchestrator's `onEvent` callback forwards events to whichever
 * client is currently being served. A promise-chain mutex ensures only
 * one message is processed at a time.
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
  const pendingCredentialPrompts = new Map<
    string,
    (value: CredentialResult | null) => void
  >();

  let mcpStatusConnected = -1;
  let mcpStatusConfigured = 0;

  return {
    executeAgentTurn: (content, sendEvent, signal) =>
      orchestrateOwnerAgentTurn(
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
        config.isOwnerTurnRef,
      ),
    clear() {
      orchestrator.clearHistory(getSession().id);
      if (config.resetSession) config.resetSession();
      if (config.broadcastChatEvent) {
        config.broadcastChatEvent({
          type: "taint_changed",
          level: "PUBLIC" as ClassificationLevel,
        });
      }
    },
    compact: (sendEvent) =>
      compactChatHistory(orchestrator, getSession, sendEvent, config),
    handleTriggerPromptResponse(source, accepted, sendEvent) {
      if (!accepted) {
        chatLog.debug("Trigger prompt declined", {
          operation: "handleTriggerPromptResponse",
          source,
        });
        return Promise.resolve();
      }
      return acceptTriggerResult({
        source,
        config,
        state,
        orchestrator,
        getSession,
        ownerTargetClassification,
        sendEvent,
      });
    },
    handleSecretPromptResponse: (nonce, value) =>
      resolveSecretPrompt(pendingSecretPrompts, nonce, value),
    handleCredentialPromptResponse: (nonce, username, password) =>
      resolveCredentialPrompt(
        pendingCredentialPrompts,
        nonce,
        username,
        password,
      ),
    createTidepoolSecretPrompt: (sendEvent) =>
      buildTidepoolSecretPrompt(pendingSecretPrompts, sendEvent),
    createTidepoolCredentialPrompt: (sendEvent) =>
      buildTidepoolCredentialPrompt(pendingCredentialPrompts, sendEvent),
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
    get workspacePath() {
      return config.getWorkspacePath?.() ?? config.workspacePath ?? "";
    },
    get sessionTaint() {
      return getSessionTaint();
    },
    toggleBumpers() {
      if (config.toggleSessionBumpers) return config.toggleSessionBumpers();
      return false;
    },
    get bumpersEnabled() {
      return config.getBumpersEnabled?.() ?? true;
    },
    loadChatHistory(): Promise<readonly ChatHistoryEntry[]> {
      if (!config.messageStore) return Promise.resolve([]);
      return loadChatHistoryEntries(config.messageStore, ownerSessionId);
    },
  };
}
