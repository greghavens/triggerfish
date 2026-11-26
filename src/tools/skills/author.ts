/**
 * Agent self-authoring for skills.
 *
 * Enables agents to create new skills in their workspace directory,
 * with an approval workflow requiring owner confirmation before activation.
 *
 * @module
 */

import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import { CLASSIFICATION_ORDER } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { enforceSkillName } from "./registry_types.ts";
import type { SkillReferenceDocument } from "./reference_documents.ts";

const log = createLogger("skills-author");

/** Skill authoring status. */
export type SkillApprovalStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";

/** Authored skill metadata. */
export interface AuthoredSkill {
  /** Skill name. */
  readonly name: string;
  /** Skill description. */
  readonly description: string;
  /** Classification ceiling for the skill. */
  readonly classificationCeiling: ClassificationLevel;
  /** Required tools. */
  readonly requiresTools: readonly string[];
  /** Network domains. */
  readonly networkDomains: readonly string[];
  /** Approval status. */
  readonly status: SkillApprovalStatus;
  /** Path where the skill was created. */
  readonly path: string;
}

/** Options for creating a skill author. */
export interface SkillAuthorOptions {
  /** Workspace skills directory. */
  readonly skillsDir: string;
  /** Maximum classification ceiling the user allows. */
  readonly userCeiling: ClassificationLevel;
}

export interface SkillCreateOptions {
  readonly name: string;
  readonly description: string;
  readonly classificationCeiling: ClassificationLevel;
  readonly requiresTools?: readonly string[];
  readonly networkDomains?: readonly string[];
  readonly content: string;
  readonly files?: readonly SkillReferenceDocument[];
}

/** Skill author interface. */
export interface SkillAuthor {
  /** Create a new skill in the workspace. Returns PENDING_APPROVAL. */
  create(
    options: SkillCreateOptions,
    beforePublish?: () => boolean,
  ): Promise<Result<AuthoredSkill, string>>;
}

/** Validate that a skill ceiling does not exceed the user's ceiling. */
function validateSkillCeiling(
  ceiling: ClassificationLevel,
  userCeiling: ClassificationLevel,
): Result<void, string> {
  if (CLASSIFICATION_ORDER[ceiling] > CLASSIFICATION_ORDER[userCeiling]) {
    return {
      ok: false,
      error:
        `Classification ceiling ${ceiling} exceeds user ceiling ${userCeiling}`,
    };
  }
  return { ok: true, value: undefined };
}

/** Serialize the same pending Markdown for review and publication. */
export function buildPendingSkillMarkdown(options: SkillCreateOptions): string {
  const frontmatter = stringifyYaml({
    name: options.name,
    description: options.description,
    classification_ceiling: options.classificationCeiling,
    requires_tools: options.requiresTools ?? [],
    network_domains: options.networkDomains ?? [],
    ...(options.files?.length && { files: options.files }),
    status: "PENDING_APPROVAL",
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${options.content}`;
}

/** Publish a new SKILL.md without replacing any existing files or directories. */
function writeSkillToDisk(
  skillsDir: string,
  skillDir: string,
  skillMd: string,
  beforePublish?: () => boolean,
): Result<void, string> {
  try {
    Deno.mkdirSync(skillsDir, { recursive: true });
    if (!Deno.lstatSync(skillsDir).isDirectory) {
      return { ok: false, error: "Skill directory is unavailable." };
    }
    Deno.mkdirSync(skillDir);
  } catch {
    return {
      ok: false,
      error: "The skill directory already exists or could not be created.",
    };
  }
  let published = false;
  let staged: string | undefined;
  try {
    if (beforePublish && !beforePublish()) {
      return {
        ok: false,
        error: "The proposed skill or authorization changed before creation.",
      };
    }
    staged = Deno.makeTempFileSync({ dir: skillDir, prefix: ".skill-create-" });
    Deno.writeTextFileSync(staged, skillMd);
    Deno.linkSync(staged, join(skillDir, "SKILL.md"));
    published = true;
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Failed to publish the skill draft." };
  } finally {
    if (staged) {
      try {
        Deno.removeSync(staged);
      } catch {
        // Preserve the publication result if temporary-file cleanup fails.
      }
    }
    if (!published) {
      try {
        Deno.removeSync(skillDir);
      } catch {
        // An unrelated writer's files must never be removed.
      }
    }
  }
}

/** Build the AuthoredSkill result from validated create options. */
function buildAuthoredSkillResult(
  opts: {
    readonly name: string;
    readonly description: string;
    readonly classificationCeiling: ClassificationLevel;
    readonly requiresTools: readonly string[];
    readonly networkDomains: readonly string[];
  },
  skillDir: string,
): Result<AuthoredSkill, string> {
  return {
    ok: true,
    value: {
      name: opts.name,
      description: opts.description,
      classificationCeiling: opts.classificationCeiling,
      requiresTools: opts.requiresTools,
      networkDomains: opts.networkDomains,
      status: "PENDING_APPROVAL",
      path: skillDir,
    },
  };
}

/** Normalize create options, filling in defaults. */
function normalizeSkillCreateOptions(
  createOptions: Parameters<SkillAuthor["create"]>[0],
): {
  readonly name: string;
  readonly description: string;
  readonly classificationCeiling: ClassificationLevel;
  readonly requiresTools: readonly string[];
  readonly networkDomains: readonly string[];
  readonly content: string;
  readonly files?: readonly SkillReferenceDocument[];
} {
  return {
    name: createOptions.name,
    description: createOptions.description,
    classificationCeiling: createOptions.classificationCeiling,
    requiresTools: createOptions.requiresTools ?? [],
    networkDomains: createOptions.networkDomains ?? [],
    content: createOptions.content,
    files: createOptions.files,
  };
}

/** Execute the full skill creation workflow: validate, write, return result. */
function executeSkillCreation(
  createOptions: SkillCreateOptions,
  authorOptions: SkillAuthorOptions,
  beforePublish?: () => boolean,
): Result<AuthoredSkill, string> {
  // Guard the name before it is ever joined into a filesystem path.
  const nameCheck = enforceSkillName(createOptions.name);
  if (!nameCheck.ok) {
    log.warn("Skill creation rejected: invalid skill name", {
      operation: "executeSkillCreation",
      name: createOptions.name,
      reason: nameCheck.error,
    });
    return nameCheck;
  }
  const opts = normalizeSkillCreateOptions(createOptions);

  const ceilingCheck = validateSkillCeiling(
    opts.classificationCeiling,
    authorOptions.userCeiling,
  );
  if (!ceilingCheck.ok) return ceilingCheck;

  const skillDir = join(authorOptions.skillsDir, opts.name);
  const skillMd = buildPendingSkillMarkdown(opts);
  const writeResult = writeSkillToDisk(
    authorOptions.skillsDir,
    skillDir,
    skillMd,
    beforePublish,
  );
  if (!writeResult.ok) return writeResult;

  return buildAuthoredSkillResult(opts, skillDir);
}

/**
 * Create a skill author for agent self-authoring.
 *
 * Authored skills are placed in the workspace skills directory
 * and start in PENDING_APPROVAL status. The classification ceiling
 * cannot exceed the user's configured ceiling.
 */
export function createSkillAuthor(options: SkillAuthorOptions): SkillAuthor {
  return {
    create: (createOptions, beforePublish) =>
      Promise.resolve(
        executeSkillCreation(createOptions, options, beforePublish),
      ),
  };
}
