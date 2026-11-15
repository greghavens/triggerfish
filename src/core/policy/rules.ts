/**
 * Policy rule types for the deterministic enforcement engine.
 *
 * Rules define conditions under which actions (ALLOW, BLOCK, REDACT,
 * REQUIRE_APPROVAL) are taken at specific enforcement hooks.
 *
 * @module
 */

/** Enforcement hook types — points in the data flow where policy is evaluated. */
export type HookType =
  | "PRE_CONTEXT_INJECTION"
  | "PRE_TOOL_CALL"
  | "POST_TOOL_RESPONSE"
  | "PRE_OUTPUT"
  | "SESSION_RESET"
  | "MCP_TOOL_CALL";

/** Operators for comparing context field values against rule conditions. */
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "matches";

/** A single condition that must be satisfied for a rule to match. */
export interface PolicyCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value: string | number;
}

/** Actions the policy engine can take when a rule matches. */
export type PolicyAction = "ALLOW" | "BLOCK" | "REDACT" | "REQUIRE_APPROVAL";

/**
 * A policy rule binding conditions to an action at a specific hook.
 *
 * Rules are evaluated in priority order (descending — higher number first).
 * The first matching rule wins.
 */
export interface PolicyRule {
  readonly id: string;
  readonly priority: number;
  readonly hook: HookType;
  readonly conditions: readonly PolicyCondition[];
  readonly action: PolicyAction;
  readonly message?: string;
  readonly redaction_pattern?: string;
  readonly notify?: boolean;
}
