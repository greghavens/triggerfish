/**
 * Browser request guard tests.
 *
 * Verifies that CDP request interception re-validates every
 * browser-originated request (main frame, subresource, redirect hop)
 * against the SSRF denylist and domain policy at request time, aborting
 * on failure with a WARN log, and that the guard fails closed when
 * interception cannot be enabled.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { HTTPRequest, Page } from "puppeteer-core";
import {
  enforceBrowserRequestPolicy,
  installBrowserRequestGuard,
} from "../../../src/tools/browser/tools/tools_request_guard.ts";
import { createDomainPolicy } from "../../../src/tools/browser/domains.ts";
import type { DnsChecker } from "../../../src/tools/browser/tools/tools.ts";
import { initLogger, shutdownLogger } from "../../../src/core/logger/mod.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────────

/** DNS checker that records lookups and blocks the listed hostnames. */
function createRecordingDns(blockedHosts: readonly string[]) {
  const calls: string[] = [];
  const checker: DnsChecker = (hostname: string) => {
    calls.push(hostname);
    return Promise.resolve(
      blockedHosts.includes(hostname)
        ? {
          ok: false as const,
          error: `SSRF blocked: ${hostname} resolves to private IP 10.0.0.1`,
        }
        : { ok: true as const, value: "93.184.216.34" },
    );
  };
  return { checker, calls };
}

/** Permissive domain policy (empty allowlist/denylist). */
function createOpenPolicy() {
  return createDomainPolicy({
    allowList: [],
    denyList: [],
    classifications: {},
  });
}

/** Mock HTTPRequest recording abort/continue actions. */
function createMockRequest(url: string) {
  const actions: string[] = [];
  const request = {
    url: () => url,
    abort: (_errorCode?: string) => {
      actions.push("abort");
      return Promise.resolve();
    },
    continue: () => {
      actions.push("continue");
      return Promise.resolve();
    },
  } as unknown as HTTPRequest;
  return { request, actions };
}

/** Mock Page exposing registered request handlers and interception state. */
function createMockInterceptionPage(
  opts: { failInterception?: boolean } = {},
) {
  const state = { interceptionEnabled: false };
  const requestHandlers: Array<(request: HTTPRequest) => void> = [];
  const page = {
    setRequestInterception: (enabled: boolean) => {
      if (opts.failInterception) {
        return Promise.reject(
          new Error("Protocol error: Fetch.enable unavailable"),
        );
      }
      state.interceptionEnabled = enabled;
      return Promise.resolve();
    },
    on: (event: string, handler: (request: HTTPRequest) => void) => {
      if (event === "request") requestHandlers.push(handler);
    },
  } as unknown as Page;
  return { page, requestHandlers, state };
}

