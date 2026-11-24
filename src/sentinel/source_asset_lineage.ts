/** Enumerate verified publications of one exact, case-scoped source asset. */

import { join } from "@std/path";
import { isSentinelCaseId, resolveSentinelCasePath } from "./cases.ts";
import { readSentinelChatSnapshot } from "./chat_mode.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  digestSentinelSnapshot,
  readSentinelSourceSnapshotFile,
  sentinelSourceSnapshotDirectory,
  sentinelSourceSnapshotPath,
} from "./shared_inventory.ts";
import {
  assertOperatorSourceSnapshot,
  operatorSourceDirectoryExists,
  withSentinelSourceSnapshotLock,
} from "./source_snapshot_lock.ts";

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_READS_PER_PAGE = 40;
const MAX_PAGE = 20;

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Asset = Extract<Snapshot["nodes"][number], { kind: "asset" }>;

interface SourceAssetVersion {
  readonly snapshotDigest: string;
  readonly storage: "archive" | "quarantine" | "published";
  readonly currentPublication: boolean;
  readonly asset: Pick<Asset, "id" | "label" | "assetType">;
}

export interface SentinelSourceAssetLineageOptions {
  readonly after?: string;
  readonly limit?: number;
}

async function listArchivedDigests(
  baseDir: string,
  caseId: string,
  quarantined: boolean,
): Promise<string[]> {
  const root = sentinelSourceSnapshotDirectory(baseDir, quarantined);
  const path = join(root, caseId);
  if (
    !await operatorSourceDirectoryExists(root) ||
    !await operatorSourceDirectoryExists(path)
  ) {
    return [];
  }
  const digests = [];
  let scanned = 0;
  for await (const entry of Deno.readDir(path)) {
    if (++scanned > MAX_ARCHIVE_ENTRIES) {
      throw new Error(
        "Sentinel source case archive exceeds the lineage scan limit",
      );
    }
    if (!entry.isFile || entry.isSymlink || !entry.name.endsWith(".json")) {
      continue;
    }
    const digest = entry.name.slice(0, -5);
    if (DIGEST.test(digest)) digests.push(digest);
  }
  return digests;
}

type Publication =
  | {
    readonly status: "published";
    readonly graph: Snapshot;
    readonly digest: string;
  }
  | { readonly status: "not_published" | "unavailable" };

async function readPublication(
  baseDir: string,
  caseId: string,
): Promise<Publication> {
  try {
    const path = resolveSentinelCasePath(baseDir, caseId);
    await assertOperatorSourceSnapshot(path);
    const graph = loadSentinelGraph(await readSentinelChatSnapshot(path))
      .snapshot();
    return {
      status: "published",
      graph,
      digest: digestSentinelSnapshot(graph),
    };
  } catch (error) {
    return {
      status: error instanceof Deno.errors.NotFound
        ? "not_published"
        : "unavailable",
    };
  }
}

/**
 * Enumerate lexically by digest. The cursor advances over checked snapshots
 * even when they are unreadable or do not contain the exact asset.
 */
export async function readSentinelSourceAssetLineage(
  baseDir: string,
  caseId: string,
  assetId: string,
  options: SentinelSourceAssetLineageOptions = {},
) {
  const { after, limit = 10 } = options;
  if (
    !isSentinelCaseId(caseId) || typeof assetId !== "string" ||
    !assetId.trim() || assetId.length > 4096 ||
    (after !== undefined &&
      (typeof after !== "string" || !DIGEST.test(after))) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
  ) {
    throw new Error("Invalid Sentinel source asset or lineage page");
  }

  // Keep a page stable against concurrent archive publication/quarantine.
  // The current publication is read once and treated as a separate source.
  await operatorSourceDirectoryExists(join(baseDir, "data"));
  return await withSentinelSourceSnapshotLock(baseDir, false, async () => {
    const archived = await listArchivedDigests(baseDir, caseId, false);
    const quarantined = await listArchivedDigests(baseDir, caseId, true);
    const publication = await readPublication(baseDir, caseId);
    const locations = new Map<string, SourceAssetVersion["storage"]>();
    if (publication.status === "published") {
      locations.set(publication.digest, "published");
    }
    for (const digest of quarantined) locations.set(digest, "quarantine");
    for (const digest of archived) locations.set(digest, "archive");
    const digests = [...locations.keys()].filter((digest) =>
      after === undefined || digest > after
    ).sort();

    const versions: SourceAssetVersion[] = [];
    let unavailableArchiveCount = 0;
    let scanned = 0;
    while (
      scanned < MAX_READS_PER_PAGE && scanned < digests.length &&
      versions.length < limit
    ) {
      const snapshotDigest = digests[scanned++];
      const storage = locations.get(snapshotDigest)!;
      const currentPublication = publication.status === "published" &&
        snapshotDigest === publication.digest;
      let graph: Snapshot;
      if (storage === "published" && publication.status === "published") {
        graph = publication.graph;
      } else {
        const path = sentinelSourceSnapshotPath(
          baseDir,
          caseId,
          snapshotDigest,
          storage === "quarantine",
        );
        try {
          graph = await readSentinelSourceSnapshotFile(path, snapshotDigest);
        } catch {
          unavailableArchiveCount++;
          continue;
        }
      }

      const asset = graph.nodes.find((node): node is Asset =>
        node.kind === "asset" && node.id === assetId
      );
      if (!asset) continue;
      versions.push({
        snapshotDigest,
        storage,
        currentPublication,
        asset: {
          id: asset.id,
          label: asset.label.slice(0, 256),
          ...(asset.assetType && { assetType: asset.assetType }),
        },
      });
    }

    return {
      version: 1 as const,
      caseId,
      assetId,
      versions,
      publicationStatus: publication.status,
      unavailableArchiveCount,
      nextAfter: scanned < digests.length ? digests[scanned - 1] : null,
    };
  });
}
