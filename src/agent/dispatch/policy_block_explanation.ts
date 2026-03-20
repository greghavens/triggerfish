/**
 * User-facing error messages for policy violations.
 *
 * Renders detailed explanations for blocked tool calls so the agent
 * can inform the user why a specific action was denied and what they
 * can do to resolve it.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SecurityContext } from "./security_context.ts";

/** Render tool-floor enforcement error. */
function renderToolFloorError(
  ctx: SecurityContext,
  sessionTaint: ClassificationLevel,
): string {
  return `Error: "${ctx.toolName}" requires a minimum session taint of ${ctx.toolFloor}. ` +
    `Your current session taint is ${sessionTaint}. ` +
    `Access higher-classified data first to escalate your session taint, ` +
    `or use a tool that doesn't require ${ctx.toolFloor} clearance.`;
}

/** Render resource write-down error. */
function renderWriteDownError(
  ctx: SecurityContext,
  sessionTaint: ClassificationLevel,
): string {
  if (ctx.isOutboundRequest && ctx.operationType === "read") {
    return `Error: Outbound request blocked — your session taint is ${sessionTaint}, ` +
      `but the target domain${
        ctx.resourceParam ? ` "${ctx.resourceParam}"` : ""
      } is classified ${ctx.resourceClassification}. ` +
      `Outbound HTTP requests from a ${sessionTaint}-tainted session to ${ctx.resourceClassification}-level domains ` +
      `risk exfiltrating classified data via the request itself. ` +
      `Use /clear to reset your session context and taint before fetching from ${ctx.resourceClassification}-classified domains.`;
  }
  return `Error: Write-down blocked — your session taint is ${sessionTaint}, ` +
    `but the target resource${
      ctx.resourceParam ? ` "${ctx.resourceParam}"` : ""
    } is classified ${ctx.resourceClassification}. ` +
    `A ${sessionTaint}-tainted session cannot write to ${ctx.resourceClassification}-level destinations. ` +
    `Use /clear to reset your session context and taint before writing to ${ctx.resourceClassification}-classified resources.`;
}

/** Render resource read-ceiling error. */
function renderReadCeilingError(ctx: SecurityContext): string {
  return `Error: Access denied — the resource${
    ctx.resourceParam ? ` "${ctx.resourceParam}"` : ""
  } is classified ${ctx.resourceClassification}, ` +
    `which exceeds your session ceiling of ${ctx.nonOwnerCeiling}. ` +
    `You do not have permission to access ${ctx.resourceClassification}-classified resources.`;
}

/** Build a detailed error message for a blocked tool call. */
export function renderPolicyBlockExplanation(
  ruleId: string | null,
  ctx: SecurityContext,
  sessionTaint: ClassificationLevel,
): string {
  switch (ruleId) {
    case "tool-floor-enforcement":
      return renderToolFloorError(ctx, sessionTaint);
    case "resource-write-down":
      return renderWriteDownError(ctx, sessionTaint);
    case "resource-read-ceiling":
      return renderReadCeilingError(ctx);
    case "no-write-down":
      return `Error: Write-down blocked — your session taint is ${sessionTaint}, ` +
        `which exceeds the target classification. ` +
        `Use /clear to reset your session context and taint before outputting to lower-classified channels.`;
    default:
      return `Tool call blocked by policy: ${ruleId ?? "denied"}`;
  }
}
