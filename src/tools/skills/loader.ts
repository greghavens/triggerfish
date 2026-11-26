/**
 * Skill discovery and loading.
 *
 * Discovers skills from multiple directories (bundled, managed, workspace),
 * parses SKILL.md frontmatter, and applies priority rules for conflict resolution.
 *
 * @module
 */

import { join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import {
  isRealPathWithinJail,
  resolveWithinJail,
} from "../../core/security/path_jail.ts";
import { sanitizePathForPrompt } from "../../core/security/path_sanitization.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { redactCredentialText } from "../../core/logger/redactor.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { parseClassification } from "../../core/types/classification.ts";
import type { SkillSource } from "../../core/types/skills.ts";
import { computeSkillHash } from "./integrity.ts";
import { enforceSkillName } from "./registry_types.ts";
import type {
  SkillCreationReceipt,
  SkillDraftApprovals,
  SkillDraftReceipt,
  SkillWithdrawalReceipt,
} from "./draft_approvals.ts";
import {
  buildPendingSkillMarkdown,
  createSkillAuthor,
  type SkillCreateOptions,
} from "./author.ts";
import { parseSkillReferences } from "./reference_documents.ts";

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
  readonly replacementBody?: string;
  readonly replacementDescription?: string;
  readonly content: string;
  readonly digest: string;
}

export interface SkillCreationProposal {
  readonly input: SkillCreateOptions;
  readonly source: string;
  readonly markdown: string;
  readonly proposalDigest: string;
  readonly draftDigest: string;
  readonly creation?: SkillCreationReceipt;
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
  readonly inspectCreation?: (
    name: string,
  ) => Promise<SkillCreationProposal | undefined>;
  readonly createDraft?: (
    name: string,
    proposalDigest: string,
    draftDigest: string,
    ownerSessionId: string,
    isCurrentOwner: () => boolean,
  ) => Promise<SkillCreationReceipt | undefined>;
  readonly inspectDraft?: (name: string) => Promise<SkillDraft | undefined>;
  readonly inspectRevision?: (
    name: string,
  ) => Promise<SkillDraftRevision | undefined>;
  readonly stageRevision?: (
    name: string,
    sourceDigest: string,
    revisionDigest: string,
    isCurrentOwner: () => boolean,
    sourceWithdrawalId?: string,
  ) => Promise<SkillDraftRevision | undefined>;
  readonly withdrawDraft?: (
    name: string,
    digest: string,
    approvalReceiptId: string,
    ownerSessionId: string,
    isCurrentOwner: () => boolean,
  ) => Promise<SkillWithdrawalReceipt | undefined>;
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
  readonly files?: unknown;
}

