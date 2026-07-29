/**
 * Plugin loader and sandbox module.
 *
 * Dynamically loads plugins from `~/.triggerfish/plugins/`. Plugins
 * without config-granted trust are imported and executed inside a
 * permission-restricted Deno Worker.
 *
 * @module
 */

export type {
  LoadedPlugin,
  PluginContext,
  PluginExports,
  PluginLogger,
  PluginManifest,
  PluginToolExecutor,
  PluginTrustLevel,
  RegisteredPlugin,
} from "./types.ts";

export {
  decodePluginToolName,
  encodePluginToolName,
  namespaceToolDefinitions,
} from "./namespace.ts";

export {
  importPluginModule,
  scanPluginsDirectory,
  validatePluginExports,
  validatePluginManifest,
} from "./loader.ts";

export { createPluginRegistry } from "./registry.ts";
export type { PluginRegistry } from "./registry.ts";

export { createPluginExecutor } from "./executor.ts";

export {
  acquirePluginExecutor,
  resolveEffectiveTrust,
} from "./sandboxed_executor.ts";
export type {
  AcquiredPlugin,
  AcquirePluginOptions,
} from "./sandboxed_executor.ts";

export { createPluginToolExecutor, PLUGIN_TOOL_DEFINITIONS } from "./tools.ts";
export type { PluginToolsOptions } from "./tools.ts";

export { createPluginScanner, scanPluginDirectory } from "./scanner.ts";
export type { PluginScanResult } from "./scanner.ts";

export { createPluginReefRegistry } from "./reef.ts";
export type {
  CatalogCache,
  MutableCatalogCache,
  PluginReefOptions,
  PluginReefRegistry,
  ReefPluginCatalog,
  ReefPluginCatalogEntry,
  ReefPluginListing,
} from "./reef.ts";
