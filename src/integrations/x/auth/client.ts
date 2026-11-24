/**
 * Authenticated HTTP client for X API v2.
 * @module
 */

import type { Result } from "../../../core/types/classification.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import { resolveAndCheck as defaultResolveAndCheck } from "../../../core/security/ssrf.ts";
import type { XRateLimiter } from "../client/rate_limiter.ts";
import type { XApiClient, XApiResult, XAuthManager } from "./types_auth.ts";

const log = createLogger("x-client");
const X_API_BASE = "https://api.twitter.com";
const MAX_ERROR_LENGTH = 500;

const ALLOWED_X_HOSTS = new Set([
  "api.twitter.com",
  "upload.twitter.com",
  "api.x.com",
]);

/** Options for an individual X API request. */
interface XApiRequestOptions {
  readonly body?: unknown;
  readonly params?: Record<string, string>;
  readonly raw?: boolean;
  readonly isRetry?: boolean;
}

/** Options for building a RequestInit with optional body. */
interface XRequestBodyOpts {
  readonly body?: unknown;
  readonly raw?: boolean;
}

/** Build fetch RequestInit with Bearer auth header and optional body. */
function buildXApiRequestInit(
  method: string,
  token: string,
  bodyOpts?: XRequestBodyOpts,
): RequestInit {
  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (!bodyOpts?.body) {
    return { method, headers: baseHeaders };
  }
  if (bodyOpts.raw) {
    return { method, headers: baseHeaders, body: bodyOpts.body as BodyInit };
  }
  return {
    method,
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(bodyOpts.body),
  };
}

/** Extract the endpoint path from a full URL for rate limit tracking. */
function extractEndpoint(url: string): string {
  try {
    return new URL(url, X_API_BASE).pathname;
  } catch (_err: unknown) {
    log.warn("URL parse failed for rate limit tracking, using raw URL", {
      operation: "extractEndpoint",
      url,
    });
    return url;
  }
}

function truncateErrorMessage(msg: string): string {
  return msg.length <= MAX_ERROR_LENGTH
    ? msg
    : msg.slice(0, MAX_ERROR_LENGTH) + "… (truncated)";
}

/** Parse error details from a non-OK X API response. */
async function parseXApiErrorResponse<T>(
  response: Response,
): Promise<XApiResult<T>> {
  let errorMessage: string;
  let errorCode = `HTTP_${response.status}`;
  try {
    const errorData = await response.json();
    const raw = errorData?.detail ?? errorData?.title ?? response.statusText;
    errorMessage = truncateErrorMessage(String(raw));
    if (errorData?.type) {
      errorCode = truncateErrorMessage(String(errorData.type));
    }
  } catch (parseErr: unknown) {
    log.warn("X API error response JSON parse failed, using statusText", {
      operation: "parseXApiErrorResponse",
      err: parseErr,
    });
    errorMessage = response.statusText;
  }
  const retryAfter = response.headers.get("retry-after");
  const retrySeconds = retryAfter && !isNaN(parseInt(retryAfter, 10))
    ? parseInt(retryAfter, 10)
    : undefined;
  return {
    ok: false,
    error: {
      code: errorCode,
      message: errorMessage,
      status: response.status,
      retryAfterSeconds: retrySeconds,
    },
  };
}

/** Parse JSON body from a successful X API response. */
async function parseXApiSuccessBody<T>(
  response: Response,
): Promise<XApiResult<T>> {
  try {
    return { ok: true, value: (await response.json()) as T };
  } catch (parseErr: unknown) {
    log.warn("X API success response JSON parse failed", {
      operation: "parseXApiSuccessBody",
      err: parseErr,
      status: response.status,
    });
    return {
      ok: false,
      error: {
        code: "PARSE_FAILED",
        message:
          `X API returned HTTP ${response.status} with invalid JSON body`,
        status: response.status,
      },
    };
  }
}

/** Parse an X API response into a typed Result. */
function parseXApiResponse<T>(response: Response): Promise<XApiResult<T>> {
  if (!response.ok) return parseXApiErrorResponse(response);
  if (response.status === 204) {
    return Promise.resolve({ ok: true as const, value: {} as T });
  }
  return parseXApiSuccessBody<T>(response);
}

/** Build the full URL from base, path, and optional query params. */
function buildFullUrl(
  baseUrl: string,
  url: string,
  params?: Record<string, string>,
): string {
  const base = url.startsWith("http") ? url : `${baseUrl}${url}`;
  if (!params || Object.keys(params).length === 0) return base;
  return `${base}?${new URLSearchParams(params).toString()}`;
}

function ssrfBlockedResult<T>(message: string): XApiResult<T> {
  return { ok: false, error: { code: "SSRF_BLOCKED", message } };
}

