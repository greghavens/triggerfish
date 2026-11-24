/** Report source archive references without modifying archived evidence. */
import { dirname, join } from "@std/path";
import { readSentinelSourceSnapshotReferences } from "./assessment_store.ts";
import { readAdaptiveSourceSnapshotReferences } from "./adaptive_store.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { readSentinelChatSnapshot } from "./chat_mode.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  readArchivedSentinelSnapshot,
  readSentinelSourceSnapshotFile,
  sentinelSourceSnapshotDirectory,
  sentinelSourceSnapshotPath,
} from "./shared_inventory.ts";
import { sentinelSharedTopologyPath } from "./paths.ts";

import { withSentinelSourceSnapshotLock } from "./source_snapshot_lock.ts";

const DIGEST = /^[0-9a-f]{64}$/;

export function auditSentinelSourceSnapshots(baseDir: string) {
  return withSentinelSourceSnapshotLock(
    baseDir,
    false,
    () => scanArchives(baseDir),
  );
}

async function scanArchives(baseDir: string) {
  const references = new Set<string>();
  const unavailableCases: string[] = [];
  const unreadableSnapshots: string[] = [];
  function addReference(caseId: unknown, digest: unknown) {
    if (
      isSentinelCaseId(caseId) && typeof digest === "string" &&
      DIGEST.test(digest)
    ) {
      references.add(`${caseId}/${digest}`);
    }
  }

  function scanGraph(
    graph: ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>,
  ) {
    for (const node of graph.nodes) {
      if (node.kind !== "evidence") continue;
      for (const source of node.relationshipSources ?? []) {
        addReference(source.caseId, source.snapshotDigest);
      }
    }
  }

  for (const caseId of ["main", ...listSentinelCaseIds(baseDir)]) {
    try {
      const path = resolveSentinelCasePath(baseDir, caseId);
      for (
        const source of [
          ...readSentinelSourceSnapshotReferences(path),
          ...readAdaptiveSourceSnapshotReferences(
            join(dirname(path), "sentinel-adaptive.db"),
          ),
        ]
      ) {
        addReference(source.caseId, source.digest);
      }
      const published = await readSentinelChatSnapshot(path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      });
      if (published !== undefined) {
        scanGraph(loadSentinelGraph(published).snapshot());
      }
      const overlay = await readSentinelChatSnapshot(
        sentinelSharedTopologyPath(path),
      )
        .catch((error) => {
          if (error instanceof Deno.errors.NotFound) return [];
          throw error;
        });
      if (!Array.isArray(overlay)) throw new Error("Invalid topology overlay");
      for (const link of overlay) {
        for (
          const [sourceCase, digest] of Object.entries(link.sourceDigests ?? {})
        ) {
          addReference(sourceCase, digest);
        }
      }
    } catch {
      unavailableCases.push(caseId);
    }
  }

  const archive = await listSnapshotFiles(baseDir, false);
  const quarantine = await listSnapshotFiles(baseDir, true);
  // Iteration over the set also visits references discovered in archived graphs.
  for (const id of references) {
    if (!archive.has(id) && !quarantine.has(id)) continue;
    const [caseId, digest] = id.split("/");
    try {
      scanGraph(await readArchivedSentinelSnapshot(baseDir, caseId, digest));
    } catch {
      unreadableSnapshots.push(id);
    }
  }
  const missing = [...references].filter((id) =>
    !archive.has(id) && !quarantine.has(id)
  ).sort();
  return {
    archivedCount: archive.size,
    quarantined: [...quarantine].sort(),
    referencedCount: references.size,
    missing,
    unreadableSnapshots: unreadableSnapshots.sort(),
    candidates:
      unavailableCases.length || missing.length || unreadableSnapshots.length
        ? []
        : [...archive].filter((id) => !references.has(id)).sort(),
    unavailableCases,
  };
}

async function listSnapshotFiles(baseDir: string, quarantined: boolean) {
  const root = sentinelSourceSnapshotDirectory(baseDir, quarantined);
  const archive = new Set<string>();
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || !isSentinelCaseId(entry.name)) continue;
      for await (const file of Deno.readDir(join(root, entry.name))) {
        if (!file.isFile || !file.name.endsWith(".json")) continue;
        const digest = file.name.slice(0, -5);
        if (DIGEST.test(digest)) archive.add(`${entry.name}/${digest}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return archive;
}

export function moveSentinelSourceSnapshot(
  baseDir: string,
  id: string,
  restore: boolean,
) {
  return withSentinelSourceSnapshotLock(baseDir, true, async () => {
    const [caseId, digest, extra] = id.split("/");
    if (!digest || extra !== undefined) {
      throw new Error("Invalid Sentinel source snapshot reference");
    }
    const from = sentinelSourceSnapshotPath(baseDir, caseId, digest, restore);
    const to = sentinelSourceSnapshotPath(baseDir, caseId, digest, !restore);
    if (!restore && !(await scanArchives(baseDir)).candidates.includes(id)) {
      throw new Error(
        "This source snapshot is no longer eligible for cleanup.",
      );
    }
    const source = await Deno.lstat(from);
    if (!source.isFile || source.isSymlink || (source.nlink ?? 1) !== 1) {
      throw new Error("The archive entry must be a regular snapshot file.");
    }
    await readSentinelSourceSnapshotFile(from, digest);
    const destination = await Deno.lstat(to).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (destination) {
      throw new Error("The destination already contains this source snapshot.");
    }
    await Deno.mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await Deno.rename(from, to);
    return await scanArchives(baseDir);
  });
}
