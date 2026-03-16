/**
 * Browser tool executor — tool definitions, dispatch routing,
 * auto-launch lifecycle, and profile watermarking.
 *
 * @module
 */

export {
  BROWSER_TOOLS_SYSTEM_PROMPT,
  buildBrowserToolDefinitions,
  getBrowserToolDefinitions,
} from "./tools_defs.ts";

export {
  type BrowserToolExecutorFn,
  type BrowserToolExecutorOptions,
  createBrowserToolExecutor,
} from "./tools_executor_dispatch.ts";

export {
  type AutoLaunchBrowserConfig,
  type BrowserExecutorHandle,
  createAutoLaunchBrowserExecutor,
} from "./tools_executor_autolaunch.ts";

export {
  canAccessProfile,
  escalateWatermark,
  getWatermark,
  type ProfileWatermark,
  retrieveWatermark,
  watermarkKey,
} from "./watermark.ts";
