/**
 * Session tool types, definitions, and system prompt.
 *
 * Consolidated from 7 to 5 tools:
 * - sessions_list (now includes session_status via optional session_id)
 * - sessions_history
 * - sessions_send (now includes message functionality via optional channel/recipient/text)
 * - sessions_spawn
 * - channels_list
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { ChannelAdapter } from "../../../channels/types.ts";
import type { EnhancedSessionManager } from "../../sessions.ts";
import type { PairingService } from "../../../channels/pairing.ts";

/** A registered channel adapter with its classification and metadata. */
export interface RegisteredChannel {
  /** The channel adapter instance. */
  readonly adapter: ChannelAdapter;
  /** The channel's classification level. */
  readonly classification: ClassificationLevel;
  /** Human-readable channel name. */
  readonly name: string;
}

/** Context required by session tool executors. */
export interface SessionToolContext {
  /** The enhanced session manager instance. */
  readonly sessionManager: EnhancedSessionManager;
  /** The caller's session ID (injected, not from LLM). */
  readonly callerSessionId: SessionId;
  /** The caller's taint level (injected, not from LLM). */
  readonly callerTaint: ClassificationLevel;
  /**
   * Live taint getter — returns current session taint (reflects escalation).
   * Falls back to callerTaint if not provided.
   */
  readonly getCallerTaint?: () => ClassificationLevel;
  /**
   * Registered channel adapters keyed by channel type (e.g. "signal", "telegram").
   * This is a mutable Map so channels can be registered after executor creation.
   */
  readonly channels?: Map<string, RegisteredChannel>;
  /** Pairing service for generating/verifying pairing codes. */
  readonly pairingService?: PairingService;
}

function buildSessionsListDef(): ToolDefinition {
  return {
    name: "sessions_list",
    description: "List all active sessions visible to the current session. " +
      "If session_id is provided, returns detailed status for that specific session.",
    parameters: {
      session_id: {
        type: "string",
        description:
          "Optional: get status for a specific session instead of listing all",
        required: false,
      },
    },
  };
}

function buildSessionsHistoryDef(): ToolDefinition {
  return {
    name: "sessions_history",
    description: "Get the message history for a session by ID.",
    parameters: {
      session_id: {
        type: "string",
        description: "The session ID to retrieve history for",
        required: true,
      },
    },
  };
}

function buildSessionsSendDef(): ToolDefinition {
  return {
    name: "sessions_send",
    description: "Send content to another session or a connected channel. " +
      "Subject to write-down enforcement.\n" +
      "- To send to a session: provide session_id and content.\n" +
      "- To send to a channel: provide channel, recipient, and text. " +
      "For Signal, the recipient is a phone number (E.164 format) or a group ID prefixed with 'group-'.",
    parameters: {
      session_id: {
        type: "string",
        description: "Target session ID (session-to-session send)",
        required: false,
      },
      content: {
        type: "string",
        description: "Message content (session-to-session send)",
        required: false,
      },
      channel: {
        type: "string",
        description:
          "Target channel type, e.g. 'signal', 'telegram' (channel send). Use channels_list to see connected channels.",
        required: false,
      },
      recipient: {
        type: "string",
        description:
          "Recipient identifier — phone number for Signal, chat ID for Telegram, etc. (channel send)",
        required: false,
      },
      text: {
        type: "string",
        description: "Message text (channel send)",
        required: false,
      },
    },
  };
}

function buildSessionsSpawnDef(): ToolDefinition {
  return {
    name: "sessions_spawn",
    description: "Spawn a new background session for an autonomous task. " +
      "The new session starts with independent PUBLIC taint.",
    parameters: {
      task: {
        type: "string",
        description: "Description of what the background session should do",
        required: true,
      },
    },
  };
}

function buildSessionTaintDef(): ToolDefinition {
  return {
    name: "current_session_taint",
    description:
      "Get the current session's classification taint level (PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED). " +
      "Taint escalates when classified data is accessed and can never decrease within a session.",
    parameters: {},
  };
}

function buildChannelsListDef(): ToolDefinition {
  return {
    name: "channels_list",
    description:
      "List all connected messaging channels with their type, classification, and connection status.",
    parameters: {},
  };
}

function buildSignalListGroupsDef(): ToolDefinition {
  return {
    name: "signal_list_groups",
    description:
      "List all Signal groups the account belongs to. Returns group IDs, names, and member counts. Only works when Signal is connected.",
    parameters: {},
  };
}

function buildSignalListContactsDef(): ToolDefinition {
  return {
    name: "signal_list_contacts",
    description:
      "List all known Signal contacts with their phone numbers and profile names. Only works when Signal is connected.",
    parameters: {},
  };
}

function buildSignalGeneratePairingDef(): ToolDefinition {
  return {
    name: "signal_generate_pairing",
    description: "Generate a 6-digit pairing code for Signal. " +
      "Give this code to someone so they can pair with your Signal number and chat with the agent. " +
      "The code expires after 5 minutes. Only works when Signal DM policy is 'pairing'.",
    parameters: {},
  };
}

/** Build session tool definitions for the agent orchestrator (excludes Signal). */
export function buildSessionToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildSessionsListDef(),
    buildSessionsHistoryDef(),
    buildSessionsSendDef(),
    buildSessionsSpawnDef(),
    buildSessionTaintDef(),
    buildChannelsListDef(),
  ];
}

/** @deprecated Use buildSessionToolDefinitions instead */
export const getSessionToolDefinitions = buildSessionToolDefinitions;

/** Build Signal-specific tool definitions (separate group for conditional loading). */
export function buildSignalToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildSignalListGroupsDef(),
    buildSignalListContactsDef(),
    buildSignalGeneratePairingDef(),
  ];
}

/** @deprecated Use buildSignalToolDefinitions instead */
export const getSignalToolDefinitions = buildSignalToolDefinitions;

/** System prompt section explaining session tools to the LLM. */
export const SESSION_TOOLS_SYSTEM_PROMPT = `## Session & Channel Management

Write-down enforcement applies to all cross-session and cross-channel communication:
you cannot send data to a channel or session whose classification is lower than your current session taint.

- \`current_session_taint\`: check your current classification taint level (PUBLIC → INTERNAL → CONFIDENTIAL → RESTRICTED)
- \`sessions_list\`: list all sessions, or pass session_id for one session's status
- \`sessions_send\`: send to a session (session_id + content) or channel (channel + recipient + text)
- \`sessions_spawn\`: create background sessions for autonomous tasks (starts at PUBLIC taint)
- \`channels_list\`: discover connected channels before sending messages

For Signal: use signal_list_contacts/signal_list_groups to find recipients, signal_generate_pairing to onboard new contacts.`;
