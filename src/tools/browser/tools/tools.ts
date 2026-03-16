/**
 * Browser interaction tools for CDP-based automation.
 *
 * Provides navigate, snapshot, click, type, select, scroll, and wait
 * operations. Navigation enforces SSRF prevention (DNS resolve + IP
 * denylist) and domain policy checks. Screenshots return base64 PNG
 * with extracted text content.
 *
 * Tool definitions live in `tools_defs.ts`; executor logic in
 * `tools_executor.ts`. Types in `tools_types.ts`, navigation helpers
 * in `tools_navigation.ts`, page helpers in `tools_page.ts`.
 *
 * @module
 */

import type { Page } from "puppeteer-core";
import type { Result } from "../../../core/types/classification.ts";
import { resolveAndCheck } from "../../web/domains.ts";
import type {
  BrowserTools,
  BrowserToolsConfig,
  DnsChecker,
  NavigateResult,
} from "./tools_types.ts";
import {
  enforceBrowserNavigationPolicy,
  navigateBrowserPage,
  parseNavigationUrl,
} from "./tools_navigation.ts";
import { captureBrowserSnapshot, scrollBrowserPage } from "./tools_page.ts";

// ─── Barrel re-exports ──────────────────────────────────────────────────────

export {
  BROWSER_TOOLS_SYSTEM_PROMPT,
  buildBrowserToolDefinitions,
  getBrowserToolDefinitions,
} from "../executor/tools_defs.ts";
export {
  type AutoLaunchBrowserConfig,
  type BrowserExecutorHandle,
  type BrowserToolExecutorOptions,
  createAutoLaunchBrowserExecutor,
  createBrowserToolExecutor,
} from "../executor/tools_executor.ts";
export type {
  BrowserTools,
  BrowserToolsConfig,
  DnsChecker,
  NavigateResult,
  PageLink,
  ScrollDirection,
  SnapshotResult,
} from "./tools_types.ts";

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create browser tools backed by a CDP page connection.
 *
 * All navigation checks SSRF denylist (via DNS resolution) and domain
 * policy before proceeding. Tool results follow the Result<T, E> pattern.
 *
 * @param config - Page, domain policy, and optional DNS checker
 * @returns BrowserTools for interacting with the browser page
 */
export function createBrowserTools(config: BrowserToolsConfig): BrowserTools {
  const page = config.page as Page;
  const dnsCheck: DnsChecker = config.dnsChecker ?? resolveAndCheck;

  return {
    async navigate(url: string): Promise<Result<NavigateResult, string>> {
      const parsed = parseNavigationUrl(url);
      if (!parsed.ok) return parsed;

      const policy = await enforceBrowserNavigationPolicy(
        url,
        parsed.value.hostname,
        dnsCheck,
        config.domainPolicy,
      );
      if (!policy.ok) return policy;

      return navigateBrowserPage(page, url);
    },

    snapshot() {
      return captureBrowserSnapshot(page);
    },

    async click(selector: string): Promise<Result<void, string>> {
      try {
        await page.click(selector);
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: `Click failed on "${selector}": ${(err as Error).message}`,
        };
      }
    },

    async type(
      selector: string,
      text: string,
    ): Promise<Result<void, string>> {
      try {
        await page.type(selector, text);
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: `Type failed on "${selector}": ${(err as Error).message}`,
        };
      }
    },

    async select(
      selector: string,
      value: string,
    ): Promise<Result<void, string>> {
      try {
        await page.select(selector, value);
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: `Select failed on "${selector}": ${(err as Error).message}`,
        };
      }
    },

    scroll(direction, amount?) {
      return scrollBrowserPage(page, direction, amount);
    },

    async wait(
      selector?: string,
      timeout?: number,
    ): Promise<Result<boolean, string>> {
      try {
        if (selector) {
          await page.waitForSelector(selector, {
            timeout: timeout ?? 10000,
          });
          return { ok: true, value: true };
        }

        await new Promise<void>((r) => setTimeout(r, timeout ?? 10000));
        return { ok: true, value: true };
      } catch (err) {
        return {
          ok: false,
          error: `Wait failed: ${(err as Error).message}`,
        };
      }
    },

    async close(): Promise<Result<void, string>> {
      try {
        await page.browser().close();
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: `Browser close failed: ${(err as Error).message}`,
        };
      }
    },
  };
}
