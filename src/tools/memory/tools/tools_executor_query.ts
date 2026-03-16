/**
 * Memory tool query executors — read, search, list, and delete operations.
 *
 * Extracted from tools_executor.ts to keep file sizes manageable.
 * @module
 */

import type { MemoryStore } from "../store.ts";
import type { MemorySearchProvider } from "../search/mod.ts";
import type { MemoryToolContext } from "./tools_executor.ts";
import { recordReadLineage } from "./tools_executor_write.ts";

/** Execute a memory_get operation. */
export async function executeMemoryGet(
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const key = input.key;
  if (typeof key !== "string" || key.length === 0) {
    return "Error: memory_get requires a 'key' argument (non-empty string).";
  }

  const record = await ctx.store.get({
    key,
    agentId: ctx.agentId,
    sessionTaint: ctx.sessionTaint,
  });

  if (record === null) {
    return JSON.stringify({ found: false, key });
  }

  await recordReadLineage(ctx, "memory_get", key, [record]);

  return JSON.stringify({
    found: true,
    key: record.key,
    content: record.content,
    classification: record.classification,
    tags: record.tags,
    updated_at: record.updatedAt.toISOString(),
  });
}

/** Execute a memory_search operation. */
export async function executeMemorySearch(
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query;
  if (typeof query !== "string" || query.length === 0) {
    return "Error: memory_search requires a 'query' argument (non-empty string).";
  }

  const maxResults = typeof input.max_results === "number"
    ? input.max_results
    : 10;

  if (!ctx.searchProvider) {
    return "Error: Search is not available (no search provider configured).";
  }

  const results = await ctx.searchProvider.search({
    agentId: ctx.agentId,
    query,
    sessionTaint: ctx.sessionTaint,
    maxResults,
  });

  if (results.length === 0) {
    return JSON.stringify({ results: [], query });
  }

  await recordReadLineage(
    ctx,
    "memory_search",
    query,
    results.map((r) => r.record),
  );

  return formatSearchResults(results, query);
}

/** Format search results into a JSON string. */
export function formatSearchResults(
  results: Awaited<ReturnType<MemorySearchProvider["search"]>>,
  query: string,
): string {
  return JSON.stringify({
    results: results.map((r) => ({
      key: r.record.key,
      content: r.record.content,
      classification: r.record.classification,
      tags: r.record.tags,
    })),
    query,
  });
}

/** Execute a memory_list operation. */
export async function executeMemoryList(
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const tag = typeof input.tag === "string" ? input.tag : undefined;

  const records = await ctx.store.list({
    agentId: ctx.agentId,
    sessionTaint: ctx.sessionTaint,
    tag,
  });

  if (records.length === 0) {
    return "No memories found.";
  }

  return formatListResults(records);
}

/** Format list results into a JSON string. */
export function formatListResults(
  records: Awaited<ReturnType<MemoryStore["list"]>>,
): string {
  return JSON.stringify({
    memories: records.map((r) => ({
      key: r.key,
      content: r.content,
      classification: r.classification,
      tags: r.tags,
      updated_at: r.updatedAt.toISOString(),
    })),
  });
}

/** Execute a memory_delete operation. */
export async function executeMemoryDelete(
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const key = input.key;
  if (typeof key !== "string" || key.length === 0) {
    return "Error: memory_delete requires a 'key' argument (non-empty string).";
  }

  const result = await ctx.store.delete({
    key,
    agentId: ctx.agentId,
    sessionTaint: ctx.sessionTaint,
    sourceSessionId: ctx.sourceSessionId,
  });

  if (!result.ok) {
    return `Error: ${result.error.message}`;
  }

  return JSON.stringify({ deleted: true, key });
}
