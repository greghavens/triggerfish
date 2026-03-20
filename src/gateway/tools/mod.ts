/**
 * Tool registration, profiles, and dispatch.
 *
 * @module
 */

export {
  createToolExecutor,
  resolvePromptsForProfile,
  resolveToolsForProfile,
  TOOL_GROUPS,
} from "./agent_tools.ts";

export { TOOL_GROUP_PROMPTS, TOOL_PROFILES } from "./registry.ts";

export type {
  SubsystemExecutor,
  ToolExecutorOptions,
} from "./executor/executor_types.ts";

export {
  buildSessionToolDefinitions,
  buildSignalToolDefinitions,
  createSessionToolExecutor,
  getSessionToolDefinitions,
  getSignalToolDefinitions,
  SESSION_TOOLS_SYSTEM_PROMPT,
} from "./session/session_tools.ts";
export type { RegisteredChannel } from "./session/session_tools.ts";

export type { SessionToolContext } from "./session/session_tools_defs.ts";

export {
  buildTriggerToolDefinitions,
  createTriggerToolExecutor,
  getTriggerContextToolDefinitions,
  getTriggerToolDefinitions,
  TRIGGER_SESSION_SYSTEM_PROMPT,
} from "./trigger/trigger_tools.ts";
export type { TriggerToolContext } from "./trigger/trigger_tools.ts";
