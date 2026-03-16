/**
 * Agent turn — entry point and preconditions.
 *
 * Validates preconditions, prepares context (system prompt, history,
 * vision fallback), and delegates to the agent loop.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/mod.ts";
import type { SessionState } from "../../core/types/session.ts";
import type { MessageContent } from "../../core/image/content.ts";
import { extractText } from "../../core/image/content.ts";
import { countTokens } from "../compactor/compactor_tokens.ts";
import { buildFullSystemPrompt } from "../orchestrator/system_prompt.ts";
import { orchestrateVisionFallback } from "../orchestrator/vision_fallback.ts";
import { orchestrateAgentLoop } from "./agent_loop.ts";
import type {
  HistoryEntry,
  OrchestratorConfig,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import type { ConversationRecord } from "../../core/conversation/mod.ts";

const log = createLogger("agent-turn");

/** Fire PRE_CONTEXT_INJECTION hook. */
async function firePreContextHook(
  config: OrchestratorConfig,
  session: SessionState,
  message: MessageContent,
): Promise<Result<void, string>> {
  const result = await config.hookRunner.evaluateHook(
    "PRE_CONTEXT_INJECTION",
    {
      session,
      input: { content: extractText(message), source_type: "OWNER" },
    },
  );
  if (!result.allowed) {
    return { ok: false, error: result.message ?? "Input blocked by policy" };
  }
  return { ok: true, value: undefined };
}

/** Convert a ConversationRecord to a HistoryEntry for session restoration. */
function recordToHistoryEntry(record: ConversationRecord): HistoryEntry {
  switch (record.role) {
    case "user":
      return { role: "user", content: record.content };
    case "assistant":
      return { role: "assistant", content: record.content };
    case "compaction_summary":
      return {
        role: "user",
        content: `[CONTEXT SUMMARY]\n${record.content}`,
      };
    case "tool_call":
      return {
        role: "assistant",
        content: record.tool_args ? JSON.stringify(record.tool_args) : "",
      };
  }
}

/** Restore session history from MessageStore if history is empty. */
export async function restoreSessionHistoryIfEmpty(
  config: OrchestratorConfig,
  histories: Map<string, HistoryEntry[]>,
  sessionKey: string,
  sessionTaint: ClassificationLevel,
): Promise<void> {
  if (!config.messageStore) return;
  const existing = histories.get(sessionKey);
  if (existing && existing.length > 0) return;

  const records = await config.messageStore.loadActive(sessionKey);
  if (records.length === 0) return;

  // Check for compaction summary — if present, use only that
  const summaryRecord = records.find((r) => r.role === "compaction_summary");
  const toRestore = summaryRecord ? [summaryRecord] : records;

  const entries: HistoryEntry[] = [];
  for (const record of toRestore) {
    if (!canFlowTo(record.classification, sessionTaint)) {
      log.warn("Skipping record above current taint on restore", {
        operation: "restoreSessionHistoryIfEmpty",
        sessionId: sessionKey,
        recordClassification: record.classification,
        sessionTaint,
        sequence: record.sequence,
      });
      continue;
    }
    entries.push(recordToHistoryEntry(record));
    // Add tool result placeholder after tool_call entries
    if (record.role === "tool_call") {
      const toolName = record.tool_name ?? "unknown";
      const lineageRef = record.lineage_id
        ? ` — see lineage ${record.lineage_id}`
        : "";
      entries.push({
        role: "user",
        content:
          `[TOOL_RESULT name="${toolName}"]\n(result not available${lineageRef})\n[/TOOL_RESULT]`,
      });
    }
  }

  if (entries.length > 0) {
    histories.set(sessionKey, entries);
    log.info("Session history restored from message store", {
      operation: "restoreSessionHistoryIfEmpty",
      sessionId: sessionKey,
      recordCount: entries.length,
    });
  }
}

/** Get or create conversation history for a session. */
function ensureSessionHistory(
  histories: Map<string, HistoryEntry[]>,
  sessionKey: string,
): HistoryEntry[] {
  if (!histories.has(sessionKey)) {
    histories.set(sessionKey, []);
  }
  return histories.get(sessionKey)!;
}

/**
 * Update the compactor budget to match the provider selected for the
 * current session's taint level. This ensures auto-compaction thresholds
 * are based on the actual model's context window, not a global minimum.
 */
