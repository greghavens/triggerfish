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

/** Per-hop policy options for safeFetchWithRedirects. */
export interface SafeFetchHopPolicy {
  /** Maximum redirect hops to follow before failing closed. */
  readonly maxRedirects?: number;
  /**
   * Domain-policy predicate re-evaluated for the initial URL and every
   * redirect target. Returning false — or throwing — blocks the hop
   * (fail closed).
   */
  readonly isUrlAllowed?: (url: string) => boolean;
}

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

/** Extract a hostname for logging without exposing the full URL. */
function extractHostnameForLog(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "<unparseable>";
  }
}

/**
 * Re-evaluate the optional domain-policy predicate for one hop.
 * A predicate that returns false — or throws — blocks the hop (fail closed).
 */
function enforceHopDomainPolicy(
  hopUrl: string,
  isUrlAllowed: ((url: string) => boolean) | undefined,
): Result<void, string> {
  if (isUrlAllowed === undefined) return { ok: true, value: undefined };
  const hostname = extractHostnameForLog(hopUrl);
  let allowed: boolean;
  try {
    allowed = isUrlAllowed(hopUrl);
  } catch (err) {
    log.warn("Domain policy predicate threw on fetch hop; failing closed", {
      operation: "enforceHopDomainPolicy",
      hostname,
      err,
    });
    return { ok: false, error: `Domain blocked by policy: ${hostname}` };
  }
  if (allowed) return { ok: true, value: undefined };
  log.warn("Domain policy blocked fetch hop", {
    operation: "enforceHopDomainPolicy",
    hostname,
  });
  return { ok: false, error: `Domain blocked by policy: ${hostname}` };
}

/** Validate one hop URL: protocol + SSRF check plus optional domain policy. */
async function validateHopUrl(
  hopUrl: string,
  ssrfChecker: SsrfChecker,
  isUrlAllowed: ((url: string) => boolean) | undefined,
): Promise<Result<string, string>> {
  const validated = await validateOutboundUrl(hopUrl, ssrfChecker);
  if (!validated.ok) return validated;
  const domainVerdict = enforceHopDomainPolicy(hopUrl, isUrlAllowed);
  if (!domainVerdict.ok) return { ok: false, error: domainVerdict.error };
  return validated;
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

/** Apply redirect method rules and prevent cross-origin credential forwarding. */
function buildRedirectOptions(context: {
  readonly from: string;
  readonly to: string;
  readonly status: number;
  readonly options?: RequestInit;
}): Result<RequestInit, string> {
  const from = new URL(context.from);
  const to = new URL(context.to);
  if (from.protocol === "https:" && to.protocol === "http:") {
    return {
      ok: false,
      error: "Fetch redirect blocked: HTTPS cannot downgrade to HTTP",
    };
  }
  const options: RequestInit = { ...context.options };
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (
    ((context.status === 301 || context.status === 302) && method === "POST") ||
    (context.status === 303 && method !== "GET" && method !== "HEAD")
  ) {
    options.method = "GET";
    options.body = undefined;
    for (
      const name of [
        "content-type",
        "content-length",
        "content-encoding",
        "content-language",
        "content-location",
      ]
    ) headers.delete(name);
  }
  if (from.origin !== to.origin) {
    if (options.body !== undefined && options.body !== null) {
      return {
        ok: false,
        error: "Fetch redirect blocked: request body cannot cross origins",
      };
    }
    for (
      const name of [
        "authorization",
        "proxy-authorization",
        "cookie",
        "cookie2",
        "host",
        "x-api-key",
        "api-key",
        "x-goog-api-key",
        "x-auth-token",
        "referer",
      ]
    ) headers.delete(name);
    options.credentials = "omit";
  }
  options.headers = headers;
  return { ok: true, value: options };
}

/**
 * Fetch a URL with SSRF prevention enforced on the initial request AND on
 * every redirect hop.
 *
 * Redirects are followed manually (`redirect: "manual"`) so the resolved IP of
 * each hop's destination is re-checked against the SSRF denylist — and the
 * optional `hopPolicy.isUrlAllowed` domain-policy predicate — before the
 * next request is made. Fails closed when the hop budget is exhausted.
 *
 * @param url - The URL to fetch (must be http or https)
 * @param options - Standard RequestInit fetch options; the redirect mode is forced
 * @param ssrfChecker - Override SSRF checker for testing (default: resolveAndCheck)
 * @param hopPolicy - Per-hop policy: redirect budget + domain-policy predicate
 * @returns Result<Response, string> — Err if any hop fails the SSRF/protocol/domain check
 */
export async function safeFetchWithRedirects(
  url: string | URL,
  options?: RequestInit,
  ssrfChecker: SsrfChecker = resolveAndCheck,
  hopPolicy?: SafeFetchHopPolicy,
): Promise<Result<Response, string>> {
  const maxRedirects = hopPolicy?.maxRedirects ?? MAX_SSRF_REDIRECTS;
  let currentUrl = url instanceof URL ? url.href : url;
  let requestOptions = options;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateHopUrl(
      currentUrl,
      ssrfChecker,
      hopPolicy?.isUrlAllowed,
    );
    if (!validated.ok) return validated;
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...requestOptions,
        redirect: "manual",
      });
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
    const redirected = buildRedirectOptions({
      from: currentUrl,
      to: next.value,
      status: response.status,
      options: requestOptions,
    });
    if (!redirected.ok) {
      log.warn("Outbound redirect blocked", {
        operation: "safeFetchWithRedirects",
        hostname: extractHostnameForLog(currentUrl),
        reason: redirected.error,
      });
      return redirected;
    }
    requestOptions = redirected.value;
    currentUrl = next.value;
  }
  return { ok: false, error: `Too many redirects (>${maxRedirects})` };
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
