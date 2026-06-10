/**
 * Google Chat channel adapter via PubSub pull delivery.
 *
 * Receives incoming messages by polling a Google Cloud PubSub subscription
 * and sends replies via the Google Chat API. No permanent public endpoint
 * required — all connections are outbound.
 *
 * Follows the same polling pattern as the Email/IMAP adapter.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import type { GoogleChatConfig, PubSubAckFn, PubSubPullFn } from "./types.ts";
import {
  createPubSubAcknowledger,
  createPubSubPuller,
  parseGoogleChatEventData,
  sendGoogleChatMessage,
  sendGoogleChatTyping,
} from "./client.ts";
import { dispatchGoogleChatEvent, spaceNameFromSessionId } from "./dispatch.ts";

const log = createLogger("googlechat");

/** Default poll interval in milliseconds. */
const DEFAULT_POLL_INTERVAL = 5000;

/** Extended Google Chat adapter with typing indicator support. */
export interface GoogleChatChannelAdapter extends ChannelAdapter {
  /** Send a typing indicator to the given session. */
  sendTyping(sessionId: string): Promise<void>;
}

/** Mutable state shared across Google Chat adapter helpers. */
interface GoogleChatAdapterState {
  connected: boolean;
  handler: MessageHandler | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  readonly pullFn: PubSubPullFn;
  readonly ackFn: PubSubAckFn;
}

// ─── Polling logic ──────────────────────────────────────────────────────────

/** Poll PubSub for new messages and dispatch them. */
async function pollGoogleChatMessages(
  state: GoogleChatAdapterState,
  config: GoogleChatConfig,
): Promise<void> {
  if (!state.handler) return;

  try {
    const response = await state.pullFn(
      config.pubsubSubscription,
      10,
    );

    const messages = response.receivedMessages ?? [];
    if (messages.length === 0) return;

    const ackIds: string[] = [];

    for (const received of messages) {
      const event = parseGoogleChatEventData(received.message.data);
      if (!event) {
        log.warn("Google Chat PubSub message parse failed, not acknowledging", {
          operation: "pollGoogleChatMessages",
          ackId: received.ackId,
        });
        continue;
      }

      ackIds.push(received.ackId);
      dispatchGoogleChatEvent(event, state.handler, config);
    }

    if (ackIds.length > 0) {
      await state.ackFn(config.pubsubSubscription, ackIds);
    }
  } catch (err: unknown) {
    log.warn("Google Chat PubSub poll failed", {
      operation: "pollGoogleChatMessages",
      err,
    });
  }
}

/** Schedule the next poll after the current one completes (prevents overlap). */
function schedulePollLoop(
  state: GoogleChatAdapterState,
  config: GoogleChatConfig,
): void {
  if (!state.connected) return;
  state.pollTimer = setTimeout(async () => {
    await pollGoogleChatMessages(state, config);
    schedulePollLoop(state, config);
  }, DEFAULT_POLL_INTERVAL);
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a Google Chat channel adapter.
 *
 * Receives messages via PubSub pull and sends replies via the Chat API.
 * Each conversation is mapped to a session ID based on the space name.
 *
 * @param config - Google Chat adapter configuration.
 * @returns A GoogleChatChannelAdapter wired to Google Chat.
 */
export function createGoogleChatChannel(
  config: GoogleChatConfig,
): GoogleChatChannelAdapter {
  const classification = (config.classification ??
    "INTERNAL") as ClassificationLevel;

  const state: GoogleChatAdapterState = {
    connected: false,
    handler: null,
    pollTimer: null,
    pullFn: config._pullFn ?? createPubSubPuller(config),
    ackFn: config._ackFn ?? createPubSubAcknowledger(config),
  };
  return {
    classification,
    // Ownership is decided per-message (ChannelMessage.isOwner), never here.
    isOwner: false,

    async connect(): Promise<void> {
      state.connected = true;
      await pollGoogleChatMessages(state, config);
      schedulePollLoop(state, config);
      log.info("Google Chat adapter connected", {
        subscription: config.pubsubSubscription,
      });
    },

    disconnect(): Promise<void> {
      if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
      }
      state.connected = false;
      log.info("Google Chat adapter disconnected");
      return Promise.resolve();
    },

    async send(message: ChannelMessage): Promise<void> {
      if (!message.sessionId) return;
      const spaceName = spaceNameFromSessionId(message.sessionId);
      if (!spaceName) return;
      try {
        await sendGoogleChatMessage(config, spaceName, message.content);
        log.info("Google Chat message delivered", {
          operation: "send",
          sessionId: message.sessionId,
          spaceId: spaceName,
        });
      } catch (err: unknown) {
        log.error("Google Chat message delivery failed", {
          operation: "send",
          err,
          sessionId: message.sessionId,
          spaceId: spaceName,
        });
        throw err;
      }
    },

    onMessage(handler: MessageHandler): void {
      state.handler = handler;
    },

    status(): ChannelStatus {
      return { connected: state.connected, channelType: "googlechat" };
    },

    sendTyping(sessionId: string): Promise<void> {
      if (!sessionId) return Promise.resolve();
      const spaceName = spaceNameFromSessionId(sessionId);
      if (!spaceName) return Promise.resolve();
      sendGoogleChatTyping(spaceName);
      return Promise.resolve();
    },
  };
}
