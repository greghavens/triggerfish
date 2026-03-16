/**
 * Tool profiles, system prompt mappings, and resolution functions.
 *
 * Re-exports from split sub-modules for backward compatibility.
 * See tool_profile_defs.ts and service_availability.ts for implementations.
 *
 * @module
 */

export {
  resolvePromptsForProfile,
  resolveToolsForProfile,
  TOOL_GROUP_PROMPTS,
  TOOL_PROFILES,
  type ToolProfile,
  type ToolProfileName,
} from "./tool_profile_defs.ts";

export {
  buildToolDefinitions,
  buildUnconfiguredServicesPrompt,
  filterProfileByAvailability,
  getToolDefinitions,
  type ServiceAvailability,
} from "./service_availability.ts";
