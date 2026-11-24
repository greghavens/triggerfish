/**
 * Channel adapters for Triggerfish.
 *
 * Exports channel types and adapter implementations.
 *
 * @module
 */

export type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "./types.ts";

export type { CliChannel, CliChannelConfig } from "./cli/channel.ts";
export { createCliChannel } from "./cli/channel.ts";

export type { ChannelRouter } from "./router.ts";
export { createChannelRouter } from "./router.ts";

export { resolveOwnerStatus } from "./owner_status.ts";

export type { AgentState, RippleManager } from "./ripple.ts";
export { createRippleManager } from "./ripple.ts";

export type {
  GroupConfig,
  GroupManager,
  GroupMode,
  OwnerContext,
} from "./groups.ts";
export { createGroupManager } from "./groups.ts";

export type {
  TelegramChannelAdapter,
  TelegramConfig,
} from "./telegram/adapter.ts";
export { createTelegramChannel } from "./telegram/adapter.ts";
export { chunkMessage } from "./telegram/adapter.ts";

export type { SlackConfig } from "./slack/adapter.ts";
export { createSlackChannel } from "./slack/adapter.ts";

export type {
  DiscordChannelAdapter,
  DiscordConfig,
} from "./discord/adapter.ts";
export { createDiscordChannel } from "./discord/adapter.ts";

export type { WhatsAppConfig } from "./whatsapp/adapter.ts";
export { createWhatsAppChannel } from "./whatsapp/adapter.ts";

export type { WebChatConfig } from "./webchat/adapter.ts";
export { createWebChatChannel } from "./webchat/adapter.ts";

export type { EmailConfig } from "./email/adapter.ts";
export { createEmailChannel } from "./email/adapter.ts";

export type { SignalChannelAdapter, SignalConfig } from "./signal/mod.ts";
export { createSignalChannel } from "./signal/mod.ts";

export type {
  GoogleChatChannelAdapter,
  GoogleChatConfig,
} from "./googlechat/mod.ts";
export { createGoogleChatChannel } from "./googlechat/mod.ts";

export type {
  UserClassificationConfig,
  UserSessionManager,
} from "./user_sessions.ts";
export {
  createUserSessionManager,
  parseUserOverrides,
} from "./user_sessions.ts";

export type { PairingCode, PairingResult, PairingService } from "./pairing.ts";
export { createPairingService } from "./pairing.ts";

export type { UserRateLimiter, UserRateLimiterConfig } from "./rate_limiter.ts";
export { createUserRateLimiter } from "./rate_limiter.ts";
