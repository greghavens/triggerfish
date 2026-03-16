/**
 * Plugin initialization for the tool infrastructure.
 *
 * Scans the plugins directory, filters by config-enabled plugins,
 * enforces trust levels, creates executors, and registers them.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import {
  createPluginRegistry,
  initializePluginExecutor,
  loadPluginsFromDirectory,
  namespaceToolDefinitions,
  resolveEffectiveTrust,
  scanPluginDirectory,
} from "../../../plugin/mod.ts";
import type {
  PluginContext,
  PluginRegistry,
  PluginTrustLevel,
} from "../../../plugin/mod.ts";

const pluginLog = createLogger("plugin-init");

/**
 * Initialize dynamically loaded plugins from `~/.triggerfish/plugins/`.
 *
 * Scans the plugins directory, filters by config-enabled plugins,
 * enforces trust levels, creates executors, and registers them.
 */
export async function initializePlugins(
  config: TriggerFishConfig,
  getSessionTaint: () => ClassificationLevel,
  toolClassifications: Map<string, ClassificationLevel>,
  integrationClassifications: Map<string, ClassificationLevel>,
): Promise<PluginRegistry> {
  const registry = createPluginRegistry();
  const homeDir = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  const pluginsDir = `${homeDir}/.triggerfish/plugins`;

  const loadResult = await loadPluginsFromDirectory(pluginsDir);
  if (!loadResult.ok) {
    pluginLog.warn("Plugin directory load failed", {
      operation: "initializePlugins",
      error: loadResult.error,
    });
    return registry;
  }

  const loaded = loadResult.value;
  if (loaded.length === 0) return registry;

  const pluginsConfig = (config.plugins ?? {}) as Record<
    string,
    | { enabled?: boolean; trust?: PluginTrustLevel; classification?: string }
    | undefined
  >;

  for (const plugin of loaded) {
    const name = plugin.exports.manifest.name;
    const pluginCfg = pluginsConfig[name];
    if (!pluginCfg?.enabled) {
      pluginLog.info("Plugin skipped: not enabled in config", {
        operation: "initializePlugins",
        plugin: name,
      });
      continue;
    }

    // Security scan before initialization
    const pluginDir = plugin.sourcePath.replace(/\/mod\.ts$/, "");
    const scanResult = await scanPluginDirectory(pluginDir);
    if (!scanResult.ok) {
      pluginLog.warn("Plugin blocked by security scanner", {
        operation: "initializePlugins",
        plugin: name,
        warnings: scanResult.warnings,
      });
      continue;
    }

    const configTrust: PluginTrustLevel = pluginCfg.trust ?? "sandboxed";
    const effectiveTrust = resolveEffectiveTrust(
      plugin.exports.manifest.trust,
      configTrust,
    );

    const context: PluginContext = {
      pluginName: name,
      getSessionTaint,
      escalateTaint: () => {
        // Taint escalation is handled by the hook runner at the gateway layer.
        // Plugins cannot directly escalate taint — this is a no-op placeholder.
      },
      log: {
        debug: (msg, ctx) => pluginLog.debug(msg, { ...ctx, plugin: name }),
        info: (msg, ctx) => pluginLog.info(msg, { ...ctx, plugin: name }),
        warn: (msg, ctx) => pluginLog.warn(msg, { ...ctx, plugin: name }),
        error: (msg, ctx) => pluginLog.error(msg, { ...ctx, plugin: name }),
      },
      config: (pluginCfg as Record<string, unknown>) ?? {},
    };

    try {
      const executor = await initializePluginExecutor(
        plugin,
        context,
        effectiveTrust,
      );
      const namespacedTools = namespaceToolDefinitions(
        name,
        plugin.exports.toolDefinitions,
      );

      registry.registerPlugin({
        loaded: plugin,
        executor,
        namespacedTools,
      });

      // Inject plugin classifications into the mutable maps
      const classification = plugin.exports.manifest.classification;
      const prefix = `plugin_${name}_`;
      toolClassifications.set(prefix, classification);
      integrationClassifications.set(prefix, classification);
    } catch (err) {
      pluginLog.error("Plugin initialization failed", {
        operation: "initializePlugins",
        plugin: name,
        err,
      });
    }
  }

  return registry;
}
