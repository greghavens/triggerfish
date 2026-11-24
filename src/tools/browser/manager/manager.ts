/**
 * Multi-agent Chromium lifecycle management for browser automation.
 *
 * Each agent gets an isolated browser profile with classification-aware
 * watermarking. A lower-tainted session cannot reuse a profile that has
 * been used at a higher classification level.
 *
 * Sub-modules:
 * - manager_detection.ts: Chrome binary detection, CDP/port helpers
 * - manager_launch.ts: Launch strategies (direct/flatpak) and stealth patches
 *
 * @module
 */

import type { Browser, Page } from "puppeteer-core";
import type {
  ClassificationLevel,
  Result,
} from "../../../core/types/classification.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import type { DomainPolicy } from "../domains.ts";
import {
  canAccessProfile,
  escalateWatermark,
  retrieveWatermark,
} from "../executor/watermark.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import {
  DEFAULT_LAUNCH_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  detectChrome,
  findFlatpakBin,
} from "./manager_detection.ts";
import type { ChromeDetection } from "./manager_detection.ts";
import {
  applyStealthPatches,
  launchDirect,
  launchFlatpak,
} from "./manager_launch.ts";
import {
  createEgressProxy,
  resolveAndCheck,
} from "../../../core/security/mod.ts";
import type {
  EgressProxy,
  EgressResolver,
} from "../../../core/security/mod.ts";

// Re-export sub-module APIs for backward compatibility
export { applyStealthPatches, baseChromeArgs } from "./manager_launch.ts";
export {
  detectChrome,
  findFreePort,
  pollCdpReady,
  withTimeout,
} from "./manager_detection.ts";

const log = createLogger("browser-manager");

// ─── Public types ────────────────────────────────────────────────────────────

/** A running browser instance for a specific agent. */
export interface BrowserInstance {
  /** The agent this instance belongs to. */
  readonly agentId: string;
  /** Filesystem path to the isolated profile directory. */
  readonly profilePath: string;
  /** Classification watermark after launch. */
  readonly watermark: ClassificationLevel;
  /** The puppeteer Page (opaque to consumers outside this module). */
  readonly page: unknown;
}

/** Configuration for the multi-agent browser manager. */
export interface BrowserManagerConfig {
  /** Internal launch transport, supplied by the manager after policy setup. */
  readonly egressProxyUrl?: string;
  /** Trusted resolver injection for transport integration tests. Not a YAML option. */
  readonly egressResolver?: EgressResolver;
  /** Path to Chromium executable. If not set, auto-detected. */
  readonly chromiumPath?: string;
  /** Base directory for per-agent browser profiles. */
  readonly profileBaseDir: string;
  /** Domain classification policy. */
  readonly domainPolicy: DomainPolicy;
  /** Storage provider for watermark persistence. */
  readonly storage: StorageProvider;
  /** Run headless (default true). */
  readonly headless?: boolean;
  /** Viewport dimensions. */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Extra Chromium launch arguments. */
  readonly launchArgs?: readonly string[];
  /** Whether credential autofill is enabled. Defaults to false. */
  readonly credentialAutofill?: boolean;
  /** Maximum time (ms) to wait for Chrome to launch. Default: 30 000. */
  readonly launchTimeoutMs?: number;
  /** Force a specific launch strategy; auto-detected if unset. */
  readonly launchStrategy?: "direct" | "flatpak";
}

