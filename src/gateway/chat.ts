/**
 * Chat session handler for the daemon.
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
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import { createOrchestrator } from "../agent/orchestrator.ts";
import type {
  OrchestratorEvent,
  OrchestratorEventCallback,
  ToolDefinition,
  ToolExecutor,
} from "../agent/orchestrator.ts";
import type { SecretStore } from "../secrets/keychain.ts";
import type { LlmProviderRegistry, LlmProvider } from "../agent/llm.ts";
import type { PlanManager } from "../agent/plan.ts";
import type { HookRunner } from "../core/policy/hooks.ts";
import type { PathClassifier } from "../core/security/path_classification.ts";
import type { DomainClassifier } from "../web/domains.ts";
import type { ToolFloorRegistry } from "../core/security/tool_floors.ts";
import type { SessionState } from "../core/types/session.ts";
import { updateTaint } from "../core/types/session.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { CompactorConfig } from "../agent/compactor.ts";
import type { MessageContent } from "../image/content.ts";
import type { ChannelAdapter, ChannelMessage } from "../channels/types.ts";
import {
  createUserSessionManager,
  parseUserOverrides,
} from "../channels/user_sessions.ts";
import type { UserSessionManager } from "../channels/user_sessions.ts";
import type { PairingService } from "../channels/pairing.ts";

const chatLog = createLogger("chat");

/** Events sent over the chat wire protocol. */
export type ChatEvent =
  | { readonly type: "connected"; readonly provider: string; readonly model: string; readonly taint?: ClassificationLevel }
  | { readonly type: "llm_start"; readonly iteration: number; readonly maxIterations: number }
  | {
    readonly type: "llm_complete";
    readonly iteration: number;
    readonly hasToolCalls: boolean;
  }
  | {
    readonly type: "tool_call";
    readonly name: string;
    readonly args: Record<string, unknown>;
  }
  | {
    readonly type: "tool_result";
    readonly name: string;
    readonly result: string;
    readonly blocked: boolean;
  }
  | { readonly type: "response"; readonly text: string }
  | { readonly type: "response_chunk"; readonly text: string; readonly done: boolean }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "vision_start"; readonly imageCount: number }
  | { readonly type: "vision_complete"; readonly imageCount: number }
  | { readonly type: "compact_start" }
  | {
    readonly type: "compact_complete";
    readonly messagesBefore: number;
    readonly messagesAfter: number;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
  }
  | { readonly type: "taint_changed"; readonly level: ClassificationLevel }
  | {
    /**
     * Server → client: MCP server connection status indicator.
     * Sent on new connection and whenever connection state changes.
     */
    readonly type: "mcp_status";
    /** Number of currently connected MCP servers. */
    readonly connected: number;
    /** Total number of configured (non-disabled) MCP servers. */
    readonly configured: number;
  }
  | {
    /**
     * Server → browser: request the user to securely enter a secret value.
     * The browser must show a password input form and respond with
     * `secret_prompt_response`.
     */
    readonly type: "secret_prompt";
    /** Unique nonce correlating this request with the response. */
    readonly nonce: string;
    /** The secret name being collected. */
    readonly name: string;
    /** Optional human-readable hint for the user. */
    readonly hint?: string;
  }
  /** Server → client: cancel acknowledged — the in-flight request was aborted. */
  | { readonly type: "cancelled" };

/** Messages the client can send. */
export type ChatClientMessage =
  | { readonly type: "message"; readonly content: MessageContent }
  | { readonly type: "cancel" }
  | { readonly type: "clear" }
  | { readonly type: "compact" }
  | {
    /**
     * Browser → server: the user has entered a secret value in the password
     * form triggered by a `secret_prompt` event.
     */
    readonly type: "secret_prompt_response";
    /** The nonce from the originating `secret_prompt` event. */
    readonly nonce: string;
    /** The secret value entered by the user, or null if cancelled. */
    readonly value: string | null;
  };

