/**
 * Cross-session memory system — classification-gated persistent recall.
 *
 * @module
 */

export type { MemoryError, MemoryRecord, StoredMemoryRecord } from "./types.ts";

export type {
  MemorySearchOptions,
  MemorySearchProvider,
  MemorySearchResult,
} from "./search/mod.ts";

export {
  createFts5SearchProvider,
  createInMemorySearchProvider,
  deserialiseRecord,
  serialiseRecord,
} from "./search/mod.ts";

export type {
  CreateMemoryStoreOptions,
  MemoryDeleteOptions,
  MemoryGetOptions,
  MemoryListOptions,
  MemoryPurgeOptions,
  MemorySaveOptions,
  MemoryStore,
} from "./store.ts";

export { createMemoryStore } from "./store.ts";

export type { MemoryToolContext } from "./tools/mod.ts";

export {
  buildMemoryToolDefinitions,
  getMemoryToolDefinitions,
  MEMORY_SYSTEM_PROMPT,
} from "./tools/mod.ts";

export { createMemoryToolExecutor } from "./tools/mod.ts";

export { loadPersonaContext, MAX_PERSONA_CHARS } from "./persona.ts";
export type { PersonaContextOptions } from "./persona.ts";
