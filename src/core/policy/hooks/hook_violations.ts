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
import { createLogger } from "../../logger/logger.ts";

const log = createLogger("policy-violations");

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

/**
 * Check if a non-owner read exceeds the user's classification ceiling.
 *
 * Default-deny: a non-owner session with no ceiling (or an unparseable
 * one) is capped at PUBLIC — reads of higher-classified resources are
 * violations rather than silently allowed.
 */
export function detectResourceReadCeilingViolation(
  input: Record<string, unknown>,
): boolean {
  const rc = input.resource_classification as ClassificationLevel | undefined;
  if (rc === undefined || input.operation_type !== "read") return false;
  if (input.is_owner !== false) return false;
  const rawCeiling = input.non_owner_ceiling;
  const ceiling: ClassificationLevel =
    typeof rawCeiling === "string" && rawCeiling in CLASSIFICATION_ORDER
      ? rawCeiling as ClassificationLevel
      : "PUBLIC";
  return !canFlowTo(rc, ceiling);
}

/** Log the default-deny branch of the read-ceiling detector at WARN. */
function logReadCeilingDefaultDeny(
  context: HookContext,
  violation: boolean,
): void {
  if (!violation || context.input.non_owner_ceiling !== undefined) return;
  log.warn(
    "Resource read denied: non-owner session has no ceiling (default-deny above PUBLIC)",
    {
      operation: "detectResourceReadCeilingViolation",
      sessionId: context.session.id,
      resourceClassification: context.input.resource_classification,
    },
  );
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
  const readCeilingViolation = detectResourceReadCeilingViolation(input);
  logReadCeilingDefaultDeny(context, readCeilingViolation);

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
    resource_read_ceiling_violation: readCeilingViolation ? "true" : "false",
  };
}