/** Read package documents separately from the instructions passed to an agent. */
export function splitSkillDocuments(content: string) {
  const header = frontmatterPattern.exec(content)?.[0];
  const meta = parseFrontmatter(content);
  if (!header || !meta || !Object.hasOwn(meta, "files")) {
    return { instructions: content, files: [] };
  }
  const { files, ...instructions } = meta;
  return {
    instructions: `---\n${stringifyYaml(instructions).trimEnd()}\n---${
      content.slice(header.length)
    }`,
    files: parseSkillReferences(files),
  };
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
  } catch {
    log.debug("Skill frontmatter YAML parse failed");
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
  filename: "SKILL.md" | "SKILL.revision.md" | "SKILL.revision.description",
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

function readProposalText(workspace: string, name: string): string | undefined {
  // The selector is a skill name. The caller cannot nominate a filesystem path.
  if (name.length > 128 || !enforceSkillName(name).ok) return;
  const proposals = join(workspace, ".proposals");
  const path = join(proposals, `${name}.md`);
  try {
    const file = Deno.lstatSync(path);
    if (
      !Deno.lstatSync(workspace).isDirectory ||
      !Deno.lstatSync(proposals).isDirectory || !file.isFile ||
      file.size > maxDraftBytes || !isRealPathWithinJail(path, workspace)
    ) return;
    const content = Deno.readTextFileSync(path);
    return new TextEncoder().encode(content).length <= maxDraftBytes
      ? content
      : undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function boundedSelectors(
  value: unknown,
  matches: (value: string) => boolean,
): value is readonly string[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= 32 &&
      value.every((item) => typeof item === "string" && matches(item));
}

function parseCreationOptions(
  name: string,
  source: string,
): SkillCreateOptions | undefined {
  const header = frontmatterPattern.exec(source)?.[0];
  const meta = parseFrontmatter(source);
  if (
    !header || !meta || typeof meta !== "object" || Array.isArray(meta) ||
    Object.keys(meta).some((key) =>
      ![
        "name",
        "description",
        "classification_ceiling",
        "requires_tools",
        "network_domains",
        "files",
      ].includes(key)
    ) ||
    meta.name !== name || typeof meta.description !== "string" ||
    !meta.description.trim() || meta.description.length > 512 ||
    typeof meta.classification_ceiling !== "string" ||
    !boundedSelectors(
      meta.requires_tools,
      (tool) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(tool),
    ) ||
    !boundedSelectors(
      meta.network_domains,
      (domain) =>
        domain.length <= 253 &&
        domain.split(".").every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
        ),
    )
  ) return;
  const ceiling = parseClassification(meta.classification_ceiling);
  const content = source.slice(header.length + 1);
  const files = meta.files === undefined
    ? undefined
    : parseSkillReferences(meta.files);
  if (!ceiling.ok || !content.trim() || (meta.files !== undefined && !files)) {
    return;
  }
  return {
    name,
    description: meta.description,
    classificationCeiling: ceiling.value,
    requiresTools: meta.requires_tools,
    networkDomains: meta.network_domains,
    content,
    files,
  };
}

function existingPath(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function inspectExactCreation(
  workspace: string,
  name: string,
  registry: SkillDraftApprovals,
): Promise<SkillCreationProposal | undefined> {
  const source = readProposalText(workspace, name);
  if (source === undefined) return;
  const input = parseCreationOptions(name, source);
  if (!input) return;
  const markdown = buildPendingSkillMarkdown(input);
  if (new TextEncoder().encode(markdown).length > maxDraftBytes) return;
  const [proposalDigest, draftDigest] = await Promise.all([
    computeSkillHash(source),
    computeSkillHash(markdown),
  ]);
  const receipt = registry.creation(workspace, name);
  if (
    receipt &&
    (receipt.proposalDigest !== proposalDigest ||
      receipt.draftDigest !== draftDigest)
  ) return;
  const directory = join(workspace, name);
  let creation: SkillCreationReceipt | undefined;
  if (existingPath(directory)) {
    if (
      !receipt ||
      readWorkspaceSkillText(workspace, directory, "SKILL.md") !== markdown
    ) return;
    creation = receipt;
  }
  return { input, source, markdown, proposalDigest, draftDigest, creation };
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
    skill: draftApproval && !draftApproval.withdrawal
      ? { ...skill, draftApproval }
      : skill,
    content,
    approvals,
  };
}

/** A fixed local text file may revise only the descriptive frontmatter. */
function withRevisedDescription(frontmatter: string, source: string) {
  const description = source.trim();
  if (
    !description || description.length > 512 ||
    /[\p{Cc}\p{Cf}]/u.test(description) ||
    redactCredentialText(description) !== description
  ) return;
  const before = parseFrontmatter(frontmatter);
  const selector = /^description:[^\n]*(?:\n[ \t][^\n]*)*/m;
  if (
    !before || typeof before.description !== "string" ||
    !selector.test(frontmatter)
  ) {
    return;
  }
  const replacement = stringifyYaml({ description }).trimEnd();
  const updated = frontmatter.replace(selector, () => replacement);
  return isDeepStrictEqual(parseFrontmatter(updated), {
      ...before,
      description,
    })
    ? updated
    : undefined;
}

async function readExactRevision(
  workspace: string,
  name: string,
  registry: SkillDraftApprovals,
): Promise<SkillDraftRevision | undefined> {
  const draft = await readExactDraft(workspace, name, registry);
  if (!draft) return;
  const sourceApproval = draft.approvals?.get(draft.skill.contentHash);
  if (!sourceApproval) return;
  const replacementBody = readWorkspaceSkillText(
    workspace,
    draft.skill.path,
    "SKILL.revision.md",
  );
  const replacementDescription = readWorkspaceSkillText(
    workspace,
    draft.skill.path,
    "SKILL.revision.description",
  );
  if (
    (replacementBody !== undefined && !replacementBody.trim()) ||
    (replacementBody === undefined &&
      existingPath(join(draft.skill.path, "SKILL.revision.md"))) ||
    (replacementDescription === undefined &&
      existingPath(join(draft.skill.path, "SKILL.revision.description"))) ||
    (replacementBody === undefined && replacementDescription === undefined)
  ) return;
  const frontmatter = frontmatterPattern.exec(draft.content)?.[0];
  if (!frontmatter) return;
  const revised = replacementDescription === undefined
    ? frontmatter
    : withRevisedDescription(frontmatter, replacementDescription);
  if (!revised) return;
  const content = revised + "\n" +
    (replacementBody ?? draft.content.slice(frontmatter.length + 1));
  if (content === draft.content) return;
  if (new TextEncoder().encode(content).length > maxDraftBytes) {
    return undefined;
  }
  const digest = await computeSkillHash(content);
  if (draft.approvals?.has(digest)) return undefined;
  return {
    skill: draft.skill,
    sourceApproval,
    sourceContent: draft.content,
    replacementBody,
    replacementDescription,
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
    const active = approvals?.get(revision.skill.contentHash);
    return active?.receiptId === revision.sourceApproval.receiptId &&
      active.withdrawal?.receiptId ===
        revision.sourceApproval.withdrawal?.receiptId &&
      !approvals?.has(revision.digest) &&
      readWorkspaceSkillText(workspace, path, "SKILL.md") ===
        revision.sourceContent &&
      (revision.replacementBody === undefined
        ? !existingPath(join(path, "SKILL.revision.md"))
        : readWorkspaceSkillText(workspace, path, "SKILL.revision.md") ===
          revision.replacementBody) &&
      (revision.replacementDescription === undefined
        ? !existingPath(join(path, "SKILL.revision.description"))
        : readWorkspaceSkillText(
          workspace,
          path,
          "SKILL.revision.description",
        ) ===
          revision.replacementDescription);
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
      if (
        !entry.isDirectory || entry.isSymlink ||
        (source === "workspace" && entry.name === ".proposals")
      ) continue;
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
          !draftApproval || draftApproval.withdrawal ||
          entry.name !== sanitizedName ||
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
      inspectCreation: (name: string) =>
        inspectExactCreation(approvals.workspace, name, approvals.registry),
      async createDraft(
        name: string,
        proposalDigest: string,
        draftDigest: string,
        ownerSessionId: string,
        isCurrentOwner: () => boolean,
      ) {
        const proposal = await inspectExactCreation(
          approvals.workspace,
          name,
          approvals.registry,
        );
        if (
          !proposal || proposal.proposalDigest !== proposalDigest ||
          proposal.draftDigest !== draftDigest || !isCurrentOwner()
        ) return undefined;
        if (proposal.creation) return proposal.creation;
        const author = createSkillAuthor({
          skillsDir: approvals.workspace,
          userCeiling: proposal.input.classificationCeiling,
        });
        let receipt: SkillCreationReceipt | undefined;
        const result = await author.create(proposal.input, () => {
          if (
            !isCurrentOwner() ||
            readProposalText(approvals.workspace, name) !== proposal.source
          ) return false;
          receipt = approvals.registry.reserveCreation(
            approvals.workspace,
            name,
            proposalDigest,
            draftDigest,
            ownerSessionId,
          );
          return receipt !== undefined;
        });
        return result.ok ? receipt : undefined;
      },
      inspectDraft: (name: string) =>
        readExactDraft(approvals.workspace, name, approvals.registry),
      inspectRevision: (name: string) =>
        readExactRevision(approvals.workspace, name, approvals.registry),
      async stageRevision(
        name: string,
        sourceDigest: string,
        revisionDigest: string,
        isCurrentOwner: () => boolean,
        sourceWithdrawalId?: string,
      ) {
        const revision = await readExactRevision(
          approvals.workspace,
          name,
          approvals.registry,
        );
        return revision?.skill.contentHash === sourceDigest &&
            revision.digest === revisionDigest &&
            revision.sourceApproval.withdrawal?.receiptId ===
              sourceWithdrawalId &&
            replaceDraftIfCurrent(
              approvals.workspace,
              revision,
              approvals.registry,
              isCurrentOwner,
            )
          ? revision
          : undefined;
      },
      async withdrawDraft(
        name: string,
        digest: string,
        approvalReceiptId: string,
        ownerSessionId: string,
        isCurrentOwner: () => boolean,
      ) {
        const workspace = approvals.workspace;
        const draft = await readExactDraft(workspace, name, approvals.registry);
        if (
          !draft || draft.skill.contentHash !== digest ||
          draft.approvals?.get(digest)?.receiptId !== approvalReceiptId ||
          !isCurrentOwner() ||
          readWorkspaceSkillText(workspace, draft.skill.path, "SKILL.md") !==
            draft.content
        ) return;
        return approvals.registry.withdraw(
          workspace,
          name,
          digest,
          approvalReceiptId,
          ownerSessionId,
        );
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
        if (
          !draft || draft.skill.contentHash !== digest ||
          draft.approvals?.get(digest)?.withdrawal || !isCurrentOwner()
        ) return;
        const approval = approvals.registry.record(
          approvals.workspace,
          name,
          digest,
          ownerSessionId,
        );
        return approval.withdrawal ? undefined : approval;
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
