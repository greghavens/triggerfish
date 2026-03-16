/**
 * Plan mode subsystem: structured planning before code changes.
 *
 * @module
 */

export type { PlanManager, PlanManagerOptions } from "./plan_types.ts";

export { createPlanManager } from "./plan.ts";

export { createPlanToolExecutor } from "./executor.ts";

export type {
  ActivePlan,
  AgentMode,
  ImplementationPlan,
  PlanComplexity,
  PlanModeState,
  PlanRecord,
  PlanStatus,
  PlanStep,
} from "./types.ts";

export {
  DEFAULT_PLAN_STATE,
  PLAN_ALLOWED_TOOLS,
  PLAN_BLOCKED_CRON_ACTIONS,
  PLAN_BLOCKED_TOOLS,
} from "./types.ts";

export {
  buildAwaitingApprovalPrompt,
  buildPlanExecutionPrompt,
  buildPlanModePrompt,
  formatPlanAsMarkdown,
} from "./prompt.ts";

export {
  buildPlanToolDefinitions,
  getPlanToolDefinitions,
  PLAN_SYSTEM_PROMPT,
} from "./tools.ts";
