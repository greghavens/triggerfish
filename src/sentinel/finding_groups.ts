/** Read one saved case's finding counts and independently bounded entry page. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import {
  type FindingExportFilter,
  matchesFindingFilter,
} from "./assessment_export.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import {
  loadSentinelGraph,
  type sentinelFindingDispositions,
  type sentinelFindingSeverities,
} from "./graph.ts";
import { sentinelOperatingConstraintsAllow } from "./operating_constraints.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
} from "./worker_finding_store.ts";

function findingFacets(categoryOffset: number) {
  const severity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    unknown: 0,
  };
  const disposition = { open: 0, confirmed: 0, resolved: 0, dismissed: 0 };
  const categories = new Map<string, number>();
  let total = 0;
  return {
    add(
      level?: typeof sentinelFindingSeverities[number],
      state?: typeof sentinelFindingDispositions[number],
      category?: string,
    ) {
      total++;
      severity[level ?? "unknown"]++;
      disposition[state ?? "open"]++;
      if (category) {
        categories.set(category, (categories.get(category) ?? 0) + 1);
      }
    },
    page() {
      const end = categoryOffset + 8;
      const entries = [...categories.keys()].sort().slice(categoryOffset, end)
        .map(
          (category) => ({ category, count: categories.get(category)! }),
        );
      return {
        total,
        severity,
        disposition,
        categories: entries,
        categoryTotal: categories.size,
        nextCategoryOffset: end < categories.size ? end : null,
      };
    },
  };
}

function workerEntry(
  report: NonNullable<
    ReturnType<
      ReturnType<typeof openSentinelWorkerFindingStore>["readFindingReport"]
    >
  >,
) {
  return {
    source: "worker",
    id: report.finding.id,
    title: redactCredentialText(report.title).slice(0, 256),
    evidenceRevision: report.finding.evidenceRevision,
    taskId: report.finding.taskId,
    reportVersion: report.version,
    ...(report.severity !== undefined && { severity: report.severity }),
    ...(report.disposition !== undefined &&
      { disposition: report.disposition }),
    ...(report.findingCategory &&
      { findingCategory: report.findingCategory }),
  };
}

export type SentinelFindingOrder = "severity" | "time";

type FindingRank = {
  readonly severity?: typeof sentinelFindingSeverities[number];
  readonly foundAt: string;
  readonly id: string;
};

const severityRank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function compareSentinelFindingRank(
  order: SentinelFindingOrder,
  left: FindingRank,
  right: FindingRank,
): number {
  const leftSeverity = left.severity ? severityRank[left.severity] : 0;
  const rightSeverity = right.severity ? severityRank[right.severity] : 0;
  return (order === "severity" ? rightSeverity - leftSeverity : 0) ||
    right.foundAt.localeCompare(left.foundAt) ||
    left.id.localeCompare(right.id);
}

export function readSentinelFindingGroup(
  path: string,
  caseId: string,
  revision: number,
  offset: number,
  limit: number,
  categoryOffset?: number,
  filter?: FindingExportFilter,
  order?: SentinelFindingOrder,
  assetSubtreeId?: string,
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
  const graphEntry = (finding: typeof imported[number]) => ({
    source: "imported",
    id: finding.id,
    title: redactCredentialText(finding.label).slice(0, 256),
    severity: finding.severity,
    disposition: reviews.get(finding.id) ?? "open",
    evidenceRevision: revision,
  });
  const graphEntries = imported.slice(offset, offset + limit).map(graphEntry);
  const workerLimit = limit - graphEntries.length;
  const workerOffset = Math.max(0, offset - imported.length);
  const journal = hasSentinelWorkerFindingJournal(path)
    ? openSentinelWorkerFindingStore(path)
    : undefined;
  try {
    const saved = readSentinelOperatingConstraints(path, runId, revision)
      ?.constraints;
    const current = readSentinelOperatingConstraints(path, runId)
      ?.constraints;
    const requiresScope = [saved, current].some((policy) =>
      policy && (
        policy.allowedAssetIds !== undefined ||
        policy.deniedKinds.includes("review_finding") ||
        policy.deniedKinds.includes("review_evidence")
      )
    );
    if (
      requiresScope || filter || order || assetSubtreeId !== undefined ||
      categoryOffset !== undefined
    ) {
      const allowed = (
        kind: "review_finding" | "review_evidence",
        nodeId: string,
      ) =>
        sentinelOperatingConstraintsAllow(saved, { kind, nodeId }, snapshot) &&
        sentinelOperatingConstraintsAllow(current, { kind, nodeId }, snapshot);
      const subtree = new Set<string>();
      if (assetSubtreeId !== undefined) {
        const savedAssets = saved?.allowedAssetIds &&
          new Set(saved.allowedAssetIds);
        const currentAssets = current?.allowedAssetIds &&
          new Set(current.allowedAssetIds);
        if (
          saved?.deniedKinds.includes("review_evidence") ||
          current?.deniedKinds.includes("review_evidence")
        ) return;
        const available = new Set(
          snapshot?.nodes.flatMap((node) =>
            node.kind === "asset" &&
              (!savedAssets || savedAssets.has(node.id)) &&
              (!currentAssets || currentAssets.has(node.id))
              ? [node.id]
              : []
          ),
        );
        if (!available.has(assetSubtreeId)) return;
        const children = new Map<string, string[]>();
        for (const node of snapshot?.nodes ?? []) {
          if (
            node.kind !== "asset" || !node.parentId ||
            !available.has(node.id) || !available.has(node.parentId)
          ) continue;
          const siblings = children.get(node.parentId) ?? [];
          siblings.push(node.id);
          children.set(node.parentId, siblings);
        }
        subtree.add(assetSubtreeId);
        for (const parent of subtree) {
          for (const child of children.get(parent) ?? []) subtree.add(child);
        }
      }
      const facets = categoryOffset === undefined
        ? undefined
        : findingFacets(categoryOffset);
      const filteredGraph = imported.filter((finding) => {
        const disposition = reviews.get(finding.id) ?? "open";
        if (
          !allowed("review_finding", finding.id) ||
          (assetSubtreeId !== undefined &&
            !finding.assets.some((asset) => subtree.has(asset))) ||
          (filter && !matchesFindingFilter(filter, {
            kind: "imported",
            assets: finding.assets,
            title: finding.label,
            severity: finding.severity,
            disposition,
          }))
        ) return false;
        facets?.add(finding.severity, disposition);
        return true;
      });
      const workerIds = filter?.kind === "imported"
        ? []
        : journal?.pageFindingIds(caseId, runId, revision, 0, 4097).ids ?? [];
      if (workerIds.length > 4096) return;
      const entries:
        (ReturnType<typeof graphEntry> | ReturnType<typeof workerEntry>)[] =
          filteredGraph.slice(offset, offset + limit).map(graphEntry);
      const orderedEntries:
        | ((typeof entries)[number] & { foundAt: string })[]
        | undefined = order
          ? filteredGraph.map((finding) => ({
            ...graphEntry(finding),
            foundAt: state.updatedAt,
          }))
          : undefined;
      let workerCount = 0;
      for (const id of workerIds) {
        const report = journal?.readFindingReport(id, revision);
        if (
          !report || report.finding.caseId !== caseId ||
          report.finding.runId !== runId
        ) return;
        if (
          !allowed("review_evidence", report.finding.targetId) ||
          (assetSubtreeId !== undefined &&
            !subtree.has(report.finding.targetId)) ||
          (filter && !matchesFindingFilter(filter, {
            kind: "worker",
            assets: [report.finding.targetId],
            title: report.title,
            summary: report.summary,
            severity: report.severity,
            disposition: report.disposition,
            category: report.findingCategory,
          }))
        ) continue;
        facets?.add(
          report.severity,
          report.disposition,
          report.findingCategory,
        );
        const index = filteredGraph.length + workerCount++;
        if (orderedEntries) {
          orderedEntries.push({
            ...workerEntry(report),
            foundAt: report.finding.recordedAt,
          });
        } else if (index >= offset && index < offset + limit) {
          entries.push(workerEntry(report));
        }
      }
      const total = filteredGraph.length + workerCount;
      if (order && orderedEntries) {
        orderedEntries.sort((a, b) => compareSentinelFindingRank(order, a, b));
      }
      const page = orderedEntries
        ? orderedEntries.slice(offset, offset + limit)
        : entries;
      const latest = orderedEntries?.reduce(
        (time, entry) => entry.foundAt > time ? entry.foundAt : time,
        "",
      );
      const highest = orderedEntries?.reduce<FindingRank["severity"]>(
        (severity, entry) =>
          entry.severity &&
            (!severity || severityRank[entry.severity] > severityRank[severity])
            ? entry.severity
            : severity,
        undefined,
      );
      return {
        caseId,
        runId,
        revision,
        ...(assetSubtreeId !== undefined && { assetSubtreeId }),
        total,
        imported: filteredGraph.length,
        worker: workerCount,
        ...(facets && { facets: facets.page() }),
        ...(orderedEntries &&
          { latestFoundAt: latest ?? "", highestSeverity: highest }),
        entries: page,
        nextOffset: offset + page.length < total ? offset + page.length : null,
      };
    }
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
      workerEntries.push(workerEntry(report));
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
