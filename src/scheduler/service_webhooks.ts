/**
 * Scheduler webhook processing — validates inbound webhook HTTP
 * requests and executes them in isolated orchestrator sessions.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../core/types/classification.ts";
import type { WebhookEvent } from "./webhooks/webhooks.ts";
import type {
  SchedulerServiceConfig,
  WebhookRequestContext,
} from "./service_types.ts";
import type { RateLimiter } from "./webhooks/rate_limiter.ts";
import type { ReplayGuard } from "./webhooks/replay_guard.ts";
import { verifyHmacAsync } from "./webhooks/webhooks.ts";
import { deliverSchedulerOutput } from "./service_output.ts";
import { logSchedulerTokenUsage } from "./service_cron.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("scheduler.webhook");

/** Parsed and validated webhook payload. */
interface ValidatedWebhook {
  readonly event: WebhookEvent;
  readonly classification: ClassificationLevel;
}

/** Options for validating an inbound webhook request. */
interface WebhookValidationOptions {
  readonly config: SchedulerServiceConfig;
  readonly sourceId: string;
  readonly body: string;
  readonly context: WebhookRequestContext;
  readonly replayGuard: ReplayGuard;
  readonly getRateLimiter: (sourceId: string) => RateLimiter;
}

/** Options for executing a webhook in an orchestrator session. */
interface WebhookExecutionOptions {
  readonly config: SchedulerServiceConfig;
  readonly sourceId: string;
  readonly body: string;
  readonly event: WebhookEvent;
  readonly classification: ClassificationLevel;
}

/**
 * Validate a webhook request using a 6-step enforcement chain (cheapest first):
 * 1. Webhooks enabled check
 * 2. Source lookup
 * 3. Rate limit check (fast in-memory, before crypto)
 * 4. Timestamp validation (arithmetic, before HMAC)
 * 5. HMAC signature verification
 * 6. Replay detection (after HMAC — signature is the nonce)
 */
export async function verifyWebhookRequest(
  options: WebhookValidationOptions,
): Promise<Result<ValidatedWebhook, string>> {
  const { config, sourceId, body, context, replayGuard, getRateLimiter } =
    options;

  if (!config.webhooks.enabled) {
    return { ok: false, error: "Webhooks are disabled" };
  }

  const source = config.webhooks.sources[sourceId];
  if (!source) {
    return { ok: false, error: `Unknown webhook source: ${sourceId}` };
  }

  if (!getRateLimiter(sourceId).allowRequest(sourceId)) {
    log.warn(`Webhook rate limit exceeded: source=${sourceId}`);
    return { ok: false, error: `Rate limit exceeded for source: ${sourceId}` };
  }

  const maxAgeMs = config.webhooks.maxAgeMs ?? 300_000;
  if (maxAgeMs > 0) {
    const ts = Number(context.timestamp);
    const age = Date.now() - ts;
    if (!context.timestamp || isNaN(age) || age > maxAgeMs || age < 0) {
      log.warn(
        `Webhook timestamp rejected: source=${sourceId} timestamp=${context.timestamp} age=${age}ms maxAgeMs=${maxAgeMs}`,
      );
      return { ok: false, error: "Webhook timestamp missing or expired" };
    }
  }

  const valid = await verifyHmacAsync(body, context.signature, source.secret);
  if (!valid) {
    log.warn(`Webhook HMAC verification failed: source=${sourceId}`);
    return { ok: false, error: "Invalid HMAC signature" };
  }

  if (replayGuard.hasSeenSignature(context.signature)) {
    log.warn(`Webhook replay detected: source=${sourceId}`);
    return { ok: false, error: "Replay detected: duplicate webhook rejected" };
  }
  replayGuard.recordSignature(context.signature);

  return parseWebhookBody(body, source.classification);
}

/** Parse a JSON webhook body into a WebhookEvent. */
function parseWebhookBody(
  body: string,
  classification: ClassificationLevel,
): Result<ValidatedWebhook, string> {
  try {
    const parsed = JSON.parse(body);
    return {
      ok: true,
      value: {
        event: {
          event: parsed.event ?? "unknown",
          data: parsed.data ?? parsed,
        },
        classification,
      },
    };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

/** Build the prompt message for a webhook event. */
function buildWebhookPrompt(
  sourceId: string,
  event: WebhookEvent,
  body: string,
): string {
  return `Webhook event from ${sourceId}: ${event.event}\n\nPayload:\n${body}`;
}

/** Execute a webhook event in an isolated orchestrator session. */
export async function dispatchWebhookSession(
  options: WebhookExecutionOptions,
): Promise<void> {
  const { config, sourceId, body, event, classification } = options;
  try {
    const { orchestrator, session } = await config.orchestratorFactory.create(
      `webhook-${sourceId}`,
    );
    const result = await orchestrator.executeAgentTurn({
      session,
      message: buildWebhookPrompt(sourceId, event, body),
      targetClassification: classification,
    });
    logSchedulerTokenUsage(`webhook:${sourceId}`, result);
    await deliverSchedulerOutput({
      config,
      result,
      sessionTaint: session.taint,
      source: `webhook:${sourceId}`,
    });
  } catch (err) {
    log.error(
      `Webhook session execution failed: source=${sourceId} error=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** @deprecated Use verifyWebhookRequest instead */
export const validateWebhookRequest = verifyWebhookRequest;

/** @deprecated Use dispatchWebhookSession instead */
export const executeWebhookSession = dispatchWebhookSession;
