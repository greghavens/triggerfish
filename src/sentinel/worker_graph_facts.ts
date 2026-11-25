/** Case-local immutable journal for defensive graph relationship receipts. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { locateSentinelCase } from "./cases.ts";
import type { loadSentinelGraph } from "./graph.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
export type SentinelWorkerGraphRelationship = Snapshot["edges"][number];

const relationNames = {
  affects: true,
  mitigates: true,
  supports: true,
  verifies: true,
  observed_on: true,
  resolved_to: true,
  uses_hostname: true,
  depends_on: true,
  contained_in: true,
} satisfies Record<SentinelWorkerGraphRelationship["relation"], true>;

const appId = 0x53574746;
const journalName = "sentinel-worker-graph-facts.db";
const maxFacts = 4096;
const maxPage = 20;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const taskPattern = /^adaptive:[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const factPattern = /^worker-graph-fact:[a-f0-9]{64}$/;

export interface SentinelWorkerGraphFactScope {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly targetId: string;
  readonly taskId?: string;
}

export type SentinelPlannerGraphFactScope = Pick<
  SentinelWorkerGraphFactScope,
  "caseId" | "runId" | "evidenceRevision"
>;

export interface SentinelWorkerGraphFactInput
  extends SentinelWorkerGraphFactScope {
  readonly taskId: string;
  readonly snapshotDigest: string;
  readonly resultSha256: string;
  readonly relationship: SentinelWorkerGraphRelationship;
  readonly sourceStepIndex: number;
  readonly requestId: string;
}

export interface SentinelWorkerGraphFact extends SentinelWorkerGraphFactInput {
  readonly id: string;
  readonly kind: "graph_relationship";
  readonly sourceTool: "sentinel_assigned_target";
  readonly recordedAt: string;
}

export interface SentinelWorkerGraphFactPageOptions {
  readonly limit?: number;
  readonly offset?: number;
}

function isExactId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 &&
    !value.includes("\0");
}

function checkedRunScope(
  scope: SentinelPlannerGraphFactScope,
  caseId: string,
): boolean {
  return scope.caseId === caseId && typeof scope.runId === "string" &&
    uuid.test(scope.runId) && Number.isSafeInteger(scope.evidenceRevision) &&
    scope.evidenceRevision > 0;
}

function checkedScope(
  scope: SentinelWorkerGraphFactScope,
  caseId: string,
): boolean {
  return checkedRunScope(scope, caseId) && isExactId(scope.targetId) &&
    (scope.taskId === undefined ||
      typeof scope.taskId === "string" && taskPattern.test(scope.taskId));
}

function normalize(
  input: SentinelWorkerGraphFactInput,
  caseId: string,
): SentinelWorkerGraphFactInput {
  if (!checkedScope(input, caseId) || !input.relationship) {
    throw new Error("Invalid Sentinel worker graph fact scope");
  }
  const { from, to, relation } = input.relationship;
  const { taskId, snapshotDigest, resultSha256, sourceStepIndex, requestId } =
    input;
  if (
    typeof taskId !== "string" || !isExactId(from) || !isExactId(to) ||
    (from !== input.targetId && to !== input.targetId) ||
    typeof relation !== "string" || !Object.hasOwn(relationNames, relation) ||
    typeof snapshotDigest !== "string" || !digestPattern.test(snapshotDigest) ||
    typeof resultSha256 !== "string" || !digestPattern.test(resultSha256) ||
    !Number.isSafeInteger(sourceStepIndex) || sourceStepIndex < 0 ||
    sourceStepIndex >= 16 || typeof requestId !== "string" ||
    !uuid.test(requestId.toLowerCase())
  ) throw new Error("Invalid Sentinel worker graph fact receipt");
  return {
    caseId,
    runId: input.runId,
    evidenceRevision: input.evidenceRevision,
    taskId,
    targetId: input.targetId,
    snapshotDigest,
    resultSha256,
    relationship: { from, to, relation },
    sourceStepIndex,
    requestId: requestId.toLowerCase(),
  };
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function initialize(db: DatabaseSync, writable: boolean) {
  const initializeSchema = () => {
    const id = db.prepare("PRAGMA application_id").get()?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (id === appId && version === 1) return;
    if (
      !writable || id !== 0 || version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) throw new Error("Invalid Sentinel worker graph fact journal");
    db.exec(`
      CREATE TABLE worker_graph_facts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        receipt TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX worker_graph_facts_scope
        ON worker_graph_facts(run_id, revision, target_id, task_id);
      PRAGMA application_id = ${appId};
      PRAGMA user_version = 1;`);
  };
  if (writable) transaction(db, initializeSchema);
  else initializeSchema();
}

function factId(encoded: string) {
  return "worker-graph-fact:" +
    createHash("sha256").update(encoded).digest("hex");
}

function toReceipt(
  input: SentinelWorkerGraphFactInput,
  id: string,
  time: number,
): SentinelWorkerGraphFact {
  return {
    ...input,
    id,
    kind: "graph_relationship",
    sourceTool: "sentinel_assigned_target",
    recordedAt: new Date(time).toISOString(),
  };
}

function openFacts(snapshotPath: string, writable: boolean, now: () => number) {
  const snapshot = resolve(snapshotPath);
  const caseId = locateSentinelCase(snapshot)?.caseId;
  if (!caseId) {
    throw new Error("Sentinel worker facts require an exact case path");
  }
  const parent = dirname(snapshot);
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const path = join(parent, journalName);
  if (writable) {
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) throw new Error("Sentinel worker facts require a private regular journal");
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec("PRAGMA busy_timeout = 1500; PRAGMA trusted_schema = OFF");
    initialize(db, writable);
  } catch (error) {
    db.close();
    throw error;
  }

  type Row = NonNullable<
    ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
  >;
  const decode = (row: Row): SentinelWorkerGraphFact => {
    const input = normalize(JSON.parse(String(row.receipt)), caseId);
    const id = factId(JSON.stringify(input));
    if (
      id !== row.id || input.requestId !== row.request_id ||
      input.runId !== row.run_id || input.evidenceRevision !== row.revision ||
      input.targetId !== row.target_id || input.taskId !== row.task_id ||
      typeof row.recorded_at !== "number" ||
      !Number.isSafeInteger(row.recorded_at)
    ) throw new Error("Invalid saved Sentinel worker graph fact");
    return toReceipt(input, id, row.recorded_at);
  };

  return {
    /** The caller separately authorizes the active exact lease for every request. */
    record(
      raw: SentinelWorkerGraphFactInput,
      verifyNew: (input: SentinelWorkerGraphFactInput) => boolean,
    ): SentinelWorkerGraphFact | undefined {
      if (!writable) {
        throw new Error("The Sentinel graph fact journal is read-only");
      }
      const input = normalize(raw, caseId);
      const encoded = JSON.stringify(input);
      const id = factId(encoded);
      return transaction(db, () => {
        const existing = db.prepare(
          "SELECT * FROM worker_graph_facts WHERE request_id = ?",
        ).get(input.requestId);
        if (existing) return existing.id === id ? decode(existing) : undefined;
        if (verifyNew(input) !== true) return undefined;
        const count = db.prepare(
          "SELECT COUNT(*) AS count FROM worker_graph_facts",
        ).get();
        if (Number(count?.count) >= maxFacts) {
          throw new Error("Sentinel worker graph fact journal is full");
        }
        const time = now();
        if (!Number.isSafeInteger(time)) {
          throw new Error("Invalid Sentinel worker fact clock");
        }
        const receipt = toReceipt(input, id, time);
        db.prepare(`
          INSERT INTO worker_graph_facts
            (id,request_id,run_id,revision,target_id,task_id,receipt,recorded_at)
            VALUES (?,?,?,?,?,?,?,?)
        `).run(
          id,
          input.requestId,
          input.runId,
          input.evidenceRevision,
          input.targetId,
          input.taskId,
          encoded,
          time,
        );
        return receipt;
      });
    },

    read(
      scope: SentinelWorkerGraphFactScope,
      id: string,
    ): SentinelWorkerGraphFact | undefined {
      if (
        !checkedScope(scope, caseId) || typeof id !== "string" ||
        !factPattern.test(id)
      ) {
        return undefined;
      }
      const row = db.prepare(`
        SELECT * FROM worker_graph_facts
        WHERE id = ? AND run_id = ? AND revision = ? AND target_id = ?
          AND (? IS NULL OR task_id = ?)
      `).get(
        id,
        scope.runId,
        scope.evidenceRevision,
        scope.targetId,
        scope.taskId ?? null,
        scope.taskId ?? null,
      );
      return row ? decode(row) : undefined;
    },

    list(
      scope: SentinelWorkerGraphFactScope,
      options: SentinelWorkerGraphFactPageOptions = {},
    ) {
      const { limit = 10, offset = 0 } = options;
      if (
        !checkedScope(scope, caseId) || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > maxPage || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > maxFacts
      ) throw new Error("Invalid Sentinel worker graph fact page");
      const rows = db.prepare(`
        SELECT * FROM worker_graph_facts
        WHERE run_id = ? AND revision = ? AND target_id = ?
          AND (? IS NULL OR task_id = ?)
        ORDER BY rowid DESC LIMIT ? OFFSET ?
      `).all(
        scope.runId,
        scope.evidenceRevision,
        scope.targetId,
        scope.taskId ?? null,
        scope.taskId ?? null,
        limit + 1,
        offset,
      );
      return {
        facts: rows.slice(0, limit).map(decode),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },

    readCaseFact(scope: SentinelPlannerGraphFactScope, id: string) {
      if (!checkedRunScope(scope, caseId) || !factPattern.test(id)) return;
      const row = db.prepare(`
        SELECT * FROM worker_graph_facts WHERE run_id = ? AND revision = ? AND id = ?
      `).get(scope.runId, scope.evidenceRevision, id);
      return row ? decode(row) : undefined;
    },

    listForCase(
      scope: SentinelPlannerGraphFactScope,
      { limit = 5, offset = 0 }: SentinelWorkerGraphFactPageOptions = {},
    ) {
      if (
        !checkedRunScope(scope, caseId) || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > maxPage || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > maxFacts
      ) return { facts: [], nextOffset: null };
      const rows = db.prepare(`
        SELECT * FROM worker_graph_facts WHERE run_id = ? AND revision = ?
        ORDER BY rowid DESC LIMIT ? OFFSET ?
      `).all(scope.runId, scope.evidenceRevision, limit + 1, offset);
      return {
        facts: rows.slice(0, limit).map(decode),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },

    listForPlanner(scope: SentinelPlannerGraphFactScope, limit: number) {
      if (
        !checkedRunScope(scope, caseId) || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > maxPage
      ) return [];
      return db.prepare(`
        SELECT * FROM worker_graph_facts WHERE run_id = ? AND revision = ?
        ORDER BY rowid DESC LIMIT ?
      `).all(scope.runId, scope.evidenceRevision, limit).map(decode);
    },

    close() {
      db.close();
    },
  };
}

