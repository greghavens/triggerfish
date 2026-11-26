/** Read one saved case's finding counts and independently bounded entry page. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import {
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelRunIdForRevision,
} from "./assessment_store.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
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
