/**
 * Skill tools — LLM-callable operations for reading skills.
 *
 * Provides the `read_skill` tool which reads SKILL.md content from
 * bundled or user-provided skills. Enforces security checks at
 * activation time:
 * 1. Classification ceiling — session taint must not exceed skill ceiling
 * 2. Content integrity — SHA-256 hash verified for non-bundled skills
 * 3. Scanner — content scanned for injection patterns
 * 4. Context tracking — active skill set for tool/domain enforcement
 *
 * @module
 */

import { join } from "@std/path";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../core/types/tool.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../core/types/classification.ts";
import type { SkillLoader, SkillSource } from "./loader.ts";
import { enforceSkillName } from "./registry_types.ts";
import type { SkillContextTracker } from "./context.ts";
import type { SkillScanner } from "./scanner.ts";
import { enforceSkillClassificationCeiling } from "./enforcer.ts";
import { computeSkillHash, verifySkillIntegrity } from "./integrity.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { fenceExternalMetadata } from "../../core/security/prompt_fencing.ts";

const log = createLogger("skill-tools");

/** Skill type argument accepted by read_skill. */
export type SkillType = "BUNDLED" | "USER_PROVIDED";

/** Context required by the skill tool executor. */
export interface SkillToolContext {
  /** Skill loader used to discover available skills. */
  readonly skillLoader: SkillLoader;
  /** If provided, the active skill is tracked for tool filtering and domain enforcement. */
  readonly skillContextTracker?: SkillContextTracker;
  /** If provided, classification ceiling is checked before activation. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** If provided, skill content is scanned at activation time. */
  readonly skillScanner?: SkillScanner;
  readonly getConfirmPrompt?: () => (prompt: string) => Promise<boolean>;
}

function buildReadSkillDef(): ToolDefinition {
  return {
    name: "read_skill",
    description:
      "Read the full content of a skill (SKILL.md) by type and name. " +
      "Use this to learn what a skill does, how to activate it, and what " +
      "tools it requires. Reading a skill never escalates the session " +
      "security level — use this instead of read_file when you need to " +
      "inspect skill instructions. " +
      "type must be BUNDLED (skills shipped with Triggerfish) or " +
      "USER_PROVIDED (skills installed or authored by the user).",
    parameters: {
      type: {
        type: "string",
        description: "Skill source type: BUNDLED or USER_PROVIDED",
        required: true,
        enum: ["BUNDLED", "USER_PROVIDED"],
      },
      skill_name: {
        type: "string",
        description:
          "Name of the skill to read (e.g. 'weather', 'deep-research')",
        required: true,
      },
    },
  };
}

/** Tool definitions for skill reading operations. */
export function buildSkillToolDefinitions(): readonly ToolDefinition[] {
  return [buildReadSkillDef()];
}

