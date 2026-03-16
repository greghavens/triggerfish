/**
 * Explore module — single-agent codebase exploration.
 *
 * @module
 */

export {
  buildExploreToolDefinitions,
  EXPLORE_SYSTEM_PROMPT,
  getExploreToolDefinitions,
} from "./tools_defs.ts";

export type { ExploreDepth } from "./tools_defs.ts";

export { buildExplorePrompt } from "./prompts.ts";

export { createExploreToolExecutor } from "./executor.ts";
export type { ExploreExecutorOptions } from "./executor.ts";

export { computeExploreIterationBudget } from "./budget.ts";
