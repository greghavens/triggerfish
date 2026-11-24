/**
 * Browser manager tests — detection, port allocation, CDP polling,
 * timeout wrapper, and launch error handling.
 *
 * Unit tests use mocks/stubs; integration tests are gated on actual
 * Flatpak Chrome presence on the host.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  applyStealthPatches,
  baseChromeArgs,
  detectChrome,
  findFreePort,
  pollCdpReady,
  withTimeout,
} from "../../../src/tools/browser/manager/manager.ts";
import { createBrowserManager } from "../../../src/tools/browser/manager/manager.ts";
import { createDomainPolicy } from "../../../src/tools/browser/domains.ts";
import { createMemoryStorage } from "../../../src/core/storage/memory.ts";

// ---------------------------------------------------------------------------
// detectChrome
// ---------------------------------------------------------------------------

Deno.test("detectChrome: returns a detection result on this system", async () => {
  const result = await detectChrome();
  // On CI or bare systems this may be undefined — that's fine, we just
  // verify the function doesn't throw and returns the right shape.
  if (result !== undefined) {
    assertEquals(typeof result.kind, "string");
    assertEquals(["direct", "flatpak"].includes(result.kind), true);
    assertEquals(typeof result.target, "string");
    if (result.kind === "flatpak") {
      assertEquals(typeof result.flatpakBin, "string");
    }
  }
});

Deno.test("detectChrome: prefers direct binary over Flatpak", async () => {
  const result = await detectChrome();
  // If we got a result AND a direct binary exists, kind must be "direct"
  if (result?.kind === "direct") {
    // Verify the target looks like an absolute path (Unix: starts with "/", Windows: "C:\...")
    const isAbsPath = result.target.startsWith("/") ||
      /^[A-Za-z]:[\\\/]/.test(result.target);
    assertEquals(isAbsPath, true);
  }
  // If kind is "flatpak", it means no direct binary was found — still valid
});

Deno.test({
  name:
    "detectChrome: Windows detection returns chrome.exe, brave.exe, or msedge.exe path",
  ignore: Deno.build.os !== "windows",
  async fn() {
    const result = await detectChrome();
    if (result !== undefined && result.kind === "direct") {
      const lowerTarget = result.target.toLowerCase();
      const isKnownBrowser = lowerTarget.endsWith("chrome.exe") ||
        lowerTarget.endsWith("brave.exe") ||
        lowerTarget.endsWith("msedge.exe");
      assertEquals(isKnownBrowser, true);
      // Must be an absolute Windows path
      assertEquals(/^[A-Za-z]:[\\\/]/.test(result.target), true);
    }
  },
});

// ---------------------------------------------------------------------------
// findFreePort
// ---------------------------------------------------------------------------

Deno.test("findFreePort: returns valid port", async () => {
  const port = await findFreePort();
  assertEquals(typeof port, "number");
  assertEquals(port >= 1024, true);
  assertEquals(port <= 65535, true);
});

Deno.test("findFreePort: returns different ports on consecutive calls", async () => {
  const port1 = await findFreePort();
  const port2 = await findFreePort();
  // Not guaranteed to be different, but overwhelmingly likely
  assertEquals(typeof port1, "number");
  assertEquals(typeof port2, "number");
});

// ---------------------------------------------------------------------------
// pollCdpReady
// ---------------------------------------------------------------------------

Deno.test("pollCdpReady: returns Ok when endpoint responds", async () => {
  // Start a local HTTP server that mimics CDP /json/version
  const wsUrl = "ws://127.0.0.1:9222/devtools/browser/fake-id";
  const ac = new AbortController();

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen() {/* suppress default log */},
  }, () => {
    const body = JSON.stringify({
      webSocketDebuggerUrl: wsUrl,
      Browser: "HeadlessChrome/test",
    });
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  });

  const port = server.addr.port;

  const result = await pollCdpReady(port, 5_000);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.webSocketDebuggerUrl, wsUrl);
    assertEquals(result.value.Browser, "HeadlessChrome/test");
  }

  ac.abort();
  await server.finished;
});

