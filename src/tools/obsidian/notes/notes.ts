/**
 * Note store — public interface and factory for note CRUD + query operations.
 *
 * Implementation is split across:
 * - {@link ./note_crud.ts} — read, create, update
 * - {@link ./note_query.ts} — search, list
 * - {@link ./note_walker.ts} — vault filesystem traversal
 *
 * @module
 */

import type { Result } from "../../../core/types/classification.ts";
import type {
  NoteCreateOptions,
  NoteListOptions,
  NoteSearchOptions,
  NoteUpdateOptions,
  ObsidianNote,
} from "../types.ts";
import type { VaultContext } from "../vault.ts";
import {
  createNoteInVault,
  persistNoteToVault,
  readNoteFromVault,
} from "./note_crud.ts";
import { listNotesInVault, searchNotesInVault } from "./note_query.ts";

/** Interface for note CRUD operations. */
export interface NoteStore {
  /** Read a note by its vault-relative path. */
  read(path: string): Promise<Result<ObsidianNote, string>>;
  /** Create a new note. */
  create(options: NoteCreateOptions): Promise<Result<ObsidianNote, string>>;
  /** Update an existing note. */
  update(options: NoteUpdateOptions): Promise<Result<ObsidianNote, string>>;
  /** Search notes by content and filename. */
  search(
    options: NoteSearchOptions,
  ): Promise<Result<readonly ObsidianNote[], string>>;
  /** List notes in the vault. */
  list(
    options: NoteListOptions,
  ): Promise<Result<readonly ObsidianNote[], string>>;
}

/**
 * Create a NoteStore for the given vault context.
 */
export function createNoteStore(ctx: VaultContext): NoteStore {
  return {
    read: (path) => readNoteFromVault(ctx, path),
    create: (options) => createNoteInVault(ctx, options),
    update: (options) => persistNoteToVault(ctx, options),
    search: (options) => searchNotesInVault(ctx, options),
    list: (options) => listNotesInVault(ctx, options),
  };
}
