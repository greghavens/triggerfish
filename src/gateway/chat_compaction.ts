/** Create a durable summary from the owner conversation's safe text projection. */
import { createCompactor } from "../agent/compactor/compactor.ts";
import { compactSessionHistory } from "../agent/compactor/history_compaction.ts";
import type { HistoryEntry } from "../agent/orchestrator/orchestrator_types.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import type { SessionState } from "../core/types/session.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import type { ChatSessionConfig } from "./chat_types.ts";

export const compactOwnerContext: ToolDefinition = {
  name: "compact_owner_context",
  description:
    "Summarize committed previous owner conversation when its length interferes with the current turn. Current work and tool exchanges remain available.",
  parameters: {},
};

export const ownerCompactionRequested = "Owner context compaction requested.";

export async function checkpointOwnerCompaction(
  config: ChatSessionConfig,
  session: SessionState,
  taint: ClassificationLevel,
  store: NonNullable<ChatSessionConfig["messageStore"]>,
  activeTurn?: { readonly signal?: AbortSignal },
) {
  const records = (await store.loadActive(session.id))
    .sort((left, right) => left.sequence - right.sequence);
  const last = records.findLast((record) =>
    record.role === "compaction_summary" && record.compaction
  );
  const through = last?.compaction?.throughSequence ?? -1;
  const activeSequence = activeTurn
    ? records.findLast(({ role }) => role === "user")?.sequence ?? -1
    : Infinity;
  const candidates = records.filter((record) =>
    record.sequence > through && record.sequence < activeSequence &&
    (record.role === "user" ||
      (record.role === "assistant" && !record.tool_calls?.length))
  );
  const messages = candidates.slice(0, 128);
  const source = last ? [last, ...messages] : messages;
  const empty = {
    messagesBefore: source.length,
    messagesAfter: source.length,
    tokensBefore: 0,
    tokensAfter: 0,
  };
  if (
    source.length < 3 ||
    source.some((record) => !canFlowTo(record.classification, taint))
  ) {
    return { result: empty, saved: false };
  }
  const latestSource = messages.at(-1);
  const admitted = await config.hookRunner.evaluateHook(
    "PRE_CONTEXT_INJECTION",
    {
      session,
      input: { source_type: "OWNER", operation: "compact_owner_history" },
    },
  );
  if (!admitted.allowed || !latestSource || activeTurn?.signal?.aborted) {
    return { result: empty, saved: false };
  }
  const projection: HistoryEntry[] = source.map((record) => ({
    role: record.role === "assistant" ? "assistant" : "user",
    content: record.content,
  }));
  const histories = new Map([[session.id as string, projection]]);
  const result = await compactSessionHistory(
    session.id,
    histories,
    config.providerRegistry,
    createCompactor(),
    taint,
    activeTurn?.signal,
  );
  const summary = projection[0]?.content;
  if (
    result.messagesAfter !== 1 || typeof summary !== "string" ||
    summary.length > 8000 || summary.trim().length === 0 ||
    activeTurn?.signal?.aborted
  ) {
    return { result: empty, saved: false };
  }
  await store.append({
    session_id: session.id,
    role: "compaction_summary",
    classification: taint,
    content: summary,
    compaction: {
      sourceMessageIds: source.map((record) => record.message_id),
      throughSequence: latestSource.sequence,
    },
  });
  const replacement: HistoryEntry[] = [
    {
      role: "user",
      content: `[CONTEXT SUMMARY]\n${summary}`,
    },
    ...candidates.slice(messages.length)
      .filter(({ classification }) => canFlowTo(classification, taint))
      .map(({ role, content }): HistoryEntry => ({
        role: role === "assistant" ? "assistant" : "user",
        content,
      })),
  ];
  return { result, saved: true, replacement };
}
