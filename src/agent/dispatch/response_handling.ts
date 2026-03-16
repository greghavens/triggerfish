/**
 * Final response handling and PRE_OUTPUT hook evaluation.
 *
 * Evaluates the PRE_OUTPUT policy hook and assembles the final
 * ProcessMessageResult. Re-exports response quality classification
 * and recovery nudge functions for backward compatibility.
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
  OrchestratorConfig,
  ProcessMessageResult,
} from "../orchestrator/orchestrator_types.ts";
import type {
  OrchestratorState,
  TokenAccumulator,
} from "../orchestrator/orchestrator.ts";
import {
  classifyResponseQuality,
  detectRepetition,
  FALLBACK_RESPONSE,
} from "./response_quality.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("orchestrator");

// ─── PRE_OUTPUT hook ─────────────────────────────────────────────────────────

/** Fire PRE_OUTPUT hook and return the result. */
export async function evaluatePreOutputHook(
  config: OrchestratorConfig,
  session: SessionState,
  responseText: string,
  targetClassification: ClassificationLevel,
): Promise<Result<void, string>> {
  const outputTaint = config.getSessionTaint?.() ?? session.taint;
  const outputSession = outputTaint !== session.taint
    ? { ...session, taint: outputTaint }
    : session;
  const isOwnerOutput = config.isOwnerSession !== undefined &&
    config.isOwnerSession();
  const effectiveTarget = isOwnerOutput ? outputTaint : targetClassification;

  log.debug("Evaluating PRE_OUTPUT hook", {
    operation: "evaluatePreOutputHook",
    outputTaint,
    targetClassification: effectiveTarget,
  });
  const result = await config.hookRunner.evaluateHook("PRE_OUTPUT", {
    session: outputSession,
    input: {
      content: responseText,
      target_classification: effectiveTarget,
    },
  });
  if (!result.allowed) {
    log.warn("PRE_OUTPUT hook blocked response", {
      operation: "evaluatePreOutputHook",
      outputTaint,
      targetClassification: effectiveTarget,
      ruleId: result.ruleId,
      message: result.message,
    });
    return { ok: false, error: result.message ?? "Output blocked by policy" };
  }
  return { ok: true, value: undefined };
}

// ─── Final response handling ─────────────────────────────────────────────────

/** Handle the final text response (no tool calls). */
export async function deliverFinalResponse(
  finalText: string,
  completion: { content: string },
  hasTools: boolean,
  emptyNudgeCount: number,
  state: OrchestratorState,
  session: SessionState,
  history: HistoryEntry[],
  targetClassification: ClassificationLevel,
  tokens: TokenAccumulator,
): Promise<Result<ProcessMessageResult, string> | null> {
  const { isEmptyOrJunk, isLeakedIntent, hasTrailingIntent, isDenseNarration } =
    classifyResponseQuality(finalText, hasTools);
  const isJunkFinal = finalText.length === 0 || isEmptyOrJunk ||
    isLeakedIntent || isDenseNarration ||
    (hasTrailingIntent && emptyNudgeCount >= 2);

  const deduped = detectRepetition(finalText);
  const responseText = isJunkFinal && emptyNudgeCount >= 2
    ? FALLBACK_RESPONSE
    : deduped ?? finalText;

  const hookResult = await evaluatePreOutputHook(
    state.config,
    session,
    responseText,
    targetClassification,
  );
  if (!hookResult.ok) {
    return { ok: false, error: hookResult.error };
  }

  state.emit({ type: "response", text: responseText });
  history.push({
    role: "assistant",
    content: responseText.length > 0 ? responseText : completion.content,
  });

  // Persist assistant response and create lineage record
  const sessionKey = session.id as string;
  const sessionTaint = state.config.getSessionTaint?.() ?? session.taint;

  if (state.config.messageStore) {
    await state.config.messageStore.append({
      session_id: sessionKey,
      role: "assistant",
      content: responseText,
      classification: sessionTaint,
      token_count: tokens.outputTokens,
    });
  }

  if (state.config.lineageStore) {
    await state.config.lineageStore.create({
      content: responseText,
      origin: {
        source_type: "agent_response",
        source_name: "assistant",
        accessed_at: new Date().toISOString(),
        accessed_by: session.userId as string,
        access_method: "llm_generation",
      },
      classification: {
        level: sessionTaint,
        reason: "Assistant response",
      },
      sessionId: session.id,
    });
  }

  return {
    ok: true,
    value: {
      response: responseText,
      tokenUsage: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
      },
    },
  };
}

/** @deprecated Use deliverFinalResponse instead */
export const handleFinalResponse = deliverFinalResponse;