/** Writable journal; the broker must hold its exact assessment and lease gate. */
export function openSentinelWorkerGraphFacts(
  snapshotPath: string,
  now = Date.now,
) {
  return openFacts(snapshotPath, true, now);
}

function readJournal<T>(
  snapshotPath: string,
  inspect: (journal: ReturnType<typeof openFacts>) => T,
): T | undefined {
  let journal;
  try {
    journal = openFacts(snapshotPath, false, Date.now);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    return inspect(journal);
  } finally {
    journal.close();
  }
}

/** Reopen only the exact requested receipt in the independently selected scope. */
export function readSentinelWorkerGraphFact(
  snapshotPath: string,
  scope: SentinelWorkerGraphFactScope,
  id: string,
) {
  return readJournal(snapshotPath, (journal) => journal.read(scope, id));
}

export function listSentinelWorkerGraphFacts(
  snapshotPath: string,
  scope: SentinelWorkerGraphFactScope,
  options?: SentinelWorkerGraphFactPageOptions,
) {
  return readJournal(snapshotPath, (journal) => journal.list(scope, options)) ??
    { facts: [], nextOffset: null };
}

/** Read a bounded planner page within one exact case run and evidence revision. */
export function listSentinelPlannerGraphFacts(
  snapshotPath: string,
  scope: SentinelPlannerGraphFactScope,
  limit = 10,
): readonly SentinelWorkerGraphFact[] {
  return readJournal(
    snapshotPath,
    (journal) => journal.listForPlanner(scope, limit),
  ) ?? [];
}

/** Read exact case facts independently of the recent planner prompt window. */
export function readSentinelCaseGraphFacts(
  snapshotPath: string,
  scope: SentinelPlannerGraphFactScope,
  query: SentinelWorkerGraphFactPageOptions & { readonly id?: string } = {},
) {
  if (query.id !== undefined) {
    const id = query.id;
    const fact = readJournal(
      snapshotPath,
      (journal) => journal.readCaseFact(scope, id),
    );
    return fact ? { fact } : undefined;
  }
  return readJournal(
    snapshotPath,
    (journal) => journal.listForCase(scope, query),
  ) ??
    { facts: [], nextOffset: null };
}