function alignCompactorBudgetToSession(state: OrchestratorState): void {
  const taint = state.config.getSessionTaint?.() ?? "PUBLIC";
  const override = state.config.providerRegistry.getForClassification(taint);
  const provider = override ?? state.config.providerRegistry.getDefault();
  log.debug("Compactor budget alignment for session taint", {
    operation: "alignCompactorBudgetToSession",
    taint,
    overrideFound: override !== undefined,
    providerName: provider?.name,
    contextWindow: provider?.contextWindow,
  });
  if (provider?.contextWindow) {
    state.compactor.updateBudget(provider.contextWindow);
  }
}

/** Auto-compact history if approaching context limits. */
function autoCompactHistory(
  history: HistoryEntry[],
  compactor: {
    compact(h: HistoryEntry[], t?: number): readonly HistoryEntry[];
  },
  systemPromptTokens: number,
): void {
  const compacted = compactor.compact(history, systemPromptTokens);
  if (compacted.length < history.length) {
    history.length = 0;
    history.push(...compacted);
  }
}

/** Persist a user message to the message store. */
async function persistUserMessage(
  config: OrchestratorConfig,
  sessionKey: string,
  message: MessageContent,
  sessionTaint: ClassificationLevel,
): Promise<void> {
  if (!config.messageStore) return;
  const text = extractText(message);
  await config.messageStore.append({
    session_id: sessionKey,
    role: "user",
    content: text,
    classification: sessionTaint,
    token_count: countTokens(text),
  });
}

/** Create a lineage record for a user message. */
async function recordUserMessageLineage(
  config: OrchestratorConfig,
  session: SessionState,
  message: MessageContent,
): Promise<void> {
  if (!config.lineageStore) return;
  const text = extractText(message);
  await config.lineageStore.create({
    content: text,
    origin: {
      source_type: "channel_message",
      source_name: session.channelId as string,
      accessed_at: new Date().toISOString(),
      accessed_by: session.userId as string,
      access_method: "user_input",
    },
    classification: {
      level: config.getSessionTaint?.() ?? session.taint,
      reason: "User message",
    },
    sessionId: session.id,
  });
}

/** Prepare system prompt, history, and vision fallback for the turn. */
async function prepareAgentTurnContext(
  state: OrchestratorState,
  session: SessionState,
  sessionKey: string,
  message: MessageContent,
  signal: AbortSignal | undefined,
): Promise<{ systemPrompt: string; history: HistoryEntry[] }> {
  const sessionTaint = state.config.getSessionTaint?.() ?? session.taint;
  await restoreSessionHistoryIfEmpty(
    state.config,
    state.histories,
    sessionKey,
    sessionTaint,
  );

  let systemPrompt = await buildFullSystemPrompt(state, sessionKey);
  const history = ensureSessionHistory(state.histories, sessionKey);
  history.push({ role: "user", content: message });

  // Persist user message and create lineage record (fire-and-forget safe)
  await persistUserMessage(state.config, sessionKey, message, sessionTaint);
  await recordUserMessageLineage(state.config, session, message);

  const visionAddendum = await orchestrateVisionFallback(
    state,
    message,
    history,
    signal,
  );
  if (visionAddendum) systemPrompt += visionAddendum;

  alignCompactorBudgetToSession(state);
  autoCompactHistory(history, state.compactor, countTokens(systemPrompt));
  return { systemPrompt, history };
}

/** Validate pre-conditions for an agent turn: run pre-context hook and verify provider. */
async function validateAgentTurnPreconditions(
  config: OrchestratorConfig,
  session: SessionState,
  message: MessageContent,
): Promise<Result<true, string>> {
  const hookResult = await firePreContextHook(config, session, message);
  if (!hookResult.ok) return hookResult;
  if (!config.providerRegistry.getDefault()) {
    return { ok: false, error: "No default LLM provider configured" };
  }
  return { ok: true, value: true };
}

/** Run the full agent turn loop. */
export async function orchestrateAgentTurn(
  state: OrchestratorState,
  options: ProcessMessageOptions,
): Promise<Result<ProcessMessageResult, string>> {
  const { session, message, targetClassification, signal } = options;
  const guard = await validateAgentTurnPreconditions(
    state.config,
    session,
    message,
  );
  if (!guard.ok) return guard;

  const sessionKey = session.id as string;
  const ctx = await prepareAgentTurnContext(
    state,
    session,
    sessionKey,
    message,
    signal,
  );
  return orchestrateAgentLoop({
    state,
    session,
    systemPrompt: ctx.systemPrompt,
    history: ctx.history,
    sessionKey,
    targetClassification,
    signal,
  });
}

/** @deprecated Use orchestrateAgentTurn instead */
export const runAgentTurn = orchestrateAgentTurn;
