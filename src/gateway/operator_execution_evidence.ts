/** Attach approved historical execution evidence to a case asset. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import type {
  ExecutionTraceApprovedPayload,
  ExecutionTraceReceipt,
} from "../core/execution_traces.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
} from "../sentinel/assessment_store.ts";
import {
  branchExecutionEvidenceId,
  executionEvidenceDigest,
  repositoryVisibilityEvidenceId,
  retainCaseExecutionEvidence,
  workflowAttemptControlResult,
  workflowAttemptEvidenceId,
  workflowControlEvidenceId,
  workflowControlResult,
} from "../sentinel/case_execution_evidence.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import type { SentinelWorkerFindingRecord } from "../sentinel/worker_finding_store.ts";
import { verifyWorkerFindingRecheck } from "../sentinel/worker_finding_evidence.ts";
import {
  executionControlReceipt,
  executionRecheckScope,
} from "./sentinel_execution_rechecks.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import {
  loadSentinelGraph,
  type SentinelNativeWorkflowSource,
} from "../sentinel/graph.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import {
  assertOperatorSourceSnapshot,
  withSentinelSourceSnapshotLock,
} from "../sentinel/source_snapshot_lock.ts";

type ApprovedReceipt = {
  step: ExecutionTraceReceipt;
  payload: ExecutionTraceApprovedPayload;
};
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function projectExecutionAttachment(
  { action, runId, node, controlId, branch, validUntil }: {
    readonly action: unknown;
    readonly runId: string;
    readonly node: string;
    readonly controlId?: unknown;
    readonly branch?: unknown;
    readonly validUntil?: unknown;
  },
  original: ApprovedReceipt,
) {
  const branchCheck = action === "attach_branch_evidence";
  const repositoryCheck = action === "attach_repository_visibility_evidence";
  const workflowCheck = action === "attach_workflow_control_evidence";
  const attemptCheck = action === "attach_workflow_attempt_evidence";
  const verifiesControl = branchCheck || repositoryCheck || workflowCheck ||
    attemptCheck;
  const { step, payload } = original;
  const workflow = workflowCheck ? workflowControlResult(payload) : undefined;
  const attempt = attemptCheck
    ? workflowAttemptControlResult(payload)
    : undefined;
  let controlVerification;
  if (verifiesControl) {
    const passed = branchCheck
      ? payload.kind === "github_branch_protection"
        ? payload.approvedBranches?.find(({ name }) => name === branch)
          ?.protected
        : undefined
      : workflowCheck
      ? workflow?.passed
      : attemptCheck
      ? attempt?.passed
      : payload.kind === "github_repository_status"
      ? payload.visibility === "private"
      : undefined;
    if (passed === undefined || typeof validUntil !== "string") {
      return undefined;
    }
    const expiry = Date.parse(validUntil);
    const observed = Date.parse(step.recordedAt);
    if (
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== validUntil ||
      !Number.isFinite(observed) || expiry <= observed ||
      (workflow && Date.parse(workflow.createdAt) > observed)
    ) return undefined;
    controlVerification = {
      outcome: passed ? "pass" as const : "fail" as const,
      observedAt: step.recordedAt,
      validUntil,
    };
  }
  const executionSource = {
    role: step.scope.role,
    runId: step.scope.runId,
    ordinal: step.ordinal,
    receiptId: step.id,
    resultSha256: executionEvidenceDigest(payload),
    ...(!verifiesControl && { recordedAt: step.recordedAt }),
  };
  const id = branchCheck && typeof controlId === "string" &&
      typeof branch === "string" && typeof validUntil === "string"
    ? branchExecutionEvidenceId(
      runId,
      node,
      controlId,
      executionSource,
      branch,
      validUntil,
    )
    : repositoryCheck && payload.kind === "github_repository_status" &&
        typeof controlId === "string" && typeof validUntil === "string"
    ? repositoryVisibilityEvidenceId(
      runId,
      node,
      controlId,
      executionSource,
      payload.repositoryId,
      validUntil,
    )
    : workflow && typeof controlId === "string" &&
        typeof validUntil === "string"
    ? workflowControlEvidenceId(
      runId,
      node,
      controlId,
      executionSource,
      payload.repositoryId,
      workflow.workflow,
      validUntil,
    )
    : attempt && typeof controlId === "string" &&
        typeof validUntil === "string"
    ? workflowAttemptEvidenceId(
      runId,
      node,
      controlId,
      executionSource,
      payload.repositoryId,
      attempt.runId,
      attempt.attempt,
      validUntil,
    )
    : "execution-evidence:" + sha([runId, node, executionSource]);
  const evidence = {
    id,
    kind: "evidence" as const,
    label: branchCheck
      ? "Approved branch protection observation"
      : repositoryCheck
      ? "Approved repository visibility observation"
      : workflowCheck
      ? "Approved workflow control observation"
      : attemptCheck
      ? "Approved workflow attempt observation"
      : "Approved execution observation",
    executionSource,
    ...(controlVerification && { controlVerification }),
  };
  return { evidence, workflow, attempt };
}

/** Derive an exact attachment only when the existing recheck verifier accepts it. */
export function projectExecutionRecheckSource(
  path: string,
  snapshot: ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>,
  evidenceRevision: number,
  finding: SentinelWorkerFindingRecord,
  original: ApprovedReceipt,
  validUntil: string,
) {
  const { step, payload } = original;
  const receipt = executionControlReceipt(payload);
  if (!receipt || step.recordedAt <= finding.observedAt) return;
  const action = receipt.kind === "github_branch_protection"
    ? "attach_branch_evidence"
    : receipt.kind === "github_repository_status"
    ? "attach_repository_visibility_evidence"
    : receipt.kind === "github_actions_run_status"
    ? "attach_workflow_attempt_evidence"
    : "attach_workflow_control_evidence";
  const branches = receipt.kind === "github_branch_protection"
    ? (receipt.approvedBranches ?? []).map(({ name }) => name)
    : [undefined];
  for (const branch of branches) {
    const attachment = {
      action,
      runId: finding.runId,
      node: finding.targetId,
      controlId: finding.controlId,
      ...(branch === undefined ? {} : { branch }),
      validUntil,
      traceRole: step.scope.role,
      traceRunId: step.scope.runId,
      ordinal: step.ordinal,
    };
    const projection = projectExecutionAttachment(attachment, original);
    const evidence = projection?.evidence;
    const boundary = evidence &&
      executionRecheckScope(path, finding, evidence.id, receipt);
    if (!evidence?.controlVerification || !boundary) continue;
    const graph = snapshot.nodes.some(({ id }) => id === evidence.id)
      ? snapshot
      : {
        ...snapshot,
        nodes: [...snapshot.nodes, evidence],
        edges: [
          ...snapshot.edges,
          { from: evidence.id, to: finding.targetId, relation: "observed_on" },
          { from: evidence.id, to: finding.controlId, relation: "verifies" },
        ],
      };
    if (
      verifyWorkerFindingRecheck(
        graph,
        {
          caseId: finding.caseId,
          evidenceRevision,
          evaluatedAt: new Date().toISOString(),
        },
        {
          findingId: finding.graphFindingId,
          assetId: finding.targetId,
          controlId: finding.controlId,
          evidenceId: evidence.id,
        },
        boundary,
      )
    ) {
      return {
        attachment,
        evidenceId: evidence.id,
        executionSource: evidence.executionSource,
        verification: evidence.controlVerification,
      };
    }
  }
}

