/**
 * Enforcement hooks — re-export barrel for backward compatibility.
 *
 * The hook implementation has been split into:
 * - hook_types.ts: Type definitions (HookContext, HookResult, etc.)
 * - hook_violations.ts: Classification violation detectors
 * - hook_runner.ts: Hook runner with timeout and logging
 * - default_rules.ts: Default system policy rules
 *
 * @module
 */

export type {
  HookContext,
  HookLogEntry,
  HookLogger,
  HookResult,
  HookRunner,
  HookRunnerOptions,
} from "./hook_types.ts";

export { createHookRunner } from "./hook_runner.ts";
export {
  createDefaultRules,
  createToolApprovalRules,
} from "./default_rules.ts";
