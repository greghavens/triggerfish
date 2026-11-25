/** Shared durable metadata traces for explicitly admitted delegated and scheduled executions. */
/// <reference path="../sentinel/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  canFlowTo,
  CLASSIFICATION_ORDER,
  type ClassificationLevel,
} from "./types/classification.ts";

export type ExecutionTraceRole = "delegated" | "scheduled";
export type ExecutionTraceOutcome = "returned" | "blocked" | "failed";
export type ExecutionTraceTerminalStatus =
  | "completed"
  | "failed"
  | "interrupted";

export interface ExecutionTraceScope {
  readonly role: ExecutionTraceRole;
  readonly runId: string;
  readonly sessionId: string;
  readonly sourceId?: string;
  readonly classification?: ClassificationLevel;
}

export interface ExecutionTraceStep {
  readonly ordinal: number;
  readonly tool: string;
  readonly classification: ClassificationLevel;
  readonly outcome: ExecutionTraceOutcome;
}

export interface ExecutionTraceRun {
  readonly scope: ExecutionTraceScope;
  readonly classification: ClassificationLevel;
  readonly admittedAt: string;
  readonly status: "running" | ExecutionTraceTerminalStatus;
  readonly finishedAt?: string;
}

export interface ExecutionTraceReceipt extends ExecutionTraceStep {
  readonly id: string;
  readonly scope: ExecutionTraceScope;
  readonly recordedAt: string;
}

const appId = 0x45545243;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const toolPattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const receiptPattern = /^execution-trace:[a-f0-9]{64}$/;
const runCursorPattern = /^execution-trace-run:[a-f0-9]{64}$/;
const maxPage = 50;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function roleOf(value: unknown): value is ExecutionTraceRole {
  return value === "delegated" || value === "scheduled";
}

function levelOf(value: unknown): value is ClassificationLevel {
  return typeof value === "string" &&
    Object.hasOwn(CLASSIFICATION_ORDER, value);
}

function reference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}

function normalizeScope(
  raw: ExecutionTraceScope,
): ExecutionTraceScope | undefined {
  if (!raw || typeof raw !== "object") return;
  const { role, runId, sessionId, sourceId, classification = "INTERNAL" } = raw;
  if (
    !roleOf(role) || !reference(runId) || !reference(sessionId) ||
    (sourceId !== undefined && !reference(sourceId)) || !levelOf(classification)
  ) return;
  return {
    role,
    runId,
    sessionId,
    ...(sourceId !== undefined && { sourceId }),
    classification,
  };
}

function normalizeStep(
  raw: ExecutionTraceStep,
): ExecutionTraceStep | undefined {
  if (!raw || typeof raw !== "object") return;
  const { ordinal, tool, classification, outcome } = raw;
  if (
    !Number.isSafeInteger(ordinal) || ordinal < 1 ||
    typeof tool !== "string" || !toolPattern.test(tool) ||
    !levelOf(classification) ||
    (outcome !== "returned" && outcome !== "blocked" && outcome !== "failed")
  ) return;
  return { ordinal, tool, classification, outcome };
}

function hashId(prefix: string, input: unknown) {
  return `${prefix}:${
    createHash("sha256").update(JSON.stringify(input)).digest("hex")
  }`;
}

function privateDatabase(path: string) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const dir = Deno.lstatSync(parent);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o022) !== 0) {
    throw new Error(
      "Execution traces require an operator-controlled directory.",
    );
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
    throw new Error("Execution traces require a private regular database.");
  }
  return new DatabaseSync(absolute);
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runFor(row: Row): ExecutionTraceRun {
  const classification = Object.keys(CLASSIFICATION_ORDER).find((key) =>
    CLASSIFICATION_ORDER[key as ClassificationLevel] === row.maxLevel
  ) as ClassificationLevel;
  return {
    scope: JSON.parse(String(row.scope)) as ExecutionTraceScope,
    classification,
    admittedAt: new Date(Number(row.admittedAt)).toISOString(),
    status: row.status as ExecutionTraceRun["status"],
    ...(typeof row.finishedAt === "number" && {
      finishedAt: new Date(row.finishedAt).toISOString(),
    }),
  };
}

function receiptFor(
  scope: ExecutionTraceScope,
  row: Row,
): ExecutionTraceReceipt {
  return {
    scope,
    id: String(row.id),
    ordinal: Number(row.ordinal),
    tool: String(row.tool),
    classification: row.classification as ClassificationLevel,
    outcome: row.outcome as ExecutionTraceOutcome,
    recordedAt: new Date(Number(row.recordedAt)).toISOString(),
  };
}

function pageSize(limit: number) {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maxPage;
}

