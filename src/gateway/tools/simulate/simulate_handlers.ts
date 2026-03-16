/**
 * Simulate tool handlers — validation, taint computation, and block evaluation.
 *
 * Pure functions that implement the simulation pipeline steps without
 * side effects. Used by simulate_executor.ts to assemble the full
 * dry-run security evaluation.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import {
  canFlowTo,
  maxClassification,
} from "../../../core/types/classification.ts";
import type { ToolFloorRegistry } from "../../../core/security/tool_floors.ts";
import {
  detectResourceReadCeilingViolation,
  detectResourceWriteDownViolation,
  detectToolFloorViolation,
} from "../../../core/policy/hooks/hook_violations.ts";
import type { SecurityContextConfig } from "../../../agent/dispatch/security_context.ts";
import type { SimulateToolContext } from "./simulate_executor.ts";

// ─── Input validation ────────────────────────────────────────────────────────

/** Parse and validate simulate_tool_call input. Returns error string or null. */
export function parseSimulateInput(
  input: Record<string, unknown>,
): string | null {
  if (typeof input.tool_name !== "string" || input.tool_name.length === 0) {
    return "Error: simulate_tool_call requires a non-empty 'tool_name' argument (string).";
  }
  if (input.tool_args === undefined || input.tool_args === null) {
    return "Error: simulate_tool_call requires a 'tool_args' argument (object).";
  }
  if (typeof input.tool_args !== "object" || Array.isArray(input.tool_args)) {
    return "Error: simulate_tool_call 'tool_args' must be an object, not an array or primitive.";
  }
  return null;
}

/** @deprecated Use {@link parseSimulateInput} instead. */
export const validateSimulateInput = parseSimulateInput;

// ─── Taint computation ──────────────────────────────────────────────────────

/** Resolve the prefix-based classification for a tool name. */
export function resolveToolPrefixClassification(
  toolName: string,
  toolClassifications?: ReadonlyMap<string, ClassificationLevel>,
): ClassificationLevel | null {
  if (!toolClassifications) return null;
  for (const [prefix, level] of toolClassifications) {
    if (toolName.startsWith(prefix)) return level;
  }
  return null;
}

/**
 * Compute the taint that would result from executing a tool call.
 *
 * Mirrors the escalation logic in `tool_dispatch.ts`:
 * 1. If resource classification is available, use it (pre-escalation for owner/trigger).
 * 2. Otherwise, fall back to tool prefix classification.
 * 3. If no prefix match, fall back to tool floor registry.
 */
export function computeSimulatedTaint(
  currentTaint: ClassificationLevel,
  resourceClassification: ClassificationLevel | null,
  toolName: string,
  toolClassifications?: ReadonlyMap<string, ClassificationLevel>,
  toolFloorRegistry?: ToolFloorRegistry,
): ClassificationLevel {
  if (resourceClassification !== null) {
    return maxClassification(currentTaint, resourceClassification);
  }
  const prefixLevel = resolveToolPrefixClassification(
    toolName,
    toolClassifications,
  );
  if (prefixLevel !== null) {
    return maxClassification(currentTaint, prefixLevel);
  }
  const floor = toolFloorRegistry?.getFloor(toolName) ?? null;
  if (floor !== null) {
    return maxClassification(currentTaint, floor);
  }
  return currentTaint;
}

// ─── Blocked evaluation ──────────────────────────────────────────────────────

/** Block result for a detected violation. */
interface BlockResult {
  readonly blocked: boolean;
  readonly reason?: string;
}

const NOT_BLOCKED: BlockResult = { blocked: false };

/** Check tool floor violation. */
function checkToolFloorBlock(
  hookInput: Record<string, unknown>,
  resultingTaint: ClassificationLevel,
  toolName: string,
): BlockResult | null {
  if (!detectToolFloorViolation(hookInput, resultingTaint)) return null;
  const floor = hookInput.tool_floor as ClassificationLevel;
  return {
    blocked: true,
    reason:
      `Tool floor: ${toolName} requires ${floor}, session would be at ${resultingTaint}.`,
  };
}

/** Check resource write-down violation. */
function checkResourceWriteDownBlock(
  hookInput: Record<string, unknown>,
  resultingTaint: ClassificationLevel,
): BlockResult | null {
  if (!detectResourceWriteDownViolation(hookInput, resultingTaint)) return null;
  const rc = hookInput.resource_classification as ClassificationLevel;
  return {
    blocked: true,
    reason:
      `Write-down: session taint ${resultingTaint} cannot write to ${rc} resource.`,
  };
}

/** Check non-owner read ceiling violation. */
function checkReadCeilingBlock(
  hookInput: Record<string, unknown>,
): BlockResult | null {
  if (!detectResourceReadCeilingViolation(hookInput)) return null;
  const rc = hookInput.resource_classification as ClassificationLevel;
  const ceiling = hookInput.non_owner_ceiling as ClassificationLevel;
  return {
    blocked: true,
    reason: `Read ceiling: resource ${rc} exceeds session ceiling ${ceiling}.`,
  };
}

/** Check integration write-down (session taint vs integration classification). */
function checkIntegrationWriteDownBlock(
  resultingTaint: ClassificationLevel,
  toolName: string,
  integrationClassifications?: ReadonlyMap<string, ClassificationLevel>,
): BlockResult | null {
  if (!integrationClassifications) return null;
  for (const [prefix, level] of integrationClassifications) {
    if (!toolName.startsWith(prefix)) continue;
    if (!canFlowTo(resultingTaint, level)) {
      return {
        blocked: true,
        reason:
          `Integration write-down: session taint ${resultingTaint} cannot flow to ${toolName} (classified ${level}).`,
      };
    }
    break;
  }
  return null;
}

/**
 * Check whether the tool call would be blocked by policy.
 *
 * Evaluates: tool floor violation, resource write-down, read ceiling,
 * and integration write-down — all without side effects.
 */
export function evaluateSimulatedBlocked(
  hookInput: Record<string, unknown>,
  resultingTaint: ClassificationLevel,
  toolName: string,
  integrationClassifications?: ReadonlyMap<string, ClassificationLevel>,
): BlockResult {
  return checkToolFloorBlock(hookInput, resultingTaint, toolName) ??
    checkResourceWriteDownBlock(hookInput, resultingTaint) ??
    checkReadCeilingBlock(hookInput) ??
    checkIntegrationWriteDownBlock(
      resultingTaint,
      toolName,
      integrationClassifications,
    ) ??
    NOT_BLOCKED;
}

// ─── Config proxy ────────────────────────────────────────────────────────────

/** Build the config subset consumed by assembleSecurityContext. */
export function buildSecurityConfigProxy(
  ctx: SimulateToolContext,
): SecurityContextConfig {
  return {
    pathClassifier: ctx.pathClassifier,
    domainClassifier: ctx.domainClassifier,
    toolFloorRegistry: ctx.toolFloorRegistry,
    isOwnerSession: ctx.isOwner,
    isTriggerSession: ctx.isTrigger,
    getNonOwnerCeiling: ctx.getNonOwnerCeiling,
    getWorkspacePath: ctx.getWorkspacePath,
  };
}
