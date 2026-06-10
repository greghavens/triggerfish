/**
 * Telegram channel adapter wiring for gateway startup.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { UserId } from "../../../core/types/session.ts";
import type { ChannelMessage } from "../../../channels/types.ts";
import { createTelegramChannel } from "../../../channels/telegram/adapter.ts";
import { buildSendEvent } from "../../chat.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import { resolveChannelClassification } from "./channels_shared.ts";
import type { NotificationService } from "../../notifications/notifications.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-channels-telegram");

/** Telegram channel config from triggerfish.yaml. */
export interface TelegramChannelConfig {
  readonly botToken?: string;
  readonly ownerId?: number;
  readonly classification?: string;
  readonly user_classifications?: Record<string, string>;
  readonly respond_to_unclassified?: boolean;
}

/** Respond to the /start command with a greeting. */
function respondToStartCommand(
  adapter: ReturnType<typeof createTelegramChannel>,
  sessionId: string | undefined,
): void {
  adapter.send({
    content: "Triggerfish connected. You can chat with me here.",
    sessionId: sessionId,
  }).catch((err) => log.error("Telegram /start greeting send failed", err));
}

/** Reset session and notify owner on /clear command. */
function handleClearCommand(
  adapter: ReturnType<typeof createTelegramChannel>,
  chatSession: ChannelWiringDeps["chatSession"],
  notificationService: NotificationService,
  sessionId: string | undefined,
): void {
  chatSession.clear();
  adapter.clearChat(sessionId ?? "")
    .then(() =>
      adapter.send({
        content:
          "Session cleared. Your context and taint level have been reset to PUBLIC.\n\nWhat would you like to do?",
        sessionId: sessionId,
      })
    )
    .then(() => notificationService.flushPending("owner" as UserId))
    .catch((err) => log.error("Telegram /clear session reset failed", err));
}

/** Handle incoming Telegram messages, dispatching commands and chat. */
function handleTelegramMessage(
  msg: ChannelMessage,
  adapter: ReturnType<typeof createTelegramChannel>,
  deps: ChannelWiringDeps,
): void {
  const { chatSession, notificationService } = deps;

  if (msg.content === "/start") {
    respondToStartCommand(adapter, msg.sessionId);
    return;
  }

  if (msg.content === "/clear" && msg.isOwner === true) {
    handleClearCommand(
      adapter,
      chatSession,
      notificationService,
      msg.sessionId,
    );
    return;
  }

  if (msg.isOwner === true) {
    const sendEvent = buildSendEvent(adapter, "Telegram", msg);
    chatSession.executeAgentTurn(msg.content, sendEvent)
      .catch((err) => log.error("Telegram owner executeAgentTurn failed", err));
  } else {
    chatSession.handleChannelMessage(msg, "telegram")
      .catch((err) =>
        log.error("Telegram external handleChannelMessage failed", err)
      );
  }
}

/** Register Telegram notification channel for owner. */
function registerTelegramNotifications(opts: {
  readonly notificationService: NotificationService;
  readonly adapter: ReturnType<typeof createTelegramChannel>;
  readonly ownerId: number | undefined;
  readonly classification: ClassificationLevel;
}): void {
  const ownerChatId = opts.ownerId ? `telegram-${opts.ownerId}` : undefined;
  if (!ownerChatId) return;

  opts.notificationService.registerChannel({
    name: "telegram",
    classification: opts.classification,
    send: (msg) => opts.adapter.send({ content: msg, sessionId: ownerChatId }),
  });
}

/** Wire and connect Telegram channel adapter. */
export async function wireTelegramChannel(
  telegramConfig: TelegramChannelConfig,
  deps: ChannelWiringDeps,
): Promise<void> {
  if (!telegramConfig.botToken) return;

  const { chatSession, channelAdapters } = deps;
  const classification = resolveChannelClassification({
    channel: "telegram",
    field: "classification",
    raw: telegramConfig.classification,
    fallback: "PUBLIC",
  });

  const telegramAdapter = createTelegramChannel({
    botToken: telegramConfig.botToken,
    ownerId: telegramConfig.ownerId,
    classification,
  });

  await chatSession.registerChannel("telegram", {
    adapter: telegramAdapter,
    channelName: "Telegram",
    classification,
    userClassifications: telegramConfig.user_classifications,
    respondToUnclassified: telegramConfig.respond_to_unclassified,
  });

  telegramAdapter.onMessage((msg) =>
    handleTelegramMessage(msg, telegramAdapter, deps)
  );

  registerTelegramNotifications({
    notificationService: deps.notificationService,
    adapter: telegramAdapter,
    ownerId: telegramConfig.ownerId,
    classification,
  });

  await telegramAdapter.connect();
  channelAdapters.set("telegram", {
    adapter: telegramAdapter,
    classification,
    name: "Telegram",
  });
  log.info("Telegram channel connected");
}
