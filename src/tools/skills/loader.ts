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
const frontmatterPattern = /^---\n([\s\S]*?)(?:\n---|\n\.\.\.)(?=\n|$)/;
const maxDraftBytes = 32_768;

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
  readonly approvals: ReadonlyMap<string, SkillDraftReceipt> | undefined;
}

export interface SkillDraftRevision {
  readonly skill: Skill;
  readonly sourceApproval: SkillDraftReceipt;
  readonly sourceContent: string;
  readonly replacementBody: string;
  readonly content: string;
  readonly digest: string;
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
  readonly inspectRevision?: (
    name: string,
  ) => Promise<SkillDraftRevision | undefined>;
  readonly stageRevision?: (
    name: string,
    sourceDigest: string,
    revisionDigest: string,
    isCurrentOwner: () => boolean,
  ) => Promise<SkillDraftRevision | undefined>;
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
  const match = frontmatterPattern.exec(content);
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

/** Read one regular file from an exact skill directory and enforce its size bound. */
function readWorkspaceSkillText(
  workspace: string,
  path: string,
  filename: "SKILL.md" | "SKILL.revision.md",
): string | undefined {
  const markdown = join(path, filename);
  try {
    const root = Deno.lstatSync(path);
    const file = Deno.lstatSync(markdown);
    if (
      !root.isDirectory || !file.isFile || file.size > maxDraftBytes ||
      !isRealPathWithinJail(markdown, workspace)
    ) return undefined;
    const content = Deno.readTextFileSync(markdown);
    return new TextEncoder().encode(content).length <= maxDraftBytes
      ? content
      : undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function readExactDraft(
  workspace: string,
  name: string,
  registry: SkillDraftApprovals,
): Promise<SkillDraft | undefined> {
  if (name.length > 128 || !enforceSkillName(name).ok) return undefined;
  const path = join(workspace, name);
  const content = readWorkspaceSkillText(workspace, path, "SKILL.md");
  if (content === undefined) return undefined;
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
  const approvals = registry.list(workspace).get(name);
  const draftApproval = approvals?.get(digest);
  return {
    skill: draftApproval ? { ...skill, draftApproval } : skill,
    content,
    approvals,
  };
}

async function readExactRevision(
  workspace: string,
  name: string,
  registry: SkillDraftApprovals,
): Promise<SkillDraftRevision | undefined> {
  const draft = await readExactDraft(workspace, name, registry);
  if (!draft?.skill.draftApproval) return undefined;
  const replacementBody = readWorkspaceSkillText(
    workspace,
    draft.skill.path,
    "SKILL.revision.md",
  );
  if (!replacementBody?.trim()) return undefined;
  const frontmatter = frontmatterPattern.exec(draft.content)?.[0];
  if (!frontmatter) return undefined;
  const content = frontmatter + "\n" + replacementBody;
  if (new TextEncoder().encode(content).length > maxDraftBytes) {
    return undefined;
  }
  const digest = await computeSkillHash(content);
  if (draft.approvals?.has(digest)) return undefined;
  return {
    skill: draft.skill,
    sourceApproval: draft.skill.draftApproval,
    sourceContent: draft.content,
    replacementBody,
    content,
    digest,
  };
}

function replaceDraftIfCurrent(
  workspace: string,
  revision: SkillDraftRevision,
  registry: SkillDraftApprovals,
  isCurrentOwner: () => boolean,
): boolean {
  const path = revision.skill.path;
  const current = () => {
    if (!isCurrentOwner()) return false;
    const approvals = registry.list(workspace).get(revision.skill.name);
    return approvals?.get(revision.skill.contentHash)?.receiptId ===
        revision.sourceApproval.receiptId &&
      !approvals.has(revision.digest) &&
      readWorkspaceSkillText(workspace, path, "SKILL.md") ===
        revision.sourceContent &&
      readWorkspaceSkillText(workspace, path, "SKILL.revision.md") ===
        revision.replacementBody;
  };
  if (!current()) return false;
  const target = join(path, "SKILL.md");
  const mode = Deno.lstatSync(target).mode;
  const staged = Deno.makeTempFileSync({ dir: path, prefix: ".skill-draft-" });
  try {
    Deno.writeTextFileSync(staged, revision.content);
    if (mode !== null) Deno.chmodSync(staged, mode & 0o777);
    if (!current()) return false;
    Deno.renameSync(staged, target);
    return true;
  } finally {
    try {
      Deno.removeSync(staged);
    } catch {
      // Preserve the staging outcome if temporary-file cleanup fails.
    }
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
      inspectRevision: (name: string) =>
        readExactRevision(approvals.workspace, name, approvals.registry),
      async stageRevision(
        name: string,
        sourceDigest: string,
        revisionDigest: string,
        isCurrentOwner: () => boolean,
      ) {
        const revision = await readExactRevision(
          approvals.workspace,
          name,
          approvals.registry,
        );
        return revision?.skill.contentHash === sourceDigest &&
            revision.digest === revisionDigest &&
            replaceDraftIfCurrent(
              approvals.workspace,
              revision,
              approvals.registry,
              isCurrentOwner,
            )
          ? revision
          : undefined;
      },
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
