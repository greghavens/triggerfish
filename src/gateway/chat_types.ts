/**
 * Chat session types and wire protocol events.
 *
 * Defines the ChatEvent union, ChatClientMessage union, config
 * interfaces (ChatSessionConfig, ChannelRegistrationConfig), and
 * the ChatSession interface. Separated from the factory implementation
 * in `chat.ts` for lighter type-only imports.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { HookRunner } from "../core/policy/hooks/hooks.ts";
import type { SessionState } from "../core/types/session.ts";
import type { SecretStore } from "../core/secrets/keychain/keychain.ts";
import type { LlmProviderRegistry, LlmProvider } from "../core/types/llm.ts";
import type { PlanManager } from "../agent/plan/plan.ts";
import type { PathClassifier } from "../core/security/path_classification.ts";
import type { DomainClassifier } from "../core/types/domain.ts";
import type { ToolFloorRegistry } from "../core/security/tool_floors.ts";
import type { CompactorConfig } from "../agent/compactor/compactor.ts";
import type { ActiveSkillContext } from "../agent/orchestrator/orchestrator_types.ts";
import type { MessageContent } from "../core/image/content.ts";
import type { ChannelAdapter, ChannelMessage } from "../channels/types.ts";
import type { PairingService } from "../channels/pairing.ts";
import type {
  ToolDefinition,
  ToolExecutor,
} from "../core/types/tool.ts";

export type { ChatEvent, ChatClientMessage, ChatEventSender } from "../core/types/chat_event.ts";
import type { ChatEventSender } from "../core/types/chat_event.ts";

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
  /**
   * Optional per-user rate limiting for non-owner senders.
   * When set, individual senders exceeding maxRequests/windowMs are silently dropped.
   */
  readonly nonOwnerRateLimit?: {
    readonly maxRequests: number;
    readonly windowMs?: number;
  };
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
  /**
   * Returns the currently active skill context for tool filtering.
   * When non-null, the LLM tool list is filtered to the skill's requiresTools.
   */
  readonly getActiveSkillContext?: () => ActiveSkillContext | null;
}

/** Shared chat session that serializes access to the orchestrator. */
export interface ChatSession {
  /** Process an owner message through the orchestrator. */
  executeAgentTurn(
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
