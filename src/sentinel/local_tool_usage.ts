/** Metadata-only counts for exact local Sentinel tool receipts. */
/// <reference path="../core/sqlite_types.d.ts" />
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { sentinelTrafficReadArgs } from "./traffic_recovery.ts";
import { parseSentinelPinnedFindingRead } from "./worker_goal_recovery.ts";

interface Step {
  readonly outcome: "returned" | "error";
  readonly ordinal: number;
}

export type SentinelLinkedUsageStep = Step & {
  readonly tool:
    | "sentinel_shared_topology_source"
    | "sentinel_shared_finding_source";
  readonly taskId: string;
  readonly target: string;
  readonly assignedTarget: string;
  readonly goalReceiptRead: {
    readonly args: Readonly<Record<string, string>>;
    readonly sha256: string;
  };
};

function trafficBinding(row: Record<string, unknown>, revision: number) {
  const args = sentinelTrafficReadArgs({
    revision: row.trafficRevision,
    evidenceId: row.trafficEvidence,
    digest: row.trafficDigest,
  });
  return args?.revision === revision && typeof row.trafficSha === "string" &&
      /^[a-f0-9]{64}$/.test(row.trafficSha)
    ? { args, sha256: row.trafficSha }
    : undefined;
}

export type SentinelTrafficUsageStep =
  & Step
  & {
    readonly tool: "sentinel_traffic_get";
    readonly trafficRead: NonNullable<ReturnType<typeof trafficBinding>>;
  }
  & (
    | { readonly plannerIdentity: string; readonly attempt: number }
    | { readonly taskId: string; readonly assignedTarget: string }
  );

export type SentinelLocalUsageStep =
  | SentinelLinkedUsageStep
  | SentinelTrafficUsageStep
  | (
    & Step
    & (
      | {
        readonly tool: "sentinel_graph_overview";
        readonly plannerIdentity: string;
        readonly attempt: number;
      }
      | {
        readonly tool: "sentinel_assigned_target";
        readonly taskId: string;
        readonly target: string;
      }
    )
  );

