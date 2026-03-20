/**
 * Trigger tools — context loading, management, and system prompts.
 *
 * @module
 */

export {
  buildTriggerToolDefinitions,
  getTriggerContextToolDefinitions,
  getTriggerToolDefinitions,
  TRIGGER_SESSION_SYSTEM_PROMPT,
  TRIGGER_TOOLS_SYSTEM_PROMPT,
} from "./trigger_tools.ts";
export type { TriggerToolContext } from "./trigger_tools.ts";

export { createTriggerToolExecutor } from "./trigger_context_executor.ts";

export {
  buildTriggerManageToolDefinitions,
  getTriggerManageToolDefinitions,
  TRIGGER_MANAGE_SYSTEM_PROMPT,
} from "./trigger_manage_defs.ts";
export { createTriggerManageExecutor } from "./trigger_manage_executor.ts";
export { TRIGGER_INSTRUCTIONS_MEMORY_KEY } from "../../../core/security/constants.ts";
export type { TriggerManageContext } from "./trigger_manage_executor.ts";
