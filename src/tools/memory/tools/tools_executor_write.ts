/**
 * Memory tool write executors — save and lineage recording operations.
 *
 * Extracted from tools_executor.ts to keep file sizes manageable.
 * @module
 */

import type { MemoryRecord } from "../types.ts";
import type { MemoryToolContext } from "./tools_executor.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("memory-lineage");

/** Record a lineage entry for a memory write operation. Returns the lineage_id or undefined. */
export async function recordSaveLineage(
  ctx: MemoryToolContext,
  key: string,
  content: string,
): Promise<string | undefined> {
  if (!ctx.lineageStore) return undefined;
  try {
    const record = await ctx.lineageStore.create({
      content,
      origin: {
        source_type: "memory_access",
        source_name: key,
        accessed_at: new Date().toISOString(),
        accessed_by: ctx.agentId,
        access_method: "memory_save",
      },
      classification: {
        level: ctx.sessionTaint,
        reason: `Memory save: ${key}`,
      },
      sessionId: ctx.sourceSessionId,
    });
    return record.lineage_id;
  } catch (err) {
    log.error("Lineage record creation failed for memory_save", {
      operation: "recordSaveLineage",
      err,
    });
    return undefined;
  }
}

/** Record a lineage entry for a memory read operation. */
export async function recordReadLineage(
  ctx: MemoryToolContext,
  accessMethod: string,
  key: string,
  records: readonly MemoryRecord[],
): Promise<void> {
  if (!ctx.lineageStore) return;
  const inputLineageIds = records
    .map((r) => r.lineageId)
    .filter((id): id is string => id !== undefined);
  try {
    await ctx.lineageStore.create({
      content: key,
      origin: {
        source_type: "memory_access",
        source_name: key,
        accessed_at: new Date().toISOString(),
        accessed_by: ctx.agentId,
        access_method: accessMethod,
      },
      classification: {
        level: ctx.sessionTaint,
        reason: `Memory read: ${key}`,
      },
      sessionId: ctx.sourceSessionId,
      ...(inputLineageIds.length > 0 ? { inputLineageIds } : {}),
    });
  } catch (err) {
    log.error("Lineage record creation failed for memory read", {
      operation: "recordReadLineage",
      err,
    });
  }
}

/** Execute a memory_save operation. */
export async function executeMemorySave(
  ctx: MemoryToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const key = input.key;
  const content = input.content;
  if (typeof key !== "string" || key.length === 0) {
    return "Error: memory_save requires a 'key' argument (non-empty string).";
  }
  if (typeof content !== "string" || content.length === 0) {
    return "Error: memory_save requires a 'content' argument (non-empty string).";
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.filter((t): t is string => typeof t === "string")
    : [];

  const lineageId = await recordSaveLineage(ctx, key, content);

  const result = await ctx.store.save({
    key,
    agentId: ctx.agentId,
    sessionTaint: ctx.sessionTaint,
    content,
    tags,
    sourceSessionId: ctx.sourceSessionId,
    ...(lineageId !== undefined ? { lineageId } : {}),
  });

  if (!result.ok) {
    return `Error: ${result.error.message}`;
  }

  return JSON.stringify({
    saved: true,
    key: result.value.key,
    classification: result.value.classification,
  });
}
