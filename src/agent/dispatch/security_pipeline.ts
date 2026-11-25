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

import { isDeepStrictEqual } from "node:util";
import { computeContentHash } from "../../core/session/lineage_serde.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import type { SessionState } from "../../core/types/session.ts";
import type {
  HistoryEntry,
  ProcessMessageOptions,
  RecoveryToolCall,
  RecoveryToolPersistence,
} from "../../core/types/orchestrator.ts";
import { createPlanToolExecutor } from "../plan/plan.ts";
import type { PlanManager } from "../plan/plan.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
  ToolExecutor,
} from "../orchestrator/orchestrator_types.ts";
import { assembleSecurityContext } from "./security_context.ts";
import { renderPolicyBlockExplanation } from "./policy_block_explanation.ts";
import type { SecurityContext } from "./security_context.ts";
import { escalateToolPrefixTaint } from "./access_control.ts";
import { createLogger } from "../../core/logger/mod.ts";
import { parseNativeToolCalls } from "./tool_format.ts";

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
  auditInput?: Record<string, unknown>,
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
    ...(auditInput && { auditInput }),
  });
  if (!result.allowed) {
    log.warn("PRE_TOOL_CALL hook denied tool call", {
      operation: "evaluatePreToolCallHook",
      toolName,
      currentTaint,
      ruleId: result.ruleId,
      ...(!auditInput && { message: result.message }),
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
  beforeAuthorizedDispatch?: () => void | Promise<void>,
): Promise<{ resultText: string; blocked: boolean }> {
  const writeDown = enforceIntegrationWriteDownPolicy(call, config);
  if (writeDown.resultText !== undefined) {
    return { resultText: writeDown.resultText, blocked: writeDown.blocked };
  }
  escalateNonOwnerResourceTaint(secCtx, config, call);
  const taint = config.getSessionTaint?.();
  const capture = call.name === "web_fetch" &&
    config.isOwnerSession?.() === true &&
    secCtx.isOwner && !secCtx.isTrigger && taint !== undefined &&
    canFlowTo(taint, "INTERNAL") &&
    (secCtx.resourceClassification === null ||
      canFlowTo(secCtx.resourceClassification, "INTERNAL"));
  if (beforeAuthorizedDispatch) await beforeAuthorizedDispatch();
  return {
    resultText: capture
      ? await toolExecutor(call.name, call.args, { allowSentinelCapture: true })
      : await toolExecutor(call.name, call.args),
    blocked: false,
  };
}

/** Execute a single tool call through the full security pipeline. */
export async function dispatchSecurityEnforcedToolCall(
  call: ParsedToolCall,
  config: OrchestratorConfig,
  session: SessionState,
  toolExecutor: ToolExecutor,
  projectedAuditArgs?: Record<string, unknown>,
  signal?: AbortSignal,
  sessionKey = session.id as string,
  beforeAuthorizedDispatch?: (
    approvedRuleId?: string,
  ) => ReturnType<
    NonNullable<RecoveryToolPersistence["beforeAuthorizedDispatch"]>
  >,
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

  const inbox = config.hookRunner.toolApprovalInbox;
  const audit = projectedAuditArgs ?? (inbox ? {} : undefined);
  const { result: preToolResult, currentTaint } = await evaluatePreToolCallHook(
    config,
    session,
    secInput,
    audit && toolAuditInput(secInput, call, audit),
  );

  let currentContext = secCtx;
  let approval: {
    recordHandlerReturn(): unknown;
    finish(outcome: "returned" | "blocked" | "failed"): unknown;
  } | undefined;
  if (preToolResult.action === "REQUIRE_APPROVAL" && inbox) {
    const blocked = {
      resultText: "Tool approval was denied, expired, or no longer applies.",
      blocked: true,
    };
    const owner = config.toolApprovalContext;
    const activity = signal ?? new AbortController().signal;
    if (
      activity.aborted ||
      (owner?.isCurrent && !await owner.isCurrent(session.id))
    ) {
      return blocked;
    }
    const release = await inbox.wait({
      sessionId: session.id,
      runId: owner?.runId ?? session.id,
      assignmentId: owner?.assignmentId,
      tool: call.name,
      args: call.args,
      ruleId: preToolResult.ruleId,
      signal: activity,
    });
    if (!release) return blocked;
    try {
      const fresh = assembleSecurityContext(call, config);
      currentContext = fresh.ctx;
      const check = await evaluatePreToolCallHook(
        config,
        session,
        fresh.input,
        toolAuditInput(fresh.input, call, {}),
      );
      const permits =
        (check.result.allowed && check.result.action === "ALLOW") ||
        (check.result.action === "REQUIRE_APPROVAL" &&
          check.result.ruleId === preToolResult.ruleId);
      if (
        !permits || activity.aborted ||
        assessBumpersForToolCall(currentContext, config, call) !== null ||
        config.planManager?.isToolBlocked(sessionKey, call.name, call.args) ||
        (owner?.isCurrent && !await owner.isCurrent(session.id))
      ) return blocked;
      approval = release.claim(call.args);
      if (!approval) return blocked;
    } finally {
      if (!approval) release.stale();
    }
  } else if (!preToolResult.allowed || preToolResult.action !== "ALLOW") {
    return {
      resultText: renderPolicyBlockExplanation(
        preToolResult.ruleId,
        secCtx,
        currentTaint,
      ),
      blocked: true,
    };
  }
  let outcome: "returned" | "blocked" | "failed" = "failed";
  try {
    const response = await dispatchApprovedToolCall(
      call,
      config,
      currentContext,
      toolExecutor,
      beforeAuthorizedDispatch &&
        (async () => {
          const commit = await beforeAuthorizedDispatch(
            approval ? preToolResult.ruleId ?? undefined : undefined,
          );
          if (!commit) return;
          const fresh = assembleSecurityContext(call, config);
          const { result } = await evaluatePreToolCallHook(
            config,
            session,
            fresh.input,
            toolAuditInput(fresh.input, call, projectedAuditArgs ?? {}),
          );
          const permits = (result.allowed && result.action === "ALLOW") ||
            (approval && result.action === "REQUIRE_APPROVAL" &&
              result.ruleId === preToolResult.ruleId);
          if (
            !permits || assessBumpersForToolCall(fresh.ctx, config, call) ||
            config.planManager?.isToolBlocked(
              sessionKey,
              call.name,
              call.args,
            ) ||
            enforceIntegrationWriteDownPolicy(call, config).blocked
          ) {
            throw new Error("Tool policy changed before dispatch.");
          }
          signal?.throwIfAborted();
          const active = config.toolApprovalContext?.isCurrent;
          if (active && !await active(session.id)) {
            throw new Error("The tool assignment is no longer active.");
          }
          signal?.throwIfAborted();
          commit();
        }),
    );
    if (!response.blocked) approval?.recordHandlerReturn();
    const permitted = await enforcePostToolResponse(
      call.name,
      config,
      session,
      response,
    );
    if (!permitted.blocked) {
      config.onAuthorizedToolResponse?.(
        call.name,
        call.args,
        permitted.resultText,
      );
    }
    outcome = permitted.blocked
      ? "blocked"
      : permitted.resultText.startsWith("Error:")
      ? "failed"
      : "returned";
    return permitted;
  } finally {
    approval?.finish(outcome);
  }
}

/** Gate a completed tool response before formatting, persistence or model use. */
export async function enforcePostToolResponse(
  toolName: string,
  config: OrchestratorConfig,
  session: SessionState,
  response: { resultText: string; blocked: boolean },
): Promise<{ resultText: string; blocked: boolean }> {
  if (response.blocked) return response;
  try {
    const taint = config.getSessionTaint?.() ?? session.taint;
    const hookSession = taint === session.taint
      ? session
      : { ...session, taint };
    const metadata = {
      tool_name: toolName,
      session_taint: taint,
      response_length: response.resultText.length,
    };
    const decision = await config.hookRunner.evaluateHook(
      "POST_TOOL_RESPONSE",
      {
        session: hookSession,
        input: { ...metadata, tool_response: response.resultText },
        auditInput: metadata,
      },
    );
    if (decision.allowed && decision.action === "ALLOW") return response;
  } catch {
    // Tool output and hook exceptions may contain classified data.
  }
  return { resultText: "Tool response withheld by policy.", blocked: true };
}

function toolAuditInput(
  input: Record<string, unknown>,
  call: RecoveryToolCall,
  args: Record<string, unknown>,
) {
  return {
    ...input,
    tool_call: {
      name: call.name,
      ...(call.id !== undefined && { id: call.id }),
      args,
    },
  };
}

/** Reauthorize projected checkpoint results before restoring them to model history. */
export async function authorizeSavedToolResponses(
  history: readonly HistoryEntry[],
  calls: NonNullable<ProcessMessageOptions["resumeToolCalls"]>,
  config: OrchestratorConfig,
  session: SessionState,
  signal?: AbortSignal,
): Promise<boolean> {
  const results: { name?: string; toolCallId?: string; text: string }[] = [];
  const checkReceipts = calls.some(({ resultReceipt }) => !!resultReceipt);
  const requests = new Map<string, ParsedToolCall>();
  for (const entry of history) {
    if (checkReceipts && entry.role === "assistant" && entry.tool_calls) {
      const parsed = parseNativeToolCalls(entry.tool_calls, log, true);
      if (parsed.length !== entry.tool_calls.length) return false;
      for (const request of parsed) {
        if (!request.id || request.argsParseError || requests.has(request.id)) {
          return false;
        }
        requests.set(request.id, request);
      }
    } else if (entry.role === "tool") {
      if (typeof entry.content !== "string") return false;
      results.push({ toolCallId: entry.tool_call_id, text: entry.content });
    } else if (
      entry.role === "user" && typeof entry.content === "string" &&
      entry.content.startsWith('[TOOL_RESULT name="')
    ) {
      const frames = [...entry.content.matchAll(
        /\[TOOL_RESULT name="([A-Za-z_][A-Za-z0-9_.:-]{0,127})"\]\n([\s\S]*?)\n\[\/TOOL_RESULT\]/g,
      )];
      if (frames.map(([frame]) => frame).join("\n\n") !== entry.content) {
        return false;
      }
      results.push(...frames.map(([, name, text]) => ({ name, text })));
    }
  }
  if (calls.length !== results.length) return false;
  for (const [index, { name, toolCallId, text }] of results.entries()) {
    const { name: tool, args, resultReceipt } = calls[index];
    if (signal?.aborted || (name !== undefined && name !== tool)) return false;
    if (resultReceipt) {
      if (name === undefined) {
        if (toolCallId !== resultReceipt.toolCallId) return false;
        const request = requests.get(toolCallId);
        if (request?.name !== tool || !isDeepStrictEqual(request.args, args)) {
          return false;
        }
        requests.delete(toolCallId);
      }
      if (await computeContentHash(text) !== resultReceipt.sha256) return false;
    }
    const decision = await enforcePostToolResponse(tool, config, session, {
      resultText: text,
      blocked: false,
    });
    if (decision.blocked) return false;
  }
  return !signal?.aborted && requests.size === 0;
}

/** Re-evaluate a trusted saved read against current tool policy without dispatch. */
export async function authorizeSavedToolCalls(
  calls: readonly RecoveryToolCall[],
  config: OrchestratorConfig,
  session: SessionState,
  persistence?: RecoveryToolPersistence,
  signal?: AbortSignal,
) {
  if (!Array.isArray(calls) || calls.length > 128) return false;
  try {
    for (const call of calls) {
      if (
        signal?.aborted || !call || call.malformed ||
        typeof call.name !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(call.name) ||
        !call.args || typeof call.args !== "object" || Array.isArray(call.args)
      ) return false;
      const projected = persistence?.projectCall({
        ...call,
        args: structuredClone(call.args),
      });
      if (persistence && !projected) return false;
      if (config.planManager?.isToolBlocked(session.id, call.name, call.args)) {
        return false;
      }
      const { input, ctx } = assembleSecurityContext(call, config);
      if (assessBumpersForToolCall(ctx, config, call)) return false;
      const decision = await evaluatePreToolCallHook(
        config,
        session,
        input,
        toolAuditInput(input, call, projected ?? {}),
      );
      const { allowed, action, ruleId } = decision.result;
      if (allowed && action === "ALLOW") continue;
      if (
        action === "REQUIRE_APPROVAL" && ruleId &&
        persistence?.acceptsSavedApproval?.(call, ruleId)
      ) continue;
      return false;
    }
    return !signal?.aborted;
  } catch {
    return false;
  }
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
