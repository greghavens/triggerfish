/**
 * Violation detection functions for enforcement hooks.
 *
 * Each function checks a specific classification invariant against
 * the session state and input context. These are pure, deterministic
 * predicates used during hook evaluation to detect policy breaches.
 *
 * @module
 */

import { canFlowTo, CLASSIFICATION_ORDER } from "../../types/classification.ts";
import type { ClassificationLevel } from "../../types/classification.ts";
import type { HookContext } from "./hook_types.ts";

/** Check if session taint cannot flow to the target classification. */
export function detectWriteDownViolation(
  input: Record<string, unknown>,
  sessionTaint: ClassificationLevel,
): boolean {
  const target = input.target_classification as ClassificationLevel | undefined;
  return target !== undefined &&
    target in CLASSIFICATION_ORDER &&
    !canFlowTo(sessionTaint, target);
}

/** Check if session taint is below the tool's required minimum floor. */
export function detectToolFloorViolation(
  input: Record<string, unknown>,
  sessionTaint: ClassificationLevel,
): boolean {
  const toolFloor = input.tool_floor as ClassificationLevel | undefined;
  return toolFloor !== undefined &&
    toolFloor in CLASSIFICATION_ORDER &&
    CLASSIFICATION_ORDER[sessionTaint] < CLASSIFICATION_ORDER[toolFloor];
}

/**
 * Check if session taint exceeds a resource's classification level.
 *
 * Triggers for:
 * - Write operations (writing tainted data to a lower-classified resource).
 * - Outbound network requests (the HTTP request itself carries session
 *   context — URL, headers, timing — to the remote server, making even
 *   "read" fetches a data-exfiltration vector from higher-tainted sessions).
 *
 * Local filesystem reads are safe read-ups and do not trigger this check.
 */
export function detectResourceWriteDownViolation(
  input: Record<string, unknown>,
  sessionTaint: ClassificationLevel,
): boolean {
  const rc = input.resource_classification as ClassificationLevel | undefined;
  const opType = input.operation_type as string | undefined;
  const isOutbound = input.is_outbound_request === true;
  return rc !== undefined &&
    rc in CLASSIFICATION_ORDER &&
    (opType === "write" || isOutbound) &&
    !canFlowTo(sessionTaint, rc);
}

/** Check if a non-owner read exceeds the user's classification ceiling. */
export function detectResourceReadCeilingViolation(
  input: Record<string, unknown>,
): boolean {
  const rc = input.resource_classification as ClassificationLevel | undefined;
  const ceiling = input.non_owner_ceiling as ClassificationLevel | undefined;
  return rc !== undefined &&
    input.operation_type === "read" &&
    input.is_owner === false &&
    ceiling !== undefined &&
    ceiling in CLASSIFICATION_ORDER &&
    !canFlowTo(rc, ceiling);
}

/**
 * Build the evaluation context by merging session state fields into the input.
 *
 * Injects session_id, user_id, channel_id, session_taint, write-down
 * violation flags, tool floor violation, and path classification violations
 * for use in policy condition evaluation.
 */
export function buildEvaluationContext(
  context: HookContext,
): Record<string, unknown> {
  const { session, input } = context;

  return {
    ...input,
    session_id: session.id,
    user_id: session.userId,
    channel_id: session.channelId,
    session_taint: session.taint,
    write_down_violation: detectWriteDownViolation(input, session.taint)
      ? "true"
      : "false",
    tool_floor_violation: detectToolFloorViolation(input, session.taint)
      ? "true"
      : "false",
    resource_write_down_violation:
      detectResourceWriteDownViolation(input, session.taint) ? "true" : "false",
    resource_read_ceiling_violation: detectResourceReadCeilingViolation(input)
      ? "true"
      : "false",
  };
}
