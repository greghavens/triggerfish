/**
 * Notion tool handlers — database and block operations.
 *
 * @module
 */

import { createLogger } from "../../core/logger/mod.ts";
import { formatNotionError } from "./client.ts";
import { markdownToNotionBlocks, notionBlocksToMarkdown } from "./richtext.ts";
import type { NotionToolContext } from "./tool_context.ts";
import {
  formatProperties,
  resolveNotionClassification,
} from "./tool_handlers_shared.ts";

const log = createLogger("notion:handlers");

/** Handle notion.databases.query tool invocation. */
export async function queryNotionDatabase(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const databaseId = input.database_id;
  if (typeof databaseId !== "string" || databaseId.length === 0) {
    return "Error: notion.databases.query requires a 'database_id' argument.";
  }
  log.info("Notion databases.query", {
    operation: "executeDatabasesQuery",
    databaseId,
  });
  const filter = typeof input.filter === "object" && input.filter !== null
    ? input.filter as Readonly<Record<string, unknown>>
    : undefined;
  const sorts = Array.isArray(input.sorts)
    ? input.sorts as readonly Readonly<Record<string, unknown>>[]
    : undefined;
  const pageSize = typeof input.page_size === "number"
    ? input.page_size
    : undefined;
  const startCursor = typeof input.start_cursor === "string"
    ? input.start_cursor
    : undefined;
  const classification = resolveNotionClassification(ctx);
  const result = await ctx.databases.query(
    databaseId,
    { filter, sorts, pageSize, startCursor },
    classification,
  );
  if (!result.ok) return formatNotionError(result.error);
  return JSON.stringify({
    results: result.value.results.map((page) => ({
      id: page.id,
      title: page.title,
      url: page.url,
      properties: formatProperties(page.properties),
    })),
    next_cursor: result.value.nextCursor,
    _classification: classification,
  });
}

/** @deprecated Use queryNotionDatabase instead */
export const executeDatabasesQuery = queryNotionDatabase;

/** Handle notion.databases.create tool invocation. */
export async function createNotionDatabase(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const parentPageId = input.parent_page_id;
  if (typeof parentPageId !== "string" || parentPageId.length === 0) {
    return "Error: notion.databases.create requires a 'parent_page_id' argument.";
  }
  const title = input.title;
  if (typeof title !== "string" || title.length === 0) {
    return "Error: notion.databases.create requires a 'title' argument.";
  }
  const properties = input.properties;
  if (typeof properties !== "object" || properties === null) {
    return "Error: notion.databases.create requires a 'properties' argument with database schema.";
  }
  log.info("Notion databases.create", { operation: "executeDatabasesCreate" });
  const classification = resolveNotionClassification(ctx);
  const result = await ctx.databases.create(
    parentPageId,
    {
      title,
      properties: properties as Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >,
    },
    classification,
  );
  if (!result.ok) return formatNotionError(result.error);
  return JSON.stringify({
    id: result.value.id,
    title: result.value.title,
    url: result.value.url,
    _classification: classification,
  });
}

/** @deprecated Use createNotionDatabase instead */
export const executeDatabasesCreate = createNotionDatabase;

/** Handle notion.blocks.read tool invocation. */
export async function readNotionBlocks(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const blockId = input.block_id;
  if (typeof blockId !== "string" || blockId.length === 0) {
    return "Error: notion.blocks.read requires a 'block_id' argument.";
  }
  log.info("Notion blocks.read", { operation: "executeBlocksRead", blockId });
  const pageSize = typeof input.page_size === "number"
    ? input.page_size
    : undefined;
  const startCursor = typeof input.start_cursor === "string"
    ? input.start_cursor
    : undefined;
  const result = await ctx.blocks.readChildren(blockId, {
    pageSize,
    startCursor,
  });
  if (!result.ok) return formatNotionError(result.error);
  const classification = resolveNotionClassification(ctx);
  const markdown = notionBlocksToMarkdown(result.value.results);
  return JSON.stringify({
    content: markdown,
    block_count: result.value.results.length,
    next_cursor: result.value.nextCursor,
    _classification: classification,
  });
}

/** @deprecated Use readNotionBlocks instead */
export const executeBlocksRead = readNotionBlocks;

/** Handle notion.blocks.append tool invocation. */
export async function appendNotionBlocks(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const blockId = input.block_id;
  if (typeof blockId !== "string" || blockId.length === 0) {
    return "Error: notion.blocks.append requires a 'block_id' argument.";
  }
  const content = input.content;
  if (typeof content !== "string" || content.length === 0) {
    return "Error: notion.blocks.append requires a non-empty 'content' argument.";
  }
  log.info("Notion blocks.append", {
    operation: "executeBlocksAppend",
    blockId,
  });
  const notionBlocks = markdownToNotionBlocks(content);
  const result = await ctx.blocks.append(blockId, notionBlocks);
  if (!result.ok) return formatNotionError(result.error);
  const classification = resolveNotionClassification(ctx);
  return JSON.stringify({
    appended_blocks: result.value.length,
    _classification: classification,
  });
}

/** @deprecated Use appendNotionBlocks instead */
export const executeBlocksAppend = appendNotionBlocks;
