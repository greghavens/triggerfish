/**
 * Google Chat event dispatch — message parsing, filtering, and routing.
 *
 * Extracts helpers from the adapter to keep file sizes within limits.
 * All functions are pure (no adapter state) and operate on event data.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { MessageHandler } from "../types.ts";
import type { GoogleChatConfig, GoogleChatEvent } from "./types.ts";
import type {
  GoogleChatSenderVerifier,
  GoogleChatVerifiedMessage,
} from "./verify.ts";

const log = createLogger("googlechat-dispatch");

/** Outcome of dispatching one event: acknowledge it or leave it for redelivery. */
export type GoogleChatDispatchOutcome = "ack" | "retry";

/** Dependencies for dispatching a Google Chat event. */
export interface GoogleChatDispatchContext {
  readonly handler: MessageHandler;
  readonly config: GoogleChatConfig;
  readonly verifier: GoogleChatSenderVerifier;
}

// ─── Space / session helpers ────────────────────────────────────────────────

/** Determine if a Google Chat space is a DM (direct message). */
function isDirectMessage(event: GoogleChatEvent): boolean {
  const space = event.message?.space ?? event.space;
  if (!space) return false;
  if (space.singleUserBotDm) return true;
  return space.type === "DM";
}

/** Encode a space resource name for use in a session ID (URL-encode slashes). */
export function encodeSpaceName(spaceName: string): string {
  return spaceName.replace(/\//g, "%2F");
}

/** Decode a space resource name from a session ID (restore slashes). */
function decodeSpaceName(encoded: string): string {
  return encoded.replace(/%2F/g, "/");
}

/** Build a session ID from a Google Chat event. */
function buildSessionId(event: GoogleChatEvent): string | undefined {
  const space = event.message?.space ?? event.space;
  if (!space?.name) return undefined;
  const encoded = encodeSpaceName(space.name);
  return isDirectMessage(event)
    ? `googlechat-${encoded}`
    : `googlechat-group-${encoded}`;
}

/** Extract the space resource name from a session ID. */
export function spaceNameFromSessionId(
  sessionId: string,
): string | undefined {
  const stripped = sessionId
    .replace("googlechat-group-", "")
    .replace("googlechat-", "");
  if (!stripped) return undefined;
  return decodeSpaceName(stripped);
}

// ─── Mention / group filtering ──────────────────────────────────────────────

/** Check if the bot was @mentioned in a Google Chat event. */
function isBotMentioned(event: GoogleChatEvent): boolean {
  const annotations = event.message?.annotations;
  if (!annotations) return false;
  return annotations.some(
    (a) =>
      a.type === "USER_MENTION" &&
      a.userMention?.user?.type === "BOT",
  );
}

/** Determine if a group space message should be dispatched based on group mode. */
function isGroupMessageAllowed(
  event: GoogleChatEvent,
  config: GoogleChatConfig,
): boolean {
  const space = event.message?.space ?? event.space;
  const spaceName = space?.name ?? "";
  const mode = config.groups?.[spaceName]?.mode ??
    config.defaultGroupMode ?? "mentioned-only";

  switch (mode) {
    case "always":
      return true;
    case "mentioned-only":
      return isBotMentioned(event);
    case "owner-only":
      return false;
    default:
      return false;
  }
}

// ─── Ownership claim ────────────────────────────────────────────────────────

/** Extract the (unverified) sender email claimed by the event payload. */
function claimedSenderEmail(event: GoogleChatEvent): string {
  return event.message?.sender?.email ?? event.user?.email ?? "unknown";
}

/**
 * Determine if the event CLAIMS to be from the configured owner.
 *
 * This is an unverified payload claim — PubSub pull events are unsigned.
 * A true result only routes the event into Chat API verification; it
 * never grants owner status by itself.
 */
function claimsOwnership(
  event: GoogleChatEvent,
  ownerEmail: string | undefined,
): boolean {
  if (!ownerEmail) {
    log.warn("Google Chat ownerEmail not configured, defaulting to non-owner", {
      operation: "claimsOwnership",
    });
    return false;
  }
  return claimedSenderEmail(event) === ownerEmail;
}

// ─── Event dispatch ─────────────────────────────────────────────────────────

/** Extract the message text from a Google Chat event. */
function extractMessageText(event: GoogleChatEvent): string | undefined {
  return event.message?.argumentText?.trim() ||
    event.message?.text?.trim();
}

/** Dispatch a non-owner message with PUBLIC session taint. */
function dispatchNonOwnerMessage(
  event: GoogleChatEvent,
  text: string,
  handler: MessageHandler,
): void {
  const sessionId = buildSessionId(event);
  if (!sessionId) return;
  const isDm = isDirectMessage(event);
  const senderEmail = claimedSenderEmail(event);
  log.ext("DEBUG", "Google Chat message received", {
    sessionId,
    sender: senderEmail,
    isDm: String(isDm),
    isOwner: "false",
  });
  handler({
    content: text,
    sessionId,
    senderId: senderEmail,
    isOwner: false,
    sessionTaint: "PUBLIC" as ClassificationLevel,
    isGroup: !isDm,
    groupId: !isDm ? (event.message?.space?.name ?? undefined) : undefined,
  });
}

/** Build a session ID from a Chat-API-verified message (not the event). */
function buildVerifiedSessionId(verified: GoogleChatVerifiedMessage): string {
  const encoded = encodeSpaceName(verified.spaceName);
  return verified.isDm
    ? `googlechat-${encoded}`
    : `googlechat-group-${encoded}`;
}

/**
 * Verify an owner-claimed event against the Chat API and dispatch it.
 *
 * The session, space, and content come from the AUTHORITATIVE API message
 * — never from the forgeable event payload — so a forged envelope cannot
 * bind an owner-privileged session to an attacker-chosen space or text.
 */
async function dispatchOwnerClaimedMessage(
  event: GoogleChatEvent,
  ctx: GoogleChatDispatchContext,
): Promise<GoogleChatDispatchOutcome> {
  const verified = await ctx.verifier.verifyOwnerMessage(event);
  if (!verified.ok) {
    log.warn("Google Chat owner-claimed event failed verification", {
      operation: "dispatchOwnerClaimedMessage",
      messageName: event.message?.name ?? "missing",
      claimedSender: claimedSenderEmail(event),
      reason: verified.error.reason,
      transient: String(verified.error.transient),
    });
    return verified.error.transient ? "retry" : "ack";
  }
  const sessionId = buildVerifiedSessionId(verified.value);
  log.info("Google Chat owner message verified via Chat API", {
    operation: "dispatchOwnerClaimedMessage",
    messageName: event.message?.name ?? "",
    space: verified.value.spaceName,
    sessionId,
  });
  ctx.handler({
    content: verified.value.text,
    sessionId,
    senderId: claimedSenderEmail(event),
    isOwner: true,
    isGroup: !verified.value.isDm,
    groupId: !verified.value.isDm ? verified.value.spaceName : undefined,
  });
  return "ack";
}

/**
 * Dispatch a parsed Google Chat event to the message handler.
 *
 * Owner status is never granted from the event payload alone (PubSub pull
 * events are unsigned and forgeable by anyone who can publish to the
 * topic). Owner-claimed events are verified against the Chat API first.
 * Returns whether the PubSub message should be acknowledged or left for
 * redelivery (transient verification failures only).
 */
export async function dispatchGoogleChatEvent(
  event: GoogleChatEvent,
  ctx: GoogleChatDispatchContext,
): Promise<GoogleChatDispatchOutcome> {
  if (event.type !== "MESSAGE") return "ack";

  const text = extractMessageText(event);
  if (!text) return "ack";
  if (!buildSessionId(event)) return "ack";

  const isDm = isDirectMessage(event);
  if (!isDm && !isGroupMessageAllowed(event, ctx.config)) {
    log.warn("Google Chat group message denied by group mode", {
      operation: "dispatchGoogleChatEvent",
      space: event.message?.space?.name ?? "unknown",
      sender: claimedSenderEmail(event),
    });
    return "ack";
  }

  if (claimsOwnership(event, ctx.config.ownerEmail)) {
    return await dispatchOwnerClaimedMessage(event, ctx);
  }
  dispatchNonOwnerMessage(event, text, ctx.handler);
  return "ack";
}