/** Validate hostname against allowlist and SSRF DNS check. */
async function validateRequestHost<T>(
  hostname: string,
  fullUrl: string,
  ssrfCheck: (hostname: string) => Promise<Result<string, string>>,
): Promise<XApiResult<T> | null> {
  if (!ALLOWED_X_HOSTS.has(hostname)) {
    log.error("X API request blocked: disallowed hostname", {
      operation: "xApiRequest",
      hostname,
      url: fullUrl,
    });
    return ssrfBlockedResult(
      `X API request blocked: hostname '${hostname}' not in allowlist`,
    );
  }
  const dnsCheck = await ssrfCheck(hostname);
  if (!dnsCheck.ok) {
    log.error("X API request blocked: DNS resolves to private IP", {
      operation: "xApiRequest",
      hostname,
      err: dnsCheck.error,
    });
    return ssrfBlockedResult(`X API request blocked: ${dnsCheck.error}`);
  }
  return null;
}

/** Check rate limit and return error result if exhausted. */
function checkRateLimit<T>(
  rateLimiter: XRateLimiter,
  endpoint: string,
): XApiResult<T> | null {
  const limitCheck = rateLimiter.checkLimit(endpoint);
  if (!limitCheck.ok) {
    const retryAfterSeconds = Math.max(
      0,
      limitCheck.error.resetAt - Math.floor(Date.now() / 1000),
    );
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: limitCheck.error.message,
        retryAfterSeconds,
      },
    };
  }
  return null;
}

/** Log a warning when the server returns 429. */
function logServerRateLimit(response: Response, endpoint: string): void {
  if (response.status !== 429) return;
  log.warn("X API rate limited by server", {
    operation: "xApiRequest",
    endpoint,
    retryAfter: response.headers.get("retry-after"),
  });
}

/**
 * Create an authenticated X API v2 client.
 *
 * @param authManager - Provides access tokens with auto-refresh
 * @param rateLimiter - Tracks per-endpoint rate limits from response headers
 * @param opts - Optional overrides for fetch function and base URL
 */
export function createXApiClient(
  authManager: XAuthManager,
  rateLimiter: XRateLimiter,
  opts?: {
    readonly fetchFn?: typeof globalThis.fetch;
    readonly baseUrl?: string;
    readonly ssrfCheck?: (hostname: string) => Promise<Result<string, string>>;
  },
): XApiClient {
  const fetchFn = opts?.fetchFn ?? globalThis.fetch;
  const baseUrl = opts?.baseUrl ?? X_API_BASE;
  const ssrfCheck = opts?.ssrfCheck ?? defaultResolveAndCheck;

  /** Execute fetch, record rate limit headers, return response + endpoint. */
  async function executeRequest(
    method: string,
    fullUrl: string,
    token: string,
    reqOpts?: XApiRequestOptions,
  ): Promise<{ readonly response: Response; readonly endpoint: string }> {
    const init = buildXApiRequestInit(method, token, reqOpts);
    const response = await fetchFn(fullUrl, init);
    const endpoint = extractEndpoint(fullUrl);
    rateLimiter.recordResponse(endpoint, response.headers);
    return { response, endpoint };
  }

  /** Retry a request after forcing an auth token refresh. */
  async function retryAfterRefresh<T>(
    method: string,
    url: string,
    reqOpts?: XApiRequestOptions,
  ): Promise<XApiResult<T>> {
    log.info("X API 401, forcing token refresh before retry", {
      operation: "xApiRequest",
      endpoint: url,
    });
    const refreshResult = await authManager.forceRefresh();
    if (!refreshResult.ok) return { ok: false, error: refreshResult.error };
    return request<T>(method, url, { ...reqOpts, isRetry: true });
  }

  async function request<T>(
    method: string,
    url: string,
    reqOpts?: XApiRequestOptions,
  ): Promise<XApiResult<T>> {
    const fullUrl = buildFullUrl(baseUrl, url, reqOpts?.params);
    const hostError = await validateRequestHost<T>(
      new URL(fullUrl).hostname,
      fullUrl,
      ssrfCheck,
    );
    if (hostError) return hostError;

    const rateLimitError = checkRateLimit<T>(
      rateLimiter,
      extractEndpoint(fullUrl),
    );
    if (rateLimitError) return rateLimitError;

    const tokenResult = await authManager.getAccessToken();
    if (!tokenResult.ok) return { ok: false, error: tokenResult.error };

    const { response, endpoint } = await executeRequest(
      method,
      fullUrl,
      tokenResult.value,
      reqOpts,
    );
    if (response.status === 401 && !reqOpts?.isRetry) {
      return retryAfterRefresh<T>(method, url, reqOpts);
    }
    logServerRateLimit(response, endpoint);
    return parseXApiResponse<T>(response);
  }

  return {
    get: <T>(url: string, params?: Record<string, string>) =>
      request<T>("GET", url, { params }),
    post: <T>(url: string, body: unknown) => request<T>("POST", url, { body }),
    postRaw: <T>(url: string, body: BodyInit) =>
      request<T>("POST", url, { body, raw: true }),
    put: <T>(url: string, body: unknown) => request<T>("PUT", url, { body }),
    del: <T>(url: string) => request<T>("DELETE", url),
  };
}
