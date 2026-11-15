/**
 * Agent self-authoring for skills.
 *
 * Enables agents to create new skills in their workspace directory,
 * with an approval workflow requiring owner confirmation before activation.
 *
 * @module
 */

import { join } from "@std/path";
import type {
  ClassificationLevel,
  Result,
} from "../../core/types/classification.ts";
import { CLASSIFICATION_ORDER } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { enforceSkillName } from "./registry_types.ts";

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

/** Skill author interface. */
export interface SkillAuthor {
  /** Create a new skill in the workspace. Returns PENDING_APPROVAL. */
  create(options: {
    readonly name: string;
    readonly description: string;
    readonly classificationCeiling: ClassificationLevel;
    readonly requiresTools?: readonly string[];
    readonly networkDomains?: readonly string[];
    readonly content: string;
  }): Promise<Result<AuthoredSkill, string>>;
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

/** Build SKILL.md content from frontmatter fields and body. */
function buildSkillMdContent(options: {
  readonly name: string;
  readonly description: string;
  readonly classificationCeiling: ClassificationLevel;
  readonly requiresTools: readonly string[];
  readonly networkDomains: readonly string[];
  readonly content: string;
}): string {
  const frontmatter = [
    "---",
    `name: ${options.name}`,
    `description: ${options.description}`,
    `classification_ceiling: ${options.classificationCeiling}`,
    `requires_tools: [${options.requiresTools.join(", ")}]`,
    `network_domains: [${options.networkDomains.join(", ")}]`,
    `status: PENDING_APPROVAL`,
    "---",
  ].join("\n");
  return `${frontmatter}\n${options.content}`;
}

/** Write the skill directory and SKILL.md file to disk. */
async function writeSkillToDisk(
  skillDir: string,
  skillMd: string,
): Promise<Result<void, string>> {
  try {
    await Deno.mkdir(skillDir, { recursive: true });
  } catch {
    return {
      ok: false,
      error: `Failed to create skill directory: ${skillDir}`,
    };
  }
  try {
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), skillMd);
  } catch {
    return { ok: false, error: `Failed to write SKILL.md` };
  }
  return { ok: true, value: undefined };
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
} {
  return {
    name: createOptions.name,
    description: createOptions.description,
    classificationCeiling: createOptions.classificationCeiling,
    requiresTools: createOptions.requiresTools ?? [],
    networkDomains: createOptions.networkDomains ?? [],
    content: createOptions.content,
  };
}

/** Execute the full skill creation workflow: validate, write, return result. */
async function executeSkillCreation(
  createOptions: Parameters<SkillAuthor["create"]>[0],
  authorOptions: SkillAuthorOptions,
): Promise<Result<AuthoredSkill, string>> {
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
  const skillMd = buildSkillMdContent(opts);
  const writeResult = await writeSkillToDisk(skillDir, skillMd);
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
    create: (createOptions) => executeSkillCreation(createOptions, options),
  };
}
