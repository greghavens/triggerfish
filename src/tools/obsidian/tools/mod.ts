/**
 * Obsidian tool definitions, executor, and read/write handlers.
 *
 * @module
 */

export type { ObsidianToolContext } from "./tools_defs.ts";
export {
  buildObsidianToolDefinitions,
  getObsidianToolDefinitions,
  OBSIDIAN_SYSTEM_PROMPT,
} from "./tools_defs.ts";

export { createObsidianToolExecutor } from "./tools.ts";

export {
  executeObsidianRead,
  executeObsidianWrite,
  readObsidianNote,
  recordLineage,
  resolveNotePath,
  writeObsidianNote,
} from "./tools_read_write.ts";
