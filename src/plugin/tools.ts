/**
 * LLM-callable plugin management tools.
 *
 * Provides `plugin_list`, `plugin_install`, `plugin_reload`, and
 * `plugin_scan` tools that the agent can invoke to manage plugins at
 * runtime. Execution requires an explicit enabled/trusted grant in user
 * configuration. Untrusted and sandboxed plugins cannot execute.
 *
 * @module
 */

import type { ClassificationLevel } from "../core/types/classification.ts";
import type { PluginRegistry } from "./registry.ts";
import type { PluginTrustLevel } from "./types.ts";

/** Re-export tool definitions. */
export { PLUGIN_TOOL_DEFINITIONS } from "./tools_defs.ts";

/** Re-export handler functions. */
export {
  buildPluginContext,
  enforcePluginDirJail,
  executePluginInstall,
  executePluginList,
  executePluginReload,
  executePluginScan,
  resolvePluginDir,
  resolvePluginsRoot,
} from "./tools_handlers.ts";

import {
  executePluginInstall,
  executePluginList,
  executePluginReload,
  executePluginScan,
} from "./tools_handlers.ts";

/** Options for creating the plugin management executor. */
export interface PluginToolsOptions {
  /** The live plugin registry. */
  readonly registry: PluginRegistry;
  /** Get the current session taint level. */
  readonly getSessionTaint: () => ClassificationLevel;
  /** Plugin configuration from triggerfish.yaml. */
  readonly pluginsConfig: Readonly<
    Record<
      string,
      | {
        readonly enabled?: boolean;
        readonly trust?: PluginTrustLevel;
        readonly classification?: string;
      }
      | undefined
    >
  >;
  /** Mutable tool classifications map to inject plugin prefixes into. */
  readonly toolClassifications: Map<string, ClassificationLevel>;
  /** Mutable integration classifications map. */
  readonly integrationClassifications: Map<string, ClassificationLevel>;
  /** Security scanner for plugin content. */
  readonly scanPlugin: (
    pluginDir: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly warnings: readonly string[];
    readonly scannedFiles: readonly string[];
  }>;
}

/**
 * Create the plugin management tool executor.
 *
 * Returns a SubsystemExecutor that handles plugin_list, plugin_install,
 * plugin_reload, and plugin_scan tool calls. The agent can build a
 * plugin and scan it; activation requires an explicit user execution grant.
 */
export function createPluginToolExecutor(
  opts: PluginToolsOptions,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  const activeChanges = new Set<string>();
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (toolName) {
      case "plugin_list":
        return executePluginList(opts.registry);
      case "plugin_install":
      case "plugin_reload": {
        const name = input.name;
        const install = toolName === "plugin_install";
        if (typeof name !== "string" || name.length === 0) {
          return `Plugin ${
            install ? "install" : "reload"
          } requires a "name" parameter.`;
        }
        if (activeChanges.has(name)) {
          return "This plugin already has a lifecycle change in progress.";
        }
        activeChanges.add(name);
        try {
          const path = typeof input.path === "string" ? input.path : undefined;
          return await (install
            ? executePluginInstall(name, opts, path)
            : executePluginReload(name, opts));
        } finally {
          activeChanges.delete(name);
        }
      }
      case "plugin_scan": {
        const path = input.path;
        if (typeof path !== "string" || path.length === 0) {
          return 'Plugin scan requires a "path" parameter.';
        }
        return executePluginScan(path, opts);
      }
      default:
        return null;
    }
  };
}
