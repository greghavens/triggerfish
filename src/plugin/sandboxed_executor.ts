/**
 * Trust-aware plugin acquisition.
 *
 * Decides how a plugin is imported and executed based on trust:
 *
 * - Config grants `trust: "trusted"` AND the manifest declares
 *   `trust: "trusted"` → the module is imported in the host process and
 *   its executor runs with daemon permissions.
 * - Every other combination → the module is imported and executed inside
 *   a permission-restricted Deno Worker (`worker_host.ts`): read access
 *   to the plugin's own directory, net access to declared endpoints
 *   only, no env/run/write/ffi/sys. Host code never imports the module.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type {
  LoadedPlugin,
  PluginContext,
  PluginExports,
  PluginToolExecutor,
  PluginTrustLevel,
} from "./types.ts";
import { importPluginModule, validatePluginExports } from "./loader.ts";
import type { SerializedPluginExports } from "./worker_host.ts";
import { createPluginWorker, inspectPluginModule } from "./worker_host.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-sandbox");

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

/** A plugin acquired with its executor and effective trust level. */
export interface AcquiredPlugin {
  /** Validated plugin exports (loaded in host or reconstructed from worker). */
  readonly loaded: LoadedPlugin;
  /** Executor honoring the effective trust level. */
  readonly executor: PluginToolExecutor;
  /** Trust level the plugin actually runs at. */
  readonly effectiveTrust: PluginTrustLevel;
  /** Terminates the sandbox worker. Absent for trusted plugins. */
  readonly dispose?: () => void;
}

/** Options for acquiring a plugin. */
export interface AcquirePluginOptions {
  /** Absolute path to the plugin directory containing mod.ts. */
  readonly pluginDir: string;
  /** Trust level granted by user config (default "sandboxed"). */
  readonly configTrust: PluginTrustLevel;
  /** Context for executor creation and logging. */
  readonly context: PluginContext;
}

/**
 * Acquire a plugin's exports and executor with trust enforcement.
 *
 * Host import happens ONLY when the user config grants trust; otherwise
 * the module never leaves the restricted worker.
 */
export function acquirePluginExecutor(
  opts: AcquirePluginOptions,
): Promise<Result<AcquiredPlugin, string>> {
  const modPath = `${opts.pluginDir}/mod.ts`;
  if (opts.configTrust === "trusted") {
    return acquireConfigTrustedPlugin(modPath, opts);
  }
  return acquireWorkerPlugin(modPath, opts);
}

/** Acquire a plugin whose config grants trust (host import permitted). */
async function acquireConfigTrustedPlugin(
  modPath: string,
  opts: AcquirePluginOptions,
): Promise<Result<AcquiredPlugin, string>> {
  const imported = await importPluginModule(modPath, {
    enabled: true,
    trust: "trusted",
  });
  if (!imported.ok) return imported;

  const effectiveTrust = resolveEffectiveTrust(
    imported.value.manifest.trust,
    "trusted",
  );
  if (effectiveTrust === "sandboxed") {
    // Manifest requests a sandbox despite config trust — honor it.
    return buildWorkerBackedPlugin(
      {
        manifest: imported.value.manifest,
        toolDefinitions: imported.value.toolDefinitions,
        systemPrompt: imported.value.systemPrompt,
        hasCreateExecutor: true,
      },
      modPath,
      opts,
    );
  }

  log.info("Plugin running as trusted in host process", {
    operation: "acquirePluginExecutor",
    plugin: imported.value.manifest.name,
    effectiveTrust,
  });
  const executor = await imported.value.createExecutor(opts.context);
  return {
    ok: true,
    value: {
      loaded: { exports: imported.value, sourcePath: modPath },
      executor,
      effectiveTrust,
    },
  };
}

/** Acquire a never-trusted plugin — the host never imports its module. */
async function acquireWorkerPlugin(
  modPath: string,
  opts: AcquirePluginOptions,
): Promise<Result<AcquiredPlugin, string>> {
  const inspected = await inspectPluginModule(
    modPath,
    opts.pluginDir,
    opts.context.log,
  );
  if (!inspected.ok) {
    return {
      ok: false,
      error: `Plugin import failed at ${modPath}: ${inspected.error}`,
    };
  }
  return buildWorkerBackedPlugin(inspected.value, modPath, opts);
}

/** Build a worker-backed plugin from serialized exports. */
function buildWorkerBackedPlugin(
  data: SerializedPluginExports,
  modPath: string,
  opts: AcquirePluginOptions,
): Result<AcquiredPlugin, string> {
  let workerExecute: PluginToolExecutor = () =>
    Promise.reject(new Error("Plugin sandbox worker not yet created"));
  const candidate: Record<string, unknown> = {
    manifest: data.manifest,
    toolDefinitions: data.toolDefinitions,
    createExecutor: data.hasCreateExecutor ? () => workerExecute : undefined,
  };
  if (data.systemPrompt !== undefined) {
    candidate.systemPrompt = data.systemPrompt;
  }

  const validated = validatePluginExports(candidate, modPath);
  if (!validated.ok) return validated;

  const exports: PluginExports = validated.value;
  const worker = createPluginWorker({
    modPath,
    pluginDir: opts.pluginDir,
    declaredEndpoints: exports.manifest.declaredEndpoints,
    pluginName: exports.manifest.name,
    pluginConfig: opts.context.config,
    getSessionTaint: opts.context.getSessionTaint,
    pluginLog: opts.context.log,
  });
  workerExecute = worker.execute;

  log.info("Plugin running sandboxed in restricted worker", {
    operation: "acquirePluginExecutor",
    plugin: exports.manifest.name,
    declaredEndpoints: exports.manifest.declaredEndpoints,
  });
  return {
    ok: true,
    value: {
      loaded: { exports, sourcePath: modPath },
      executor: worker.execute,
      effectiveTrust: "sandboxed",
      dispose: worker.terminate,
    },
  };
}

/** Initialize a previously loaded explicitly trusted executor. */
export async function initializePluginExecutor(
  plugin: LoadedPlugin,
  context: PluginContext,
  effectiveTrust: PluginTrustLevel,
): Promise<Result<PluginToolExecutor, string>> {
  const manifest = plugin.exports.manifest;
  if (effectiveTrust !== "trusted" || manifest.trust !== "trusted") {
    log.warn(
      "Plugin execution blocked: a loaded module can only initialize as trusted",
      {
        operation: "initializePluginExecutor",
        plugin: manifest.name,
      },
    );
    return {
      ok: false,
      error:
        "Plugin execution blocked: a loaded module can only initialize as trusted",
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
