/**
 * Webhook endpoint handler for inbound webhook events.
 *
 * Provides HMAC signature validation per source, event-to-task routing,
 * per-source classification assignment, and isolated session spawning
 * for each webhook event.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";

/** Inbound webhook event structure. */
export interface WebhookEvent {
  readonly event: string;
  readonly data: unknown;
}

/** Handler function for a specific event type. */
export type WebhookEventHandler = (event: WebhookEvent) => Promise<void>;

/** Webhook source configuration. */
export interface WebhookSource {
  readonly id: string;
  readonly name: string;
  readonly secret: string;
  readonly classification: ClassificationLevel;
}

/** Webhook handler that routes events to registered handlers. */
export interface WebhookHandler {
  /** Register a handler for a specific event type. */
  on(eventType: string, handler: WebhookEventHandler): void;
  /** Handle an inbound webhook event by routing to the appropriate handler. */
  handleWebhookEvent(event: WebhookEvent): Promise<void>;
}

/**
 * Verify an HMAC-SHA256 signature asynchronously using the Web Crypto API.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param body - The raw request body string
 * @param signature - The signature header value (e.g., "sha256=abcdef...")
 * @param secret - The shared secret for HMAC computation
 * @returns Promise resolving to true if the signature is valid
 */
export async function verifyHmacAsync(
  body: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const sigParts = signature.split("=");
  if (sigParts.length < 2 || sigParts[0] !== "sha256") {
    return false;
  }

  const providedHex = sigParts.slice(1).join("=");
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body),
  );

  const expectedHex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expectedHex.length !== providedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Compose the timestamp-bound webhook signing payload.
 *
 * Signing `timestamp + "." + body` binds the freshness window into the
 * signature: a captured signature cannot be replayed with a fresh
 * timestamp, because changing the timestamp invalidates the HMAC.
 */
export function composeSignedWebhookPayload(
  timestamp: string,
  body: string,
): string {
  return `${timestamp}.${body}`;
}

/** Outcome of webhook signature verification. */
export interface WebhookHmacVerdict {
  /** True when the signature matched one of the accepted schemes. */
  readonly valid: boolean;
  /**
   * Which scheme matched: "timestamped" (signature covers
   * `timestamp + "." + body` — preferred) or "body" (body-only
   * fallback for senders that cannot sign the timestamp, e.g.
   * GitHub-style; the persistent replay guard is the primary
   * replay control for those). Null when invalid.
   */
  readonly scheme: "timestamped" | "body" | null;
}

/**
 * Verify a webhook signature, preferring the timestamp-bound scheme.
 *
 * When a timestamp is provided, `timestamp + "." + body` is verified
 * first. Body-only signatures require an explicit legacy opt-in, because
 * they do not authenticate freshness. Both use constant-time comparison.
 */
export async function verifyWebhookHmac(options: {
  readonly body: string;
  readonly signature: string;
  readonly secret: string;
  readonly timestamp?: string;
  readonly allowBodySignature?: boolean;
}): Promise<WebhookHmacVerdict> {
  if (options.timestamp) {
    const timestamped = await verifyHmacAsync(
      composeSignedWebhookPayload(options.timestamp, options.body),
      options.signature,
      options.secret,
    );
    if (timestamped) return { valid: true, scheme: "timestamped" };
  }
  const bodyOnly = options.allowBodySignature === true && await verifyHmacAsync(
    options.body,
    options.signature,
    options.secret,
  );
  if (bodyOnly) return { valid: true, scheme: "body" };
  return { valid: false, scheme: null };
}

/**
 * Compute the timestamp-bound webhook signature.
 *
 * Returns "sha256=<hex>" over `timestamp + "." + body` — the preferred
 * scheme senders should use. Useful for generating test fixtures.
 */
export function computeTimestampedHmac(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  return computeHmac(composeSignedWebhookPayload(timestamp, body), secret);
}

/**
 * Compute an HMAC-SHA256 hex digest for a body using a secret.
 *
 * Returns the signature in the format "sha256=<hex>".
 * Useful for generating test fixtures.
 */
export async function computeHmac(
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
}

/**
 * Create a new webhook handler for routing inbound events.
 *
 * Events are dispatched to registered handlers by event type.
 * Unrecognized event types are silently ignored.
 */
export function createWebhookHandler(): WebhookHandler {
  const handlers = new Map<string, WebhookEventHandler[]>();

  return {
    on(eventType: string, handler: WebhookEventHandler): void {
      const existing = handlers.get(eventType) ?? [];
      handlers.set(eventType, [...existing, handler]);
    },

    async handleWebhookEvent(event: WebhookEvent): Promise<void> {
      const eventHandlers = handlers.get(event.event);
      if (!eventHandlers) return;

      for (const handler of eventHandlers) {
        await handler(event);
      }
    },
  };
}
