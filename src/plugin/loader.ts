/**
 * Plugin scanner, importer, and validator.
 *
 * Scans `~/.triggerfish/plugins/` for subdirectories containing a `mod.ts`,
 * dynamically imports each module, and validates the exported manifest and
 * tool definitions against the expected PluginExports shape.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import { parseClassification } from "../core/types/classification.ts";
import type {
  LoadedPlugin,
  PluginExports,
  PluginManifest,
  PluginTrustLevel,
} from "./types.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-loader");

const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Scan a plugins directory for subdirectories containing mod.ts. */
export async function scanPluginsDirectory(
  dir: string,
): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory) continue;
      const modPath = `${dir}/${entry.name}/mod.ts`;
      try {
        const stat = await Deno.stat(modPath);
        if (stat.isFile) names.push(entry.name);
      } catch {
        // No mod.ts in this subdirectory — skip
      }
    }
  } catch (err) {
    log.debug("Plugin directory scan skipped", {
      operation: "scanPluginsDirectory",
      dir,
      err,
    });
  }
  return names.sort();
}

/** Validate a plugin manifest object. */
export function validatePluginManifest(
  manifest: unknown,
): Result<PluginManifest, string> {
  if (manifest === null || typeof manifest !== "object") {
    return { ok: false, error: "Plugin manifest is not an object" };
  }
  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== "string" || !PLUGIN_NAME_PATTERN.test(m.name)) {
    return {
      ok: false,
      error: `Plugin manifest name must match ${PLUGIN_NAME_PATTERN} — got "${
        String(m.name)
      }"`,
    };
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    return {
      ok: false,
      error: "Plugin manifest version must be a non-empty string",
    };
  }
  if (typeof m.description !== "string" || m.description.length === 0) {
    return {
      ok: false,
      error: "Plugin manifest description must be a non-empty string",
    };
  }

  const classResult = parseClassification(
    typeof m.classification === "string" ? m.classification : "",
  );
  if (!classResult.ok) {
    return {
      ok: false,
      error: `Plugin manifest classification invalid: ${classResult.error}`,
    };
  }

  const trust = m.trust as PluginTrustLevel | undefined;
  if (trust !== "sandboxed" && trust !== "trusted") {
    return {
      ok: false,
      error: `Plugin manifest trust must be "sandboxed" or "trusted" — got "${
        String(trust)
      }"`,
    };
  }

  if (!Array.isArray(m.declaredEndpoints)) {
    return {
      ok: false,
      error: "Plugin manifest declaredEndpoints must be an array",
    };
  }
  for (const ep of m.declaredEndpoints) {
    if (typeof ep !== "string") {
      return {
        ok: false,
        error: "Plugin manifest declaredEndpoints entries must be strings",
      };
    }
  }

  return {
    ok: true,
    value: {
      name: m.name,
      version: m.version as string,
      description: m.description as string,
      classification: classResult.value,
      trust,
      declaredEndpoints: m.declaredEndpoints as string[],
    },
  };
}

/** Validate the full exports shape of a plugin module. */
export function validatePluginExports(
  exports: unknown,
  path: string,
): Result<PluginExports, string> {
  if (exports === null || typeof exports !== "object") {
    return { ok: false, error: `Plugin at ${path} did not export an object` };
  }
  const e = exports as Record<string, unknown>;

  const manifestResult = validatePluginManifest(e.manifest);
  if (!manifestResult.ok) {
    return { ok: false, error: `${path}: ${manifestResult.error}` };
  }

  if (!Array.isArray(e.toolDefinitions)) {
    return { ok: false, error: `${path}: toolDefinitions must be an array` };
  }
  for (const tool of e.toolDefinitions) {
    if (typeof tool !== "object" || tool === null) {
      return {
        ok: false,
        error: `${path}: each tool definition must be an object`,
      };
    }
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name.length === 0) {
      return { ok: false, error: `${path}: tool definition missing name` };
    }
    if (typeof t.description !== "string") {
      return {
        ok: false,
        error: `${path}: tool "${t.name}" missing description`,
      };
    }
    if (typeof t.parameters !== "object" || t.parameters === null) {
      return {
        ok: false,
        error: `${path}: tool "${t.name}" missing parameters object`,
      };
    }
  }

  if (typeof e.createExecutor !== "function") {
    return { ok: false, error: `${path}: createExecutor must be a function` };
  }

  if (e.systemPrompt !== undefined && typeof e.systemPrompt !== "string") {
    return {
      ok: false,
      error: `${path}: systemPrompt must be a string if provided`,
    };
  }

  return {
    ok: true,
    value: e as unknown as PluginExports,
  };
}

/** Dynamically import a plugin module and validate its exports. */
export async function importPluginModule(
  modPath: string,
): Promise<Result<PluginExports, string>> {
  try {
    // Append cache-busting query to force re-import on reload.
    // Deno caches dynamic imports by URL — without this, overwritten
    // files return the stale cached module.
    const cacheBust = `?t=${Date.now()}`;
    const mod = await import(`${modPath}${cacheBust}`);
    return validatePluginExports(mod, modPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Plugin import failed", {
      operation: "importPluginModule",
      modPath,
      err,
    });
    return { ok: false, error: `Plugin import failed at ${modPath}: ${msg}` };
  }
}

/**
 * Load all valid plugins from a directory.
 *
 * Scans for subdirectories with mod.ts, imports and validates each.
 * Returns all successfully loaded plugins; logs warnings for failures.
 */
export async function loadPluginsFromDirectory(
  dir: string,
): Promise<Result<LoadedPlugin[], string>> {
  const names = await scanPluginsDirectory(dir);
  if (names.length === 0) {
    return { ok: true, value: [] };
  }

  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];

  for (const name of names) {
    const modPath = `${dir}/${name}/mod.ts`;
    const result = await importPluginModule(modPath);
    if (!result.ok) {
      log.warn("Plugin load skipped", {
        operation: "loadPluginsFromDirectory",
        plugin: name,
        reason: result.error,
      });
      errors.push(result.error);
      continue;
    }
    if (result.value.manifest.name !== name) {
      const msg =
        `Plugin directory "${name}" does not match manifest name "${result.value.manifest.name}"`;
      log.warn("Plugin name mismatch", {
        operation: "loadPluginsFromDirectory",
        directory: name,
        manifestName: result.value.manifest.name,
      });
      errors.push(msg);
      continue;
    }
    plugins.push({ exports: result.value, sourcePath: modPath });
  }

  log.info("Plugins loaded from directory", {
    operation: "loadPluginsFromDirectory",
    dir,
    loaded: plugins.map((p) => p.exports.manifest.name),
    skipped: errors.length,
  });
  return { ok: true, value: plugins };
}
