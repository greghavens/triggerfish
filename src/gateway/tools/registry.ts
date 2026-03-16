/**
 * Tool definitions, groups, profiles, and system prompt mappings.
 *
 * This file re-exports from the split modules for backward compatibility.
 * New code should import from the specific modules directly.
 *
 * @module
 */

export {
  buildExecCommandDefinitions,
  buildExecFileDefinitions,
  buildExecInlineDefinitions,
  getExecCommandDefinitions,
  getExecFileDefinitions,
  getExecInlineDefinitions,
} from "./defs/exec_tool_defs.ts";
export {
  buildAgentInlineDefinitions,
  getAgentInlineDefinitions,
} from "./defs/agent_tool_defs.ts";
export {
  buildCronInlineDefinitions,
  getCronInlineDefinitions,
} from "./defs/cron_tool_defs.ts";
export { TOOL_GROUPS, type ToolGroupName } from "./defs/tool_groups.ts";
export {
  buildToolDefinitions,
  getToolDefinitions,
  resolvePromptsForProfile,
  resolveToolsForProfile,
  TOOL_GROUP_PROMPTS,
  TOOL_PROFILES,
  type ToolProfile,
  type ToolProfileName,
} from "./defs/tool_profiles.ts";
