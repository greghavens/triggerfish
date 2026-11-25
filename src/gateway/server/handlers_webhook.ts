/**
 * Webhook HTTP request handler for the gateway.
 *
 * Routes inbound POST requests on /webhooks/:sourceId to the
 * scheduler service, extracting HMAC signatures from standard headers.
 *
 * @module
 */

import type { SchedulerService } from "../../scheduler/service_types.ts";
import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("gateway.webhook");

/** Maximum size of an incoming webhook body (1 MB). */
const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;

// ─── Webhook HTTP handler ────────────────────────────────────────────────────

/** Extract the HMAC signature from standard webhook request headers. */
function extractWebhookSignature(request: Request): string {
  return request.headers.get("x-hub-signature-256") ??
    request.headers.get("x-signature") ??
    "";
}

/** Map a webhook error message to the appropriate HTTP status code. */
function mapWebhookErrorStatus(errorMessage: string): number {
  if (errorMessage === "Webhook admission journal unavailable") return 503;
  if (errorMessage.includes("Invalid HMAC")) return 401;
  if (errorMessage.includes("Unknown webhook")) return 404;
  if (errorMessage.includes("Rate limit exceeded")) return 429;
  if (errorMessage.includes("Replay detected")) return 409;
  return 400;
}

/** Build a JSON Response with the given body and status. */
function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(
    JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** Extract the source ID from the webhook URL path. Returns empty string if missing. */
function extractWebhookSourceId(url: URL): string {
  return url.pathname.slice("/webhooks/".length);
}

/** Read request body in chunks up to maxBytes; returns error string if limit exceeded. */
async function consumeWebhookBody(
  request: Request,
  maxBytes: number,
): Promise<Result<string, string>> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: "" };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return {
          ok: false,
          error: `Webhook body too large: exceeds ${maxBytes} byte limit`,
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    return {
      ok: false,
      error: `Webhook body read failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return { ok: true, value: new TextDecoder().decode(merged) };
}

/** Forward a validated webhook request to the scheduler and build the response. */
async function forwardWebhookToScheduler(
  request: Request,
  sourceId: string,
  scheduler: SchedulerService,
): Promise<Response> {
  const signature = extractWebhookSignature(request);
  const timestamp = request.headers.get("x-timestamp") ?? undefined;
  const bodyResult = await consumeWebhookBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (!bodyResult.ok) {
    log.warn("Webhook body rejected: exceeds size limit", {
      operation: "forwardWebhookToScheduler",
      sourceId,
      limitBytes: MAX_WEBHOOK_BODY_BYTES,
    });
    return jsonResponse({ error: bodyResult.error }, 413);
  }
  const result = await scheduler.handleWebhookRequest(
    sourceId,
    bodyResult.value,
    { signature, timestamp },
  );

  if (result.ok) {
    log.debug("Webhook request accepted", { sourceId });
    return jsonResponse({
      ok: true,
      ...(result.executionId && { executionId: result.executionId }),
    }, 200);
  }
  const status = mapWebhookErrorStatus(result.error);
  log.warn("Webhook request rejected by scheduler", {
    sourceId,
    status,
    error: result.error,
  });
  return jsonResponse({ error: result.error }, status);
}

/**
 * Handle an inbound webhook HTTP request.
 *
 * Routes POST /webhooks/:sourceId to the scheduler service,
 * reading the HMAC signature from standard webhook headers.
 */
// deno-lint-ignore require-await
export async function routeWebhookHttp(
  request: Request,
  url: URL,
  scheduler: SchedulerService,
): Promise<Response> {
  const sourceId = extractWebhookSourceId(url);
  if (!sourceId) {
    return jsonResponse({ error: "Missing source ID" }, 400);
  }
  return forwardWebhookToScheduler(request, sourceId, scheduler);
}

/** Re-supply a verified delivery body over the authenticated operator route. */
export async function routeWebhookRecoveryHttp(
  request: Request,
  executionId: string,
  resume: (executionId: string, body: string) => Promise<boolean>,
): Promise<Response> {
  if (!/^scheduler-webhook-[a-f0-9]{64}$/.test(executionId)) {
    return jsonResponse({ error: "Invalid webhook execution ID." }, 400);
  }
  const body = await consumeWebhookBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) {
    return jsonResponse({ error: "Webhook body unavailable." }, 413);
  }
  try {
    if (await resume(executionId, body.value)) {
      return jsonResponse({ ok: true }, 200);
    }
  } catch {
    // Keep transport, source policy and payload details out of the operator response.
  }
  return jsonResponse({ error: "Webhook execution could not resume." }, 409);
}
