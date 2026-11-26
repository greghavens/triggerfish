/** Read one saved case's finding counts and independently bounded entry page. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
} from "./worker_finding_store.ts";

export function readSentinelFindingGroup(
  path: string,
  caseId: string,
  revision: number,
  offset: number,
  limit: number,
) {
  const state = readSentinelAssessmentRevision(path, revision);
  if (!state) return;
  const runId = readSentinelRunIdForRevision(path, revision);
  const snapshot = state.result?.sharedGraph.snapshot;
  if (!runId) return;
  const imported = snapshot ? loadSentinelGraph(snapshot).report() : [];
  const reviews = new Map(
    readSentinelFindingReviews(path, revision).toReversed().map(
      ({ findingId, disposition }) => [findingId, disposition],
    ),
  );
  const graphEntries = imported.slice(offset, offset + limit).map((
    finding,
  ) => ({
    source: "imported",
    id: finding.id,
    title: redactCredentialText(finding.label).slice(0, 256),
    severity: finding.severity,
    disposition: reviews.get(finding.id) ?? "open",
    evidenceRevision: revision,
  }));
  const workerLimit = limit - graphEntries.length;
  const workerOffset = Math.max(0, offset - imported.length);
  const journal = hasSentinelWorkerFindingJournal(path)
    ? openSentinelWorkerFindingStore(path)
    : undefined;
  try {
    const workers = journal?.pageFindingIds(
      caseId,
      runId,
      revision,
      workerOffset,
      workerLimit,
    ) ?? { total: 0, ids: [] };
    const workerEntries = [];
    for (const id of workers.ids) {
      const report = journal?.readFindingReport(id, revision);
      if (
        !report || report.finding.caseId !== caseId ||
        report.finding.runId !== runId
      ) return;
      workerEntries.push({
        source: "worker",
        id,
        title: redactCredentialText(report.title).slice(0, 256),
        evidenceRevision: report.finding.evidenceRevision,
        taskId: report.finding.taskId,
        reportVersion: report.version,
        ...(report.severity !== undefined && { severity: report.severity }),
        ...(report.disposition !== undefined &&
          { disposition: report.disposition }),
        ...(report.findingCategory &&
          { findingCategory: report.findingCategory }),
      });
    }
    const entries = [...graphEntries, ...workerEntries];
    const total = imported.length + workers.total;
    return {
      caseId,
      runId,
      revision,
      total,
      imported: imported.length,
      worker: workers.total,
      entries,
      nextOffset: offset + entries.length < total
        ? offset + entries.length
        : null,
    };
  } finally {
    journal?.close();
  }
}

/** Project only declared parents that are still in the authorized case scope. */
export function readSentinelFindingAssetTree(
  path: string,
  caseId: string,
  revision: number,
  findingIds: readonly string[],
) {
  const state = readSentinelAssessmentRevision(path, revision);
  const runId = readSentinelRunIdForRevision(path, revision);
  if (!state?.result?.sharedGraph.snapshot || !runId) return;
  const graph = loadSentinelGraph(state.result.sharedGraph.snapshot);
  const saved = readSentinelOperatingConstraints(path, runId, revision)
    ?.constraints.allowedAssetIds;
  const current = readSentinelOperatingConstraints(path, runId)
    ?.constraints.allowedAssetIds;
  const savedScope = saved && new Set(saved);
  const currentScope = current && new Set(current);
  const assets = new Map(
    graph.snapshot().nodes.flatMap((node) =>
      node.kind === "asset" &&
        (!savedScope || savedScope.has(node.id)) &&
        (!currentScope || currentScope.has(node.id))
        ? [[node.id, node] as const]
        : []
    ),
  );
  const imported = new Map(
    graph.report().map((finding) => [finding.id, finding]),
  );
  const workers = readSentinelCaseFindingReceipts(path, findingIds);
  const counts = new Map<string, { direct: number; aggregate: number }>();
  for (const id of findingIds) {
    const graphFinding = imported.get(id);
    const worker = workers.get(id);
    if (graphFinding && worker) return;
    const affected = graphFinding?.assets ??
      (worker?.kind === "finding" && worker.caseId === caseId &&
          worker.runId === runId && worker.evidenceRevision <= revision
        ? [worker.targetId]
        : []);
    const direct = new Set(affected.filter((assetId) => assets.has(assetId)));
    if (!direct.size) return;
    const touched = new Set<string>();
    for (const assetId of direct) {
      let node = assets.get(assetId);
      while (node && !touched.has(node.id)) {
        touched.add(node.id);
        node = node.parentId ? assets.get(node.parentId) : undefined;
      }
    }
    for (const assetId of touched) {
      const count = counts.get(assetId) ?? { direct: 0, aggregate: 0 };
      count.aggregate++;
      if (direct.has(assetId)) count.direct++;
      counts.set(assetId, count);
      if (counts.size > 32) return;
    }
  }
  const nodes = [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([assetId, count]) => {
    const { label, assetType, parentId } = assets.get(assetId)!;
    return {
      id: assetId,
      label: redactCredentialText(label).slice(0, 128),
      ...(assetType && { assetType }),
      ...(parentId && counts.has(parentId) && { parentId }),
      ...count,
    };
  });
  return { caseId, runId, revision, findingTotal: findingIds.length, nodes };
}
