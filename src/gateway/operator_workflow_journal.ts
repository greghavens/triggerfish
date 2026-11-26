import { validControlEvidenceId } from "../core/evidence_task_progression.ts";
/** Private metadata-only journal for admitted ordinary operator workflows. */
/// <reference path="../core/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import {
  restoreRunArchiveOnce,
  type RunArchiveRestoreKey,
} from "../core/run_archive_actions.ts";
import { DatabaseSync } from "node:sqlite";
import {
  type ArchivedOperatorRunLink,
  type OperatorRunLinkInput,
  recordOperatorRunLink,
  restoreOperatorRunLinks,
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

interface WorkflowStepEvidenceSource {
  readonly sourceTaskId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly revision: number;
  readonly resultSha256: string;
}

export interface WorkflowGoalCompletionEvidence {
  readonly caseId: string;
  readonly runId: string;
  readonly revision: number;
  readonly goalId: string;
  readonly completedAt: string;
  readonly resultSha256: string;
}

type WorkflowWorkerStepEvidence =
  & WorkflowStepEvidenceSource
  & (
    | {
      readonly observationId: string;
      readonly workflowRunId: number;
      readonly sourceStepIndex: number;
    }
    | {
      readonly graphFactId: string;
      readonly sourceStepIndex: number;
      readonly controlCheckedAt?: string;
      readonly assetId?: string;
      readonly controlId?: string;
    }
    | {
      readonly findingRecheckId: string;
      readonly findingId: string;
      readonly evidenceId: string;
      readonly controlCheckedAt: string;
    }
  );

export type WorkflowStepEvidence =
  | WorkflowWorkerStepEvidence
  | WorkflowGoalCompletionEvidence;

export function validWorkflowStepEvidence(
  value: unknown,
): value is WorkflowStepEvidence {
  if (!value || typeof value !== "object") return false;
  const e = value as WorkflowStepEvidence;
  const timestamp = (at: unknown) =>
    typeof at === "string" && Number.isFinite(Date.parse(at)) &&
    new Date(at).toISOString() === at;
  const binding = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(e.caseId) &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.runId) &&
    Number.isSafeInteger(e.revision) && e.revision > 0 &&
    /^[a-f0-9]{64}$/.test(e.resultSha256);
  if ("goalId" in e) {
    return binding && Object.keys(value).length === 6 &&
      typeof e.goalId === "string" &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(e.goalId) &&
      timestamp(e.completedAt);
  }
  const exactSource = "findingRecheckId" in e
    ? Object.keys(value).length === 9 &&
      typeof e.findingRecheckId === "string" &&
      /^worker-recheck:[a-f0-9]{64}$/.test(e.findingRecheckId) &&
      typeof e.findingId === "string" &&
      /^worker-finding:[a-f0-9]{64}$/.test(e.findingId) &&
      typeof e.evidenceId === "string" &&
      e.evidenceId.trim() === e.evidenceId &&
      e.evidenceId.length > 0 && e.evidenceId.length <= 4096 &&
      !e.evidenceId.includes("\0") && timestamp(e.controlCheckedAt)
    : "graphFactId" in e
    ? (Object.hasOwn(e, "controlCheckedAt")
      ? (Object.hasOwn(e, "assetId") || Object.hasOwn(e, "controlId")
        ? Object.keys(value).length === 10 &&
          validControlEvidenceId(e.assetId) &&
          validControlEvidenceId(e.controlId)
        : Object.keys(value).length === 8) &&
        timestamp(e.controlCheckedAt)
      : Object.keys(value).length === 7) &&
      /^worker-graph-fact:[a-f0-9]{64}$/.test(e.graphFactId)
    : Object.keys(value).length === 8 &&
      /^workflow-observation:[a-f0-9]{64}$/.test(e.observationId) &&
      Number.isSafeInteger(e.workflowRunId) && e.workflowRunId > 0;
  return exactSource &&
    /^adaptive:[a-f0-9]{64}$/.test(e.sourceTaskId) &&
    ("findingRecheckId" in e ||
      Number.isSafeInteger(e.sourceStepIndex) && e.sourceStepIndex >= 0 &&
        e.sourceStepIndex < 16) &&
    binding;
}

