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
import type { DomainPolicy } from "../domains.ts";
import type { DnsChecker, NavigateResult } from "./tools_types.ts";

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
    return { ok: false, error: dnsResult.error };
  }
  if (!domainPolicy.isAllowed(url)) {
    return {
      ok: false,
      error: `Navigation blocked by domain policy: ${url}`,
    };
  }
  return { ok: true, value: undefined };
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
