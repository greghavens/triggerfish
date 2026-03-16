/**
 * Notion integration — REST API access with classification-gated taint propagation.
 *
 * Provides tools for searching, reading, creating, and updating Notion
 * pages, databases, and blocks. All data classified at session taint
 * level or configured classification floor.
 *
 * @module
 */

export type {
  RawPropertySchema,
  RawPropertyValue,
  RawRichText,
} from "./raw_types.ts";

export type {
  CreateDatabaseOptions,
  CreatePageOptions,
  NotionAnnotations,
  NotionBlock,
  NotionBlockContent,
  NotionDatabase,
  NotionError,
  NotionPage,
  NotionPropertySchema,
  NotionPropertyValue,
  NotionRichText,
  NotionSearchResult,
  QueryDatabaseOptions,
  UpdatePageOptions,
} from "./types.ts";

export type { NotionClient, NotionClientConfig } from "./client.ts";

export { createNotionClient, formatNotionError } from "./client.ts";

export type { ResolveNotionTokenOptions } from "./auth.ts";

export { isValidNotionTokenFormat, resolveNotionToken } from "./auth.ts";

export type { NotionPagesService } from "./pages.ts";

export { createNotionPagesService } from "./pages.ts";

export type { NotionDatabasesService } from "./databases.ts";

export { createNotionDatabasesService } from "./databases.ts";

export type { NotionBlocksService } from "./blocks.ts";

export { createNotionBlocksService } from "./blocks.ts";

export {
  markdownToNotionBlocks,
  notionBlocksToMarkdown,
  parseInlineMarkdown,
} from "./richtext.ts";

export type { NotionToolContext } from "./tool_context.ts";

export {
  getNotionToolDefinitions,
  buildNotionToolDefinitions,
  NOTION_TOOLS_SYSTEM_PROMPT,
} from "./tool_defs.ts";

export { createNotionToolExecutor } from "./tools.ts";
