/** Exact, classified task lists stored with their execution traces. */

/// <reference path="./sqlite_types.d.ts" />

import type { DatabaseSync } from "node:sqlite";
import { redactCredentialText } from "./logger/mod.ts";
import type { StorageProvider } from "./storage/provider.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  parseClassification,
} from "./types/classification.ts";

export interface ExecutionChecklistScope {
  readonly role: "delegated" | "scheduled";
  readonly sessionId: string;
  readonly runId: string;
}

export interface ArchivedExecutionChecklist extends ExecutionChecklistScope {
  readonly contents: string;
}

type ChecklistStorage = Pick<StorageProvider, "get" | "set" | "compareAndSet">;

/** Validate the exact checklist fields approved for persistence. */
export function canPersistExecutionChecklistItems(
  todos: readonly unknown[],
): boolean {
  const ids = new Set<string>();
  return todos.length <= 100 && todos.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const { id, content, status, priority, created_at, updated_at } =
      value as Record<string, unknown>;
    if (
      Object.keys(value).length !== 6 ||
      typeof id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(id) ||
      ids.has(id) ||
      typeof content !== "string" || !content.trim() ||
      content.length > 1_024 ||
      typeof status !== "string" ||
      !["pending", "in_progress", "completed"].includes(status) ||
      typeof priority !== "string" ||
      !["low", "medium", "high"].includes(priority) ||
      redactCredentialText(id) !== id ||
      redactCredentialText(content) !== content ||
      content.includes("{{secret:") ||
      typeof created_at !== "string" || created_at.length > 40 ||
      !Number.isFinite(Date.parse(created_at)) ||
      typeof updated_at !== "string" || updated_at.length > 40 ||
      !Number.isFinite(Date.parse(updated_at))
    ) return false;
    ids.add(id);
    return true;
  });
}

export function ensureExecutionChecklists(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS execution_checklists (
    role TEXT NOT NULL CHECK(role IN ('delegated', 'scheduled')),
    sessionId TEXT NOT NULL,
    runId TEXT NOT NULL,
    contents TEXT NOT NULL,
    PRIMARY KEY (role, sessionId, runId)
  )`);
}

function read(
  db: DatabaseSync,
  scope: ExecutionChecklistScope,
): string | null {
  const row = db.prepare(
    "SELECT contents FROM execution_checklists WHERE role = ? AND sessionId = ? AND runId = ?",
  ).get(scope.role, scope.sessionId, scope.runId);
  return typeof row?.contents === "string" ? row.contents : null;
}

/** Bind one trusted session to the trace DB while retaining access to old rows. */
export function createExecutionChecklistStorage(
  openDatabase: () => DatabaseSync,
  scope: ExecutionChecklistScope,
  previous?: Pick<ChecklistStorage, "get">,
): ChecklistStorage {
  const withDatabase = <T>(operation: (db: DatabaseSync) => T): T => {
    const db = openDatabase();
    try {
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA trusted_schema = OFF");
      ensureExecutionChecklists(db);
      return operation(db);
    } finally {
      db.close();
    }
  };
  return {
    async get(key) {
      return withDatabase((db) => read(db, scope)) ??
        await previous?.get(key) ?? null;
    },
    set(_key, value) {
      withDatabase((db) => {
        db.prepare(
          "INSERT OR REPLACE INTO execution_checklists VALUES (?, ?, ?, ?)",
        )
          .run(scope.role, scope.sessionId, scope.runId, value);
      });
      return Promise.resolve();
    },
    async compareAndSet(key, expected, value) {
      const previousValue = await previous?.get(key) ?? null;
      return withDatabase((db) => {
        if (expected === previousValue) {
          const inserted = db.prepare(
            "INSERT OR IGNORE INTO execution_checklists VALUES (?, ?, ?, ?)",
          ).run(scope.role, scope.sessionId, scope.runId, value);
          if (inserted.changes === 1) return true;
        }
        return db.prepare(
          "UPDATE execution_checklists SET contents = ? WHERE role = ? AND sessionId = ? AND runId = ? AND contents = ?",
        ).run(value, scope.role, scope.sessionId, scope.runId, expected)
          .changes === 1;
      });
    },
  };
}

export function archiveExecutionChecklist(
  db: DatabaseSync,
  scope: ExecutionChecklistScope,
  ceiling: ClassificationLevel,
): ArchivedExecutionChecklist | undefined {
  const contents = read(db, scope);
  if (contents === null) return;
  const { role, sessionId, runId } = scope;
  const result = { role, sessionId, runId, contents };
  if (!validExecutionChecklist(result, scope, ceiling)) {
    throw new Error(
      "Execution checklist cannot be archived at this classification",
    );
  }
  return result;
}

export function validExecutionChecklist(
  value: ArchivedExecutionChecklist,
  scope: ExecutionChecklistScope,
  ceiling: ClassificationLevel,
): boolean {
  if (
    value?.role !== scope.role || value.sessionId !== scope.sessionId ||
    value.runId !== scope.runId || Object.keys(value).length !== 4 ||
    typeof value.contents !== "string" || value.contents.length > 200_000
  ) return false;
  try {
    const list = JSON.parse(value.contents);
    const level = typeof list?._classification === "string"
      ? parseClassification(list._classification)
      : undefined;
    return !!level?.ok && canFlowTo(level.value, ceiling) &&
      Object.keys(list).length === 3 &&
      typeof list.revision === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(list.revision) &&
      Array.isArray(list.todos) &&
      canPersistExecutionChecklistItems(list.todos);
  } catch {
    return false;
  }
}

export function installExecutionChecklist(
  db: DatabaseSync,
  checklist: ArchivedExecutionChecklist,
): void {
  if (
    db.prepare("INSERT OR IGNORE INTO execution_checklists VALUES (?, ?, ?, ?)")
      .run(
        checklist.role,
        checklist.sessionId,
        checklist.runId,
        checklist.contents,
      ).changes !==
      1
  ) {
    throw new Error("Execution checklist identity collision");
  }
}
