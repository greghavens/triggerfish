/**
 * Plugin Reef install and publish operations.
 *
 * Handles downloading plugin bundles from The Reef with integrity
 * verification, security scanning, and preparing plugins for publishing.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { PluginManifest } from "./types.ts";
import type { ReefPluginCatalogEntry } from "./reef_catalog.ts";
import { scanPluginDirectory } from "./scanner.ts";
import { importPluginModule } from "./loader.ts";
import { computeHash, parseRegistryUrl } from "./reef_catalog.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("plugin-reef");

function formatFetchError(err: unknown): string {
  return `Plugin fetch failed: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

async function fetchPluginContent(
  entry: ReefPluginCatalogEntry,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<string, string>> {
  const modUrl = `${baseUrl}/plugins/${entry.name}/${entry.version}/mod.ts`;
  const urlCheck = parseRegistryUrl(modUrl, baseUrl);
  if (!urlCheck.ok) return urlCheck;

  try {
    const response = await fetchFn(modUrl);
    if (!response.ok) {
      return {
        ok: false,
        error: `Plugin fetch failed: ${modUrl} returned ${response.status}`,
      };
    }
    return { ok: true, value: await response.text() };
  } catch (err) {
    return { ok: false, error: formatFetchError(err) };
  }
}

async function verifyPluginChecksum(
  content: string,
  entry: ReefPluginCatalogEntry,
): Promise<Result<string, string>> {
  const actualHash = await computeHash(content);
  if (actualHash !== entry.checksum) {
    log.warn("Plugin install checksum mismatch", {
      operation: "installPlugin",
      plugin: entry.name,
      expected: entry.checksum,
      actual: actualHash,
    });
    return { ok: false, error: `Checksum mismatch for plugin "${entry.name}"` };
  }
  return { ok: true, value: actualHash };
}

async function writePluginFiles(
  pluginDir: string,
  content: string,
  entry: ReefPluginCatalogEntry,
): Promise<Result<string, string>> {
  try {
    await Deno.mkdir(pluginDir, { recursive: true });
    await Deno.writeTextFile(`${pluginDir}/mod.ts`, content);
    return { ok: true, value: pluginDir };
  } catch (err) {
    return {
      ok: false,
      error: `Plugin write failed for "${entry.name}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function cleanupRejectedPlugin(pluginDir: string): Promise<void> {
  try {
    await Deno.remove(pluginDir, { recursive: true });
  } catch (err) {
    log.debug("Plugin cleanup failed after scan rejection", {
      operation: "installPlugin",
      pluginDir,
      err,
    });
  }
}

async function scanInstalledPlugin(
  pluginDir: string,
  entry: ReefPluginCatalogEntry,
): Promise<Result<string, string>> {
  const scanResult = await scanPluginDirectory(pluginDir);
  if (scanResult.ok) return { ok: true, value: pluginDir };

  await cleanupRejectedPlugin(pluginDir);
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

async function recordPluginIntegrity(
  pluginDir: string,
  entry: ReefPluginCatalogEntry,
  hash: string,
): Promise<void> {
  const hashRecord = {
    pluginName: entry.name,
    contentHash: hash,
    recordedAt: new Date().toISOString(),
    source: "reef" as const,
    version: entry.version,
  };
  await Deno.writeTextFile(
    `${pluginDir}/.plugin-hash.json`,
    JSON.stringify(hashRecord, null, 2),
  );
}

/** Install a plugin bundle from The Reef. */
export async function installPlugin(
  entry: ReefPluginCatalogEntry,
  targetDir: string,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<Result<string, string>> {
  const contentResult = await fetchPluginContent(entry, baseUrl, fetchFn);
  if (!contentResult.ok) return contentResult;
  const checksumResult = await verifyPluginChecksum(contentResult.value, entry);
  if (!checksumResult.ok) return checksumResult;

  const pluginDir = `${targetDir}/${entry.name}`;
  const writeResult = await writePluginFiles(
    pluginDir,
    contentResult.value,
    entry,
  );
  if (!writeResult.ok) return writeResult;
  const scanResult = await scanInstalledPlugin(pluginDir, entry);
  if (!scanResult.ok) return scanResult;

  await recordPluginIntegrity(pluginDir, entry, checksumResult.value);
  log.info("Plugin installed from The Reef", {
    operation: "installPlugin",
    plugin: entry.name,
    version: entry.version,
  });
  return { ok: true, value: `Installed ${entry.name}@${entry.version}` };
}

async function readPluginModule(
  pluginDir: string,
): Promise<Result<string, string>> {
  try {
    return { ok: true, value: await Deno.readTextFile(`${pluginDir}/mod.ts`) };
  } catch (err) {
    return {
      ok: false,
      error: `Plugin mod.ts not readable in ${pluginDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function scanPublishDirectory(
  pluginDir: string,
): Promise<Result<void, string>> {
  const scanResult = await scanPluginDirectory(pluginDir);
  if (!scanResult.ok) {
    return {
      ok: false,
      error: `Plugin failed security scan: ${scanResult.warnings.join("; ")}`,
    };
  }
  return { ok: true, value: undefined };
}

function buildPublishMetadata(
  manifest: PluginManifest,
  checksum: string,
): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    classification: manifest.classification,
    trust: manifest.trust,
    declaredEndpoints: manifest.declaredEndpoints,
    checksum,
    publishedAt: new Date().toISOString(),
    author: "unknown",
    tags: [],
  };
}

async function generatePublishArtifacts(
  manifest: PluginManifest,
  modContent: string,
): Promise<string> {
  const checksum = await computeHash(modContent);
  const tempDir = await Deno.makeTempDir({ prefix: "reef-plugin-publish-" });
  const publishDir = `${tempDir}/plugins/${manifest.name}/${manifest.version}`;
  await Deno.mkdir(publishDir, { recursive: true });
  await Deno.writeTextFile(`${publishDir}/mod.ts`, modContent);
  const metadata = buildPublishMetadata(manifest, checksum);
  await Deno.writeTextFile(
    `${publishDir}/metadata.json`,
    JSON.stringify(metadata, null, 2),
  );
  return tempDir;
}

/** Validate and prepare a plugin for Reef publishing. */
export async function publishPlugin(
  pluginDir: string,
): Promise<Result<string, string>> {
  const readResult = await readPluginModule(pluginDir);
  if (!readResult.ok) return readResult;

  const importResult = await importPluginModule(`${pluginDir}/mod.ts`);
  if (!importResult.ok) return importResult;

  const scanResult = await scanPublishDirectory(pluginDir);
  if (!scanResult.ok) return scanResult;

  const manifest = importResult.value.manifest;
  const tempDir = await generatePublishArtifacts(manifest, readResult.value);
  log.info("Plugin prepared for Reef publishing", {
    operation: "publishPlugin",
    plugin: manifest.name,
    version: manifest.version,
    outputDir: tempDir,
  });
  return { ok: true, value: tempDir };
}
