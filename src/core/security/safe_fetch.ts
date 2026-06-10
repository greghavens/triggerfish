/**
 * safeFetch — SSRF-enforced HTTP fetch wrapper.
 *
 * Validates a URL against the SSRF denylist (DNS resolution + IP check)
 * before making any outbound HTTP request, AND re-validates every redirect
 * hop. Redirects are followed manually so a permitted host cannot 3xx-bounce
 * the request to a private/reserved address (e.g. cloud-metadata 169.254.169.254).
 * Returns a Result to avoid thrown exceptions.
 *
 * Use this as the building block for any new code that needs outbound HTTP.
 * Never call `fetch()` directly on user-controlled or config-provided URLs.
 *
 * @module
 */

import type { Result } from "../types/classification.ts";
import { resolveAndCheck } from "./ssrf.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("security");

/** DNS resolver + SSRF checker function signature (injectable for testing). */
export type SsrfChecker = (hostname: string) => Promise<Result<string, string>>;

/** Maximum number of redirect hops to follow before failing closed. */
const MAX_SSRF_REDIRECTS = 5;

/** HTTP status codes that represent a redirect carrying a Location header. */
function isRedirectStatus(status: number): boolean {
  return (
    status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308
  );
}

/**
 * Validate a URL's protocol and run the SSRF check on its resolved host.
 *
 * @param urlStr - The URL to validate (must be http or https)
 * @param ssrfChecker - Override SSRF checker for testing (default: resolveAndCheck)
 * @returns Ok with the normalized URL, or Err describing why it is blocked
 */
export async function validateOutboundUrl(
  urlStr: string,
  ssrfChecker: SsrfChecker = resolveAndCheck,
): Promise<Result<string, string>> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: `Invalid URL: ${urlStr}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }
  const ssrfResult = await ssrfChecker(parsed.hostname);
  if (!ssrfResult.ok) return { ok: false, error: ssrfResult.error };
  return { ok: true, value: parsed.href };
}

/** Resolve a redirect Location against the current URL, returning the next URL. */
function resolveRedirectTarget(
  response: Response,
  currentUrl: string,
): Result<string, string> {
  const location = response.headers.get("location");
  if (!location) {
    return {
      ok: false,
      error: `Redirect ${response.status} missing Location header`,
    };
  }
  try {
    return { ok: true, value: new URL(location, currentUrl).href };
  } catch {
    return { ok: false, error: `Invalid redirect Location: ${location}` };
  }
}

/**
 * Fetch a URL with SSRF prevention enforced on the initial request AND on
 * every redirect hop.
 *
 * Redirects are followed manually (`redirect: "manual"`) so the resolved IP of
 * each hop's destination is re-checked against the SSRF denylist before the
 * next request is made. Fails closed when the hop budget is exhausted.
 *
 * @param url - The URL to fetch (must be http or https)
 * @param options - Standard RequestInit fetch options; the redirect mode is forced
 * @param ssrfChecker - Override SSRF checker for testing (default: resolveAndCheck)
 * @param maxRedirects - Maximum redirect hops to follow before failing
 * @returns Result<Response, string> — Err if any hop fails the SSRF/protocol check
 */
export async function safeFetchWithRedirects(
  url: string | URL,
  options?: RequestInit,
  ssrfChecker: SsrfChecker = resolveAndCheck,
  maxRedirects: number = MAX_SSRF_REDIRECTS,
): Promise<Result<Response, string>> {
  let currentUrl = url instanceof URL ? url.href : url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateOutboundUrl(currentUrl, ssrfChecker);
    if (!validated.ok) return validated;
    let response: Response;
    try {
      response = await fetch(currentUrl, { ...options, redirect: "manual" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch failed: ${detail}` };
    }
    if (!isRedirectStatus(response.status)) {
      return { ok: true, value: response };
    }
    await response.body?.cancel();
    const next = resolveRedirectTarget(response, currentUrl);
    if (!next.ok) return next;
    currentUrl = next.value;
  }
  return { ok: false, error: `Too many redirects (>${MAX_SSRF_REDIRECTS})` };
}

/**
 * Fetch a URL with SSRF prevention enforced.
 *
 * Resolves the URL's hostname via DNS and checks all returned IP addresses
 * against the hardcoded SSRF denylist before making the request, and on every
 * redirect hop. Blocks if any resolved IP is private/reserved.
 *
 * @param url - The URL to fetch (must be http or https)
 * @param options - Standard RequestInit fetch options
 * @param ssrfChecker - Override SSRF checker for testing (default: resolveAndCheck)
 * @returns Result<Response, string> — Err if SSRF check fails, URL is invalid, or fetch throws
 */
export async function safeFetch(
  url: string | URL,
  options?: RequestInit,
  ssrfChecker: SsrfChecker = resolveAndCheck,
): Promise<Result<Response, string>> {
  return await safeFetchWithRedirects(url, options, ssrfChecker);
}

/**
 * Build a `fetch`-compatible function with SSRF prevention enforced.
 *
 * Adapts the Result-based safeFetch to the web-standard fetch signature so it
 * can be injected into clients that accept a `fetchFn: typeof fetch`. A
 * blocked or failed request surfaces as a thrown Error — matching fetch's own
 * network-error contract — so callers' existing catch-based handling applies.
 * Request-object inputs are rejected: callers must pass a URL so every hop
 * can be re-validated.
 *
 * @param ssrfChecker - Override SSRF checker for testing (default: resolveAndCheck)
 * @returns A drop-in `fetch` replacement that fails closed on SSRF violations
 */
export function createSsrfCheckedFetch(
  ssrfChecker: SsrfChecker = resolveAndCheck,
): typeof fetch {
  return async (
    input: URL | Request | string,
    init?: RequestInit,
  ): Promise<Response> => {
    if (input instanceof Request) {
      throw new Error(
        "SSRF-checked fetch requires a URL input, not a Request object",
      );
    }
    const result = await safeFetchWithRedirects(input, init, ssrfChecker);
    if (!result.ok) {
      log.warn("Outbound fetch blocked by SSRF-checked fetch", {
        url: input.toString(),
        reason: result.error,
      });
      throw new Error(`Outbound fetch blocked: ${result.error}`);
    }
    return result.value;
  };
}
