/**
 * Plugin SDK, Sandbox, and dynamic loader module.
 *
 * Provides sandboxed execution environments for plugins, a
 * permission-aware SDK for data access and emission, and a dynamic
 * plugin loader that scans `~/.triggerfish/plugins/` at startup.
 *
 * Includes Pyodide WASM support for Python plugin execution.
 *
 * @module
 */

export { createSandbox } from "./sandbox.ts";
export type { Sandbox, SandboxConfig, SandboxDnsChecker } from "./sandbox.ts";

export { createPythonSandbox } from "./python_sandbox.ts";
export type {
  PyodideInstance,
  PyodideLoader,
  PythonSandbox,
  PythonSandboxConfig,
} from "./python_sandbox.ts";

export { createPluginSdk } from "./sdk.ts";
export type {
  EmitDataPayload,
  PluginCapability,
  PluginSdk,
  PluginSdkConfig,
  QueryHandler,
  QueryResult,
} from "./sdk.ts";

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
  loadPluginsFromDirectory,
  scanPluginsDirectory,
  validatePluginExports,
  validatePluginManifest,
} from "./loader.ts";

export { createPluginRegistry } from "./registry.ts";
export type { PluginRegistry } from "./registry.ts";

export { createPluginExecutor } from "./executor.ts";

export {
  initializePluginExecutor,
  resolveEffectiveTrust,
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
