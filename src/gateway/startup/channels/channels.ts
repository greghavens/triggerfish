/**
 * Channel adapter wiring barrel for gateway startup.
 *
 * Delegates Telegram, Discord, and Signal channel setup to
 * dedicated modules and re-exports their public APIs.
 *
 * @module
 */

import type { TriggerFishConfig } from "../../../core/config.ts";
import type { createChatSession } from "../../chat.ts";
import type { RegisteredChannel } from "../../tools/session/session_tools.ts";
import type { createNotificationService } from "../../notifications/notifications.ts";
import { createKeychain, resolveSecretRef } from "../../../core/secrets/mod.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import { wireTelegramChannel } from "./channels_telegram.ts";
import type { TelegramChannelConfig } from "./channels_telegram.ts";
import { wireDiscordChannel } from "./channels_discord.ts";
import type { DiscordChannelConfig } from "./channels_discord.ts";
import { wireSignalChannel } from "./channels_signal.ts";
import type {
  SignalChannelConfig,
  SignalDaemonState,
} from "./channels_signal.ts";
import { wireGoogleChatChannel } from "./channels_googlechat.ts";
import type { GoogleChatChannelConfig } from "./channels_googlechat.ts";

const log = createLogger("startup-channels");

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { ChannelWiringDeps } from "./channels_shared.ts";
export type { TelegramChannelConfig } from "./channels_telegram.ts";
export { wireTelegramChannel } from "./channels_telegram.ts";
export type { DiscordChannelConfig } from "./channels_discord.ts";
export { wireDiscordChannel } from "./channels_discord.ts";
export type {
  SignalChannelConfig,
  SignalDaemonState,
} from "./channels_signal.ts";
export { wireSignalChannel } from "./channels_signal.ts";
export type { GoogleChatChannelConfig } from "./channels_googlechat.ts";
export { wireGoogleChatChannel } from "./channels_googlechat.ts";
export type {
  ValidatedWhatsAppConfig,
  WhatsAppChannelConfig,
} from "./channels_whatsapp.ts";
export {
  isValidatedWhatsAppConfig,
  wireWhatsAppChannel,
} from "./channels_whatsapp.ts";

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Warn at startup when an owner-bearing channel has no owner identifier.
 *
 * The adapters fail closed (no sender is ever the owner without a configured
 * identifier), so the channel is wired non-owner-only. This guard makes that
 * default-deny decision visible to the operator.
 */
function warnChannelWiredWithoutOwner(
  channel: string,
  ownerId: string | number | undefined,
): void {
  if (ownerId !== undefined && String(ownerId).length > 0) return;
  log.warn(
    "Channel wired without an owner identifier — every sender is treated as a non-owner (fail closed)",
    {
      operation: "wireChannels",
      channel,
    },
  );
}

/**
 * Wire all configured messaging channels (Telegram, Discord, Signal, Google Chat).
 *
 * Returns Signal daemon state for shutdown cleanup.
 */
export async function wireChannels(
  config: TriggerFishConfig,
  chatSession: ReturnType<typeof createChatSession>,
  notificationService: ReturnType<typeof createNotificationService>,
  channelAdapters: Map<string, RegisteredChannel>,
): Promise<SignalDaemonState> {
  const channelDeps: ChannelWiringDeps = {
    chatSession,
    notificationService,
    channelAdapters,
  };

  const telegramConfig = config.channels?.telegram as
    | TelegramChannelConfig
    | undefined;
  if (telegramConfig?.botToken) {
    warnChannelWiredWithoutOwner("telegram", telegramConfig.ownerId);
    await wireTelegramChannel(telegramConfig, channelDeps);
  }

  const discordConfig = config.channels?.discord as
    | DiscordChannelConfig
    | undefined;
  if (discordConfig) {
    warnChannelWiredWithoutOwner("discord", discordConfig.ownerId);
    await wireDiscordChannel(discordConfig, channelDeps);
  }

  const googlechatConfig = config.channels?.googlechat as
    | GoogleChatChannelConfig
    | undefined;
  if (googlechatConfig?.enabled && googlechatConfig?.credentials_ref) {
    const credRef = googlechatConfig.credentials_ref;
    const keychain = createKeychain();
    // Resolves the secret ref to a bearer token. For service accounts using
    // OAuth2, callers should store the pre-exchanged access token in the
    // keychain. A future enhancement may add JWT signing / token exchange here.
    const resolveToken = async () => {
      const result = await resolveSecretRef(credRef, keychain);
      if (!result.ok) {
        log.error("Google Chat credentials_ref resolution failed", {
          operation: "wireChannels",
          err: result.error,
        });
        throw new Error(
          `Google Chat credential resolution failed: ${result.error}`,
        );
      }
      return result.value as string;
    };
    await wireGoogleChatChannel(googlechatConfig, channelDeps, resolveToken);
  }

  const signalConfig = config.channels?.signal as
    | SignalChannelConfig
    | undefined;
  return signalConfig
    ? wireSignalChannel(signalConfig, channelDeps)
    : { handle: null };
}
