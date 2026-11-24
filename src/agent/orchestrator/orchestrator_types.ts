/**
 * Orchestrator types, events, and classification map builder.
 *
 * Facade re-exporting from orchestrator_config, orchestrator_events,
 * and classification_map. All external imports from this file continue
 * to work unchanged.
 *
 * @module
 */

// ─── Config and constants ────────────────────────────────────────────────────
export type { OrchestratorConfig } from "./orchestrator_config.ts";
export {
  DEFAULT_SYSTEM_PROMPT,
  MAX_TOOL_ITERATIONS,
  SOFT_LIMIT_ITERATIONS,
} from "./orchestrator_config.ts";

// ─── Events, patterns, and parsed types ──────────────────────────────────────
export type {
  ActiveSkillContext,
  OrchestratorEvent,
  OrchestratorEventCallback,
  ParsedToolCall,
} from "./orchestrator_events.ts";
export {
  LEAKED_INTENT_PATTERN,
  TRAILING_CONTINUATION_PATTERN,
} from "./orchestrator_events.ts";

// ─── Classification map ──────────────────────────────────────────────────────
export type {
  ClassificationMapConfig,
  ToolClassificationMaps,
} from "./classification_map.ts";
export { mapToolPrefixClassifications } from "./classification_map.ts";

// ─── Re-exports from core ────────────────────────────────────────────────────
export type { ToolDefinition, ToolExecutor } from "../../core/types/tool.ts";

export type {
  AgentTurnCheckpoint,
  CompactResult,
  HistoryEntry,
  Orchestrator,
  ProcessMessageOptions,
  ProcessMessageResult,
} from "../../core/types/orchestrator.ts";