export async function attachOperatorExecutionEvidence(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  reopen: () => Promise<ApprovedReceipt | undefined>,
  confirm: (message: string) => Promise<boolean>,
  webContainmentConfigured?: boolean,
) {
  const { action, node, controlId, branch, runId, validUntil } = args;
  const branchCheck = action === "attach_branch_evidence";
  const repositoryCheck = action === "attach_repository_visibility_evidence";
  const workflowCheck = action === "attach_workflow_control_evidence";
  const attemptCheck = action === "attach_workflow_attempt_evidence";
  const verifiesControl = branchCheck || repositoryCheck || workflowCheck ||
    attemptCheck;
  const unavailable = branchCheck
    ? "Error: The exact branch protection evidence is unavailable."
    : "Error: The exact execution evidence is unavailable.";
  if (
    ref.kind !== "sentinel" || ref.revision === undefined ||
    typeof node !== "string" || typeof runId !== "string" ||
    (verifiesControl
      ? typeof controlId !== "string" || typeof validUntil !== "string" ||
        (branchCheck
          ? typeof branch !== "string"
          : Object.hasOwn(args, "branch"))
      : action !== "attach_execution_evidence" ||
        ["controlId", "branch", "validUntil"].some((key) =>
          Object.hasOwn(args, key)
        )) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "revision",
        "node",
        "controlId",
        "branch",
        "runId",
        "validUntil",
        "traceRole",
        "traceRunId",
        "ordinal",
      ].includes(key)
    )
  ) return unavailable;
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const graph = async () => {
    await assertOperatorSourceSnapshot(path);
    return loadSentinelGraph(await readSentinelChatSnapshot(path)).snapshot();
  };
  const original = await reopen();
  if (!original) return unavailable;
  const projected = projectExecutionAttachment({
    action,
    runId,
    node,
    controlId,
    branch,
    validUntil,
  }, original);
  if (!projected) return unavailable;
  const { step, payload } = original;
  const { evidence, workflow, attempt } = projected;
  const { id, executionSource, controlVerification } = evidence;
  const project = async () => {
    const state = readSentinelAssessment(path);
    if (!state?.active || state.plan.runId !== runId) return;
    const snapshot = await graph();
    const existing = snapshot.nodes.find((item) => item.id === id);
    const edges = [
      { from: id, to: node, relation: "observed_on" },
      ...(verifiesControl && typeof controlId === "string"
        ? [{ from: id, to: controlId, relation: "verifies" as const }]
        : []),
    ] as const;
    const sameEdge = (expected: typeof edges[number]) =>
      snapshot.edges.some(({ from, to, relation }) =>
        from === expected.from && to === expected.to &&
        relation === expected.relation
      );
    if (existing) {
      return isDeepStrictEqual(existing, evidence) && edges.every(sameEdge)
        ? { existing: true as const }
        : undefined;
    }
    if (
      state.revision !== ref.revision ||
      !snapshot.nodes.some((item) =>
        item.id === node && item.kind === "asset"
      ) ||
      (verifiesControl &&
        !snapshot.edges.some(({ from, to, relation }) =>
          relation === "mitigates" && from === controlId &&
          snapshot.edges.some((edge) =>
            edge.from === to && edge.to === node && edge.relation === "affects"
          )
        ))
    ) return;
    return { existing: false as const, snapshot, edges };
  };
  const planned = await project();
  const receipt = {
    evidenceId: id,
    executionSource,
    ...(controlVerification && { verification: controlVerification }),
  };
  if (planned?.existing) {
    return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
      if (!(await project())?.existing) return unavailable;
      await retainCaseExecutionEvidence(path, step, payload);
      return { receipt };
    });
  }
  if (!planned) return unavailable;
  const digest = digestSentinelSnapshot(planned.snapshot);
  if (
    !await confirm(
      `Attach this exact ${
        branchCheck
          ? "branch protection"
          : repositoryCheck
          ? "repository visibility"
          : workflowCheck
          ? "workflow control"
          : attemptCheck
          ? "workflow attempt control"
          : "execution"
      } observation?\n${
        JSON.stringify({
          caseId: ref.id,
          revision: ref.revision,
          runId,
          asset: node,
          controlId,
          repository: payload.repo,
          ...(!branchCheck && { type: payload.kind }),
          branch,
          ...(workflow && { workflow }),
          ...(attempt && { attempt, repositoryId: payload.repositoryId }),
          receipt,
          snapshotDigest: digest,
        })
      }`,
    )
  ) return "Error: The operator declined the run action.";
  const authorized = await reopen();
  if (
    !authorized || authorized.step.id !== step.id ||
    executionEvidenceDigest(authorized.payload) !== executionSource.resultSha256
  ) {
    return unavailable;
  }
  return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
    const current = await project();
    if (current?.existing) return { receipt };
    if (!current || digestSentinelSnapshot(current.snapshot) !== digest) {
      return unavailable;
    }
    const updated = loadSentinelGraph({
      version: 1,
      nodes: [...current.snapshot.nodes, evidence],
      edges: [...current.snapshot.edges, ...current.edges],
    }).snapshot();
    await retainCaseExecutionEvidence(
      path,
      authorized.step,
      authorized.payload,
    );
    await publishSentinelInput(path, updated);
    try {
      refreshSentinelAssessment(path, webContainmentConfigured);
    } catch {
      // The coordinator can refresh the committed source.
    }
    return { receipt };
  });
}

