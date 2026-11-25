/**
 * Skill discovery and loading.
 *
 * Discovers skills from multiple directories (bundled, managed, workspace),
 * parses SKILL.md frontmatter, and applies priority rules for conflict resolution.
 *
 * @module
 */

import { join } from "@std/path";
import {
  isRealPathWithinJail,
  resolveWithinJail,
} from "../../core/security/path_jail.ts";
import { sanitizePathForPrompt } from "../../core/security/path_sanitization.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { parse as parseYaml } from "@std/yaml";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { parseClassification } from "../../core/types/classification.ts";
import type { SkillSource } from "../../core/types/skills.ts";
import { computeSkillHash } from "./integrity.ts";
import { enforceSkillName } from "./registry_types.ts";
import type {
  SkillDraftApprovals,
  SkillDraftReceipt,
} from "./draft_approvals.ts";

const log = createLogger("skills");

// Re-export SkillSource from core so existing importers via this module continue to work.
export type { SkillSource } from "../../core/types/skills.ts";

/** Parsed skill definition from SKILL.md frontmatter. */
export interface Skill {
  /** Skill name from frontmatter. */
  readonly name: string;
  /** Skill version (semver, defaults to "0.0.0" if not specified). */
  readonly version: string;
  /** Skill description. */
  readonly description: string;
  /** Maximum classification level this skill can access. */
  readonly classificationCeiling: ClassificationLevel;
  /**
   * Tools required by this skill.
   * null = not declared (unrestricted). [] = declared empty (no tool access).
   */
  readonly requiresTools: readonly string[] | null;
  /**
   * Network domains this skill needs access to.
   * null = not declared (unrestricted). [] = declared empty (no network access).
   */
  readonly networkDomains: readonly string[] | null;
  /** Filesystem path to the skill directory. */
  readonly path: string;
  /** Source type (bundled, managed, workspace). */
  readonly source: SkillSource;
  /** SHA-256 hex digest of SKILL.md content computed at discovery time. */
  readonly contentHash: string;
  /** Durable owner receipt for an entry authored as a pending draft. */
  readonly draftApproval?: SkillDraftReceipt;
}

export interface SkillDraft {
  readonly skill: Skill;
  readonly content: string;
}

/** Options for creating a skill loader. */
export interface SkillLoaderOptions {
  /** Directories to scan for skills. */
  readonly directories: readonly string[];
  /** Priority order for conflict resolution (first = highest priority). */
  readonly priority?: readonly SkillSource[];
  /** Map of directory path to source type. */
  readonly dirTypes?: Readonly<Record<string, SkillSource>>;
  readonly draftApprovals?: {
    readonly workspace: string;
    readonly registry: SkillDraftApprovals;
  };
}

/** Skill loader interface for discovering and loading skills. */
export interface SkillLoader {
  /** Discover all skills from configured directories. */
  discover(): Promise<readonly Skill[]>;
  readonly inspectDraft?: (name: string) => Promise<SkillDraft | undefined>;
  readonly approveDraft?: (
    name: string,
    digest: string,
    ownerSessionId: string,
    isCurrentOwner: () => boolean,
  ) => Promise<SkillDraftReceipt | undefined>;
}

/** Raw frontmatter shape parsed from SKILL.md. */
interface SkillFrontmatter {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly classification_ceiling?: string;
  readonly requires_tools?: readonly string[];
  readonly network_domains?: readonly string[];
  readonly status?: string;
}

/**
 * Parse SKILL.md content into frontmatter and body.
 *
 * Expects YAML frontmatter delimited by `---` at the top of the file.
 */
function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)(?:\n---|\n\.\.\.)/);
  if (!match) return null;
  try {
    return parseYaml(match[1]) as SkillFrontmatter;
  } catch (err) {
    log.debug("SKILL.md frontmatter YAML parse failed", { err });
    return null;
  }
}

/** Determine source type for a directory from the type map. */
function resolveSkillSourceType(
  dir: string,
  dirTypes: Readonly<Record<string, SkillSource>>,
): SkillSource {
  return dirTypes[dir] ?? "bundled";
}

/** Compute priority index (lower = higher priority). */
function computeSkillPriority(
  source: SkillSource,
  priority: readonly SkillSource[],
): number {
  const idx = priority.indexOf(source);
  return idx >= 0 ? idx : priority.length;
}

/** Build a Skill from parsed frontmatter. Returns null if frontmatter is invalid. */
function buildSkillFromFrontmatter(
  frontmatter: SkillFrontmatter | null,
  skillDir: string,
  source: SkillSource,
  contentHash: string,
): Skill | null {
  if (
    !frontmatter || typeof frontmatter.name !== "string" || !frontmatter.name
  ) return null;

  const classResult = parseClassification(
    frontmatter.classification_ceiling ?? "PUBLIC",
  );
  const ceiling: ClassificationLevel = classResult.ok
    ? classResult.value
    : "PUBLIC";

  return {
    name: frontmatter.name,
    version: frontmatter.version ?? "0.0.0",
    description: frontmatter.description ?? "",
    classificationCeiling: ceiling,
    requiresTools: frontmatter.requires_tools ?? null,
    networkDomains: frontmatter.network_domains ?? null,
    path: skillDir,
    source,
    contentHash,
  };
}

