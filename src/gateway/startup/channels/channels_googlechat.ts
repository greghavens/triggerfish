/**
 * Google Chat channel adapter wiring for gateway startup.
 *
 * @module
 */

import type { UserId } from "../../../core/types/session.ts";
import type { ChannelMessage } from "../../../channels/types.ts";
import type { GroupMode } from "../../../channels/groups.ts";
import { createGoogleChatChannel } from "../../../channels/googlechat/adapter.ts";
import { encodeSpaceName } from "../../../channels/googlechat/dispatch.ts";
import { buildSendEvent } from "../../chat.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import { resolveChannelClassification } from "./channels_shared.ts";
import type { NotificationService } from "../../notifications/notifications.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-channels-googlechat");

/** Valid group modes for runtime validation. */
const VALID_GROUP_MODES: ReadonlySet<string> = new Set([
  "always",
  "mentioned-only",
  "owner-only",
]);

/** Google Chat channel config from triggerfish.yaml. */
export interface GoogleChatChannelConfig {
  readonly enabled?: boolean;
  readonly classification?: string;
  readonly credentials_ref?: string;
  readonly pubsub_subscription?: string;
  readonly owner_email?: string;
  readonly owner_space_id?: string;
  readonly pairing?: boolean;
  readonly pairing_classification?: string;
  readonly default_group_mode?: string;
  readonly groups?: Record<string, { readonly mode: string }>;
  readonly user_classifications?: Record<string, string>;
  readonly respond_to_unclassified?: boolean;
}

/** Validate and coerce a group mode string, defaulting to "mentioned-only". */
function validateGroupMode(mode: string | undefined): GroupMode {
  if (mode && VALID_GROUP_MODES.has(mode)) return mode as GroupMode;
  if (mode) {
    log.warn(
      "Google Chat invalid default_group_mode, falling back to mentioned-only",
      {
        operation: "validateGroupMode",
        invalidValue: mode,
      },
    );
  }
  return "mentioned-only";
}

/** Reset session and notify owner on /clear command. */
function handleGoogleChatClearCommand(
  adapter: ReturnType<typeof createGoogleChatChannel>,
  deps: ChannelWiringDeps,
  sessionId: string | undefined,
): void {
  const { chatSession, notificationService } = deps;
  log.warn("Google Chat /clear: session reset by owner", {
    operation: "handleGoogleChatClearCommand",
    sessionId,
  });
  chatSession.clear();
  adapter.send({
    content:
      "Session cleared. Your context and taint level have been reset to PUBLIC.\n\nWhat would you like to do?",
    sessionId,
  }).then(() => notificationService.flushPending("owner" as UserId))
    .catch((err) =>
      log.error("Google Chat /clear session reset send failed", {
        operation: "handleGoogleChatClearCommand",
        err,
        sessionId,
      })
    );
}

/** Handle incoming Google Chat messages, dispatching to owner or external. */
function handleGoogleChatMessage(
  msg: ChannelMessage,
  adapter: ReturnType<typeof createGoogleChatChannel>,
  deps: ChannelWiringDeps,
): void {
  const { chatSession } = deps;

  if (msg.content === "/clear" && msg.isOwner === true) {
    handleGoogleChatClearCommand(adapter, deps, msg.sessionId);
    return;
  }

  if (msg.isOwner === true) {
    const sendEvent = buildSendEvent(adapter, "Google Chat", msg);
    chatSession.executeAgentTurn(msg.content, sendEvent)
      .catch((err) =>
        log.error("Google Chat owner executeAgentTurn failed", {
          operation: "handleGoogleChatMessage",
          err,
          sessionId: msg.sessionId,
        })
      );
  } else {
    chatSession.handleChannelMessage(msg, "googlechat")
      .catch((err) =>
        log.error("Google Chat external handleChannelMessage failed", {
          operation: "handleGoogleChatMessage",
          err,
          sessionId: msg.sessionId,
        })
      );
  }
}

/** Register Google Chat notification channel for owner. */
function registerGoogleChatNotifications(
  notificationService: NotificationService,
  adapter: ReturnType<typeof createGoogleChatChannel>,
  ownerSpaceId: string | undefined,
): void {
  if (!ownerSpaceId) return;

  const sessionId = `googlechat-${encodeSpaceName(ownerSpaceId)}`;
  notificationService.registerChannel({
    name: "googlechat",
    send: (msg) => adapter.send({ content: msg, sessionId }),
  });
}

/**
 * Wire and connect Google Chat channel adapter.
 *
 * The `credentials_ref` field must be a `secret:<key>` reference.
 * The wiring layer resolves it at startup via the secret store,
 * and provides a token provider callback to the adapter.
 *
 * @param googlechatConfig - Google Chat config from triggerfish.yaml.
 * @param deps - Shared channel wiring dependencies.
 * @param resolveToken - Token provider callback that resolves the credentials_ref to a bearer token.
 */
export async function wireGoogleChatChannel(
  googlechatConfig: GoogleChatChannelConfig,
  deps: ChannelWiringDeps,
  resolveToken: () => Promise<string>,
): Promise<void> {
  if (
    !googlechatConfig.credentials_ref || !googlechatConfig.pubsub_subscription
  ) {
    log.warn(
      "Google Chat channel configured but credentials_ref or pubsub_subscription is missing",
      {
        operation: "wireGoogleChatChannel",
        hasCredentialsRef: !!googlechatConfig.credentials_ref,
        hasPubsubSubscription: !!googlechatConfig.pubsub_subscription,
      },
    );
    return;
  }

  const { chatSession, channelAdapters } = deps;
  const classification = resolveChannelClassification({
    channel: "googlechat",
    field: "classification",
    raw: googlechatConfig.classification,
    fallback: "INTERNAL",
  });

  const getAccessToken = resolveToken;

  const defaultGroupMode = validateGroupMode(
    googlechatConfig.default_group_mode,
  );

  const googlechatAdapter = createGoogleChatChannel({
    getAccessToken,
    pubsubSubscription: googlechatConfig.pubsub_subscription,
    ownerEmail: googlechatConfig.owner_email,
    classification,
    pairing: googlechatConfig.pairing,
    defaultGroupMode,
    groups: googlechatConfig.groups as Record<
      string,
      { readonly mode: "always" | "mentioned-only" | "owner-only" }
    >,
  });

  await chatSession.registerChannel("googlechat", {
    adapter: googlechatAdapter,
    channelName: "Google Chat",
    classification,
    userClassifications: googlechatConfig.user_classifications,
    respondToUnclassified: googlechatConfig.respond_to_unclassified,
    pairing: googlechatConfig.pairing,
    pairingClassification: resolveChannelClassification({
      channel: "googlechat",
      field: "pairing_classification",
      raw: googlechatConfig.pairing_classification,
      fallback: "INTERNAL",
    }),
  });

  googlechatAdapter.onMessage((msg) =>
    handleGoogleChatMessage(msg, googlechatAdapter, deps)
  );

  registerGoogleChatNotifications(
    deps.notificationService,
    googlechatAdapter,
    googlechatConfig.owner_space_id,
  );

  await googlechatAdapter.connect();
  channelAdapters.set("googlechat", {
    adapter: googlechatAdapter,
    classification,
    name: "Google Chat",
  });
  log.info("Google Chat channel connected");
}