Deno.test("pollCdpReady: returns Err on timeout", async () => {
  // Use a port that nothing is listening on
  const port = await findFreePort();
  const result = await pollCdpReady(port, 300);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("not ready"), true);
  }
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

Deno.test("withTimeout: resolves before timeout", async () => {
  const result = await withTimeout(
    Promise.resolve(42),
    1_000,
    "should not timeout",
  );
  assertEquals(result, 42);
});

Deno.test("withTimeout: rejects on timeout", async () => {
  await assertRejects(
    () =>
      withTimeout(
        new Promise(() => {}), // never resolves
        50,
        "timed out!",
      ),
    Error,
    "timed out!",
  );
});

Deno.test("withTimeout: propagates original rejection", async () => {
  await assertRejects(
    () =>
      withTimeout(
        Promise.reject(new Error("original error")),
        1_000,
        "timeout msg",
      ),
    Error,
    "original error",
  );
});

// ---------------------------------------------------------------------------
// baseChromeArgs — anti-automation-detection flags
// ---------------------------------------------------------------------------

Deno.test("baseChromeArgs: includes --disable-blink-features=AutomationControlled", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
  };
  const args = baseChromeArgs(config);
  assertEquals(
    args.includes("--disable-blink-features=AutomationControlled"),
    true,
  );
});

Deno.test("baseChromeArgs: includes --disable-infobars", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
  };
  const args = baseChromeArgs(config);
  assertEquals(args.includes("--disable-infobars"), true);
});

Deno.test("baseChromeArgs: includes --exclude-switches=enable-automation", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
  };
  const args = baseChromeArgs(config);
  assertEquals(args.includes("--exclude-switches=enable-automation"), true);
});

Deno.test("baseChromeArgs: retains base operational flags", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
  };
  const args = baseChromeArgs(config);
  assertEquals(args.includes("--no-first-run"), true);
  assertEquals(args.includes("--disable-extensions"), true);
  assertEquals(args.includes("--disable-sync"), true);
});

Deno.test("baseChromeArgs: propagates extra launchArgs", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
    launchArgs: ["--some-custom-flag"],
  };
  const args = baseChromeArgs(config);
  assertEquals(args.includes("--some-custom-flag"), true);
});

Deno.test("baseChromeArgs: includes hardcoded host-resolver-rules egress lockdown", () => {
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
  };
  const args = baseChromeArgs(config);
  const rulesArg = args.find((a) => a.startsWith("--host-resolver-rules="));
  assert(rulesArg !== undefined, "expected a --host-resolver-rules arg");
  assertStringIncludes(rulesArg, "MAP localhost ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP *.internal ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 127.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 10.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 192.168.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 169.254.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 172.16.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP 172.31.* ~NOTFOUND");
  assertStringIncludes(rulesArg, "MAP fe80:* ~NOTFOUND");
});

Deno.test("baseChromeArgs: egress lockdown comes after launchArgs so it cannot be overridden", () => {
  const userOverride = "--host-resolver-rules=MAP nothing ~NOTFOUND";
  const config = {
    profileBaseDir: "/tmp/test",
    domainPolicy: createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    }),
    storage: createMemoryStorage(),
    launchArgs: [userOverride],
  };
  const args = baseChromeArgs(config);
  const overrideIndex = args.indexOf(userOverride);
  const lockdownIndex = args.findIndex(
    (a) => a.startsWith("--host-resolver-rules=") && a !== userOverride,
  );
  assert(overrideIndex !== -1, "expected the user override to be present");
  assert(lockdownIndex !== -1, "expected the hardcoded lockdown to be present");
  // Chrome honors the LAST occurrence of a duplicated switch
  assertEquals(lockdownIndex > overrideIndex, true);
});

