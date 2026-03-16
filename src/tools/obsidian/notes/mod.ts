/**
 * Note store — CRUD, query, and vault traversal for Obsidian notes.
 *
 * @module
 */

export type { NoteStore } from "./notes.ts";
export { createNoteStore } from "./notes.ts";

export {
  applyNoteContentUpdates,
  createNoteInVault,
  ensureMdExtension,
  persistNoteToVault,
  readNoteFromVault,
  updateNoteInVault,
} from "./note_crud.ts";

export { listNotesInVault, searchNotesInVault } from "./note_query.ts";

export { walkNotes } from "./note_walker.ts";
