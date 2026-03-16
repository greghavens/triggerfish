/**
 * Notion tool handlers — search and page operations.
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

/** Handle notion.search tool invocation. */
export async function queryNotionPages(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query;
  if (typeof query !== "string" || query.length === 0) {
    return "Error: notion.search requires a non-empty 'query' argument.";
  }
  log.info("Notion search", {
    operation: "executeSearch",
    query: String(input.query).slice(0, 100),
  });
  const type = typeof input.type === "string"
    ? input.type as "page" | "database"
    : undefined;
  const pageSize = typeof input.page_size === "number"
    ? input.page_size
    : undefined;
  const result = await ctx.pages.search(query, { type, pageSize });
  if (!result.ok) return formatNotionError(result.error);
  const classification = resolveNotionClassification(ctx);
  return JSON.stringify({
    results: result.value.results.map((r) => ({
      type: r.type,
      id: r.id,
      title: r.title,
      url: r.url,
      last_edited: r.lastEditedTime,
    })),
    next_cursor: result.value.nextCursor,
    _classification: classification,
  });
}

/** @deprecated Use queryNotionPages instead */
export const executeSearch = queryNotionPages;

/** Handle notion.pages.read tool invocation. */
export async function readNotionPages(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const pageId = input.page_id;
  if (typeof pageId !== "string" || pageId.length === 0) {
    return "Error: notion.pages.read requires a 'page_id' argument.";
  }
  log.info("Notion pages.read", { operation: "executePagesRead", pageId });
  const classification = resolveNotionClassification(ctx);
  const result = await ctx.pages.read(pageId, classification);
  if (!result.ok) return formatNotionError(result.error);
  const markdown = notionBlocksToMarkdown(result.value.content);
  const properties = formatProperties(result.value.page.properties);
  return JSON.stringify({
    title: result.value.page.title,
    url: result.value.page.url,
    properties,
    content: markdown,
    _classification: classification,
  });
}

/** @deprecated Use readNotionPages instead */
export const executePagesRead = readNotionPages;

/** Handle notion.pages.create tool invocation. */
export async function createNotionPage(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const parentId = input.parent_id;
  if (typeof parentId !== "string" || parentId.length === 0) {
    return "Error: notion.pages.create requires a 'parent_id' argument.";
  }
  const parentType = input.parent_type;
  if (parentType !== "database_id" && parentType !== "page_id") {
    return 'Error: notion.pages.create requires parent_type of "database_id" or "page_id".';
  }
  const title = input.title;
  if (typeof title !== "string" || title.length === 0) {
    return "Error: notion.pages.create requires a 'title' argument.";
  }
  log.info("Notion pages.create", { operation: "executePagesCreate" });
  const children = typeof input.content === "string"
    ? markdownToNotionBlocks(input.content)
    : undefined;
  const properties =
    typeof input.properties === "object" && input.properties !== null
      ? input.properties as Readonly<Record<string, unknown>>
      : undefined;
  const classification = resolveNotionClassification(ctx);
  const result = await ctx.pages.create(
    { parentId, parentType, title, properties, children },
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

/** @deprecated Use createNotionPage instead */
export const executePagesCreate = createNotionPage;

/** Handle notion.pages.update tool invocation. */
export async function updateNotionPage(
  ctx: NotionToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const pageId = input.page_id;
  if (typeof pageId !== "string" || pageId.length === 0) {
    return "Error: notion.pages.update requires a 'page_id' argument.";
  }
  const properties =
    typeof input.properties === "object" && input.properties !== null
      ? input.properties as Readonly<Record<string, unknown>>
      : undefined;
  const archived = typeof input.archived === "boolean"
    ? input.archived
    : undefined;
  if (!properties && archived === undefined) {
    return "Error: notion.pages.update requires at least one of 'properties' or 'archived'.";
  }
  log.info("Notion pages.update", { operation: "executePagesUpdate", pageId });
  const classification = resolveNotionClassification(ctx);
  const result = await ctx.pages.update(
    pageId,
    { properties, archived },
    classification,
  );
  if (!result.ok) return formatNotionError(result.error);
  return JSON.stringify({
    id: result.value.id,
    title: result.value.title,
    url: result.value.url,
    archived: result.value.archived,
    _classification: classification,
  });
}

/** @deprecated Use updateNotionPage instead */
export const executePagesUpdate = updateNotionPage;
