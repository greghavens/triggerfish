import {
  type readSentinelAssessment,
  readSentinelAssessmentRevision,
} from "../sentinel/assessment_store.ts";
import {
  branchExecutionEvidenceId,
} from "../sentinel/case_execution_evidence.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import type { GraphNode } from "../sentinel/graph.ts";
import {
  executionFindingAsset,
  verifyWorkerFindingRecheck,
} from "../sentinel/worker_finding_evidence.ts";
import {
  readSentinelWorkerFindingHistory,
  type SentinelWorkerFindingRecord,
} from "../sentinel/worker_finding_store.ts";

export function branchRecheckScope(
  path: string,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  branches: readonly { name: string; protected: boolean }[] | undefined,
) {
  const original = readSentinelAssessmentRevision(
    path,
    finding.evidenceRevision,
  )
    ?.result.sharedGraph.snapshot?.nodes.find(({ id }) =>
      id === finding.evidenceId
    );
  if (!original) {
    return finding.evidenceId.startsWith("execution-evidence:")
      ? false
      : undefined;
  }
  if (original.kind !== "evidence" || !original.executionSource) {
    return undefined;
  }
  const matches = (node: GraphNode, branch: string) =>
    node.kind === "evidence" && !!node.executionSource &&
    !!node.controlVerification &&
    node.id === branchExecutionEvidenceId(
        finding.runId,
        finding.targetId,
        finding.controlId,
        node.executionSource,
        branch,
        node.controlVerification.validUntil,
      );
  const branch = branches?.find(({ name }) => matches(original, name));
  if (!branch) return false;
  return (node: GraphNode) =>
    matches(node, branch.name) &&
    (node.id !== evidenceId || node.kind === "evidence" &&
        node.controlVerification?.outcome ===
          (branch.protected ? "pass" : "fail"));
}

export type ExecutionBranches = readonly { name: string; protected: boolean }[];

export function receiptRecheckCandidate(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  branches: ExecutionBranches | undefined,
) {
  const snapshot = state.result?.sharedGraph.snapshot;
  if (
    !snapshot || !branches?.length || finding.runId !== state.plan.runId ||
    finding.targetId !== executionFindingAsset(snapshot, evidenceId)
  ) return;
  const boundary = branchRecheckScope(path, finding, evidenceId, branches);
  if (boundary === false) return;
  const check = verifyWorkerFindingRecheck(snapshot, {
    caseId: finding.caseId,
    evidenceRevision: state.revision,
    evaluatedAt: state.result?.controlEvaluationAt ?? state.updatedAt,
  }, {
    assetId: finding.targetId,
    findingId: finding.graphFindingId,
    controlId: finding.controlId,
    evidenceId,
  }, boundary);
  return check && check.observedAt > finding.observedAt &&
      branches.some(({ protected: enabled }) =>
        enabled === (check.outcome === "pass")
      )
    ? check
    : undefined;
}

/** Project matching case finding IDs after the planner has been authorized to read the source. */
export function plannerExecutionRecheckCandidates(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  evidenceId: string,
  branches: ExecutionBranches,
) {
  const location = locateSentinelCase(path);
  if (!location || !state.plan.runId) return [];
  const journal = readSentinelWorkerFindingHistory(path).filter((
    { caseId, runId, evidenceRevision },
  ) =>
    caseId === location.caseId && runId === state.plan.runId &&
    evidenceRevision <= state.revision
  );
  const checked = new Set(journal.flatMap((entry) =>
    entry.kind === "recheck" &&
      entry.evidenceId === evidenceId
      ? [entry.findingId]
      : []
  ));
  const candidates: string[] = [];
  for (const finding of journal) {
    if (
      finding.kind === "finding" && !checked.has(finding.id) &&
      receiptRecheckCandidate(path, state, finding, evidenceId, branches)
    ) {
      candidates.push(finding.id);
      if (candidates.length === 8) break;
    }
  }
  return candidates;
}
