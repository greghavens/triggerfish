/** Gateway authorization and source verification for shared asset discoveries. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isSentinelCaseId,
  locateSentinelCase,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelLinkedSourcesForRevision,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintsForRevision,
  readSentinelRunIdForRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import {
  openSentinelAssetDiscoveryStore,
  type SentinelAssetDiscoveryClaim,
  type SentinelAssetDiscoveryCorrectionRequest,
  type SentinelAssetDiscoveryRecord,
  type SentinelAssetDiscoveryRequest,
} from "../sentinel/asset_discovery_store.ts";
import {
  matchSentinelAssetDiscoveryDestination,
  verifySentinelAssetDiscovery,
} from "../sentinel/asset_discovery_evidence.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { normalizeSentinelWithdrawalHost } from "../sentinel/inventory_host_withdrawal.ts";
import {
  readSentinelCaseGraphFacts,
  readSentinelWorkerGraphFact,
  sentinelGraphFactScopeFilter,
} from "../sentinel/worker_graph_facts.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";

export { normalizeSentinelWithdrawalHost } from "../sentinel/inventory_host_withdrawal.ts";

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
  requestId?: string,
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
      }, requestId));
  });
}

export function proposeSentinelGraphFactDiscovery(
  baseDir: string,
  caseId: string,
  revision: number,
  factId: string,
  evidenceId: string,
  requestId: string,
) {
  const path = resolveSentinelCasePath(baseDir, caseId);
  return withSentinelAssessmentWriteLock(path, (state) => {
    const runId = state?.plan.runId;
    const snapshot = state?.result?.sharedGraph.snapshot;
    if (!state?.active || state.revision !== revision || !runId || !snapshot) {
      return;
    }
    const selected = readSentinelCaseGraphFacts(path, {
      caseId,
      runId,
      evidenceRevision: revision,
    }, { id: factId });
    if (!selected || !("fact" in selected)) return;
    const fact = selected.fact;
    const { from, to, relation } = fact.relationship;
    if (
      from !== fact.targetId ||
      (relation !== "depends_on" && relation !== "resolved_to" &&
        relation !== "uses_hostname")
    ) return;
    const graph = loadSentinelGraph(snapshot);
    const claim = verifySentinelAssetDiscovery(graph, {
      kind: "relationship",
      assetId: from,
      to,
      relation,
      evidenceId,
    });
    if (!claim) return;
    const candidate = {
      sourceCaseId: caseId,
      taskId: fact.taskId,
      evidenceRevision: revision,
      sourceDigest: fact.snapshotDigest,
      claim,
      graphFactSource: {
        id: fact.id,
        runId,
        stepIndex: fact.sourceStepIndex,
        resultSha256: fact.resultSha256,
      },
    };
    if (!allowsDiscoveryGraphFact(path, candidate, graph)) return;
    return discoveryStore(
      baseDir,
      (store) => store.propose(candidate, requestId),
    );
  });
}

function allowsDiscoveryGraphFact(
  path: string,
  record: SentinelAssetDiscoveryRequest,
  graph: ReturnType<typeof loadSentinelGraph>,
) {
  const source = record.graphFactSource;
  if (!source) return true;
  const { claim } = record;
  if (
    claim.kind !== "relationship" ||
    readSentinelRunIdForRevision(path, record.evidenceRevision) !== source.runId
  ) return false;
  const scope = {
    caseId: record.sourceCaseId,
    runId: source.runId,
    evidenceRevision: record.evidenceRevision,
    targetId: claim.assetId,
    taskId: record.taskId,
  };
  const fact = readSentinelWorkerGraphFact(path, scope, source.id);
  const snapshot = graph.snapshot();
  const evidence = snapshot.nodes.find(({ id }) => id === claim.evidenceId);
  const policy = readSentinelOperatingConstraintsForRevision(
    path,
    record.evidenceRevision,
  );
  return !!fact && fact.snapshotDigest === record.sourceDigest &&
    fact.sourceStepIndex === source.stepIndex &&
    fact.resultSha256 === source.resultSha256 &&
    fact.relationship.from === claim.assetId &&
    fact.relationship.to === claim.to &&
    fact.relationship.relation === claim.relation &&
    evidence?.kind === "evidence" && !evidence.executionSource &&
    !evidence.nativeWorkflowSource &&
    sentinelGraphFactScopeFilter(
      snapshot,
      (nodeId) =>
        sentinelOperatingConstraintsAllow(policy?.constraints, {
          kind: "review_evidence",
          nodeId,
        }, snapshot),
    )(fact);
}

function archivedDiscoveryGraph(
  baseDir: string,
  record: Pick<
    SentinelAssetDiscoveryRecord,
    "sourceCaseId" | "evidenceRevision" | "sourceDigest"
  >,
) {
  if (!isSentinelCaseId(record.sourceCaseId)) return;
  const path = resolveSentinelCasePath(baseDir, record.sourceCaseId);
  const snapshot = readSentinelAssessmentRevision(path, record.evidenceRevision)
    ?.result?.sharedGraph.snapshot;
  if (!snapshot || digestSentinelSnapshot(snapshot) !== record.sourceDigest) {
    return;
  }
  return { path, graph: loadSentinelGraph(snapshot) };
}

function archivedDiscovery(
  baseDir: string,
  record: SentinelAssetDiscoveryRecord,
) {
  const source = archivedDiscoveryGraph(baseDir, record);
  return source && verifySentinelAssetDiscovery(source.graph, record.claim) &&
      allowsDiscoveryGraphFact(source.path, record, source.graph)
    ? source
    : undefined;
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

export function previewSentinelAssetDiscoveryWithdrawal(
  baseDir: string,
  sourceCaseId: string,
  rawHost: unknown,
) {
  const host = normalizeSentinelWithdrawalHost(rawHost);
  if (!host || !isSentinelCaseId(sourceCaseId)) return;
  // A full scoped scan is necessary for a complete, non-truncated plan.
  const records = discoveryStore(
    baseDir,
    (store) => store.listApprovedForSource(sourceCaseId),
  );
  if (!records) return;
  const discoveries: { id: string; version: number }[] = [];
  const owners = new Set<string>();
  // Group proofs by archive so the scan needs at most one loaded graph.
  const ordered = [...records].sort((a, b) =>
    a.evidenceRevision - b.evidenceRevision ||
    a.sourceDigest.localeCompare(b.sourceDigest)
  );
  let cached: {
    key: string;
    graph: ReturnType<typeof loadSentinelGraph>;
    assetId?: string;
  } | undefined;
  for (const record of ordered) {
    const key = `${record.evidenceRevision}:${record.sourceDigest}`;
    if (cached?.key !== key) {
      const source = archivedDiscoveryGraph(baseDir, record);
      if (!source) return;
      const assets = source.graph.snapshot().nodes.filter((node) =>
        node.kind === "asset" &&
        [node.id, ...(node.aliases ?? [])].some((id) =>
          normalizeSentinelWithdrawalHost(id) === host
        )
      );
      for (const asset of assets) owners.add(asset.id);
      if (owners.size > 1) return;
      cached = { key, graph: source.graph, assetId: assets[0]?.id };
    }
    if (!verifySentinelAssetDiscovery(cached.graph, record.claim)) return;
    const { assetId } = cached;
    if (
      assetId && (record.claim.assetId === assetId ||
        (record.claim.kind === "relationship" && record.claim.to === assetId))
    ) {
      discoveries.push({ id: record.id, version: record.version });
      if (discoveries.length > 30) return;
    }
  }
  discoveries.sort((a, b) => a.id.localeCompare(b.id));
  const scope = { host, sourceCaseId, discoveries };
  return {
    ...scope,
    previewDigest: createHash("sha256").update(
      JSON.stringify({ version: 1, ...scope }),
    )
      .digest("hex"),
  };
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

/** Confirm the replacement against current source evidence, then apply both versions atomically. */
export async function correctSentinelAssetDiscovery(
  baseDir: string,
  input: SentinelAssetDiscoveryCorrectionRequest,
  review?: {
    readonly revision: number;
    readonly confirm: (message: string) => Promise<boolean>;
  },
) {
  const readSaved = () => {
    const receipt = discoveryStore(
      baseDir,
      (store) => store.readCorrection(input),
    );
    return receipt &&
        (review === undefined ||
          review.revision === receipt.replacement.evidenceRevision)
      ? receipt
      : undefined;
  };
  const saved = readSaved();
  if (saved) return saved;

  const select = async () => {
    const candidates = discoveryStore(
      baseDir,
      (store) => store.previewCorrection(input),
    );
    if (
      !candidates ||
      (review && review.revision !== candidates.replacement.evidenceRevision)
    ) return;
    const source = archivedDiscovery(baseDir, candidates.replacement);
    if (
      !source ||
      !await currentDiscovery(source.path, candidates.replacement, source.graph)
    ) return;
    const state = readSentinelAssessment(source.path);
    if (
      !state?.active ||
      state.revision !== candidates.replacement.evidenceRevision
    ) return;
    return { ...candidates, path: source.path };
  };
  if (review) {
    const candidate = await withSentinelSourceSnapshotLock(
      baseDir,
      false,
      select,
    );
    if (!candidate) return readSaved();
    const preview = (
      { id, version, evidenceRevision, sourceDigest, claim, graphFactSource }:
        SentinelAssetDiscoveryRecord,
    ) => ({
      id,
      version,
      evidenceRevision,
      sourceDigest,
      claim,
      ...(graphFactSource && { graphFactSource }),
    });
    if (
      !await review.confirm(
        `Replace this approved Sentinel discovery in case ${input.sourceCaseId}?
` + JSON.stringify({
            original: preview(candidate.original),
            replacement: preview(candidate.replacement),
          }),
      )
    ) return;
  }
  return await withSentinelSourceSnapshotLock(baseDir, false, async () => {
    const current = await select();
    if (!current) return readSaved();
    return withSentinelAssessmentWriteLock(current.path, (state) => {
      if (
        !state?.active ||
        state.revision !== current.replacement.evidenceRevision
      ) return;
      return discoveryStore(baseDir, (store) => store.correctApproved(input));
    });
  });
}

