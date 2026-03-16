/**
 * Tool definitions, profiles, and executor for the agent — re-export barrel.
 *
 * Sub-modules:
 * - agent_tool_registry.ts: Definitions, groups, profiles, system prompt mappings
 * - agent_tool_executor.ts: ToolExecutorOptions and createToolExecutor dispatch
 *
 * @module
 */

// ─── Registry: definitions, groups, profiles, prompts ────────────
export {
  buildToolDefinitions,
  getToolDefinitions,
  resolvePromptsForProfile,
  resolveToolsForProfile,
  TOOL_GROUP_PROMPTS,
  TOOL_GROUPS,
  TOOL_PROFILES,
  type ToolGroupName,
  type ToolProfile,
  type ToolProfileName,
} from "./registry.ts";

// ─── Executor: dispatch factory ──────────────────────────────────
export {
  createToolExecutor,
  type ToolExecutorOptions,
} from "./executor/executor.ts";
