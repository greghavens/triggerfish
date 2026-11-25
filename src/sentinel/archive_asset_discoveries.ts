/** Case-local copies of cited inventory approvals and the evidence that supported them. */
import { dirname, join } from "@std/path";
import { openSentinelAdaptiveStore } from "./adaptive_store.ts";
import { verifySentinelAssetDiscovery } from "./asset_discovery_evidence.ts";
import {
  openSentinelAssetDiscoveryStore,
  type SentinelAssetDiscoveryRecord,
} from "./asset_discovery_store.ts";
import {
  readSentinelAssessmentRevision,
  type SentinelReviewStep,
} from "./assessment_store.ts";
import { resolveSentinelCasePath } from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import { verifiedSharedAssetDiscovery } from "./provenance.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";
import { assertOperatorSourceSnapshotInfo } from "./source_snapshot_lock.ts";

export const sentinelArchivedDiscoveriesFile = "case-discovery-approvals.json";
const maxBytes = 16 * 1024 * 1024;
type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Entry = { record: SentinelAssetDiscoveryRecord; snapshot: Snapshot };

export function discoveryApproval(
  store: ReturnType<typeof openSentinelAssetDiscoveryStore>,
  id: string,
  version?: number,
) {
  const record = store.get(id);
  const event = record &&
    store.history(id).find((item) =>
      item.status === "approved" &&
      (version === undefined || item.version === version)
    );
  return record && event
    ? {
      ...record,
      status: event.status,
      version: event.version,
      updatedAt: event.at,
    }
    : undefined;
}

function workspaceDiscoveryEvidence(
  baseDir: string,
  store: ReturnType<typeof openSentinelAssetDiscoveryStore>,
  id: string,
  version?: number,
): Entry | undefined {
  const record = discoveryApproval(store, id, version);
  if (!record) return;
  const snapshot = readSentinelAssessmentRevision(
    resolveSentinelCasePath(baseDir, record.sourceCaseId),
    record.evidenceRevision,
  )?.result.sharedGraph.snapshot;
  if (
    snapshot && digestSentinelSnapshot(snapshot) === record.sourceDigest &&
    verifySentinelAssetDiscovery(loadSentinelGraph(snapshot), record.claim)
  ) return { record, snapshot };
}

function readBundle(path: string) {
  const result = new Map<string, Entry>();
  try {
    const named = Deno.lstatSync(path);
    assertOperatorSourceSnapshotInfo(named);
    using file = Deno.openSync(path);
    const info = file.statSync();
    assertOperatorSourceSnapshotInfo(info);
    if (
      info.dev !== named.dev || info.ino !== named.ino ||
      ((info.mode ?? 0) & 0o077) || info.size > maxBytes
    ) {
      throw new Error("Invalid discovery archive size or permissions");
    }
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = file.readSync(bytes.subarray(offset));
      if (!count) throw new Error("Truncated discovery archive");
      offset += count;
    }
    const entries: Entry[] = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!Array.isArray(entries)) throw new Error("Invalid discovery archive");
    for (const entry of entries) {
      const { record, snapshot } = entry;
      const graph = loadSentinelGraph(snapshot);
      if (
        record.status !== "approved" || result.has(record.id) ||
        digestSentinelSnapshot(graph.snapshot()) !== record.sourceDigest ||
        !verifySentinelAssetDiscovery(graph, record.claim)
      ) throw new Error("Invalid archived discovery source");
      result.set(record.id, { record, snapshot: graph.snapshot() });
    }
    return result;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return result;
    throw error;
  }
}

export function readArchivedDiscoveryApprovals(path: string) {
  return readBundle(join(dirname(path), sentinelArchivedDiscoveriesFile));
}

/** Resolve the historical approval and source snapshot without granting live inventory access. */
export function readHistoricalDiscoveryEvidence(
  baseDir: string,
  path: string,
  id: string,
  version?: number,
): Entry | undefined {
  const archived = readArchivedDiscoveryApprovals(path).get(id);
  if (archived) return archived;
  try {
    Deno.lstatSync(join(baseDir, "data", "sentinel-asset-discoveries.db"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const store = openSentinelAssetDiscoveryStore(baseDir);
  try {
    return workspaceDiscoveryEvidence(baseDir, store, id, version);
  } finally {
    store.close();
  }
}

function archiveCitations(
  adaptive: string | undefined,
  runId: string,
  revisions: readonly number[],
) {
  if (!adaptive) return [];
  const store = openSentinelAdaptiveStore(adaptive);
  try {
    const citations: SentinelReviewStep[] = [];
    for (const revision of revisions) {
      const mapped = store.forEvidence(revision);
      if (!mapped || mapped.goal.id !== runId) continue;
      for (const { steps } of store.modelReviewNotes(mapped.revision)) {
        citations.push(
          ...steps.filter(({ sharedAssetDiscovery }) => sharedAssetDiscovery),
        );
      }
    }
    return citations;
  } finally {
    store.close();
  }
}

export async function stageArchivedDiscoveryApprovals(
  baseDir: string,
  livePath: string,
  directory: string,
  adaptive: string | undefined,
  scope: { caseId: string; runId: string },
  revisions: readonly number[],
) {
  const citations = archiveCitations(adaptive, scope.runId, revisions);
  if (!citations.length) return;
  const retained = readArchivedDiscoveryApprovals(livePath);
  const entries = new Map<string, Entry>();
  const encoded: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 2;
  let store: ReturnType<typeof openSentinelAssetDiscoveryStore> | undefined;
  try {
    for (const step of citations) {
      const { id, version } = step.sharedAssetDiscovery!;
      const entry = entries.get(id) ?? retained.get(id) ??
        workspaceDiscoveryEvidence(
          baseDir,
          store ??= openSentinelAssetDiscoveryStore(baseDir),
          id,
          version,
        );
      if (
        !entry || !verifiedSharedAssetDiscovery(
          scope.caseId,
          new Map([[id, entry.record]]),
          step,
        )
      ) {
        throw new Error("Archive is missing exact shared discovery evidence");
      }
      if (!entries.has(id)) {
        const item = JSON.stringify(entry);
        bytes += encoder.encode(item).length + (encoded.length ? 1 : 0);
        if (bytes > maxBytes) {
          throw new Error("Archived discovery evidence exceeds its size limit");
        }
        entries.set(id, entry);
        encoded.push(item);
      }
    }
  } finally {
    store?.close();
  }
  const serialized = "[" + encoded.join(",") + "]";
  const sourcePath = join(directory, sentinelArchivedDiscoveriesFile);
  await Deno.writeTextFile(sourcePath, serialized, { mode: 0o600 });
  return { name: sentinelArchivedDiscoveriesFile, sourcePath };
}

export function validateArchivedDiscoveryApprovals(
  path: string | undefined,
  adaptive: string | undefined,
  scope: { caseId: string; runId: string },
  revisions: readonly number[],
) {
  const citations = archiveCitations(adaptive, scope.runId, revisions);
  const entries = path ? readBundle(path) : new Map<string, Entry>();
  const records = new Map([...entries].map(([id, { record }]) => [id, record]));
  const used = new Set<string>();
  for (const step of citations) {
    if (!path && step.sharedAssetDiscovery?.version === undefined) continue;
    const record = verifiedSharedAssetDiscovery(scope.caseId, records, step);
    if (!record) {
      throw new Error("Archive is missing exact shared discovery evidence");
    }
    used.add(record.id);
  }
  if (used.size !== records.size) {
    throw new Error("Archive contains uncited discovery approvals");
  }
}
