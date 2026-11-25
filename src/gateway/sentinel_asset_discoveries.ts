/** Gateway authorization and source verification for shared asset discoveries. */
import { isDeepStrictEqual } from "node:util";
import {
  isSentinelCaseId,
  locateSentinelCase,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  readSentinelAssessmentRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import {
  openSentinelAssetDiscoveryStore,
  type SentinelAssetDiscoveryClaim,
  type SentinelAssetDiscoveryRecord,
} from "../sentinel/asset_discovery_store.ts";
import {
  matchSentinelAssetDiscoveryDestination,
  verifySentinelAssetDiscovery,
} from "../sentinel/asset_discovery_evidence.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";

function discoveryStore<T>(
  baseDir: string,
  operation: (store: ReturnType<typeof openSentinelAssetDiscoveryStore>) => T,
): T {
  const store = openSentinelAssetDiscoveryStore(baseDir);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

export function submitSentinelAssetDiscovery(
  snapshotPath: string,
  assignment: { taskId: string; token: string; evidenceRevision: number },
  claim: SentinelAssetDiscoveryClaim,
): SentinelAssetDiscoveryRecord | undefined {
  const location = locateSentinelCase(snapshotPath);
  if (!location) return;
  return withSentinelAssessmentWriteLock(snapshotPath, (current) => {
    const task = readAssignedSentinelModelReview(
      snapshotPath,
      assignment.evidenceRevision,
      assignment.taskId,
      assignment.token,
    );
    const snapshot = current?.result?.sharedGraph.snapshot;
    if (
      !task || task.nodeId !== claim.assetId || !snapshot ||
      current?.revision !== assignment.evidenceRevision ||
      !verifySentinelAssetDiscovery(loadSentinelGraph(snapshot), claim)
    ) return;
    return discoveryStore(location.baseDir, (store) =>
      store.propose({
        sourceCaseId: location.caseId,
        taskId: assignment.taskId,
        evidenceRevision: assignment.evidenceRevision,
        sourceDigest: digestSentinelSnapshot(snapshot),
        claim,
      }));
  });
}

function archivedDiscovery(
  baseDir: string,
  record: SentinelAssetDiscoveryRecord,
) {
  if (!isSentinelCaseId(record.sourceCaseId)) return;
  const path = resolveSentinelCasePath(baseDir, record.sourceCaseId);
  const snapshot = readSentinelAssessmentRevision(path, record.evidenceRevision)
    ?.result?.sharedGraph.snapshot;
  if (!snapshot || digestSentinelSnapshot(snapshot) !== record.sourceDigest) {
    return;
  }
  const graph = loadSentinelGraph(snapshot);
  if (!verifySentinelAssetDiscovery(graph, record.claim)) return;
  return { path, graph };
}

async function currentDiscovery(
  path: string,
  record: SentinelAssetDiscoveryRecord,
  archived: ReturnType<typeof loadSentinelGraph>,
) {
  try {
    const graph = loadSentinelGraph(await readSentinelChatSnapshot(path));
    const evidenceId = record.claim.evidenceId;
    return verifySentinelAssetDiscovery(graph, record.claim) &&
        isDeepStrictEqual(
          graph.snapshot().nodes.find(({ id }) => id === evidenceId),
          archived.snapshot().nodes.find(({ id }) => id === evidenceId),
        )
      ? graph
      : undefined;
  } catch {
    return undefined;
  }
}

export function listSentinelAssetDiscoveryProposals(
  baseDir: string,
  caseId: string,
) {
  return discoveryStore(baseDir, (store) => {
    const pending = store.list({
      sourceCaseId: caseId,
      status: "pending",
      limit: 30,
    });
    if (pending.length === 30) return pending;
    return [
      ...pending,
      ...store.list({
        sourceCaseId: caseId,
        status: "approved",
        limit: 30 - pending.length,
      }),
    ];
  });
}

export async function decideSentinelAssetDiscovery(
  baseDir: string,
  caseId: string,
  id: string,
  version: number,
  decision: "approve" | "withdraw",
) {
  const record = discoveryStore(baseDir, (store) => store.get(id));
  if (!record || record.sourceCaseId !== caseId || record.version !== version) {
    return;
  }
  if (decision === "withdraw") {
    return discoveryStore(baseDir, (store) => store.withdraw(id, version));
  }
  return await withSentinelSourceSnapshotLock(baseDir, false, async () => {
    const source = archivedDiscovery(baseDir, record);
    if (!source || !await currentDiscovery(source.path, record, source.graph)) {
      return;
    }
    return withSentinelAssessmentWriteLock(source.path, (state) => {
      if (!state?.active || state.revision !== record.evidenceRevision) return;
      return discoveryStore(baseDir, (store) => store.approve(id, version));
    });
  });
}

export async function readSentinelSharedAssetDiscoveries(
  snapshotPath: string,
  assignment: { taskId: string; token: string; evidenceRevision: number },
  exactId?: string,
  signal?: AbortSignal,
) {
  const location = locateSentinelCase(snapshotPath);
  const task = readAssignedSentinelModelReview(
    snapshotPath,
    assignment.evidenceRevision,
    assignment.taskId,
    assignment.token,
  );
  const pinned = readSentinelAssessmentRevision(
    snapshotPath,
    assignment.evidenceRevision,
  )?.result?.sharedGraph.snapshot;
  if (!location || !task?.nodeId || !pinned || signal?.aborted) return [];
  const destination = loadSentinelGraph(pinned);
  const records = discoveryStore(location.baseDir, (store) => {
    if (!exactId) return store.list({ status: "approved", limit: 30 });
    const exact = store.get(exactId);
    return exact?.status === "approved" ? [exact] : [];
  });
  const results: (SentinelAssetDiscoveryRecord & {
    mappedAssetId: string;
    mappedTo?: string;
  })[] = [];
  for (const record of records) {
    if (signal?.aborted) return [];
    if (record.sourceCaseId === location.caseId) continue;
    try {
      const source = archivedDiscovery(location.baseDir, record);
      if (!source) continue;
      const currentSource = await currentDiscovery(
        source.path,
        record,
        source.graph,
      );
      if (!currentSource) continue;
      const match = matchSentinelAssetDiscoveryDestination(
        currentSource,
        destination,
        record.claim,
      );
      if (match?.assetId !== task.nodeId) continue;
      const current = discoveryStore(
        location.baseDir,
        (store) => store.get(record.id),
      );
      if (
        current?.status !== "approved" || current.version !== record.version
      ) continue;
      results.push({
        ...record,
        mappedAssetId: match.assetId,
        ...(match.to && { mappedTo: match.to }),
      });
      if (results.length >= 5) break;
    } catch {
      // An unavailable source cannot authorize a discovery.
    }
  }
  return signal?.aborted ||
      !readAssignedSentinelModelReview(
        snapshotPath,
        assignment.evidenceRevision,
        assignment.taskId,
        assignment.token,
      )
    ? []
    : results;
}
