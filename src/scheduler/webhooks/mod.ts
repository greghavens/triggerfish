/**
 * Webhook handling: HMAC verification, event routing, and signing.
 *
 * @module
 */

export {
  composeSignedWebhookPayload,
  computeHmac,
  computeTimestampedHmac,
  createWebhookHandler,
  verifyHmacAsync,
  verifyWebhookHmac,
  type WebhookEvent,
  type WebhookEventHandler,
  type WebhookHandler,
  type WebhookHmacVerdict,
  type WebhookSource,
} from "./webhooks.ts";

export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterConfig,
} from "./rate_limiter.ts";

export {
  createReplayGuard,
  type ReplayGuard,
  type ReplayGuardOptions,
} from "./replay_guard.ts";
