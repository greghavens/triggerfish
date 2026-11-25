/** Commit an evidence-qualified assignment without dispatching a worker. */
/// <reference path="../sentinel/sqlite_types.d.ts" />
import type { DatabaseSync } from "node:sqlite";

interface EvidenceSatisfaction {
  readonly revision: string;
  readonly taskId: string;
  readonly observation: string;
  readonly receipt: object;
}

/** Call in the queue write transaction after verifying the evidence and prerequisites. */
export function createEvidenceTaskSettler(
  db: DatabaseSync,
  assignments: string,
  maxObservationBytes: number,
) {
  if (
    !/^[a-z][a-z0-9_]*$/.test(assignments) ||
    !Number.isSafeInteger(maxObservationBytes) || maxObservationBytes < 1
  ) {
    throw new Error("Invalid evidence-driven assignment queue configuration");
  }
  return ({ revision, taskId, observation, receipt }: EvidenceSatisfaction) => {
    const budget = db.prepare(
      `SELECT COALESCE(SUM(length(CAST(observation AS BLOB))), 0) AS bytes
      FROM ${assignments} WHERE revision = ?`,
    ).get(revision);
    if (
      Number(budget?.bytes) + new TextEncoder().encode(observation).length >
        maxObservationBytes
    ) return false;
    return db.prepare(`UPDATE ${assignments}
      SET status = 'completed', observation = ?, factSatisfaction = ?
      WHERE revision = ? AND id = ? AND status = 'queued' AND attempts = 0
        AND factSatisfaction IS NULL`)
      .run(observation, JSON.stringify(receipt), revision, taskId).changes ===
      1;
  };
}
