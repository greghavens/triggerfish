/**
 * Agent loop types and debug logging helpers.
 *
 * Defines the context, outcome, and accumulator types used across
 * the agent loop modules, plus trace-level logging utilities.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import type {
  HistoryEntry,
  ProcessMessageResult,
  ToolDefinition,
} from "../orchestrator/orchestrator_types.ts";
import type {
  OrchestratorState,
  TokenAccumulator,
} from "../orchestrator/orchestrator.ts";
import type { LlmMessage } from "../llm.ts";

// ─── Debug logging ───────────────────────────────────────────────────────────

/** Minimal debug sink extracted from OrchestratorState. */
interface DebugSink {
  readonly orchLog: OrchestratorState["orchLog"];
  readonly debug: boolean;
}

/** Log to the structured logger at TRACE level. */
export function traceLog(
  sink: DebugSink,
  label: string,
  data: unknown,
): void {
  if (!sink.debug) return;
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const preview = str.length > 500
    ? str.slice(0, 500) + `... [${str.length} chars]`
    : str;
  sink.orchLog.trace(`${label}: ${preview}`);
}

/** Log first-iteration debug details (system prompt + history preview). */
export function logFirstIterationDetails(
  sink: DebugSink,
  systemPrompt: string,
  history: readonly HistoryEntry[],
): void {
  if (!sink.debug) return;
  sink.orchLog.trace(
    `=== SYSTEM PROMPT ===\n${systemPrompt}\n=== END SYSTEM PROMPT ===`,
  );
  for (const h of history) {
    const preview = typeof h.content === "string"
      ? h.content.slice(0, 100)
      : "(non-string)";
    sink.orchLog.trace(`history ${h.role}: ${preview}`);
  }
}

// ─── LLM message helpers ────────────────────────────────────────────────────

/** Build the LLM messages array from system prompt and history. */
export function buildLlmMessages(
  systemPrompt: string,
  history: readonly HistoryEntry[],
): LlmMessage[] {
  return [{ role: "system", content: systemPrompt }, ...history];
}

/** Resolve the live tool list for this iteration, applying skill and role filtering. */
export function resolveActiveToolList(
  state: OrchestratorState,
): readonly ToolDefinition[] {
  const allTools = state.getExtraTools
    ? [...state.baseTools, ...state.getExtraTools()]
    : state.baseTools;

  const afterSkill = applySkillFiltering(allTools, state);
  if (!state.config.filterTools) return afterSkill;
  const isOwner = state.config.isOwnerSession?.() ?? true;
  return state.config.filterTools(afterSkill, isOwner);
}

/** Apply skill-based tool filtering when an active skill context is present. */
function applySkillFiltering(
  tools: readonly ToolDefinition[],
  state: OrchestratorState,
): readonly ToolDefinition[] {
  const activeSkill = state.getActiveSkillContext?.() ?? null;
  if (!activeSkill || activeSkill.requiresTools === null) return tools;

  if (activeSkill.requiresTools.length === 0) {
    return tools.filter((t) => t.name === "read_skill");
  }

  const allowed = new Set(activeSkill.requiresTools);
  return tools.filter((t) => t.name === "read_skill" || allowed.has(t.name));
}

// ─── Tool call loop detection ─────────────────────────────────────────────────

/** Tracks repeated identical tool calls across loop iterations. */
export interface ToolCallHistory {
  /** Map of serialized tool-call key → invocation count. */
  readonly calls: Map<string, number>;
}

/** Threshold at which repeated tool calls trigger a loop nudge. */
export const TOOL_LOOP_THRESHOLD = 3;

/**
 * Serialize a tool call's name and arguments into a deterministic string key.
 *
 * Arguments are sorted by key name to ensure identical payloads with different
 * key ordering produce the same key.
 */
export function serializeToolCallKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

/**
 * Record tool calls and detect if any call has been repeated at or above the threshold.
 *
 * Mutates the history's call map. Returns true if a loop was detected.
 */
export function recordToolCallsAndDetectLoop(
  history: ToolCallHistory,
  calls: readonly {
    readonly name: string;
    readonly args: Record<string, unknown>;
  }[],
): boolean {
  let detected = false;
  for (const call of calls) {
    const key = serializeToolCallKey(call.name, call.args);
    const count = (history.calls.get(key) ?? 0) + 1;
    history.calls.set(key, count);
    if (count >= TOOL_LOOP_THRESHOLD) detected = true;
  }
  return detected;
}

// ─── Agent loop types ────────────────────────────────────────────────────────

/** Mutable nudge counter passed between iterations. */
export interface NudgeState {
  count: number;
}

/** Bundled context for a single agent loop iteration. */
export interface AgentLoopContext {
  readonly state: OrchestratorState;
  readonly session: SessionState;
  readonly systemPrompt: string;
  readonly history: HistoryEntry[];
  readonly sessionKey: string;
  readonly targetClassification: ClassificationLevel;
  readonly signal: AbortSignal | undefined;
  readonly tokens: TokenAccumulator;
  readonly nudge: NudgeState;
  readonly toolCallHistory: ToolCallHistory;
}

/** Result of a single agent loop iteration. */
export type IterationOutcome =
  | { action: "continue" }
  | { action: "return"; result: Result<ProcessMessageResult, string> }
  | { action: "force_text_only" };

/** Successful LLM iteration result. */
export interface LlmIterationResult {
  readonly completion: {
    content: string;
    toolCalls?: readonly unknown[];
    usage: { inputTokens: number; outputTokens: number };
    finishReason?: string;
  };
  readonly tools: readonly ToolDefinition[];
}

/** Result of calling the LLM in the agent loop: success with completion, or abort. */
export type LlmCallOutcome =
  | {
    ok: true;
    completion: LlmIterationResult["completion"];
    tools: LlmIterationResult["tools"];
  }
  | { ok: false; result: Result<ProcessMessageResult, string> };

/** Abort sentinel for cancelled operations. */
export const CANCELLED_RESULT: LlmCallOutcome = {
  ok: false,
  result: { ok: false, error: "Operation cancelled by user" },
};

// ─── Soft-limit helpers ──────────────────────────────────────────────────────

/** Compute the soft limit iteration from max iterations (80% of max). */
export function computeSoftLimit(maxIter: number): number {
  return Math.floor(maxIter * 0.8);
}

/** Inject soft limit warning into history when approaching max iterations. */
export function injectSoftLimitWarning(
  history: HistoryEntry[],
  iterations: number,
  maxIter: number,
): void {
  if (iterations !== computeSoftLimit(maxIter)) return;
  history.push({
    role: "user",
    content:
      `[SYSTEM] You have used many tool calls (${iterations}/${maxIter}). ` +
      `You have ${maxIter - iterations} remaining iterations. ` +
      "Please provide your best answer now based on the information gathered so far. " +
      "If you cannot find what you're looking for, say so rather than continuing to search.",
  });
}
