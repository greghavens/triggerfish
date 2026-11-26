/** Stage the fixed empty graph for one reviewed linked case creation. */
import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import {
  listSentinelCaseIds,
  MAX_SENTINEL_NAMED_CASES,
  resolveSentinelCasePath,
} from "./cases.ts";
import {
  assertOperatorSourceDirectoryInfo,
  assertOperatorSourceSnapshotInfo,
} from "./source_snapshot_lock.ts";

const emptyGraph = JSON.stringify({ version: 1, nodes: [], edges: [] });
export const emptyLinkedSentinelGraphDigest = createHash("sha256")
  .update(emptyGraph).digest("hex");

function exists(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.lstatSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export function canCreateEmptyLinkedSentinelCase(
  baseDir: string,
  caseId: string,
): boolean {
  return caseId !== "main" &&
    !exists(dirname(resolveSentinelCasePath(baseDir, caseId))) &&
    listSentinelCaseIds(baseDir).length < MAX_SENTINEL_NAMED_CASES;
}

function paths(baseDir: string, caseId: string, approvalDigest: string) {
  if (caseId === "main" || !/^[a-f0-9]{64}$/.test(approvalDigest)) {
    throw new Error("Invalid linked Sentinel creation scope");
  }
  const live = resolveSentinelCasePath(baseDir, caseId);
  const stagingRoot = join(baseDir, "data", "sentinel-linked-staging");
  const info = exists(stagingRoot);
  if (info) assertOperatorSourceDirectoryInfo(info);
  const staged = join(stagingRoot, approvalDigest);
  return { live, staged, snapshot: join(staged, "sentinel.json") };
}

function exactStagedGraph(staged: string, snapshot: string) {
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(staged));
  const info = Deno.lstatSync(snapshot);
  assertOperatorSourceSnapshotInfo(info);
  if (
    info.size !== emptyGraph.length ||
    Deno.readTextFileSync(snapshot) !== emptyGraph
  ) {
    throw new Error("The staged Sentinel graph changed");
  }
}

/** Call under the source snapshot lock; the staged directory is never listed as a case. */
export function stageEmptyLinkedSentinelCase(
  baseDir: string,
  caseId: string,
  approvalDigest: string,
): string {
  const { live, staged, snapshot } = paths(baseDir, caseId, approvalDigest);
  if (!canCreateEmptyLinkedSentinelCase(baseDir, caseId)) {
    throw new Error("The Sentinel case identity is already in use");
  }
  Deno.mkdirSync(dirname(dirname(live)), { mode: 0o700, recursive: true });
  Deno.mkdirSync(dirname(staged), { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(dirname(staged)));
  if (!exists(staged)) Deno.mkdirSync(staged, { mode: 0o700 });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(staged));
  if (!exists(snapshot)) {
    Deno.writeTextFileSync(snapshot, emptyGraph, {
      createNew: true,
      mode: 0o600,
    });
  }
  exactStagedGraph(staged, snapshot);
  return snapshot;
}

/** Find the private staged snapshot when an approved start committed before publication. */
export function readStagedEmptyLinkedSentinelCase(
  baseDir: string,
  caseId: string,
  approvalDigest: string,
): string | undefined {
  const { staged, snapshot } = paths(baseDir, caseId, approvalDigest);
  if (!exists(staged)) return;
  exactStagedGraph(staged, snapshot);
  return snapshot;
}

/** Publish an already committed exact stage without replacing another case. */
export function publishEmptyLinkedSentinelCase(
  baseDir: string,
  caseId: string,
  approvalDigest: string,
): boolean {
  const { live, staged, snapshot } = paths(baseDir, caseId, approvalDigest);
  if (!canCreateEmptyLinkedSentinelCase(baseDir, caseId) || !exists(staged)) {
    return false;
  }
  exactStagedGraph(staged, snapshot);
  Deno.renameSync(staged, dirname(live));
  return true;
}
