/**
 * Note query operations — search and list notes with filtering and sorting.
 *
 * All operations walk the vault via {@link walkNotes}, skipping excluded folders.
 *
 * @module
 */

import type { Result } from "../../../core/types/classification.ts";
import type {
  NoteListOptions,
  NoteSearchOptions,
  ObsidianNote,
} from "../types.ts";
import type { VaultContext } from "../vault.ts";
import { resolveVaultPath } from "../vault.ts";
import { walkNotes } from "./note_walker.ts";

/** Confine an optional folder option to the vault, rejecting escapes. */
async function confineFolderToVault(
  ctx: VaultContext,
  folder: string | undefined,
): Promise<Result<void, string>> {
  if (folder === undefined) return { ok: true, value: undefined };
  const resolved = await resolveVaultPath(ctx, folder);
  if (!resolved.ok) return resolved;
  return { ok: true, value: undefined };
}

/** Check if a note matches all required tags. */
function noteMatchesTags(
  note: ObsidianNote,
  tags: readonly string[] | undefined,
): boolean {
  if (!tags || tags.length === 0) return true;
  return tags.every((t) => note.tags.includes(t));
}

/** Check if a note matches search query by content or name. */
function noteMatchesQuery(note: ObsidianNote, queryLower: string): boolean {
  const contentLower = note.content.toLowerCase();
  const nameLower = note.name.toLowerCase();
  return contentLower.includes(queryLower) || nameLower.includes(queryLower);
}

/** Sort notes by the specified field (mutates array in place). */
function sortNotesByField(
  notes: ObsidianNote[],
  sortBy: string,
): void {
  notes.sort((a, b) => {
    switch (sortBy) {
      case "modified":
        return b.modifiedAt.getTime() - a.modifiedAt.getTime();
      case "created":
        return b.createdAt.getTime() - a.createdAt.getTime();
      case "name":
      default:
        return a.name.localeCompare(b.name);
    }
  });
}

/** Search notes in the vault by content and filename. */
export async function searchNotesInVault(
  ctx: VaultContext,
  options: NoteSearchOptions,
): Promise<Result<readonly ObsidianNote[], string>> {
  const confined = await confineFolderToVault(ctx, options.folder);
  if (!confined.ok) return confined;

  const maxResults = options.maxResults ?? 20;
  const queryLower = options.query.toLowerCase();
  const results: ObsidianNote[] = [];
  try {
    for await (const note of walkNotes(ctx, options.folder)) {
      if (!noteMatchesTags(note, options.tags)) continue;
      if (!noteMatchesQuery(note, queryLower)) continue;
      results.push(note);
      if (results.length >= maxResults) break;
    }
    return { ok: true, value: results };
  } catch (err) {
    return {
      ok: false,
      error: `Search failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** List notes in the vault with optional filtering and sorting. */
export async function listNotesInVault(
  ctx: VaultContext,
  options: NoteListOptions,
): Promise<Result<readonly ObsidianNote[], string>> {
  const confined = await confineFolderToVault(ctx, options.folder);
  if (!confined.ok) return confined;

  const maxResults = options.maxResults ?? 100;
  const notes: ObsidianNote[] = [];
  try {
    for await (const note of walkNotes(ctx, options.folder)) {
      if (!noteMatchesTags(note, options.tags)) continue;
      notes.push(note);
    }
    sortNotesByField(notes, options.sortBy ?? "name");
    return { ok: true, value: notes.slice(0, maxResults) };
  } catch (err) {
    return {
      ok: false,
      error: `List failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
