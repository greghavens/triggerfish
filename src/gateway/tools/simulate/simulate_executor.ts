/**
 * Simulate tool executor — dry-run security pipeline for tool calls.
 *
 * Runs the security context assembly and taint escalation computation
 * without executing the tool. Returns predicted taint, escalation,
 * and blocked status so the LLM can make informed decisions.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { assembleSecurityContext } from "../../../agent/dispatch/security_context.ts";
import type { PathClassifier } from "../../../core/security/path_classification.ts";
import type { ToolFloorRegistry } from "../../../core/security/tool_floors.ts";
import type { DomainClassifier } from "../../../core/types/domain.ts";
import type { SubsystemExecutor } from "../executor/executor_types.ts";
import { createLogger } from "../../../core/logger/mod.ts";

export {
  buildSecurityConfigProxy,
  computeSimulatedTaint,
  evaluateSimulatedBlocked,
  parseSimulateInput,
  resolveToolPrefixClassification,
  validateSimulateInput,
} from "./simulate_handlers.ts";

import {
  buildSecurityConfigProxy,
  computeSimulatedTaint,
  evaluateSimulatedBlocked,
  parseSimulateInput,
} from "./simulate_handlers.ts";

const log = createLogger("simulate-tool");

// ─── Types ───────────────────────────────────────────────────────────────────

/** Injected dependencies for the simulate tool executor. */
export interface SimulateToolContext {
  readonly getSessionTaint: () => ClassificationLevel;
  readonly isOwner: () => boolean;
  readonly isTrigger: () => boolean;
  readonly toolClassifications?: ReadonlyMap<string, ClassificationLevel>;
  readonly integrationClassifications?: ReadonlyMap<
    string,
    ClassificationLevel
  >;
  readonly pathClassifier?: PathClassifier;
  readonly domainClassifier?: DomainClassifier;
  readonly toolFloorRegistry?: ToolFloorRegistry;
  readonly getWorkspacePath?: () => string | null;
  readonly getNonOwnerCeiling?: () => ClassificationLevel | null;
}

/** Simulation result returned as tool output. */
interface SimulationResult {
  readonly currentTaint: ClassificationLevel;
  readonly resultingTaint: ClassificationLevel;
  readonly escalation: boolean;
  readonly blocked: boolean;
  readonly blockReason?: string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

/** Run the full simulation pipeline and return the result. */
function executeSimulation(
  ctx: SimulateToolContext,
  toolName: string,
  toolArgs: Record<string, unknown>,
): SimulationResult {
  const currentTaint = ctx.getSessionTaint();
  const fakeCall = { name: toolName, args: toolArgs };

  const { input: hookInput, ctx: secCtx } = assembleSecurityContext(
    fakeCall,
    buildSecurityConfigProxy(ctx),
  );
  log.info("Simulation security context assembled", {
    operation: "assembleSecurityContext",
    toolName,
    resourceClassification: secCtx.resourceClassification,
    toolFloor: secCtx.toolFloor,
    currentTaint,
  });

  const resultingTaint = computeSimulatedTaint(
    currentTaint,
    secCtx.resourceClassification,
    toolName,
    ctx.toolClassifications,
    ctx.toolFloorRegistry,
  );
  const hookInputWithTaint = { ...hookInput, session_taint: resultingTaint };

  const { blocked, reason } = evaluateSimulatedBlocked(
    hookInputWithTaint,
    resultingTaint,
    toolName,
    ctx.integrationClassifications,
  );
  log.info("Simulation evaluation complete", {
    operation: "evaluateSimulatedBlocked",
    toolName,
    currentTaint,
    resultingTaint,
    escalation: resultingTaint !== currentTaint,
    blocked,
    blockReason: reason,
  });

  return {
    currentTaint,
    resultingTaint,
    escalation: resultingTaint !== currentTaint,
    blocked,
    ...(reason ? { blockReason: reason } : {}),
  };
}

/**
 * Create a SubsystemExecutor for the simulate_tool_call tool.
 *
 * Returns null for any tool name other than `simulate_tool_call`.
 */
export function createSimulateToolExecutor(
  ctx: SimulateToolContext,
): SubsystemExecutor {
  return (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "simulate_tool_call") return Promise.resolve(null);

    const validationError = parseSimulateInput(input);
    if (validationError) return Promise.resolve(validationError);

    const toolName = input.tool_name as string;
    const toolArgs = input.tool_args as Record<string, unknown>;
    const result = executeSimulation(ctx, toolName, toolArgs);
    return Promise.resolve(JSON.stringify(result, null, 2));
  };
}