/** Callback to send a chat event to a specific client. */
export type ChatEventSender = (event: ChatEvent) => void;

/**
 * Per-channel classification config for non-owner user sessions.
 *
 * @deprecated Use ChannelRegistrationConfig instead.
 */
export interface ChannelClassificationConfig {
  /** Default classification ceiling for non-owner users on this channel. */
  readonly classification: ClassificationLevel;
  /** Optional per-user classification overrides keyed by platform-native ID. */
  readonly userClassifications?: Record<string, string>;
  /** Whether to respond to users not listed in userClassifications. Default: true. */
  readonly respondToUnclassified?: boolean;
}

/** Full channel registration config including adapter and access control. */
export interface ChannelRegistrationConfig {
  /** The channel adapter instance. */
  readonly adapter: ChannelAdapter;
  /** Human-readable channel name (e.g. "Signal", "Telegram"). */
  readonly channelName: string;
  /** Default classification ceiling for non-owner users on this channel. */
  readonly classification: ClassificationLevel;
  /** Optional per-user classification overrides keyed by platform-native ID. */
  readonly userClassifications?: Record<string, string>;
  /** Whether to respond to users not listed in userClassifications. Default: true. */
  readonly respondToUnclassified?: boolean;
  /** Whether pairing is required for this channel. Default: false. */
  readonly pairing?: boolean;
  /** Classification level assigned to paired users. Default: INTERNAL. */
  readonly pairingClassification?: ClassificationLevel;
}

/** Configuration for creating a ChatSession. */
export interface ChatSessionConfig {
  readonly hookRunner: HookRunner;
  readonly providerRegistry: LlmProviderRegistry;
  readonly spinePath?: string;
  readonly tools?: readonly ToolDefinition[];
  /** Live getter for extra tools resolved at each LLM call (e.g. MCP servers). */
  readonly getExtraTools?: () => readonly ToolDefinition[];
  /** Live getter for extra system prompt sections resolved at each LLM call (e.g. MCP servers). */
  readonly getExtraSystemPromptSections?: () => readonly string[];
  readonly toolExecutor?: ToolExecutor;
  readonly systemPromptSections?: readonly string[];
  readonly compactorConfig?: Partial<CompactorConfig>;
  readonly session: SessionState;
  readonly targetClassification?: ClassificationLevel;
  /** Plan manager for plan mode state tracking. */
  readonly planManager?: PlanManager;
  /** Enable streaming responses from the LLM provider. Default: true. */
  readonly enableStreaming?: boolean;
  /** Enable verbose logging of LLM responses to stderr. */
  readonly debug?: boolean;
  /** Vision-capable LLM provider for image fallback. */
  readonly visionProvider?: LlmProvider;
  /** Tool prefix → classification level. Enforced before every tool dispatch. */
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  /** Read current session taint for canFlowTo checks. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Escalate session taint after tool dispatch. */
  readonly escalateTaint?: (level: ClassificationLevel, reason: string) => void;
  /** Reset session state (taint back to PUBLIC). Called on /clear. */
  readonly resetSession?: () => void;
  /** Pairing service for verifying channel pairing codes. */
  readonly pairingService?: PairingService;
  /** Return the current owner session state (tracks taint reassignment in main.ts). */
  readonly getSession?: () => SessionState;
  /** Path classifier for filesystem tool security checks. */
  readonly pathClassifier?: PathClassifier;
  /** Domain classifier for URL-based tool security checks. */
  readonly domainClassifier?: DomainClassifier;
  /** Tool floor registry for minimum classification enforcement. */
  readonly toolFloorRegistry?: ToolFloorRegistry;
  /** Primary model identifier (e.g. "gpt-5.2-codex") for display. */
  readonly primaryModelName?: string;
  /**
   * Secret store for resolving `{{secret:name}}` references in tool arguments.
   * Passed through to the orchestrator for substitution below the LLM layer.
   */
  readonly secretStore?: SecretStore;
  /**
   * Callback invoked when a `secret_prompt` response arrives from the browser.
   * Used by the Tidepool WebSocket handler to route browser responses to the
   * waiting `secret_save` tool executor.
   */
  readonly onSecretPromptResponse?: (nonce: string, value: string | null) => void;
}

