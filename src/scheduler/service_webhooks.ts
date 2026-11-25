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
  SchedulerExecutionIdentity,
  SchedulerServiceConfig,
  WebhookRequestContext,
} from "./service_types.ts";
import type { RateLimiter } from "./webhooks/rate_limiter.ts";
import type { ReplayGuard } from "./webhooks/replay_guard.ts";
import { verifyWebhookHmac } from "./webhooks/webhooks.ts";
import { deliverSchedulerOutput } from "./service_output.ts";
import { logSchedulerTokenUsage } from "./service_cron.ts";
import { reportSchedulerGoalEvidence } from "./service_goal_completion.ts";
import {
  createScheduledAgent,
  runSchedulerOccurrence,
  schedulerExecutionIdentity,
} from "./service_execution.ts";
import {
  prepareWebhookAdmission,
  sameWebhookAdmission,
  webhookAdmissionPolicy,
} from "./webhooks/admissions.ts";
import type {
  WebhookAdmission,
  WebhookAdmissionClaim,
} from "./webhooks/admissions.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("scheduler.webhook");

/** Parsed and validated webhook payload. */
interface ValidatedWebhook {
  readonly event: WebhookEvent;
  readonly classification: ClassificationLevel;
  readonly admission?: WebhookAdmission;
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
  readonly execution?: SchedulerExecutionIdentity;
}

/**
 * Validate a webhook request using a 6-step enforcement chain (cheapest first):
 * 1. Webhooks enabled check
 * 2. Source lookup
 * 3. Rate limit check (fast in-memory, before crypto)
 * 4. Timestamp validation (arithmetic, before HMAC)
 * 5. HMAC signature verification — prefers the timestamp-bound scheme
 *    (`timestamp + "." + body`) so a captured signature cannot be replayed
 *    with a fresh timestamp; body-only accepted as fallback for senders
 *    that cannot sign the timestamp (e.g. GitHub-style)
 * 6. Replay detection (after HMAC — signature is the nonce; persisted via
 *    StorageProvider when configured, so it survives daemon restarts and
 *    is the primary control for body-only signers)
 */
