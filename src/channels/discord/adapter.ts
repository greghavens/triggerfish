/**
 * Discord channel adapter using discord.js.
 *
 * Connects to Discord via bot token and routes incoming messages
 * to the message handler. Supports Discord's 2000-character limit
 * with automatic message chunking.
 *
 * @module
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createLogger } from "../../core/logger/logger.ts";
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

const log = createLogger("discord");

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

/** Build a discord.js Client with the required gateway intents. */
function buildDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
}

/** Derive owner status and session taint from a Discord message sender. */
function resolveDiscordSenderContext(
  senderId: string,
  ownerId: string | undefined,
): {
  readonly isOwner: boolean;
  readonly sessionTaint: ClassificationLevel | undefined;
} {
  const isOwner = ownerId !== undefined ? senderId === ownerId : true;
  return {
    isOwner,
    sessionTaint: isOwner ? undefined : ("PUBLIC" as ClassificationLevel),
  };
}

/** Register a messageCreate listener that forwards messages to the handler ref. */
function attachDiscordMessageListener(
  client: Client,
  ownerId: string | undefined,
  handlerRef: { current: MessageHandler | null },
): void {
  client.on("messageCreate", (message) => {
    if (message.author.bot) return;
    if (!handlerRef.current) return;

    const { isOwner, sessionTaint } = resolveDiscordSenderContext(
      message.author.id,
      ownerId,
    );
    log.ext("DEBUG", "Message received", {
      channelId: message.channelId,
      senderId: message.author.id,
      guildId: message.guildId ?? "",
    });
    const isGroup = message.guildId !== null;
    const groupId = isGroup ? message.channelId : undefined;
    handlerRef.current({
      content: message.content,
      sessionId: isGroup
        ? `discord-group-${message.channelId}`
        : `discord-${message.channelId}`,
      senderId: message.author.id,
      isOwner,
      sessionTaint,
      isGroup,
      groupId,
    });
  });
}

/** Send chunked text to a Discord channel by session ID. */
async function sendDiscordMessage(
  client: Client,
  message: ChannelMessage,
): Promise<void> {
  if (!message.sessionId) return;

  const channelId = message.sessionId.replace("discord-group-", "").replace("discord-", "");
  const channel = await client.channels.fetch(channelId);

  if (!channel || !("send" in channel)) return;

  const chunks = chunkMessage(message.content, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await (channel as { send: (content: string) => Promise<unknown> }).send(
      chunk,
    );
  }
}

/** Send a typing indicator to a Discord channel by session ID. */
async function sendDiscordTypingIndicator(
  client: Client,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  const channelId = sessionId.replace("discord-group-", "").replace("discord-", "");
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && "sendTyping" in channel) {
      await (channel as { sendTyping: () => Promise<void> }).sendTyping();
    }
  } catch (err: unknown) {
    log.debug("Discord typing indicator send failed", {
      channelId,
      error: err,
    });
  }
}

/** Mutable connection state shared between adapter methods. */
interface DiscordAdapterState {
  connected: boolean;
  readonly handlerRef: { current: MessageHandler | null };
}

/** Connect the Discord client and mark the adapter as connected. */
async function connectDiscordClient(
  client: Client,
  botToken: string,
  state: DiscordAdapterState,
): Promise<void> {
  await client.login(botToken);
  state.connected = true;
  log.info("Discord adapter connected");
}

/** Disconnect the Discord client and mark the adapter as disconnected. */
async function disconnectDiscordClient(
  client: Client,
  state: DiscordAdapterState,
): Promise<void> {
  await client.destroy();
  state.connected = false;
  log.info("Discord adapter disconnected");
}

/** Assemble the DiscordChannelAdapter method object. */
function assembleDiscordAdapter(
  client: Client,
  config: DiscordConfig,
  classification: ClassificationLevel,
  state: DiscordAdapterState,
): DiscordChannelAdapter {
  return {
    classification,
    isOwner: true,
    connect: () => connectDiscordClient(client, config.botToken, state),
    disconnect: () => disconnectDiscordClient(client, state),
    send: (message: ChannelMessage) => sendDiscordMessage(client, message),
    onMessage(msgHandler: MessageHandler): void {
      state.handlerRef.current = msgHandler;
    },
    status: (): ChannelStatus => ({
      connected: state.connected,
      channelType: "discord",
    }),
    sendTyping: (sessionId: string) =>
      sendDiscordTypingIndicator(client, sessionId),
  };
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
export function createDiscordChannel(
  config: DiscordConfig,
): DiscordChannelAdapter {
  const classification = (config.classification ??
    "PUBLIC") as ClassificationLevel;
  const state: DiscordAdapterState = {
    connected: false,
    handlerRef: { current: null },
  };
  const client = buildDiscordClient();
  attachDiscordMessageListener(client, config.ownerId, state.handlerRef);
  return assembleDiscordAdapter(client, config, classification, state);
}