/** Emit a request through the registered handler and drain async work. */
async function emitInterceptedRequest(
  handlers: Array<(request: HTTPRequest) => void>,
  request: HTTPRequest,
): Promise<void> {
  for (const handler of handlers) handler(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Capture WARN+ log lines emitted while `run` executes. */
async function captureWarnLogs(
  run: () => Promise<void>,
): Promise<readonly string[]> {
  const lines: string[] = [];
  initLogger({
    level: "WARN",
    fileWriter: {
      write: (line: string) => {
        lines.push(line);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    console: false,
  });
  try {
    await run();
  } finally {
    await shutdownLogger();
    initLogger({ level: "INFO", console: true });
  }
  return lines;
}

// ─── enforceBrowserRequestPolicy: literal IP hosts ───────────────────────────

Deno.test("enforceBrowserRequestPolicy: blocks literal private IPv4 hosts without DNS", async () => {
  const { checker, calls } = createRecordingDns([]);
  const options = { dnsCheck: checker, domainPolicy: createOpenPolicy() };
  for (
    const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.8/internal",
      "http://100.64.0.1/cgnat",
    ]
  ) {
    const result = await enforceBrowserRequestPolicy(url, options);
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error, "SSRF blocked");
  }
  // Literal IPs are decided directly — no DNS lookups performed
  assertEquals(calls.length, 0);
});

Deno.test("enforceBrowserRequestPolicy: blocks bracketed IPv6 literal hosts", async () => {
  const { checker, calls } = createRecordingDns([]);
  const options = { dnsCheck: checker, domainPolicy: createOpenPolicy() };
  for (const url of ["http://[::1]/x", "http://[::ffff:7f00:1]/x"]) {
    const result = await enforceBrowserRequestPolicy(url, options);
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.error, "SSRF blocked");
  }
  assertEquals(calls.length, 0);
});

Deno.test("enforceBrowserRequestPolicy: allows literal public IP host", async () => {
  const { checker, calls } = createRecordingDns([]);
  const options = { dnsCheck: checker, domainPolicy: createOpenPolicy() };
  const result = await enforceBrowserRequestPolicy(
    "http://93.184.216.34/page",
    options,
  );
  assertEquals(result.ok, true);
  assertEquals(calls.length, 0);
});

// ─── enforceBrowserRequestPolicy: hostnames and schemes ──────────────────────

Deno.test("enforceBrowserRequestPolicy: blocks hostname whose DNS check fails (redirect hop)", async () => {
  const { checker } = createRecordingDns(["rebind.evil"]);
  const options = { dnsCheck: checker, domainPolicy: createOpenPolicy() };
  const result = await enforceBrowserRequestPolicy(
    "https://rebind.evil/callback",
    options,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "SSRF blocked");
});

Deno.test("enforceBrowserRequestPolicy: re-applies domain policy per request", async () => {
  const { checker } = createRecordingDns([]);
  const policy = createDomainPolicy({
    allowList: [],
    denyList: ["tracker.bad"],
    classifications: {},
  });
  const options = { dnsCheck: checker, domainPolicy: policy };
  const blocked = await enforceBrowserRequestPolicy(
    "https://tracker.bad/pixel.js",
    options,
  );
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertStringIncludes(blocked.error, "domain policy");
  const allowed = await enforceBrowserRequestPolicy(
    "https://cdn.example.com/lib.js",
    options,
  );
  assertEquals(allowed.ok, true);
});

Deno.test("enforceBrowserRequestPolicy: allows no-egress schemes, denies others", async () => {
  const { checker } = createRecordingDns([]);
  const options = { dnsCheck: checker, domainPolicy: createOpenPolicy() };
  assertEquals(
    (await enforceBrowserRequestPolicy("about:blank", options)).ok,
    true,
  );
  assertEquals(
    (await enforceBrowserRequestPolicy("data:text/plain,hello", options)).ok,
    true,
  );
  const ws = await enforceBrowserRequestPolicy(
    "ws://example.com/sock",
    options,
  );
  assertEquals(ws.ok, false);
  const ext = await enforceBrowserRequestPolicy(
    "chrome-extension://abcdef/page.html",
    options,
  );
  assertEquals(ext.ok, false);
  const garbage = await enforceBrowserRequestPolicy("not a url", options);
  assertEquals(garbage.ok, false);
});

// ─── installBrowserRequestGuard: interception wiring ─────────────────────────

Deno.test("installBrowserRequestGuard: aborts redirect/subresource request to a private-IP host and logs WARN", async () => {
  const { checker } = createRecordingDns(["rebind.evil"]);
  const { page, requestHandlers, state } = createMockInterceptionPage();
  const { request, actions } = createMockRequest("https://rebind.evil/steal");

  const warnLines = await captureWarnLogs(async () => {
    const installed = await installBrowserRequestGuard(page, {
      dnsCheck: checker,
      domainPolicy: createOpenPolicy(),
    });
    assertEquals(installed.ok, true);
    await emitInterceptedRequest(requestHandlers, request);
  });

  assertEquals(state.interceptionEnabled, true);
  assertEquals(actions, ["abort"]);
  const blockLine = warnLines.find((line) =>
    line.includes("Browser request blocked at interception")
  );
  assert(blockLine !== undefined, "expected a WARN line for the block");
  assertStringIncludes(blockLine, "[WARN]");
  assertStringIncludes(blockLine, "rebind.evil");
});

Deno.test("installBrowserRequestGuard: aborts literal private-IP subresource request", async () => {
  const { checker } = createRecordingDns([]);
  const { page, requestHandlers } = createMockInterceptionPage();
  const { request, actions } = createMockRequest(
    "http://169.254.169.254/latest/meta-data/iam/",
  );
  const installed = await installBrowserRequestGuard(page, {
    dnsCheck: checker,
    domainPolicy: createOpenPolicy(),
  });
  assertEquals(installed.ok, true);
  await emitInterceptedRequest(requestHandlers, request);
  assertEquals(actions, ["abort"]);
});

Deno.test("installBrowserRequestGuard: continues allowed requests", async () => {
  const { checker } = createRecordingDns(["rebind.evil"]);
  const { page, requestHandlers } = createMockInterceptionPage();
  const { request, actions } = createMockRequest(
    "https://cdn.example.com/lib.js",
  );
  const installed = await installBrowserRequestGuard(page, {
    dnsCheck: checker,
    domainPolicy: createOpenPolicy(),
  });
  assertEquals(installed.ok, true);
  await emitInterceptedRequest(requestHandlers, request);
  assertEquals(actions, ["continue"]);
});

Deno.test("installBrowserRequestGuard: fails closed when interception cannot be enabled", async () => {
  const { page } = createMockInterceptionPage({ failInterception: true });
  const { checker } = createRecordingDns([]);
  const result = await installBrowserRequestGuard(page, {
    dnsCheck: checker,
    domainPolicy: createOpenPolicy(),
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "fail closed");
});
