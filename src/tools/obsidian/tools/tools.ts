/**
 * Obsidian tool executor — LLM-callable operations for vault interaction.
 *
 * Implements the 6 obsidian tool handlers with classification enforcement:
 * - Reads: verify canFlowTo(noteClassification, sessionTaint)
 * - Writes: verify canFlowTo(sessionTaint, folderClassification) — prevent write-down
 *
 * Types, tool definitions, and system prompt live in `tools_defs.ts`.
 * Read and write handlers live in `tools_read_write.ts`.
 *
 * @module
 */

import { canFlowTo } from "../../../core/types/classification.ts";
import { resolveClassificationForPath } from "../vault.ts";

import type { ObsidianToolContext } from "./tools_defs.ts";
import { resolveNotePath } from "./tools_read_write.ts";
import { readObsidianNote, writeObsidianNote } from "./tools_read_write.ts";

// ─── Executor ────────────────────────────────────────────────────────────────

/**
 * Create a tool executor for obsidian operations.
 *
 * Returns a handler that accepts tool name + args and returns a result string,
 * or null if the tool name is not an obsidian tool.
 */
export function createObsidianToolExecutor(
  ctx: ObsidianToolContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (name) {
      case "obsidian_read":
        return readObsidianNote(ctx, input);

      case "obsidian_write":
        return writeObsidianNote(ctx, input);

      case "obsidian_search": {
        const query = input.query;
        if (typeof query !== "string" || query.length === 0) {
          return "Error: obsidian_search requires a 'query' argument (non-empty string).";
        }

        const folder = typeof input.folder === "string"
          ? input.folder
          : undefined;
        const tags = Array.isArray(input.tags)
          ? input.tags.filter((t): t is string => typeof t === "string")
          : undefined;
        const maxResults = typeof input.max_results === "number"
          ? input.max_results
          : undefined;

        const result = await ctx.noteStore.search({
          query,
          folder,
          tags,
          maxResults,
        });
        if (!result.ok) return `Error: ${result.error}`;

        // Filter by classification
        const filtered = result.value.filter((note) => {
          const noteClass = resolveClassificationForPath(
            ctx.vaultContext,
            note.path,
          );
          return canFlowTo(noteClass, ctx.getSessionTaint());
        });

        return JSON.stringify({
          results: filtered.map((note) => ({
            path: note.path,
            name: note.name,
            tags: note.tags,
            headings: note.headings,
          })),
          total: filtered.length,
          query,
        });
      }

      case "obsidian_list": {
        const folder = typeof input.folder === "string"
          ? input.folder
          : undefined;
        const tags = Array.isArray(input.tags)
          ? input.tags.filter((t): t is string => typeof t === "string")
          : undefined;
        const sortBy = typeof input.sort_by === "string"
          ? input.sort_by as "name" | "modified" | "created"
          : undefined;
        const maxResults = typeof input.max_results === "number"
          ? input.max_results
          : undefined;

        const result = await ctx.noteStore.list({
          folder,
          tags,
          sortBy,
          maxResults,
        });
        if (!result.ok) return `Error: ${result.error}`;

        // Filter by classification
        const filtered = result.value.filter((note) => {
          const noteClass = resolveClassificationForPath(
            ctx.vaultContext,
            note.path,
          );
          return canFlowTo(noteClass, ctx.getSessionTaint());
        });

        return JSON.stringify({
          notes: filtered.map((note) => ({
            path: note.path,
            name: note.name,
            tags: note.tags,
          })),
          total: filtered.length,
        });
      }

      case "obsidian_daily": {
        const date = typeof input.date === "string" ? input.date : undefined;
        const template = typeof input.template === "string"
          ? input.template
          : undefined;

        const result = await ctx.dailyNoteManager.getOrCreate(date, template);
        if (!result.ok) return `Error: ${result.error}`;

        return JSON.stringify({
          path: result.value.path,
          name: result.value.name,
          content: result.value.content,
          frontmatter: result.value.frontmatter,
          tags: result.value.tags,
        });
      }

      case "obsidian_links": {
        const noteName = input.note;
        if (typeof noteName !== "string" || noteName.length === 0) {
          return "Error: obsidian_links requires a 'note' argument (non-empty string).";
        }

        const direction = typeof input.direction === "string"
          ? input.direction
          : "backlinks";

        if (direction === "resolve") {
          const resolved = await ctx.linkResolver.resolveWikilink(noteName);
          if (!resolved.ok) return `Error: ${resolved.error}`;
          return JSON.stringify(resolved.value);
        }

        if (direction === "outlinks") {
          const notePath = resolveNotePath(noteName);
          const outlinks = await ctx.linkResolver.getOutlinks(notePath);
          if (!outlinks.ok) return `Error: ${outlinks.error}`;
          return JSON.stringify({ outlinks: outlinks.value });
        }

        // Default: backlinks
        const backlinks = await ctx.linkResolver.getBacklinks(noteName);
        if (!backlinks.ok) return `Error: ${backlinks.error}`;
        return JSON.stringify({ backlinks: backlinks.value });
      }

      default:
        return null;
    }
  };
}
