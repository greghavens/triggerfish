/**
 * Enforcement hooks — type definitions, violation detectors, runner, and default rules.
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

export {
  buildEvaluationContext,
  detectResourceReadCeilingViolation,
  detectResourceWriteDownViolation,
  detectToolFloorViolation,
  detectWriteDownViolation,
} from "./hook_violations.ts";

export { createHookRunner } from "./hook_runner.ts";
export { createDefaultRules } from "./default_rules.ts";
export type { SecretAccessPolicyRule } from "./secret_access_hook.ts";
export {
  createDefaultSecretAccessRules,
  evaluateSecretAccessPolicy,
} from "./secret_access_hook.ts";
