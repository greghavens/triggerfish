/**
 * Browser automation (CDP) tests.
 *
 * Uses mock page objects to test tool logic without requiring
 * a real Chromium instance. Domain policy integration is tested
 * in domains_test.ts.
 */

import { assertEquals } from "@std/assert";
import {
  createBrowserTools,
  type DnsChecker,
  type NavigateResult,
  type SnapshotResult,
} from "../../src/browser/tools.ts";
import { createDomainPolicy } from "../../src/browser/domains.ts";
import type { Result } from "../../src/core/types/classification.ts";

/** Mock page that simulates the puppeteer Page API surface used by BrowserTools. */
function createMockPage() {
  let currentUrl = "about:blank";
  const clicks: string[] = [];
  const typed: Array<{ selector: string; text: string }> = [];
  const evaluateCalls: Array<{ fn: unknown; args: unknown[] }> = [];
  let browserClosed = false;

  return {
    url: () => currentUrl,
    title: () => Promise.resolve("Mock Page Title"),
    goto: (url: string, _options?: Record<string, unknown>) => {
      currentUrl = url;
      return Promise.resolve({ status: () => 200 });
    },
    screenshot: (_options?: Record<string, unknown>) => {
      return Promise.resolve(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    },
    click: (selector: string) => {
      clicks.push(selector);
      return Promise.resolve();
    },
    type: (selector: string, text: string) => {
      typed.push({ selector, text });
      return Promise.resolve();
    },
    select: (_selector: string, value: string) => Promise.resolve([value]),
    evaluate: (fn: unknown, ...args: unknown[]) => {
      evaluateCalls.push({ fn, args });
      if (typeof fn === "function") {
        const fnStr = fn.toString();
        if (fnStr.includes("innerText")) {
          return Promise.resolve("Mock page text content");
        }
        if (fnStr.includes("scrollBy")) {
          return Promise.resolve(undefined);
        }
      }
      return Promise.resolve(null);
    },
    waitForSelector: (
      selector: string,
      _options?: Record<string, unknown>,
    ) => {
      if (selector === "#timeout") {
        return Promise.reject(new Error("Timeout waiting for selector"));
      }
      return Promise.resolve();
    },
    browser: () => ({
      close: () => {
        browserClosed = true;
        return Promise.resolve();
      },
    }),
    // Exposed for assertions
    _clicks: clicks,
    _typed: typed,
    _evaluateCalls: evaluateCalls,
    get _browserClosed() {
      return browserClosed;
    },
  };
}

/** DNS checker that allows all hostnames. */
const allowAllDns: DnsChecker = (
  _hostname: string,
): Promise<Result<string, string>> => {
  return Promise.resolve({ ok: true, value: "93.184.216.34" });
};

/** DNS checker that blocks all hostnames (simulates SSRF). */
const blockAllDns: DnsChecker = (
  hostname: string,
): Promise<Result<string, string>> => {
  return Promise.resolve({
    ok: false,
    error: `SSRF blocked: ${hostname} resolves to private IP 127.0.0.1`,
  });
};

/** Create mock browser tools with configurable DNS checker. */
function createMockTools(opts: {
  connected?: boolean;
  dnsChecker?: DnsChecker;
} = {}) {
  const mockPage = createMockPage();
  const connected = opts.connected !== false;

  const policy = createDomainPolicy({
    allowList: [],
    denyList: ["malware.bad", "phishing.evil"],
    classifications: { "classified.corp": "CONFIDENTIAL" },
  });

  const tools = connected
    ? createBrowserTools({
      page: mockPage,
      domainPolicy: policy,
      dnsChecker: opts.dnsChecker ?? allowAllDns,
    })
    : null;

  return { tools, mockPage, policy };
}

// ---------------------------------------------------------------------------
// Navigate
// ---------------------------------------------------------------------------

Deno.test("navigate: succeeds for allowed URL", async () => {
  const { tools } = createMockTools();
  const result = await tools!.navigate("https://example.com/page");
  assertEquals(result.ok, true);
  if (result.ok) {
    const nav: NavigateResult = result.value;
    assertEquals(nav.url, "https://example.com/page");
    assertEquals(nav.title, "Mock Page Title");
    assertEquals(nav.statusCode, 200);
  }
});

Deno.test("navigate: blocked by domain policy", async () => {
  const { tools } = createMockTools();
  const result = await tools!.navigate("https://malware.bad/exploit");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("domain policy"), true);
  }
});

Deno.test("navigate: returns error when not connected", () => {
  // Tools are null when not connected — executor handles this
  const { tools } = createMockTools({ connected: false });
  assertEquals(tools, null);
});

Deno.test("navigate: SSRF blocked by DNS checker", async () => {
  const { tools } = createMockTools({ dnsChecker: blockAllDns });
  const result = await tools!.navigate("https://internal.service/api");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("SSRF"), true);
  }
});

Deno.test("navigate: rejects non-http URL", async () => {
  const { tools } = createMockTools();
  const result = await tools!.navigate("ftp://files.example.com/data");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("http/https"), true);
  }
});

