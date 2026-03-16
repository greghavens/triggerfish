/**
 * Memory tools — re-exports from split modules for backward compatibility.
 *
 * Tool definitions live in `tools_defs.ts`, executor logic in
 * `tools_executor.ts`. This file re-exports both so existing imports
 * from `./tools.ts` continue to work.
 *
 * @module
 */

export {
  buildMemoryToolDefinitions,
  getMemoryToolDefinitions,
  MEMORY_SYSTEM_PROMPT,
} from "./tools_defs.ts";

export type { MemoryToolContext } from "./tools_executor.ts";

export { createMemoryToolExecutor } from "./tools_executor.ts";
