/**
 * Browser navigation helpers with SSRF prevention and domain policy.
 *
 * Handles URL parsing/validation, DNS resolution checks against
 * the SSRF denylist, and domain policy enforcement before any
 * page navigation occurs.
 *
 * @module
 */

import type { Page } from "puppeteer-core";
import type { Result } from "../../../core/types/classification.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import type { DomainPolicy } from "../domains.ts";
import type { DnsChecker, NavigateResult } from "./tools_types.ts";

const log = createLogger("browser-tools");

// ─── URL Validation ──────────────────────────────────────────────────────────

/** Parse and validate URL scheme for browser navigation. */
export function parseNavigationUrl(url: string): Result<URL, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error:
        `Only http/https URLs are allowed. Got: ${parsed.protocol} — if the user asked to open a browser or a browser tab, navigate to a URL like https://example.com instead.`,
    };
  }
  return { ok: true, value: parsed };
}

// ─── Policy Enforcement ──────────────────────────────────────────────────────

/** Run SSRF DNS check and domain policy check before navigation. */
export async function enforceBrowserNavigationPolicy(
  url: string,
  hostname: string,
  dnsCheck: DnsChecker,
  domainPolicy: DomainPolicy,
): Promise<Result<void, string>> {
  const dnsResult = await dnsCheck(hostname);
  if (!dnsResult.ok) {
    log.warn("Browser navigation blocked by SSRF check", {
      operation: "enforceBrowserNavigationPolicy",
      hostname,
      reason: dnsResult.error,
    });
    return { ok: false, error: dnsResult.error };
  }
  if (!domainPolicy.isAllowed(url)) {
    log.warn("Browser navigation blocked by domain policy", {
      operation: "enforceBrowserNavigationPolicy",
      hostname,
    });
    return {
      ok: false,
      error: `Navigation blocked by domain policy: ${url}`,
    };
  }
  log.debug("Browser navigation policy checks passed", {
    operation: "enforceBrowserNavigationPolicy",
    hostname,
  });
  return { ok: true, value: undefined };
}

/**
 * Re-validate the final post-redirect URL after navigation completes.
 *
 * Defense-in-depth behind the request-interception guard: even if a
 * redirect chain slipped through, the page's final host must still pass
 * the SSRF denylist and domain policy or the navigation fails closed.
 */
export async function revalidateFinalNavigationUrl(
  nav: NavigateResult,
  dnsCheck: DnsChecker,
  domainPolicy: DomainPolicy,
): Promise<Result<NavigateResult, string>> {
  const parsed = parseNavigationUrl(nav.url);
  if (!parsed.ok) {
    log.warn("Browser navigation final URL rejected: not a valid http URL", {
      operation: "revalidateFinalNavigationUrl",
    });
    return {
      ok: false,
      error: "Navigation blocked: final URL is not a valid http/https URL",
    };
  }
  const policy = await enforceBrowserNavigationPolicy(
    nav.url,
    parsed.value.hostname,
    dnsCheck,
    domainPolicy,
  );
  if (!policy.ok) {
    log.warn("Browser navigation final URL blocked by policy", {
      operation: "revalidateFinalNavigationUrl",
      hostname: parsed.value.hostname,
    });
    return {
      ok: false,
      error: `Navigation blocked at final URL: ${policy.error}`,
    };
  }
  return { ok: true, value: nav };
}

// ─── Navigation Execution ────────────────────────────────────────────────────

/** Execute page.goto and build NavigateResult. */
export async function navigateBrowserPage(
  page: Page,
  url: string,
): Promise<Result<NavigateResult, string>> {
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    return {
      ok: true,
      value: {
        url: page.url(),
        title: await page.title(),
        statusCode: response?.status() ?? 0,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Navigation failed: ${(err as Error).message}`,
    };
  }
}

/** @deprecated Use navigateBrowserPage instead */
export const executeBrowserNavigation = navigateBrowserPage;
