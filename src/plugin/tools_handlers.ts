/**
 * Plugin management tool handler functions.
 *
 * Implements the runtime logic for plugin_list, plugin_install,
 * plugin_reload, and plugin_scan tool invocations.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import { resolve } from "@std/path";
import { isRealPathWithinJail } from "../core/security/path_jail.ts";
import type { PluginRegistry } from "./registry.ts";
import type { PluginContext, PluginTrustLevel } from "./types.ts";
import type { PluginToolsOptions } from "./tools.ts";
import { namespaceToolDefinitions } from "./namespace.ts";
import { acquirePluginExecutor } from "./sandboxed_executor.ts";
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

/** Resolve the plugins root directory that plugin_install is jailed to. */
export function resolvePluginsRoot(): string {
  const homeDir = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  return `${homeDir}/.triggerfish/plugins`;
}

/** Resolve the plugin directory path from name and optional explicit path. */
export function resolvePluginDir(
  name: string,
  explicitPath?: string,
): string {
  if (explicitPath) {
    return explicitPath;
  }
  return `${resolvePluginsRoot()}/${name}`;
}

/**
 * Jail a plugin directory to the plugins root before any filesystem access.
 *
 * The `path` parameter of plugin_install is LLM-controlled; without this
 * check an injected path (`/etc`, `../../workspace`, a symlink) would be
 * scanned and then dynamically imported in-process. Only real-path
 * descendants of `~/.triggerfish/plugins` are accepted (fails closed when
 * the root does not exist or the path escapes after symlink resolution).
 */
export function enforcePluginDirJail(
  pluginDir: string,
): Result<string, string> {
  const root = resolvePluginsRoot();
  if (!isRealPathWithinJail(pluginDir, root)) {
    log.warn("Plugin install blocked: path escapes plugins root", {
      operation: "enforcePluginDirJail",
      pluginDir,
      pluginsRoot: root,
    });
    return {
      ok: false,
      error:
        `Plugin install blocked: path "${pluginDir}" escapes the plugins root "${root}". Place the plugin under the plugins root before installing.`,
    };
  }
  return { ok: true, value: pluginDir };
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

  // Jail check runs before the scanner or importer ever touch the path
  const jailed = enforcePluginDirJail(resolvePluginDir(name, explicitPath));
  if (!jailed.ok) {
    return jailed.error;
  }
  const pluginDir = jailed.value;
  if (resolve(pluginDir) !== resolve(resolvePluginDir(name))) {
    log.warn(
      "Plugin install blocked: path does not match configured plugin name",
      {
        operation: "executePluginInstall",
        plugin: name,
        pluginDir,
      },
    );
    return "Plugin install blocked: path does not match configured plugin directory";
  }
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

  const pluginCfg = Object.hasOwn(opts.pluginsConfig, name)
    ? opts.pluginsConfig[name]
    : undefined;
  if (pluginCfg?.enabled !== true) {
    return "Plugin install blocked: configure enabled: true for this plugin.";
  }
  const configTrust: PluginTrustLevel = pluginCfg.trust ?? "sandboxed";

  const context = buildPluginContext(
    name,
    opts,
    (pluginCfg as Record<string, unknown>) ?? {},
  );

  const acquired = await acquirePluginExecutor({
    pluginDir,
    configTrust,
    context,
  });
  if (!acquired.ok) {
    return `Plugin install failed: ${acquired.error}`;
  }
  const { loaded, executor, effectiveTrust, dispose } = acquired.value;

  if (loaded.exports.manifest.name !== name) {
    dispose?.();
    return `Plugin directory "${name}" does not match manifest name "${loaded.exports.manifest.name}"`;
  }

  try {
    const namespacedTools = namespaceToolDefinitions(
      name,
      loaded.exports.toolDefinitions,
    );

    opts.registry.registerPlugin({
      loaded,
      executor,
      namespacedTools,
      ...(dispose ? { dispose } : {}),
    });

    const classification = loaded.exports.manifest.classification;
    const prefix = `plugin_${name}_`;
    opts.toolClassifications.set(prefix, classification);
    opts.integrationClassifications.set(prefix, classification);

    log.info("Plugin installed at runtime", {
      operation: "executePluginInstall",
      plugin: name,
      version: loaded.exports.manifest.version,
      effectiveTrust,
      source: modPath,
    });

    return `Plugin "${name}@${loaded.exports.manifest.version}" installed successfully (${effectiveTrust}). Tools: ${
      namespacedTools.map((t) => t.name).join(", ")
    }`;
  } catch (err) {
    dispose?.();
    log.error("Plugin installation failed", {
      operation: "executePluginInstall",
      plugin: name,
      err,
    });
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
  if (!opts.registry.getPlugin(name)) {
    const grant = Object.hasOwn(opts.pluginsConfig, name)
      ? opts.pluginsConfig[name]
      : undefined;
    if (grant?.enabled !== true || grant.trust !== "trusted") {
      log.warn("Plugin reload blocked: execution grant revoked", {
        operation: "executePluginReload",
        plugin: name,
      });
      return `Plugin "${name}" reload blocked: execution grant revoked; plugin deactivated.`;
    }
    // Rollback: re-register the old version
    opts.registry.registerPlugin(existing);
    const classification = existing.loaded.exports.manifest.classification;
    opts.toolClassifications.set(prefix, classification);
    opts.integrationClassifications.set(prefix, classification);
    return `Plugin "${name}" reload failed (old version restored): ${result}`;
  }
  // The replacement is registered — shut down the old sandbox worker.
  existing.dispose?.();
  return result.replace("installed", "reloaded");
}
