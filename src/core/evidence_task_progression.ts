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

/** Coalesce planner wakeups and retry the latest inputs when a cooldown ends. */
export function createEvidencePlanningGate(
  wake: () => void,
  cooldownMs: number,
  now = Date.now,
) {
  let seen: string | undefined;
  let lastStart: { time: number; revision: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const defer = (delay: number) => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      wake();
    }, Math.max(1, delay));
    Deno.unrefTimer(timer);
  };

  return {
    ready(round: string, revision: number, urgent = false) {
      if (round === seen) {
        clear();
        return false;
      }
      if (!lastStart || urgent || revision > lastStart.revision) {
        clear();
        return true;
      }
      const delay = cooldownMs - (now() - lastStart.time);
      if (delay <= 0) {
        clear();
        return true;
      }
      defer(delay);
      return false;
    },
    started(revision: number) {
      clear();
      lastStart = { time: now(), revision };
    },
    settled(round: string) {
      seen = round;
    },
    defer,
    clear,
  };
}
