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
import { readSentinelAssessmentRevision } from "./assessment_store.ts";
import { readSentinelChatSnapshot } from "./chat_mode.ts";
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

export const executionEvidenceDigest = (
  payload: ExecutionTraceApprovedPayload,
) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

async function readBundle(path: string) {
  const records = new Map<string, SavedExecutionEvidence>();
  try {
    const info = await Deno.lstat(path);
    assertOperatorSourceSnapshotInfo(info);
    if ((info.mode ?? 0) & 0o077) {
      throw new Error("Sentinel execution evidence must be private");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return records;
    throw error;
  }
  const data = await readSentinelChatSnapshot(path);
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
