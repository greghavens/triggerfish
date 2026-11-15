/**
 * Discord channel adapter wiring for gateway startup.
 *
 * @module
 */

import type { UserId } from "../../../core/types/session.ts";
import type { ChannelMessage } from "../../../channels/types.ts";
import { createDiscordChannel } from "../../../channels/discord/adapter.ts";
import { buildSendEvent } from "../../chat.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import { resolveChannelClassification } from "./channels_shared.ts";
import type { NotificationService } from "../../notifications/notifications.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("startup-channels-discord");

/** Discord channel config from triggerfish.yaml. */
export interface DiscordChannelConfig {
  readonly botToken?: string;
  readonly ownerId?: string;
  readonly classification?: string;
  readonly user_classifications?: Record<string, string>;
  readonly respond_to_unclassified?: boolean;
}

/** Reset session and notify owner on /clear command. */
function handleDiscordClearCommand(
  adapter: ReturnType<typeof createDiscordChannel>,
  chatSession: ChannelWiringDeps["chatSession"],
  notificationService: NotificationService,
  sessionId: string | undefined,
): void {
  chatSession.clear();
  adapter.send({
    content:
      "Session cleared. Your context and taint level have been reset to PUBLIC.\n\nWhat would you like to do?",
    sessionId: sessionId,
  }).then(() => notificationService.flushPending("owner" as UserId))
    .catch((err) => log.error("Discord /clear session reset send failed", err));
}

/** Handle incoming Discord messages, dispatching commands and chat. */
function handleDiscordMessage(
  msg: ChannelMessage,
  adapter: ReturnType<typeof createDiscordChannel>,
  deps: ChannelWiringDeps,
): void {
  const { chatSession, notificationService } = deps;

  if (msg.content === "/clear" && msg.isOwner === true) {
    handleDiscordClearCommand(
      adapter,
      chatSession,
      notificationService,
      msg.sessionId,
    );
    return;
  }

  if (msg.isOwner === true) {
    const sendEvent = buildSendEvent(adapter, "Discord", msg);
    chatSession.executeAgentTurn(msg.content, sendEvent)
      .catch((err) => log.error("Discord owner executeAgentTurn failed", err));
  } else {
    chatSession.handleChannelMessage(msg, "discord")
      .catch((err) =>
        log.error("Discord external handleChannelMessage failed", err)
      );
  }
}

/** Wire and connect Discord channel adapter. */
export async function wireDiscordChannel(
  discordConfig: DiscordChannelConfig,
  deps: ChannelWiringDeps,
): Promise<void> {
  if (!discordConfig.botToken) {
    log.warn("Discord channel configured but botToken is missing or empty");
    return;
  }

  const { chatSession, channelAdapters } = deps;
  const classification = resolveChannelClassification({
    channel: "discord",
    field: "classification",
    raw: discordConfig.classification,
    fallback: "PUBLIC",
  });

  log.info("Discord channel configured, connecting...");
  try {
    const discordAdapter = createDiscordChannel({
      botToken: discordConfig.botToken,
      ownerId: discordConfig.ownerId,
      classification,
    });

    await chatSession.registerChannel("discord", {
      adapter: discordAdapter,
      channelName: "Discord",
      classification,
      userClassifications: discordConfig.user_classifications,
      respondToUnclassified: discordConfig.respond_to_unclassified,
    });

    discordAdapter.onMessage((msg) =>
      handleDiscordMessage(msg, discordAdapter, deps)
    );

    await discordAdapter.connect();
    channelAdapters.set("discord", {
      adapter: discordAdapter,
      classification,
      name: "Discord",
    });
    log.info("Discord channel connected");
  } catch (err) {
    log.error("Discord channel failed to connect:", err);
  }
}
