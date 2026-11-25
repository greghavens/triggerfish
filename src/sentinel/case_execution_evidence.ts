/** Case-local copies of the exact approved projections cited by imported evidence. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "@std/path";
import {
  type ExecutionTraceApprovedPayload,
  type ExecutionTraceReceipt,
  normalizeApprovedPayload,
  openExecutionTraces,
} from "../core/execution_traces.ts";
import {
  readSentinelAssessmentRevision,
  type SentinelGitHubWorkflowReadReceipt,
} from "./assessment_store.ts";
import { MAX_SNAPSHOT_BYTES, readSentinelChatSnapshot } from "./chat_mode.ts";
import {
  type GraphNode,
  loadSentinelGraph,
  type SentinelExecutionEvidenceSource,
} from "./graph.ts";
import { publishSentinelInput } from "./published_input.ts";
import { assertOperatorSourceSnapshotInfo } from "./source_snapshot_lock.ts";

export const sentinelExecutionEvidenceFile = "case-execution-evidence.json";
type SavedExecutionEvidence =
  & Omit<SentinelExecutionEvidenceSource, "recordedAt">
  & {
    classification: "PUBLIC" | "INTERNAL";
    recordedAt: string;
    payload: ExecutionTraceApprovedPayload;
  };
type SourceReference = {
  source: Omit<SentinelExecutionEvidenceSource, "recordedAt">;
  recordedAt: string;
};

/** Preserve the original branch attachment identity for historical evidence. */
export function branchExecutionEvidenceId(
  caseRunId: string,
  assetId: string,
  controlId: string,
  source: SentinelExecutionEvidenceSource,
  branch: string,
  validUntil: string,
) {
  return "execution-evidence:" + createHash("sha256").update(JSON.stringify([
    caseRunId,
    assetId,
    controlId,
    source,
    branch,
    validUntil,
  ])).digest("hex");
}

/** Bind the private-repository check to the stable GitHub repository identity. */
export function repositoryVisibilityEvidenceId(
  caseRunId: string,
  assetId: string,
  controlId: string,
  source: SentinelExecutionEvidenceSource,
  repositoryId: number,
  validUntil: string,
) {
  return "execution-evidence:" + createHash("sha256").update(JSON.stringify([
    "github_repository_private",
    caseRunId,
    assetId,
    controlId,
    source,
    repositoryId,
    validUntil,
  ])).digest("hex");
}

/** Bind an exact GitHub Actions result to a numeric workflow and case control. */
export function workflowControlEvidenceId(
  caseRunId: string,
  assetId: string,
  controlId: string,
  source: SentinelExecutionEvidenceSource,
  repositoryId: number,
  workflow: string,
  validUntil: string,
) {
  return "execution-evidence:" + createHash("sha256").update(JSON.stringify([
    "github_workflow_success",
    caseRunId,
    assetId,
    controlId,
    source,
    repositoryId,
    workflow,
    validUntil,
  ])).digest("hex");
}

/** Bind the control outcome to one exact workflow run and attempt. */
export function workflowAttemptEvidenceId(
  caseRunId: string,
  assetId: string,
  controlId: string,
  source: SentinelExecutionEvidenceSource,
  repositoryId: number,
  runId: number,
  attempt: number,
  validUntil: string,
) {
  return "execution-evidence:" + createHash("sha256").update(JSON.stringify([
    "github_workflow_attempt_success",
    caseRunId,
    assetId,
    controlId,
    source,
    repositoryId,
    runId,
    attempt,
    validUntil,
  ])).digest("hex");
}

export function workflowAttemptControlResult(
  payload: ExecutionTraceApprovedPayload,
) {
  if (
    payload.kind !== "github_actions_run_status" ||
    payload.status !== "completed" ||
    (payload.conclusion !== "success" && payload.conclusion !== "failure")
  ) return;
  return {
    runId: payload.id,
    attempt: payload.attempt,
    passed: payload.conclusion === "success",
  };
}

export function workflowControlResult(payload: ExecutionTraceApprovedPayload) {
  if (
    payload.kind !== "github_actions_status" ||
    !payload.workflow || !/^[1-9][0-9]*$/.test(payload.workflow) ||
    payload.runs.length !== 1
  ) return;
  const [run] = payload.runs;
  if (
    !run.created_at || run.status !== "completed" ||
    (run.conclusion !== "success" && run.conclusion !== "failure")
  ) return;
  return {
    workflow: payload.workflow,
    runId: run.id,
    createdAt: run.created_at,
    passed: run.conclusion === "success",
  };
}

