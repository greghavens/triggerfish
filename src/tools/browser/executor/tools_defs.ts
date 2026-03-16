/**
 * Browser tool definitions and system prompt for the agent.
 *
 * Defines the 9 `browser_*` tool schemas (navigate, snapshot, click,
 * type, select, scroll, wait, describe, close) and the system prompt
 * section. Separated from the implementation and executor for lighter
 * definition-only imports.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

function buildNavigateDef(): ToolDefinition {
  return {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. Subject to SSRF prevention and domain policy.",
    parameters: {
      url: {
        type: "string",
        description: "The URL to navigate to (http or https only)",
        required: true,
      },
    },
  };
}

function buildSnapshotDef(): ToolDefinition {
  return {
    name: "browser_snapshot",
    description:
      "Take a screenshot of the current page, extract visible text content, " +
      "and return a list of links (text + href) found on the page.",
    parameters: {},
  };
}

function buildClickDef(): ToolDefinition {
  return {
    name: "browser_click",
    description:
      "Click an element on the page. Accepts standard CSS selectors (#id, .class, a[href]) " +
      "and Puppeteer text selectors. To click by visible text use: a::-p-text(Deepgram). " +
      "NEVER use :contains() — it is not a valid CSS selector.",
    parameters: {
      selector: {
        type: "string",
        description:
          "Selector for the element. Use CSS (#id, .class, tag[attr]) or " +
          "Puppeteer text selector (::-p-text(visible text)) to match by content. " +
          "Do NOT use :contains() — it is invalid.",
        required: true,
      },
    },
  };
}

function buildTypeDef(): ToolDefinition {
  return {
    name: "browser_type",
    description: "Type text into an input element by CSS selector.",
    parameters: {
      selector: {
        type: "string",
        description: "CSS selector of the input element",
        required: true,
      },
      text: { type: "string", description: "The text to type", required: true },
    },
  };
}

function buildSelectDef(): ToolDefinition {
  return {
    name: "browser_select",
    description: "Select a value in a dropdown by CSS selector.",
    parameters: {
      selector: {
        type: "string",
        description: "CSS selector of the select element",
        required: true,
      },
      value: {
        type: "string",
        description: "The option value to select",
        required: true,
      },
    },
  };
}

function buildScrollDef(): ToolDefinition {
  return {
    name: "browser_scroll",
    description: "Scroll the page in a given direction.",
    parameters: {
      direction: {
        type: "string",
        description: '"up", "down", "left", or "right"',
        required: true,
      },
      amount: {
        type: "number",
        description: "Pixels to scroll (default: 500)",
        required: false,
      },
    },
  };
}

function buildWaitDef(): ToolDefinition {
  return {
    name: "browser_wait",
    description:
      "Wait for a CSS selector to appear, or wait for a fixed duration if no selector is given.",
    parameters: {
      selector: {
        type: "string",
        description: "CSS selector to wait for (optional)",
        required: false,
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 10000)",
        required: false,
      },
    },
  };
}

function buildDescribeDef(): ToolDefinition {
  return {
    name: "browser_describe",
    description:
      "Send the latest browser screenshot to a vision model for a detailed visual description. Takes a fresh screenshot if none is cached. Use after browser_snapshot when you need to understand the visual layout.",
    parameters: {
      prompt: {
        type: "string",
        description:
          "Optional prompt to guide the description (e.g., 'What error is shown?')",
        required: false,
      },
    },
  };
}

function buildCloseDef(): ToolDefinition {
  return {
    name: "browser_close",
    description:
      "Close the browser and end the browser session. Call this when you are done with all browser tasks.",
    parameters: {},
  };
}

/**
 * Get browser tool definitions for the agent orchestrator.
 */
export function buildBrowserToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildNavigateDef(),
    buildSnapshotDef(),
    buildClickDef(),
    buildTypeDef(),
    buildSelectDef(),
    buildScrollDef(),
    buildWaitDef(),
    buildDescribeDef(),
    buildCloseDef(),
  ];
}

/** System prompt section explaining browser tools to the LLM. */
export const BROWSER_TOOLS_SYSTEM_PROMPT = `## Browser Automation

You have browser automation tools (browser_navigate, browser_snapshot, browser_click, browser_type, browser_select, browser_scroll, browser_wait, browser_describe, browser_close). The browser auto-launches on first use — just call the tools directly.

When the user asks to open or go to a website, call browser_navigate immediately. Use browser_snapshot after navigating to see the page. browser_snapshot returns visible text AND a list of page links (text + href). Use this link list to navigate to linked pages — call browser_navigate with the href directly instead of trying to click link text. Use browser_describe if you need a visual description of the screenshot. Read the browser-automation skill for detailed usage patterns.

When the user says "open Brave", "open Chrome", or "open a browser tab", use browser_navigate with an http/https URL — never use browser-scheme URLs like brave:// or chrome://. Only http and https are supported.

### Clicking Elements

Use CSS selectors: \`#id\`, \`.class\`, \`button[type="submit"]\`, \`a[href="/path"]\`.

To click by visible text, use Puppeteer text selectors:
- \`a::-p-text(Deepgram)\` — click a link containing "Deepgram"
- \`::-p-text(Sign In)\` — click any element containing "Sign In"

NEVER use \`:contains()\` — it is not a valid CSS selector and will fail.

When the user asks you to close the browser, close a tab, or is done with browser tasks, call browser_close.`;

/** @deprecated Use buildBrowserToolDefinitions instead */
export const getBrowserToolDefinitions = buildBrowserToolDefinitions;
