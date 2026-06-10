/**
 * Per-user session manager for non-owner channel messages.
 *
 * Creates and caches ephemeral sessions keyed by `{channelType}:{senderId}`.
 * Each non-owner user gets an independent session starting at PUBLIC taint,
 * with a classification ceiling derived from channel config or per-user overrides.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import { parseClassification } from "../core/types/classification.ts";
import { createSession } from "../core/types/session.ts";
import type { ChannelId, SessionState, UserId } from "../core/types/session.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("user-sessions");

/** Configuration for per-user classification resolution. */
export interface UserClassificationConfig {
  /** Default classification for users without an explicit override. */
  readonly channelDefault: ClassificationLevel;
  /** Per-user classification overrides keyed by platform-native user ID. */
  readonly userOverrides: ReadonlyMap<string, ClassificationLevel>;
}

/** Manages ephemeral per-user sessions for non-owner channel messages. */
export interface UserSessionManager {
  /** Get an existing session or create a new one for this user. */
  getOrCreate(channelType: string, senderId: string): SessionState;
  /** Resolve the classification ceiling for a user (override or channel default). */
  getClassification(senderId: string): ClassificationLevel;
  /** Whether this user has an explicit classification (config or runtime pairing). */
  hasExplicitClassification(senderId: string): boolean;
  /** Add a runtime classification for a paired user. */
  addClassification(senderId: string, level: ClassificationLevel): void;
  /** Look up an existing session without creating one. */
  getSession(channelType: string, senderId: string): SessionState | undefined;
  /** Replace the cached session state (e.g. after taint escalation). */
  updateSession(
    channelType: string,
    senderId: string,
    session: SessionState,
  ): void;
}

/** Build a session cache key from channel type and sender ID. */
function buildSessionKey(channelType: string, senderId: string): string {
  return `${channelType}:${senderId}`;
}

/** Resolve a user's classification from runtime overrides, config, or channel default. */
function resolveUserClassification(
  runtimeOverrides: ReadonlyMap<string, ClassificationLevel>,
  config: UserClassificationConfig,
  senderId: string,
): ClassificationLevel {
  return runtimeOverrides.get(senderId) ??
    config.userOverrides.get(senderId) ??
    config.channelDefault;
}

/** Get an existing session or create a new one for the user. */
function getOrCreateUserSession(
  sessions: Map<string, SessionState>,
  channelType: string,
  senderId: string,
): SessionState {
  const key = buildSessionKey(channelType, senderId);
  const existing = sessions.get(key);
  if (existing) return existing;

  const session = createSession({
    userId: senderId as UserId,
    channelId: `${channelType}-user` as ChannelId,
  });
  sessions.set(key, session);
  return session;
}

/**
 * Create a UserSessionManager for a single channel.
 *
 * Sessions are keyed by `{channelType}:{senderId}` and start at PUBLIC taint.
 * The classification returned by `getClassification` is the ceiling for tool
 * access — the orchestrator's `targetClassification` parameter.
 */
export function createUserSessionManager(
  config: UserClassificationConfig,
): UserSessionManager {
  const sessions = new Map<string, SessionState>();
  const runtimeOverrides = new Map<string, ClassificationLevel>();

  return {
    getOrCreate: (channelType, senderId) =>
      getOrCreateUserSession(sessions, channelType, senderId),
    getClassification: (senderId) =>
      resolveUserClassification(runtimeOverrides, config, senderId),
    hasExplicitClassification: (senderId) =>
      runtimeOverrides.has(senderId) || config.userOverrides.has(senderId),
    getSession: (channelType, senderId) =>
      sessions.get(buildSessionKey(channelType, senderId)),
    updateSession: (channelType, senderId, session) =>
      sessions.set(buildSessionKey(channelType, senderId), session),
    addClassification: (senderId, level) =>
      runtimeOverrides.set(senderId, level),
  };
}

/**
 * Parse a raw `user_classifications` config object into a Map.
 *
 * Config values may be string keys (Discord snowflakes, Slack IDs) or
 * numeric keys (Telegram user IDs). All are normalised to strings.
 *
 * Fail closed: each value is validated via `parseClassification`. An
 * unparseable level (e.g. a typo like "CONFIDENTAL") pins that user to
 * PUBLIC — never silently granting the intended higher ceiling — and is
 * logged at WARN so the operator can fix the config.
 */
export function parseUserOverrides(
  raw: Record<string, string> | undefined,
): ReadonlyMap<string, ClassificationLevel> {
  const map = new Map<string, ClassificationLevel>();
  if (!raw) return map;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseClassification(value);
    if (!parsed.ok) {
      log.warn(
        "User classification override unparseable — failing closed to PUBLIC",
        { operation: "parseUserOverrides", userKey: String(key), value },
      );
    }
    map.set(String(key), parsed.ok ? parsed.value : "PUBLIC");
  }
  return map;
}
