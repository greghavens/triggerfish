/**
 * Tool access control and enforcement wrapper.
 *
 * Enforces trigger/non-owner tool ceilings, escalates taint from
 * response classifications, resolves secret references, and wraps
 * the raw tool executor with the enforcement pipeline.
 *
 * Tool prefix taint escalation is handled conditionally in tool_dispatch.ts
 * to avoid double-escalation with resource-classified tools.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import { resolveSecretRefs } from "../../core/secrets/resolver.ts";
import type {
  OrchestratorConfig,
  ToolExecutor,
} from "../orchestrator/orchestrator_types.ts";
import type { ToolFloorRegistry } from "../../core/security/tool_floors.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("access-control");

// ─── Access control checks ──────────────────────────────────────────────────

/** Check trigger tool access ceiling. Returns error message or null. */
export function enforceTriggerToolCeiling(
  name: string,
  ceiling: ClassificationLevel | null,
  toolClassifications:
    | ReadonlyMap<string, ClassificationLevel>
    | undefined,
  toolFloorRegistry?: ToolFloorRegistry,
): string | null {
  if (ceiling === null || !toolClassifications) return null;
  for (const [prefix, level] of toolClassifications) {
    if (name.startsWith(prefix)) {
      if (!canFlowTo(level, ceiling)) {
        return `Error: ${name} (classified ${level}) exceeds trigger ceiling ${ceiling}. Access denied.`;
      }
      return null;
    }
  }
  const floor = toolFloorRegistry?.getFloor(name) ?? null;
  if (floor !== null && !canFlowTo(floor, ceiling)) {
    return `Error: ${name} (classified ${floor}) exceeds trigger ceiling ${ceiling}. Access denied.`;
  }
  return null;
}

/** Check non-owner tool access ceiling. Returns error message or null. */
export function enforceNonOwnerToolCeiling(
  name: string,
  ceiling: ClassificationLevel | null,
  toolClassifications:
    | ReadonlyMap<string, ClassificationLevel>
    | undefined,
  toolFloorRegistry?: ToolFloorRegistry,
): string | null {
  if (ceiling === null) {
    return `Error: Tool calls are not available in this session.`;
  }
  if (!toolClassifications) return null;
  for (const [prefix, level] of toolClassifications) {
    if (name.startsWith(prefix)) {
      if (!canFlowTo(level, ceiling)) {
        return `Error: ${name} (classified ${level}) exceeds session ceiling ${ceiling}. Access denied.`;
      }
      return null;
    }
  }
  const floor = toolFloorRegistry?.getFloor(name) ?? null;
  if (floor !== null) {
    if (!canFlowTo(floor, ceiling)) {
      return `Error: ${name} (classified ${floor}) exceeds session ceiling ${ceiling}. Access denied.`;
    }
    return null;
  }
  return `Error: Tool calls are not available in this session.`;
}

/** Escalate session taint when calling a classified tool prefix or floored tool. */
export function escalateToolPrefixTaint(
  name: string,
  toolClassifications:
    | ReadonlyMap<string, ClassificationLevel>
    | undefined,
  escalateTaint:
    | ((level: ClassificationLevel, reason: string) => void)
    | undefined,
  toolFloorRegistry?: ToolFloorRegistry,
): void {
  if (!escalateTaint) return;
  if (toolClassifications) {
    for (const [prefix, level] of toolClassifications) {
      if (name.startsWith(prefix)) {
        log.warn("Escalating taint from tool prefix match", {
          operation: "escalateToolPrefixTaint",
          toolName: name,
          classificationLevel: level,
        });
        escalateTaint(level, `Tool call: ${name}`);
        return;
      }
    }
  }
  const floor = toolFloorRegistry?.getFloor(name) ?? null;
  if (floor !== null) {
    log.warn("Escalating taint from tool floor", {
      operation: "escalateToolFloorTaint",
      toolName: name,
      classificationLevel: floor,
    });
    escalateTaint(floor, `Tool call: ${name}`);
  }
}

/** Find the first `_classification` string in a parsed JSON value. */
function findClassification(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj._classification === "string") return obj._classification;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>)._classification === "string") {
          return (item as Record<string, unknown>)._classification as string;
        }
      }
    }
  }
  return null;
}

/** Escalate taint from _classification field in tool response JSON. */
export function escalateResponseClassification(
  result: string,
  escalateTaint:
    | ((level: ClassificationLevel, reason: string) => void)
    | undefined,
  toolName: string,
): void {
  if (!escalateTaint) return;
  try {
    const parsed = JSON.parse(result);
    const cls = findClassification(parsed);
    if (cls !== null) {
      escalateTaint(cls as ClassificationLevel, `Tool response: ${toolName}`);
    }
  } catch {
    /* Not JSON or no _classification — expected for most tools */
  }
}

// ─── Tool executor wrapper ───────────────────────────────────────────────────

/** Enforce access control for trigger and non-owner sessions. */
function enforceAccessControl(
  name: string,
  config: OrchestratorConfig,
): string | null {
  const isActiveTrigger = config.isTriggerSession?.() ?? false;
  if (isActiveTrigger) {
    return enforceTriggerToolCeiling(
      name,
      config.getNonOwnerCeiling?.() ?? null,
      config.toolClassifications,
      config.toolFloorRegistry,
    );
  }
  if (config.isOwnerSession && !config.isOwnerSession()) {
    return enforceNonOwnerToolCeiling(
      name,
      config.getNonOwnerCeiling?.() ?? null,
      config.toolClassifications,
      config.toolFloorRegistry,
    );
  }
  return null;
}

/** Resolve secret references in tool input, returning error or resolved input. */
async function resolveToolSecrets(
  input: Record<string, unknown>,
  config: OrchestratorConfig,
): Promise<{ resolved: Record<string, unknown>; error: string | null }> {
  if (!config.secretStore) return { resolved: input, error: null };
  const resolution = await resolveSecretRefs(input, config.secretStore);
  if (!resolution.ok) return { resolved: input, error: null };
  if (resolution.value.missing.length > 0) {
    return {
      resolved: input,
      error:
        `Error: The following secrets were referenced but not found in the secret store: ${
          resolution.value.missing.map((n) => `'${n}'`).join(", ")
        }. Use secret_save to store them first.`,
    };
  }
  return { resolved: resolution.value.resolved, error: null };
}

/** Create the classification-enforcing tool executor wrapper. */
export function wrapToolExecutorWithEnforcement(
  rawToolExecutor: ToolExecutor,
  config: OrchestratorConfig,
): ToolExecutor {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> => {
    const accessErr = enforceAccessControl(name, config);
    if (accessErr) return accessErr;

    const { resolved, error } = await resolveToolSecrets(input, config);
    if (error) return error;

    const result = await rawToolExecutor(name, resolved);
    escalateResponseClassification(result, config.escalateTaint, name);
    return result;
  };
}
