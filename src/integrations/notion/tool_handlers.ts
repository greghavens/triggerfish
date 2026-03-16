/**
 * Notion tool handler implementations.
 *
 * Facade re-exporting from tool_handlers_pages.ts, tool_handlers_data.ts,
 * and tool_handlers_shared.ts.
 *
 * @module
 */

export {
  createNotionPage,
  executePagesCreate,
  executePagesRead,
  executePagesUpdate,
  executeSearch,
  queryNotionPages,
  readNotionPages,
  updateNotionPage,
} from "./tool_handlers_pages.ts";

export {
  appendNotionBlocks,
  createNotionDatabase,
  executeBlocksAppend,
  executeBlocksRead,
  executeDatabasesCreate,
  executeDatabasesQuery,
  queryNotionDatabase,
  readNotionBlocks,
} from "./tool_handlers_data.ts";

export {
  formatProperties,
  resolveNotionClassification,
} from "./tool_handlers_shared.ts";
