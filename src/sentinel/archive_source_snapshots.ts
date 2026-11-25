/** Retain only source snapshots cited by the archived case run. */
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { readSentinelAssessmentRevision } from "./assessment_store.ts";
import {
  digestSentinelSnapshot,
  maxSentinelArchivedTopologyBytes,
  readArchivedSentinelSnapshot,
  sentinelArchivedFindingSourcesFile,
  sentinelArchivedTopologyFile,
  sentinelArchivedTraceSourcesFile,
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

interface AdaptiveScope {
  readonly path: string;
  readonly runId: string;
  readonly revision: number;
  readonly traces?: boolean;
}

function adaptiveReferences(scope: AdaptiveScope) {
  const result = new Map<string, { caseId: string; digest: string }>();
  const db = new DatabaseSync(scope.path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE name = 'adaptive_evidence_revisions' AND type = 'table'",
      ).get() ||
      (scope.traces
        ? !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE name = 'adaptive_note_steps' AND type = 'table'",
        ).get()
        : !db.prepare(
          "SELECT 1 FROM pragma_table_info('adaptive_tasks') WHERE name = 'plannerRound'",
        ).get())
    ) return result;
    const query = scope.traces
      ? `
      SELECT DISTINCT json_extract(source.value, '$.caseId') AS caseId,
        json_extract(source.value, '$.snapshotDigest') AS digest
      FROM adaptive_evidence_revisions AS revision
      JOIN adaptive_notes AS note USING (revision)
      JOIN adaptive_note_steps AS trace ON trace.note_id = note.rowid,
        json_each(trace.steps) AS step,
        json_each(step.value, '$.sourceSnapshots') AS source
      WHERE revision.goalId = ? AND revision.evidenceNumber <= ?
        AND note.taskId IS NOT NULL
        AND json_extract(step.value, '$.outcome') = 'returned'
        AND json_type(source.value, '$.snapshotDigest') = 'text'
      LIMIT ?
    `
      : `
      SELECT DISTINCT json_extract(citation.value, '$.sourceCaseId') AS caseId,
        json_extract(citation.value, '$.snapshotDigest') AS digest
      FROM adaptive_evidence_revisions AS revision
      JOIN adaptive_tasks AS task USING (revision),
        json_each(task.plannerRound, '$.peerFindingCitations') AS citation
      WHERE revision.goalId = ? AND revision.evidenceNumber <= ?
      LIMIT ?
    `;
    const rows = db.prepare(query).all(
      scope.runId,
      scope.revision,
      maxSources + 1,
    );
    if (rows.length > maxSources) {
      throw new Error("Too many archived adaptive sources");
    }
    for (const { caseId, digest } of rows) {
      if (typeof caseId !== "string" || typeof digest !== "string") {
        throw new Error("Invalid archived adaptive source reference");
      }
      result.set(JSON.stringify([caseId, digest]), { caseId, digest });
    }
    return result;
  } finally {
    db.close();
  }
}

export async function stageArchivedSourceSnapshots(
  baseDir: string,
  directory: string,
  snapshotPath: string,
  revisions: readonly number[],
  livePath: string,
  adaptive?: AdaptiveScope,
) {
  const cited = adaptive
    ? adaptiveReferences(adaptive)
    : references(snapshotPath, revisions);
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
      throw new Error("Archived source bundle exceeds its size limit");
    }
    entries.push(entry);
  }
  const name = adaptive?.traces
    ? sentinelArchivedTraceSourcesFile
    : adaptive
    ? sentinelArchivedFindingSourcesFile
    : sentinelArchivedTopologyFile;
  const sourcePath = join(directory, name);
  await Deno.writeTextFile(sourcePath, `[${entries.join(",")}]`, {
    mode: 0o600,
    createNew: true,
  });
  return { name, sourcePath };
}

export async function validateArchivedSourceSnapshots(
  sourcePath: string,
  snapshotPath: string,
  revisions: readonly number[],
  adaptive?: AdaptiveScope,
) {
  if ((await Deno.stat(sourcePath)).size > maxSentinelArchivedTopologyBytes) {
    throw new Error("Archived source bundle exceeds its size limit");
  }
  const entries = JSON.parse(await Deno.readTextFile(sourcePath));
  const cited = adaptive
    ? adaptiveReferences(adaptive)
    : references(snapshotPath, revisions);
  if (!Array.isArray(entries) || entries.length !== cited.size) {
    throw new Error("Invalid archived source bundle");
  }
  for (const entry of entries) {
    if (
      !entry || !cited.delete(JSON.stringify([entry.caseId, entry.digest])) ||
      digestSentinelSnapshot(loadSentinelGraph(entry.snapshot).snapshot()) !==
        entry.digest
    ) {
      throw new Error("Invalid archived source snapshot");
    }
  }
}
