/**
 * Chat history loading for Tidepool session restoration.
 *
 * Maps persisted ConversationRecords to the wire-format ChatHistoryEntry
 * consumed by Tidepool clients on reconnect.
 *
 * @module
 */

import { createLogger } from "../core/logger/mod.ts";
import type {
  ConversationRecord,
  MessageStore,
} from "../core/conversation/mod.ts";
import type { ChatHistoryEntry } from "./chat_session_interface.ts";

const log = createLogger("chat-history");

/** Map a ConversationRecord to a wire-format ChatHistoryEntry, or null if not displayable. */
function mapRecordToHistoryEntry(
  record: ConversationRecord,
): ChatHistoryEntry | null {
  if (record.role !== "user" && record.role !== "assistant") return null;
  // Tool-requesting assistant turns carry no user-visible text — they exist
  // for trace export. Rendering them produces blank chat bubbles.
  if (record.tool_calls && record.tool_calls.length > 0) return null;
  return {
    role: record.role,
    text: record.content,
    taint: record.classification,
    timestamp: new Date(record.timestamp).getTime(),
  };
}

/** Load persisted chat history and map to wire-format entries for Tidepool clients. */
export async function loadChatHistoryEntries(
  messageStore: MessageStore,
  sessionId: string,
): Promise<readonly ChatHistoryEntry[]> {
  try {
    const records = await messageStore.loadActive(sessionId);
    const entries: ChatHistoryEntry[] = [];
    for (const record of records) {
      const entry = mapRecordToHistoryEntry(record);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch (err: unknown) {
    log.warn("Chat history load failed for session restoration", {
      operation: "loadChatHistoryEntries",
      sessionId,
      err,
    });
    return [];
  }
}
