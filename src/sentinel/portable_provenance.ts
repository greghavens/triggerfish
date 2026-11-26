import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelOperatingConstraints,
} from "./assessment_store.ts";
import { sentinelOperatingConstraintsAllow } from "./operating_constraints.ts";
import {
  type AdaptiveProvenanceView,
  buildSentinelProvenance,
} from "./provenance.ts";
import type { readSentinelProvenanceNodeReference } from "./worker_goal_recovery.ts";

function retainedGraphTraceLinks(
  db: DatabaseSync,
  runId: string,
  revision: number,
  assignmentId: string,
  targetId: string,
): AdaptiveProvenanceView["tasks"] {
  const rows = db.prepare(`
    WITH mapping AS (
      SELECT revision, goalId FROM adaptive_evidence_revisions
      WHERE evidenceNumber = ? ORDER BY rowid DESC LIMIT 1
    )
    SELECT task.id, task.observation FROM mapping
    JOIN adaptive_tasks AS assigned ON assigned.revision = mapping.revision
      AND assigned.id = ? AND assigned.nodeId = ?
    JOIN adaptive_tasks AS task ON task.revision = mapping.revision
      AND task.nodeId = assigned.nodeId AND task.kind = 'trace'
    WHERE mapping.goalId = ? AND task.status = 'completed'
      AND task.plannerRound IS NULL AND task.observation IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM adaptive_events AS activity
        WHERE activity.revision = task.revision AND activity.taskId = task.id
          AND activity.event = 'cancelled'
      )
    ORDER BY task.rowid
  `).all(revision, assignmentId, targetId, runId);
  return rows.map(({ id, observation }) => ({
    id: String(id),
    kind: "trace",
    status: "completed",
    prerequisites: [],
    evidenceIds: [],
    observation: {
      relatedNodeIds: JSON.parse(String(observation)).relatedNodeIds,
    },
  }));
}

/** Check the whole saved page against the independent retained local graph. */
export function matchesPortableSentinelProvenanceNode(
  path: string,
  runId: string,
  revision: number,
  page: NonNullable<ReturnType<typeof readSentinelProvenanceNodeReference>>,
  text: string,
  adaptiveStore: DatabaseSync,
  assignmentId: string,
  targetId: string,
): boolean {
  const state = readSentinelAssessmentRevision(path, revision);
  if (state?.plan?.runId !== runId || !state.result) return false;
  const { node, offset = 0, limit = 10 } = page.args;
  const reviews = node.startsWith("finding:")
    ? readSentinelFindingReviews(path, revision)
    : undefined;
  const saved = JSON.parse(text);
  const matches = (adaptive?: AdaptiveProvenanceView) => {
    const record = buildSentinelProvenance(
      state.result,
      adaptive,
      undefined,
      undefined,
      reviews,
    ).inspect(node);
    return record?.node.origin === "imported" &&
      record.connections.length === page.totalConnections &&
      isDeepStrictEqual(saved, {
        revision,
        node: record.node,
        offset,
        totalConnections: record.connections.length,
        nextOffset: page.nextOffset,
        connections: record.connections.slice(offset, offset + limit),
      });
  };
  if (matches()) return true;
  const snapshot = state.result.sharedGraph.snapshot;
  const constraints = readSentinelOperatingConstraints(path, runId)
    ?.constraints;
  if (
    !snapshot || !sentinelOperatingConstraintsAllow(
      constraints,
      { kind: "review_evidence", nodeId: targetId },
      snapshot,
    )
  ) return false;
  return matches({
    goal: { id: runId, label: "Defensive assessment" },
    tasks: retainedGraphTraceLinks(
      adaptiveStore,
      runId,
      revision,
      assignmentId,
      targetId,
    ),
  });
}
