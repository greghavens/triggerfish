/**
 * Browser automation module for Chromium CDP control.
 *
 * Provides domain classification policy, multi-agent browser lifecycle
 * management with watermarking, and page interaction tools with SSRF
 * prevention and security enforcement.
 *
 * Sub-modules:
 * - manager/  — Chrome detection, launch strategies, profile isolation
 * - tools/    — Navigation, snapshot, click, type, select, scroll, wait
 * - executor/ — Tool definitions, dispatch, auto-launch, watermarking
 *
 * @module
 */

export {
  createDomainPolicy,
  type DomainPolicy,
  type DomainPolicyConfig,
} from "./domains.ts";

export {
  applyStealthPatches,
  baseChromeArgs,
  type BrowserInstance,
  type BrowserManager,
  type BrowserManagerConfig,
  createBrowserManager,
} from "./manager/mod.ts";

export {
  type AutoLaunchBrowserConfig,
  BROWSER_TOOLS_SYSTEM_PROMPT,
  type BrowserExecutorHandle,
  type BrowserToolExecutorOptions,
  type BrowserTools,
  type BrowserToolsConfig,
  buildBrowserToolDefinitions,
  createAutoLaunchBrowserExecutor,
  createBrowserToolExecutor,
  createBrowserTools,
  type DnsChecker,
  getBrowserToolDefinitions,
  type NavigateResult,
  type ScrollDirection,
  type SnapshotResult,
} from "./tools/mod.ts";

export {
  canAccessProfile,
  escalateWatermark,
  getWatermark,
  type ProfileWatermark,
  retrieveWatermark,
  watermarkKey,
} from "./executor/mod.ts";