export function readSentinelLocalUsageSteps(
  snapshotPath: string,
  revision: number,
  runId: string,
  includeRetainedTopology = false,
  includeRetainedFindingSources = false,
  includeRetainedTrafficMetadata = false,
): readonly SentinelLocalUsageStep[] | undefined {
  const path = join(dirname(snapshotPath), "sentinel-adaptive.db");
  try {
    const file = Deno.lstatSync(path);
    if (!file.isFile || file.isSymlink || (file.nlink ?? 1) !== 1) return;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema = OFF; BEGIN");
    const table = (name: string) =>
      !!db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table'",
      ).get(name);
    if (!table("adaptive_evidence_revisions")) return [];
    const current = db.prepare(`
      SELECT revision, goalId FROM adaptive_evidence_revisions
      WHERE evidenceNumber = ? ORDER BY rowid DESC LIMIT 1
    `).get(revision);
    if (!current) return [];
    if (current.goalId !== runId || typeof current.revision !== "string") {
      return;
    }
    const key = current.revision;
    const retained: SentinelLocalUsageStep[] = [];
    const budget = 512;
    if (table("adaptive_model_reads") && table("adaptive_model_history")) {
      const rows = db.prepare(`
        SELECT trace.identity, trace.attempt, step.key AS ordinal,
          json_extract(step.value, '$.tool') AS tool,
          json_extract(step.value, '$.trafficRead.revision') AS trafficRevision,
          json_extract(step.value, '$.trafficRead.evidenceId') AS trafficEvidence,
          json_extract(step.value, '$.trafficRead.digest') AS trafficDigest,
          json_extract(step.value, '$.trafficRead.sha256') AS trafficSha,
          json_extract(step.value, '$.outcome') AS outcome
        FROM adaptive_model_reads trace
        JOIN adaptive_model_history history USING(identity, attempt)
        JOIN json_each(trace.plannerReads) step
        WHERE (trace.identity = ? OR substr(trace.identity, 1, length(?) + 1) = ? || ':')
          AND (json_extract(step.value, '$.tool') = 'sentinel_graph_overview'
            OR (? AND json_extract(step.value, '$.tool') = 'sentinel_traffic_get'
              AND json_extract(step.value, '$.outcome') = 'returned'))
        ORDER BY trace.identity, trace.attempt, ordinal LIMIT ?
      `).all(key, key, key, Number(includeRetainedTrafficMetadata), budget + 1);
      for (const row of rows) {
        if (
          typeof row.identity !== "string" ||
          !Number.isSafeInteger(row.attempt) ||
          typeof row.attempt !== "number" || row.attempt < 1 ||
          typeof row.ordinal !== "number" ||
          !Number.isSafeInteger(row.ordinal) ||
          (row.outcome !== "returned" && row.outcome !== "error")
        ) return;
        if (row.tool === "sentinel_traffic_get") {
          const trafficRead = trafficBinding(row, revision);
          if (!trafficRead) return;
          retained.push({
            tool: row.tool,
            plannerIdentity: row.identity,
            attempt: row.attempt,
            ordinal: row.ordinal,
            outcome: row.outcome,
            trafficRead,
          });
          continue;
        }
        retained.push({
          tool: "sentinel_graph_overview",
          plannerIdentity: row.identity,
          attempt: row.attempt,
          ordinal: row.ordinal,
          outcome: row.outcome,
        });
      }
    }
    if (retained.length > budget) return;
    const sources: string[] = [];
    if (table("adaptive_note_steps") && table("adaptive_model_reviews")) {
      sources.push(`
        SELECT task.id, task.nodeId, trace.steps, 3 AS priority
        FROM tasks task
        LEFT JOIN adaptive_model_reviews review ON review.taskId = task.id
        JOIN adaptive_notes note ON note.rowid = COALESCE(review.noteId, (
          SELECT MAX(candidate.rowid) FROM adaptive_notes candidate
          WHERE candidate.revision = task.revision AND candidate.taskId = task.id
            AND EXISTS (SELECT 1 FROM adaptive_events activity
              WHERE activity.revision = task.revision AND activity.taskId = task.id
                AND activity.event = 'model_review_completed' AND activity.at = candidate.at)
          GROUP BY candidate.at HAVING COUNT(*) = 1
          ORDER BY candidate.at DESC LIMIT 1
        ))
        JOIN adaptive_note_steps trace ON trace.note_id = note.rowid
        WHERE task.status = 'completed'`);
    }
    for (
      const [tableName, priority] of [
        ["adaptive_worker_progress", 2],
        ["adaptive_archived_worker_traces", 1],
      ] as const
    ) {
      if (table(tableName)) {
        sources.push(`
        SELECT task.id, task.nodeId, trace.steps, ${priority} AS priority
        FROM tasks task JOIN ${tableName} trace
          ON trace.revision = task.revision AND trace.taskId = task.id`);
      }
    }
    if (!sources.length) return retained;
    const rows = db.prepare(`
      WITH tasks AS (
        SELECT id, revision, nodeId, status FROM adaptive_tasks WHERE revision = ?
      ), batches AS (
        ${sources.join(" UNION ALL ")}
      ), selected AS (
        SELECT *, row_number() OVER (PARTITION BY id ORDER BY priority DESC) AS rank
        FROM batches
      )
      SELECT selected.id, selected.nodeId, step.key AS ordinal,
        json_extract(step.value, '$.tool') AS tool,
        json_extract(step.value, '$.target') AS target,
        json_extract(step.value, '$.outcome') AS outcome,
        json_extract(step.value, '$.goalReceiptRead.args.evidenceId') AS evidence,
        json_extract(step.value, '$.goalReceiptRead.args.sourceCase') AS source,
        json_extract(step.value, '$.goalReceiptRead.args.asset') AS localAsset,
        json_extract(step.value, '$.goalReceiptRead.args.sourceAsset') AS sourceAsset,
        json_extract(step.value, '$.goalReceiptRead.args.finding') AS findingId,
        json_extract(step.value, '$.goalReceiptRead.args.snapshotDigest') AS snapshotDigest,
        json_extract(step.value, '$.goalReceiptRead.sha256') AS digest,
        json_extract(step.value, '$.trafficRead.revision') AS trafficRevision,
        json_extract(step.value, '$.trafficRead.evidenceId') AS trafficEvidence,
        json_extract(step.value, '$.trafficRead.digest') AS trafficDigest,
        json_extract(step.value, '$.trafficRead.sha256') AS trafficSha
      FROM selected JOIN json_each(selected.steps) step
      WHERE selected.rank = 1
        AND (json_extract(step.value, '$.tool') = 'sentinel_assigned_target'
          OR (json_extract(step.value, '$.outcome') = 'returned' AND (
            (? AND json_extract(step.value, '$.tool') = 'sentinel_shared_topology_source')
            OR (? AND json_extract(step.value, '$.tool') = 'sentinel_shared_finding_source')
            OR (? AND json_extract(step.value, '$.tool') = 'sentinel_traffic_get')
          )))
      ORDER BY selected.id, ordinal LIMIT ?
    `).all(
      key,
      Number(includeRetainedTopology),
      Number(includeRetainedFindingSources),
      Number(includeRetainedTrafficMetadata),
      budget + 1 - retained.length,
    );
    for (const row of rows) {
      if (
        typeof row.id !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(row.id) ||
        typeof row.nodeId !== "string" || !row.nodeId ||
        typeof row.ordinal !== "number" || !Number.isSafeInteger(row.ordinal) ||
        (row.outcome !== "returned" && row.outcome !== "error")
      ) return;
      if (row.tool === "sentinel_traffic_get") {
        const trafficRead = trafficBinding(row, revision);
        if (!trafficRead) return;
        retained.push({
          tool: row.tool,
          taskId: row.id,
          assignedTarget: row.nodeId,
          ordinal: row.ordinal,
          outcome: row.outcome,
          trafficRead,
        });
        continue;
      }
      if (row.tool === "sentinel_shared_topology_source") {
        if (
          typeof row.target !== "string" ||
          !/^shared-topology:[a-f0-9]{64}$/.test(row.target) ||
          row.evidence !== row.target ||
          typeof row.source !== "string" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(row.source) ||
          typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
        ) return;
        retained.push({
          tool: row.tool,
          taskId: row.id,
          target: row.target,
          assignedTarget: row.nodeId,
          ordinal: row.ordinal,
          outcome: row.outcome,
          goalReceiptRead: {
            args: { evidenceId: row.target, sourceCase: row.source },
            sha256: row.digest,
          },
        });
        continue;
      }
      if (row.tool === "sentinel_shared_finding_source") {
        const args = parseSentinelPinnedFindingRead({
          asset: row.localAsset,
          sourceCase: row.source,
          sourceAsset: row.sourceAsset,
          finding: row.findingId,
          snapshotDigest: row.snapshotDigest,
        });
        if (
          !args || row.target !== args.finding ||
          typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)
        ) return;
        retained.push({
          tool: row.tool,
          taskId: row.id,
          target: args.finding,
          assignedTarget: row.nodeId,
          ordinal: row.ordinal,
          outcome: row.outcome,
          goalReceiptRead: { args, sha256: row.digest },
        });
        continue;
      }
      if (row.target != null && row.target !== row.nodeId) return;
      retained.push({
        tool: "sentinel_assigned_target",
        taskId: row.id,
        target: row.nodeId,
        ordinal: row.ordinal,
        outcome: row.outcome,
      });
    }
    return retained.length <= budget ? retained : undefined;
  } finally {
    db.close();
  }
}