export async function verifyWebhookRequest(
  options: WebhookValidationOptions,
): Promise<Result<ValidatedWebhook, string>> {
  const { config, sourceId, body, context, replayGuard, getRateLimiter } =
    options;

  if (!config.webhooks.enabled) {
    return { ok: false, error: "Webhooks are disabled" };
  }

  const source = webhookAdmissionPolicy(config.webhooks, sourceId);
  if (!source) {
    return { ok: false, error: `Unknown webhook source: ${sourceId}` };
  }

  if (!getRateLimiter(sourceId).allowRequest(sourceId)) {
    log.warn(`Webhook rate limit exceeded: source=${sourceId}`);
    return { ok: false, error: `Rate limit exceeded for source: ${sourceId}` };
  }

  const { maxAgeMs } = source;
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

  const verdict = await verifyWebhookHmac({
    body,
    signature: context.signature,
    secret: source.secret,
    timestamp: context.timestamp,
    allowBodySignature: source.allowBodySignature,
  });
  if (!verdict.valid) {
    log.warn(`Webhook HMAC verification failed: source=${sourceId}`);
    return { ok: false, error: "Invalid HMAC signature" };
  }
  if (verdict.scheme === "body") {
    log.info(
      `Webhook verified with body-only signature (no timestamp binding): source=${sourceId} — replay guard is the primary control`,
    );
  }

  if (!await replayGuard.claimSignature(context.signature)) {
    log.warn(`Webhook replay detected: source=${sourceId}`);
    return { ok: false, error: "Replay detected: duplicate webhook rejected" };
  }

  const parsed = parseWebhookBody(body, source.ceiling);
  if (!parsed.ok || !config.recoverTurn || !config.webhookAdmissions) {
    return parsed;
  }
  try {
    const { id } = schedulerExecutionIdentity(
      "webhook",
      sourceId,
      context.signature,
    );
    const prompt = buildWebhookPrompt(sourceId, parsed.value.event, body);
    const currentPolicy = webhookAdmissionPolicy(config.webhooks, sourceId);
    const admission = prepareWebhookAdmission(id, sourceId, prompt, source);
    if (
      !currentPolicy || !sameWebhookAdmission(
        admission,
        prepareWebhookAdmission(id, sourceId, prompt, currentPolicy),
      )
    ) return { ok: false, error: "Webhook source authorization changed" };
    return { ok: true, value: { ...parsed.value, admission } };
  } catch {
    return { ok: false, error: "Webhook delivery could not be prepared" };
  }
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
): Promise<boolean> {
  const { config, sourceId, body, event, classification } = options;
  const recoverable = !!config.recoverTurn && options.execution !== undefined;
  try {
    // The source's configured classification is an enforced read ceiling
    // for the session, not just an output gate (SCHEDULER-1).
    const { orchestrator, session, getSessionTaint } =
      await createScheduledAgent(
        config,
        `webhook-${sourceId}`,
        { ceiling: classification },
        options.execution,
      );
    const result = await orchestrator.executeAgentTurn({
      session,
      message: buildWebhookPrompt(sourceId, event, body),
      targetClassification: classification,
    });
    if (recoverable && !result.ok) return false;
    if (config.goalCompletion) {
      await reportSchedulerGoalEvidence(config.goalCompletion, {
        kind: "webhook",
        sourceId,
        sessionId: session.id,
        classification: getSessionTaint(),
      });
    }
    logSchedulerTokenUsage(`webhook:${sourceId}`, result);
    await deliverSchedulerOutput({
      config,
      result,
      // Live taint after the turn — the session snapshot is stale (GATEWAY-1).
      sessionTaint: getSessionTaint(),
      source: `webhook:${sourceId}`,
    });
    return true;
  } catch (err) {
    if (options.execution) {
      log.error("Webhook session failed", {
        executionId: options.execution.id,
      });
    } else {
      log.error(
        `Webhook session execution failed: source=${sourceId} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return !recoverable;
  }
}

/** Execute a verified delivery after reserving its exact admission. */
export async function dispatchVerifiedWebhook(
  config: SchedulerServiceConfig,
  sourceId: string,
  body: string,
  validated: ValidatedWebhook,
  signature: string,
): Promise<Result<{ delivered: boolean; executionId?: string }, string>> {
  const execution = config.recoverTurn || config.executionTracePath
    ? schedulerExecutionIdentity("webhook", sourceId, signature)
    : undefined;
  const options = { config, sourceId, body, ...validated, execution };
  if (!config.recoverTurn || !execution || !config.webhookAdmissions) {
    return {
      ok: true,
      value: { delivered: await dispatchWebhookSession(options) },
    };
  }
  try {
    const admission = validated.admission;
    if (!admission || admission.id !== execution.id) {
      return { ok: false, error: "Webhook delivery could not be admitted" };
    }
    const claim = config.webhookAdmissions.admit(admission);
    if (!claim) {
      return {
        ok: false,
        error: "Replay detected: duplicate webhook rejected",
      };
    }
    log.info("Recoverable webhook delivery admitted", {
      executionId: execution.id,
    });
    return {
      ok: true,
      value: {
        delivered: await dispatchClaimedWebhook(options, claim),
        executionId: execution.id,
      },
    };
  } catch {
    log.error("Webhook admission journal failed", {
      executionId: execution.id,
    });
    return { ok: false, error: "Webhook admission journal unavailable" };
  }
}

async function dispatchClaimedWebhook(
  options: WebhookExecutionOptions,
  claim: WebhookAdmissionClaim,
): Promise<boolean> {
  let delivered = false;
  try {
    await runSchedulerOccurrence(
      options.config,
      options.execution,
      async () => {
        delivered = await dispatchWebhookSession(options);
      },
    );
    return delivered;
  } finally {
    options.config.webhookAdmissions?.settle(claim, delivered);
  }
}

/** Validate an out-of-band recovery body without claiming the delivery. */
export function verifyWebhookRecoveryBody(
  config: SchedulerServiceConfig,
  executionId: string,
  body: string,
) {
  const admission = config.webhookAdmissions?.readPending(executionId);
  if (!admission) return undefined;
  const { sourceId } = admission;
  const policy = webhookAdmissionPolicy(config.webhooks, sourceId);
  if (!policy) return undefined;
  const parsed = parseWebhookBody(body, policy.ceiling);
  if (!parsed.ok) return undefined;
  const { event, classification } = parsed.value;
  const expected = prepareWebhookAdmission(
    executionId,
    sourceId,
    buildWebhookPrompt(sourceId, event, body),
    policy,
  );
  if (!sameWebhookAdmission(admission, expected)) return undefined;
  return { expected, sourceId, event, classification };
}

/** Reopen only an admitted webhook from a trusted operator entry point. */
export async function resumeWebhookExecution(
  config: SchedulerServiceConfig,
  executionId: string,
  body: string,
  resumePaused = false,
): Promise<Result<void, string>> {
  const journal = config.webhookAdmissions;
  const rejected = {
    ok: false,
    error: "Webhook recovery unavailable for this delivery",
  } as const;
  if (!journal || !config.recoverTurn) return rejected;
  try {
    const verified = verifyWebhookRecoveryBody(config, executionId, body);
    if (!verified) return rejected;
    const { expected, sourceId, event, classification } = verified;
    const claim = journal.claim(expected);
    if (!claim) return rejected;
    const delivered = await dispatchClaimedWebhook({
      config,
      sourceId,
      body,
      event,
      classification,
      execution: {
        id: executionId,
        kind: "webhook",
        sourceId,
        resumeOnly: true,
        ...(resumePaused && { resumePaused: true }),
      },
    }, claim);
    return delivered ? { ok: true, value: undefined } : rejected;
  } catch {
    return rejected;
  }
}
