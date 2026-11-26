/**
 * Session history compaction strategies.
 *
 * Provides sliding-window (keyword-based placeholder) and
 * LLM-based summarization compaction for conversation history.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SessionId } from "../../core/types/session.ts";
import type { LlmProvider, LlmProviderRegistry } from "../llm.ts";
import type { Compactor, CompactResult } from "./compactor.ts";
import { estimateHistoryTokens } from "./compactor.ts";
import type { HistoryEntry } from "../orchestrator/orchestrator_types.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("agent.compactor.history-compaction");

/** Compact history using sliding-window strategy (no LLM). */
function compactHistoryWithSlidingWindow(
  history: HistoryEntry[],
  compactor: Compactor,
  messagesBefore: number,
  tokensBefore: number,
): CompactResult {
  const compacted = [...compactor.compact(history)];
  history.length = 0;
  history.push(...compacted);
  return {
    messagesBefore,
    messagesAfter: history.length,
    tokensBefore,
    tokensAfter: estimateHistoryTokens(history),
  };
}

/** Compact history using LLM-based summarization. */
async function compactHistoryWithSummarization(
  history: HistoryEntry[],
  compactor: Compactor,
  provider: LlmProvider,
  messagesBefore: number,
  tokensBefore: number,
  signal?: AbortSignal,
): Promise<CompactResult> {
  const summarized = [...await compactor.summarize(history, provider, signal)];
  history.length = 0;
  history.push(...summarized);
  return {
    messagesBefore,
    messagesAfter: history.length,
    tokensBefore,
    tokensAfter: estimateHistoryTokens(history),
  };
}

/** Sentinel result for empty conversation history. */
const EMPTY_COMPACT_RESULT: CompactResult = {
  messagesBefore: 0,
  messagesAfter: 0,
  tokensBefore: 0,
  tokensAfter: 0,
};

/** Update the compactor budget to match the provider's context window. */
function alignCompactorBudgetToProvider(
  compactor: Compactor,
  provider: LlmProvider,
  fallbackBudget: number,
): void {
  const budget = provider.contextWindow ?? fallbackBudget;
  compactor.updateBudget(budget);
}

/**
 * Compact a session's history using summarization or sliding-window fallback.
 *
 * Selects the provider appropriate for the session's taint level to prevent
 * classified data from being sent to a lower-classification provider during
 * summarization. Also adjusts the compactor budget to match the selected
 * provider's context window.
 */
export async function compactSessionHistory(
  sessionId: SessionId,
  histories: Map<string, HistoryEntry[]>,
  providerRegistry: LlmProviderRegistry,
  compactor: Compactor,
  taint: ClassificationLevel,
  signal?: AbortSignal,
): Promise<CompactResult> {
  const history = histories.get(sessionId as string) ?? [];
  if (history.length === 0) return EMPTY_COMPACT_RESULT;

  const messagesBefore = history.length;
  const tokensBefore = estimateHistoryTokens(history);
  const provider = providerRegistry.getForClassification(taint);

  if (!provider) {
    log.debug(
      "No classification-specific provider found, falling back to sliding-window compaction",
      {
        operation: "compactSessionHistory",
        sessionId,
        taint,
        usedClassificationOverride: false,
      },
    );
    return compactHistoryWithSlidingWindow(
      history,
      compactor,
      messagesBefore,
      tokensBefore,
    );
  }
  log.debug("Provider selected for summarization compaction", {
    operation: "compactSessionHistory",
    sessionId,
    taint,
    provider: provider.name,
    usedClassificationOverride: true,
  });
  alignCompactorBudgetToProvider(compactor, provider, 100_000);
  return await compactHistoryWithSummarization(
    history,
    compactor,
    provider,
    messagesBefore,
    tokensBefore,
    signal,
  );
}
