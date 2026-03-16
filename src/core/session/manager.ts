/**
 * Session Manager — CRUD and taint lifecycle for sessions.
 *
 * Wraps the core session types from `types/session.ts` with a
 * storage-backed manager that persists sessions via `StorageProvider`.
 * All mutations return new objects — session state is immutable.
 *
 * @module
 */

import type { ClassificationLevel } from "../types/classification.ts";
import type {
  CreateSessionOptions,
  SessionId,
  SessionState,
} from "../types/session.ts";
import {
  createSession,
  escalateTaint,
  resetSession,
} from "../types/session.ts";
import type { StorageProvider } from "../storage/provider.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("session");

/** Key prefix for sessions stored via StorageProvider. */
const SESSION_PREFIX = "sessions:";

/** Session Manager interface — async CRUD + taint operations. */
export interface SessionManager {
  /** Create a new session with PUBLIC taint. */
  create(options: CreateSessionOptions): Promise<SessionState>;

  /** Retrieve a session by ID. Returns `null` when not found. */
  get(id: SessionId): Promise<SessionState | null>;

  /** List all active sessions. */
  list(): Promise<SessionState[]>;

  /** Delete a session by ID. */
  delete(id: SessionId): Promise<void>;

  /** Escalate session taint. Returns the (possibly updated) session. */
  updateTaint(
    id: SessionId,
    level: ClassificationLevel,
    reason: string,
  ): Promise<SessionState>;

  /** Reset a session: fresh PUBLIC taint, cleared history, new ID. Preserves userId/channelId. */
  reset(id: SessionId): Promise<SessionState>;
}

/** Serialise a SessionState to a JSON string for storage. */
function serialise(session: SessionState): string {
  return JSON.stringify({
    ...session,
    createdAt: session.createdAt.toISOString(),
    history: session.history.map((e) => ({
      ...e,
      timestamp: e.timestamp.toISOString(),
    })),
  });
}

/** Deserialise a JSON string back to a SessionState. */
function deserialise(raw: string): SessionState {
  const data = JSON.parse(raw);
  return {
    ...data,
    createdAt: new Date(data.createdAt),
    history: data.history.map(
      (e: Record<string, unknown>) => ({
        ...e,
        timestamp: new Date(e.timestamp as string),
      }),
    ),
  } as SessionState;
}

/** Load a session from storage, throwing if not found. */
async function loadSessionOrThrow(
  storage: StorageProvider,
  id: SessionId,
): Promise<SessionState> {
  const raw = await storage.get(SESSION_PREFIX + id);
  if (raw === null) throw new Error(`Session not found: ${id}`);
  return deserialise(raw);
}

/** Escalate session taint and persist the updated state. */
async function escalateSessionTaint(
  storage: StorageProvider,
  id: SessionId,
  level: ClassificationLevel,
  reason: string,
): Promise<SessionState> {
  const current = await loadSessionOrThrow(storage, id);
  const updated = escalateTaint(current, level, reason);
  if (updated.taint !== current.taint) {
    log.warn("Session taint updated", {
      sessionId: id,
      from: current.taint,
      to: updated.taint,
      reason,
    });
  }
  await storage.set(SESSION_PREFIX + id, serialise(updated));
  return updated;
}

/** Reset a session: delete old, create fresh preserving user/channel. */
async function resetSessionState(
  storage: StorageProvider,
  id: SessionId,
): Promise<SessionState> {
  const current = await loadSessionOrThrow(storage, id);
  log.warn("Session reset", {
    oldSessionId: id,
    previousTaint: current.taint,
    userId: current.userId,
    channelId: current.channelId,
  });
  await storage.delete(SESSION_PREFIX + id);
  const fresh = resetSession(current);
  await storage.set(SESSION_PREFIX + fresh.id, serialise(fresh));
  return fresh;
}

/**
 * Create a SessionManager backed by the given StorageProvider.
 */
export function createSessionManager(
  storage: StorageProvider,
): SessionManager {
  return {
    async create(options: CreateSessionOptions): Promise<SessionState> {
      const session = createSession(options);
      await storage.set(SESSION_PREFIX + session.id, serialise(session));
      return session;
    },
    async get(id: SessionId): Promise<SessionState | null> {
      const raw = await storage.get(SESSION_PREFIX + id);
      if (raw === null) return null;
      return deserialise(raw);
    },
    async list(): Promise<SessionState[]> {
      const keys = await storage.list(SESSION_PREFIX);
      const sessions: SessionState[] = [];
      for (const key of keys) {
        const raw = await storage.get(key);
        if (raw !== null) sessions.push(deserialise(raw));
      }
      return sessions;
    },
    delete: (id: SessionId) => storage.delete(SESSION_PREFIX + id),
    updateTaint: (id, level, reason) =>
      escalateSessionTaint(storage, id, level, reason),
    reset: (id) => resetSessionState(storage, id),
  };
}
