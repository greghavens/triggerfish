/** Attach an approved historical branch protection result to the case graph. */
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
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import {
  assertOperatorSourceSnapshot,
  withSentinelSourceSnapshotLock,
} from "../sentinel/source_snapshot_lock.ts";

type BranchReceipt = {
  step: ExecutionTraceReceipt;
  payload: Extract<
    ExecutionTraceApprovedPayload,
    { kind: "github_branch_protection" }
  >;
};
const unavailable =
  "Error: The exact branch protection evidence is unavailable.";
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function attachOperatorBranchEvidence(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  reopen: () => Promise<BranchReceipt | undefined>,
  confirm: (message: string) => Promise<boolean>,
  webContainmentConfigured?: boolean,
) {
  const { node, controlId, branch, runId, validUntil } = args;
  if (
    ref.kind !== "sentinel" || ref.revision === undefined ||
    typeof node !== "string" || typeof controlId !== "string" ||
    typeof branch !== "string" || typeof runId !== "string" ||
    typeof validUntil !== "string" ||
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
  const branchStatus = original?.payload.approvedBranches?.find(({ name }) =>
    name === branch
  );
  if (!original || !branchStatus) return unavailable;
  const { step, payload } = original;
  const expiry = Date.parse(validUntil);
  const observed = Date.parse(step.recordedAt);
  if (
    !Number.isFinite(expiry) || new Date(expiry).toISOString() !== validUntil ||
    !Number.isFinite(observed) || expiry <= observed
  ) return unavailable;
  const executionSource = {
    role: step.scope.role,
    runId: step.scope.runId,
    ordinal: step.ordinal,
    receiptId: step.id,
    resultSha256: sha(payload),
  };
  const id = "execution-evidence:" +
    sha([runId, node, controlId, executionSource, branch, validUntil]);
  const evidence = {
    id,
    kind: "evidence" as const,
    label: "Approved branch protection observation",
    executionSource,
    controlVerification: {
      outcome: branchStatus.protected ? "pass" as const : "fail" as const,
      observedAt: step.recordedAt,
      validUntil,
    },
  };
  const project = async () => {
    const state = readSentinelAssessment(path);
    if (!state?.active || state.plan.runId !== runId) return;
    const snapshot = await graph();
    const existing = snapshot.nodes.find((item) => item.id === id);
    const edges = [
      { from: id, to: node, relation: "observed_on" },
      { from: id, to: controlId, relation: "verifies" },
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
      !snapshot.edges.some(({ from, to, relation }) =>
        relation === "mitigates" && from === controlId &&
        snapshot.edges.some((edge) =>
          edge.from === to && edge.to === node && edge.relation === "affects"
        )
      )
    ) return;
    return { existing: false as const, snapshot, edges };
  };
  const planned = await project();
  const receipt = {
    evidenceId: id,
    executionSource,
    verification: evidence.controlVerification,
  };
  if (planned?.existing) return { receipt };
  if (!planned) return unavailable;
  const digest = digestSentinelSnapshot(planned.snapshot);
  if (
    !await confirm(
      `Attach this exact branch protection observation?\n${
        JSON.stringify({
          caseId: ref.id,
          revision: ref.revision,
          runId,
          asset: node,
          controlId,
          repository: payload.repo,
          branch,
          receipt,
          snapshotDigest: digest,
        })
      }`,
    )
  ) return "Error: The operator declined the run action.";
  const authorized = await reopen();
  if (
    !authorized || authorized.step.id !== step.id ||
    sha(authorized.payload) !== executionSource.resultSha256
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
    await publishSentinelInput(path, updated);
    try {
      refreshSentinelAssessment(path, webContainmentConfigured);
    } catch {
      // The coordinator can refresh the committed source.
    }
    return { receipt };
  });
}