export async function readSentinelSharedAssetDiscoveries(
  snapshotPath: string,
  assignment: { taskId: string; token: string; evidenceRevision: number },
  exactId?: string,
  signal?: AbortSignal,
  after?: string,
) {
  const location = locateSentinelCase(snapshotPath);
  const task = readAssignedSentinelModelReview(
    snapshotPath,
    assignment.evidenceRevision,
    assignment.taskId,
    assignment.token,
  );
  if (!location || !task?.nodeId) return [];
  const isCurrent = () =>
    !!readAssignedSentinelModelReview(
      snapshotPath,
      assignment.evidenceRevision,
      assignment.taskId,
      assignment.token,
    );
  return await readScopedSentinelSharedAssetDiscoveries(
    snapshotPath,
    assignment.evidenceRevision,
    exactId,
    signal,
    after,
    (asset, mappedTo) => {
      if (asset !== task.nodeId) return false;
      if (mappedTo === undefined) return true;
      const current = readSentinelAssessment(snapshotPath);
      if (
        current?.revision !== assignment.evidenceRevision || !current.plan.runId
      ) return false;
      return sentinelOperatingConstraintsAllow(
        readSentinelOperatingConstraints(snapshotPath, current.plan.runId)
          ?.constraints,
        { kind: "review_evidence", nodeId: mappedTo },
        current.result?.sharedGraph.snapshot,
      );
    },
    isCurrent,
  );
}

