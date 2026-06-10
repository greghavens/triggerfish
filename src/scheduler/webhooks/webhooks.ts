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
