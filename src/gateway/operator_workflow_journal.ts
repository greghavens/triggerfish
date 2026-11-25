/** Private metadata-only journal for admitted ordinary operator workflows. */
/// <reference path="../sentinel/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";

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
      db.exec("PRAGMA busy_timeout = 5000");
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
  return {
    admit(entry: OperatorWorkflowJournalRow) {
      return query((db) => {
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
        if (inserted.changes === 1) return { admitted: true as const };
        return {
          admitted: false as const,
          prior: byRequest(db, entry.requestId),
        };
      });
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
    update(
      runId: string,
      status: string,
      completedAt: string | null,
      stepStatuses: string,
    ) {
      query((db) =>
        db.prepare(`
        UPDATE workflow_admissions_v1 SET status = ?, completedAt = ?, stepStatuses = ?
        WHERE runId = ? AND completedAt IS NULL
      `).run(status, completedAt, stepStatuses, runId)
      );
    },
  };
}
