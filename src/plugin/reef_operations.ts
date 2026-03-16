/**
 * Plugin Reef install and publish operations.
 *
 * Handles downloading plugin bundles from The Reef with integrity
 * verification, security scanning, and preparing plugins for publishing.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { ReefPluginCatalogEntry } from "./reef_catalog.ts";
import { scanPluginDirectory } from "./scanner.ts";
import { validatePluginManifest } from "./loader.ts";
import { computeHash, parseRegistryUrl } from "./reef_catalog.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-reef");

/** Install a plugin bundle from The Reef. */
export async function installPlugin(
  entry: ReefPluginCatalogEntry,
  targetDir: string,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<string, string>> {
  const modUrl = `${baseUrl}/plugins/${entry.name}/${entry.version}/mod.ts`;
  const urlCheck = parseRegistryUrl(modUrl, baseUrl);
  if (!urlCheck.ok) return urlCheck;

  let modContent: string;
  try {
    const response = await fetchFn(modUrl);
    if (!response.ok) {
      return {
        ok: false,
        error: `Plugin fetch failed: ${modUrl} returned ${response.status}`,
      };
    }
    modContent = await response.text();
  } catch (err) {
    return {
      ok: false,
      error: `Plugin fetch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Verify checksum
  const actualHash = await computeHash(modContent);
  if (actualHash !== entry.checksum) {
    log.warn("Plugin install checksum mismatch", {
      operation: "installPlugin",
      plugin: entry.name,
      expected: entry.checksum,
      actual: actualHash,
    });
    return { ok: false, error: `Checksum mismatch for plugin "${entry.name}"` };
  }

  // Write to target directory
  const pluginDir = `${targetDir}/${entry.name}`;
  try {
    await Deno.mkdir(pluginDir, { recursive: true });
    await Deno.writeTextFile(`${pluginDir}/mod.ts`, modContent);
  } catch (err) {
    return {
      ok: false,
      error: `Plugin write failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Security scan the installed plugin
  const scanResult = await scanPluginDirectory(pluginDir);
  if (!scanResult.ok) {
    // Remove the plugin if it fails scanning
    try {
      await Deno.remove(pluginDir, { recursive: true });
    } catch { /* cleanup best effort */ }
    log.warn("Plugin install rejected by security scanner", {
      operation: "installPlugin",
      plugin: entry.name,
      warnings: scanResult.warnings,
    });
    return {
      ok: false,
      error: `Plugin "${entry.name}" failed security scan: ${
        scanResult.warnings.join("; ")
      }`,
    };
  }

  // Record integrity hash
  const hashRecord = {
    pluginName: entry.name,
    contentHash: actualHash,
    recordedAt: new Date().toISOString(),
    source: "reef" as const,
    version: entry.version,
  };
  await Deno.writeTextFile(
    `${pluginDir}/.plugin-hash.json`,
    JSON.stringify(hashRecord, null, 2),
  );

  log.info("Plugin installed from The Reef", {
    operation: "installPlugin",
    plugin: entry.name,
    version: entry.version,
  });
  return { ok: true, value: `Installed ${entry.name}@${entry.version}` };
}

/** Validate and prepare a plugin for Reef publishing. */
export async function publishPlugin(
  pluginDir: string,
): Promise<Result<string, string>> {
  // Read and validate mod.ts
  let modContent: string;
  try {
    modContent = await Deno.readTextFile(`${pluginDir}/mod.ts`);
  } catch (err) {
    return {
      ok: false,
      error: `Plugin mod.ts not readable in ${pluginDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Raw dynamic import (not importPluginModule) because publishPlugin
  // validates manifest and exports individually with its own error messages,
  // whereas importPluginModule bundles validation into a single Result.
  let mod: Record<string, unknown>;
  try {
    mod = await import(`${pluginDir}/mod.ts`);
  } catch (err) {
    return {
      ok: false,
      error: `Plugin import failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // Validate manifest
  const manifestResult = validatePluginManifest(mod.manifest);
  if (!manifestResult.ok) {
    return { ok: false, error: manifestResult.error };
  }

  // Validate required exports
  if (!Array.isArray(mod.toolDefinitions)) {
    return { ok: false, error: "Plugin missing toolDefinitions export" };
  }
  if (typeof mod.createExecutor !== "function") {
    return { ok: false, error: "Plugin missing createExecutor export" };
  }

  // Security scan
  const scanResult = await scanPluginDirectory(pluginDir);
  if (!scanResult.ok) {
    return {
      ok: false,
      error: `Plugin failed security scan: ${scanResult.warnings.join("; ")}`,
    };
  }

  // Generate publish directory structure
  const manifest = manifestResult.value;
  const checksum = await computeHash(modContent);
  const tempDir = await Deno.makeTempDir({ prefix: "reef-plugin-publish-" });
  const publishDir = `${tempDir}/plugins/${manifest.name}/${manifest.version}`;
  await Deno.mkdir(publishDir, { recursive: true });
  await Deno.writeTextFile(`${publishDir}/mod.ts`, modContent);

  const metadata = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    classification: manifest.classification,
    trust: manifest.trust,
    declaredEndpoints: manifest.declaredEndpoints,
    checksum,
    publishedAt: new Date().toISOString(),
    author: "unknown", // Would be set by the publishing user
    tags: [],
  };
  await Deno.writeTextFile(
    `${publishDir}/metadata.json`,
    JSON.stringify(metadata, null, 2),
  );

  log.info("Plugin prepared for Reef publishing", {
    operation: "publishPlugin",
    plugin: manifest.name,
    version: manifest.version,
    outputDir: tempDir,
  });

  return { ok: true, value: tempDir };
}
