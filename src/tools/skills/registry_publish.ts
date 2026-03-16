/**
 * Reef skill publishing pipeline.
 *
 * Validates SKILL.md frontmatter, runs security scans, computes
 * checksums, and generates the directory structure for a Reef PR.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { parseClassification } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { createSkillScanner } from "./scanner.ts";
import { computeSkillHash } from "./integrity.ts";
import { parse as parseYaml } from "@std/yaml";
import { join } from "@std/path";
import type { ReefSkillMetadata } from "./registry_types.ts";
import { enforceSkillName, enforceSkillVersion } from "./registry_types.ts";

const log = createLogger("reef-registry");

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

/** Parsed frontmatter fields required for Reef publishing. */
interface ParsedPublishFrontmatter {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly tags: readonly string[];
  readonly category: string;
  readonly classificationCeiling: string;
  readonly requiresTools: readonly string[] | null;
  readonly networkDomains: readonly string[] | null;
}

/** Fields that must be present in SKILL.md frontmatter for publishing. */
const REQUIRED_PUBLISH_FIELDS = [
  "name",
  "version",
  "description",
  "author",
  "tags",
  "category",
  "classification_ceiling",
] as const;

/** Extract YAML frontmatter from SKILL.md content. */
function extractYamlFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)(?:\n---|\n\.\.\.)/);
  if (!match) return null;
  try {
    return parseYaml(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate that all required Reef fields are present in frontmatter. */
function validatePublishFrontmatter(
  raw: Record<string, unknown>,
): Result<ParsedPublishFrontmatter, string> {
  const missing = REQUIRED_PUBLISH_FIELDS.filter((f) => !raw[f]);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required frontmatter fields: ${missing.join(", ")}`,
    };
  }
  const nameCheck = enforceSkillName(String(raw.name));
  if (!nameCheck.ok) return nameCheck;
  const versionCheck = enforceSkillVersion(String(raw.version));
  if (!versionCheck.ok) return versionCheck;
  const classResult = parseClassification(
    String(raw.classification_ceiling),
  );
  if (!classResult.ok) {
    return {
      ok: false,
      error: `Invalid classification_ceiling: ${raw.classification_ceiling}`,
    };
  }
  const tags = Array.isArray(raw.tags) ? (raw.tags as string[]) : [];
  return {
    ok: true,
    value: {
      name: String(raw.name),
      version: String(raw.version),
      description: String(raw.description),
      author: String(raw.author),
      tags,
      category: String(raw.category),
      classificationCeiling: String(raw.classification_ceiling),
      requiresTools: Array.isArray(raw.requires_tools)
        ? (raw.requires_tools as string[])
        : null,
      networkDomains: Array.isArray(raw.network_domains)
        ? (raw.network_domains as string[])
        : null,
    },
  };
}

// ─── Metadata & directory ────────────────────────────────────────────────────

/** Build metadata from validated frontmatter and computed checksum. */
function buildSkillMetadata(
  frontmatter: ParsedPublishFrontmatter,
  checksum: string,
): ReefSkillMetadata {
  return {
    name: frontmatter.name,
    version: frontmatter.version,
    description: frontmatter.description,
    author: frontmatter.author,
    tags: frontmatter.tags,
    category: frontmatter.category,
    classificationCeiling: frontmatter.classificationCeiling,
    checksum,
    publishedAt: new Date().toISOString(),
    requiresTools: frontmatter.requiresTools,
    networkDomains: frontmatter.networkDomains,
  };
}

/** Create the publish directory structure in a temp directory. */
async function writePublishDirectory(
  metadata: ReefSkillMetadata,
  skillContent: string,
): Promise<Result<string, string>> {
  const tempDir = await Deno.makeTempDir({ prefix: "reef-publish-" });
  const skillDir = join(
    tempDir,
    "skills",
    metadata.name,
    metadata.version,
  );
  try {
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), skillContent);
    await Deno.writeTextFile(
      join(skillDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );
    return { ok: true, value: tempDir };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Publish directory creation failed: ${message}`,
    };
  }
}

// ─── Publish orchestration ───────────────────────────────────────────────────

/** Validate a local skill and generate the directory structure for a Reef PR. */
export async function publishSkillToRegistry(
  skillPath: string,
): Promise<Result<string, string>> {
  let content: string;
  try {
    content = await Deno.readTextFile(skillPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read SKILL.md: ${message}` };
  }

  const raw = extractYamlFrontmatter(content);
  if (!raw) {
    return {
      ok: false,
      error: "SKILL.md missing YAML frontmatter (must start with ---)",
    };
  }

  const frontmatterResult = validatePublishFrontmatter(raw);
  if (!frontmatterResult.ok) return frontmatterResult;

  const scanner = createSkillScanner();
  const scanResult = await scanner.scan(content);
  if (!scanResult.ok) {
    log.warn("Skill publish rejected by security scanner", {
      operation: "publishSkillToRegistry",
      skillPath,
      warnings: scanResult.warnings,
    });
    return {
      ok: false,
      error: `Skill failed security scan: ${scanResult.warnings.join("; ")}`,
    };
  }

  const checksum = await computeSkillHash(content);
  const metadata = buildSkillMetadata(frontmatterResult.value, checksum);
  return writePublishDirectory(metadata, content);
}

/** @deprecated Use publishSkillToRegistry instead */
export const executePublish = publishSkillToRegistry;
