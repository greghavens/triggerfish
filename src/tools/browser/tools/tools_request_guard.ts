/**
 * Browser request guard — per-request SSRF and domain policy enforcement.
 *
 * Installs CDP request interception on a page so that every request the
 * browser issues — main frame, subframes, subresources, and each redirect
 * hop — is re-validated against the SSRF denylist and the domain policy
 * at request time. Requests that fail validation are aborted. This closes
 * redirect bypasses and DNS-rebinding TOCTOU gaps that a navigation-time
 * check alone leaves open.
 *
 * WebSocket handshakes are not surfaced by puppeteer request interception;
 * the hardcoded `--host-resolver-rules` egress rules in
 * `manager/manager_launch.ts` provide the defense-in-depth layer there.
 *
 * @module
 */

import type { HTTPRequest, Page } from "puppeteer-core";
import type { Result } from "../../../core/types/classification.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import { isPrivateIp } from "../../web/domains.ts";
import type { DomainPolicy } from "../domains.ts";
import type { DnsChecker } from "./tools_types.ts";

const log = createLogger("browser-tools");

/** Schemes that perform no network egress and are always safe to continue. */
const NO_EGRESS_SCHEMES: readonly string[] = ["about:", "data:", "blob:"];

/** Options for installing the browser request guard. */
export interface BrowserRequestGuardOptions {
  /** DNS resolver + SSRF checker (defaults to resolveAndCheck upstream). */
  readonly dnsCheck: DnsChecker;
  /** Domain security policy re-evaluated for every request. */
  readonly domainPolicy: DomainPolicy;
}

/** True when the hostname is a literal IPv4 or bracketed IPv6 address. */
function isIpLiteralHostname(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/** Extract a hostname for logging without exposing the full URL. */
function extractRequestHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "<unparseable>";
  }
}

/** Run SSRF and domain policy checks for an http(s) request host. */
async function enforceRequestHostPolicy(
  parsed: URL,
  options: BrowserRequestGuardOptions,
): Promise<Result<void, string>> {
  const hostname = parsed.hostname;
  if (isIpLiteralHostname(hostname)) {
    if (isPrivateIp(hostname)) {
      return {
        ok: false,
        error: `SSRF blocked: ${hostname} is a private/reserved IP`,
      };
    }
  } else {
    const dnsResult = await options.dnsCheck(hostname);
    if (!dnsResult.ok) return { ok: false, error: dnsResult.error };
  }
  if (!options.domainPolicy.isAllowed(parsed.href)) {
    return {
      ok: false,
      error: `Browser request blocked by domain policy: ${hostname}`,
    };
  }
  return { ok: true, value: undefined };
}

/**
 * Decide whether a single browser-originated request may proceed.
 *
 * http/https requests must pass the SSRF denylist (literal IP hosts are
 * checked directly; hostnames are DNS-resolved and every record checked)
 * and the domain policy. Non-network schemes (about:, data:, blob:) are
 * allowed. Anything else — including unparseable URLs — is denied.
 */
export async function enforceBrowserRequestPolicy(
  rawUrl: string,
  options: BrowserRequestGuardOptions,
): Promise<Result<void, string>> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Browser request blocked: unparseable URL" };
  }
  if (NO_EGRESS_SCHEMES.includes(parsed.protocol)) {
    return { ok: true, value: undefined };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Browser request blocked: unsupported scheme ${parsed.protocol}`,
    };
  }
  return await enforceRequestHostPolicy(parsed, options);
}

/** Abort an intercepted request, tolerating already-handled races. */
async function abortInterceptedRequest(request: HTTPRequest): Promise<void> {
  try {
    await request.abort("blockedbyclient");
  } catch (err) {
    log.error("Browser request abort failed", {
      operation: "installBrowserRequestGuard",
      err,
    });
  }
}

/** Continue an intercepted request, tolerating already-handled races. */
async function continueInterceptedRequest(
  request: HTTPRequest,
): Promise<void> {
  try {
    await request.continue();
  } catch (err) {
    log.error("Browser request continue failed", {
      operation: "installBrowserRequestGuard",
      err,
    });
  }
}

/** Validate one intercepted request and continue or abort it. */
async function dispatchInterceptedRequest(
  request: HTTPRequest,
  options: BrowserRequestGuardOptions,
): Promise<void> {
  const verdict = await enforceBrowserRequestPolicy(request.url(), options);
  if (verdict.ok) {
    await continueInterceptedRequest(request);
    return;
  }
  log.warn("Browser request blocked at interception", {
    operation: "enforceBrowserRequestPolicy",
    hostname: extractRequestHostname(request.url()),
    reason: verdict.error,
  });
  await abortInterceptedRequest(request);
}

/**
 * Install CDP request interception that re-validates every request.
 *
 * Each request — main frame, subframe, subresource, and every redirect
 * hop — is checked against the SSRF denylist and domain policy at request
 * time; failures are aborted. Returns an error Result when interception
 * cannot be enabled — callers must fail closed and refuse to navigate.
 */
export async function installBrowserRequestGuard(
  page: Page,
  options: BrowserRequestGuardOptions,
): Promise<Result<void, string>> {
  try {
    await page.setRequestInterception(true);
  } catch (err) {
    log.error("Browser request interception enable failed", {
      operation: "installBrowserRequestGuard",
      err,
    });
    return {
      ok: false,
      error: "Browser request interception could not be enabled; " +
        "navigation refused (fail closed)",
    };
  }
  page.on("request", (request) => {
    void dispatchInterceptedRequest(request, options);
  });
  log.debug("Browser request guard installed", {
    operation: "installBrowserRequestGuard",
  });
  return { ok: true, value: undefined };
}
