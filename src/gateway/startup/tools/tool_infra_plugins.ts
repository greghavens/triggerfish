/**
 * Plugin initialization for the tool infrastructure.
 *
 * Scans the plugins directory, filters by config-enabled plugins,
 * enforces trust levels, creates executors, and registers them.
 * Only config-enabled plugins are ever imported; plugins without
 * config-granted trust load and execute inside a restricted worker.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import {
  acquirePluginExecutor,
  createPluginRegistry,
  namespaceToolDefinitions,
  scanPluginDirectory,
  scanPluginsDirectory,
} from "../../../plugin/mod.ts";
import type {
  PluginContext,
  PluginRegistry,
  PluginTrustLevel,
} from "../../../plugin/mod.ts";

const pluginLog = createLogger("plugin-init");

/** Per-plugin entry from the `plugins:` config block. */
interface PluginConfigEntry {
  readonly enabled?: boolean;
  readonly trust?: PluginTrustLevel;
  readonly classification?: string;
}

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

  const names = await scanPluginsDirectory(pluginsDir);
  const pluginsConfig = (config.plugins ?? {}) as Record<
    string,
    PluginConfigEntry | undefined
  >;

  for (const name of names) {
    const pluginCfg = pluginsConfig[name];
    if (!pluginCfg?.enabled) {
      pluginLog.info("Plugin skipped: not enabled in config", {
        operation: "initializePlugins",
        plugin: name,
      });
      continue;
    }
    await initializeSinglePlugin(name, `${pluginsDir}/${name}`, pluginCfg, {
      registry,
      getSessionTaint,
      toolClassifications,
      integrationClassifications,
    });
  }

  return registry;
}

/** Shared infrastructure passed to each plugin initialization. */
interface PluginInitInfra {
  readonly registry: PluginRegistry;
  readonly getSessionTaint: () => ClassificationLevel;
  readonly toolClassifications: Map<string, ClassificationLevel>;
  readonly integrationClassifications: Map<string, ClassificationLevel>;
}

/** Scan, acquire, and register one config-enabled plugin. */
async function initializeSinglePlugin(
  name: string,
  pluginDir: string,
  pluginCfg: PluginConfigEntry,
  infra: PluginInitInfra,
): Promise<void> {
  // Security scan before any import (host or worker)
  const scanResult = await scanPluginDirectory(pluginDir);
  if (!scanResult.ok) {
    pluginLog.warn("Plugin blocked by security scanner", {
      operation: "initializePlugins",
      plugin: name,
      warnings: scanResult.warnings,
    });
    return;
  }

  const acquired = await acquirePluginExecutor({
    pluginDir,
    configTrust: pluginCfg.trust ?? "sandboxed",
    context: buildStartupPluginContext(name, pluginCfg, infra.getSessionTaint),
  });
  if (!acquired.ok) {
    pluginLog.error("Plugin initialization failed", {
      operation: "initializePlugins",
      plugin: name,
      err: acquired.error,
    });
    return;
  }

  const { loaded, executor, effectiveTrust, dispose } = acquired.value;
  if (loaded.exports.manifest.name !== name) {
    pluginLog.warn("Plugin name mismatch", {
      operation: "initializePlugins",
      directory: name,
      manifestName: loaded.exports.manifest.name,
    });
    dispose?.();
    return;
  }

  infra.registry.registerPlugin({
    loaded,
    executor,
    namespacedTools: namespaceToolDefinitions(
      name,
      loaded.exports.toolDefinitions,
    ),
    ...(dispose ? { dispose } : {}),
  });

  const classification = loaded.exports.manifest.classification;
  const prefix = `plugin_${name}_`;
  infra.toolClassifications.set(prefix, classification);
  infra.integrationClassifications.set(prefix, classification);
  pluginLog.info("Plugin initialized", {
    operation: "initializePlugins",
    plugin: name,
    effectiveTrust,
  });
}

/** Build the PluginContext used for startup-registered plugins. */
function buildStartupPluginContext(
  name: string,
  pluginCfg: PluginConfigEntry,
  getSessionTaint: () => ClassificationLevel,
): PluginContext {
  return {
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
}
