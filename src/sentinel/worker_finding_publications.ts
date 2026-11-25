/** Durable operator approvals backing the shared Sentinel finding projections. */
import { dirname, join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { type GraphNode, loadSentinelGraph } from "./graph.ts";
import {
  assertOperatorSourceDirectoryInfo,
  assertOperatorSourceSnapshotInfo,
} from "./source_snapshot_lock.ts";

export const sentinelWorkerFindingPublicationFile =
  "sentinel-finding-publications.json";
const limit = 256;
const maxBytes = 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;

type PublishedFinding = Extract<GraphNode, { kind: "finding" }>;
type EvidenceNode = Extract<GraphNode, { kind: "evidence" }>;
type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

export interface SentinelWorkerFindingPublication {
  readonly requestId: string;
  readonly targetId: string;
  readonly finding: PublishedFinding;
  readonly evidence: EvidenceNode;
  readonly evidenceVersion: string;
  readonly policyVersion: number;
  readonly policyDigest: string | null;
  readonly approvedAt: string;
  readonly withdrawal?: {
    readonly requestId: string;
    readonly at: string;
    readonly revision: number;
    readonly runId: string;
  };
}

function canonicalTime(value: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

export function decodeSentinelWorkerFindingPublications(
  value: unknown,
  caseId: string,
): SentinelWorkerFindingPublication[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("Invalid Sentinel finding publication manifest");
  }
  const distinct = new Set<string>();
  const requests = new Set<string>();
  return value.map((row: SentinelWorkerFindingPublication) => {
    if (!row || typeof row !== "object") {
      throw new Error("Invalid Sentinel finding publication");
    }
    const {
      finding,
      evidence,
      targetId,
      requestId,
      evidenceVersion,
      approvedAt,
      withdrawal,
      policyVersion,
      policyDigest,
    } = row;
    const source = finding?.workerFindingSource;
    if (
      !source || source.caseId !== caseId ||
      typeof targetId !== "string" || !targetId.trim() ||
      targetId.length > 4096 || targetId.includes("\0") ||
      typeof requestId !== "string" || !uuid.test(requestId) ||
      typeof evidenceVersion !== "string" || !digest.test(evidenceVersion) ||
      !Number.isSafeInteger(policyVersion) || policyVersion < 0 ||
      (policyVersion === 0
        ? policyDigest !== null
        : typeof policyDigest !== "string" || !digest.test(policyDigest)) ||
      !canonicalTime(approvedAt) || distinct.has(finding.id) ||
      requests.has(requestId) ||
      evidence?.id !==
        `published-finding-evidence:${
          finding.id.slice("worker-finding:".length)
        }` ||
      (withdrawal !== undefined && (!withdrawal ||
        !uuid.test(withdrawal.requestId) ||
        withdrawal.requestId === requestId ||
        requests.has(withdrawal.requestId) || !canonicalTime(withdrawal.at) ||
        !uuid.test(withdrawal.runId) ||
        !Number.isSafeInteger(withdrawal.revision) ||
        withdrawal.revision < 1 || withdrawal.at < approvedAt ||
        Object.keys(withdrawal).length !== 4)) ||
      Object.keys(row).length !== (withdrawal === undefined ? 8 : 9)
    ) throw new Error("Invalid Sentinel finding publication binding");
    const nodes =
      loadSentinelGraph({ version: 1, nodes: [finding, evidence], edges: [] })
        .snapshot().nodes;
    if (
      !isDeepStrictEqual(nodes, [finding, evidence]) ||
      finding.label.length > 256 || evidence.label.length > 512 ||
      Object.keys(evidence).length !== 3 ||
      redactCredentialText(JSON.stringify(row)) !== JSON.stringify(row)
    ) {
      throw new Error("Invalid Sentinel finding publication projection");
    }
    distinct.add(finding.id);
    requests.add(requestId);
    if (withdrawal) requests.add(withdrawal.requestId);
    return row;
  });
}

export function readSentinelWorkerFindingPublications(
  path: string,
  caseId: string,
) {
  const file = join(dirname(path), sentinelWorkerFindingPublicationFile);
  try {
    const info = Deno.lstatSync(file);
    assertOperatorSourceSnapshotInfo(info);
    if (info.size > maxBytes || ((info.mode ?? 0) & 0o077) !== 0) {
      throw new Error("Invalid Sentinel finding publication file");
    }
    return decodeSentinelWorkerFindingPublications(
      JSON.parse(Deno.readTextFileSync(file)),
      caseId,
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

/** Caller holds the source assessment write lock. */
export function writeSentinelWorkerFindingPublications(
  path: string,
  caseId: string,
  rows: readonly SentinelWorkerFindingPublication[],
) {
  decodeSentinelWorkerFindingPublications(rows, caseId);
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  if (bytes.length > maxBytes) {
    throw new Error("Sentinel finding publication manifest is full");
  }
  const directory = dirname(path);
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
  const temporary = Deno.makeTempFileSync({
    dir: directory,
    prefix: ".finding-publications-",
  });
  try {
    {
      using file = Deno.openSync(temporary, { write: true });
      let offset = 0;
      while (offset < bytes.length) {
        const written = file.writeSync(bytes.subarray(offset));
        if (written === 0) {
          throw new Error("Finding publication write made no progress");
        }
        offset += written;
      }
      file.syncSync();
    }
    Deno.renameSync(
      temporary,
      join(directory, sentinelWorkerFindingPublicationFile),
    );
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch {
      // The manifest replacement may already have committed.
    }
    throw error;
  }
}

export function applySentinelWorkerFindingPublications(
  snapshot: Snapshot,
  publications: readonly SentinelWorkerFindingPublication[],
): Snapshot {
  const assets = new Set(
    snapshot.nodes.filter(({ kind }) => kind === "asset").map(({ id }) => id),
  );
  const used = new Set(snapshot.nodes.map(({ id }) => id));
  const nodes = [...snapshot.nodes];
  const edges = [...snapshot.edges];
  for (const row of publications) {
    const { finding, evidence, targetId, withdrawal } = row;
    if (
      withdrawal || !assets.has(targetId) || used.has(finding.id) ||
      used.has(evidence.id)
    ) continue;
    used.add(finding.id);
    used.add(evidence.id);
    nodes.push(finding, evidence);
    edges.push(
      { from: finding.id, relation: "affects", to: targetId },
      { from: evidence.id, relation: "supports", to: finding.id },
    );
  }
  return nodes.length === snapshot.nodes.length
    ? snapshot
    : loadSentinelGraph({ ...snapshot, nodes, edges }).snapshot();
}