function optionalTextArray(value: unknown): boolean {
  return value === undefined ||
    Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function readExactDraft(
  workspace: string,
  name: string,
  registry: SkillDraftApprovals,
): Promise<SkillDraft | undefined> {
  if (name.length > 128 || !enforceSkillName(name).ok) return undefined;
  const path = join(workspace, name);
  const markdown = join(path, "SKILL.md");
  try {
    const root = await Deno.lstat(path);
    const file = await Deno.lstat(markdown);
    if (
      !root.isDirectory || !file.isFile || file.size > 32_768 ||
      !isRealPathWithinJail(markdown, workspace)
    ) return undefined;
    const content = await Deno.readTextFile(markdown);
    if (new TextEncoder().encode(content).length > 32_768) return undefined;
    const frontmatter = parseFrontmatter(content);
    if (
      frontmatter?.status !== "PENDING_APPROVAL" || frontmatter.name !== name ||
      !parseClassification(frontmatter.classification_ceiling ?? "PUBLIC").ok ||
      !optionalTextArray(frontmatter.requires_tools) ||
      !optionalTextArray(frontmatter.network_domains)
    ) return undefined;
    const digest = await computeSkillHash(content);
    const skill = buildSkillFromFrontmatter(
      frontmatter,
      path,
      "workspace",
      digest,
    );
    if (!skill) return undefined;
    const draftApproval = registry.list(workspace).get(name)?.get(digest);
    return {
      skill: draftApproval ? { ...skill, draftApproval } : skill,
      content,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** Scan a single directory for skills and merge into the map by priority. */
async function scanSkillDirectory(
  dir: string,
  source: SkillSource,
  priority: readonly SkillSource[],
  skillsByName: Map<string, Skill>,
  registry?: SkillDraftApprovals,
): Promise<void> {
  try {
    const approvals = registry?.list(dir);
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      const sanitizedName = sanitizePathForPrompt(entry.name);
      if (sanitizedName.length === 0) {
        log.warn("Skill directory name rejected: empty after sanitization", {
          dir,
          originalName: entry.name,
          source,
        });
        continue;
      }
      const jailResult = resolveWithinJail(dir, sanitizedName);
      if (!jailResult.ok) continue;
      const skillDir = jailResult.value;
      let content: string;
      try {
        content = await Deno.readTextFile(join(skillDir, "SKILL.md"));
      } catch (err) {
        log.debug("Skill SKILL.md read failed, skipping directory", {
          skillDir,
          err,
        });
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter || frontmatter.status === "REJECTED") continue;
      const contentHash = await computeSkillHash(content);
      const receipts = approvals?.get(sanitizedName);
      let draftApproval: SkillDraftReceipt | undefined;
      if (frontmatter.status === "PENDING_APPROVAL" || receipts) {
        draftApproval = receipts?.get(contentHash);
        if (
          !draftApproval || entry.name !== sanitizedName ||
          frontmatter.name !== sanitizedName ||
          frontmatter.status !== "PENDING_APPROVAL" ||
          !(await Deno.lstat(join(skillDir, "SKILL.md"))).isFile ||
          !isRealPathWithinJail(join(skillDir, "SKILL.md"), dir)
        ) continue;
      }
      const candidate = buildSkillFromFrontmatter(
        frontmatter,
        skillDir,
        source,
        contentHash,
      );
      if (!candidate) continue;
      const skill = draftApproval ? { ...candidate, draftApproval } : candidate;
      const existing = skillsByName.get(skill.name);
      const shouldReplace = !existing ||
        computeSkillPriority(source, priority) <
          computeSkillPriority(existing.source, priority);
      if (shouldReplace) skillsByName.set(skill.name, skill);
    }
  } catch (err) {
    log.debug("Skill directory not readable, skipping", { dir, source, err });
  }
}

/**
 * Create a skill loader that discovers skills from configured directories.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter.
 * When multiple directories contain a skill with the same name, the priority
 * order determines which one wins (default: workspace > managed > bundled).
 */
export function createSkillLoader(options: SkillLoaderOptions): SkillLoader {
  const priority = options.priority ?? ["workspace", "managed", "bundled"];
  const dirTypes = options.dirTypes ?? {};
  const approvals = options.draftApprovals;
  if (
    approvals &&
    (!options.directories.includes(approvals.workspace) ||
      resolveSkillSourceType(approvals.workspace, dirTypes) !== "workspace")
  ) {
    throw new Error(
      "Skill approvals require a configured workspace skills path.",
    );
  }

  return {
    ...(approvals && {
      inspectDraft: (name: string) =>
        readExactDraft(approvals.workspace, name, approvals.registry),
      async approveDraft(
        name: string,
        digest: string,
        ownerSessionId: string,
        isCurrentOwner: () => boolean,
      ) {
        const draft = await readExactDraft(
          approvals.workspace,
          name,
          approvals.registry,
        );
        if (!draft || draft.skill.contentHash !== digest || !isCurrentOwner()) {
          return undefined;
        }
        return approvals.registry.record(
          approvals.workspace,
          name,
          digest,
          ownerSessionId,
        );
      },
    }),
    async discover(): Promise<readonly Skill[]> {
      const skillsByName = new Map<string, Skill>();
      for (const dir of options.directories) {
        const source = resolveSkillSourceType(dir, dirTypes);
        await scanSkillDirectory(
          dir,
          source,
          priority,
          skillsByName,
          approvals?.workspace === dir ? approvals.registry : undefined,
        );
      }
      return [...skillsByName.values()];
    },
  };
}
