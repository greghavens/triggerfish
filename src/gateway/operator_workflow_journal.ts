/** Private metadata-only journal for admitted ordinary operator workflows. */
/// <reference path="../sentinel/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type OperatorRunLinkInput,
  recordOperatorRunLink,
  withOperatorRunLinks,
} from "../core/operator_runs.ts";

export interface OperatorWorkflowJournalRow {
  readonly runId: string;
  readonly requestId: string;
  readonly planId: string;
  readonly fingerprint: string;
  readonly classification: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly stepStatuses: string;
}

export type OperatorWorkflowTraceInput =
  | {
    readonly event:
      | "admitted"
      | "started"
      | "paused"
      | "resumed"
      | "completed"
      | "failed"
      | "cancelled";
    readonly at: string;
  }
  | {
    readonly event: "step_started" | "step_completed" | "step_failed";
    readonly stepId: string;
    readonly at: string;
  };

export type OperatorWorkflowTraceEvent = OperatorWorkflowTraceInput & {
  readonly sequence: number;
};

export const MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS = 128;

const lifecycleEvents = new Set([
  "admitted",
  "started",
  "paused",
  "resumed",
  "completed",
  "failed",
  "cancelled",
]);
const stepEvents = new Set(["step_started", "step_completed", "step_failed"]);

function commit<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function privateDatabase(path: string) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const dir = Deno.lstatSync(parent);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o022) !== 0) {
    throw new Error("Operator workflow journal requires a trusted directory.");
  }
  try {
    Deno.openSync(absolute, { createNew: true, write: true, mode: 0o600 })
      .close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(absolute);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error(
      "Operator workflow journal requires a private regular file.",
    );
  }
  return new DatabaseSync(absolute);
}

