/** Resolve an explicitly published finding at an exact linked source revision. */
import { isDeepStrictEqual } from "node:util";
import {
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraintsForRevision,
  readSentinelRunIdForRevision,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { sentinelFindingTrafficEvidenceVersion } from "../sentinel/finding_traffic_links.ts";
import type { GraphNode } from "../sentinel/graph.ts";
import type { SentinelLinkedCaseSource } from "../sentinel/linked_case_sources.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { verifyWorkerFindingRecheck } from "../sentinel/worker_finding_evidence.ts";
import { readSentinelWorkerFindingPublications } from "../sentinel/worker_finding_publications.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
} from "../sentinel/worker_finding_store.ts";

export function readLinkedFindingProof(
  baseDir: string,
  sources: readonly SentinelLinkedCaseSource[],
  caseId: string,
  assetId: string,
  finding: string | Extract<GraphNode, { kind: "finding" }>,
) {
  const id = typeof finding === "string" ? finding : finding.id;
  if (!sources.some((binding) => binding.caseId === caseId)) return undefined;
  const path = resolveSentinelCasePath(baseDir, caseId);
  try {
    const publication = readSentinelWorkerFindingPublications(path, caseId)
      .find((entry) => entry.finding.id === id);
    if (
      !publication || publication.withdrawal ||
      publication.targetId !== assetId ||
      (typeof finding !== "string" &&
        !isDeepStrictEqual(publication.finding, finding))
    ) {
      return undefined;
    }
    const origin = publication.finding.workerFindingSource;
    if (
      !origin || !sources.some((binding) =>
        binding.caseId === origin.caseId && binding.runId === origin.runId &&
        binding.revision === origin.revision
      ) ||
      readSentinelRunIdForRevision(path, origin.revision) !== origin.runId ||
      !hasSentinelWorkerFindingJournal(path)
    ) {
      return undefined;
    }

    const snapshot = readSentinelAssessmentRevision(path, origin.revision)
      ?.result.sharedGraph.snapshot;
    const evidence = snapshot?.nodes.find(({ id }) =>
      id === origin.evidenceId
    );
    const policy = readSentinelOperatingConstraintsForRevision(
      path,
      origin.revision,
    );
    if (
      !snapshot || evidence?.kind !== "evidence" ||
      !sentinelOperatingConstraintsAllow(
        policy?.constraints,
        { kind: "review_evidence", nodeId: assetId },
        snapshot,
      )
    ) return undefined;
    const journal = openSentinelWorkerFindingStore(path);
    try {
      const report = journal.readFindingReport(
        origin.receiptId,
        origin.revision,
      );
      const receipt = report?.finding;
      if (
        !receipt || report.version !== origin.reportVersion ||
        receipt.caseId !== caseId || receipt.runId !== origin.runId ||
        receipt.evidenceRevision !== origin.revision ||
        receipt.targetId !== assetId ||
        receipt.taskId !== origin.taskId ||
        receipt.evidenceId !== origin.evidenceId ||
        receipt.snapshotDigest !== origin.snapshotDigest ||
        sentinelFindingTrafficEvidenceVersion(
            path,
            origin.revision,
            origin.receiptId,
          ).digest !==
          publication.evidenceVersion
      ) return undefined;
      const checked = verifyWorkerFindingRecheck(
        snapshot,
        {
          caseId,
          evidenceRevision: origin.revision,
          evaluatedAt: new Date().toISOString(),
        },
        {
          findingId: receipt.graphFindingId,
          assetId,
          controlId: receipt.controlId,
          evidenceId: receipt.evidenceId,
        },
      );
      if (
        checked?.outcome !== "fail" ||
        checked.snapshotDigest !== origin.snapshotDigest ||
        checked.observedAt !== receipt.observedAt ||
        checked.validUntil !== receipt.validUntil
      ) return undefined;
      return {
        publication,
        ...(evidence.executionSource || evidence.nativeWorkflowSource
          ? {
            execution: {
              path,
              runId: origin.runId,
              revision: origin.revision,
              assetId,
              evidence,
              controlId: receipt.controlId,
            },
          }
          : {}),
      };
    } finally {
      journal.close();
    }
  } catch {
    return undefined;
  }
}