/** Project one explicitly selected native run using the control receipt contract. */
export function nativeWorkflowControlCandidate(
  receipt: SentinelGitHubWorkflowReadReceipt,
  runId: number,
) {
  const run = receipt.runs.find(({ id }) => id === runId);
  if (
    !run?.repositoryId || !run.createdAt ||
    receipt.connectorId !== "github-actions"
  ) return;
  const payload = normalizeApprovedPayload({
    kind: "github_actions_status",
    repo: receipt.repository,
    repositoryId: run.repositoryId,
    workflow: String(receipt.workflowId),
    runs: [{
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      created_at: run.createdAt,
    }],
  });
  if (!payload) return;
  const control = workflowControlResult(payload);
  if (!control) return;
  return {
    payload,
    outcome: control.passed ? "pass" as const : "fail" as const,
  };
}

export const executionEvidenceDigest = (
  payload: ExecutionTraceApprovedPayload,
) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

async function readBundle(path: string) {
  try {
    const info = await Deno.lstat(path);
    assertOperatorSourceSnapshotInfo(info);
    if ((info.mode ?? 0) & 0o077) {
      throw new Error("Sentinel execution evidence must be private");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Map<string, SavedExecutionEvidence>();
    }
    throw error;
  }
  return parseBundle(await readSentinelChatSnapshot(path));
}

function parseBundle(data: unknown) {
  const records = new Map<string, SavedExecutionEvidence>();
  if (!Array.isArray(data)) {
    throw new Error("Invalid Sentinel execution evidence");
  }
  for (const row of data) {
    const payload = normalizeApprovedPayload(row?.payload);
    if (
      !payload ||
      !isDeepStrictEqual(payload, row.payload) ||
      (row.role !== "delegated" && row.role !== "scheduled") ||
      typeof row.runId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(row.runId) ||
      !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 ||
      typeof row.receiptId !== "string" ||
      !/^execution-trace:[a-f0-9]{64}$/.test(row.receiptId) ||
      records.has(row.receiptId) ||
      (row.classification !== "PUBLIC" && row.classification !== "INTERNAL") ||
      typeof row.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(row.recordedAt)) ||
      row.resultSha256 !== executionEvidenceDigest(payload) ||
      Object.keys(row).length !== 8
    ) throw new Error("Invalid Sentinel execution evidence record");
    records.set(row.receiptId, row);
  }
  return records;
}

function savedExecutionEvidence(
  step: ExecutionTraceReceipt,
  payload: ExecutionTraceApprovedPayload,
): SavedExecutionEvidence {
  if (step.classification !== "PUBLIC" && step.classification !== "INTERNAL") {
    throw new Error("Execution evidence exceeds Sentinel classification");
  }
  return {
    role: step.scope.role,
    runId: step.scope.runId,
    ordinal: step.ordinal,
    receiptId: step.id,
    resultSha256: executionEvidenceDigest(payload),
    classification: step.classification,
    recordedAt: step.recordedAt,
    payload,
  };
}

function matchesSource(
  record: SavedExecutionEvidence | undefined,
  { source, recordedAt }: SourceReference,
) {
  return !!record && record.role === source.role &&
    record.runId === source.runId &&
    record.ordinal === source.ordinal &&
    record.receiptId === source.receiptId &&
    record.resultSha256 === source.resultSha256 &&
    record.recordedAt === recordedAt;
}

/** Called while holding the case publication lock. */
export async function retainCaseExecutionEvidence(
  path: string,
  step: ExecutionTraceReceipt,
  payload: ExecutionTraceApprovedPayload,
) {
  const bundlePath = join(dirname(path), sentinelExecutionEvidenceFile);
  const bundle = await readBundle(bundlePath);
  const record = savedExecutionEvidence(step, payload);
  const prior = bundle.get(record.receiptId);
  if (prior) {
    if (!isDeepStrictEqual(prior, record)) {
      throw new Error("Execution evidence identity changed");
    }
    return;
  }
  bundle.set(record.receiptId, record);
  await publishSentinelInput(bundlePath, [...bundle.values()]);
}

function sourceReference(
  node: GraphNode | undefined,
): SourceReference | undefined {
  if (node?.kind !== "evidence" || !node.executionSource) return;
  const { recordedAt, ...source } = node.executionSource;
  const observedAt = recordedAt ?? node.controlVerification?.observedAt;
  return observedAt ? { source, recordedAt: observedAt } : undefined;
}

