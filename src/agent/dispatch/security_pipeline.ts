/**
 * Security pipeline for tool calls — plan mode, taint escalation, policy hooks, bumpers.
 *
 * Contains the security enforcement stages that each tool call passes through
 * before execution: plan mode blocking, owner/trigger taint pre-escalation,
 * integration write-down checks, bumper classification checks, and PRE_TOOL_CALL
 * hook evaluation.
 *
 * @module
 */

import { canFlowTo } from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import { createPlanToolExecutor } from "../plan/plan.ts";
import type { PlanManager } from "../plan/plan.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
  ToolExecutor,
} from "../orchestrator/orchestrator_types.ts";
import {
  assembleSecurityContext,
  renderPolicyBlockExplanation,
} from "./security_context.ts";
import type { SecurityContext } from "./security_context.ts";
import { escalateToolPrefixTaint } from "./access_control.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("tool-dispatch");

/** Check plan mode blocking and execute plan tools. */
export async function invokePlanModeToolCall(
  planManager: PlanManager,
  sessionKey: string,
  call: ParsedToolCall,
): Promise<{ resultText: string | undefined; blocked: boolean }> {
  if (planManager.isToolBlocked(sessionKey, call.name, call.args)) {
    return {
      resultText: `Tool "${call.name}" is blocked in plan mode. ` +
        `Use plan_manage(action: "exit") to present your implementation plan first.`,
      blocked: true,
    };
  }
  const planExecutor = createPlanToolExecutor(planManager, sessionKey);
  const planResult = await planExecutor(call.name, call.args);
  if (planResult !== null) {
    return { resultText: planResult, blocked: false };
  }
  return { resultText: undefined, blocked: false };
}

/** Pre-escalate taint for owner/trigger resource access. */
export function preEscalateOwnerTriggerTaint(
  secCtx: SecurityContext,
  config: OrchestratorConfig,
  call: ParsedToolCall,
): void {
  if (
    secCtx.resourceClassification === null ||
    (!secCtx.isOwner && !secCtx.isTrigger) ||
    !config.escalateTaint
  ) {
    log.debug("Resource-based taint escalation skipped", {
      operation: "preEscalateOwnerTriggerTaint",
      toolName: call.name,
      resourceClassification: secCtx.resourceClassification,
      isOwner: secCtx.isOwner,
      isTrigger: secCtx.isTrigger,
    });
    return;
  }
  log.warn("Resource-based taint escalation firing", {
    operation: "preEscalateOwnerTriggerTaint",
    toolName: call.name,
    resourceClassification: secCtx.resourceClassification,
  });
  config.escalateTaint(
    secCtx.resourceClassification,
    `${call.name}: ${secCtx.resourceParam}`,
  );
}

/** Check integration write-down (session taint vs integration resource classification). */
export function enforceIntegrationWriteDownPolicy(
  call: ParsedToolCall,
  config: OrchestratorConfig,
): { resultText: string | undefined; blocked: boolean } {
  if (!config.integrationClassifications || !config.getSessionTaint) {
    return { resultText: undefined, blocked: false };
  }
  const sessionTaint = config.getSessionTaint();
  for (const [prefix, level] of config.integrationClassifications) {
    if (call.name.startsWith(prefix)) {
      if (!canFlowTo(sessionTaint, level)) {
        log.warn("Integration write-down blocked", {
          operation: "checkIntegrationWriteDown",
          toolName: call.name,
          sessionTaint,
          integrationClassification: level,
        });
        return {
          resultText:
            `Error: Session taint ${sessionTaint} cannot flow to ${call.name} (classified ${level}). ` +
            `Accessing a lower-classified integration from a higher-tainted session risks data leakage. ` +
            `Use /clear to reset your session context and taint before using ${level}-classified integrations.`,
          blocked: true,
        };
      }
      break;
    }
  }
  return { resultText: undefined, blocked: false };
}

/** Post-hook escalation for non-owner sessions. */
export function escalateNonOwnerResourceTaint(
  secCtx: SecurityContext,
  config: OrchestratorConfig,
  call: ParsedToolCall,
): void {
  if (
    secCtx.resourceClassification === null || secCtx.isOwner ||
    secCtx.isTrigger || !config.escalateTaint
  ) {
    log.debug("Non-owner taint escalation skipped", {
      operation: "escalateNonOwnerResourceTaint",
      toolName: call.name,
      resourceClassification: secCtx.resourceClassification,
      isOwner: secCtx.isOwner,
      isTrigger: secCtx.isTrigger,
    });
    return;
  }
  config.escalateTaint(
    secCtx.resourceClassification,
    `${call.name}: ${secCtx.resourceParam}`,
  );
}