export function validWorkflowWaitDeadline(
  at: string,
  deadlineAt: unknown,
): deadlineAt is string {
  if (typeof deadlineAt !== "string") return false;
  const duration = Date.parse(deadlineAt) - Date.parse(at);
  return duration > 0 && duration <= 60_000;
}

function tracePayload(event: OperatorWorkflowTraceInput) {
  if (event.event === "step_waiting") return JSON.stringify(event.deadlineAt);
  if (
    event.event === "step_satisfied" || event.event === "step_proof_renewed"
  ) {
    return JSON.stringify(event.evidence);
  }
  return null;
}

export type OperatorWorkflowTraceInput =
  | {
    readonly event: "step_waiting";
    readonly stepId: string;
    readonly at: string;
    readonly deadlineAt: string;
  }
  | {
    readonly event: "step_satisfied" | "step_proof_renewed";
    readonly stepId: string;
    readonly at: string;
    readonly evidence: WorkflowStepEvidence;
  }
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
const stepEvents = new Set([
  "step_started",
  "step_completed",
  "step_failed",
  "step_satisfied",
  "step_proof_renewed",
  "step_waiting",
]);

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
    commit(db, () => {
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
  `);
      if (
        !db.prepare("PRAGMA table_info(workflow_trace_v1)").all()
          .some(({ name }) => name === "evidence")
      ) {
        db.exec("ALTER TABLE workflow_trace_v1 ADD COLUMN evidence TEXT");
      }
    })
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
      INSERT INTO workflow_trace_v1 (runId, sequence, event, stepId, at, evidence)
      SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
      FROM workflow_trace_v1 WHERE runId = ?
    `).run(
      runId,
      event.event,
      "stepId" in event ? event.stepId : null,
      event.at,
      tracePayload(event),
      runId,
    );
  }
  return {
    stepEvidence(
      runId: string,
      stepId: string,
    ): WorkflowStepEvidence | undefined {
      return query((db) => {
        const row = db.prepare(`SELECT evidence FROM workflow_trace_v1
          WHERE runId = ? AND stepId = ? AND event = 'step_satisfied'
          ORDER BY sequence LIMIT 2`).all(runId, stepId);
        if (row.length !== 1 || typeof row[0].evidence !== "string") return;
        const original: unknown = JSON.parse(row[0].evidence);
        if (!validWorkflowStepEvidence(original)) return;
        const latest = db.prepare(`SELECT evidence FROM workflow_trace_v1
          WHERE runId = ? AND stepId = ? AND event = 'step_proof_renewed'
          ORDER BY sequence DESC LIMIT 1`).get(runId, stepId);
        if (!latest) return original;
        if (typeof latest.evidence !== "string") return;
        const evidence: unknown = JSON.parse(latest.evidence);
        if (
          !validWorkflowStepEvidence(evidence) ||
          !("graphFactId" in original) || !("graphFactId" in evidence) ||
          !original.assetId || original.assetId !== evidence.assetId ||
          original.controlId !== evidence.controlId ||
          original.caseId !== evidence.caseId ||
          original.runId !== evidence.runId ||
          original.revision !== evidence.revision
        ) return;
        return evidence;
      });
    },
    waitDeadline(runId: string, stepId: string) {
      return query((db) => {
        const row = db.prepare(`SELECT at, evidence FROM workflow_trace_v1
          WHERE runId = ? AND stepId = ? AND event = 'step_waiting' ORDER BY sequence LIMIT 1`)
          .get(runId, stepId);
        if (!row) return;
        if (typeof row.at !== "string" || typeof row.evidence !== "string") {
          throw new Error("Invalid retained workflow wait.");
        }
        const deadline = JSON.parse(row.evidence);
        if (!validWorkflowWaitDeadline(row.at, deadline)) {
          throw new Error("Invalid retained workflow wait deadline.");
        }
        return Date.parse(deadline);
      });
    },
    restore(
      entry: OperatorWorkflowJournalRow,
      events: readonly OperatorWorkflowTraceEvent[],
      links?: { path: string; records: readonly ArchivedOperatorRunLink[] },
      installKey?: RunArchiveRestoreKey,
    ) {
      return query((db) =>
        withOperatorRunLinks(
          db,
          links?.path,
          () =>
            commit(db, () =>
              restoreRunArchiveOnce(db, installKey, () => {
                const inserted = db.prepare(`
            INSERT INTO workflow_admissions_v1 (${fields})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `).run(
                  entry.runId,
                  entry.requestId,
                  entry.planId,
                  entry.fingerprint,
                  entry.classification,
                  entry.completedAt === null ? "restored_paused" : entry.status,
                  entry.startedAt,
                  entry.completedAt,
                  entry.stepStatuses,
                );
                if (inserted.changes !== 1) return false;
                const insert = db.prepare(
                  "INSERT INTO workflow_trace_v1 VALUES (?, ?, ?, ?, ?, ?)",
                );
                for (const event of events) {
                  insert.run(
                    entry.runId,
                    event.sequence,
                    event.event,
                    "stepId" in event ? event.stepId : null,
                    event.at,
                    tracePayload(event),
                  );
                }
                if (links) {
                  restoreOperatorRunLinks(
                    db,
                    { kind: "workflow", id: entry.runId },
                    links.records,
                  );
                }
                return true;
              })),
        )
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
    interruptedWaits(limit: number) {
      return query((db) =>
        db.prepare(`
        SELECT admission.runId FROM workflow_admissions_v1 AS admission
        WHERE admission.status = 'running' AND admission.completedAt IS NULL
          AND EXISTS (SELECT 1 FROM workflow_trace_v1 AS trace
            WHERE trace.runId = admission.runId AND trace.event = 'step_waiting')
        ORDER BY admission.sequence LIMIT ?
      `).all(limit).map(({ runId }) => ({ runId: String(runId) }))
      );
    },
    update(
      runId: string,
      status: string,
      completedAt: string | null,
      stepStatuses: string,
      event: OperatorWorkflowTraceInput,
    ) {
      return query((db) =>
        commit(db, () => {
          const changed = db.prepare(`
        UPDATE workflow_admissions_v1 SET status = ?, completedAt = ?, stepStatuses = ?
        WHERE runId = ? AND completedAt IS NULL
      `).run(status, completedAt, stepStatuses, runId);
          if (changed.changes !== 1) return false;
          append(db, runId, event);
          return true;
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
          SELECT sequence, event, stepId, at, evidence FROM workflow_trace_v1
          WHERE runId = ? AND sequence > ?
            AND (? IS NULL OR instr(lower(event), ?) > 0 OR instr(lower(stepId), ?) > 0)
          ORDER BY sequence LIMIT ?
        `).all(runId, after, term ?? null, term ?? null, term ?? null, limit);
        if (
          raw.some(({ sequence, event, stepId, at, evidence }) =>
            typeof sequence !== "number" || !Number.isSafeInteger(sequence) ||
            typeof event !== "string" || typeof at !== "string" ||
            !Number.isFinite(Date.parse(at)) ||
            (event === "step_satisfied" || event === "step_proof_renewed"
              ? typeof evidence !== "string" ||
                !validWorkflowStepEvidence(JSON.parse(evidence))
              : event === "step_waiting"
              ? typeof evidence !== "string" ||
                !validWorkflowWaitDeadline(at, JSON.parse(evidence))
              : evidence !== null) ||
            (stepEvents.has(event)
              ? typeof stepId !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(stepId)
              : !lifecycleEvents.has(event) || stepId !== null)
          )
        ) return undefined;
        return {
          events: raw.map(({ sequence, event, stepId, at, evidence }) => ({
            sequence: Number(sequence),
            event: String(event),
            at: String(at),
            ...(typeof stepId === "string" && { stepId }),
            ...(typeof evidence === "string" &&
              (event === "step_waiting"
                ? { deadlineAt: JSON.parse(evidence) }
                : { evidence: JSON.parse(evidence) })),
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