/** The owner can discover currently eligible skills without activating one. */
export function buildSkillAdministrationToolDefinitions(): readonly ToolDefinition[] {
  return [{
    name: "list_skills",
    description:
      "List active skills from the current owner skill registry. The result includes skill names and sources, with no instruction content. A skill can be opened with read_skill.",
    parameters: {
      type: {
        type: "string",
        description: "Optional source filter",
        enum: ["BUNDLED", "USER_PROVIDED"],
      },
      after: {
        type: "string",
        description: "Skill name returned as next_after on the preceding page",
      },
      limit: {
        type: "integer",
        description: "Maximum number of skills to return, from 1 to 100",
      },
    },
  }, {
    name: "inspect_skill_draft",
    description:
      "Inspect one pending workspace skill draft by exact name. The fenced content is for owner review only. Use its SHA-256 digest when requesting approval.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact pending draft name",
        required: true,
      },
    },
  }, {
    name: "approve_skill",
    description:
      "Request owner confirmation to approve one exact skill draft digest. Inspect the draft first so the owner can review it. Changing the draft requires a new approval.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact pending draft name",
        required: true,
      },
      digest: {
        type: "string",
        description: "SHA-256 digest returned by inspect_skill_draft",
        required: true,
      },
    },
  }, {
    name: "withdraw_skill",
    description:
      "Request owner confirmation to withdraw the active approval for one exact workspace-authored skill digest. The draft and approval history are retained.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact workspace-authored skill name",
        required: true,
      },
      digest: {
        type: "string",
        description: "Exact active digest returned by inspect_skill_draft",
        required: true,
      },
    },
  }, {
    name: "inspect_skill_revision",
    description:
      "Preview one exact workspace skill revision from a previously approved or withdrawn draft. SKILL.revision.md supplies an optional replacement body, and SKILL.revision.description supplies an optional one-line description, beside the approved SKILL.md. The preview preserves all other metadata and leaves the proposed text inactive.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact previously approved workspace skill name",
        required: true,
      },
    },
  }, {
    name: "stage_skill_revision",
    description:
      "Request owner confirmation to stage the reviewed body or description as a pending revision. Existing approval receipts are retained. The revision needs its own approval.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact previously approved workspace skill name",
        required: true,
      },
      source_digest: {
        type: "string",
        description:
          "Previously approved source digest returned by inspect_skill_revision",
        required: true,
      },
      source_withdrawal_id: {
        type: "string",
        description:
          "Exact source withdrawal receipt from the preview, required when the source was withdrawn.",
      },
      revision_digest: {
        type: "string",
        description: "Proposed digest returned by inspect_skill_revision",
        required: true,
      },
    },
  }, {
    name: "inspect_skill_creation",
    description:
      "Read metadata and digests for one named skill creation proposal. An owner prepares .proposals/<skill_name>.md inside the configured workspace skills directory, with name, description, classification_ceiling, optional requires_tools and network_domains, and a Markdown body. Review the proposal file before requesting creation.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact proposed skill name",
        required: true,
      },
    },
  }, {
    name: "create_skill",
    description:
      "Request owner confirmation to create an exact reviewed workspace proposal as a new pending skill. The draft needs its own approval before it can be activated.",
    parameters: {
      skill_name: {
        type: "string",
        description: "Exact proposed skill name",
        required: true,
      },
      proposal_digest: {
        type: "string",
        description: "Proposal SHA-256 returned by inspect_skill_creation",
        required: true,
      },
      draft_digest: {
        type: "string",
        description: "Pending draft SHA-256 returned by inspect_skill_creation",
        required: true,
      },
    },
  }];
}

function skillType(source: SkillSource): SkillType {
  return source === "bundled" ? "BUNDLED" : "USER_PROVIDED";
}

function validSkillSelector(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    enforceSkillName(value).ok;
}

async function executeListSkills(
  ctx: SkillToolContext,
  input: Record<string, unknown>,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const isCurrentOwner = dispatch?.isCurrentInteractiveOwner;
  if (!isCurrentOwner?.() || !ctx.getSessionTaint) {
    return "Error: Skill discovery requires the active owner session.";
  }
  const { type, after, limit = 25 } = input;
  if (
    Object.keys(input).some((key) =>
      !["type", "after", "limit"].includes(key)
    ) ||
    (type !== undefined && type !== "BUNDLED" && type !== "USER_PROVIDED") ||
    (after !== undefined && !validSkillSelector(after)) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > 100
  ) return "Error: Invalid skill listing filter or cursor.";

  const skills = await ctx.skillLoader.discover();
  if (!isCurrentOwner()) return "Error: The owner session is no longer active.";
  const taint = ctx.getSessionTaint();
  const candidates = skills.filter((skill) =>
    validSkillSelector(skill.name) &&
    (type === undefined || skillType(skill.source) === type) &&
    (after === undefined || skill.name > after) &&
    !enforceSkillClassificationCeiling(taint, skill)
  ).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const page = candidates.slice(0, limit);
  return JSON.stringify({
    skills: page.map((skill) => ({
      name: skill.name,
      type: skillType(skill.source),
      source: skill.source,
      classification_ceiling: skill.classificationCeiling,
      version:
        typeof skill.version === "string" && skill.version.length <= 80 &&
          /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)*$/.test(skill.version)
          ? skill.version
          : null,
    })),
    next_after: candidates.length > limit ? page.at(-1)?.name : null,
    _classification: taint,
  });
}

