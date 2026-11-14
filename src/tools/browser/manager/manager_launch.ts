/**
 * Chrome launch strategies and stealth patches.
 *
 * Provides two launch paths (direct binary and Flatpak wrapper) and
 * anti-automation-detection patches applied to every new page.
 *
 * @module
 */

import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import type { Result } from "../../../core/types/classification.ts";
import type { BrowserManagerConfig } from "./manager.ts";
import { withTimeout } from "./manager_detection.ts";
import type { ChromeDetection } from "./manager_detection.ts";
import { DEFAULT_VIEWPORT } from "./manager_detection.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("browser-launch");

/**
 * Hardcoded host-resolver MAP rules that hard-fail lookups of loopback,
 * link-local, and RFC1918 hosts inside Chrome itself (egress lockdown).
 *
 * Chrome's `--host-resolver-rules` matches the requested host STRING —
 * it cannot express "block any name that RESOLVES to a private range",
 * so these legacy argument-construction rules are not used as the connection
 * boundary. Actual launches require the policy SOCKSv5 proxy, pin connections
 * to checked IPs, disable local proxy bypass, and prohibit direct DNS lookups.
 * Not configurable, mirroring the hardcoded SSRF denylist.
 */
function buildEgressDenyResolverRules(): readonly string[] {
  const rfc1918Block172 = Array.from(
    { length: 16 },
    (_, i) => `MAP 172.${16 + i}.* ~NOTFOUND`,
  );
  return [
    "MAP localhost ~NOTFOUND",
    "MAP *.localhost ~NOTFOUND",
    "MAP *.local ~NOTFOUND",
    "MAP *.internal ~NOTFOUND",
    "MAP *.lan ~NOTFOUND",
    "MAP *.home.arpa ~NOTFOUND",
    "MAP 127.* ~NOTFOUND",
    "MAP 0.* ~NOTFOUND",
    "MAP 10.* ~NOTFOUND",
    "MAP 192.168.* ~NOTFOUND",
    "MAP 169.254.* ~NOTFOUND",
    ...rfc1918Block172,
    "MAP [::1] ~NOTFOUND",
    "MAP fe80:* ~NOTFOUND",
  ];
}