export async function readScopedSentinelSharedAssetDiscoveries(
  snapshotPath: string,
  revision: number,
  exactId: string | undefined,
  signal: AbortSignal | undefined,
  after: string | undefined,
  allowsAsset: (id: string, mappedTo?: string) => boolean,
  isCurrent: () => boolean,
) {
  const location = locateSentinelCase(snapshotPath);
  const pinned = readSentinelAssessmentRevision(snapshotPath, revision)
    ?.result.sharedGraph.snapshot;
  if (!location || !pinned || signal?.aborted || !isCurrent()) return [];
  const linkedCaseSources = readSentinelLinkedSourcesForRevision(
    snapshotPath,
    revision,
  );
  const allowsRecord = (record: SentinelAssetDiscoveryRecord) => {
    if (linkedCaseSources === undefined) return true;
    const binding = linkedCaseSources.find(({ caseId, revision }) =>
      caseId === record.sourceCaseId && revision === record.evidenceRevision
    );
    return !!binding && readSentinelRunIdForRevision(
          resolveSentinelCasePath(location.baseDir, binding.caseId),
          binding.revision,
        ) === binding.runId;
  };
  const destination = loadSentinelGraph(pinned);
  const records = discoveryStore(location.baseDir, (store) => {
    if (!exactId) return store.listPeerApprovals(location.caseId, after);
    const exact = store.get(exactId);
    return exact?.status === "approved" ? [exact] : [];
  });
  const results: (SentinelAssetDiscoveryRecord & {
    mappedAssetId: string;
    mappedTo?: string;
  })[] = [];
  for (const record of records) {
    if (signal?.aborted) return [];
    if (record.sourceCaseId === location.caseId || !allowsRecord(record)) {
      continue;
    }
    try {
      const source = archivedDiscovery(location.baseDir, record);
      if (!source) continue;
      const match = matchSentinelAssetDiscoveryDestination(
        source.graph,
        destination,
        record.claim,
      );
      if (!match || !allowsAsset(match.assetId, match.to)) continue;
      const currentSource = await currentDiscovery(
        source.path,
        record,
        source.graph,
      );
      if (!currentSource) continue;
      const liveMatch = matchSentinelAssetDiscoveryDestination(
        currentSource,
        destination,
        record.claim,
      );
      if (liveMatch?.assetId !== match.assetId || liveMatch.to !== match.to) {
        continue;
      }
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
      if (results.length >= 6) break;
    } catch {
      // An unavailable source cannot authorize a discovery.
    }
  }
  return signal?.aborted || !isCurrent() ? [] : discoveryStore(
    location.baseDir,
    (store) =>
      results.filter(({ id, version, mappedAssetId, mappedTo }) => {
        const current = store.get(id);
        return current?.status === "approved" && current.version === version &&
          allowsAsset(mappedAssetId, mappedTo) && allowsRecord(current) &&
          (!current.graphFactSource ||
            !!archivedDiscovery(location.baseDir, current));
      }),
  );
}
