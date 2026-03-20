/**
 * Session types and taint management.
 *
 * Sessions track conversation state with independent taint levels.
 * Taint can only escalate, never decrease within a session.
 * All functions return new objects — session state is immutable.
 *
 * @module
 */

import type { ClassificationLevel } from "./classification.ts";
import { canFlowTo, maxClassification } from "./classification.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("session");

/**
 * Stable memory namespace for the owner's agent.
 *
 * Trigger sessions share this namespace so they can read/write
 * the same memories as the main interactive session.
 */
export const OWNER_MEMORY_AGENT_ID = "main-session";

/** Branded type for session identifiers. */
export type SessionId = string & { readonly __brand: unique symbol };

/** Branded type for user identifiers. */
export type UserId = string & { readonly __brand: unique symbol };

/** Branded type for channel identifiers. */
export type ChannelId = string & { readonly __brand: unique symbol };

/** Records a change in session taint level. */
export interface TaintEvent {
  readonly timestamp: Date;
  readonly previousLevel: ClassificationLevel;
  readonly newLevel: ClassificationLevel;
  readonly reason: string;
  readonly sourceId?: string;
}

/** Immutable session state with taint tracking. */
export interface SessionState {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly channelId: ChannelId;
  readonly taint: ClassificationLevel;
  readonly createdAt: Date;
  readonly history: readonly TaintEvent[];
  /** Whether taint escalation bumpers are enabled. Default: true. */
  readonly bumpersEnabled: boolean;
}

/** Options for creating a new session. */
export interface CreateSessionOptions {
  readonly userId: UserId;
  readonly channelId: ChannelId;
  /** Initial bumper state. Defaults to true (bumpers deployed). */
  readonly bumpersEnabled?: boolean;
}

/**
 * Create a new session with PUBLIC taint and a unique ID.
 */
export function createSession(options: CreateSessionOptions): SessionState {
  return {
    id: crypto.randomUUID() as SessionId,
    userId: options.userId,
    channelId: options.channelId,
    taint: "PUBLIC",
    createdAt: new Date(),
    history: [],
    bumpersEnabled: options.bumpersEnabled ?? true,
  };
}

/**
 * Update session taint level. Taint can only escalate, never decrease.
 *
 * Returns a new session object — the original is not mutated.
 * If the new level is lower than or equal to the current taint,
 * the session is returned unchanged (silently ignored).
 */
export function escalateTaint(
  session: SessionState,
  level: ClassificationLevel,
  reason: string,
  sourceId?: string,
): SessionState {
  const newTaint = maxClassification(session.taint, level);

  // If taint didn't change, return a new object with same values
  // (still immutable — never return the same reference)
  if (newTaint === session.taint) {
    return { ...session };
  }

  log.warn("Taint escalation", {
    sessionId: session.id,
    from: session.taint,
    to: newTaint,
    reason,
    sourceId,
  });

  const event: TaintEvent = {
    timestamp: new Date(),
    previousLevel: session.taint,
    newLevel: newTaint,
    reason,
    ...(sourceId !== undefined ? { sourceId } : {}),
  };

  return {
    ...session,
    taint: newTaint,
    history: [...session.history, event],
  };
}

/**
 * Check if output is allowed from a session to a target classification.
 *
 * Uses canFlowTo: session taint must be <= target classification.
 */
export function canOutput(
  session: SessionState,
  targetClassification: ClassificationLevel,
): boolean {
  const allowed = canFlowTo(session.taint, targetClassification);
  if (!allowed) {
    log.warn("Write-down blocked", {
      sessionId: session.id,
      sessionTaint: session.taint,
      targetClassification,
    });
  }
  return allowed;
}

/** @deprecated Use escalateTaint instead */
export const updateTaint = escalateTaint;

/**
 * Reset a session, creating a fresh session with PUBLIC taint.
 *
 * Preserves userId and channelId. Generates a new session ID.
 * Clears taint history.
 */
export function resetSession(session: SessionState): SessionState {
  return createSession({
    userId: session.userId,
    channelId: session.channelId,
  });
}
