/**
 * Trigger context tools for the agent orchestrator.
 *
 * Re-exports from split modules:
 * - `trigger_tools_defs.ts` — tool definitions and system prompts
 * - `trigger_context_executor.ts` — context loading executor
 *
 * @module
 */

export {
  buildTriggerToolDefinitions,
  getTriggerContextToolDefinitions,
  getTriggerToolDefinitions,
  TRIGGER_SESSION_SYSTEM_PROMPT,
  TRIGGER_TOOLS_SYSTEM_PROMPT,
} from "./trigger_tools_defs.ts";

export { createTriggerToolExecutor } from "./trigger_context_executor.ts";
export type { TriggerToolContext } from "./trigger_context_executor.ts";
