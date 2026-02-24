/**
 * Slack channel adapter using Bolt.
 *
 * Connects to Slack via the Bolt framework and routes incoming messages
 * to the message handler. Supports Slack's block-based messaging and
 * respects the 40,000-character message limit.
 *
 * @module
 */

import SlackBolt from "@slack/bolt";
const { App: SlackApp } = SlackBolt;
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("slack");

/** Maximum message length for Slack. */
const MAX_MESSAGE_LENGTH = 40000;

/** Configuration for the Slack channel adapter. */
export interface SlackConfig {
  /** Slack Bot Token (xoxb-...). */
  readonly botToken: string;
  /** Slack App Token for socket mode (xapp-...). */
  readonly appToken: string;
  /** Slack Signing Secret. */
  readonly signingSecret: string;
  /** Classification level for this channel. Default: PUBLIC */
  readonly classification?: ClassificationLevel;
  /** Owner's Slack user ID (e.g. U01234ABC). */
  readonly ownerId?: string;
}

/** Mutable connection state shared between adapter methods. */
interface SlackAdapterState {
  connected: boolean;
  readonly handlerRef: { current: MessageHandler | null };
}

/** Build a Bolt SlackApp configured for socket mode. */
function buildSlackApp(config: SlackConfig): InstanceType<typeof SlackApp> {
  return new SlackApp({
    token: config.botToken,
    appToken: config.appToken,
    signingSecret: config.signingSecret,
    socketMode: true,
  });
}

/** Register a message listener that forwards incoming Slack messages. */
function attachSlackMessageListener(
  app: InstanceType<typeof SlackApp>,
  ownerId: string | undefined,
  handlerRef: { current: MessageHandler | null },
): void {
  // deno-lint-ignore require-await
  app.message(async ({ message }) => {
    if (!handlerRef.current) return;

    const msg = message as { text?: string; user?: string; channel?: string; channel_type?: string };
    if (!msg.text || !msg.channel) return;

    const isOwner = ownerId !== undefined ? msg.user === ownerId : true;
    const isGroup = msg.channel_type !== "im";
    const groupId = isGroup ? msg.channel : undefined;

    log.ext("DEBUG", "Message received", {
      channel: msg.channel,
      senderId: msg.user ?? "",
    });
    handlerRef.current({
      content: msg.text,
      sessionId: isGroup
        ? `slack-group-${msg.channel}`
        : `slack-${msg.channel}`,
      senderId: msg.user,
      isOwner,
      sessionTaint: isOwner ? undefined : ("PUBLIC" as ClassificationLevel),
      isGroup,
      groupId,
    });
  });
}

/** Send a truncated text message to a Slack channel. */
async function sendSlackMessage(
  app: InstanceType<typeof SlackApp>,
  message: ChannelMessage,
): Promise<void> {
  if (!message.sessionId) return;

  const channelId = message.sessionId.replace("slack-group-", "").replace("slack-", "");
  const text = message.content.length > MAX_MESSAGE_LENGTH
    ? message.content.slice(0, MAX_MESSAGE_LENGTH)
    : message.content;

  await app.client.chat.postMessage({ channel: channelId, text });
}

/** Connect the Slack Bolt app and mark the adapter as connected. */
async function connectSlackApp(
  app: InstanceType<typeof SlackApp>,
  state: SlackAdapterState,
): Promise<void> {
  await app.start();
  state.connected = true;
  log.info("Slack adapter connected");
}

/** Disconnect the Slack Bolt app and mark the adapter as disconnected. */
async function disconnectSlackApp(
  app: InstanceType<typeof SlackApp>,
  state: SlackAdapterState,
): Promise<void> {
  await app.stop();
  state.connected = false;
  log.info("Slack adapter disconnected");
}

/** Assemble the ChannelAdapter method object for Slack. */
function assembleSlackAdapter(
  app: InstanceType<typeof SlackApp>,
  classification: ClassificationLevel,
  state: SlackAdapterState,
): ChannelAdapter {
  return {
    classification,
    isOwner: true,
    connect: () => connectSlackApp(app, state),
    disconnect: () => disconnectSlackApp(app, state),
    send: (message: ChannelMessage) => sendSlackMessage(app, message),
    onMessage(msgHandler: MessageHandler): void {
      state.handlerRef.current = msgHandler;
    },
    status: (): ChannelStatus => ({
      connected: state.connected,
      channelType: "slack",
    }),
  };
}

/**
 * Create a Slack channel adapter.
 *
 * Uses Bolt to connect via Socket Mode. Listens for messages in all
 * channels the bot is added to.
 *
 * @param config - Slack app configuration.
 * @returns A ChannelAdapter wired to Slack.
 */
export function createSlackChannel(config: SlackConfig): ChannelAdapter {
  const classification = (config.classification ??
    "PUBLIC") as ClassificationLevel;
  const state: SlackAdapterState = {
    connected: false,
    handlerRef: { current: null },
  };
  const app = buildSlackApp(config);
  attachSlackMessageListener(app, config.ownerId, state.handlerRef);
  return assembleSlackAdapter(app, classification, state);
}
