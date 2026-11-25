/**
 * ChatSession interface — the shared session that serializes orchestrator access.
 *
 * Defines the public contract for the chat session, including message routing,
 * secret/credential prompts, trigger handling, and MCP status.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { MessageContent } from "../core/image/content.ts";
import type { ChannelMessage } from "../channels/types.ts";
import type { ChatEventSender } from "../core/types/chat_event.ts";
import type { ChatHistoryWireEntry } from "../core/types/chat_event.ts";
import type { SideQuestionService } from "./side_question.ts";

import type { ChannelRegistrationConfig } from "./chat_session_config.ts";

/**
 * Wire-format chat history entry sent to clients on reconnect.
 *
 * @deprecated Use `ChatHistoryWireEntry` from `core/types/chat_event.ts` directly.
 */
export type ChatHistoryEntry = ChatHistoryWireEntry;

/** Shared chat session that serializes access to the orchestrator. */
export interface ChatSession {
  readonly sideQuestions?: SideQuestionService;
  readonly sentinelSnapshotPath?: string;
  readonly resolveSentinelChatCase?: (caseId: string) => string | undefined;
  readonly sentinelWebContainmentConfigured?: boolean;
  readonly readSentinelOutputLanguage?: (
    path: string,
  ) =>
    | import("../sentinel/report_language.ts").SentinelReportLanguage
    | undefined;
  readonly createSentinelAgent?: (
    worker?: boolean,
    caseSnapshotPath?: string,
  ) => ReturnType<typeof import("./sentinel_agent.ts").createSentinelAgent>;
  readonly clearForSentinelMode?: () => Promise<void>;
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
  registerChannel(
    channelType: string,
    config: ChannelRegistrationConfig,
  ): Promise<void>;
  /**
   * Route a channel message to the correct session.
   *
   * Owner messages (`msg.isOwner === true`) use the main daemon session.
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
  /** Workspace directory path for display in client banners. */
  readonly workspacePath: string;
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
   * Route a `credential_prompt_response` from the Tidepool browser client to the
   * waiting `secret_save_credential` tool executor.
   *
   * @param nonce - The nonce from the originating `credential_prompt` event.
   * @param username - The entered username, or null if the user cancelled.
   * @param password - The entered password, or null if the user cancelled.
   */
  handleCredentialPromptResponse(
    nonce: string,
    username: string | null,
    password: string | null,
  ): void;
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
  createTidepoolSecretPrompt(
    sendEvent: ChatEventSender,
  ): (name: string, hint?: string) => Promise<string | null>;
  /**
   * Create a `CredentialPromptCallback` suitable for use with `createSecretToolExecutor`
   * in Tidepool mode.
   *
   * When called, the callback sends a `credential_prompt` WebSocket event and awaits
   * the corresponding `credential_prompt_response` from the browser.
   *
   * @param sendEvent - The function that sends events to the active WebSocket client.
   * @returns A CredentialPromptCallback that resolves when the browser responds.
   */
  createTidepoolCredentialPrompt(
    sendEvent: ChatEventSender,
  ): (
    name: string,
    hint?: string,
  ) => Promise<{ readonly username: string; readonly password: string } | null>;
  /**
   * Route a `confirm_prompt_response` from the client to the
   * waiting daemon_manage (or other) tool executor.
   *
   * @param nonce - The nonce from the originating `confirm_prompt` event.
   * @param approved - Whether the user approved (true) or denied (false).
   */
  handleConfirmPromptResponse(nonce: string, approved: boolean): void;
  /**
   * Create a confirm prompt callback for Tidepool mode.
   *
   * When called, sends a `confirm_prompt` WebSocket event and awaits
   * the corresponding `confirm_prompt_response` from the browser.
   *
   * @param sendEvent - The function that sends events to the active WebSocket client.
   * @returns A callback that resolves to true (approved) or false (denied).
   */
  createTidepoolConfirmPrompt(
    sendEvent: ChatEventSender,
  ): (message: string) => Promise<boolean>;
  /**
   * Handle a trigger_prompt_response from the client.
   *
   * On accept: retrieves the trigger result, handles classification
   * (session reset for write-down, taint escalation for write-up),
   * and injects the formatted trigger output as a user message.
   *
   * On decline: logs and takes no action.
   *
   * @param source - The trigger source identifier
   * @param accepted - Whether the user accepted (true) or dismissed (false)
   * @param sendEvent - Event sender for the accepting client's socket
   */
  handleTriggerPromptResponse(
    source: string,
    accepted: boolean,
    sendEvent: ChatEventSender,
  ): Promise<void>;
  /**
   * Get the last known MCP server connection status for sending to new clients.
   * Returns null if MCP status has not been set yet (no MCP servers configured).
   */
  getMcpStatus?: () => {
    readonly connected: number;
    readonly configured: number;
  } | null;
  /**
   * Update the stored MCP server connection status.
   * Called by the daemon when MCP connection state changes.
   */
  setMcpStatus?: (connected: number, configured: number) => void;
  /** Toggle bumpers on/off and return the new enabled state. */
  toggleBumpers(): boolean;
  /** Read whether bumpers are currently enabled. */
  readonly bumpersEnabled: boolean;
  /**
   * Load persisted chat history for session restoration on browser refresh.
   * Returns active (non-compacted, within resume window) messages mapped
   * to the wire format consumed by Tidepool clients.
   */
  loadChatHistory(): Promise<readonly ChatHistoryEntry[]>;
}
