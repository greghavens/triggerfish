/**
 * Reef skill installation pipeline.
 *
 * Fetches skill content from the registry, verifies checksums,
 * runs security scans, and writes installed skills to disk.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { createSkillScanner } from "./scanner.ts";
import { computeSkillHash, recordSkillHash } from "./integrity.ts";
import { join } from "@std/path";
import { enforceRegistryUrl } from "./registry_catalog.ts";
import { fetchCatalog, findLatestSkillEntry } from "./registry_catalog.ts";
import type { CatalogCache, ReefCatalogEntry } from "./registry_types.ts";
import { enforceSkillName, enforceSkillVersion } from "./registry_types.ts";

const log = createLogger("reef-registry");

// ─── Fetch & verify ──────────────────────────────────────────────────────────

/** Fetch a skill's SKILL.md content from the registry. */
async function fetchSkillContent(options: {
  readonly baseUrl: string;
  readonly name: string;
  readonly version: string;
  readonly fetchFn: typeof fetch;
}): Promise<Result<string, string>> {
  const nameCheck = enforceSkillName(options.name);
  if (!nameCheck.ok) return nameCheck;
  const versionCheck = enforceSkillVersion(options.version);
  if (!versionCheck.ok) return versionCheck;

  const url =
    `${options.baseUrl}/skills/${options.name}/${options.version}/SKILL.md`;
  const urlCheck = enforceRegistryUrl(url, options.baseUrl);
  if (!urlCheck.ok) return urlCheck;

  try {
    const response = await options.fetchFn(url);
    if (!response.ok) {
      return {
        ok: false,
        error: `Skill fetch failed: ${url} returned ${response.status}`,
      };
    }
    return { ok: true, value: await response.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Skill fetch failed: ${message}` };
  }
}

/** Verify SHA-256 checksum of downloaded content against expected value. */
async function verifyDownloadChecksum(
  content: string,
  expectedChecksum: string,
): Promise<Result<void, string>> {
  const actual = await computeSkillHash(content);
  if (actual !== expectedChecksum) {
    return {
      ok: false,
      error: `Checksum mismatch: expected ${expectedChecksum}, got ${actual}`,
    };
  }
  return { ok: true, value: undefined };
}

// ─── Write & scan ────────────────────────────────────────────────────────────

/** Write a downloaded skill's SKILL.md to the target directory. */
async function writeInstalledSkill(
  targetDir: string,
  name: string,
  content: string,
): Promise<Result<void, string>> {
  const nameCheck = enforceSkillName(name);
  if (!nameCheck.ok) return nameCheck;

  const skillDir = join(targetDir, name);
  try {
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), content);
    return { ok: true, value: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Skill write failed: ${message}` };
  }
}

/** Scan content with the security scanner and write to disk if clean. */
async function scanAndWriteSkill(options: {
  readonly content: string;
  readonly entry: ReefCatalogEntry;
  readonly targetDir: string;
}): Promise<Result<string, string>> {
  const scanner = createSkillScanner();
  const scanResult = await scanner.scan(options.content);
  if (!scanResult.ok) {
    log.warn("Skill install rejected by scanner", {
      operation: "installSkill",
      skillName: options.entry.name,
      warnings: scanResult.warnings,
    });
    return {
      ok: false,
      error: `Skill "${options.entry.name}" failed security scan: ${
        scanResult.warnings.join("; ")
      }`,
    };
  }

  const writeResult = await writeInstalledSkill(
    options.targetDir,
    options.entry.name,
    options.content,
  );
  if (!writeResult.ok) return writeResult;

  const contentHash = await computeSkillHash(options.content);
  await recordSkillHash(
    join(options.targetDir, options.entry.name),
    options.entry.name,
    contentHash,
    "reef",
  );

  log.debug("Skill installed from The Reef", {
    operation: "installSkill",
    skillName: options.entry.name,
    version: options.entry.version,
  });

  return {
    ok: true,
    value: `Installed ${options.entry.name}@${options.entry.version}`,
  };
}

// ─── Install orchestration ───────────────────────────────────────────────────

/** Fetch, verify, scan, and install a skill from a catalog entry. */
async function installSkillFromEntry(options: {
  readonly entry: ReefCatalogEntry;
  readonly targetDir: string;
  readonly baseUrl: string;
  readonly fetchFn: typeof fetch;
}): Promise<Result<string, string>> {
  const contentResult = await fetchSkillContent({
    baseUrl: options.baseUrl,
    name: options.entry.name,
    version: options.entry.version,
    fetchFn: options.fetchFn,
  });
  if (!contentResult.ok) return contentResult;

  const checksumResult = await verifyDownloadChecksum(
    contentResult.value,
    options.entry.checksum,
  );
  if (!checksumResult.ok) {
    log.warn("Skill install checksum verification failed", {
      operation: "installSkill",
      skillName: options.entry.name,
      err: checksumResult.error,
    });
    return checksumResult;
  }

  return scanAndWriteSkill({
    content: contentResult.value,
    entry: options.entry,
    targetDir: options.targetDir,
  });
}

/** Look up a skill in the catalog and install it. */
export async function installSkillFromRegistry(options: {
  readonly name: string;
  readonly targetDir: string;
  readonly baseUrl: string;
  readonly cache: CatalogCache;
  readonly cacheTtlMs: number;
  readonly fetchFn: typeof fetch;
}): Promise<Result<string, string>> {
  const catalogResult = await fetchCatalog(options);
  if (!catalogResult.ok) return catalogResult;

  const entry = findLatestSkillEntry(catalogResult.value, options.name);
  if (!entry) {
    return {
      ok: false,
      error: `Skill "${options.name}" not found in The Reef`,
    };
  }

  return installSkillFromEntry({
    entry,
    targetDir: options.targetDir,
    baseUrl: options.baseUrl,
    fetchFn: options.fetchFn,
  });
}

/** @deprecated Use installSkillFromRegistry instead */
export const executeInstall = installSkillFromRegistry;
