/**
 * Scheduler module: cron jobs, triggers, webhook handling, and service.
 *
 * @module
 */

export {
  createCronManager,
  createPersistentCronManager,
  type CronExpression,
  type CronJob,
  type CronJobExecution,
  type CronJobOptions,
  type CronManager,
  matchesNow,
  parseCronExpression,
} from "./cron/mod.ts";

export {
  createTrigger,
  type QuietHours,
  type Trigger,
  type TriggerOptions,
} from "./triggers/mod.ts";

export {
  computeHmac,
  createRateLimiter,
  createReplayGuard,
  createWebhookHandler,
  type RateLimiter,
  type RateLimiterConfig,
  type ReplayGuard,
  verifyHmacAsync,
  type WebhookEvent,
  type WebhookEventHandler,
  type WebhookHandler,
  type WebhookSource,
} from "./webhooks/mod.ts";

export {
  createSchedulerService,
  type OrchestratorFactory,
  type SchedulerService,
  type SchedulerServiceConfig,
  type WebhookRequestContext,
  type WebhookSourceConfig,
} from "./service.ts";

export { signWebhook, verifyWebhookSignature } from "./webhooks/mod.ts";

export {
  createTriggerStore,
  type TriggerResult,
  type TriggerStore,
} from "./triggers/mod.ts";
