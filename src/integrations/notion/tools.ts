/**
 * Notion tool executor.
 *
 * Creates a chain-compatible executor that routes notion.* tool calls
 * to the appropriate handler. Returns null for unknown tools to allow
 * chaining with other executors.
 *
 * @module
 */

import type { NotionToolContext } from "./tool_context.ts";
import {
  appendNotionBlocks,
  createNotionDatabase,
  createNotionPage,
  queryNotionDatabase,
  queryNotionPages,
  readNotionBlocks,
  readNotionPages,
  updateNotionPage,
} from "./tool_handlers.ts";

/** Tool handler function type. */
type ToolHandler = (
  ctx: NotionToolContext,
  input: Record<string, unknown>,
) => Promise<string>;

/** Registry mapping each notion.* tool name to its handler. */
const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  "notion.search": queryNotionPages,
  "notion.pages.read": readNotionPages,
  "notion.pages.create": createNotionPage,
  "notion.pages.update": updateNotionPage,
  "notion.databases.query": queryNotionDatabase,
  "notion.databases.create": createNotionDatabase,
  "notion.blocks.read": readNotionBlocks,
  "notion.blocks.append": appendNotionBlocks,
};

/**
 * Create a tool executor for Notion tools.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 * Returns a graceful error message if ctx is undefined (Notion not configured).
 */
export function createNotionToolExecutor(
  ctx: NotionToolContext | undefined,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (!name.startsWith("notion.")) return null;
    if (!ctx) {
      return "Notion is not configured. Run: triggerfish connect notion";
    }
    const handler = TOOL_HANDLERS[name];
    if (!handler) return null;
    return handler(ctx, input);
  };
}
