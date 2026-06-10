/**
 * WebSocket upgrade authentication and Origin validation helpers.
 *
 * Pure, deterministic functions usable by both the gateway server and
 * channel adapters. All auth decisions are side-effect free — same input
 * always produces the same output, no LLM calls, no async.
 *
 * @module
 */

import { timingSafeEqual } from "./hmac.ts";

/**
 * Extract a bearer token from an upgrade request.
 *
 * Checks the `Authorization: Bearer <token>` header first; falls back to
 * the `token` query parameter. Returns `null` when neither is present.
 * Header takes precedence over the query parameter.
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return new URL(request.url).searchParams.get("token");
}

/**
 * Determine whether an `Origin` header value is permitted by the configured allowlist.
 *
 * - `"*"` in the list permits all origins (wildcard).
 * - `"null"` in the list permits requests with no Origin header (e.g. file:// pages).
 * - A `null` origin (missing header) is only allowed when `"null"` is explicitly listed.
 */
export function isOriginAllowed(
  origin: string | null,
  allowedOrigins: readonly string[],
): boolean {
  if (allowedOrigins.includes("*")) return true;
  if (origin === null) return allowedOrigins.includes("null");
  return allowedOrigins.includes(origin);
}

/**
 * Validate a WebSocket upgrade request against the configured token and Origin policy.
 *
 * Returns a rejection `Response` (401 or 403) if the request must be refused,
 * or `null` if the upgrade may proceed.
 *
 * Auth is only enforced when the respective option is configured:
 * - `options.token` set → bearer token required; missing or wrong token → 401
 * - `options.allowedOrigins` non-empty → Origin must match; mismatch → 403
 */
export function rejectWebSocketUpgrade(
  request: Request,
  options: {
    readonly token?: string;
    readonly allowedOrigins?: readonly string[];
  },
): Response | null {
  if (options.token) {
    const provided = extractBearerToken(request);
    if (provided === null || !timingSafeEqual(provided, options.token)) {
      return new Response("Unauthorized", { status: 401 });
    }
  }
  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    const origin = request.headers.get("origin");
    if (!isOriginAllowed(origin, options.allowedOrigins)) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  return null;
}