async function executeDraftAction(
  ctx: SkillToolContext,
  name: "inspect_skill_draft" | "approve_skill" | "withdraw_skill",
  input: Record<string, unknown>,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const owner = dispatch?.isCurrentInteractiveOwner;
  const currentTaint = ctx.getSessionTaint;
  const inspection = name === "inspect_skill_draft";
  if (
    !owner?.() || !currentTaint || !ctx.skillLoader.inspectDraft ||
    !ctx.skillScanner
  ) {
    return "Error: Draft administration requires the active owner session and a configured workspace.";
  }
  const { skill_name: skillName, digest } = input;
  if (
    !validSkillSelector(skillName) ||
    Object.keys(input).some((key) =>
      key !== "skill_name" && (inspection || key !== "digest")
    ) ||
    (!inspection &&
      (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))
  ) return "Error: Select an exact skill draft and its digest.";

  const draft = await ctx.skillLoader.inspectDraft(skillName);
  if (!draft || (!inspection && draft.skill.contentHash !== digest)) {
    return "Error: The selected skill draft or digest is unavailable.";
  }
  const applicable = () =>
    owner() &&
    !enforceSkillClassificationCeiling(currentTaint(), draft.skill);
  if (!applicable()) {
    return "Error: Draft administration is outside the active owner scope.";
  }
  const approval = draft.approvals?.get(draft.skill.contentHash);
  if (name === "withdraw_skill") {
    if (!approval || typeof digest !== "string") {
      return "Error: The selected skill approval is unavailable.";
    }
    const project = (withdrawal: NonNullable<typeof approval.withdrawal>) =>
      JSON.stringify({ withdrawal, _classification: currentTaint() });
    if (approval.withdrawal) return project(approval.withdrawal);
    if (
      !ctx.getConfirmPrompt || !ctx.skillLoader.withdrawDraft ||
      !dispatch?.reauthorizeOwnerApproval || !dispatch.ownerSessionId
    ) return "Error: The confirmation channel is unavailable.";
    const confirmed = await ctx.getConfirmPrompt()(
      `Withdraw workspace skill '${skillName}' with SHA-256 ${digest}?`,
    );
    if (!confirmed) return "The owner declined the skill withdrawal.";
    if (!applicable() || !await dispatch.reauthorizeOwnerApproval()) {
      return "Error: Owner authorization changed before skill withdrawal.";
    }
    const withdrawal = await ctx.skillLoader.withdrawDraft(
      skillName,
      digest,
      approval.receiptId,
      dispatch.ownerSessionId,
      applicable,
    );
    return withdrawal
      ? project(withdrawal)
      : "Error: The skill or its approval changed before withdrawal.";
  }
  if (!inspection && approval?.withdrawal) {
    return "Error: This exact skill draft approval was withdrawn.";
  }
  const scan = await ctx.skillScanner.scan(draft.content);
  if (!applicable()) {
    return "Error: Draft administration is outside the active owner scope.";
  }
  if (inspection) {
    return JSON.stringify({
      skill_name: skillName,
      digest: draft.skill.contentHash,
      classification_ceiling: draft.skill.classificationCeiling,
      reviewable: scan.ok,
      ...(scan.ok &&
        {
          content: fenceExternalMetadata(
            draft.content,
            "workspace-skill-draft",
          ),
        }),
      approval: draft.skill.draftApproval ?? null,
      ...(approval?.withdrawal && { withdrawal: approval.withdrawal }),
      approval_history: [...draft.approvals?.values() ?? []]
        .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))
        .slice(0, 20),
      _classification: currentTaint(),
    });
  }
  if (!scan.ok) {
    return "Error: The draft was blocked by the skill security scanner.";
  }
  if (
    !ctx.getConfirmPrompt || !ctx.skillLoader.approveDraft ||
    !dispatch?.reauthorizeOwnerApproval || !dispatch.ownerSessionId ||
    typeof digest !== "string"
  ) return "Error: The approval channel is unavailable.";
  if (draft.skill.draftApproval) {
    return JSON.stringify({
      approval: draft.skill.draftApproval,
      _classification: currentTaint(),
    });
  }
  const confirmed = await ctx.getConfirmPrompt()(
    `Approve workspace skill '${skillName}' with SHA-256 ${digest}? Review the exact draft before confirming.`,
  );
  if (!confirmed) return "The owner declined the skill draft approval.";
  if (!applicable() || !await dispatch.reauthorizeOwnerApproval()) {
    return "Error: Owner authorization changed before the skill approval.";
  }
  const receipt = await ctx.skillLoader.approveDraft(
    skillName,
    digest,
    dispatch.ownerSessionId,
    applicable,
  );
  return receipt
    ? JSON.stringify({ approval: receipt, _classification: currentTaint() })
    : "Error: The skill draft changed before approval.";
}