/** Evaluate PRE_TOOL_CALL hook with real-time session taint. */
export async function evaluatePreToolCallHook(
  config: OrchestratorConfig,
  session: SessionState,
  secInput: Record<string, unknown>,
) {
  const currentTaint = config.getSessionTaint?.() ?? session.taint;
  const hookSession = currentTaint !== session.taint
    ? { ...session, taint: currentTaint }
    : session;
  const toolName = secInput.tool_name ?? secInput.name ?? "unknown";
  log.debug("Evaluating PRE_TOOL_CALL hook", {
    operation: "evaluatePreToolCallHook",
    toolName,
    currentTaint,
  });
  const result = await config.hookRunner.evaluateHook("PRE_TOOL_CALL", {
    session: hookSession,
    input: secInput,
  });
  if (!result.allowed) {
    log.warn("PRE_TOOL_CALL hook denied tool call", {
      operation: "evaluatePreToolCallHook",
      toolName,
      currentTaint,
      ruleId: result.ruleId,
      message: result.message,
    });
  }
  return { result, currentTaint };
}

/** Check if bumpers would block a tool call based on classification. */
export function assessBumpersForToolCall(
  secCtx: SecurityContext,
  config: OrchestratorConfig,
  call: ParsedToolCall,
): string | null {
  if (!config.checkBumpersBlock) return null;

  if (secCtx.resourceClassification !== null) {
    const blocked = config.checkBumpersBlock(secCtx.resourceClassification);
    if (blocked) {
      log.warn("Bumpers blocked tool call via resource classification", {
        operation: "checkBumpersForToolCall",
        toolName: call.name,
        resourceClassification: secCtx.resourceClassification,
      });
      return blocked;
    }
  }

  if (config.toolClassifications) {
    for (const [prefix, level] of config.toolClassifications) {
      if (call.name.startsWith(prefix)) {
        const blocked = config.checkBumpersBlock(level);
        if (blocked) {
          log.warn("Bumpers blocked tool call via prefix classification", {
            operation: "checkBumpersForToolCall",
            toolName: call.name,
            prefix,
            classificationLevel: level,
          });
          return blocked;
        }
        break;
      }
    }
  }

  const floor = config.toolFloorRegistry?.getFloor(call.name) ?? null;
  if (floor !== null) {
    const blocked = config.checkBumpersBlock(floor);
    if (blocked) {
      log.warn("Bumpers blocked tool call via floor registry", {
        operation: "checkBumpersForToolCall",
        toolName: call.name,
        floorClassification: floor,
      });
      return blocked;
    }
  }

  log.debug("Bumpers allowed tool call", {
    operation: "checkBumpersForToolCall",
    toolName: call.name,
  });
  return null;
}

/** Execute the tool after policy approval (write-down + escalation + dispatch). */
export async function dispatchApprovedToolCall(
  call: ParsedToolCall,
  config: OrchestratorConfig,
  secCtx: SecurityContext,
  toolExecutor: ToolExecutor,
): Promise<{ resultText: string; blocked: boolean }> {
  const writeDown = enforceIntegrationWriteDownPolicy(call, config);
  if (writeDown.resultText !== undefined) {
    return { resultText: writeDown.resultText, blocked: writeDown.blocked };
  }
  escalateNonOwnerResourceTaint(secCtx, config, call);
  return {
    resultText: await toolExecutor(call.name, call.args),
    blocked: false,
  };
}

/** Execute a single tool call through the full security pipeline. */
export async function dispatchSecurityEnforcedToolCall(
  call: ParsedToolCall,
  config: OrchestratorConfig,
  session: SessionState,
  toolExecutor: ToolExecutor,
): Promise<{ resultText: string; blocked: boolean }> {
  const { input: secInput, ctx: secCtx } = assembleSecurityContext(
    call,
    config,
  );

  const bumpersBlock = assessBumpersForToolCall(secCtx, config, call);
  if (bumpersBlock !== null) {
    return { resultText: bumpersBlock, blocked: true };
  }

  preEscalateOwnerTriggerTaint(secCtx, config, call);
  if (secCtx.resourceClassification === null) {
    log.debug(
      "Falling back to prefix-based taint escalation — resource classification is null",
      {
        operation: "escalateToolPrefixTaint",
        toolName: call.name,
      },
    );
    escalateToolPrefixTaint(
      call.name,
      config.toolClassifications,
      config.escalateTaint,
      config.toolFloorRegistry,
    );
  }

  const { result: preToolResult, currentTaint } = await evaluatePreToolCallHook(
    config,
    session,
    secInput,
  );

  if (!preToolResult.allowed) {
    return {
      resultText: renderPolicyBlockExplanation(
        preToolResult.ruleId,
        secCtx,
        currentTaint,
      ),
      blocked: true,
    };
  }
  return dispatchApprovedToolCall(call, config, secCtx, toolExecutor);
}

/** @deprecated Use invokePlanModeToolCall instead */
export const executePlanModeToolCall = invokePlanModeToolCall;

/** @deprecated Use enforceIntegrationWriteDownPolicy instead */
export const checkIntegrationWriteDown = enforceIntegrationWriteDownPolicy;

/** @deprecated Use assessBumpersForToolCall instead */
export const checkBumpersForToolCall = assessBumpersForToolCall;

/** @deprecated Use dispatchApprovedToolCall instead */
export const executeAfterPolicyApproval = dispatchApprovedToolCall;

/** @deprecated Use dispatchSecurityEnforcedToolCall instead */
export const executeSecurityEnforcedToolCall = dispatchSecurityEnforcedToolCall;
