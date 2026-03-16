/**
 * Web tool definitions and executor for web_search and web_fetch.
 *
 * Follows the same pattern as `src/tools/todo.ts` — provides tool
 * definitions, a system prompt section, and an executor factory.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";
import type { SearchProvider } from "./search.ts";
import type { WebFetcher } from "./fetch.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("web-tools");

// ─── Tool Definitions ───────────────────────────────────────────────────────

function buildWebSearchDef(): ToolDefinition {
  return {
    name: "web_search",
    description:
      "Search the web. Returns titles, URLs, and snippets. Use the URLs to fetch full page content with web_fetch.",
    parameters: {
      query: {
        type: "string",
        description:
          "Search query. Be specific — include relevant keywords, names, or dates for better results.",
        required: true,
      },
      max_results: {
        type: "number",
        description:
          "Maximum results to return (default: 5, max: 20). Use more for broad topics.",
        required: false,
      },
    },
  };
}

function buildWebFetchDef(): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL. Returns article text by default. If the result is very short or empty, retry with mode 'raw' or try a different URL.",
    parameters: {
      url: {
        type: "string",
        description:
          "The URL to fetch. Can be a webpage URL from web_search results, or a direct API endpoint (e.g. from a skill's instructions). For JSON APIs, use mode 'raw'.",
        required: true,
      },
      mode: {
        type: "string",
        description:
          "Extraction mode: 'readability' (default, article text) or 'raw' (full HTML/JSON). Use 'raw' for JSON API endpoints or if readability returns too little content.",
        required: false,
      },
    },
  };
}

/**
 * Get web tool definitions for the agent system prompt.
 */
export function buildWebToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildWebSearchDef(),
    buildWebFetchDef(),
  ];
}

// ─── System Prompt ──────────────────────────────────────────────────────────

/** System prompt section explaining web tools to the LLM. */
export const WEB_TOOLS_SYSTEM_PROMPT = `## Web Access

You have access to the internet via web_search and web_fetch tools.

- Use web_search to find information, then use web_fetch to read relevant pages before answering.
- web_fetch extracts article text by default. If extraction returns very little, retry with mode "raw".
- If a fetch fails or returns an error, try a different URL from the search results rather than giving up.
- When answering with web information, cite the source URLs inline so they are visible in all channels (e.g. Telegram, Slack).
- Never narrate your intent to search or fetch — just use the tools directly.`;

// ─── Executor Helpers ───────────────────────────────────────────────────────

async function executeWebSearch(
  searchProvider: SearchProvider | undefined,
  input: Record<string, unknown>,
): Promise<string> {
  if (!searchProvider) {
    return "Web search is not configured. Set up a search provider in triggerfish.yaml.";
  }

  const query = input.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return "Error: web_search requires a non-empty 'query' argument.";
  }

  const maxResults = typeof input.max_results === "number"
    ? Math.min(Math.max(input.max_results, 1), 20)
    : 5;

  const result = await searchProvider.search(query, { maxResults });

  if (!result.ok) {
    log.warn("Web search failed", {
      operation: "executeWebSearch",
      query,
      error: result.error,
    });
    return `Search error: ${result.error}`;
  }

  const sr = result.value;
  if (sr.results.length === 0) {
    log.info("Web search returned zero results", {
      operation: "executeWebSearch",
      query,
    });
    return `No results found for "${query}".`;
  }

  log.debug("Web search returned results", {
    operation: "executeWebSearch",
    query,
    resultCount: sr.results.length,
  });

  const lines = sr.results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
  );

  return `Search results for "${query}":\n\n${lines.join("\n\n")}`;
}

/**
 * Check whether a URL is allowed by the active skill's network domain restrictions.
 *
 * Returns null if allowed, or an error message string if blocked.
 * Exported for testing.
 */