/** Publish a native workflow check without changing the source trace identity. */
export async function attachOperatorNativeWorkflowControl(options: {
  baseDir: string;
  path: string;
  source: SentinelNativeWorkflowSource;
  assetId: string;
  controlId: string;
  observedAt: string;
  validUntil: string;
  outcome: "pass" | "fail";
  authorize: () => Promise<boolean>;
  confirm: (message: string) => Promise<boolean>;
  webContainmentConfigured?: boolean;
}) {
  const {
    baseDir,
    path,
    source,
    assetId,
    controlId,
    observedAt,
    validUntil,
    outcome,
  } = options;
  const expiry = Date.parse(validUntil);
  if (
    !Number.isFinite(expiry) || new Date(expiry).toISOString() !== validUntil ||
    expiry <= Date.parse(observedAt)
  ) return;
  const verification = { outcome, observedAt, validUntil };
  const evidenceId = "native-workflow-evidence:" +
    sha([source, assetId, controlId, verification]);
  const evidence = {
    id: evidenceId,
    kind: "evidence" as const,
    label: "Approved native workflow control observation",
    controlVerification: verification,
    nativeWorkflowSource: source,
  };
  const edges = [
    { from: evidenceId, to: assetId, relation: "observed_on" },
    { from: evidenceId, to: controlId, relation: "verifies" },
  ];
  const project = async () => {
    const state = readSentinelAssessment(path);
    if (!state?.active || state.plan.runId !== source.runId) return;
    await assertOperatorSourceSnapshot(path);
    const graph = loadSentinelGraph(await readSentinelChatSnapshot(path))
      .snapshot();
    const existing = graph.nodes.find(({ id }) => id === evidenceId);
    if (existing) {
      return isDeepStrictEqual(existing, evidence) &&
          edges.every((expected) =>
            graph.edges.some((edge) => isDeepStrictEqual(edge, expected))
          )
        ? { graph, existing: true }
        : undefined;
    }
    if (
      state.revision !== source.revision ||
      !graph.nodes.some(({ kind, id }) => kind === "asset" && id === assetId) ||
      !graph.edges.some(({ from, to, relation }) =>
        relation === "mitigates" && from === controlId &&
        graph.edges.some((edge) =>
          edge.from === to && edge.to === assetId && edge.relation === "affects"
        )
      )
    ) return;
    return { graph, existing: false };
  };
  const initial = await project();
  if (!initial) return;
  const receipt = { evidenceId, source, verification };
  if (initial.existing) return { receipt };
  const digest = digestSentinelSnapshot(initial.graph);
  if (
    !await options.confirm(
      `Attach this exact native workflow run?\n${
        JSON.stringify({
          assetId,
          controlId,
          receipt,
          snapshotDigest: digest,
        })
      }`,
    )
  ) return "Error: The operator declined the run action.";
  if (!await options.authorize()) return;
  return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
    const current = await project();
    if (!current) return;
    if (current.existing) return { receipt };
    if (digestSentinelSnapshot(current.graph) !== digest) return;
    const next = loadSentinelGraph({
      ...current.graph,
      nodes: [...current.graph.nodes, evidence],
      edges: [...current.graph.edges, ...edges],
    }).snapshot();
    await publishSentinelInput(path, next);
    try {
      refreshSentinelAssessment(path, options.webContainmentConfigured);
    } catch {
      // The coordinator can refresh the committed source.
    }
    return { receipt };
  });
}
