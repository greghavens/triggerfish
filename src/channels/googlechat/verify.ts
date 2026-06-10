/**
 * Google Chat owner verification — anchors owner status in the Chat API.
 *
 * PubSub pull payloads carry no signature: anyone able to publish to the
 * subscription's topic can forge an event claiming the owner's
 * `sender.email`. Owner status is therefore never granted from the event
 * payload. The event is only a hint: the authoritative message (sender,
 * content, space) is re-fetched from the Chat API by resource name using
 * our own credentials, and the owner's identity (DM space + user ID) is
 * resolved via `spaces:findDirectMessage` + `spaces.members.list`. A
 * replay guard rejects already-verified message names so captured events
 * cannot be re-published to repeat owner commands.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { Result } from "../../core/types/classification.ts";
import type {
  GoogleChatApiMessage,
  GoogleChatConfig,
  GoogleChatEvent,
  GoogleChatMembership,
} from "./types.ts";

const log = createLogger("googlechat-verify");

/**
 * Strict resource-name pattern for a Chat message (URL-injection guard).
 * The message segment may contain dots but must not BE dots ("..", ".")
 * — a pure-dot segment would normalize to a different API path.
 */
const CHAT_MESSAGE_NAME_PATTERN =
  /^spaces\/[A-Za-z0-9_-]+\/messages\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Strict resource-name pattern for a Chat space. */
const CHAT_SPACE_NAME_PATTERN = /^spaces\/[A-Za-z0-9_-]+$/;

/** How long a verified message name is remembered for replay rejection. */
const REPLAY_TTL_MS = 10 * 60 * 1000;

/** Maximum number of remembered message names. */
const REPLAY_MAX_ENTRIES = 1000;

/** Error from owner verification. Transient errors may be retried. */
export interface GoogleChatVerifyError {
  readonly reason: string;
  readonly transient: boolean;
}

/** Authoritative content of a Chat-API-verified owner message. */
export interface GoogleChatVerifiedMessage {
  readonly text: string;
  readonly senderUserId: string;
  readonly spaceName: string;
  readonly isDm: boolean;
}

/** Verifies owner-claimed events against the Chat API. */
export interface GoogleChatSenderVerifier {
  /** Verify an event claiming the owner sent it; never trusts the payload. */
  verifyOwnerMessage(
    event: GoogleChatEvent,
  ): Promise<Result<GoogleChatVerifiedMessage, GoogleChatVerifyError>>;
}

/** Owner identity resolved from the Chat API (never from event payloads). */
interface OwnerIdentity {
  readonly dmSpaceName: string;
  readonly ownerUserId: string;
}

/** Build a definitive (non-retryable) verification error. */
function definitiveError(
  reason: string,
): Result<never, GoogleChatVerifyError> {
  return { ok: false, error: { reason, transient: false } };
}

// ─── Chat API access ────────────────────────────────────────────────────────