/** Match a retained source under the synchronous finding write lock. */
export function retainedControlSources(path: string) {
  try {
    const bundle = join(dirname(path), sentinelExecutionEvidenceFile);
    const info = Deno.lstatSync(bundle);
    assertOperatorSourceSnapshotInfo(info);
    if ((info.mode ?? 0) & 0o077 || info.size > MAX_SNAPSHOT_BYTES) return;
    using file = Deno.openSync(bundle, { read: true });
    const opened = file.statSync();
    assertOperatorSourceSnapshotInfo(opened);
    if (
      (opened.mode ?? 0) & 0o077 || opened.size > MAX_SNAPSHOT_BYTES ||
      info.dev !== opened.dev || info.ino !== opened.ino
    ) return;
    const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = file.readSync(bytes.subarray(length));
      if (count === null) break;
      length += count;
    }
    if (length === bytes.length) return;
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, length));
    const records = parseBundle(JSON.parse(text));
    return (node: GraphNode) => {
      const ref = sourceReference(node);
      if (!ref) return;
      const saved = records.get(ref.source.receiptId);
      return matchesSource(saved, ref) ? saved?.payload : undefined;
    };
  } catch {
    return undefined;
  }
}

function findSources(
  assessment: string,
  revisions: readonly number[],
  graph: unknown,
) {
  const refs = new Map<string, SourceReference>();
  const snapshots = [
    loadSentinelGraph(graph).snapshot(),
    ...revisions.map((revision) =>
      readSentinelAssessmentRevision(assessment, revision)?.result.sharedGraph
        .snapshot
    ),
  ];
  for (const snapshot of snapshots) {
    for (const node of snapshot?.nodes ?? []) {
      const ref = sourceReference(node);
      if (!ref) continue;
      const previous = refs.get(ref.source.receiptId);
      if (previous && !isDeepStrictEqual(previous, ref)) {
        throw new Error("Conflicting execution evidence");
      }
      refs.set(ref.source.receiptId, ref);
    }
  }
  return refs;
}

function findWorkspaceSource(baseDir: string, ref: SourceReference) {
  const { source } = ref;
  const journal = openExecutionTraces(join(baseDir, "execution-traces.db"));
  try {
    const run = journal.readRun(source.role, source.runId, "INTERNAL");
    if (!run) return;
    const step = journal.inspect(run.scope, source.ordinal, "INTERNAL");
    const payload = journal.readApprovedPayload(
      run.scope,
      source.ordinal,
      "INTERNAL",
    );
    if (!step || !payload) return;
    const record = savedExecutionEvidence(step, payload);
    return matchesSource(record, ref) ? record : undefined;
  } finally {
    journal.close();
  }
}

export async function stageCaseExecutionEvidence(
  baseDir: string,
  livePath: string,
  directory: string,
  assessment: string,
  revisions: readonly number[],
  graph: unknown,
) {
  const refs = findSources(assessment, revisions, graph);
  if (!refs.size) return;
  const saved = await readBundle(
    join(dirname(livePath), sentinelExecutionEvidenceFile),
  );
  const records = [];
  for (const ref of refs.values()) {
    const record = saved.get(ref.source.receiptId) ??
      findWorkspaceSource(baseDir, ref);
    if (!matchesSource(record, ref)) {
      throw new Error("Cited execution evidence is unavailable");
    }
    records.push(record);
  }
  const sourcePath = join(directory, sentinelExecutionEvidenceFile);
  await publishSentinelInput(sourcePath, records);
  return { name: sentinelExecutionEvidenceFile, sourcePath };
}

export async function validateCaseExecutionEvidence(
  path: string | undefined,
  assessment: string,
  revisions: readonly number[],
  graph: unknown,
) {
  const refs = findSources(assessment, revisions, graph);
  const saved = path === undefined ? new Map() : await readBundle(path);
  if (
    saved.size !== refs.size ||
    [...refs].some(([id, ref]) => !matchesSource(saved.get(id), ref))
  ) {
    throw new Error("Archive is missing exact case execution evidence");
  }
}

export async function readCaseExecutionEvidence(
  baseDir: string,
  path: string,
  revision: number,
  nodeId: string,
  assignedAsset?: string,
) {
  const state = readSentinelAssessmentRevision(path, revision);
  const snapshot = state?.result.sharedGraph.snapshot;
  if (
    assignedAsset &&
    !snapshot?.edges.some(({ from, to, relation }) =>
      from === nodeId && to === assignedAsset && relation === "observed_on"
    )
  ) return;
  const node = snapshot?.nodes.find(({ id }) => id === nodeId);
  const ref = sourceReference(node);
  if (!ref) return;
  const records = await readBundle(
    join(dirname(path), sentinelExecutionEvidenceFile),
  );
  const saved = records.get(ref.source.receiptId) ??
    findWorkspaceSource(baseDir, ref);
  return matchesSource(saved, ref) ? saved : undefined;
}
