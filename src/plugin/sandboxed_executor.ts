/**
 * Plugin execution trust gate.
 *
 * In-process execution provides no runtime isolation. Until an isolated
 * runtime exists, sandboxed requests fail closed before executor creation.
 * Trusted plugins run with normal process permissions.
 *
 * @module
 */

import type { LoadedPlugin, PluginContext, PluginTrustLevel } from "./types.ts";
import type { Result } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-sandbox");

/** SubsystemExecutor signature (matches gateway executor_types.ts). */
type SubsystemExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string | null>;

/**
 * Resolve the effective trust level for a plugin.
 *
 * A plugin only runs as "trusted" if BOTH the manifest declares
 * `trust: "trusted"` AND the user config grants `trust: "trusted"`.
 * All other combinations result in "sandboxed".
 */
export function resolveEffectiveTrust(
  manifestTrust: PluginTrustLevel,
  configTrust: PluginTrustLevel,
): PluginTrustLevel {
  return (manifestTrust === "trusted" && configTrust === "trusted")
    ? "trusted"
    : "sandboxed";
}

/**
 * Initialize a trusted executor; reject unsupported sandbox requests.
 */
export async function initializePluginExecutor(
  plugin: LoadedPlugin,
  context: PluginContext,
  effectiveTrust: PluginTrustLevel,
): Promise<Result<SubsystemExecutor, string>> {
  const manifest = plugin.exports.manifest;
  if (effectiveTrust !== "trusted" || manifest.trust !== "trusted") {
    log.warn("Plugin execution blocked: sandboxed runtime is unavailable", {
      operation: "initializePluginExecutor",
      plugin: manifest.name,
    });
    return {
      ok: false,
      error: "Plugin execution blocked: sandboxed runtime is unavailable",
    };
  }
  log.info("Initializing explicitly trusted plugin with process permissions", {
    operation: "initializePluginExecutor",
    plugin: manifest.name,
  });
  try {
    return { ok: true, value: await plugin.exports.createExecutor(context) };
  } catch (err) {
    log.error("Plugin executor initialization failed", {
      operation: "initializePluginExecutor",
      plugin: manifest.name,
      err,
    });
    return {
      ok: false,
      error: `Plugin initialization failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