/** Multi-agent browser manager interface. */
export interface BrowserManager {
  /** Launch (or reuse) a browser for an agent, checking watermark access. */
  launch(
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Result<BrowserInstance, string>>;
  /** Close the browser for a specific agent. */
  close(agentId: string): Promise<void>;
  /** Check whether an agent currently has a running browser. */
  isRunning(agentId: string): boolean;
  /** Read the stored profile watermark for an agent (returns a Promise). */
  getProfileWatermark(agentId: string): Promise<ClassificationLevel | null>;
  /** The domain security policy. */
  readonly domainPolicy: DomainPolicy;
}

// ─── Internal types ──────────────────────────────────────────────────────────

/** Internal state for a running browser instance. */
interface RunningBrowser {
  readonly browser: Browser;
  readonly page: Page;
  readonly instance: BrowserInstance;
  readonly egressProxy: EgressProxy;
}

// ─── Public factory ──────────────────────────────────────────────────────────

/**
 * Create a multi-agent browser manager.
 *
 * Each agent gets an isolated Chromium profile under `profileBaseDir/<agentId>/profile/`.
 * Profile watermarks are persisted via StorageProvider and enforce escalation-only access.
 *
 * @param config - Browser manager configuration
 * @returns A BrowserManager instance
 */
/** Resolve Chrome binary detection, handling config overrides. */
async function resolveChromeDetection(
  config: BrowserManagerConfig,
): Promise<ChromeDetection | undefined> {
  if (config.chromiumPath && config.launchStrategy !== "flatpak") {
    return { kind: "direct", target: config.chromiumPath };
  }
  let detection = await detectChrome();
  if (
    detection && config.launchStrategy === "flatpak" &&
    detection.kind === "direct"
  ) {
    const flatpakBinPath = await findFlatpakBin();
    if (flatpakBinPath) {
      detection = {
        kind: "flatpak",
        target: detection.target,
        flatpakBin: flatpakBinPath,
      };
    }
  }
  return detection;
}

/** Apply viewport, stealth patches, and register a browser instance. */
async function finalizeBrowserLaunch(
  agentId: string,
  profilePath: string,
  watermark: ClassificationLevel,
  browser: Browser,
  page: Page,
  instances: Map<string, RunningBrowser>,
  config: BrowserManagerConfig,
  strategy: string,
  egressProxy: EgressProxy,
): Promise<BrowserInstance> {
  const vp = config.viewport ?? DEFAULT_VIEWPORT;
  await page.setViewport({ width: vp.width, height: vp.height });
  await applyStealthPatches(page);
  const instance: BrowserInstance = { agentId, profilePath, watermark, page };
  instances.set(agentId, { browser, page, instance, egressProxy });
  browser.on("disconnected", () => {
    if (instances.get(agentId)?.browser === browser) instances.delete(agentId);
    void egressProxy.close().catch((err) =>
      log.warn("Browser egress shutdown failed", {
        operation: "finalizeBrowserLaunch",
        agentId,
        err,
      })
    );
  });
  log.debug("browser launch success", { agentId, strategy, watermark });
  return instance;
}

export function createBrowserManager(
  config: BrowserManagerConfig,
): BrowserManager {
  const instances = new Map<string, RunningBrowser>();

  return {
    get domainPolicy(): DomainPolicy {
      return config.domainPolicy;
    },

    async launch(
      agentId: string,
      sessionTaint: ClassificationLevel,
    ): Promise<Result<BrowserInstance, string>> {
      log.debug("browser launch start", { agentId, sessionTaint });
      const currentWatermark = await retrieveWatermark(config.storage, agentId);
      if (
        currentWatermark !== null &&
        !canAccessProfile(currentWatermark, sessionTaint)
      ) {
        return {
          ok: false,
          error:
            `Profile watermark ${currentWatermark} exceeds session taint ${sessionTaint}`,
        };
      }
      const watermark = await escalateWatermark(
        config.storage,
        agentId,
        sessionTaint,
      );
      const existing = instances.get(agentId);
      if (existing) return { ok: true, value: existing.instance };
      const detection = await resolveChromeDetection(config);
      if (!detection) {
        return {
          ok: false,
          error:
            "No Chromium executable found. Set chromiumPath in config or install Chromium/Chrome.",
        };
      }
      const profilePath = `${config.profileBaseDir}/${agentId}/profile`;
      try {
        await Deno.mkdir(profilePath, { recursive: true });
      } catch { /* may exist */ }
      const timeoutMs = config.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
      const egress = createEgressProxy(async (hostname, port) => {
        const host = hostname.includes(":") ? `[${hostname}]` : hostname;
        const url = `${port === 443 ? "https" : "http"}://${host}:${port}/`;
        if (!config.domainPolicy.isAllowed(url)) {
          return {
            ok: false,
            error: "Browser connection blocked by domain policy",
          };
        }
        return await (config.egressResolver ?? resolveAndCheck)(hostname, port);
      });
      if (!egress.ok) return egress;
      const launchConfig = { ...config, egressProxyUrl: egress.value.url };
      const result = detection.kind === "flatpak"
        ? await launchFlatpak(launchConfig, detection, profilePath, timeoutMs)
        : await launchDirect(
          launchConfig,
          detection.target,
          profilePath,
          timeoutMs,
        );
      if (!result.ok) {
        await egress.value.close();
        return result;
      }
      try {
        const instance = await finalizeBrowserLaunch(
          agentId,
          profilePath,
          watermark,
          result.value.browser,
          result.value.page,
          instances,
          config,
          detection.kind,
          egress.value,
        );
        return { ok: true, value: instance };
      } catch (err) {
        log.error("Browser initialization failed", {
          operation: "launchBrowser",
          agentId,
          err,
        });
        try {
          await result.value.browser.close();
        } catch (closeError) {
          log.warn("Browser initialization cleanup failed", {
            operation: "launchBrowser",
            agentId,
            err: closeError,
          });
        }
        await egress.value.close();
        return { ok: false, error: "Browser initialization failed" };
      }
    },

    async close(agentId: string): Promise<void> {
      const running = instances.get(agentId);
      if (!running) return;

      try {
        await running.browser.close();
      } catch (err) {
        log.warn("Browser close failed", {
          operation: "closeBrowser",
          agentId,
          err,
        });
      } finally {
        await running.egressProxy.close();
      }

      instances.delete(agentId);
    },

    isRunning(agentId: string): boolean {
      return instances.has(agentId);
    },

    getProfileWatermark(
      agentId: string,
    ): Promise<ClassificationLevel | null> {
      return retrieveWatermark(config.storage, agentId);
    },
  };
}
