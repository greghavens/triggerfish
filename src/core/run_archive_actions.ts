/** Private admission and outcome records for authorized run archive operations. */
/// <reference path="../sentinel/sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { RunArchiveIdentity } from "./run_archive.ts";

export interface RunArchiveActionInput {
  readonly requestId: string;
  readonly archiveId: string;
  readonly action: "archive" | "restore";
  readonly identity: RunArchiveIdentity;
}

export interface RunArchiveActionRecord extends RunArchiveActionInput {
  readonly status: "pending" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archiveDigest?: string;
}

export type RunArchiveActionAdmission =
  | {
    readonly admitted: true;
    readonly record: RunArchiveActionRecord;
    readonly token: string;
  }
  | { readonly admitted: false; readonly record: RunArchiveActionRecord };

const applicationId = 0x52414143;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const archiveName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const identityPart = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function validatedIdentity(raw: RunArchiveIdentity, requireRevision: boolean) {
  if (!raw || typeof raw !== "object") return undefined;
  const { kind, id, runId, revision } = raw;
  if (
    (kind !== "sentinel" && kind !== "workflow" && kind !== "delegated" &&
      kind !== "scheduled" && kind !== "owner_chat") ||
    typeof id !== "string" || !identityPart.test(id) ||
    typeof runId !== "string" || !identityPart.test(runId) ||
    (revision === undefined
      ? requireRevision && kind === "sentinel"
      : kind !== "sentinel" || !Number.isSafeInteger(revision) || revision < 1)
  ) return undefined;
  return { kind, id, runId, ...(revision !== undefined && { revision }) };
}

