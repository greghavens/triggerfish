/**
 * Discord channel adapter using discord.js.
 *
 * Connects to Discord via bot token and routes incoming messages
 * to the message handler. Supports Discord's 2000-character limit
 * with automatic message chunking.
 *
 * @module
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import { chunkMessage } from "../telegram/adapter.ts";

/** Maximum message length for Discord. */
const MAX_MESSAGE_LENGTH = 2000;

/** Configuration for the Discord channel adapter. */
export interface DiscordConfig {
  /** Discord Bot Token. */
  readonly botToken: string;
  /** Classification level for this channel. Default: PUBLIC */
  readonly classification?: ClassificationLevel;
  /** Owner's Discord user ID (snowflake). */
  readonly ownerId?: string;
}

/** Extended Discord adapter with typing indicator support. */
export interface DiscordChannelAdapter extends ChannelAdapter {
  /** Send a typing indicator to the given Discord channel. */
  sendTyping(sessionId: string): Promise<void>;
}

/**
 * Create a Discord channel adapter.
 *
 * Uses discord.js to connect to the Discord gateway. Listens for
 * messages in all channels/DMs the bot has access to.
 *
 * @param config - Discord bot configuration.
 * @returns A DiscordChannelAdapter wired to Discord.
 */
export function createDiscordChannel(config: DiscordConfig): DiscordChannelAdapter {
  const classification = (config.classification ?? "PUBLIC") as ClassificationLevel;
  const ownerId = config.ownerId;
  let connected = false;
  let handler: MessageHandler | null = null;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on("messageCreate", (message) => {
    // Ignore bot's own messages
    if (message.author.bot) return;
    if (!handler) return;

    const isOwner = ownerId !== undefined
      ? message.author.id === ownerId
      : true;

    handler({
      content: message.content,
      sessionId: `discord-${message.channelId}`,
      senderId: message.author.id,
      isOwner,
      sessionTaint: isOwner ? undefined : ("PUBLIC" as ClassificationLevel),
    });
  });

  return {
    classification,
    isOwner: true,

    async connect(): Promise<void> {
      await client.login(config.botToken);
      connected = true;
    },

    async disconnect(): Promise<void> {
      await client.destroy();
      connected = false;
    },

    async send(message: ChannelMessage): Promise<void> {
      if (!message.sessionId) return;

      const channelId = message.sessionId.replace("discord-", "");
      const channel = await client.channels.fetch(channelId);

      if (!channel || !("send" in channel)) return;

      const chunks = chunkMessage(message.content, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await (channel as { send: (content: string) => Promise<unknown> }).send(chunk);
      }
    },

    onMessage(msgHandler: MessageHandler): void {
      handler = msgHandler;
    },

    status(): ChannelStatus {
      return {
        connected,
        channelType: "discord",
      };
    },

    async sendTyping(sessionId: string): Promise<void> {
      if (!sessionId) return;
      const channelId = sessionId.replace("discord-", "");
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && "sendTyping" in channel) {
          await (channel as { sendTyping: () => Promise<void> }).sendTyping();
        }
      } catch {
        // Best-effort: typing indicators are non-critical
      }
    },
  };
}
