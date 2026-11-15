/**
 * Orchestrator interface and related message-processing types.
 *
 * Extracted into core so that scheduler/ and other modules can depend
 * on the Orchestrator contract without importing from agent/.
 *
 * @module
 */

import type { ClassificationLevel, Result } from "./classification.ts";
import type { SessionId, SessionState } from "./session.ts";
import type { MessageContent } from "../image/content.ts";

/** Options for processing a single message. */
export interface ProcessMessageOptions {
  readonly session: SessionState;
  readonly message: MessageContent;
  readonly targetClassification: ClassificationLevel;
  /** Optional signal to abort the operation. */
  readonly signal?: AbortSignal;
}

/** Successful response from message processing. */
export interface ProcessMessageResult {
  readonly response: string;
  /** Cumulative token usage across all LLM calls made during this message turn. */
  readonly tokenUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

/** A conversation history entry. */
export interface HistoryEntry {
  readonly role: string;
  readonly content: MessageContent;
  /**
   * Native tool calls emitted by the assistant on this turn.
   *
   * Preserved verbatim from the provider response so the model sees its
   * own tool calls (with original IDs) when the history is replayed on
   * subsequent turns. OpenAI Chat Completions requires this field on the
   * assistant message that triggered tool execution — omitting it breaks
   * the call/result pairing and causes models like Kimi K2.5 to repeat
   * calls or go off-rails.
   */
  readonly tool_calls?: readonly unknown[];
  /**
   * Tool-call ID this message is a result for. Present only on
   * `role: "tool"` messages, paired with a `tool_calls[].id` from a
   * preceding assistant message.
   */
  readonly tool_call_id?: string;
  /**
   * Reasoning/thinking text the model produced on this assistant turn.
   *
   * Only the most recent assistant turn's reasoning is replayed to the
   * provider; older turns are stripped at the API boundary. See
   * `agent/providers/reasoning_history.ts` for the rule and why it holds
   * across every reasoning model.
   */
  readonly reasoning?: string;
  /**
   * Provider-native reasoning blocks for this assistant turn. Replayed
   * verbatim by providers that sign them (Anthropic); ignored by the
   * OpenAI-compatible providers, which use `reasoning` instead.
   */
  readonly reasoningBlocks?: readonly unknown[];
}

/** Result of conversation compaction. */
export interface CompactResult {
  /** Number of messages before compaction. */
  readonly messagesBefore: number;
  /** Number of messages after compaction. */
  readonly messagesAfter: number;
  /** Estimated tokens before compaction. */
  readonly tokensBefore: number;
  /** Estimated tokens after compaction. */
  readonly tokensAfter: number;
}

/** The orchestrator interface for processing messages. */
export interface Orchestrator {
  /** Process a user message through the full agent loop. */
  executeAgentTurn(
    options: ProcessMessageOptions,
  ): Promise<Result<ProcessMessageResult, string>>;
  /** Get conversation history for a session. */
  getHistory(sessionId: SessionId): readonly HistoryEntry[];
  /** Clear conversation history for a session. */
  clearHistory(sessionId: SessionId): void;
  /** Force LLM-based summarization of a session's history. */
  compactHistory(sessionId: SessionId): Promise<CompactResult>;
}