export function enforceSkillDomainRestriction(
  url: string,
  getActiveSkillDomains: (() => readonly string[] | null) | undefined,
): string | null {
  const skillDomains = getActiveSkillDomains?.() ?? null;
  if (skillDomains === null) return null;

  if (skillDomains.length === 0) {
    return "Error: The active skill has declared no network access (network_domains: []).";
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return `Error: Invalid URL "${url}".`;
  }

  const allowed = skillDomains.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`),
  );

  if (!allowed) {
    return (
      `Error: Domain "${hostname}" is not in the active skill's declared ` +
      `network_domains (${skillDomains.join(", ")}).`
    );
  }

  return null;
}

async function executeWebFetch(
  webFetcher: WebFetcher | undefined,
  input: Record<string, unknown>,
  getActiveSkillDomains?: () => readonly string[] | null,
): Promise<string> {
  if (!webFetcher) {
    return "Web fetch is not available.";
  }

  const url = input.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return "Error: web_fetch requires a non-empty 'url' argument.";
  }

  // Check skill domain restriction before fetching
  const domainError = enforceSkillDomainRestriction(url, getActiveSkillDomains);
  if (domainError) return domainError;

  const mode = input.mode === "raw" ? "raw" as const : "readability" as const;
  const result = await webFetcher.fetch(url, { mode });

  if (!result.ok) {
    return `Fetch error: ${result.error}`;
  }

  const fr = result.value;
  const header = fr.title
    ? `Title: ${fr.title}\nURL: ${fr.url}\nMode: ${fr.mode}\n\n`
    : `URL: ${fr.url}\nMode: ${fr.mode}\n\n`;

  return header + fr.content;
}

// ─── Executor ───────────────────────────────────────────────────────────────

/** Options for creating a web tool executor. */
export interface WebToolExecutorOptions {
  readonly searchProvider?: SearchProvider;
  readonly webFetcher?: WebFetcher;
  /**
   * Returns active skill's declared networkDomains, or null if unrestricted.
   * null = no active skill or skill has no domain restriction.
   * [] = skill declared empty (no network access).
   * ["foo.com"] = skill is restricted to declared domains.
   */
  readonly getActiveSkillDomains?: () => readonly string[] | null;
}

/**
 * Create a tool executor for web tools.
 *
 * Returns null for unknown tool names (allowing chaining with other executors).
 *
 * Accepts either an options object or positional args (backward-compatible).
 *
 * @returns An executor function: (name, input) => Promise<string | null>
 */
export function createWebToolExecutor(
  optsOrSearch: WebToolExecutorOptions | SearchProvider | undefined,
  webFetcherArg?: WebFetcher | undefined,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  // Support both options object and positional args for backward compatibility
  const isOptions = optsOrSearch !== null &&
    optsOrSearch !== undefined &&
    typeof optsOrSearch === "object" &&
    !("search" in optsOrSearch) &&
    ("searchProvider" in optsOrSearch || "webFetcher" in optsOrSearch ||
      "getActiveSkillDomains" in optsOrSearch);

  const searchProvider = isOptions
    ? (optsOrSearch as WebToolExecutorOptions).searchProvider
    : optsOrSearch as SearchProvider | undefined;
  const webFetcher = isOptions
    ? (optsOrSearch as WebToolExecutorOptions).webFetcher
    : webFetcherArg;
  const getActiveSkillDomains = isOptions
    ? (optsOrSearch as WebToolExecutorOptions).getActiveSkillDomains
    : undefined;

  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (name) {
      case "web_search":
        return executeWebSearch(searchProvider, input);
      case "web_fetch":
        return executeWebFetch(webFetcher, input, getActiveSkillDomains);
      default:
        return null;
    }
  };
}

/** @deprecated Use buildWebToolDefinitions instead */
export const getWebToolDefinitions = buildWebToolDefinitions;
/** @deprecated Use enforceSkillDomainRestriction instead */
export const checkSkillDomainRestriction = enforceSkillDomainRestriction;
