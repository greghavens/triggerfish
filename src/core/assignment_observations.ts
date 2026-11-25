/** Committed assignment evidence, independently of the producer's completion. */
/// <reference path="../sentinel/sqlite_types.d.ts" />
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface ObservationSource {
  readonly revision: string;
  readonly taskId: string;
  readonly targetId: string;
  readonly evidenceRevision: number;
  readonly stepIndex: number;
}

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

/** Validate publication authority and payload before calling within a write transaction. */
export function createAssignmentObservationJournal<T>(
  db: DatabaseSync,
  table: string,
  assignments: string,
  prefix: string,
  decodeReceipt: (raw: unknown, revision: number) => T | undefined,
) {
  if (
    ![table, assignments].every((name) => /^[a-z][a-z0-9_]*$/.test(name)) ||
    !/^[a-z][a-z0-9-]*$/.test(prefix)
  ) {
    throw new Error("Invalid assignment observation journal");
  }
  const exists = () =>
    !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table);
  const hasPublicationStep = () =>
    db.prepare(`PRAGMA table_info(${table})`).all()
      .some(({ name }) => name === "publicationStepIndex");

  function decode(row: Row) {
    const evidenceRevision = Number(row.evidenceRevision);
    const receipt = decodeReceipt(
      JSON.parse(String(row.receipt)),
      evidenceRevision,
    );
    if (receipt === undefined) {
      throw new Error("Invalid committed assignment observation");
    }
    return {
      id: String(row.id),
      taskId: String(row.taskId),
      targetId: String(row.targetId),
      evidenceRevision,
      stepIndex: Number(row.stepIndex),
      receipt,
    };
  }

  return {
    publish(source: ObservationSource, receipt: T) {
      const { revision, taskId, targetId, evidenceRevision, stepIndex } =
        source;
      const id = `${prefix}:${
        createHash("sha256").update(JSON.stringify([
          revision,
          taskId,
          targetId,
          evidenceRevision,
          stepIndex,
          receipt,
        ])).digest("hex")
      }`;
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        taskId TEXT NOT NULL REFERENCES ${assignments}(id),
        targetId TEXT NOT NULL,
        evidenceRevision INTEGER NOT NULL,
        stepIndex INTEGER NOT NULL,
        receipt TEXT NOT NULL,
        UNIQUE (revision, taskId, evidenceRevision)
      );
      CREATE INDEX IF NOT EXISTS ${table}_by_scope
        ON ${table}(revision, targetId, evidenceRevision);`);
      const saved = db.prepare(`INSERT OR IGNORE INTO ${table}
        (id, revision, taskId, targetId, evidenceRevision, stepIndex, receipt)
        VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
        id,
        revision,
        taskId,
        targetId,
        evidenceRevision,
        stepIndex,
        JSON.stringify(receipt),
      );
      const row = saved ?? db.prepare(`SELECT * FROM ${table}
        WHERE id = ? AND revision = ? AND taskId = ?`).get(
        id,
        revision,
        taskId,
      );
      return row && { observation: decode(row), created: !!saved };
    },
    list(
      revision: string,
      offset: number,
      limit: number,
      filter?: {
        readonly evidenceRevision?: number;
        readonly targetIds?: readonly string[];
        readonly excludeTaskId?: string;
      },
    ) {
      if (!exists()) return [];
      const number = filter?.evidenceRevision ?? null;
      const targets = filter?.targetIds
        ? JSON.stringify(filter.targetIds)
        : null;
      const excluded = filter?.excludeTaskId ?? null;
      return db.prepare(`SELECT * FROM ${table} WHERE revision = ?
        AND (? IS NULL OR evidenceRevision = ?)
        AND (? IS NULL OR targetId IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR taskId != ?)
        ORDER BY rowid LIMIT ? OFFSET ?`).all(
        revision,
        number,
        number,
        targets,
        targets,
        excluded,
        excluded,
        limit,
        offset,
      ).map(decode);
    },
    readPeer(
      revision: string,
      id: string,
      targetId: string,
      evidenceRevision: number,
      excludedTaskId: string,
    ) {
      if (!exists()) return;
      const row = db.prepare(
        `SELECT * FROM ${table} WHERE revision = ? AND id = ?
        AND targetId = ? AND evidenceRevision = ? AND taskId != ?`,
      )
        .get(revision, id, targetId, evidenceRevision, excludedTaskId);
      return row && decode(row);
    },
    readById(revision: string, id: string) {
      if (!exists()) return;
      const row = db.prepare(
        `SELECT * FROM ${table} WHERE revision = ? AND id = ?`,
      )
        .get(revision, id);
      return row && decode(row);
    },
    readByAssignment(
      revision: string,
      taskId: string,
      evidenceRevision: number,
    ) {
      if (!exists()) return;
      const row = db.prepare(`SELECT * FROM ${table}
        WHERE revision = ? AND taskId = ? AND evidenceRevision = ?`)
        .get(revision, taskId, evidenceRevision);
      return row && decode(row);
    },
    attachPublicationStep(
      revision: string,
      taskId: string,
      evidenceRevision: number,
      id: string,
      index: number,
    ) {
      if (!exists()) return;
      if (!hasPublicationStep()) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN publicationStepIndex INTEGER`);
      }
      db.prepare(`UPDATE ${table} SET publicationStepIndex = ?
        WHERE revision = ? AND taskId = ? AND evidenceRevision = ?
          AND id = ? AND stepIndex < ? AND publicationStepIndex IS NULL`)
        .run(index, revision, taskId, evidenceRevision, id, index);
    },
    readByPublicationStep(revision: string, taskId: string, index: number) {
      if (!hasPublicationStep()) return;
      const row = db.prepare(`SELECT * FROM ${table}
        WHERE revision = ? AND taskId = ? AND publicationStepIndex = ?
          AND stepIndex < publicationStepIndex`).get(revision, taskId, index);
      return row && decode(row);
    },
  };
}