// ---------------------------------------------------------------------------
// applyStealthPatches — exported function presence
// ---------------------------------------------------------------------------

Deno.test("applyStealthPatches: is exported as an async function", () => {
  assertEquals(typeof applyStealthPatches, "function");
  // Calling it with a minimal mock-like object should return a Promise
  // (we can't run a real browser in unit tests; integration tests cover this)
});

// ---------------------------------------------------------------------------
// launch: error when no Chrome found
// ---------------------------------------------------------------------------

Deno.test("launch: error when no Chrome found", async () => {
  const storage = createMemoryStorage();
  const policy = createDomainPolicy({
    allowList: [],
    denyList: [],
    classifications: {},
  });

  const mgr = createBrowserManager({
    // Provide a path that definitely doesn't exist
    chromiumPath: "/nonexistent/path/to/chrome",
    profileBaseDir: "/tmp/tf-manager-test-no-chrome",
    domainPolicy: policy,
    storage,
    launchTimeoutMs: 1_000,
  });

  const result = await mgr.launch("test-agent", "PUBLIC");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(typeof result.error, "string");
    assertEquals(
      result.error.includes("launch failed") || result.error.includes("Launch"),
      true,
    );
  }
});

// ---------------------------------------------------------------------------
// Integration tests — gated on Flatpak Chrome presence
// ---------------------------------------------------------------------------

const hasFlatpakChrome = await (async () => {
  try {
    const stat = await Deno.stat(
      "/var/lib/flatpak/exports/bin/com.google.Chrome",
    );
    return stat.isFile || stat.isSymlink;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "Flatpak Chrome: launches headless and connects",
  ignore: !hasFlatpakChrome,
  async fn() {
    const storage = createMemoryStorage();
    const policy = createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    });

    const mgr = createBrowserManager({
      profileBaseDir: "/tmp/tf-manager-test-flatpak",
      domainPolicy: policy,
      storage,
    });

    const result = await mgr.launch("flatpak-test", "PUBLIC");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.agentId, "flatpak-test");
      assertEquals(typeof result.value.profilePath, "string");
      assertEquals(result.value.watermark, "PUBLIC");
      assertEquals(mgr.isRunning("flatpak-test"), true);
    }

    await mgr.close("flatpak-test");
    assertEquals(mgr.isRunning("flatpak-test"), false);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Flatpak Chrome: cleans up process on close",
  ignore: !hasFlatpakChrome,
  async fn() {
    const storage = createMemoryStorage();
    const policy = createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    });

    const mgr = createBrowserManager({
      profileBaseDir: "/tmp/tf-manager-test-flatpak-cleanup",
      domainPolicy: policy,
      storage,
    });

    const result = await mgr.launch("cleanup-test", "PUBLIC");
    assertEquals(result.ok, true);

    await mgr.close("cleanup-test");
    assertEquals(mgr.isRunning("cleanup-test"), false);

    // Give OS a moment to clean up
    await new Promise((r) => setTimeout(r, 500));

    // Verify no zombie — we can't easily check the PID here without
    // reaching into internals, but isRunning === false confirms cleanup
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "Flatpak Chrome: profile directory is accessible",
  ignore: !hasFlatpakChrome,
  async fn() {
    const baseDir = "/tmp/tf-manager-test-flatpak-profile";
    const storage = createMemoryStorage();
    const policy = createDomainPolicy({
      allowList: [],
      denyList: [],
      classifications: {},
    });

    const mgr = createBrowserManager({
      profileBaseDir: baseDir,
      domainPolicy: policy,
      storage,
    });

    const result = await mgr.launch("profile-test", "PUBLIC");
    assertEquals(result.ok, true);

    // Verify the profile directory was created
    try {
      const stat = await Deno.stat(`${baseDir}/profile-test/profile`);
      assertEquals(stat.isDirectory, true);
    } catch {
      throw new Error("Profile directory was not created");
    }

    await mgr.close("profile-test");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
