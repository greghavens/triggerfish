/**
 * Default system policy rules.
 *
 * These rules enforce core security invariants that cannot be disabled:
 * write-down prevention, untrusted input blocking, tool floor enforcement,
 * resource classification gating, and rate limiting placeholders.
 *
 * @module
 */

import type { PolicyRule } from "../rules.ts";

/** Build the no-write-down enforcement rule for PRE_OUTPUT. */
function buildNoWriteDownRule(): PolicyRule {
  return {
    id: "no-write-down",
    priority: 1000,
    hook: "PRE_OUTPUT",
    conditions: [{
      field: "write_down_violation",
      operator: "equals",
      value: "true",
    }],
    action: "BLOCK",
    message:
      "Write-down violation: session taint exceeds target classification",
  };
}

/** Build the untrusted input blocking rule for PRE_CONTEXT_INJECTION. */
function buildUntrustedInputRule(): PolicyRule {
  return {
    id: "untrusted-input",
    priority: 1000,
    hook: "PRE_CONTEXT_INJECTION",
    conditions: [{
      field: "source_type",
      operator: "equals",
      value: "UNTRUSTED",
    }],
    action: "BLOCK",
    message: "Untrusted input source blocked",
  };
}

/** Build the tool floor enforcement rule for PRE_TOOL_CALL. */
function buildToolFloorRule(): PolicyRule {
  return {
    id: "tool-floor-enforcement",
    priority: 1000,
    hook: "PRE_TOOL_CALL",
    conditions: [{
      field: "tool_floor_violation",
      operator: "equals",
      value: "true",
    }],
    action: "BLOCK",
    message: "Tool requires minimum classification level",
  };
}

/** Build the resource write-down prevention rule for PRE_TOOL_CALL. */
function buildResourceWriteDownRule(): PolicyRule {
  return {
    id: "resource-write-down",
    priority: 1000,
    hook: "PRE_TOOL_CALL",
    conditions: [{
      field: "resource_write_down_violation",
      operator: "equals",
      value: "true",
    }],
    action: "BLOCK",
    message: "Write-down: session taint exceeds target resource classification",
  };
}

/** Build the resource read ceiling enforcement rule for PRE_TOOL_CALL. */
function buildResourceReadCeilingRule(): PolicyRule {
  return {
    id: "resource-read-ceiling",
    priority: 1000,
    hook: "PRE_TOOL_CALL",
    conditions: [{
      field: "resource_read_ceiling_violation",
      operator: "equals",
      value: "true",
    }],
    action: "BLOCK",
    message: "Resource classification exceeds session ceiling",
  };
}

/** Build the rate limit placeholder rule for PRE_TOOL_CALL. */
function buildRateLimitBaseRule(): PolicyRule {
  return {
    id: "rate-limit-base",
    priority: 500,
    hook: "PRE_TOOL_CALL",
    conditions: [],
    action: "ALLOW",
    message: "Rate limit placeholder",
  };
}

/**
 * Build the log-file content redact rule for PRE_CONTEXT_INJECTION.
 *
 * Marks log file content as REDACT so the orchestrator knows the content
 * has been pre-processed by readLogsForLlm() before entering LLM context.
 * The actual injection scanning and stripping is done by log_reader.ts;
 * this rule signals that the content carries provenance warnings.
 */
function buildLogFileRedactRule(): PolicyRule {
  return {
    id: "log-file-redact",
    priority: 950,
    hook: "PRE_CONTEXT_INJECTION",
    conditions: [{
      field: "source_type",
      operator: "equals",
      value: "LOG_FILE",
    }],
    action: "REDACT",
    message:
      "Log file content: external regions scanned and sanitized before LLM context injection",
  };
}

/**
 * Create the default system policy rules.
 *
 * These rules enforce core security invariants that cannot be disabled.
 *
 * @returns Array of default PolicyRule objects
 */
export function createDefaultRules(): PolicyRule[] {
  return [
    buildNoWriteDownRule(),
    buildUntrustedInputRule(),
    buildToolFloorRule(),
    buildResourceWriteDownRule(),
    buildResourceReadCeilingRule(),
    {
      id: "owner-chat-goal-mutation-approval",
      priority: 760,
      hook: "PRE_TOOL_CALL",
      conditions: [
        { field: "tool_name", operator: "equals", value: "goal_report" },
        {
          field: "chat_goal_mutation",
          operator: "matches",
          value: "^(register|revise)$",
        },
        { field: "is_owner", operator: "equals", value: "true" },
        { field: "is_trigger", operator: "equals", value: "false" },
      ],
      action: "REQUIRE_APPROVAL",
    },
    {
      id: "configured-mcp-lifecycle-approval",
      priority: 760,
      hook: "PRE_TOOL_CALL",
      conditions: [
        { field: "tool_name", operator: "equals", value: "mcp_manage" },
        {
          field: "mcp_lifecycle_action",
          operator: "matches",
          value: "^(add|replace|enable|disable|remove)$",
        },
        { field: "is_owner", operator: "equals", value: "true" },
        { field: "is_trigger", operator: "equals", value: "false" },
      ],
      action: "REQUIRE_APPROVAL",
    },
    {
      id: "configured-custom-tool-approval",
      priority: 760,
      hook: "PRE_TOOL_CALL",
      conditions: [
        { field: "tool_name", operator: "equals", value: "custom_tool_manage" },
        { field: "custom_tool_apply", operator: "equals", value: "true" },
        { field: "is_owner", operator: "equals", value: "true" },
        { field: "is_trigger", operator: "equals", value: "false" },
      ],
      action: "REQUIRE_APPROVAL",
    },
    buildRateLimitBaseRule(),
    buildLogFileRedactRule(),
  ];
}

/** Configure exact root tool names, below mandatory denials and above default allow. */
export function createToolApprovalRules(input: unknown): PolicyRule[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) || input.length > 100 ||
    input.some((name) =>
      typeof name !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/.test(name)
    )
  ) throw new Error("tool_approval must list up to 100 exact tool names");
  return [...new Set<string>(input)].map((name) => ({
    id: `tool-approval:${name}`,
    priority: 750,
    hook: "PRE_TOOL_CALL",
    conditions: [{ field: "tool_name", operator: "equals", value: name }],
    action: "REQUIRE_APPROVAL",
  }));
}
