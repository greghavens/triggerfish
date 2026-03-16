/**
 * Orchestrator — factory, types, system prompt, and vision fallback.
 *
 * @module
 */

export type {
  ActiveSkillContext,
  ClassificationMapConfig,
  CompactResult,
  HistoryEntry,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorEventCallback,
  ParsedToolCall,
  ProcessMessageOptions,
  ProcessMessageResult,
  ToolClassificationMaps,
  ToolDefinition,
  ToolExecutor,
} from "./orchestrator_types.ts";

export {
  DEFAULT_SYSTEM_PROMPT,
  LEAKED_INTENT_PATTERN,
  mapToolPrefixClassifications,
  MAX_TOOL_ITERATIONS,
  SOFT_LIMIT_ITERATIONS,
  TRAILING_CONTINUATION_PATTERN,
} from "./orchestrator_types.ts";

export type { OrchestratorState, TokenAccumulator } from "./orchestrator.ts";

export { createOrchestrator } from "./orchestrator.ts";

export { buildFullSystemPrompt, readSpineFromDisk } from "./system_prompt.ts";

export {
  orchestrateVisionFallback,
  processVisionFallback,
} from "./vision_fallback.ts";
