/**
 * Browser interaction tools — navigate, snapshot, click, type, select,
 * scroll, wait, and close operations with SSRF prevention.
 *
 * @module
 */

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
} from "./tools.ts";

export {
  enforceBrowserNavigationPolicy,
  executeBrowserNavigation,
  navigateBrowserPage,
  parseNavigationUrl,
} from "./tools_navigation.ts";

export {
  captureBrowserSnapshot,
  computeScrollDeltas,
  DEFAULT_SCROLL_PX,
  encodeBufferToBase64,
  scrollBrowserPage,
} from "./tools_page.ts";