/** Remove competing proxy controls and force all URL traffic through the policy proxy. */
function buildPinnedProxyArgs(config: BrowserManagerConfig): string[] {
  if (!config.egressProxyUrl) {
    return [
      ...(config.launchArgs ?? []),
      `--host-resolver-rules=${buildEgressDenyResolverRules().join(", ")}`,
    ];
  }
  const forbidden =
    /^--(?:proxy(?:-|$)|no-proxy-server(?:=|$)|host-(?:resolver-)?rules(?:=|$)|enable-quic(?:=|$)|force-webrtc-ip-handling-policy(?:=|$))/;
  return [
    ...(config.launchArgs ?? []).filter((arg) => !forbidden.test(arg)),
    `--proxy-server=${config.egressProxyUrl.replace("socks5h:", "socks5:")}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/**
 * Standard Chrome launch arguments shared by both strategies.
 *
 * Includes anti-automation-detection flags that prevent Chrome from
 * advertising itself as WebDriver-controlled, plus the non-configurable
 * private-range egress lockdown. The egress flag is appended AFTER
 * `config.launchArgs` so user-supplied args cannot override it (Chrome
 * honors the last occurrence of a duplicated switch).
 *
 * @exported for testing
 */
export function baseChromeArgs(config: BrowserManagerConfig): string[] {
  return [
    "--no-first-run",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    // Remove Chrome's automation-mode advertising
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--exclude-switches=enable-automation",
    ...(config.credentialAutofill === true
      ? []
      : ["--disable-save-password-bubble"]),
    ...buildPinnedProxyArgs(config),
  ];
}

/**
 * Apply stealth patches to a puppeteer Page to suppress automation fingerprints.
 *
 * Patches applied on every new document (via `evaluateOnNewDocument`):
 * 1. `navigator.webdriver` → `undefined` (eliminates the #1 CDP detection signal)
 * 2. `window.chrome` → `{ runtime: {} }` if absent (matches real Chrome environment)
 *
 * Additionally, strips `"HeadlessChrome"` from the live user-agent string and
 * re-injects the cleaned UA for subsequent navigations.
 *
 * Must be called immediately after the page is obtained, before any navigation.
 *
 * @exported for testing
 */
async function patchWebdriverFlag(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

async function patchWindowChrome(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    if (!("chrome" in window)) {
      Object.defineProperty(window, "chrome", {
        writable: true,
        enumerable: true,
        configurable: false,
        value: { runtime: {} },
      });
    }
  });
}

async function patchHeadlessUserAgent(page: Page): Promise<void> {
  const ua = await page.evaluate(() => navigator.userAgent) as string;
  const patchedUa = ua.replace(/HeadlessChrome\//g, "Chrome/");
  if (patchedUa !== ua) {
    await page.setUserAgent(patchedUa);
    await page.evaluateOnNewDocument(
      (cleanUa: string) => {
        Object.defineProperty(navigator, "userAgent", {
          get: () => cleanUa,
          configurable: true,
        });
      },
      patchedUa,
    );
  }
}

export async function applyStealthPatches(page: Page): Promise<void> {
  await patchWebdriverFlag(page);
  await patchWindowChrome(page);
  await patchHeadlessUserAgent(page);
}

/** Launch Chrome via puppeteer.launch() for a direct binary, wrapped in a timeout. */
export async function launchDirect(
  config: BrowserManagerConfig,
  execPath: string,
  profilePath: string,
  timeoutMs: number,
): Promise<Result<{ browser: Browser; page: Page }, string>> {
  if (!config.egressProxyUrl) {
    return {
      ok: false,
      error: "Browser launch failed: policy egress proxy is required",
    };
  }
  // Pipe mode uses inherited FDs 3 & 4 for CDP communication, which is
  // unreliable on Windows + Deno — Chrome launches but the window never
  // appears. WebSocket mode (pipe: false) uses --remote-debugging-port
  // over standard TCP and works cross-platform.
  const usePipe = Deno.build.os !== "windows";
  const headless = config.headless !== false;
  const vp = config.viewport ?? DEFAULT_VIEWPORT;
  const windowArgs = headless ? [] : [`--window-size=${vp.width},${vp.height}`];

  log.debug("direct Chrome launch config", {
    execPath,
    usePipe,
    headless,
    windowArgs,
  });

  try {
    const browser = await withTimeout(
      puppeteer.launch({
        executablePath: execPath,
        pipe: usePipe,
        headless,
        userDataDir: profilePath,
        args: [...baseChromeArgs(config), ...windowArgs],
      }),
      timeoutMs,
      `Chrome launch timed out after ${timeoutMs}ms`,
    );

    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    return { ok: true, value: { browser, page } };
  } catch (err) {
    log.error("Direct Chrome process launch failed", {
      operation: "launchDirect",
      err,
    });
    return {
      ok: false,
      error: `Browser launch failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Launch Flatpak Chrome via puppeteer pipe mode.
 *
 * Writes a small shell wrapper script that exec-replaces itself with
 * `flatpak run --filesystem=<profileBaseDir> <appId> "$@"`, then passes it
 * as `executablePath` to `puppeteer.launch({ pipe: true })`.
 *
 * Pipe mode communicates over inherited file descriptors (FDs 3 & 4), which
 * work through `exec` regardless of Flatpak's network namespace configuration.
 * Puppeteer owns the full process lifecycle — no manual port allocation or
 * CDP polling required.
 */
export async function launchFlatpak(
  config: BrowserManagerConfig,
  detection: ChromeDetection,
  profilePath: string,
  timeoutMs: number,
): Promise<Result<{ browser: Browser; page: Page }, string>> {
  if (!config.egressProxyUrl) {
    return {
      ok: false,
      error: "Browser launch failed: policy egress proxy is required",
    };
  }
  const wrapperPath = `${config.profileBaseDir}/.flatpak-chrome-wrapper.sh`;
  const wrapperScript =
    `#!/bin/sh\nexec ${detection.flatpakBin} run --filesystem=${config.profileBaseDir} ${detection.target} "$@"\n`;

  try {
    await Deno.writeTextFile(wrapperPath, wrapperScript);
    await Deno.chmod(wrapperPath, 0o755);
  } catch (err) {
    log.error("Flatpak wrapper script file write failed", {
      operation: "launchFlatpak",
      err,
    });
    return {
      ok: false,
      error: `Failed to write Flatpak wrapper script: ${
        (err as Error).message
      }`,
    };
  }

  const vp = config.viewport ?? DEFAULT_VIEWPORT;

  try {
    const browser = await withTimeout(
      puppeteer.launch({
        executablePath: wrapperPath,
        pipe: true,
        headless: config.headless !== false,
        userDataDir: profilePath,
        args: [
          "--no-sandbox",
          `--window-size=${vp.width},${vp.height}`,
          ...baseChromeArgs(config),
        ],
      }),
      timeoutMs,
      `Flatpak Chrome did not start in time after ${timeoutMs}ms`,
    );

    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    return { ok: true, value: { browser, page } };
  } catch (err) {
    log.error("Flatpak Chrome process launch failed", {
      operation: "launchFlatpak",
      err,
    });
    return {
      ok: false,
      error: `Flatpak Chrome launch failed: ${(err as Error).message}`,
    };
  }
}
