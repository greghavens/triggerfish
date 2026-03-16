/**
 * Plugin management tool handler functions.
 *
 * Implements the runtime logic for plugin_list, plugin_install,
 * plugin_reload, and plugin_scan tool invocations.
 *
 * @module
 */

import type { PluginRegistry } from "./registry.ts";
import type { PluginContext, PluginTrustLevel } from "./types.ts";
import type { PluginToolsOptions } from "./tools.ts";
import { importPluginModule } from "./loader.ts";
import { namespaceToolDefinitions } from "./namespace.ts";
import {
  initializePluginExecutor,
  resolveEffectiveTrust,
} from "./sandboxed_executor.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-tools");

/** Format plugin list for display. */
export function executePluginList(registry: PluginRegistry): string {
  const plugins = registry.getAllPlugins();
  if (plugins.length === 0) {
    return "No plugins are currently registered.";
  }
  const entries = plugins.map((p) => {
    const m = p.loaded.exports.manifest;
    return {
      name: m.name,
      version: m.version,
      classification: m.classification,
      trust: m.trust,
      tools: p.namespacedTools.map((t) => t.name),
      source: p.loaded.sourcePath,
    };
  });
  return JSON.stringify(entries, null, 2);
}

/** Resolve the plugin directory path from name and optional explicit path. */
export function resolvePluginDir(
  name: string,
  explicitPath?: string,
): string {
  if (explicitPath) {
    return explicitPath;
  }
  const homeDir = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  return `${homeDir}/.triggerfish/plugins/${name}`;
}

/** Build a PluginContext for a plugin. */
export function buildPluginContext(
  name: string,
  opts: PluginToolsOptions,
  pluginCfg: Record<string, unknown>,
): PluginContext {
  return {
    pluginName: name,
    getSessionTaint: opts.getSessionTaint,
    escalateTaint: () => {},
    log: {
      debug: (msg, ctx) => log.debug(msg, { ...ctx, plugin: name }),
      info: (msg, ctx) => log.info(msg, { ...ctx, plugin: name }),
      warn: (msg, ctx) => log.warn(msg, { ...ctx, plugin: name }),
      error: (msg, ctx) => log.error(msg, { ...ctx, plugin: name }),
    },
    config: pluginCfg,
  };
}

/** Run security scan on a plugin directory. */
export async function executePluginScan(
  path: string,
  opts: PluginToolsOptions,
): Promise<string> {
  const scanResult = await opts.scanPlugin(path);
  if (scanResult.ok) {
    return JSON.stringify({
      ok: true,
      message: "Plugin passed security scan.",
      scannedFiles: scanResult.scannedFiles,
    });
  }
  return JSON.stringify({
    ok: false,
    message: "Plugin failed security scan.",
    warnings: scanResult.warnings,
    scannedFiles: scanResult.scannedFiles,
  });
}

/** Install a plugin at runtime from a name or explicit path. */
export async function executePluginInstall(
  name: string,
  opts: PluginToolsOptions,
  explicitPath?: string,
): Promise<string> {
  if (opts.registry.getPlugin(name)) {
    return `Plugin "${name}" is already registered. Use plugin_reload to update it.`;
  }

  const pluginDir = resolvePluginDir(name, explicitPath);
  const modPath = `${pluginDir}/mod.ts`;

  // Security scan is mandatory
  const scanResult = await opts.scanPlugin(pluginDir);
  if (!scanResult.ok) {
    log.warn("Plugin install blocked by security scanner", {
      operation: "executePluginInstall",
      plugin: name,
      warnings: scanResult.warnings,
    });
    return `Plugin "${name}" failed security scan: ${
      scanResult.warnings.join("; ")
    }`;
  }

  const importResult = await importPluginModule(modPath);
  if (!importResult.ok) {
    return `Plugin install failed: ${importResult.error}`;
  }

  if (importResult.value.manifest.name !== name) {
    return `Plugin directory "${name}" does not match manifest name "${importResult.value.manifest.name}"`;
  }

  // Config is optional — fall back to sandboxed with manifest classification
  const pluginCfg = opts.pluginsConfig[name];
  const configTrust: PluginTrustLevel = pluginCfg?.trust ?? "sandboxed";
  const effectiveTrust = resolveEffectiveTrust(
    importResult.value.manifest.trust,
    configTrust,
  );

  const context = buildPluginContext(
    name,
    opts,
    (pluginCfg as Record<string, unknown>) ?? {},
  );

  try {
    const executor = await initializePluginExecutor(
      { exports: importResult.value, sourcePath: modPath },
      context,
      effectiveTrust,
    );
    const namespacedTools = namespaceToolDefinitions(
      name,
      importResult.value.toolDefinitions,
    );

    opts.registry.registerPlugin({
      loaded: { exports: importResult.value, sourcePath: modPath },
      executor,
      namespacedTools,
    });

    const classification = importResult.value.manifest.classification;
    const prefix = `plugin_${name}_`;
    opts.toolClassifications.set(prefix, classification);
    opts.integrationClassifications.set(prefix, classification);

    log.info("Plugin installed at runtime", {
      operation: "executePluginInstall",
      plugin: name,
      version: importResult.value.manifest.version,
      effectiveTrust,
      source: modPath,
    });

    return `Plugin "${name}@${importResult.value.manifest.version}" installed successfully (${effectiveTrust}). Tools: ${
      namespacedTools.map((t) => t.name).join(", ")
    }`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Plugin "${name}" initialization failed: ${msg}`;
  }
}

/** Reload a plugin by unregistering and re-importing from its original source. */
export async function executePluginReload(
  name: string,
  opts: PluginToolsOptions,
): Promise<string> {
  const existing = opts.registry.getPlugin(name);
  if (!existing) {
    return `Plugin "${name}" is not registered. Use plugin_install first.`;
  }

  // Derive the plugin directory from the stored source path
  const sourcePath = existing.loaded.sourcePath;
  const pluginDir = sourcePath.replace(/\/mod\.ts$/, "");

  // Remove old registration
  opts.registry.unregisterPlugin(name);
  const prefix = `plugin_${name}_`;
  opts.toolClassifications.delete(prefix);
  opts.integrationClassifications.delete(prefix);

  // Re-install from original source location
  const result = await executePluginInstall(name, opts, pluginDir);
  if (result.includes("failed") || result.includes("blocked")) {
    // Rollback: re-register the old version
    opts.registry.registerPlugin(existing);
    const classification = existing.loaded.exports.manifest.classification;
    opts.toolClassifications.set(prefix, classification);
    opts.integrationClassifications.set(prefix, classification);
    return `Plugin "${name}" reload failed (old version restored): ${result}`;
  }
  return result.replace("installed", "reloaded");
}
