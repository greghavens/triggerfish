/**
 * Memory tool executor — classification-gated execution of memory operations.
 *
 * Provides the executor factory that wires memory tool invocations to the
 * underlying MemoryStore and MemorySearchProvider. Classification is always
 * forced to session taint — the LLM cannot choose what level a memory is
 * stored at.
 *
 * Query operations live in tools_executor_query.ts.
 * Write operations live in tools_executor_write.ts.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { LineageStore } from "../../../core/session/lineage_types.ts";
import type { MemoryStore } from "../store.ts";
import type { MemorySearchProvider } from "../search/mod.ts";

export {
  executeMemoryDelete,
  executeMemoryGet,
  executeMemoryList,
  executeMemorySearch,
  formatListResults,
  formatSearchResults,
} from "./tools_executor_query.ts";

export {
  executeMemorySave,
  recordReadLineage,
  recordSaveLineage,
} from "./tools_executor_write.ts";

import {
  executeMemoryDelete,
  executeMemoryGet,
  executeMemoryList,
  executeMemorySearch,
} from "./tools_executor_query.ts";

import { executeMemorySave } from "./tools_executor_write.ts";

/** Context required by the memory tool executor. */
export interface MemoryToolContext {
  readonly store: MemoryStore;
  readonly searchProvider?: MemorySearchProvider;
  readonly agentId: string;
  readonly sessionTaint: ClassificationLevel;
  readonly sourceSessionId: SessionId;
  readonly lineageStore?: LineageStore;
}

// ─── Dispatch Table ────────────────────────────────────────────────────────────

type MemoryExecutorFn = (
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
) => Promise<string>;

const MEMORY_EXECUTORS: Readonly<Record<string, MemoryExecutorFn>> = {
  memory_save: executeMemorySave,
  memory_get: executeMemoryGet,
  memory_search: executeMemorySearch,
  memory_list: executeMemoryList,
  memory_delete: executeMemoryDelete,
};

/**
 * Create a tool executor for memory operations.
 *
 * Returns a handler that accepts tool name + args and returns a result string,
 * or null if the tool name is not a memory tool (so callers can fall through).
 */
export function createMemoryToolExecutor(
  ctx: MemoryToolContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  // deno-lint-ignore require-await
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    const executor = MEMORY_EXECUTORS[name];
    if (!executor) return null;
    return executor(ctx, input);
  };
}