/** Internal per-channel state tracked by ChatSession. */
interface ChannelState {
  readonly userSessions: UserSessionManager;
  readonly adapter: ChannelAdapter;
  readonly channelName: string;
  readonly respondToUnclassified: boolean;
  readonly pairing: boolean;
  readonly pairingClassification: ClassificationLevel;
}

/** Shared chat session that serializes access to the orchestrator. */
export interface ChatSession {
  /** Process an owner message through the orchestrator. */
  processMessage(
    content: MessageContent,
    sendEvent: ChatEventSender,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Register a channel for routing through handleChannelMessage.
   *
   * Pre-loads paired senders from storage when pairing is enabled.
   * Must be called before `handleChannelMessage` for a given channel type.
   */
  registerChannel(channelType: string, config: ChannelRegistrationConfig): Promise<void>;
  /**
   * Route a channel message to the correct session.
   *
   * Owner messages (`msg.isOwner !== false`) use the main daemon session.
   * Non-owner messages pass through pairing and respondToUnclassified gates,
   * then get independent per-user sessions with classification ceilings
   * derived from the registered channel config.
   *
   * Builds the ChatEventSender internally from the registered adapter —
   * callers do not provide sendEvent.
   */
  handleChannelMessage(
    msg: ChannelMessage,
    channelType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Clear conversation history and reset session state. */
  clear(): void;
  /** Force LLM-based summarization of conversation history. */
  compact(sendEvent: ChatEventSender): Promise<void>;
  /** The name of the default LLM provider. */
  readonly providerName: string;
  /** The primary model identifier from config. */
  readonly modelName: string;
  /** Read the current owner session taint. */
  readonly sessionTaint: ClassificationLevel;
  /**
   * Route a `secret_prompt_response` from the Tidepool browser client to the
   * waiting `secret_save` tool executor.
   *
   * @param nonce - The nonce from the originating `secret_prompt` event.
   * @param value - The entered secret value, or null if the user cancelled.
   */
  handleSecretPromptResponse(nonce: string, value: string | null): void;
  /**
   * Create a `SecretPromptCallback` suitable for use with `createSecretToolExecutor`
   * in Tidepool mode.
   *
   * When called, the callback sends a `secret_prompt` WebSocket event to the
   * currently-active Tidepool client (via `sendEvent`) and awaits the
   * corresponding `secret_prompt_response` from the browser.
   *
   * @param sendEvent - The function that sends events to the active WebSocket client.
   * @returns A SecretPromptCallback that resolves when the browser responds.
   */
  createTidepoolSecretPrompt(sendEvent: ChatEventSender): (name: string, hint?: string) => Promise<string | null>;
  /**
   * Get the last known MCP server connection status for sending to new clients.
   * Returns null if MCP status has not been set yet (no MCP servers configured).
   */
  getMcpStatus?: () => { readonly connected: number; readonly configured: number } | null;
  /**
   * Update the stored MCP server connection status.
   * Called by the daemon when MCP connection state changes.
   */
  setMcpStatus?: (connected: number, configured: number) => void;
}

/**
 * Build a ChatEventSender for a channel adapter that handles typing
 * indicators, response sending, and error delivery.
 */
export function buildSendEvent(
  adapter: ChannelAdapter,
  channelName: string,
  msg: ChannelMessage,
): ChatEventSender {
  let typingInterval: number | undefined;

  return (event) => {
    if (event.type === "llm_start") {
      clearInterval(typingInterval);
      adapter.sendTyping?.(msg.sessionId ?? "").catch(() => {});
      typingInterval = setInterval(() => {
        adapter.sendTyping?.(msg.sessionId ?? "").catch(() => {});
      }, 4000) as unknown as number;
    }

    if (event.type === "tool_result" && event.blocked) {
      // A tool call was blocked (e.g. write-down: session taint > tool classification).
      // Notify the user directly so they see the reason — channels like Telegram do not
      // surface individual tool results the way Tidepool/webchat does via WebSocket events.
      adapter.send({
        content: event.result,
        sessionId: msg.sessionId,
      }).catch((err) => chatLog.warn(`${channelName} send error:`, err));
    }

    if (event.type === "response") {
      clearInterval(typingInterval);
      typingInterval = undefined;
      const text = event.text.trim();
      if (text.length > 0) {
        adapter.send({
          content: text,
          sessionId: msg.sessionId,
        }).catch((err) => chatLog.warn(`${channelName} send error:`, err));
      } else {
        chatLog.warn(`${channelName}: skipping empty response (LLM returned no text)`);
      }
    }

    if (event.type === "error") {
      clearInterval(typingInterval);
      typingInterval = undefined;
      adapter.send({
        content: `Error: ${event.message}`,
        sessionId: msg.sessionId,
      }).catch((err) => chatLog.warn(`${channelName} send error:`, err));
    }
  };
}

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
  // Mutable ref: set per-message, cleared after
  let activeSend: ChatEventSender | null = null;

  // --- Session-aware taint and classification tracking ---
  const ownerSessionId = config.session.id as string;
  let activeSessionId: string = ownerSessionId;
  const ownerTargetClassification = config.targetClassification ?? "INTERNAL" as ClassificationLevel;
  // Non-owner tool ceiling: null = no explicit classification = all tools blocked.
  let activeNonOwnerCeiling: ClassificationLevel | null = null;

  // Track all session states. Owner session is always present.
  const sessionStates = new Map<string, SessionState>();
  sessionStates.set(ownerSessionId, config.session);

  // Per-channel state, keyed by channelType.
  const channelStates = new Map<string, ChannelState>();

  const pairingService = config.pairingService;

  const ownerGetTaint = config.getSessionTaint;
  const ownerEscalateTaint = config.escalateTaint;

  function getSessionTaint(): ClassificationLevel {
    if (activeSessionId === ownerSessionId && ownerGetTaint) {
      return ownerGetTaint();
    }
    return sessionStates.get(activeSessionId)?.taint ?? "PUBLIC";
  }

  function escalateTaint(level: ClassificationLevel, reason: string): void {
    const prevTaint = getSessionTaint();
    if (activeSessionId === ownerSessionId && ownerEscalateTaint) {
      ownerEscalateTaint(level, reason);
    } else {
      const s = sessionStates.get(activeSessionId);
      if (s) {
        sessionStates.set(activeSessionId, updateTaint(s, level, reason));
      }
    }
    const newTaint = getSessionTaint();
    if (newTaint !== prevTaint && activeSend) {
      activeSend({ type: "taint_changed", level: newTaint });
    }
  }

  const onEvent: OrchestratorEventCallback = (event: OrchestratorEvent) => {
    if (activeSend) {
      activeSend(event as ChatEvent);
    }
  };

  const orchestrator = createOrchestrator({
    hookRunner: config.hookRunner,
    providerRegistry: config.providerRegistry,
    spinePath: config.spinePath,
    tools: config.tools,
    getExtraTools: config.getExtraTools,
    getExtraSystemPromptSections: config.getExtraSystemPromptSections,
    toolExecutor: config.toolExecutor,
    onEvent,
    compactorConfig: config.compactorConfig,
    systemPromptSections: config.systemPromptSections,
    planManager: config.planManager,
    enableStreaming: config.enableStreaming,
    debug: config.debug,
    visionProvider: config.visionProvider,
    toolClassifications: config.toolClassifications,
    getSessionTaint,
    escalateTaint,
    isOwnerSession: () => activeSessionId === ownerSessionId,
    getNonOwnerCeiling: () => activeNonOwnerCeiling,
    pathClassifier: config.pathClassifier,
    domainClassifier: config.domainClassifier,
    toolFloorRegistry: config.toolFloorRegistry,
    secretStore: config.secretStore,
  });

  const initialSession = config.session;
  function getSession(): SessionState {
    return config.getSession?.() ?? initialSession;
  }

  const providerName = config.providerRegistry.getDefault()?.name ?? "unknown";
  const modelName = config.primaryModelName ?? config.providerRegistry.getDefault()?.name ?? "unknown";

  // Registry of pending secret prompt requests from the Tidepool browser client.
  // Keyed by nonce; values are resolve functions from awaited Promises.
  const pendingSecretPrompts = new Map<string, (value: string | null) => void>();

  // Promise-chain mutex: each processMessage waits for the previous to finish
  let mutex: Promise<void> = Promise.resolve();

  async function processMessage(
    content: MessageContent,
    sendEvent: ChatEventSender,
    signal?: AbortSignal,
  ): Promise<void> {
    const prev = mutex;
    let resolve: () => void;
    mutex = new Promise<void>((r) => {
      resolve = r;
    });

    await prev;

    activeSend = sendEvent;
    activeSessionId = ownerSessionId;

    try {
      const result = await orchestrator.processMessage({
        session: getSession(),
        message: content,
        targetClassification: ownerTargetClassification,
        signal,
      });

      if (!result.ok && !signal?.aborted) {
        sendEvent({ type: "error", message: result.error });
      }
    } catch (err: unknown) {
      if (!signal?.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        sendEvent({ type: "error", message: msg });
      }
    } finally {
      activeSend = null;
      activeSessionId = ownerSessionId;

      resolve!();
    }
  }

  async function registerChannel(channelType: string, channelConfig: ChannelRegistrationConfig): Promise<void> {
    const mgr = createUserSessionManager({
      channelDefault: channelConfig.classification,
      userOverrides: parseUserOverrides(channelConfig.userClassifications),
    });

    const pairingCls = channelConfig.pairingClassification ?? "INTERNAL" as ClassificationLevel;

    // Pre-load paired users as classified users when pairing is enabled.
    if (channelConfig.pairing && pairingService) {
      try {
        const linkedUsers = await pairingService.getLinkedUsers(channelType);
        for (const userId of linkedUsers) {
          mgr.addClassification(userId, pairingCls);
        }
      } catch { /* ignore if prefix listing not supported */ }
    }

    channelStates.set(channelType, {
      userSessions: mgr,
      adapter: channelConfig.adapter,
      channelName: channelConfig.channelName,
      respondToUnclassified: channelConfig.respondToUnclassified ?? true,
      pairing: channelConfig.pairing ?? false,
      pairingClassification: pairingCls,
    });
  }

  async function handleChannelMessage(
    msg: ChannelMessage,
    channelType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const channelState = channelStates.get(channelType);
    if (!channelState) {
      chatLog.error(`No channel config registered for ${channelType}`);
      return;
    }

    // Owner messages → build sendEvent from adapter → main daemon session
    if (msg.isOwner !== false) {
      const sendEvent = buildSendEvent(channelState.adapter, channelState.channelName, msg);
      return processMessage(msg.content, sendEvent, signal);
    }

    const senderId = msg.senderId ?? "";
    const userSessions = channelState.userSessions;
    const hasClassification = userSessions.hasExplicitClassification(senderId || "unknown");

    // --- Unified access control gate ---
    if (!hasClassification) {
      // Try pairing if enabled (DMs only, 6-digit codes)
      if (channelState.pairing && senderId) {
        const isGroupMsg = msg.sessionId?.startsWith(`${channelType}-group-`) ?? false;
        if (!isGroupMsg) {
          const codeMatch = (msg.content ?? "").trim().match(/^\d{6}$/);
          if (codeMatch && pairingService) {
            const result = await pairingService.verifyCode(codeMatch[0], channelType, senderId);
            if (result.ok) {
              userSessions.addClassification(senderId, channelState.pairingClassification);
              await channelState.adapter.send({
                content: "Paired successfully. You can now chat with me.",
                sessionId: msg.sessionId,
              }).catch(() => {});
            }
            // Invalid/expired code: stay silent.
          }
        }
        // Pairing required, user not classified → drop
        return;
      }

      // No pairing, no classification → check respondToUnclassified
      if (!channelState.respondToUnclassified) {
        chatLog.warn(`[${channelType}] Dropping unclassified sender ${senderId} (respondToUnclassified=false)`);
        return;
      }
    }

    // Non-owner messages → per-user session
    const effectiveSenderId = senderId || "unknown";
    const userSession = userSessions.getOrCreate(channelType, effectiveSenderId);
    const userCls = userSessions.getClassification(effectiveSenderId);

    const sendEvent = buildSendEvent(channelState.adapter, channelState.channelName, msg);

    const prev = mutex;
    let resolve: () => void;
    mutex = new Promise<void>((r) => {
      resolve = r;
    });

    await prev;

    const userSessionId = userSession.id as string;
    sessionStates.set(userSessionId, userSession);
    activeSend = sendEvent;
    activeSessionId = userSessionId;
    activeNonOwnerCeiling = userSessions.hasExplicitClassification(effectiveSenderId)
      ? userSessions.getClassification(effectiveSenderId)
      : null;

    try {
      const result = await orchestrator.processMessage({
        session: userSession,
        message: msg.content,
        targetClassification: userCls,
        signal,
      });

      if (!result.ok && !signal?.aborted) {
        sendEvent({ type: "error", message: result.error });
      }
    } catch (err: unknown) {
      if (!signal?.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendEvent({ type: "error", message: errMsg });
      }
    } finally {
      // Persist potentially-escalated session back to the UserSessionManager
      const updated = sessionStates.get(userSessionId);
      if (updated) {
        userSessions.updateSession(channelType, effectiveSenderId, updated);
      }
      activeSend = null;
      activeSessionId = ownerSessionId;
      activeNonOwnerCeiling = null;
      resolve!();
    }
  }

  function clear(): void {
    orchestrator.clearHistory(getSession().id);
    if (config.resetSession) {
      config.resetSession();
    }
  }

  async function compact(sendEvent: ChatEventSender): Promise<void> {
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
      const msg = err instanceof Error ? err.message : String(err);
      sendEvent({ type: "error", message: `Compact failed: ${msg}` });
    }
  }