/** GET a Chat API path with bearer auth, returning parsed JSON. */
async function fetchChatApiResource<T>(
  config: GoogleChatConfig,
  pathAndQuery: string,
): Promise<Result<T, GoogleChatVerifyError>> {
  const fetchFn = config._fetchFn ?? fetch;
  let response: Response;
  try {
    const token = await config.getAccessToken();
    response = await fetchFn(`https://chat.googleapis.com/v1/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err: unknown) {
    log.warn("Chat API request failed during owner verification", {
      operation: "fetchChatApiResource",
      path: pathAndQuery.split("?")[0],
      err,
    });
    return {
      ok: false,
      error: { reason: "Chat API unreachable", transient: true },
    };
  }
  return await parseChatApiResponse<T>(response, pathAndQuery);
}

/** Convert a Chat API response into a Result, classifying retryability. */
async function parseChatApiResponse<T>(
  response: Response,
  pathAndQuery: string,
): Promise<Result<T, GoogleChatVerifyError>> {
  const path = pathAndQuery.split("?")[0];
  if (!response.ok) {
    await response.body?.cancel();
    const transient = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      error: {
        reason: `Chat API ${path} returned ${response.status}`,
        transient,
      },
    };
  }
  try {
    return { ok: true, value: await response.json() as T };
  } catch (err: unknown) {
    log.warn("Chat API response JSON parse failed", {
      operation: "parseChatApiResponse",
      path,
      err,
    });
    return definitiveError(`Chat API ${path} returned invalid JSON`);
  }
}

// ─── Owner identity resolution ──────────────────────────────────────────────

/** Resolve the owner's 1:1 DM space name via spaces:findDirectMessage. */
async function fetchOwnerDmSpaceName(
  config: GoogleChatConfig,
  ownerEmail: string,
): Promise<Result<string, GoogleChatVerifyError>> {
  const encoded = encodeURIComponent(`users/${ownerEmail}`);
  const space = await fetchChatApiResource<{ readonly name?: string }>(
    config,
    `spaces:findDirectMessage?name=${encoded}`,
  );
  if (!space.ok) return space;
  const name = space.value.name;
  if (!name || !CHAT_SPACE_NAME_PATTERN.test(name)) {
    return definitiveError(
      "Owner DM space lookup returned no usable space name",
    );
  }
  return { ok: true, value: name };
}

/** Resolve the single human member of the owner DM space (the owner). */
async function fetchOwnerUserId(
  config: GoogleChatConfig,
  dmSpaceName: string,
): Promise<Result<string, GoogleChatVerifyError>> {
  const res = await fetchChatApiResource<
    { readonly memberships?: readonly GoogleChatMembership[] }
  >(config, `${dmSpaceName}/members`);
  if (!res.ok) return res;
  const humans = (res.value.memberships ?? []).filter(
    (m) => m.member?.type === "HUMAN" && typeof m.member?.name === "string",
  );
  if (humans.length !== 1) {
    return definitiveError(
      `Owner DM space has ${humans.length} human members, expected exactly 1`,
    );
  }
  return { ok: true, value: humans[0].member!.name! };
}

// ─── Replay guard ───────────────────────────────────────────────────────────

/** Check whether a message name was already verified recently. */
function isReplayedMessageName(
  seen: Map<string, number>,
  messageName: string,
): boolean {
  const verifiedAt = seen.get(messageName);
  return verifiedAt !== undefined && Date.now() - verifiedAt < REPLAY_TTL_MS;
}

/** Record a verified message name, pruning expired and overflow entries. */
function recordSeenMessageName(
  seen: Map<string, number>,
  messageName: string,
): void {
  const now = Date.now();
  for (const [key, verifiedAt] of seen) {
    if (now - verifiedAt >= REPLAY_TTL_MS) seen.delete(key);
  }
  while (seen.size >= REPLAY_MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  seen.set(messageName, now);
}

// ─── Verifier factory ───────────────────────────────────────────────────────

/** Extract the verified message fields from an authoritative API message. */
function buildVerifiedMessage(
  apiMessage: GoogleChatApiMessage,
  ownerUserId: string,
): Result<GoogleChatVerifiedMessage, GoogleChatVerifyError> {
  const text = apiMessage.argumentText?.trim() || apiMessage.text?.trim() || "";
  if (!text) return definitiveError("Authoritative message has no text");
  const space = apiMessage.space;
  if (!space?.name) {
    return definitiveError("Authoritative message has no space");
  }
  return {
    ok: true,
    value: {
      text,
      senderUserId: ownerUserId,
      spaceName: space.name,
      isDm: space.singleUserBotDm === true || space.type === "DM",
    },
  };
}

/**
 * Create a verifier that anchors owner status in the Chat API.
 *
 * The resolved owner identity (DM space + user ID) is cached for the
 * process lifetime; verified message names are remembered to reject
 * replayed events. All failures are fail-closed: the caller must treat
 * an error Result as "not the owner".
 */
export function createGoogleChatSenderVerifier(
  config: GoogleChatConfig,
): GoogleChatSenderVerifier {
  let identity: OwnerIdentity | null = null;
  const seenMessageNames = new Map<string, number>();

  async function resolveOwnerIdentity(): Promise<
    Result<OwnerIdentity, GoogleChatVerifyError>
  > {
    if (identity) return { ok: true, value: identity };
    if (!config.ownerEmail) {
      return definitiveError("ownerEmail not configured");
    }
    const dmSpace = await fetchOwnerDmSpaceName(config, config.ownerEmail);
    if (!dmSpace.ok) return dmSpace;
    const ownerUserId = await fetchOwnerUserId(config, dmSpace.value);
    if (!ownerUserId.ok) return ownerUserId;
    identity = { dmSpaceName: dmSpace.value, ownerUserId: ownerUserId.value };
    log.info("Google Chat owner identity resolved via Chat API", {
      operation: "resolveOwnerIdentity",
      dmSpaceName: identity.dmSpaceName,
      ownerUserId: identity.ownerUserId,
    });
    return { ok: true, value: identity };
  }

  return {
    async verifyOwnerMessage(event) {
      const messageName = event.message?.name;
      if (!messageName || !CHAT_MESSAGE_NAME_PATTERN.test(messageName)) {
        return definitiveError("Event message name missing or invalid");
      }
      if (isReplayedMessageName(seenMessageNames, messageName)) {
        return definitiveError("Message already processed (replay rejected)");
      }
      const owner = await resolveOwnerIdentity();
      if (!owner.ok) return owner;
      const apiMessage = await fetchChatApiResource<GoogleChatApiMessage>(
        config,
        messageName,
      );
      if (!apiMessage.ok) return apiMessage;
      if (apiMessage.value.sender?.name !== owner.value.ownerUserId) {
        return definitiveError(
          `Authoritative sender ${
            apiMessage.value.sender?.name ?? "unknown"
          } is not the owner`,
        );
      }
      const verified = buildVerifiedMessage(
        apiMessage.value,
        owner.value.ownerUserId,
      );
      if (verified.ok) recordSeenMessageName(seenMessageNames, messageName);
      return verified;
    },
  };
}
