/**
 * Obsidian vault integration — filesystem-based note access with classification gating.
 *
 * @module
 */

export type {
  Backlink,
  DailyNoteOptions,
  DailyNotesConfig,
  Heading,
  NoteCreateOptions,
  NoteListOptions,
  NoteSearchOptions,
  NoteUpdateOptions,
  ObsidianNote,
  ObsidianVaultConfig,
  WikilinkTarget,
} from "./types.ts";

export type { VaultContext } from "./vault.ts";
export {
  createVaultContext,
  getClassificationForPath,
  isExcluded,
  resolveClassificationForPath,
  resolveVaultPath,
} from "./vault.ts";

export {
  buildNote,
  extractHeadings,
  extractTags,
  extractWikilinks,
  mergeFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
} from "./markdown.ts";
export type { FrontmatterResult } from "./markdown.ts";

export type { NoteStore } from "./notes/mod.ts";
export { createNoteStore } from "./notes/mod.ts";

export type { DailyNoteManager } from "./daily.ts";
export { createDailyNoteManager } from "./daily.ts";

export type { LinkResolver } from "./links.ts";
export { createLinkResolver } from "./links.ts";

export type { ObsidianToolContext } from "./tools/mod.ts";
export {
  buildObsidianToolDefinitions,
  createObsidianToolExecutor,
  getObsidianToolDefinitions,
  OBSIDIAN_SYSTEM_PROMPT,
} from "./tools/mod.ts";