  function handleSecretPromptResponse(nonce: string, value: string | null): void {
    const resolve = pendingSecretPrompts.get(nonce);
    if (resolve) {
      pendingSecretPrompts.delete(nonce);
      resolve(value);
    }
  }

  function createTidepoolSecretPrompt(
    sendEvent: ChatEventSender,
  ): (name: string, hint?: string) => Promise<string | null> {
    return (name: string, hint?: string): Promise<string | null> => {
      const nonce = crypto.randomUUID();
      return new Promise<string | null>((resolve) => {
        pendingSecretPrompts.set(nonce, resolve);
        const promptEvent: ChatEvent = hint !== undefined
          ? { type: "secret_prompt", nonce, name, hint }
          : { type: "secret_prompt", nonce, name };
        sendEvent(promptEvent);
      });
    };
  }

  // Stored MCP status for sending to new clients on connect
  let mcpStatusConnected = -1;
  let mcpStatusConfigured = 0;

  return {
    processMessage,
    registerChannel,
    handleChannelMessage,
    clear,
    compact,
    handleSecretPromptResponse,
    createTidepoolSecretPrompt,
    getMcpStatus(): { connected: number; configured: number } | null {
      if (mcpStatusConnected < 0 || mcpStatusConfigured === 0) return null;
      return { connected: mcpStatusConnected, configured: mcpStatusConfigured };
    },
    setMcpStatus(connected: number, configured: number): void {
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
