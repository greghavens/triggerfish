import { dirname, join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import { openSentinelAdaptiveStore } from "../sentinel/adaptive_store.ts";
import { readNativeWorkflowCitation } from "../sentinel/native_workflow_evidence.ts";
import type { ExecutionTraceApprovedPayload } from "../core/execution_traces.ts";
import {
  type readSentinelAssessment,
  readSentinelAssessmentRevision,
} from "../sentinel/assessment_store.ts";
import {
  branchExecutionEvidenceId,
  repositoryVisibilityEvidenceId,
  retainedControlSources,
  workflowControlEvidenceId,
  workflowControlResult,
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
  {
    kind:
      | "github_branch_protection"
      | "github_repository_status"
      | "github_actions_status";
  }
>;

export function executionControlReceipt(
  payload: ExecutionTraceApprovedPayload,
): ExecutionControlReceipt | undefined {
  if (
    payload.kind === "github_repository_status" ||
    (payload.kind === "github_actions_status" &&
      workflowControlResult(payload)) ||
    (payload.kind === "github_branch_protection" &&
      payload.approvedBranches?.length)
  ) return payload;
}

function matchesTypedControl(
  node: GraphNode,
  runId: string,
  assetId: string,
  controlId: string,
  receipt: Exclude<
    ExecutionControlReceipt,
    { kind: "github_branch_protection" }
  >,
) {
  if (
    node.kind !== "evidence" || !node.executionSource ||
    !node.controlVerification
  ) return false;
  const { executionSource, controlVerification: { validUntil } } = node;
  if (receipt.kind === "github_repository_status") {
    return node.id === repositoryVisibilityEvidenceId(
      runId,
      assetId,
      controlId,
      executionSource,
      receipt.repositoryId,
      validUntil,
    );
  }
  const workflow = workflowControlResult(receipt);
  return !!workflow && node.id === workflowControlEvidenceId(
        runId,
        assetId,
        controlId,
        executionSource,
        receipt.repositoryId,
        workflow.workflow,
        validUntil,
      );
}

function nativeRecheckScope(
  path: string,
  original: Extract<GraphNode, { kind: "evidence" }>,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  receipt: ExecutionControlReceipt | undefined,
) {
  if (
    !original.nativeWorkflowSource || receipt?.kind !== "github_actions_status"
  ) {
    return false;
  }
  const store = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  const prior = (() => {
    try {
      return readNativeWorkflowCitation(store, original.nativeWorkflowSource);
    } finally {
      store.close();
    }
  })();
  if (
    !prior || prior.assetId !== finding.targetId ||
    prior.candidate.outcome !== original.controlVerification?.outcome ||
    prior.saved.observedAt !== original.controlVerification.observedAt
  ) return false;
  const before = workflowControlResult(prior.candidate.payload);
  const after = workflowControlResult(receipt);
  if (
    !before?.createdAt || !after?.createdAt ||
    prior.candidate.payload.repositoryId !== receipt.repositoryId ||
    before.workflow !== after.workflow || before.runId === after.runId ||
    before.createdAt >= after.createdAt
  ) return false;
  return (node: GraphNode) => {
    if (
      node.id !== evidenceId || node.kind !== "evidence" ||
      node.nativeWorkflowSource?.runId !== finding.runId
    ) return false;
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const candidate = readNativeWorkflowCitation(
        store,
        node.nativeWorkflowSource,
      );
      return !!candidate && candidate.assetId === finding.targetId &&
        candidate.saved.observedAt === node.controlVerification?.observedAt &&
        candidate.candidate.outcome === node.controlVerification.outcome &&
        isDeepStrictEqual(candidate.candidate.payload, receipt);
    } finally {
      store.close();
    }
  };
}

export function executionRecheckScope(
  path: string,
  finding: SentinelWorkerFindingRecord,
  evidenceId: string,
  receipt: ExecutionControlReceipt | undefined,
) {
  const original = readSentinelAssessmentRevision(
    path,
    finding.evidenceRevision,
  )
    ?.result.sharedGraph.snapshot?.nodes.find(({ id }) =>
      id === finding.evidenceId
    );
  if (original?.kind === "evidence" && original.nativeWorkflowSource) {
    return nativeRecheckScope(path, original, finding, evidenceId, receipt);
  }
  if (finding.evidenceId.startsWith("native-workflow-evidence:")) return false;
  if (!receipt || receipt.kind === "github_branch_protection") {
    return branchRecheckScope(path, finding, evidenceId, receipt);
  }
  const matches = (node: GraphNode) =>
    matchesTypedControl(
      node,
      finding.runId,
      finding.targetId,
      finding.controlId,
      receipt,
    );
  if (!original || !matches(original)) return false;
  if (receipt.kind === "github_repository_status") return matches;
  const lookup = retainedControlSources(path);
  const previous = lookup?.(original);
  const prior = previous && workflowControlResult(previous);
  if (!prior?.createdAt || previous?.repositoryId !== receipt.repositoryId) {
    return false;
  }
  const priorCreatedAt = prior.createdAt;
  return (node: GraphNode) => {
    if (!matches(node)) return false;
    const payload = node.id === evidenceId ? receipt : lookup?.(node);
    const run = payload && workflowControlResult(payload);
    return !!run?.createdAt && run.createdAt > priorCreatedAt &&
      payload?.repositoryId === receipt.repositoryId &&
      run.workflow === prior.workflow && run.runId !== prior.runId &&
      node.kind === "evidence" &&
      run.passed === (node.controlVerification?.outcome === "pass");
  };
}

export function executionReceiptSupportsCheck(
  node: GraphNode | undefined,
  runId: string,
  assetId: string,
  controlId: string,
  outcome: "pass" | "fail",
  receipt: ExecutionControlReceipt | undefined,
) {
  if (node?.kind === "evidence" && node.nativeWorkflowSource) {
    const run = receipt?.kind === "github_actions_status" &&
      workflowControlResult(receipt);
    return !!run && node.nativeWorkflowSource.runId === runId &&
      run.runId === node.nativeWorkflowSource.workflowRunNumber &&
      run.passed === (outcome === "pass");
  }
  if (receipt && receipt.kind !== "github_branch_protection") {
    const passed = receipt.kind === "github_repository_status"
      ? receipt.visibility === "private"
      : workflowControlResult(receipt)?.passed;
    return !!node && matchesTypedControl(
      node,
      runId,
      assetId,
      controlId,
      receipt,
    ) && passed === (outcome === "pass");
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
