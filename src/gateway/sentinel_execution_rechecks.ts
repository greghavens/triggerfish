import type { ExecutionTraceApprovedPayload } from "../core/execution_traces.ts";
import {
  type readSentinelAssessment,
  readSentinelAssessmentRevision,
} from "../sentinel/assessment_store.ts";
import {
  branchExecutionEvidenceId,
  repositoryVisibilityEvidenceId,
  retainedControlSources,
} from "../sentinel/case_execution_evidence.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import type { GraphNode } from "../sentinel/graph.ts";
import {
  executionFindingAsset,
  verifyWorkerFindingRecheck,
} from "../sentinel/worker_finding_evidence.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingHistory,
  type SentinelWorkerFindingRecord,
} from "../sentinel/worker_finding_store.ts";

function branchRecheckScope(
  path: string,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  receipt:
    | Extract<ExecutionControlReceipt, { kind: "github_branch_protection" }>
    | undefined,
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
  if (!receipt?.approvedBranches?.length) return false;
  const lookup = retainedControlSources(path);
  const source = lookup?.(original);
  if (
    source?.kind !== "github_branch_protection" ||
    source.repositoryId !== receipt.repositoryId
  ) return false;
  const branch = receipt.approvedBranches.find(({ name }) =>
    matches(original, name) &&
    source.approvedBranches?.some((previous) =>
      previous.name === name &&
      previous.protected === (original.controlVerification?.outcome === "pass")
    )
  );
  if (!branch) return false;
  return (node: GraphNode) => {
    if (!matches(node, branch.name) || node.kind !== "evidence") return false;
    const candidate = node.id === evidenceId ? receipt : lookup?.(node);
    return candidate?.kind === "github_branch_protection" &&
      candidate.repositoryId === receipt.repositoryId &&
      candidate.approvedBranches?.some(({ name, protected: enabled }) =>
          name === branch.name &&
          enabled === (node.controlVerification?.outcome === "pass")
        ) === true;
  };
}

export type ExecutionControlReceipt = Extract<
  ExecutionTraceApprovedPayload,
  { kind: "github_branch_protection" | "github_repository_status" }
>;

export function executionControlReceipt(
  payload: ExecutionTraceApprovedPayload,
): ExecutionControlReceipt | undefined {
  if (
    payload.kind === "github_repository_status" ||
    (payload.kind === "github_branch_protection" &&
      payload.approvedBranches?.length)
  ) return payload;
}

function matchesVisibilityControl(
  node: GraphNode,
  runId: string,
  assetId: string,
  controlId: string,
  repositoryId: number,
) {
  return node.kind === "evidence" && !!node.executionSource &&
    !!node.controlVerification &&
    node.id === repositoryVisibilityEvidenceId(
        runId,
        assetId,
        controlId,
        node.executionSource,
        repositoryId,
        node.controlVerification.validUntil,
      );
}

export function executionRecheckScope(
  path: string,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  receipt: ExecutionControlReceipt | undefined,
) {
  if (receipt?.kind !== "github_repository_status") {
    return branchRecheckScope(
      path,
      finding,
      evidenceId,
      receipt,
    );
  }
  const original = readSentinelAssessmentRevision(
    path,
    finding.evidenceRevision,
  )
    ?.result.sharedGraph.snapshot?.nodes.find(({ id }) =>
      id === finding.evidenceId
    );
  const matches = (node: GraphNode) =>
    matchesVisibilityControl(
      node,
      finding.runId,
      finding.targetId,
      finding.controlId,
      receipt.repositoryId,
    );
  if (!original || !matches(original)) return false;
  return matches;
}

export function executionReceiptSupportsCheck(
  node: GraphNode | undefined,
  runId: string,
  assetId: string,
  controlId: string,
  outcome: "pass" | "fail",
  receipt: ExecutionControlReceipt | undefined,
) {
  if (receipt?.kind === "github_repository_status") {
    return !!node && matchesVisibilityControl(
      node,
      runId,
      assetId,
      controlId,
      receipt.repositoryId,
    ) && (receipt.visibility === "private") === (outcome === "pass");
  }
  return receipt?.approvedBranches?.some(({ protected: enabled }) =>
    enabled === (outcome === "pass")
  ) === true;
}

export function receiptRecheckCandidate(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  receipt: ExecutionControlReceipt | undefined,
) {
  const snapshot = state.result?.sharedGraph.snapshot;
  if (
    !snapshot || !receipt || finding.runId !== state.plan.runId ||
    finding.targetId !== executionFindingAsset(snapshot, evidenceId)
  ) return;
  const boundary = executionRecheckScope(path, finding, evidenceId, receipt);
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
      executionReceiptSupportsCheck(
        snapshot.nodes.find(({ id }) => id === evidenceId),
        finding.runId,
        finding.targetId,
        finding.controlId,
        check.outcome,
        receipt,
      )
    ? check
    : undefined;
}

/** Check one original finding against an authorized branch receipt in this case. */
export function exactExecutionRecheckCandidate(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  evidenceId: string,
  findingId: string,
  receipt: ExecutionControlReceipt,
) {
  const caseId = locateSentinelCase(path)?.caseId;
  if (!caseId || !hasSentinelWorkerFindingJournal(path)) return;
  const store = openSentinelWorkerFindingStore(path);
  try {
    const finding = store.readFinding(findingId);
    return finding && finding.caseId === caseId &&
        finding.evidenceRevision <= state.revision
      ? receiptRecheckCandidate(path, state, finding, evidenceId, receipt)
      : undefined;
  } finally {
    store.close();
  }
}

/** Project matching case finding IDs after the planner has been authorized to read the source. */
export function plannerExecutionRecheckCandidates(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  evidenceId: string,
  receipt: ExecutionControlReceipt,
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
      receiptRecheckCandidate(path, state, finding, evidenceId, receipt)
    ) {
      candidates.push(finding.id);
      if (candidates.length === 8) break;
    }
  }
  return candidates;
}
