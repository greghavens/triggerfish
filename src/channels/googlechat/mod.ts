/**
 * Google Chat channel adapter module.
 *
 * Exports the adapter factory, types, and client utilities
 * for Google Chat integration via PubSub pull delivery.
 *
 * @module
 */

export type { GoogleChatChannelAdapter } from "./adapter.ts";
export { createGoogleChatChannel } from "./adapter.ts";

export type {
  AccessTokenProvider,
  GoogleChatAnnotation,
  GoogleChatApiMessage,
  GoogleChatConfig,
  GoogleChatEvent,
  GoogleChatMembership,
  GoogleChatSender,
  GoogleChatSpace,
  PubSubAckFn,
  PubSubPullFn,
  PubSubPullResponse,
  PubSubReceivedMessage,
} from "./types.ts";

export {
  createPubSubAcknowledger,
  createPubSubPuller,
  parseGoogleChatEventData,
  sendGoogleChatMessage,
  sendGoogleChatTyping,
} from "./client.ts";

export { createGoogleChatSenderVerifier } from "./verify.ts";
export type {
  GoogleChatSenderVerifier,
  GoogleChatVerifiedMessage,
  GoogleChatVerifyError,
} from "./verify.ts";
