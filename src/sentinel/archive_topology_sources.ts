/** Retain only source snapshots cited by the archived case run. */
import { join } from "@std/path";
import { readSentinelAssessmentRevision } from "./assessment_store.ts";
import {
  digestSentinelSnapshot,
  maxSentinelArchivedTopologyBytes,
  readArchivedSentinelSnapshot,
  sentinelArchivedTopologyFile,
} from "./shared_inventory.ts";
import { loadSentinelGraph } from "./graph.ts";

const maxSources = 128;

function references(path: string, revisions: readonly number[]) {
  const result = new Map<string, { caseId: string; digest: string }>();
  for (const revision of revisions) {
    const graph = readSentinelAssessmentRevision(path, revision)?.result
      .sharedGraph.snapshot;
    for (const node of graph?.nodes ?? []) {
      if (node.kind !== "evidence") continue;
      for (
        const { caseId, snapshotDigest: digest } of node.relationshipSources ??
          []
      ) {
        if (digest) {
          result.set(JSON.stringify([caseId, digest]), { caseId, digest });
        }
      }
    }
  }
  if (result.size > maxSources) {
    throw new Error("Too many archived topology sources");
  }
  return result;
}

export async function stageArchivedTopologySources(
  baseDir: string,
  directory: string,
  snapshotPath: string,
  revisions: readonly number[],
  livePath: string,
) {
  const cited = references(snapshotPath, revisions);
  if (!cited.size) return;
  const entries: string[] = [];
  const utf8 = new TextEncoder();
  let bytes = 2;
  for (const { caseId, digest } of cited.values()) {
    const snapshot = await readArchivedSentinelSnapshot(
      baseDir,
      caseId,
      digest,
      livePath,
    );
    const entry = JSON.stringify({ caseId, digest, snapshot });
    bytes += utf8.encode(entry).byteLength + (entries.length ? 1 : 0);
    if (bytes > maxSentinelArchivedTopologyBytes) {
      throw new Error("Archived topology source bundle exceeds its size limit");
    }
    entries.push(entry);
  }
  const sourcePath = join(directory, sentinelArchivedTopologyFile);
  await Deno.writeTextFile(sourcePath, `[${entries.join(",")}]`, {
    mode: 0o600,
    createNew: true,
  });
  return { name: sentinelArchivedTopologyFile, sourcePath };
}

export async function validateArchivedTopologySources(
  sourcePath: string,
  snapshotPath: string,
  revisions: readonly number[],
) {
  if ((await Deno.stat(sourcePath)).size > maxSentinelArchivedTopologyBytes) {
    throw new Error("Archived topology source bundle exceeds its size limit");
  }
  const entries = JSON.parse(await Deno.readTextFile(sourcePath));
  const cited = references(snapshotPath, revisions);
  if (!Array.isArray(entries) || entries.length !== cited.size) {
    throw new Error("Invalid archived topology source bundle");
  }
  for (const entry of entries) {
    if (
      !entry || !cited.delete(JSON.stringify([entry.caseId, entry.digest])) ||
      digestSentinelSnapshot(loadSentinelGraph(entry.snapshot).snapshot()) !==
        entry.digest
    ) {
      throw new Error("Invalid archived topology source");
    }
  }
}