Deno.test("navigate: rejects invalid URL", async () => {
  const { tools } = createMockTools();
  const result = await tools!.navigate("not a valid url");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Invalid URL"), true);
  }
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

Deno.test("snapshot: returns SnapshotResult with screenshot and textContent", async () => {
  const { tools } = createMockTools();
  const result = await tools!.snapshot();
  assertEquals(result.ok, true);
  if (result.ok) {
    const snap: SnapshotResult = result.value;
    assertEquals(typeof snap.screenshot, "string");
    // Should be valid base64
    assertEquals(snap.screenshot.length > 0, true);
    assertEquals(snap.textContent, "Mock page text content");
  }
});

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

Deno.test("click: succeeds on valid selector", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.click("#submit-btn");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, undefined);
  }
  assertEquals(mockPage._clicks.includes("#submit-btn"), true);
});

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

Deno.test("type: enters text into element", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.type("#search-input", "hello world");
  assertEquals(result.ok, true);
  assertEquals(mockPage._typed.length, 1);
  assertEquals(mockPage._typed[0].selector, "#search-input");
  assertEquals(mockPage._typed[0].text, "hello world");
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

Deno.test("select: selects dropdown value", async () => {
  const { tools } = createMockTools();
  const result = await tools!.select("#country", "US");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, undefined);
  }
});

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------

Deno.test("scroll: down calls evaluate with positive Y offset", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.scroll("down", 300);
  assertEquals(result.ok, true);

  // The last evaluate call should have scrollBy args (dx=0, dy=300)
  const lastCall =
    mockPage._evaluateCalls[mockPage._evaluateCalls.length - 1];
  assertEquals(lastCall.args, [0, 300]);
});

Deno.test("scroll: up calls evaluate with negative Y offset", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.scroll("up", 200);
  assertEquals(result.ok, true);

  const lastCall =
    mockPage._evaluateCalls[mockPage._evaluateCalls.length - 1];
  assertEquals(lastCall.args, [0, -200]);
});

Deno.test("scroll: left calls evaluate with negative X offset", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.scroll("left");
  assertEquals(result.ok, true);

  const lastCall =
    mockPage._evaluateCalls[mockPage._evaluateCalls.length - 1];
  assertEquals(lastCall.args, [-500, 0]);
});

Deno.test("scroll: right calls evaluate with positive X offset", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.scroll("right", 100);
  assertEquals(result.ok, true);

  const lastCall =
    mockPage._evaluateCalls[mockPage._evaluateCalls.length - 1];
  assertEquals(lastCall.args, [100, 0]);
});

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

Deno.test("wait: succeeds for existing selector", async () => {
  const { tools } = createMockTools();
  const result = await tools!.wait("#content");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

Deno.test("wait: returns error on timeout", async () => {
  const { tools } = createMockTools();
  const result = await tools!.wait("#timeout");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("Wait failed"), true);
  }
});

Deno.test("wait: with custom timeout and no selector resolves", async () => {
  const { tools } = createMockTools();
  // Use a very short timeout so the test completes quickly
  const result = await tools!.wait(undefined, 10);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, true);
  }
});

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

Deno.test("close: closes the browser successfully", async () => {
  const { tools, mockPage } = createMockTools();
  const result = await tools!.close();
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, undefined);
  }
  assertEquals(mockPage._browserClosed, true);
});

// ---------------------------------------------------------------------------
// Domain policy integration
// ---------------------------------------------------------------------------

Deno.test("navigate: multiple denied domains are all blocked", async () => {
  const { tools } = createMockTools();

  const r1 = await tools!.navigate("https://malware.bad/path");
  const r2 = await tools!.navigate("https://phishing.evil/login");

  assertEquals(r1.ok, false);
  assertEquals(r2.ok, false);
});

// ---------------------------------------------------------------------------
// Tool definitions and executor
// ---------------------------------------------------------------------------

Deno.test("getBrowserToolDefinitions: returns 9 tool definitions including browser_close", async () => {
  const { getBrowserToolDefinitions } = await import(
    "../../src/browser/tools.ts"
  );
  const defs = getBrowserToolDefinitions();
  assertEquals(defs.length, 9);
  assertEquals(defs.some((d) => d.name === "browser_close"), true);
});

Deno.test("executor: returns null for non-browser tools", async () => {
  const { createBrowserToolExecutor } = await import(
    "../../src/browser/tools.ts"
  );
  const executor = createBrowserToolExecutor(undefined);
  const result = await executor("web_search", { query: "test" });
  assertEquals(result, null);
});

Deno.test("executor: returns error when browser not connected", async () => {
  const { createBrowserToolExecutor } = await import(
    "../../src/browser/tools.ts"
  );
  const executor = createBrowserToolExecutor(undefined);
  const result = await executor("browser_navigate", {
    url: "https://example.com",
  });
  assertEquals(typeof result, "string");
  assertEquals(result!.includes("not connected"), true);
});

Deno.test("executor: browser_close closes browser and returns success", async () => {
  const { createBrowserToolExecutor, createBrowserTools } = await import(
    "../../src/browser/tools.ts"
  );
  const { createDomainPolicy } = await import("../../src/browser/domains.ts");

  const mockPage = createMockPage();
  const policy = createDomainPolicy({
    allowList: [],
    denyList: [],
    classifications: {},
  });
  const tools = createBrowserTools({ page: mockPage, domainPolicy: policy });
  const executor = createBrowserToolExecutor({ tools });

  const result = await executor("browser_close", {});
  assertEquals(result, "Browser closed.");
  assertEquals(mockPage._browserClosed, true);
});
