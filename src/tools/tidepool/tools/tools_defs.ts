/**
 * Tidepool tool definitions and system prompt.
 *
 * Defines the 5 A2UI canvas tool schemas (tidepool_render_component,
 * tidepool_render_html, tidepool_render_file, tidepool_update,
 * tidepool_clear) and the LLM system prompt section.
 *
 * Separated from the tools and executor in `tools.ts` for lighter
 * type-only imports.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildRenderComponentDef(): ToolDefinition {
  return {
    name: "tidepool_render_component",
    description: "Render a visual component tree in the Tidepool canvas. " +
      "The tree is broadcast to all connected Tidepool clients and displayed in the canvas panel.",
    parameters: {
      label: {
        type: "string",
        description:
          "Short label shown in the chat timeline (e.g. 'Dashboard', 'Results')",
        required: true,
      },
      tree: {
        type: "object",
        description:
          "Component tree object: { root: { type, id, props, children? }, version }",
        required: true,
      },
    },
  };
}

function buildRenderHtmlDef(): ToolDefinition {
  return {
    name: "tidepool_render_html",
    description: "Render raw HTML or SVG in the Tidepool canvas. " +
      "The content is displayed in a sandboxed iframe.",
    parameters: {
      label: {
        type: "string",
        description: "Short label shown in the chat timeline",
        required: true,
      },
      html: {
        type: "string",
        description: "Raw HTML or SVG string to render",
        required: true,
      },
    },
  };
}

/** Build parameter definitions for the tidepool_render_file tool. */
function buildRenderFileParams(): ToolDefinition["parameters"] {
  return {
    label: {
      type: "string",
      description: "Short label shown in the chat timeline",
      required: true,
    },
    filename: {
      type: "string",
      description: "Original filename (e.g. 'report.pdf', 'chart.png')",
      required: true,
    },
    mime: {
      type: "string",
      description:
        "MIME type (e.g. 'image/png', 'application/pdf', 'text/plain')",
      required: true,
    },
    data: {
      type: "string",
      description: "Base64-encoded file data",
      required: true,
    },
  };
}

function buildRenderFileDef(): ToolDefinition {
  return {
    name: "tidepool_render_file",
    description:
      "Render a file with preview and download in the Tidepool canvas. " +
      "Supports images, PDFs, text/code files, and archives.",
    parameters: buildRenderFileParams(),
  };
}

function buildUpdateDef(): ToolDefinition {
  return {
    name: "tidepool_update",
    description:
      "Update a single component's props by ID in the current Tidepool canvas tree.",
    parameters: {
      component_id: {
        type: "string",
        description: "The unique ID of the component to update",
        required: true,
      },
      props: {
        type: "object",
        description: "New props to merge into the component",
        required: true,
      },
    },
  };
}

function buildClearDef(): ToolDefinition {
  return {
    name: "tidepool_clear",
    description: "Clear the Tidepool canvas, removing all rendered content.",
    parameters: {},
  };
}

/** Get Tidepool A2UI tool definitions for the agent orchestrator. */
export function buildTidepoolToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildRenderComponentDef(),
    buildRenderHtmlDef(),
    buildRenderFileDef(),
    buildUpdateDef(),
    buildClearDef(),
  ];
}

/** System prompt section explaining Tidepool canvas tools to the LLM. */
export const TIDEPOOL_SYSTEM_PROMPT = `## Tidepool Canvas

You have a visual canvas panel. Render content ONCE per user request — do not re-render or iterate.

### Tools
- **tidepool_render_component** — Structured UI (cards, tables, charts, forms, images, markdown, layouts)
- **tidepool_render_html** — Raw HTML/SVG
- **tidepool_render_file** — File preview + download (base64 data)
- **tidepool_update** — Patch a component's props by ID
- **tidepool_clear** — Clear the canvas

### Component props
- card: { title, content } | table: { headers: string[], rows: string[][] }
- chart: { type: "bar"|"line"|"pie", labels, values } or { svg } | form: { fields: [{ name, type, label }] }
- image: { src, alt? } | markdown: { content } | layout: { direction: "row"|"column" } + children

### Rules
- Call ONE render tool per request, then respond to the user. Never call render tools multiple times for the same content.
- The canvas iframe has its own dark theme styling — do not include background colors or font styles in your HTML.
- If Tidepool is not connected, fall back to text output.`;

/** @deprecated Use buildTidepoolToolDefinitions instead */
export const getTidepoolToolDefinitions = buildTidepoolToolDefinitions;