/** Run authorization and trusted tool-name selection belong to the caller. */
export function openExecutionTraces(path: string, now = Date.now) {
  const db = privateDatabase(path);
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON",
    );
    transaction(db, () => {
      const current = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (current === appId && version === 1) return;
      if (
        current !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid execution trace database or version.");
      }
      db.exec(`
        CREATE TABLE execution_trace_runs (
          sequence INTEGER PRIMARY KEY,
          role TEXT NOT NULL CHECK(role IN ('delegated','scheduled')),
          runId TEXT NOT NULL,
          scope TEXT NOT NULL,
          cursor TEXT NOT NULL UNIQUE,
          maxLevel INTEGER NOT NULL,
          admittedAt INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','interrupted')),
          finishedAt INTEGER,
          finishLevel INTEGER,
          UNIQUE(role,runId)
        );
        CREATE TABLE execution_trace_steps (
          runSequence INTEGER NOT NULL REFERENCES execution_trace_runs(sequence),
          ordinal INTEGER NOT NULL,
          id TEXT NOT NULL UNIQUE,
          tool TEXT NOT NULL,
          classification TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('returned','blocked','failed')),
          recordedAt INTEGER NOT NULL,
          PRIMARY KEY(runSequence,ordinal)
        );
        PRAGMA application_id = ${appId};
        PRAGMA user_version = 1;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const run = db.prepare(
    "SELECT * FROM execution_trace_runs WHERE role = ? AND runId = ?",
  );
  const exact = db.prepare(
    "SELECT * FROM execution_trace_steps WHERE runSequence = ? AND ordinal = ?",
  );
  function checkedRun(
    scope: ExecutionTraceScope,
    ceiling?: ClassificationLevel,
  ) {
    const row = run.get(scope.role, scope.runId);
    return row?.scope === JSON.stringify(scope) &&
        (ceiling === undefined ||
          Number(row.maxLevel) <= CLASSIFICATION_ORDER[ceiling])
      ? row
      : undefined;
  }
  const lastOrdinal = db.prepare(
    "SELECT MAX(ordinal) AS ordinal FROM execution_trace_steps WHERE runSequence = ?",
  );
  function append(
    rawScope: ExecutionTraceScope,
    rawStep: Omit<ExecutionTraceStep, "ordinal">,
    ordinal?: number,
  ): ExecutionTraceReceipt | undefined {
    const scope = normalizeScope(rawScope);
    const normalized = normalizeStep({ ...rawStep, ordinal: ordinal ?? 1 });
    if (!scope || !normalized) return;
    return transaction(db, () => {
      const admitted = checkedRun(scope);
      if (!admitted) return undefined;
      const last = Number(lastOrdinal.get(admitted.sequence)?.ordinal ?? 0);
      const step = { ...normalized, ordinal: ordinal ?? last + 1 };
      if (!Number.isSafeInteger(step.ordinal)) return undefined;
      const id = hashId("execution-trace", [scope, step]);
      const current = ordinal === undefined
        ? undefined
        : exact.get(admitted.sequence, ordinal);
      if (current) {
        return current.id === id ? receiptFor(scope, current) : undefined;
      }
      if (admitted.status !== "running" || step.ordinal <= last) {
        return undefined;
      }
      const row = db.prepare(`
        INSERT INTO execution_trace_steps VALUES (?,?,?,?,?,?,?) RETURNING *
      `).get(
        admitted.sequence,
        step.ordinal,
        id,
        step.tool,
        step.classification,
        step.outcome,
        now(),
      );
      db.prepare(
        "UPDATE execution_trace_runs SET maxLevel = max(maxLevel, ?) WHERE sequence = ?",
      )
        .run(CLASSIFICATION_ORDER[step.classification], admitted.sequence);
      return receiptFor(scope, row!);
    });
  }
  return {
    admit(raw: ExecutionTraceScope): ExecutionTraceRun | undefined {
      const scope = normalizeScope(raw);
      if (!scope) return;
      const encoded = JSON.stringify(scope);
      return transaction(db, () => {
        const current = run.get(scope.role, scope.runId);
        if (current) {
          return current.scope === encoded ? runFor(current) : undefined;
        }
        const row = db.prepare(`
          INSERT INTO execution_trace_runs (role,runId,scope,cursor,maxLevel,admittedAt)
          VALUES (?,?,?,?,?,?) RETURNING *
        `).get(
          scope.role,
          scope.runId,
          encoded,
          hashId("execution-trace-run", scope),
          CLASSIFICATION_ORDER[scope.classification!],
          now(),
        );
        return runFor(row!);
      });
    },

    append(
      rawScope: ExecutionTraceScope,
      rawStep: ExecutionTraceStep,
    ): ExecutionTraceReceipt | undefined {
      if (!Number.isSafeInteger(rawStep?.ordinal)) return undefined;
      return append(rawScope, rawStep, rawStep.ordinal);
    },

    appendNext(
      rawScope: ExecutionTraceScope,
      rawStep: Omit<ExecutionTraceStep, "ordinal">,
    ) {
      return append(rawScope, rawStep);
    },

    finish(
      rawScope: ExecutionTraceScope,
      status: ExecutionTraceTerminalStatus,
      classification?: ClassificationLevel,
    ): ExecutionTraceRun | undefined {
      const scope = normalizeScope(rawScope);
      if (
        !scope ||
        (status !== "completed" && status !== "failed" &&
          status !== "interrupted") ||
        (classification !== undefined && !levelOf(classification))
      ) return undefined;
      const level = classification === undefined
        ? null
        : CLASSIFICATION_ORDER[classification];
      return transaction(db, () => {
        const admitted = checkedRun(scope);
        if (!admitted) return undefined;
        if (admitted.status !== "running") {
          return admitted.status === status && admitted.finishLevel === level
            ? runFor(admitted)
            : undefined;
        }
        const row = db.prepare(`
          UPDATE execution_trace_runs SET status = ?, finishedAt = ?, finishLevel = ?,
            maxLevel = max(maxLevel, coalesce(?, maxLevel))
          WHERE sequence = ? AND status = 'running' RETURNING *
        `).get(status, now(), level, level, admitted.sequence);
        return row && runFor(row);
      });
    },

    readRun(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
    ) {
      if (!roleOf(role) || !reference(runId) || !levelOf(ceiling)) {
        return undefined;
      }
      const row = run.get(role, runId);
      if (!row) return undefined;
      const info = runFor(row);
      return canFlowTo(info.classification, ceiling) ? info : undefined;
    },

    listRuns({ role, ceiling, limit = 20, cursor }: {
      readonly role?: ExecutionTraceRole;
      readonly ceiling: ClassificationLevel;
      readonly limit?: number;
      readonly cursor?: string;
    }) {
      if (
        (role !== undefined && !roleOf(role)) || !levelOf(ceiling) ||
        !pageSize(limit)
      ) return undefined;
      let before = Number.MAX_SAFE_INTEGER;
      if (cursor !== undefined) {
        if (typeof cursor !== "string" || !runCursorPattern.test(cursor)) {
          return undefined;
        }
        const found = db.prepare(
          "SELECT * FROM execution_trace_runs WHERE cursor = ?",
        ).get(cursor);
        if (
          !found || (role !== undefined && role !== found.role) ||
          Number(found.maxLevel) > CLASSIFICATION_ORDER[ceiling]
        ) return undefined;
        before = Number(found.sequence);
      }
      const rows = db.prepare(`
        SELECT * FROM execution_trace_runs
        WHERE (? IS NULL OR role = ?) AND maxLevel <= ? AND sequence < ?
        ORDER BY sequence DESC LIMIT ?
      `).all(
        role ?? null,
        role ?? null,
        CLASSIFICATION_ORDER[ceiling],
        before,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      return {
        runs: page.map(runFor),
        nextCursor: rows.length > limit ? String(page.at(-1)!.cursor) : null,
      };
    },

    list(rawScope: ExecutionTraceScope, { ceiling, limit = 20, cursor }: {
      readonly ceiling: ClassificationLevel;
      readonly limit?: number;
      readonly cursor?: string;
    }) {
      const scope = normalizeScope(rawScope);
      if (!scope || !levelOf(ceiling) || !pageSize(limit)) return undefined;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        if (!admitted) return undefined;
        let after = 0;
        if (cursor !== undefined) {
          if (typeof cursor !== "string" || !receiptPattern.test(cursor)) {
            return undefined;
          }
          const found = db.prepare(
            "SELECT ordinal FROM execution_trace_steps WHERE runSequence = ? AND id = ?",
          )
            .get(admitted.sequence, cursor);
          if (!found) return undefined;
          after = Number(found.ordinal);
        }
        const rows = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ? AND ordinal > ?
          ORDER BY ordinal LIMIT ?
        `).all(admitted.sequence, after, limit + 1);
        const page = rows.slice(0, limit);
        return {
          steps: page.map((row) => receiptFor(scope, row)),
          nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
        };
      });
    },

    inspect(
      rawScope: ExecutionTraceScope,
      ordinal: number,
      ceiling: ClassificationLevel,
    ) {
      const scope = normalizeScope(rawScope);
      if (
        !scope || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
        !levelOf(ceiling)
      ) return undefined;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        const row = admitted && exact.get(admitted.sequence, ordinal);
        return row && receiptFor(scope, row);
      });
    },

    close: () => db.close(),
  };
}
