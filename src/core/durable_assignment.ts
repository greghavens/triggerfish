/** Storage and identity primitives for durable assignment execution. */
/// <reference path="../sentinel/sqlite_types.d.ts" />
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentTurnCheckpoint } from "./types/orchestrator.ts";

export function assignmentRecoveryKey(sessionId: string, executionId: string) {
  return createHash("sha256").update(JSON.stringify([sessionId, executionId]))
    .digest("hex");
}

interface CheckpointScope {
  readonly revision: string;
  readonly taskId: string;
  readonly evidenceRevision: number;
}

type Checkpoint = AgentTurnCheckpoint & {
  readonly controlClaimSha256?: string;
};
const checkpointVersion = 1;
const checkpointTtlMs = 24 * 60 * 60 * 1000;
const maxCheckpointBytes = 24 * 1024;

/** Use within the caller's transaction, after validating the assignment lease. */
export function createAssignmentCheckpointJournal(
  db: DatabaseSync,
  table: string,
  assignments: string,
  now = Date.now,
) {
  if (![table, assignments].every((name) => /^[a-z][a-z0-9_]*$/.test(name))) {
    throw new Error("Invalid assignment checkpoint table name");
  }
  const hasTable = () =>
    !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table);
  function encode(checkpoint: Checkpoint) {
    const encoded = JSON.stringify(checkpoint);
    return new TextEncoder().encode(encoded).length <= maxCheckpointBytes
      ? encoded
      : undefined;
  }

  return {
    hasTable,
    read(scope: CheckpointScope, promptSha256: string): Checkpoint | undefined {
      if (!hasTable()) return;
      const row = db.prepare(`SELECT checkpoint FROM ${table}
        WHERE revision = ? AND taskId = ? AND evidenceRevision = ?
          AND promptSha256 = ? AND expiresAt > ? AND version = ?`).get(
        scope.revision,
        scope.taskId,
        scope.evidenceRevision,
        promptSha256,
        now(),
        checkpointVersion,
      );
      return typeof row?.checkpoint === "string"
        ? JSON.parse(row.checkpoint)
        : undefined;
    },
    write(
      scope: CheckpointScope,
      promptSha256: string,
      checkpoint: Checkpoint,
    ) {
      const encoded = encode(checkpoint);
      if (!encoded || !/^[a-f0-9]{64}$/.test(promptSha256)) return false;
      db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
        revision TEXT NOT NULL,
        taskId TEXT NOT NULL REFERENCES ${assignments}(id),
        evidenceRevision INTEGER NOT NULL,
        promptSha256 TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        version INTEGER NOT NULL,
        checkpoint TEXT NOT NULL,
        PRIMARY KEY(revision, taskId, evidenceRevision)
      )`);
      const time = now();
      db.prepare(`DELETE FROM ${table} WHERE expiresAt <= ?`).run(time);
      db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(revision, taskId, evidenceRevision) DO UPDATE SET
          promptSha256 = excluded.promptSha256,
          expiresAt = excluded.expiresAt,
          version = excluded.version,
          checkpoint = excluded.checkpoint`).run(
        scope.revision,
        scope.taskId,
        scope.evidenceRevision,
        promptSha256,
        time + checkpointTtlMs,
        checkpointVersion,
        encoded,
      );
      return true;
    },
    replace(scope: CheckpointScope, checkpoint: Checkpoint) {
      const encoded = encode(checkpoint);
      if (!encoded || !hasTable()) return false;
      return db.prepare(`UPDATE ${table} SET checkpoint = ?
        WHERE revision = ? AND taskId = ? AND evidenceRevision = ? AND version = ?`)
        .run(
          encoded,
          scope.revision,
          scope.taskId,
          scope.evidenceRevision,
          checkpointVersion,
        )
        .changes === 1;
    },
    clear(revision: string, taskId: string) {
      if (hasTable()) {
        db.prepare(`DELETE FROM ${table} WHERE revision = ? AND taskId = ?`)
          .run(revision, taskId);
      }
    },
    retainRevision(revision: string) {
      if (hasTable()) {
        db.prepare(`DELETE FROM ${table} WHERE revision <> ?`).run(revision);
      }
    },
  };
}

/** Fence asynchronous control and persistence operations with the current lease. */
export function guardAssignmentExecution(
  signal: AbortSignal,
  isCurrent: () => boolean,
) {
  const active = () => !signal.aborted && isCurrent();
  function assertActive() {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("The assignment is no longer active.");
  }

  return {
    async boundary<T>(
      apply: () => T | Promise<T>,
    ): Promise<T | { stop: true }> {
      if (!active()) return { stop: true };
      const decision = await apply();
      return active() ? decision : { stop: true };
    },
    async checkpoint(commit: () => void | Promise<void>): Promise<void> {
      assertActive();
      await commit();
      assertActive();
    },
  };
}
