/** Shared durable metadata traces for explicitly admitted delegated and scheduled executions. */
/// <reference path="../sentinel/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AgentRecoveryStore,
  installPausedRecovery,
  type RecoverableState,
} from "./agent_recovery_store.ts";
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

/** Canonical, explicitly approved read projection. */
interface ActionsStatusPayload {
  readonly kind: "github_actions_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly workflow?: string;
  readonly perPage?: number;
  readonly runs: readonly {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
}

export type ExecutionTraceApprovedPayload = ActionsStatusPayload | {
  readonly kind: "github_repository_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly visibility: "public" | "internal" | "private";
} | {
  readonly kind: "github_pull_status";
  readonly repo: string;
  readonly repositoryId: number;
  readonly number: number;
  readonly state: "open" | "closed";
  readonly mergeable: boolean | null;
};

export function executionTracePayloadCall(
  payload: ExecutionTraceApprovedPayload,
) {
  if (payload.kind === "github_pull_status") {
    return {
      name: "github_pulls",
      args: { action: "get", repo: payload.repo, pr_number: payload.number },
    };
  }
  return payload.kind === "github_repository_status"
    ? { name: "github_repos", args: { action: "get", repo: payload.repo } }
    : {
      name: "github_actions",
      args: {
        action: "list_runs",
        repo: payload.repo,
        ...(payload.workflow !== undefined && { workflow: payload.workflow }),
        ...(payload.perPage !== undefined && { per_page: payload.perPage }),
      },
    };
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

export interface ExecutionTraceArchive {
  readonly run: ExecutionTraceRun;
  readonly finishLevel: number | null;
  readonly entries: readonly {
    readonly step: ExecutionTraceReceipt;
    readonly payload?: ExecutionTraceApprovedPayload;
  }[];
}

const appId = 0x45545243;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const toolPattern = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const receiptPattern = /^execution-trace:[a-f0-9]{64}$/;
const runCursorPattern = /^execution-trace-run:[a-f0-9]{64}$/;
const maxPage = 50;
const maxArchivedSteps = 1000;
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const workflowPattern = /^(?:[1-9][0-9]{0,11}|[a-zA-Z0-9_.-]{1,100}\.ya?ml)$/;
const workflowStatuses = new Set([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);
const workflowConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "startup_failure",
]);

function normalizeApprovedPayload(
  raw: ExecutionTraceApprovedPayload,
): ExecutionTraceApprovedPayload | undefined {
  if (raw?.kind === "github_pull_status") {
    const { repo, repositoryId, number, state, mergeable } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      !Number.isSafeInteger(number) || number < 1 ||
      (state !== "open" && state !== "closed") ||
      (mergeable !== null && typeof mergeable !== "boolean") ||
      Object.keys(raw).length !== 6
    ) return;
    return { kind: raw.kind, repo, repositoryId, number, state, mergeable };
  }
  if (raw?.kind === "github_repository_status") {
    const { repo, repositoryId, visibility } = raw;
    if (
      typeof repo !== "string" || !repoPattern.test(repo) ||
      /\/(?:\.|\.\.)$/.test(repo) ||
      !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
      !["public", "internal", "private"].includes(visibility) ||
      Object.keys(raw).some((key) =>
        !["kind", "repo", "repositoryId", "visibility"].includes(key)
      )
    ) return undefined;
    return { kind: raw.kind, repo, repositoryId, visibility };
  }
  if (
    !raw || typeof raw !== "object" || raw.kind !== "github_actions_status" ||
    typeof raw.repo !== "string" || !repoPattern.test(raw.repo) ||
    /\/(?:\.|\.\.)$/.test(raw.repo) ||
    !Number.isSafeInteger(raw.repositoryId) || raw.repositoryId < 1 ||
    (raw.workflow !== undefined &&
      (typeof raw.workflow !== "string" ||
        !workflowPattern.test(raw.workflow))) ||
    (raw.perPage !== undefined &&
      (!Number.isSafeInteger(raw.perPage) || raw.perPage < 1 ||
        raw.perPage > 100)) ||
    !Array.isArray(raw.runs) || raw.runs.length > 100 ||
    Object.keys(raw).some((key) =>
      !["kind", "repo", "repositoryId", "workflow", "perPage", "runs"].includes(
        key,
      )
    )
  ) return;
  const runs: ActionsStatusPayload["runs"][number][] = [];
  for (const entry of raw.runs) {
    if (
      !entry || typeof entry !== "object" ||
      !Number.isSafeInteger(entry.id) || entry.id < 1 ||
      !workflowStatuses.has(entry.status) ||
      (entry.conclusion !== null &&
        !workflowConclusions.has(entry.conclusion)) ||
      !["id", "status", "conclusion"].every((key) =>
        Object.hasOwn(entry, key)
      ) ||
      Object.keys(entry).length !== 3
    ) return;
    runs.push({
      id: entry.id,
      status: entry.status,
      conclusion: entry.conclusion,
    });
  }
  return {
    kind: raw.kind,
    repo: raw.repo,
    repositoryId: raw.repositoryId,
    ...(raw.workflow !== undefined && { workflow: raw.workflow }),
    ...(raw.perPage !== undefined && { perPage: raw.perPage }),
    runs,
  };
}
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
      if (current === appId && version === 2) return;
      const payloadTable = `
        CREATE TABLE execution_trace_approved_payloads (
          stepId TEXT PRIMARY KEY REFERENCES execution_trace_steps(id),
          payload TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 2;
      `;
      if (current === appId && version === 1) {
        db.exec(payloadTable);
        return;
      }
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
        ${payloadTable}
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
  const readPayload = db.prepare(
    "SELECT payload FROM execution_trace_approved_payloads WHERE stepId = ?",
  );
  const writePayload = db.prepare(
    "INSERT INTO execution_trace_approved_payloads (stepId,payload) VALUES (?,?)",
  );
  function append(
    rawScope: ExecutionTraceScope,
    rawStep: Omit<ExecutionTraceStep, "ordinal">,
    ordinal?: number,
    rawPayload?: ExecutionTraceApprovedPayload,
  ): ExecutionTraceReceipt | undefined {
    const scope = normalizeScope(rawScope);
    const normalized = normalizeStep({ ...rawStep, ordinal: ordinal ?? 1 });
    if (!scope || !normalized) return;
    const payload = rawPayload === undefined
      ? undefined
      : normalizeApprovedPayload(rawPayload);
    if (
      rawPayload !== undefined &&
      (!payload ||
        normalized.tool !== executionTracePayloadCall(payload).name ||
        normalized.outcome !== "returned")
    ) return;
    return transaction(db, () => {
      const admitted = checkedRun(scope);
      if (!admitted) return undefined;
      const last = Number(lastOrdinal.get(admitted.sequence)?.ordinal ?? 0);
      const step = { ...normalized, ordinal: ordinal ?? last + 1 };
      if (!Number.isSafeInteger(step.ordinal)) return undefined;
      const id = hashId(
        "execution-trace",
        payload ? [scope, step, payload] : [scope, step],
      );
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
      if (payload) writePayload.run(id, JSON.stringify(payload));
      db.prepare(
        "UPDATE execution_trace_runs SET maxLevel = max(maxLevel, ?) WHERE sequence = ?",
      )
        .run(CLASSIFICATION_ORDER[step.classification], admitted.sequence);
      return receiptFor(scope, row!);
    });
  }
  return {
    archiveSnapshot(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      includeRunning = false,
    ): ExecutionTraceArchive | undefined {
      if (!roleOf(role) || !reference(runId) || !levelOf(ceiling)) return;
      return transaction(db, () => {
        const row = run.get(role, runId);
        if (!row) return;
        const saved = runFor(row);
        if (
          (!includeRunning && saved.status === "running") ||
          !canFlowTo(saved.classification, ceiling)
        ) return;
        const rows = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ?
          ORDER BY ordinal LIMIT ?
        `).all(row.sequence, maxArchivedSteps + 1);
        if (rows.length > maxArchivedSteps) return;
        const entries = rows.map((row) => {
          const step = receiptFor(saved.scope, row);
          const stored = readPayload.get(step.id)?.payload;
          const payload = typeof stored === "string"
            ? normalizeApprovedPayload(JSON.parse(stored))
            : undefined;
          if (stored !== undefined && !payload) {
            throw new Error("Invalid saved execution trace payload");
          }
          return { step, ...(payload && { payload }) };
        });
        return {
          run: saved,
          finishLevel: typeof row.finishLevel === "number"
            ? row.finishLevel
            : null,
          entries,
        };
      });
    },

    restoreSnapshot(
      archive: ExecutionTraceArchive,
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      recovery?: {
        path: string;
        record: RecoverableState;
        admission?: { path: string; install(db: DatabaseSync): boolean };
      },
    ): boolean {
      const saved = archive?.run;
      const scope = normalizeScope(saved?.scope);
      if (
        !saved || !scope || scope.role !== role || scope.runId !== runId ||
        !levelOf(ceiling) || !levelOf(saved.classification) ||
        !canFlowTo(saved.classification, ceiling) ||
        !canFlowTo(scope.classification!, saved.classification) ||
        (recovery
          ? saved.status !== "running" || saved.finishedAt !== undefined ||
            archive.finishLevel !== null ||
            recovery.record.key !== createHash("sha256").update(
                JSON.stringify([scope.sessionId, scope.runId]),
              ).digest("hex") ||
            !recovery.record.tools.every(({ classification }) =>
              canFlowTo(classification, ceiling)
            )
          : !["completed", "failed", "interrupted"].includes(saved.status)) ||
        !Array.isArray(archive.entries) ||
        archive.entries.length > maxArchivedSteps
      ) return false;
      const admittedAt = Date.parse(saved.admittedAt);
      const finishedAt = recovery ? null : Date.parse(saved.finishedAt ?? "");
      const level = CLASSIFICATION_ORDER[saved.classification];
      if (
        archive.finishLevel !== null &&
        (!Number.isInteger(archive.finishLevel) ||
          archive.finishLevel < 0 || archive.finishLevel > level)
      ) return false;
      if (
        !Number.isFinite(admittedAt) ||
        (!recovery && !Number.isFinite(finishedAt))
      ) {
        return false;
      }
      let last = 0;
      const entries: {
        id: string;
        step: ExecutionTraceStep;
        recordedAt: number;
        payload?: ExecutionTraceApprovedPayload;
      }[] = [];
      for (const entry of archive.entries) {
        const step = normalizeStep(entry?.step);
        if (
          !step || step.ordinal <= last ||
          !canFlowTo(step.classification, saved.classification) ||
          JSON.stringify(normalizeScope(entry.step.scope)) !==
            JSON.stringify(scope)
        ) return false;
        const recordedAt = Date.parse(entry.step.recordedAt);
        if (!Number.isFinite(recordedAt)) return false;
        const payload = entry.payload === undefined
          ? undefined
          : normalizeApprovedPayload(entry.payload);
        if (
          entry.payload !== undefined && (!payload ||
            step.tool !== executionTracePayloadCall(payload).name ||
            step.outcome !== "returned")
        ) return false;
        const id = hashId(
          "execution-trace",
          payload ? [scope, step, payload] : [scope, step],
        );
        if (entry.step.id !== id) return false;
        entries.push({ id, step, recordedAt, payload });
        last = step.ordinal;
      }
      if (recovery) {
        new AgentRecoveryStore(recovery.path).close();
        db.prepare("ATTACH DATABASE ? AS archive_recovery").run(recovery.path);
      }
      let admissionAttached = false;
      try {
        if (recovery?.admission) {
          db.prepare("ATTACH DATABASE ? AS archive_admission").run(
            recovery.admission.path,
          );
          admissionAttached = true;
          if (
            db.prepare("PRAGMA archive_admission.journal_mode").get()
              ?.journal_mode !== "delete"
          ) return false;
        }
        if (
          recovery && (
            db.prepare("PRAGMA main.journal_mode").get()?.journal_mode !==
              "delete" ||
            db.prepare("PRAGMA archive_recovery.journal_mode").get()
                ?.journal_mode !== "delete"
          )
        ) return false;
        return transaction(db, () => {
          if (run.get(role, runId)) return false;
          if (
            recovery &&
            !installPausedRecovery(db, recovery.record, "archive_recovery")
          ) return false;
          if (recovery?.admission && !recovery.admission.install(db)) {
            throw new Error("Scheduler admission identity collision");
          }
          const row = db.prepare(`
          INSERT INTO execution_trace_runs
          (role,runId,scope,cursor,maxLevel,admittedAt,status,finishedAt,finishLevel)
          VALUES (?,?,?,?,?,?,?,?,?) RETURNING sequence
        `).get(
              role,
              runId,
              JSON.stringify(scope),
              hashId("execution-trace-run", scope),
              level,
              admittedAt,
              saved.status,
              finishedAt,
              archive.finishLevel,
            );
          const insert = db.prepare(
            "INSERT INTO execution_trace_steps VALUES (?,?,?,?,?,?,?)",
          );
          for (const { id, step, recordedAt, payload } of entries) {
            insert.run(
              row!.sequence,
              step.ordinal,
              id,
              step.tool,
              step.classification,
              step.outcome,
              recordedAt,
            );
            if (payload) writePayload.run(id, JSON.stringify(payload));
          }
          return true;
        });
      } finally {
        if (admissionAttached) db.exec("DETACH DATABASE archive_admission");
        if (recovery) db.exec("DETACH DATABASE archive_recovery");
      }
    },
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
      payload?: ExecutionTraceApprovedPayload,
    ): ExecutionTraceReceipt | undefined {
      if (!Number.isSafeInteger(rawStep?.ordinal)) return undefined;
      return append(rawScope, rawStep, rawStep.ordinal, payload);
    },

    appendNext(
      rawScope: ExecutionTraceScope,
      rawStep: Omit<ExecutionTraceStep, "ordinal">,
      payload?: ExecutionTraceApprovedPayload,
    ) {
      return append(rawScope, rawStep, undefined, payload);
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

    search({
      query,
      ceiling,
      role,
      runId,
      limit = 10,
      cursor,
    }: {
      readonly query: string;
      readonly ceiling: ClassificationLevel;
      readonly role?: ExecutionTraceRole;
      readonly runId?: string;
      readonly limit?: number;
      readonly cursor?: string;
    }) {
      if (
        typeof query !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(query) ||
        !levelOf(ceiling) || !pageSize(limit) ||
        (role !== undefined && !roleOf(role)) ||
        (runId !== undefined && (!role || !reference(runId)))
      ) return;
      const term = query.toLowerCase();
      const filter = hashId("execution-trace-search", [
        role ?? null,
        runId ?? null,
        term,
        ceiling,
      ]);
      return transaction(db, () => {
        if (runId !== undefined) {
          const selected = run.get(role!, runId);
          if (
            !selected ||
            Number(selected.maxLevel) > CLASSIFICATION_ORDER[ceiling]
          ) return;
        }
        let sequence = Number.MAX_SAFE_INTEGER;
        let ordinal = Number.MAX_SAFE_INTEGER;
        if (cursor !== undefined) {
          if (typeof cursor !== "string") return;
          const prefix = filter + ".";
          const receipt = cursor.slice(prefix.length);
          if (!cursor.startsWith(prefix) || !receiptPattern.test(receipt)) {
            return;
          }
          const anchor = db.prepare(`
            SELECT step.runSequence, step.ordinal FROM execution_trace_steps AS step
            JOIN execution_trace_runs AS run ON run.sequence = step.runSequence
            WHERE step.id = ? AND run.maxLevel <= ?
              AND (? IS NULL OR run.role = ?) AND (? IS NULL OR run.runId = ?)
              AND (instr(lower(step.tool), ?) > 0 OR step.outcome = ?)
          `).get(
            receipt,
            CLASSIFICATION_ORDER[ceiling],
            role ?? null,
            role ?? null,
            runId ?? null,
            runId ?? null,
            term,
            term,
          );
          if (!anchor) return;
          sequence = Number(anchor.runSequence);
          ordinal = Number(anchor.ordinal);
        }
        const rows = db.prepare(`
          SELECT step.*, run.role, run.runId FROM execution_trace_steps AS step
          JOIN execution_trace_runs AS run ON run.sequence = step.runSequence
          WHERE run.maxLevel <= ?
            AND (? IS NULL OR run.role = ?) AND (? IS NULL OR run.runId = ?)
            AND (instr(lower(step.tool), ?) > 0 OR step.outcome = ?)
            AND (step.runSequence, step.ordinal) < (?, ?)
          ORDER BY step.runSequence DESC, step.ordinal DESC LIMIT ?
        `).all(
          CLASSIFICATION_ORDER[ceiling],
          role ?? null,
          role ?? null,
          runId ?? null,
          runId ?? null,
          term,
          term,
          sequence,
          ordinal,
          limit + 1,
        );
        const matches = rows.slice(0, limit).map((row) => ({
          role: row.role as ExecutionTraceRole,
          runId: String(row.runId),
          id: String(row.id),
          ordinal: Number(row.ordinal),
          tool: String(row.tool),
          classification: row.classification as ClassificationLevel,
          outcome: row.outcome as ExecutionTraceOutcome,
          recordedAt: new Date(Number(row.recordedAt)).toISOString(),
        }));
        return {
          matches,
          nextCursor: rows.length > limit
            ? filter + "." + matches.at(-1)!.id
            : null,
        };
      });
    },

    recent(
      role: ExecutionTraceRole,
      runId: string,
      ceiling: ClassificationLevel,
      limit = 12,
    ) {
      if (
        !roleOf(role) || !reference(runId) || !levelOf(ceiling) ||
        !pageSize(limit)
      ) return;
      return transaction(db, () => {
        const row = run.get(role, runId);
        if (!row || Number(row.maxLevel) > CLASSIFICATION_ORDER[ceiling]) {
          return;
        }
        const selected = runFor(row);
        const steps = db.prepare(`
          SELECT * FROM execution_trace_steps WHERE runSequence = ?
          ORDER BY ordinal DESC LIMIT ?
        `).all(row.sequence, limit).reverse();
        return {
          run: selected,
          steps: steps.map((step) => receiptFor(selected.scope, step)),
        };
      });
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

    readApprovedPayload(
      rawScope: ExecutionTraceScope,
      ordinal: number,
      ceiling: ClassificationLevel,
    ): ExecutionTraceApprovedPayload | undefined {
      const scope = normalizeScope(rawScope);
      if (
        !scope || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
        !levelOf(ceiling)
      ) return;
      return transaction(db, () => {
        const admitted = checkedRun(scope, ceiling);
        const row = admitted && exact.get(admitted.sequence, ordinal);
        if (
          !row || row.outcome !== "returned"
        ) return;
        const saved = readPayload.get(row.id)?.payload;
        if (typeof saved !== "string" || saved.length > 16_000) return;
        try {
          const payload = normalizeApprovedPayload(JSON.parse(saved));
          const step = normalizeStep({
            ordinal,
            tool: String(row.tool),
            outcome: "returned",
            classification: row.classification as ClassificationLevel,
          });
          if (
            !step || !payload ||
            step.tool !== executionTracePayloadCall(payload).name ||
            !canFlowTo(step.classification, ceiling) ||
            hashId("execution-trace", [scope, step, payload]) !== row.id
          ) return;
          return payload;
        } catch {
          return undefined;
        }
      });
    },

    close: () => db.close(),
  };
}
