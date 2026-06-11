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
  composeSignedWebhookPayload,
  computeHmac,
  computeTimestampedHmac,
  createRateLimiter,
  createReplayGuard,
  createWebhookHandler,
  type RateLimiter,
  type RateLimiterConfig,
  type ReplayGuard,
  type ReplayGuardOptions,
  verifyHmacAsync,
  verifyWebhookHmac,
  type WebhookEvent,
  type WebhookEventHandler,
  type WebhookHandler,
  type WebhookHmacVerdict,
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

export {
  createTriggerStore,
  type TriggerResult,
  type TriggerStore,
} from "./triggers/mod.ts";
