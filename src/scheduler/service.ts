/**
 * Scheduler service — ties together cron jobs, triggers, and webhooks.
 *
 * Runs a cron tick loop (every 60s), a periodic trigger that reads
 * TRIGGER.md, and handles inbound webhook HTTP requests. Each scheduled
 * execution spawns an isolated orchestrator session via the injected
 * OrchestratorFactory.
 *
 * Types and interfaces live in `service_types.ts`. Domain logic is
 * split across `service_cron.ts`, `service_trigger.ts`,
 * `service_webhooks.ts`, and `service_output.ts`.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import { createCronManager } from "./cron/cron.ts";
import type { CronManager } from "./cron/parser.ts";
import { createTrigger } from "./triggers/trigger.ts";
import type { Trigger } from "./triggers/trigger.ts";
import { createWebhookHandler } from "./webhooks/webhooks.ts";
import type { WebhookHandler } from "./webhooks/webhooks.ts";
import { createRateLimiter } from "./webhooks/rate_limiter.ts";
import type { RateLimiter } from "./webhooks/rate_limiter.ts";
import { createReplayGuard } from "./webhooks/replay_guard.ts";
import type { ReplayGuard } from "./webhooks/replay_guard.ts";
import { createLogger } from "../core/logger/mod.ts";
import type {
  SchedulerService,
  SchedulerServiceConfig,
  WebhookRequestContext,
} from "./service_types.ts";
import { tickCronJobs } from "./service_cron.ts";
import { invokeTriggerCallback } from "./service_trigger.ts";
import {
  dispatchWebhookSession,
  verifyWebhookRequest,
} from "./service_webhooks.ts";

// ─── Barrel re-exports from service_types.ts ─────────────────────────────────

export type {
  OrchestratorCreateOptions,
  OrchestratorFactory,
  SchedulerService,
  SchedulerServiceConfig,
  WebhookRequestContext,
  WebhookSourceConfig,
} from "./service_types.ts";

// ─── Mutable scheduler state ─────────────────────────────────────────────────

/** Mutable state shared across scheduler lifecycle methods. */
interface SchedulerState {
  cronTickId: number | undefined;
  trigger: Trigger | undefined;
}

/** Bundled scheduler infrastructure passed to lifecycle helpers. */
interface SchedulerInfra {
  readonly state: SchedulerState;
  readonly config: SchedulerServiceConfig;
  readonly cronManager: CronManager;
}

/** Options for processing an inbound webhook request. */
interface ProcessWebhookOptions {
  readonly config: SchedulerServiceConfig;
  readonly webhookHandler: WebhookHandler;
  readonly sourceId: string;
  readonly body: string;
  readonly context: WebhookRequestContext;
  readonly replayGuard: ReplayGuard;
  readonly getRateLimiter: (sourceId: string) => RateLimiter;
}

// ─── Lifecycle helpers ───────────────────────────────────────────────────────

const log = createLogger("scheduler");

/** Start the cron tick loop (immediate tick + every 60s). */
function startCronLoop(infra: SchedulerInfra): void {
  if (infra.state.cronTickId !== undefined) return;
  tickCronJobs(infra.config, infra.cronManager);
  infra.state.cronTickId = setInterval(
    () => tickCronJobs(infra.config, infra.cronManager),
    60_000,
  );
}

/** Start the trigger timer if enabled and not already running. */
function startTriggerLoop(infra: SchedulerInfra): void {
  const { state, config } = infra;
  if (!config.trigger.enabled || state.trigger !== undefined) return;
  state.trigger = createTrigger({
    intervalMs: config.trigger.intervalMinutes * 60 * 1000,
    callback: () => invokeTriggerCallback(config),
    classificationCeiling: config.trigger.classificationCeiling,
    quietHours: config.trigger.quietHours,
  });
  state.trigger.start();
}

/** Stop all running cron and trigger timers. */
function stopSchedulerTimers(state: SchedulerState): void {
  if (state.cronTickId !== undefined) {
    clearInterval(state.cronTickId);
    state.cronTickId = undefined;
  }
  if (state.trigger !== undefined) {
    state.trigger.stop();
    state.trigger = undefined;
  }
}

/** Handle an inbound webhook HTTP request end-to-end. */
async function processWebhookRequest(
  options: ProcessWebhookOptions,
): Promise<Result<void, string>> {
  const {
    config,
    webhookHandler,
    sourceId,
    body,
    context,
    replayGuard,
    getRateLimiter,
  } = options;
  const validation = await verifyWebhookRequest({
    config,
    sourceId,
    body,
    context,
    replayGuard,
    getRateLimiter,
  });
  if (!validation.ok) return validation;
  const { event, classification } = validation.value;
  await dispatchWebhookSession({
    config,
    sourceId,
    body,
    event,
    classification,
  });
  await webhookHandler.handleWebhookEvent(event);
  return { ok: true, value: undefined };
}

// ─── Service assembly ────────────────────────────────────────────────────────

/**
 * Create a scheduler service that manages cron jobs, triggers, and webhooks.
 *
 * The service uses the OrchestratorFactory to spawn isolated sessions
 * for each scheduled execution. Cron jobs are checked every 60 seconds.
 * The trigger reads TRIGGER.md and fires at the configured interval.
 */
export function createSchedulerService(
  config: SchedulerServiceConfig,
): SchedulerService {
  const cronManager = config.cronManager ?? createCronManager();
  const webhookHandler = createWebhookHandler();
  const state: SchedulerState = { cronTickId: undefined, trigger: undefined };
  const infra: SchedulerInfra = { state, config, cronManager };

  const replayGuard = createReplayGuard(
    config.webhooks.replayGuardSize ?? 10_000,
  );
  const rateLimiters = new Map<string, RateLimiter>();

  function getRateLimiter(sourceId: string): RateLimiter {
    if (!rateLimiters.has(sourceId)) {
      const source = config.webhooks.sources[sourceId];
      const rlConfig = source?.rateLimit ?? config.webhooks.rateLimit ?? {
        perMinute: 60,
        burst: 10,
      };
      rateLimiters.set(sourceId, createRateLimiter(rlConfig));
    }
    return rateLimiters.get(sourceId)!;
  }

  return {
    cronManager,
    webhookHandler,
    start: () => {
      startCronLoop(infra);
      startTriggerLoop(infra);
    },
    stop: () => stopSchedulerTimers(state),
    async runTrigger() {
      log.info("Forced trigger run requested");
      await invokeTriggerCallback(config);
    },
    handleWebhookRequest: (sourceId, body, context) =>
      processWebhookRequest({
        config,
        webhookHandler,
        sourceId,
        body,
        context,
        replayGuard,
        getRateLimiter,
      }),
  };
}