async function executeRevisionAction(
  ctx: SkillToolContext,
  name: "inspect_skill_revision" | "stage_skill_revision",
  input: Record<string, unknown>,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const owner = dispatch?.isCurrentInteractiveOwner;
  const currentTaint = ctx.getSessionTaint;
  const inspection = name === "inspect_skill_revision";
  if (
    !owner?.() || !currentTaint || !ctx.skillLoader.inspectRevision ||
    !ctx.skillScanner
  ) {
    return "Error: Skill revision requires the active owner session and a configured workspace.";
  }
  const {
    skill_name: skillName,
    source_digest: source,
    revision_digest: digest,
    source_withdrawal_id: withdrawal,
  } = input;
  if (
    !validSkillSelector(skillName) ||
    Object.keys(input).some((key) =>
      key !== "skill_name" &&
      (inspection ||
        (key !== "source_digest" && key !== "revision_digest" &&
          key !== "source_withdrawal_id"))
    ) ||
    (!inspection &&
      (typeof source !== "string" || !/^[a-f0-9]{64}$/.test(source) ||
        typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) ||
    (withdrawal !== undefined &&
      (typeof withdrawal !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(withdrawal)))
  ) return "Error: Select an exact skill and both reviewed digests.";
  const revision = await ctx.skillLoader.inspectRevision(skillName);
  if (
    !revision ||
    (!inspection &&
      (revision.skill.contentHash !== source || revision.digest !== digest ||
        revision.sourceApproval.withdrawal?.receiptId !== withdrawal))
  ) {
    return "Error: The approved source or proposed skill revision is unavailable.";
  }
  const applicable = () =>
    owner() &&
    !enforceSkillClassificationCeiling(currentTaint(), revision.skill);
  if (!applicable()) {
    return "Error: Skill revision is outside the active owner scope.";
  }
  const scan = await ctx.skillScanner.scan(revision.content);
  if (!applicable()) {
    return "Error: Skill revision is outside the active owner scope.";
  }
  if (inspection) {
    return JSON.stringify({
      skill_name: skillName,
      source_approval: revision.sourceApproval,
      source_digest: revision.skill.contentHash,
      ...(revision.sourceApproval.withdrawal && {
        source_withdrawal_id: revision.sourceApproval.withdrawal.receiptId,
      }),
      revision_digest: revision.digest,
      reviewable: scan.ok,
      ...(scan.ok &&
        {
          content: fenceExternalMetadata(
            revision.content,
            "workspace-skill-revision",
          ),
        }),
      _classification: currentTaint(),
    });
  }
  if (!scan.ok) {
    return "Error: The revision was blocked by the skill security scanner.";
  }
  if (
    !ctx.getConfirmPrompt || !ctx.skillLoader.stageRevision ||
    !dispatch?.reauthorizeOwnerApproval || typeof source !== "string" ||
    typeof digest !== "string"
  ) return "Error: The confirmation channel is unavailable.";
  const confirmed = await ctx.getConfirmPrompt()(
    `Stage a pending revision for workspace skill '${skillName}'? Approved SHA-256 ${source}. Proposed SHA-256 ${digest}.` +
      (typeof withdrawal === "string"
        ? ` Source withdrawal ${withdrawal}.`
        : ""),
  );
  if (!confirmed) return "The owner declined the skill revision.";
  if (!applicable() || !await dispatch.reauthorizeOwnerApproval()) {
    return "Error: Owner authorization changed before staging.";
  }
  const staged = await ctx.skillLoader.stageRevision(
    skillName,
    source,
    digest,
    applicable,
    typeof withdrawal === "string" ? withdrawal : undefined,
  );
  return staged
    ? JSON.stringify({
      skill_name: skillName,
      source_approval: staged.sourceApproval,
      revision_digest: staged.digest,
      status: "PENDING_APPROVAL",
      _classification: currentTaint(),
    })
    : "Error: The skill or proposed revision changed before staging.";
}

async function executeCreationAction(
  ctx: SkillToolContext,
  name: "inspect_skill_creation" | "create_skill",
  input: Record<string, unknown>,
  dispatch?: ToolExecutionContext,
): Promise<string> {
  const owner = dispatch?.isCurrentInteractiveOwner;
  const currentTaint = ctx.getSessionTaint;
  const inspection = name === "inspect_skill_creation";
  if (
    !owner?.() || !currentTaint || !ctx.skillLoader.inspectCreation ||
    !ctx.skillScanner
  ) {
    return "Error: Skill creation requires the active owner session and a configured workspace.";
  }
  const {
    skill_name: skillName,
    proposal_digest: source,
    draft_digest: digest,
  } = input;
  if (
    !validSkillSelector(skillName) ||
    Object.keys(input).some((key) =>
      key !== "skill_name" &&
      (inspection || (key !== "proposal_digest" && key !== "draft_digest"))
    ) ||
    (!inspection &&
      (typeof source !== "string" || !/^[a-f0-9]{64}$/.test(source) ||
        typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))
  ) {
    return "Error: Select an exact skill and the reviewed proposal and draft digests.";
  }
  const proposal = await ctx.skillLoader.inspectCreation(skillName);
  if (
    !proposal ||
    (!inspection &&
      (proposal.proposalDigest !== source || proposal.draftDigest !== digest))
  ) {
    return "Error: The reviewed proposal or destination is unavailable.";
  }
  const applicable = () =>
    owner() &&
    canFlowTo(currentTaint(), proposal.input.classificationCeiling);
  if (!applicable()) {
    return "Error: The proposed skill is outside the active owner scope.";
  }
  const scan = await ctx.skillScanner.scan(proposal.markdown);
  if (!applicable()) {
    return "Error: The proposed skill is outside the active owner scope.";
  }
  if (inspection) {
    return JSON.stringify({
      skill_name: skillName,
      proposal_digest: proposal.proposalDigest,
      draft_digest: proposal.draftDigest,
      classification_ceiling: proposal.input.classificationCeiling,
      reviewable: scan.ok,
      creation: proposal.creation ?? null,
      _classification: currentTaint(),
    });
  }
  if (!scan.ok) {
    return "Error: The proposal was blocked by the skill security scanner.";
  }
  if (
    !ctx.getConfirmPrompt || !ctx.skillLoader.createDraft ||
    !dispatch?.reauthorizeOwnerApproval || !dispatch.ownerSessionId ||
    typeof source !== "string" || typeof digest !== "string"
  ) return "Error: The confirmation channel is unavailable.";
  if (proposal.creation) {
    return JSON.stringify({
      creation: proposal.creation,
      initial_status: "PENDING_APPROVAL",
      _classification: currentTaint(),
    });
  }
  const confirmed = await ctx.getConfirmPrompt()(
    `Create pending workspace skill '${skillName}' with ceiling ${proposal.input.classificationCeiling}? Proposal SHA-256 ${source}. Draft SHA-256 ${digest}.`,
  );
  if (!confirmed) return "The owner declined the skill creation.";
  if (!applicable() || !await dispatch.reauthorizeOwnerApproval()) {
    return "Error: Owner authorization changed before creation.";
  }
  const created = await ctx.skillLoader.createDraft(
    skillName,
    source,
    digest,
    dispatch.ownerSessionId,
    applicable,
  );
  return created
    ? JSON.stringify({
      creation: created,
      initial_status: "PENDING_APPROVAL",
      _classification: currentTaint(),
    })
    : "Error: The proposal or destination changed before creation.";
}

/**
 * Create a tool executor for skill reading operations.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 *
 * When optional security context is provided (skillContextTracker, getSessionTaint,
 * skillScanner), enforces classification ceiling, content integrity, and
 * scanner checks before activation.
 *
 * @param ctx - Context containing the skill loader and optional security wiring
 */
export function createSkillToolExecutor(
  ctx: SkillToolContext,
): (
  name: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<string | null> => {
    if (name === "inspect_skill_creation" || name === "create_skill") {
      return await executeCreationAction(ctx, name, input, context);
    }
    if (name === "inspect_skill_revision" || name === "stage_skill_revision") {
      return await executeRevisionAction(ctx, name, input, context);
    }
    if (
      name === "inspect_skill_draft" || name === "approve_skill" ||
      name === "withdraw_skill"
    ) {
      return await executeDraftAction(ctx, name, input, context);
    }
    if (name === "list_skills") {
      return await executeListSkills(ctx, input, context);
    }
    if (name !== "read_skill") return null;

    const type = input.type;
    const skillName = input.skill_name;

    if (
      typeof type !== "string" ||
      (type !== "BUNDLED" && type !== "USER_PROVIDED")
    ) {
      return "Error: read_skill requires 'type' to be BUNDLED or USER_PROVIDED.";
    }

    if (typeof skillName !== "string" || skillName.trim().length === 0) {
      return "Error: read_skill requires a non-empty 'skill_name' argument.";
    }

    const trimmedName = skillName.trim();
    const skills = await ctx.skillLoader.discover();

    const matchesType = (s: { source: SkillSource }) =>
      skillType(s.source) === type;

    const skill = skills.find(
      (s) => s.name === trimmedName && matchesType(s),
    );

    if (!skill) {
      const taint = ctx.getSessionTaint?.();
      const available = skills
        .filter((candidate) =>
          matchesType(candidate) &&
          (taint === undefined ||
            !enforceSkillClassificationCeiling(taint, candidate))
        )
        .map((s) => s.name)
        .sort()
        .join(", ");
      return JSON.stringify({
        found: false,
        skill_name: trimmedName,
        type,
        available: available || "(none)",
      });
    }

    // ─── Security enforcement at activation time ─────────────────────────────

    // 1. Classification ceiling check
    if (ctx.getSessionTaint) {
      const taint = ctx.getSessionTaint();
      const ceilingError = enforceSkillClassificationCeiling(taint, skill);
      if (ceilingError) {
        log.warn("Skill activation blocked by classification ceiling", {
          operation: "readSkillCeilingCheck",
          skillName: skill.name,
          sessionTaint: taint,
          skillCeiling: skill.classificationCeiling,
        });
        return `Error: ${ceilingError}`;
      }
    }

    // Read the SKILL.md content from disk
    const skillMdPath = join(skill.path, "SKILL.md");
    let content: string;
    try {
      content = await Deno.readTextFile(skillMdPath);
    } catch (err) {
      return `Error: Failed to read skill "${trimmedName}": ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    // 2. Verify the content still matches the entry selected at discovery.
    const currentHash = await computeSkillHash(content);
    if (skill.contentHash !== currentHash) {
      return "Error: The skill changed during activation. Retry discovery.";
    }
    if (skill.source !== "bundled") {
      const integrityOk = await verifySkillIntegrity(skill.path, currentHash);
      if (integrityOk === false) {
        log.warn("Skill content integrity check failed", {
          operation: "readSkillIntegrityCheck",
          skillName: skill.name,
          skillPath: skill.path,
        });
        return `Error: Skill "${skill.name}" content has been tampered. Reinstall from The Reef.`;
      }
    }

    // 3. Scanner check at activation time
    if (ctx.skillScanner) {
      const scanResult = await ctx.skillScanner.scan(content);
      if (!scanResult.ok) {
        log.warn("Skill activation blocked by scanner", {
          operation: "readSkillScannerCheck",
          skillName: skill.name,
          warnings: scanResult.warnings,
        });
        return `Error: Skill "${skill.name}" failed security scan: ${
          scanResult.warnings.join("; ")
        }`;
      }
    }

    if (skill.draftApproval) {
      const current = await ctx.skillLoader.inspectDraft?.(skill.name);
      if (
        current?.skill.draftApproval?.receiptId !==
          skill.draftApproval.receiptId
      ) return "Error: The skill approval changed during activation.";
    }

    // 4. Track the active skill for tool filtering and domain enforcement
    ctx.skillContextTracker?.setActive(skill);

    return JSON.stringify({
      found: true,
      skill_name: skill.name,
      type,
      source: skill.source,
      classification_ceiling: skill.classificationCeiling,
      ...(skill.draftApproval &&
        { approval_receipt_id: skill.draftApproval.receiptId }),
      requires_tools: skill.requiresTools,
      network_domains: skill.networkDomains,
      content,
    });
  };
}

/** @deprecated Use buildSkillToolDefinitions instead */
export const getSkillToolDefinitions = buildSkillToolDefinitions;
