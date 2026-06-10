/**
 * Web fetch with content extraction via Mozilla Readability.
 *
 * Fetches web pages with SSRF prevention, domain policy checks,
 * and optional article content extraction using Readability.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { DomainPolicy } from "./policy.ts";
import { resolveAndCheck as defaultResolveAndCheck } from "./ssrf.ts";
import type { DnsChecker, FetchOptions, FetchResult } from "./fetch_types.ts";
import type { WebFetcher, WebFetcherConfig } from "./fetch_types.ts";
import {
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_TIMEOUT,
  DEFAULT_USER_AGENT,
} from "./fetch_types.ts";
import { extractPageContent, fetchPageContent } from "./fetch_content.ts";

export type {
  DnsChecker,
  FetchMode,
  FetchOptions,
  FetchResult,
  WebFetcher,
  WebFetcherConfig,
} from "./fetch_types.ts";

const log = createLogger("web.fetch");

/** Validate URL format and protocol. */
function validateFetchUrl(url: string): Result<URL, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Unsupported protocol: ${parsed.protocol}` };
  }
  return { ok: true, value: parsed };
}

/** Check SSRF prevention and domain policy for a hostname. */
async function enforceFetchPolicy(
  hostname: string,
  url: string,
  domainPolicy: DomainPolicy,
  dnsChecker: DnsChecker,
): Promise<Result<void, string>> {
  const dnsResult = await dnsChecker(hostname);
  if (!dnsResult.ok) {
    log.warn("SSRF check blocked outbound request", {
      operation: "enforceFetchPolicy",
      hostname,
      reason: dnsResult.error,
    });
    return { ok: false, error: dnsResult.error };
  }
  log.debug("SSRF check passed", { operation: "enforceFetchPolicy", hostname });
  if (!domainPolicy.isAllowed(url)) {
    log.warn("Domain policy blocked outbound request", {
      operation: "enforceFetchPolicy",
      hostname,
    });
    return { ok: false, error: `Domain blocked by policy: ${hostname}` };
  }
  log.debug("Domain policy allowed outbound request", {
    operation: "enforceFetchPolicy",
    hostname,
  });
  return { ok: true, value: undefined };
}

/**
 * Create a web fetcher with domain policy enforcement and SSRF prevention.
 *
 * @param configOrPolicy - WebFetcherConfig or DomainPolicy for backwards compatibility
 * @returns A WebFetcher instance
 */
export function createWebFetcher(
  configOrPolicy: WebFetcherConfig | DomainPolicy,
): WebFetcher {
  const domainPolicy = "isAllowed" in configOrPolicy
    ? configOrPolicy
    : configOrPolicy.domainPolicy;
  const resolveAndCheck = "isAllowed" in configOrPolicy
    ? defaultResolveAndCheck
    : (configOrPolicy.dnsChecker ?? defaultResolveAndCheck);
  return {
    async fetch(
      url: string,
      options?: FetchOptions,
    ): Promise<Result<FetchResult, string>> {
      const urlResult = validateFetchUrl(url);
      if (!urlResult.ok) return urlResult;
      const policyResult = await enforceFetchPolicy(
        urlResult.value.hostname,
        url,
        domainPolicy,
        resolveAndCheck,
      );
      if (!policyResult.ok) return policyResult;
      const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
      const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
      const mode = options?.mode ?? "readability";
      const maxLen = options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
      const pageResult = await fetchPageContent(
        {
          url,
          userAgent,
          timeout,
          maxBytes: maxLen,
          ssrfChecker: resolveAndCheck,
        },
      );
      if (!pageResult.ok) return pageResult;
      const { response, rawBody, contentType, byteLength, bodyTruncated } =
        pageResult.value;
      const extracted = extractPageContent(rawBody, contentType, mode);
      const content = bodyTruncated
        ? extracted.content + "\n[truncated]"
        : extracted.content.length > maxLen
        ? extracted.content.slice(0, maxLen) + "\n[truncated]"
        : extracted.content;
      return {
        ok: true,
        value: {
          url: response.url,
          title: extracted.title,
          content,
          contentType,
          statusCode: response.status,
          mode,
          byteLength,
        },
      };
    },
  };
}
