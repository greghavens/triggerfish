import { createSavedSourceAuthorization } from "../dispatch/saved_source_authorization.ts";
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
import {
  canFlowTo,
  maxClassification,
  parseClassification,
} from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/mod.ts";
import type { SessionState } from "../../core/types/session.ts";
import type { MessageContent } from "../../core/image/content.ts";
import { extractText } from "../../core/image/content.ts";
import { countTokens } from "../compactor/compactor_tokens.ts";
import { buildFullSystemPrompt } from "../orchestrator/system_prompt.ts";
import { orchestrateVisionFallback } from "../orchestrator/vision_fallback.ts";
import { orchestrateAgentLoop } from "./agent_loop.ts";
import { expirePreviousTurnReasoning } from "../providers/reasoning_history.ts";
import type {
  AgentTurnCheckpoint,
  HistoryEntry,
  OrchestratorConfig,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "../orchestrator/orchestrator_types.ts";
import type { OrchestratorState } from "../orchestrator/orchestrator.ts";
import { MAX_TOOL_ITERATIONS } from "../orchestrator/orchestrator_types.ts";
import { wrapToolExecutorWithEnforcement } from "../dispatch/access_control.ts";
import {
  authorizeSavedToolCalls,
  authorizeSavedToolResponses,
} from "../dispatch/security_pipeline.ts";
import type { ConversationRecord } from "../../core/conversation/mod.ts";

const log = createLogger("agent-turn");

/** Fire PRE_CONTEXT_INJECTION hook. */
async function firePreContextHook(
  config: OrchestratorConfig,
  session: SessionState,
  message: MessageContent,
  protectPrompt = false,
): Promise<Result<void, string>> {
  // OWNER labeling requires a positive signal; anything else is NON_OWNER.
  const sourceType = config.isOwnerSession?.() === true ? "OWNER" : "NON_OWNER";
  const result = await config.hookRunner.evaluateHook(
    "PRE_CONTEXT_INJECTION",
    {
      session,
      input: { content: extractText(message), source_type: sourceType },
      ...(protectPrompt && { auditInput: { source_type: sourceType } }),
    },
  );
  if (!result.allowed) {
    log.warn("Pre-context injection blocked by policy", {
      operation: "firePreContextHook",
      sessionId: session.id,
      sourceType,
      ...(!protectPrompt && { reason: result.message }),
    });
    return {
      ok: false,
      error: protectPrompt
        ? "Input blocked by policy"
        : result.message ?? "Input blocked by policy",
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Convert a ConversationRecord to a HistoryEntry for session restoration.
 *
 * Returns null for `tool_call` records — those cannot be safely restored
 * because tool results live in the lineage store, not the message store,
 * so the original assistant→tool pairing cannot be reconstructed. The
 * caller filters out nulls.
 */
function recordToHistoryEntry(
  record: ConversationRecord,
): HistoryEntry | null {
  switch (record.role) {
    case "user":
      return { role: "user", content: record.content };
    case "assistant":
      // Assistant turns that requested tools are persisted for trace export
      // only. Their paired tool results are dropped on restore (see below),
      // so replaying the call would leave the model holding an unanswered
      // tool_calls block — which providers reject.
      if (record.tool_calls && record.tool_calls.length > 0) return null;
      return { role: "assistant", content: record.content };
    case "compaction_summary":
      return {
        role: "user",
        content: `[CONTEXT SUMMARY]\n${record.content}`,
      };
    case "tool_call":
      // Previously emitted the tool call as an assistant message followed by
      // a "(result not available)" placeholder. The model mimicked the
      // placeholder pattern on subsequent turns, so we now drop tool_call
      // records entirely on restore.
      return null;
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

  const records = (await config.messageStore.loadActive(sessionKey))
    .sort((left, right) => left.sequence - right.sequence);
  if (records.length === 0) return;

  const summary = records.findLast((record) =>
    record.role === "compaction_summary" && record.compaction &&
    canFlowTo(record.classification, sessionTaint)
  );
  const throughSequence = summary?.compaction?.throughSequence;
  const toRestore = summary && throughSequence !== undefined
    ? [
      summary,
      ...records.filter((record) =>
        record.role !== "compaction_summary" &&
        record.sequence > throughSequence
      ),
    ]
    : records.filter((record) =>
      record.role !== "compaction_summary" ||
      (!record.compaction && !record.content.startsWith("[Compaction]"))
    );

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
    const entry = recordToHistoryEntry(record);
    if (entry) entries.push(entry);
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
  resume: AgentTurnCheckpoint | undefined,
  protectPrompt: boolean,
): Promise<
  { systemPrompt: string; history: HistoryEntry[]; activeUser?: HistoryEntry }
> {
  if (resume) {
    const history = structuredClone([...resume.history]);
    if (!protectPrompt) state.histories.set(sessionKey, history);
    const systemPrompt = await buildFullSystemPrompt(state, sessionKey);
    alignCompactorBudgetToSession(state);
    return { systemPrompt, history };
  }
  const sessionTaint = state.config.getSessionTaint?.() ?? session.taint;
  await restoreSessionHistoryIfEmpty(
    state.config,
    state.histories,
    sessionKey,
    sessionTaint,
  );

  let systemPrompt = await buildFullSystemPrompt(state, sessionKey);
  const sessionHistory = ensureSessionHistory(state.histories, sessionKey);
  // Protected requests use their own checkpoint history for continuation.
  const history = protectPrompt
    ? structuredClone(sessionHistory)
    : sessionHistory;
  // A new user message ends the previous turn, and reasoning is only
  // meaningful within the turn that produced it.
  expirePreviousTurnReasoning(history);
  const activeUser: HistoryEntry = { role: "user", content: message };
  history.push(activeUser);

  if (!protectPrompt) {
    await persistUserMessage(state.config, sessionKey, message, sessionTaint);
    await recordUserMessageLineage(state.config, session, message);
  }

  const visionAddendum = await orchestrateVisionFallback(
    state,
    message,
    history,
    signal,
  );
  if (visionAddendum) systemPrompt += visionAddendum;

  alignCompactorBudgetToSession(state);
  autoCompactHistory(history, state.compactor, countTokens(systemPrompt));
  return { systemPrompt, history, activeUser };
}

/** Validate pre-conditions for an agent turn: run pre-context hook and verify provider. */
async function validateAgentTurnPreconditions(
  config: OrchestratorConfig,
  session: SessionState,
  message: MessageContent,
  protectPrompt = false,
): Promise<Result<true, string>> {
  let hookResult: Awaited<ReturnType<typeof firePreContextHook>>;
  try {
    hookResult = await firePreContextHook(
      config,
      session,
      message,
      protectPrompt,
    );
  } catch (error) {
    if (!protectPrompt) throw error;
    return {
      ok: false,
      error: "The protected input policy could not be checked.",
    };
  }
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
  const {
    session,
    message,
    targetClassification,
    signal,
    resume,
    resumeMessageIndex = 0,
    resumeClassification,
    resumeToolCalls,
    authorizeResumeSources,
    beforeToolBatch,
    toolPersistence,
    workerBoundary,
    onToolDispatchOutcome,
    refreshCommittedHistory,
    onToolBatchCheckpoint,
  } = options;
  const protectedResume = resumeClassification !== undefined ||
    resumeToolCalls !== undefined || authorizeResumeSources !== undefined;
  if (!protectedResume) {
    const guard = await validateAgentTurnPreconditions(
      state.config,
      session,
      message,
      toolPersistence !== undefined,
    );
    if (!guard.ok) return guard;
  }
  if (protectedResume && !resume) {
    return { ok: false, error: "Invalid agent turn checkpoint" };
  }
  if (
    resume &&
    (!Number.isSafeInteger(resumeMessageIndex) || resumeMessageIndex < 0 ||
      resume.history[resumeMessageIndex]?.role !== "user" ||
      typeof message !== "string" ||
      resume.history[resumeMessageIndex].content !== message ||
      !Number.isSafeInteger(resume.completedIterations) ||
      resume.completedIterations < 1 ||
      resume.completedIterations >
        (state.config.maxIterations ?? MAX_TOOL_ITERATIONS))
  ) return { ok: false, error: "Invalid agent turn checkpoint" };

  let turnState = state;
  let turnSession = session;
  let restoreTaint: (() => void) | undefined;
  if (resumeClassification !== undefined) {
    const required = parseClassification(resumeClassification);
    if (!required.ok) {
      return { ok: false, error: "Invalid checkpoint classification" };
    }
    const config = state.config;
    const current = maxClassification(
      config.getSessionTaint?.() ?? session.taint,
      session.taint,
    );
    let floor = maxClassification(required.value, current);
    if (
      !canFlowTo(floor, targetClassification) ||
      (floor !== current && config.checkBumpersBlock?.(floor))
    ) {
      return {
        ok: false,
        error:
          "Checkpoint evidence is blocked by the current classification policy",
      };
    }
    turnSession = { ...session, taint: floor };
    const scopedConfig: OrchestratorConfig = {
      ...config,
      getSessionTaint: () =>
        maxClassification(config.getSessionTaint?.() ?? session.taint, floor),
      escalateTaint(level, reason) {
        floor = maxClassification(floor, level);
        config.escalateTaint?.(level, reason);
      },
    };
    turnState = {
      ...state,
      config: scopedConfig,
      toolExecutor: config.toolExecutor
        ? wrapToolExecutorWithEnforcement(config.toolExecutor, scopedConfig)
        : state.toolExecutor,
    };
    if (floor !== current) {
      restoreTaint = () =>
        config.escalateTaint?.(
          required.value,
          "Authorized checkpoint recovery",
        );
    }
  }
  if (protectedResume) {
    const guard = await validateAgentTurnPreconditions(
      turnState.config,
      turnSession,
      message,
      true,
    );
    if (!guard.ok) return guard;
    if (
      resumeToolCalls && !await authorizeSavedToolCalls(
        resumeToolCalls,
        turnState.config,
        turnSession,
        toolPersistence,
        signal,
      )
    ) {
      return {
        ok: false,
        error: "A saved tool request is blocked by the current policy",
      };
    }
    if (
      resume && resumeToolCalls && !await authorizeSavedToolResponses(
        resume.history.slice(resumeMessageIndex + 1),
        resumeToolCalls,
        turnState.config,
        turnSession,
        signal,
      )
    ) {
      return {
        ok: false,
        error: "A saved tool result is blocked by the current policy",
      };
    }
    if (
      authorizeResumeSources && (!resume || !resumeToolCalls ||
        signal?.aborted ||
        !await authorizeResumeSources(
          signal,
          createSavedSourceAuthorization(turnState.config, turnSession, signal),
        ).catch(() => false))
    ) {
      return {
        ok: false,
        error: "A saved tool result is no longer authorized.",
      };
    }
    if (signal?.aborted) {
      return { ok: false, error: "Operation cancelled by user" };
    }
    try {
      restoreTaint?.();
    } catch {
      return {
        ok: false,
        error: "Checkpoint classification could not be restored",
      };
    }
  }
  const sessionKey = session.id as string;
  const protectContext = toolPersistence !== undefined || protectedResume;
  let ctx: Awaited<ReturnType<typeof prepareAgentTurnContext>>;
  try {
    ctx = await prepareAgentTurnContext(
      turnState,
      turnSession,
      sessionKey,
      message,
      signal,
      resume,
      protectContext,
    );
  } catch (error) {
    if (!protectContext) throw error;
    return {
      ok: false,
      error: "The protected agent context could not be prepared.",
    };
  }
  const { activeUser } = ctx;
  return orchestrateAgentLoop({
    state: turnState,
    session: turnSession,
    systemPrompt: ctx.systemPrompt,
    history: ctx.history,
    sessionKey,
    targetClassification,
    signal,
    resume,
    beforeToolBatch,
    toolPersistence,
    workerBoundary,
    onToolDispatchOutcome,
    refreshCommittedHistory: !protectContext && activeUser &&
        refreshCommittedHistory
      ? async (results) => {
        const activeIndex = ctx.history.indexOf(activeUser);
        if (activeIndex < 1 || signal?.aborted) return;
        const replacement = await refreshCommittedHistory(results);
        if (replacement && !signal?.aborted) {
          ctx.history.splice(0, activeIndex, ...replacement);
        }
      }
      : undefined,
    onToolBatchCheckpoint,
  });
}

/** @deprecated Use orchestrateAgentTurn instead */
export const runAgentTurn = orchestrateAgentTurn;