function normalize(
  raw: RunArchiveActionInput,
): RunArchiveActionInput | undefined {
  if (
    !raw || typeof raw !== "object" || !raw.identity ||
    typeof raw.requestId !== "string" || !uuid.test(raw.requestId) ||
    typeof raw.archiveId !== "string" || !archiveName.test(raw.archiveId) ||
    raw.archiveId.endsWith(".") ||
    (raw.action !== "archive" && raw.action !== "restore")
  ) return undefined;
  const identity = validatedIdentity(raw.identity, true);
  if (!identity) return undefined;
  return {
    requestId: raw.requestId.toLowerCase(),
    archiveId: raw.archiveId,
    action: raw.action,
    identity,
  };
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
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

export interface RunArchiveRestoreKey {
  readonly requestId: string;
  readonly archiveDigest: string;
}

/** Run inside the destination transaction so the receipt and restored rows commit together. */
export function restoreRunArchiveOnce(
  db: DatabaseSync,
  key: RunArchiveRestoreKey | undefined,
  install: () => boolean,
): boolean {
  if (!key) return install();
  if (!uuid.test(key.requestId) || !digestPattern.test(key.archiveDigest)) {
    return false;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS installed_run_archives (
    requestId TEXT PRIMARY KEY,
    archiveDigest TEXT NOT NULL
  ) STRICT`);
  const prior = db.prepare(
    "SELECT archiveDigest FROM installed_run_archives WHERE requestId = ?",
  ).get(key.requestId);
  if (prior) return prior.archiveDigest === key.archiveDigest;
  if (!install()) return false;
  db.prepare("INSERT INTO installed_run_archives VALUES (?, ?)").run(
    key.requestId,
    key.archiveDigest,
  );
  return true;
}

/** Hold sole execution authority across confirmation and restore. */
export function lockRunArchiveRestore(directory: string, requestId: string) {
  if (!uuid.test(requestId)) return;
  const root = join(directory, "restore-locks");
  Deno.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = Deno.lstatSync(root);
  if (!info.isDirectory || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    return;
  }
  const path = join(root, requestId.toLowerCase());
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const stat = Deno.lstatSync(path);
  if (
    !stat.isFile || stat.isSymlink || (stat.nlink ?? 1) !== 1 ||
    ((stat.mode ?? 0) & 0o077) !== 0
  ) return;
  const file = Deno.openSync(path, { write: true });
  let locked = false;
  try {
    locked = file.tryLockSync(true);
    if (locked) return file;
  } finally {
    if (!locked) file.close();
  }
}

function privateDatabase(path: string) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  const dir = Deno.lstatSync(parent);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o022) !== 0) {
    throw new Error(
      "Run archive actions require an operator-controlled directory.",
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
    throw new Error("Run archive actions require a private regular database.");
  }
  return new DatabaseSync(absolute);
}

function project(row: Row): RunArchiveActionRecord {
  return {
    ...JSON.parse(String(row.binding)) as RunArchiveActionInput,
    status: row.status as RunArchiveActionRecord["status"],
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
    ...(typeof row.archiveDigest === "string" &&
      { archiveDigest: row.archiveDigest }),
  };
}

/** One request claims one action. An interrupted action remains pending without automatic replay. */
export function openRunArchiveActions(path: string, now = Date.now) {
  const db = privateDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF");
    transaction(db, () => {
      const id = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (id === applicationId && version === 1) return;
      if (
        id !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid run archive action database or version.");
      }
      db.exec(`
        CREATE TABLE run_archive_actions (
          sequence INTEGER PRIMARY KEY,
          requestId TEXT NOT NULL UNIQUE,
          archiveId TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('archive','restore')),
          kind TEXT NOT NULL,
          identityId TEXT NOT NULL,
          runId TEXT NOT NULL,
          revision INTEGER,
          binding TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
          archiveDigest TEXT,
          token TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX run_archive_action_identity
          ON run_archive_actions(kind, identityId, runId, sequence DESC);
        CREATE UNIQUE INDEX run_archive_action_package
          ON run_archive_actions(archiveId) WHERE action = 'archive' AND status = 'succeeded';
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = 1;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const exact = db.prepare(
    "SELECT * FROM run_archive_actions WHERE requestId = ?",
  );
  return {
    admit(raw: RunArchiveActionInput): RunArchiveActionAdmission | undefined {
      const input = normalize(raw);
      if (!input) return undefined;
      const binding = JSON.stringify(input);
      return transaction(db, () => {
        const existing = exact.get(input.requestId);
        if (existing) {
          return existing.binding === binding
            ? { admitted: false, record: project(existing) }
            : undefined;
        }
        const at = now();
        const token = crypto.randomUUID();
        const { kind, id, runId, revision } = input.identity;
        const row = db.prepare(`
          INSERT INTO run_archive_actions (
            requestId, archiveId, action, kind, identityId, runId, revision, binding, status, token, createdAt, updatedAt
          ) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)
          RETURNING *
        `).get(
          input.requestId,
          input.archiveId,
          input.action,
          kind,
          id,
          runId,
          revision ?? null,
          binding,
          token,
          at,
          at,
        );
        return { admitted: true, record: project(row!), token };
      });
    },

    recoverRestore(
      raw: RunArchiveActionInput,
    ): RunArchiveActionAdmission | undefined {
      const input = normalize(raw);
      if (!input || input.action !== "restore") return;
      const token = crypto.randomUUID();
      const row = db.prepare(`
        UPDATE run_archive_actions SET token = ?, updatedAt = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending' RETURNING *
      `).get(token, now(), input.requestId, JSON.stringify(input));
      return row && { admitted: true, record: project(row), token };
    },

    complete(
      raw: RunArchiveActionInput,
      token: string,
      status: "succeeded" | "failed",
      archiveDigest?: string,
    ) {
      const input = normalize(raw);
      if (
        !input || typeof token !== "string" || !uuid.test(token) ||
        (status !== "succeeded" && status !== "failed") ||
        (status === "succeeded" && input.action === "archive"
          ? typeof archiveDigest !== "string" ||
            !digestPattern.test(archiveDigest)
          : archiveDigest !== undefined)
      ) return undefined;
      const row = db.prepare(`
        UPDATE OR IGNORE run_archive_actions SET status = ?, updatedAt = ?, token = NULL, archiveDigest = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending' AND token = ? RETURNING *
      `).get(
        status,
        now(),
        archiveDigest ?? null,
        input.requestId,
        JSON.stringify(input),
        token,
      );
      return row && project(row);
    },

    read(requestId: string) {
      if (typeof requestId !== "string" || !uuid.test(requestId)) {
        return undefined;
      }
      const row = exact.get(requestId.toLowerCase());
      return row && project(row);
    },

    readArchived(archiveId: string) {
      if (
        typeof archiveId !== "string" || !archiveName.test(archiveId) ||
        archiveId.endsWith(".")
      ) return undefined;
      const row = db.prepare(`
        SELECT * FROM run_archive_actions
        WHERE archiveId = ? AND action = 'archive' AND status = 'succeeded'
      `).get(archiveId);
      return row && project(row);
    },

    list(identity: RunArchiveIdentity, limit = 20, before?: number) {
      const scope = validatedIdentity(identity, false);
      if (
        !scope || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        before !== undefined && (!Number.isSafeInteger(before) || before < 1)
      ) return { records: [], nextBefore: null };
      const rows = db.prepare(`
        SELECT * FROM run_archive_actions
        WHERE kind = ? AND identityId = ? AND runId = ? AND (? IS NULL OR revision = ?)
          AND sequence < ?
        ORDER BY sequence DESC LIMIT ?
      `).all(
        scope.kind,
        scope.id,
        scope.runId,
        scope.revision ?? null,
        scope.revision ?? null,
        before ?? Number.MAX_SAFE_INTEGER,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      return {
        records: page.map(project),
        nextBefore: rows.length > limit ? Number(page.at(-1)!.sequence) : null,
      };
    },

    close() {
      db.close();
    },
  };
}
