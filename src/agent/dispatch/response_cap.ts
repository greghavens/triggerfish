/**
 * Centralized tool response capping with cache-backed read_more pagination.
 *
 * Truncates large tool responses at a configurable character budget and
 * stores the full text in an ephemeral per-session cache. The LLM can
 * retrieve subsequent chunks via the injected `read_more` tool, paying
 * token cost only when it actually needs more context.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("response-cap");

/** Default character budget for tool responses (~3K tokens). */
export const DEFAULT_RESPONSE_BUDGET = 12_000;

/** Maximum cached full-text entries before LRU eviction. */
export const MAX_CACHE_ENTRIES = 10;

/** Per-tool character budget overrides. */
export const TOOL_RESPONSE_BUDGETS: ReadonlyMap<string, number> = new Map([
  ["read_file", 20_000],
  ["github_issues", 6_000],
  ["browser_snapshot", 8_000],
  ["run_command", 16_000],
]);

/** A cached full-text tool response awaiting read_more retrieval. */
export interface CachedToolResponse {
  readonly fullText: string;
  readonly toolName: string;
  readonly budget: number;
  /** Cursor tracking the next unread offset. Auto-advances on each read. */
  cursor: number;
}

/** Generate a 6-character hex cache ID. */
function generateCacheId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * LRU-evicting cache for truncated tool responses.
 *
 * Stores up to MAX_CACHE_ENTRIES full-text entries. When capacity is
 * reached, the oldest entry (first inserted) is evicted.
 */
export class ResponseCache {
  readonly #entries = new Map<string, CachedToolResponse>();

  /** Store a full-text response and return its cache ID. */
  store(entry: CachedToolResponse): string {
    if (this.#entries.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.#entries.delete(oldestKey);
      }
    }
    const id = generateCacheId();
    this.#entries.set(id, entry);
    return id;
  }

  /** Retrieve a cached response by ID, or undefined if evicted/missing. */
  get(id: string): CachedToolResponse | undefined {
    return this.#entries.get(id);
  }

  /** Number of entries currently cached. */
  get size(): number {
    return this.#entries.size;
  }
}

/**
 * Find the last newline before the budget boundary.
 *
 * Returns the character index to slice at (exclusive). If no newline
 * exists before the budget, falls back to the budget itself.
 */
export function truncateAtLineBoundary(text: string, budget: number): number {
  const lastNewline = text.lastIndexOf("\n", budget);
  return lastNewline > 0 ? lastNewline : budget;
}

/**
 * Resolve the character budget for a tool response.
 *
 * Priority: per-tool override → config override → global default.
 */
function resolveBudget(toolName: string, configBudget?: number): number {
  const perTool = TOOL_RESPONSE_BUDGETS.get(toolName);
  if (perTool !== undefined) return perTool;
  return configBudget ?? DEFAULT_RESPONSE_BUDGET;
}

/**
 * Cap a tool response to the resolved budget.
 *
 * If the response fits within the budget, it is returned unchanged and
 * no cache entry is created. Otherwise the full text is cached and a
 * truncated version with a continuation marker is returned.
 */
export function capToolResponse(
  toolName: string,
  text: string,
  cache: ResponseCache,
  configBudget?: number,
): string {
  const budget = resolveBudget(toolName, configBudget);

  if (text.length <= budget) {
    return text;
  }

  const sliceEnd = truncateAtLineBoundary(text, budget);
  const entry: CachedToolResponse = {
    fullText: text,
    toolName,
    budget,
    cursor: sliceEnd,
  };
  const cacheId = cache.store(entry);
  const remaining = text.length - sliceEnd;

  log.info("Tool response truncated", {
    operation: "capToolResponse",
    toolName,
    originalLength: text.length,
    truncatedAt: sliceEnd,
    remaining,
    cacheId,
    budget,
  });

  const truncated = text.slice(0, sliceEnd);
  const marker =
    `\n… [truncated — ${remaining} chars remaining, use read_more(cache_id="${cacheId}") to continue]`;
  return truncated + marker;
}

/**
 * Retrieve the next chunk from a cached tool response.
 *
 * Returns the chunk text with a continuation marker appended if more
 * data remains, or the final chunk without a marker.
 */
export function readMoreFromCache(
  cache: ResponseCache,
  cacheId: string,
  offset?: number,
): string {
  const entry = cache.get(cacheId);
  if (!entry) {
    return `Error: cache_id "${cacheId}" not found — it may have been evicted. Re-run the original tool call to get fresh results.`;
  }

  const startOffset = offset ?? entry.cursor;
  if (startOffset >= entry.fullText.length) {
    return `No more content — offset ${startOffset} is at or past the end (${entry.fullText.length} chars total).`;
  }

  const rawEnd = startOffset + entry.budget;
  const lineEnd = truncateAtLineBoundary(entry.fullText, rawEnd);
  const effectiveEnd = rawEnd >= entry.fullText.length
    ? entry.fullText.length
    : (lineEnd > startOffset ? lineEnd : rawEnd);
  const chunk = entry.fullText.slice(startOffset, effectiveEnd);
  const remaining = entry.fullText.length - effectiveEnd;

  // Advance cursor so next call without offset auto-continues
  entry.cursor = effectiveEnd;

  if (remaining <= 0) {
    return chunk;
  }

  return chunk +
    `\n… [truncated — ${remaining} chars remaining, use read_more(cache_id="${cacheId}") to continue]`;
}

/** Tool definition for the read_more pagination tool. */
export function buildReadMoreToolDefinition(): ToolDefinition {
  return {
    name: "read_more",
    description:
      "Retrieve the next chunk of a truncated tool response. Use the cache_id from the truncation marker.",
    parameters: {
      cache_id: {
        type: "string",
        description: "Cache ID from the truncation marker",
        required: true,
      },
      offset: {
        type: "number",
        description:
          "Character offset to read from. Defaults to where the previous chunk left off.",
        required: false,
      },
    },
  };
}

/** @deprecated Use buildReadMoreToolDefinition instead */
export const getReadMoreToolDefinition = buildReadMoreToolDefinition;
