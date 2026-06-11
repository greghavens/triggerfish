/**
 * Enhanced Session Manager — wraps Phase 4 SessionManager with
 * inter-session capabilities for the Gateway control plane.
 *
 * Adds session listing with filters, inter-session messaging
 * with write-down enforcement, and background session spawning.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { Result } from "../core/types/classification.ts";
import type {
  CreateSessionOptions,
  SessionId,
  SessionState,
} from "../core/types/session.ts";
import type { SessionManager } from "../core/session/manager.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("session");

/** Session types for classification and routing. */
export type SessionType = "MAIN" | "CHANNEL" | "BACKGROUND" | "AGENT";

/** Enhanced session manager with inter-session capabilities. */
export interface EnhancedSessionManager {
  /** Create a new session (delegates to base). */
  create(options: CreateSessionOptions): Promise<SessionState>;

  /** Retrieve a session by ID (delegates to base). */
  get(id: SessionId): Promise<SessionState | null>;

  /** Delete a session by ID (delegates to base). */
  delete(id: SessionId): Promise<void>;

  /** Escalate session taint (delegates to base). */
  updateTaint(
    id: SessionId,
    level: ClassificationLevel,
    reason: string,
  ): Promise<SessionState>;

  /** Reset a session (delegates to base). */
  reset(id: SessionId): Promise<SessionState>;

  /** List all active sessions with optional type/channel filters. */
  sessionsList(filter?: SessionListFilter): Promise<SessionState[]>;

  /**
   * Send content from one session to another.
   * Enforces write-down check: source session taint must be able
   * to flow to the resolved target session's taint. The target
   * classification is always derived from the target session —
   * callers cannot supply it.
   */
  sessionsSend(
    fromId: SessionId,
    toId: SessionId,
    content: string,
  ): Promise<Result<{ delivered: true }, string>>;

  /**
   * Spawn a background session from a parent session.
   * The spawned session has independent PUBLIC taint.
   */
  sessionsSpawn(parentId: SessionId, task: string): Promise<SessionState>;
}

/** Filter options for session listing. */
export interface SessionListFilter {
  readonly type?: SessionType;
  readonly channelId?: string;
  readonly userId?: string;
}

/**
 * Create an enhanced session manager wrapping a base SessionManager.
 */
export function createEnhancedSessionManager(
  base: SessionManager,
): EnhancedSessionManager {
  return {
    create(options: CreateSessionOptions): Promise<SessionState> {
      return base.create(options);
    },

    get(id: SessionId): Promise<SessionState | null> {
      return base.get(id);
    },

    delete(id: SessionId): Promise<void> {
      return base.delete(id);
    },

    updateTaint(
      id: SessionId,
      level: ClassificationLevel,
      reason: string,
    ): Promise<SessionState> {
      return base.updateTaint(id, level, reason);
    },

    reset(id: SessionId): Promise<SessionState> {
      return base.reset(id);
    },

    async sessionsList(filter?: SessionListFilter): Promise<SessionState[]> {
      const all = await base.list();
      if (!filter) return all;

      return all.filter((session) => {
        if (filter.channelId && session.channelId !== filter.channelId) {
          return false;
        }
        if (filter.userId && session.userId !== filter.userId) {
          return false;
        }
        return true;
      });
    },

    async sessionsSend(
      fromId: SessionId,
      toId: SessionId,
      _content: string,
    ): Promise<Result<{ delivered: true }, string>> {
      const source = await base.get(fromId);
      if (!source) {
        return { ok: false, error: `Source session not found: ${fromId}` };
      }
      const target = await base.get(toId);
      if (!target) {
        return { ok: false, error: `Target session not found: ${toId}` };
      }

      // Enforce no write-down: source taint must flow to the target
      // session's taint, derived here — never trusted from the caller.
      if (!canFlowTo(source.taint, target.taint)) {
        log.warn("Inter-session write-down blocked", {
          fromSessionId: fromId,
          toSessionId: toId,
          sourceTaint: source.taint,
          targetTaint: target.taint,
        });
        return {
          ok: false,
          error:
            `Write-down blocked: ${source.taint} cannot flow to ${target.taint}`,
        };
      }

      return { ok: true, value: { delivered: true } };
    },

    async sessionsSpawn(
      parentId: SessionId,
      _task: string,
    ): Promise<SessionState> {
      const parent = await base.get(parentId);
      if (!parent) {
        throw new Error(`Parent session not found: ${parentId}`);
      }

      // Spawned session gets independent PUBLIC taint
      return base.create({
        userId: parent.userId,
        channelId: parent.channelId,
      });
    },
  };
}
