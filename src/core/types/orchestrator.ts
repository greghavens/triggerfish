import type { LlmProviderRegistry } from "./llm.ts";
import type { ExecutionTraceApprovedPayload } from "../execution_traces.ts";
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

/** Unresolved provider arguments supplied to trusted recovery hooks. */
export interface RecoveryToolCall {
  readonly name: string;
  readonly id?: string;
  readonly args: Record<string, unknown>;
  readonly malformed?: true;
}

export interface SavedWorkflowReadDestination {
  readonly url: string;
  readonly caseId: string;
  readonly repository: string;
  readonly workflowId: number;
  readonly evidenceRevision: number;
  readonly taskId: string;
}

/** Root policy checks for an exact underlying saved read. These never dispatch. */
export interface SavedSourceAuthorization {
  readonly signal?: AbortSignal;
  authorizeWorkflowDestination(
    destination: SavedWorkflowReadDestination,
  ): Promise<boolean>;
  authorizeSavedCall(
    call: RecoveryToolCall,
    classification: ClassificationLevel,
  ): Promise<boolean>;
  authorizeSavedResponse(
    name: string,
    text: string,
    classification: ClassificationLevel,
  ): Promise<boolean>;
}

/** Trusted projection for tool data allowed to enter outputs or durable traces. */
export interface RecoveryToolPersistence {
  /** Prepare the durable record. Root policy must pass again before committing it. */
  readonly beforeAuthorizedDispatch?: (
    call: RecoveryToolCall,
    approvedRuleId?: string,
  ) => (() => void) | undefined | Promise<(() => void) | undefined>;
  /** Check an exact replay receipt against the currently applicable approval rule. */
  readonly acceptsSavedApproval?: (
    call: RecoveryToolCall,
    ruleId: string,
  ) => boolean;
  readonly projectCall: (
    call: RecoveryToolCall,
  ) => Record<string, unknown> | undefined;
  readonly projectResult: (
    call: RecoveryToolCall,
    result: { readonly text: string; readonly blocked: boolean },
  ) => string | undefined;
  readonly projectTracePayload?: (
    call: RecoveryToolCall,
    projected: string,
  ) => ExecutionTraceApprovedPayload | undefined;
}

/** Internal execution boundaries exposed to a trusted worker controller. */
export type WorkerBoundaryPhase =
  | "before_model"
  | "before_action"
  | "before_tool";

export interface WorkerBoundaryDecision {
  readonly stop?: true;
  readonly instructions?: readonly string[];
}

export type WorkerBoundary = (
  phase: WorkerBoundaryPhase,
) => WorkerBoundaryDecision | Promise<WorkerBoundaryDecision>;

/** Sanitized metadata for an actual root tool dispatch. */
export interface ToolDispatchOutcome {
  readonly tool: string;
  readonly approvedPayload?: ExecutionTraceApprovedPayload;
  readonly classification: ClassificationLevel;
  readonly outcome: "returned" | "blocked" | "failed";
}

/** Options for processing a single message. */
export interface ProcessMessageOptions {
  readonly session: SessionState;
  readonly message: MessageContent;
  readonly targetClassification: ClassificationLevel;
  /** Optional signal to abort the operation. */
  readonly signal?: AbortSignal;
  /** Validated internal checkpoint for resuming an interrupted turn. */
  readonly resume?: AgentTurnCheckpoint;
  /** Position of the exact initiating user message in trusted resumed history. */
  readonly resumeMessageIndex?: number;
  /** Trusted classification of the approved result frames in the checkpoint. */
  readonly resumeClassification?: ClassificationLevel;
  /** Canonical saved read requests to revalidate without invoking the tools. */
  readonly resumeToolCalls?: readonly (RecoveryToolCall & {
    readonly resultReceipt?: {
      readonly toolCallId: string;
      readonly sha256: string;
    };
  })[];
  /** Recheck saved source access after the root hooks authorize the checkpoint. */
  readonly authorizeResumeSources?: (
    signal?: AbortSignal,
    sourceAuthorization?: SavedSourceAuthorization,
  ) => Promise<boolean>;
  /** Mark the turn uncertain before dispatch, even for calls that cannot be checkpointed. */
  readonly beforeToolBatch?: (
    batch: number,
    calls: readonly RecoveryToolCall[],
  ) => Promise<void>;
  readonly toolPersistence?: RecoveryToolPersistence;
  readonly onToolDispatchOutcome?: (entry: ToolDispatchOutcome) => void;
  /** Return a typed checkpoint result after current call, response, and source authorization. */
  readonly onRestoredToolResult?: (
    entry: ToolDispatchOutcome,
    recordedAt: number,
  ) => void;
  /**
   * Apply trusted instructions before the next provider decision. Instructions
   * arriving before action invalidate the unexecuted provider response.
   * The per-tool boundary accepts stop decisions only.
   */
  readonly workerBoundary?: WorkerBoundary;
  /** Replace only completed-turn context after an authorized tool batch. */
  readonly refreshCommittedHistory?: (
    results: readonly {
      toolName: string;
      content: string;
      blocked?: boolean;
    }[],
    providers: LlmProviderRegistry,
  ) => Promise<readonly HistoryEntry[] | undefined>;
  /** Persist an entire tool batch before another provider call can begin. */
  readonly onToolBatchCheckpoint?: (
    checkpoint: AgentTurnCheckpoint,
  ) => Promise<void>;
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

/** Trusted continuation state after a complete assistant/tool exchange. */
export interface AgentTurnCheckpoint {
  readonly history: readonly HistoryEntry[];
  readonly completedIterations: number;
  readonly tokenUsage: ProcessMessageResult["tokenUsage"];
  readonly nudgeCount: number;
  readonly eosRetries: number;
  readonly toolCallCounts: readonly (readonly [string, number])[];
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