export function createOperatorWorkflowJournal(path: string) {
  function query<T>(operation: (db: DatabaseSync) => T): T {
    const db = privateDatabase(path);
    try {
      db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
      );
      return operation(db);
    } finally {
      db.close();
    }
  }

  query((db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_admissions_v1 (
      sequence INTEGER PRIMARY KEY,
      runId TEXT NOT NULL UNIQUE,
      requestId TEXT NOT NULL UNIQUE,
      planId TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      classification TEXT NOT NULL,
      status TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      completedAt TEXT,
      stepStatuses TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_trace_v1 (
      runId TEXT NOT NULL REFERENCES workflow_admissions_v1(runId),
      sequence INTEGER NOT NULL,
      event TEXT NOT NULL,
      stepId TEXT,
      at TEXT NOT NULL,
      PRIMARY KEY(runId, sequence)
    );
  `)
  );
  const fields =
    "runId, requestId, planId, fingerprint, classification, status, startedAt, completedAt, stepStatuses";
  function byRequest(db: DatabaseSync, requestId: string) {
    return db.prepare(
      `SELECT ${fields} FROM workflow_admissions_v1 WHERE requestId = ?`,
    )
      .get(requestId) as OperatorWorkflowJournalRow | undefined;
  }
  function append(
    db: DatabaseSync,
    runId: string,
    event: OperatorWorkflowTraceInput,
  ) {
    const control = event.event === "paused" || event.event === "resumed";
    if (
      control && Number(
          db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_trace_v1
      WHERE runId = ? AND event IN ('paused', 'resumed')
    `).get(runId)?.count,
        ) >= MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS
    ) return;
    db.prepare(`
      INSERT INTO workflow_trace_v1 (runId, sequence, event, stepId, at)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
      FROM workflow_trace_v1 WHERE runId = ?
    `).run(
      runId,
      event.event,
      "stepId" in event ? event.stepId : null,
      event.at,
      runId,
    );
  }
  return {
    restorePaused(
      entry: OperatorWorkflowJournalRow,
      events: readonly OperatorWorkflowTraceEvent[],
    ) {
      return query((db) =>
        commit(db, () => {
          const inserted = db.prepare(`
            INSERT INTO workflow_admissions_v1 (${fields})
            VALUES (?, ?, ?, ?, ?, 'restored_paused', ?, NULL, ?)
            ON CONFLICT DO NOTHING
          `).run(
            entry.runId,
            entry.requestId,
            entry.planId,
            entry.fingerprint,
            entry.classification,
            entry.startedAt,
            entry.stepStatuses,
          );
          if (inserted.changes !== 1) return false;
          const insert = db.prepare(
            "INSERT INTO workflow_trace_v1 VALUES (?, ?, ?, ?, ?)",
          );
          for (const event of events) {
            insert.run(
              entry.runId,
              event.sequence,
              event.event,
              "stepId" in event ? event.stepId : null,
              event.at,
            );
          }
          return true;
        })
      );
    },
    admit(entry: OperatorWorkflowJournalRow, link?: {
      path: string;
      input: OperatorRunLinkInput;
    }) {
      return query((db) =>
        withOperatorRunLinks(db, link?.path, () =>
          commit(db, () => {
            const inserted = db.prepare(`
          INSERT INTO workflow_admissions_v1 (${fields})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(requestId) DO NOTHING
        `).run(
              entry.runId,
              entry.requestId,
              entry.planId,
              entry.fingerprint,
              entry.classification,
              entry.status,
              entry.startedAt,
              entry.completedAt,
              entry.stepStatuses,
            );
            if (inserted.changes === 1) {
              if (link) recordOperatorRunLink(db, link.input, "run_links");
              append(db, entry.runId, {
                event: "admitted",
                at: entry.startedAt,
              });
              return { admitted: true as const };
            }
            return {
              admitted: false as const,
              prior: byRequest(db, entry.requestId),
            };
          }))
      );
    },
    readRequest(requestId: string) {
      return query((db) => byRequest(db, requestId));
    },
    inspect(runId: string) {
      return query((db) =>
        db.prepare(
          `SELECT ${fields} FROM workflow_admissions_v1 WHERE runId = ?`,
        ).get(runId) as OperatorWorkflowJournalRow | undefined
      );
    },
    list(limit: number) {
      return query((db) =>
        db.prepare(`
        SELECT ${fields} FROM workflow_admissions_v1 ORDER BY sequence DESC LIMIT ?
      `).all(limit) as unknown as OperatorWorkflowJournalRow[]
      );
    },
    cancel(runId: string, at: string): boolean {
      return query((db) =>
        commit(db, () => {
          const result = db.prepare(`
            UPDATE workflow_admissions_v1 SET status = 'cancelled', completedAt = ?
            WHERE runId = ? AND completedAt IS NULL
              AND status IN ('running', 'paused', 'restored_paused')
          `).run(at, runId);
          if (result.changes !== 1) return false;
          append(db, runId, { event: "cancelled", at });
          return true;
        })
      );
    },
    update(
      runId: string,
      status: string,
      completedAt: string | null,
      stepStatuses: string,
      event: OperatorWorkflowTraceInput,
    ) {
      query((db) =>
        commit(db, () => {
          const changed = db.prepare(`
        UPDATE workflow_admissions_v1 SET status = ?, completedAt = ?, stepStatuses = ?
        WHERE runId = ? AND completedAt IS NULL
      `).run(status, completedAt, stepStatuses, runId);
          if (changed.changes === 1) append(db, runId, event);
        })
      );
    },
    traces(
      runId: string,
      fingerprint: string,
      after: number,
      limit: number,
      term?: string,
    ) {
      return query((db) => {
        if (
          !db.prepare(
            "SELECT 1 FROM workflow_admissions_v1 WHERE runId = ? AND fingerprint = ?",
          ).get(runId, fingerprint)
        ) return undefined;
        if (
          after > 0 &&
          !db.prepare(
            "SELECT 1 FROM workflow_trace_v1 WHERE runId = ? AND sequence = ?",
          ).get(runId, after)
        ) return undefined;
        const raw = db.prepare(`
          SELECT sequence, event, stepId, at FROM workflow_trace_v1
          WHERE runId = ? AND sequence > ?
            AND (? IS NULL OR instr(lower(event), ?) > 0 OR instr(lower(stepId), ?) > 0)
          ORDER BY sequence LIMIT ?
        `).all(runId, after, term ?? null, term ?? null, term ?? null, limit);
        if (
          raw.some(({ sequence, event, stepId, at }) =>
            typeof sequence !== "number" || !Number.isSafeInteger(sequence) ||
            typeof event !== "string" || typeof at !== "string" ||
            !Number.isFinite(Date.parse(at)) ||
            (stepEvents.has(event)
              ? typeof stepId !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(stepId)
              : !lifecycleEvents.has(event) || stepId !== null)
          )
        ) return undefined;
        return {
          events: raw.map(({ sequence, event, stepId, at }) => ({
            sequence: Number(sequence),
            event: String(event),
            at: String(at),
            ...(typeof stepId === "string" && { stepId }),
          } as OperatorWorkflowTraceEvent)),
          controlLimitReached: Number(
            db.prepare(`
            SELECT COUNT(*) AS count FROM workflow_trace_v1
            WHERE runId = ? AND event IN ('paused', 'resumed')
          `).get(runId)?.count,
          ) >= MAX_OPERATOR_WORKFLOW_CONTROL_EVENTS,
        };
      });
    },
  };
}
