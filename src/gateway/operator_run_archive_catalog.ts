/** Exact, classified archive receipt discovery without reopening archive artifacts. */

import { createHash } from "node:crypto";
import { join } from "@std/path";
import {
  openRunArchiveActions,
  type RunArchiveActionRecord,
} from "../core/run_archive_actions.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function metadata(record: RunArchiveActionRecord) {
  const { archiveId, identity, status, createdAt, updatedAt } = record;
  return { archiveId, identity, status, createdAt, updatedAt };
}

export async function executeOperatorArchiveCatalog(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
) {
  const { query = "", archiveStatus, archiveId, cursor, limit = 10 } = args;
  if (
    typeof query !== "string" || query.length > 128 ||
    !/^[a-z\d_.:-]*$/i.test(query.trim()) ||
    (archiveStatus !== undefined && archiveStatus !== "pending" &&
      archiveStatus !== "succeeded" && archiveStatus !== "failed") ||
    (archiveId !== undefined &&
      (typeof archiveId !== "string" || !uuid.test(archiveId))) ||
    (cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length > 70)) ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
    limit > 20 ||
    Object.keys(args).some((key) =>
      !["action", "query", "archiveStatus", "archiveId", "cursor", "limit"]
        .includes(key)
    )
  ) return;
  const literal = query.trim().toLowerCase();
  const id = archiveId?.toLowerCase();
  const scope = createHash("sha256").update(
    JSON.stringify([literal, archiveStatus ?? null, id ?? null, limit]),
  ).digest("hex").slice(0, 32);
  const authorizeReceipt = (record: RunArchiveActionRecord) =>
    authorize({ action: "archive_history", ...record.identity });
  const directory = join(baseDir, "data", "run-archives");
  if (!await authorize(args)) return;
  try {
    const stat = await Deno.lstat(directory);
    if (
      !stat.isDirectory || stat.isSymlink || ((stat.mode ?? 0) & 0o077) !== 0
    ) {
      return;
    }
    await Deno.lstat(join(directory, "actions.db"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && cursor === undefined) {
      return { archives: [], nextCursor: null };
    }
    return;
  }

  const journal = openRunArchiveActions(join(directory, "actions.db"));
  try {
    let before: number | undefined;
    if (cursor !== undefined) {
      const [prefix, anchor] = cursor.split(":");
      if (
        prefix !== scope || !anchor || !uuid.test(anchor) ||
        cursor !== `${scope}:${anchor}`
      ) return;
      const item = journal.listSentinelArchiveCatalog(
        literal,
        archiveStatus,
        anchor,
      )[0];
      if (
        !item || (id && anchor !== id) || !await authorizeReceipt(item.record)
      ) {
        return;
      }
      before = item.sequence;
    }
    const archives: ReturnType<typeof metadata>[] = [];
    const finish = async (nextCursor: string | null) =>
      await authorize(args) ? { archives, nextCursor } : undefined;
    while (await authorize(args)) {
      const page = journal.listSentinelArchiveCatalog(
        literal,
        archiveStatus,
        id,
        before,
      );
      for (const { record, sequence } of page) {
        before = sequence;
        if (!await authorizeReceipt(record)) continue;
        if (archives.length === limit) {
          return await finish(`${scope}:${archives.at(-1)!.archiveId}`);
        }
        archives.push(metadata(record));
      }
      if (page.length < 32) return await finish(null);
    }
  } finally {
    journal.close();
  }
}
