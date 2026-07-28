/**
 * Conversation store — persists and queries conversation records
 * backed by a {@link StorageProvider}.
 *
 * Records are stored under `conv:{session_id}:{sequence_padded_12}`.
 * Session sequence counters are stored under `conv-session:{session_id}`.
 *
 * @module
 */

import type { Result } from "../types/classification.ts";
import type { StorageProvider } from "../storage/provider.ts";
import { createLogger } from "../logger/mod.ts";

const log = createLogger("conversation-store");
import type {
  ConversationAppendInput,
  ConversationRecord,
  LoadActiveOptions,
  MessageRetentionConfig,
  MessageStore,
} from "./conversation_types.ts";
import {
  convRecordKey,
  convSessionIndexKey,
  deserialiseConvRecord,
  serialiseConvRecord,
  truncateToolArgs,
} from "./conversation_serde.ts";

/** Default resume window in days. */
const DEFAULT_RESUME_WINDOW_DAYS = 7;

/** Read and increment the sequence counter for a session. */
async function nextSequence(
  storage: StorageProvider,
  sessionId: string,
): Promise<number> {
  const indexKey = convSessionIndexKey(sessionId);
  const raw = await storage.get(indexKey);
  const current = raw !== null
    ? (JSON.parse(raw) as { lastSequence: number }).lastSequence
    : -1;
  const next = current + 1;
  await storage.set(indexKey, JSON.stringify({ lastSequence: next }));
  return next;
}

/** Build a ConversationRecord from append input. */
function buildRecord(
  input: ConversationAppendInput,
  sequence: number,
): ConversationRecord {
  return {
    message_id: crypto.randomUUID(),
    session_id: input.session_id,
    role: input.role,
    content: input.content,
    classification: input.classification,
    timestamp: new Date().toISOString(),
    sequence,
    compacted: false,
    ...(input.lineage_id !== undefined ? { lineage_id: input.lineage_id } : {}),
    ...(input.tool_name !== undefined ? { tool_name: input.tool_name } : {}),
    ...(input.tool_args !== undefined
      ? { tool_args: truncateToolArgs(input.tool_args) }
      : {}),
    ...(input.token_count !== undefined
      ? { token_count: input.token_count }
      : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.tool_calls !== undefined ? { tool_calls: input.tool_calls } : {}),
    ...(input.tool_call_id !== undefined
      ? { tool_call_id: input.tool_call_id }
      : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

/** Load all conversation records for a session from storage. */
async function loadAllRecords(
  storage: StorageProvider,
  sessionId: string,
): Promise<ConversationRecord[]> {
  const prefix = `conv:${sessionId}:`;
  const keys = await storage.list(prefix);
  const records: ConversationRecord[] = [];
  for (const key of keys) {
    const raw = await storage.get(key);
    if (raw !== null) {
      records.push(deserialiseConvRecord(raw));
    }
  }
  return records;
}

/** Check if a record is within the resume window. */
function isWithinResumeWindow(
  record: ConversationRecord,
  now: Date,
  windowDays: number,
): boolean {
  const recordTime = new Date(record.timestamp).getTime();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return now.getTime() - recordTime <= windowMs;
}

/** Check if a record has expired. */
function isExpired(record: ConversationRecord, now: Date): boolean {
  if (record.expiresAt === undefined) return false;
  return new Date(record.expiresAt).getTime() <= now.getTime();
}

/**
 * Create a new {@link MessageStore} backed by the given {@link StorageProvider}.
 *
 * All records are persisted under the `conv:` key namespace. Session sequence
 * counters are stored under `conv-session:`.
 */
export function createMessageStore(storage: StorageProvider): MessageStore {
  return {
    async append(input: ConversationAppendInput): Promise<ConversationRecord> {
      const sequence = await nextSequence(storage, input.session_id);
      const record = buildRecord(input, sequence);
      await storage.set(
        convRecordKey(input.session_id, sequence),
        serialiseConvRecord(record),
      );
      return record;
    },

    loadSession(sessionId: string): Promise<ConversationRecord[]> {
      return loadAllRecords(storage, sessionId);
    },

    async loadActive(
      sessionId: string,
      options?: LoadActiveOptions,
    ): Promise<ConversationRecord[]> {
      const windowDays = options?.resumeWindowDays ??
        DEFAULT_RESUME_WINDOW_DAYS;
      const excludeCompacted = options?.excludeCompacted ?? true;
      const now = new Date();
      const all = await loadAllRecords(storage, sessionId);
      return all.filter((r) => {
        if (excludeCompacted && r.compacted) return false;
        if (isExpired(r, now)) return false;
        if (!isWithinResumeWindow(r, now, windowDays)) return false;
        return true;
      });
    },

    async markCompacted(
      sessionId: string,
      fromSequence: number,
      toSequence: number,
    ): Promise<void> {
      for (let seq = fromSequence; seq <= toSequence; seq++) {
        const key = convRecordKey(sessionId, seq);
        const raw = await storage.get(key);
        if (raw === null) continue;
        const record = deserialiseConvRecord(raw);
        const updated: ConversationRecord = { ...record, compacted: true };
        await storage.set(key, serialiseConvRecord(updated));
      }
    },

    export(sessionId: string): Promise<ConversationRecord[]> {
      return loadAllRecords(storage, sessionId);
    },

    async applyRetention(
      config: MessageRetentionConfig,
      now?: Date,
    ): Promise<Result<number, string>> {
      const referenceTime = now ?? new Date();
      const maxAgeMs = config.maxAgeDays * 24 * 60 * 60 * 1000;

      try {
        const keys = await storage.list("conv:");
        // Exclude conv-session: index keys
        const recordKeys = keys.filter((k) => !k.startsWith("conv-session:"));
        let deletedCount = 0;

        for (const key of recordKeys) {
          const raw = await storage.get(key);
          if (raw === null) continue;
          try {
            const record = deserialiseConvRecord(raw);
            const ageMs = referenceTime.getTime() -
              new Date(record.timestamp).getTime();
            if (ageMs > maxAgeMs) {
              await storage.delete(key);
              deletedCount++;
            }
          } catch (err: unknown) {
            log.warn(
              "Conversation record deserialization failed during retention",
              { operation: "applyRetention", key, err },
            );
            continue;
          }
        }

        return { ok: true, value: deletedCount };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: `Message retention policy failed: ${message}`,
        };
      }
    },
  };
}
