/**
 * Notion tool definitions and system prompt.
 *
 * Defines 8 tools under the `notion.` namespace and provides a system
 * prompt explaining Notion access to the LLM.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Get all 8 Notion tool definitions. */
export function buildNotionToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildSearchDef(),
    buildPagesReadDef(),
    buildPagesCreateDef(),
    buildPagesUpdateDef(),
    buildDatabasesQueryDef(),
    buildDatabasesCreateDef(),
    buildBlocksReadDef(),
    buildBlocksAppendDef(),
  ];
}

/** Build the notion.search tool definition. */
function buildSearchDef(): ToolDefinition {
  return {
    name: "notion.search",
    description:
      "Search Notion pages and databases by title. Returns matching items with their IDs and URLs.",
    parameters: {
      query: {
        type: "string",
        description: "Search query to match against page/database titles",
        required: true,
      },
      type: {
        type: "string",
        description: 'Filter by object type: "page" or "database"',
        enum: ["page", "database"],
      },
      page_size: {
        type: "number",
        description: "Number of results to return (default: 10, max: 100)",
      },
    },
  };
}

/** Build the notion.pages.read tool definition. */
function buildPagesReadDef(): ToolDefinition {
  return {
    name: "notion.pages.read",
    description:
      "Read a Notion page's properties and content as markdown. Returns clean readable text, not raw Notion JSON.",
    parameters: {
      page_id: {
        type: "string",
        description: "The Notion page ID (UUID format, with or without dashes)",
        required: true,
      },
    },
  };
}

/** Build the notion.pages.create tool definition. */
function buildPagesCreateDef(): ToolDefinition {
  return {
    name: "notion.pages.create",
    description:
      "Create a new Notion page in a database or as a sub-page. Content provided as markdown is converted to Notion blocks.",
    parameters: {
      parent_id: {
        type: "string",
        description: "ID of the parent database or page",
        required: true,
      },
      parent_type: {
        type: "string",
        description: 'Parent type: "database_id" or "page_id"',
        required: true,
        enum: ["database_id", "page_id"],
      },
      title: {
        type: "string",
        description: "Page title",
        required: true,
      },
      properties: {
        type: "object",
        description:
          "Additional page properties (for database pages). Use Notion API property format.",
      },
      content: {
        type: "string",
        description:
          "Page body content as markdown. Will be converted to Notion blocks.",
      },
    },
  };
}

/** Build the notion.pages.update tool definition. */
function buildPagesUpdateDef(): ToolDefinition {
  return {
    name: "notion.pages.update",
    description: "Update a Notion page's properties or archive/unarchive it.",
    parameters: {
      page_id: {
        type: "string",
        description: "The Notion page ID to update",
        required: true,
      },
      properties: {
        type: "object",
        description: "Properties to update. Use Notion API property format.",
      },
      archived: {
        type: "boolean",
        description: "Set to true to archive, false to unarchive",
      },
    },
  };
}

/** Build the notion.databases.query tool definition. */
function buildDatabasesQueryDef(): ToolDefinition {
  return {
    name: "notion.databases.query",
    description:
      'Query a Notion database with filters and sorts. Filters use Notion API format: { "property": "Status", "select": { "equals": "Done" } }. Sorts use: [{ "property": "Created", "direction": "descending" }].',
    parameters: {
      database_id: {
        type: "string",
        description: "The database ID to query",
        required: true,
      },
      filter: {
        type: "object",
        description:
          'Notion API filter object. Example: { "property": "Status", "select": { "equals": "Done" } }',
      },
      sorts: {
        type: "array",
        description:
          'Array of sort objects. Example: [{ "property": "Date", "direction": "descending" }]',
      },
      page_size: {
        type: "number",
        description: "Number of results per page (default: 50, max: 100)",
      },
      start_cursor: {
        type: "string",
        description:
          "Cursor for pagination (from previous query's next_cursor)",
      },
    },
  };
}

/** Build the notion.databases.create tool definition. */
function buildDatabasesCreateDef(): ToolDefinition {
  return {
    name: "notion.databases.create",
    description:
      "Create an inline database inside a Notion page. Define the schema with property types.",
    parameters: {
      parent_page_id: {
        type: "string",
        description: "ID of the parent page to create the database in",
        required: true,
      },
      title: {
        type: "string",
        description: "Database title",
        required: true,
      },
      properties: {
        type: "object",
        description:
          'Database schema. Map of property name to type definition. Example: { "Name": { "title": {} }, "Status": { "select": { "options": [{ "name": "Todo" }, { "name": "Done" }] } } }',
        required: true,
      },
    },
  };
}

/** Build the notion.blocks.read tool definition. */
function buildBlocksReadDef(): ToolDefinition {
  return {
    name: "notion.blocks.read",
    description:
      "Read child blocks of a page or block. Useful for reading truncated content or specific sections.",
    parameters: {
      block_id: {
        type: "string",
        description: "The block or page ID to read children from",
        required: true,
      },
      page_size: {
        type: "number",
        description: "Number of blocks to return (default: 100, max: 100)",
      },
      start_cursor: {
        type: "string",
        description: "Cursor for pagination",
      },
    },
  };
}

/** Build the notion.blocks.append tool definition. */
function buildBlocksAppendDef(): ToolDefinition {
  return {
    name: "notion.blocks.append",
    description:
      "Append markdown content to a Notion page or block. Markdown is converted to Notion blocks.",
    parameters: {
      block_id: {
        type: "string",
        description: "The page or block ID to append content to",
        required: true,
      },
      content: {
        type: "string",
        description:
          "Markdown content to append. Will be converted to Notion blocks.",
        required: true,
      },
    },
  };
}

/** @deprecated Use buildNotionToolDefinitions instead */
export const getNotionToolDefinitions = buildNotionToolDefinitions;

/** System prompt section explaining Notion tools to the LLM. */
export const NOTION_TOOLS_SYSTEM_PROMPT = `## Notion Access

You have access to Notion via 8 notion.* tools: search, pages, databases, and blocks.

- Page and database IDs are UUIDs (32 hex chars, with or without dashes).
- \`notion.pages.read\` returns page content as clean markdown — use it to read pages.
- \`notion.pages.create\` accepts markdown in the \`content\` parameter — it's converted to Notion blocks automatically.
- \`notion.blocks.append\` also accepts markdown in \`content\`.
- \`notion.databases.query\` uses Notion API filter format: \`{ "property": "Status", "select": { "equals": "Done" } }\`.
- All Notion data inherits the session's classification level. Accessing Notion data may escalate session taint.
- Pages must be explicitly shared with the Notion integration to be accessible.
- Never narrate your intent to use Notion tools — just call them directly.`;
