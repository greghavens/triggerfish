/** Private admission and outcome records for authorized run archive operations. */
/// <reference path="./sqlite_types.d.ts" />

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

export interface RunArchivePurgeReceipt {
  readonly requestId: string;
  readonly archiveId: string;
  readonly archiveDigest: string;
  readonly identity: RunArchiveIdentity;
  readonly status: "pending" | "succeeded";
}

export type RunArchivePurgeAuthorization =
  | { readonly kind: "standalone" }
  | { readonly kind: "batch"; readonly batchRequestId: string };

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
      kind !== "scheduled" && kind !== "owner_chat" &&
      kind !== "team_delivery") ||
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

/** Hold sole execution authority across confirmation and execution. */
export function lockRunArchiveAction(directory: string, requestId: string) {
  if (!uuid.test(requestId)) return;
  return lockArchiveFile(directory, requestId.toLowerCase());
}

/** Serialize Sentinel package publication with dependency-aware deletion. */
export function lockSentinelArchiveCatalog(directory: string) {
  return lockArchiveFile(directory, "sentinel-dependency-catalog");
}

function lockArchiveFile(directory: string, name: string) {
  const root = join(directory, "restore-locks");
  Deno.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = Deno.lstatSync(root);
  if (!info.isDirectory || info.isSymlink || ((info.mode ?? 0) & 0o077) !== 0) {
    return;
  }
  const path = join(root, name);
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

function createArchiveBatches(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE run_archive_batches (
      requestId TEXT PRIMARY KEY,
      binding TEXT NOT NULL,
      eligible TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
  `);
}

function createArchivePurges(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE run_archive_purges (
      archiveId TEXT PRIMARY KEY,
      requestId TEXT NOT NULL UNIQUE,
      archiveDigest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','succeeded'))
    ) STRICT;
    PRAGMA user_version = 3;
  `);
}

/** Durable admission and results for exact reviewed archive actions. */
function addPurgeAuthorization(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE run_archive_purges ADD COLUMN authorization TEXT;
    PRAGMA user_version = 4;
  `);
}

function addPurgeBatchDigests(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE run_archive_batches ADD COLUMN purgeDigests TEXT;
    PRAGMA user_version = 5;
  `);
}

interface ReviewedPurgeDigest {
  readonly archiveId: string;
  readonly archiveDigest: string;
}

function exactPurgeDigests(
  eligible: readonly string[],
  entries: readonly ReviewedPurgeDigest[],
): boolean {
  return entries.length > 0 && entries.length === eligible.length &&
    entries.length <= 8 && new Set(eligible).size === eligible.length &&
    entries.every((entry, index) =>
      entry && typeof entry === "object" &&
      entry.archiveId === eligible[index] && uuid.test(entry.archiveId) &&
      typeof entry.archiveDigest === "string" &&
      digestPattern.test(entry.archiveDigest)
    );
}

export function openRunArchiveActions(path: string, now = Date.now) {
  const db = privateDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF");
    transaction(db, () => {
      const id = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (id === applicationId && version === 5) return;
      if (
        id === applicationId &&
        (version === 1 || version === 2 || version === 3 || version === 4)
      ) {
        if (version === 1) createArchiveBatches(db);
        if (version < 3) createArchivePurges(db);
        if (version < 4) addPurgeAuthorization(db);
        addPurgeBatchDigests(db);
        return;
      }
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
      `);
      createArchiveBatches(db);
      createArchivePurges(db);
      addPurgeAuthorization(db);
      addPurgeBatchDigests(db);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const exact = db.prepare(
    "SELECT * FROM run_archive_actions WHERE requestId = ?",
  );
  const purge = db.prepare(
    "SELECT * FROM run_archive_purges WHERE archiveId = ?",
  );
  const archived = db.prepare(`
    SELECT * FROM run_archive_actions
    WHERE archiveId = ? AND action = 'archive' AND status = 'succeeded'
  `);
  function purgeReceipt(archiveId: string): RunArchivePurgeReceipt | undefined {
    const row = purge.get(archiveId);
    const source = row && archived.get(archiveId);
    if (!row || !source) return;
    return {
      archiveId,
      requestId: String(row.requestId),
      archiveDigest: String(row.archiveDigest),
      identity: project(source).identity,
      status: row.status === "succeeded" ? "succeeded" : "pending",
    };
  }
  return {
    readPurge: purgeReceipt,

    readPurgeAuthorization(
      archiveId: string,
    ): RunArchivePurgeAuthorization | undefined {
      const raw = purge.get(archiveId)?.authorization;
      if (raw === null || raw === undefined) return;
      if (raw === "standalone") return { kind: "standalone" };
      if (typeof raw === "string" && uuid.test(raw)) {
        return { kind: "batch", batchRequestId: raw };
      }
      throw new Error("Invalid retained purge authorization.");
    },

    /** Requires the caller to hold the package lock and current scope. */
    admitPurge(
      requestId: string,
      archive: RunArchiveActionRecord,
      authorization?: RunArchivePurgeAuthorization,
    ) {
      if (
        authorization?.kind === "batch" &&
        !uuid.test(authorization.batchRequestId)
      ) return;
      const binding = authorization?.kind === "batch"
        ? authorization.batchRequestId
        : authorization?.kind ?? null;
      if (
        !uuid.test(requestId) || !uuid.test(archive.archiveId) ||
        !archive.archiveDigest || !digestPattern.test(archive.archiveDigest)
      ) {
        return;
      }
      return transaction(db, () => {
        const source = archived.get(archive.archiveId);
        if (
          !source || JSON.stringify(project(source)) !== JSON.stringify(archive)
        ) return;
        const prior = purgeReceipt(archive.archiveId);
        if (prior) {
          const saved = purge.get(archive.archiveId)?.authorization;
          return prior.requestId === requestId &&
              prior.archiveDigest === archive.archiveDigest &&
              (saved === null || saved === binding)
            ? prior
            : undefined;
        }
        if (
          exact.get(requestId) ||
          db.prepare("SELECT 1 FROM run_archive_batches WHERE requestId = ?")
            .get(requestId) ||
          db.prepare("SELECT 1 FROM run_archive_purges WHERE requestId = ?")
            .get(requestId) ||
          db.prepare(
            "SELECT 1 FROM run_archive_actions WHERE archiveId = ? AND action = 'restore' AND status = 'pending'",
          ).get(archive.archiveId)
        ) return;
        db.prepare(`
          INSERT INTO run_archive_purges (archiveId, requestId, archiveDigest, status, authorization)
          VALUES (?, ?, ?, 'pending', ?)
        `).run(archive.archiveId, requestId, archive.archiveDigest!, binding);
        return purgeReceipt(archive.archiveId);
      });
    },

    completePurge(receipt: RunArchivePurgeReceipt) {
      const changed = db.prepare(`
        UPDATE run_archive_purges SET status = 'succeeded'
        WHERE archiveId = ? AND requestId = ? AND archiveDigest = ? AND status = 'pending'
      `).run(receipt.archiveId, receipt.requestId, receipt.archiveDigest);
      return changed.changes === 1
        ? purgeReceipt(receipt.archiveId)
        : undefined;
    },

    readBatch(requestId: string): {
      readonly binding: string;
      readonly eligible: string[];
      readonly purgeDigests?: readonly ReviewedPurgeDigest[];
    } | undefined {
      if (!uuid.test(requestId)) return undefined;
      const row = db.prepare(
        "SELECT binding, eligible, purgeDigests FROM run_archive_batches WHERE requestId = ?",
      ).get(requestId);
      if (!row) return;
      const eligible = JSON.parse(String(row.eligible)) as string[];
      const purgeDigests = row.purgeDigests === null
        ? undefined
        : JSON.parse(String(row.purgeDigests)) as ReviewedPurgeDigest[];
      if (
        !Array.isArray(eligible) || (purgeDigests !== undefined &&
          (!Array.isArray(purgeDigests) ||
            !exactPurgeDigests(eligible, purgeDigests)))
      ) {
        throw new Error("Invalid retained batch purge approval.");
      }
      return {
        binding: String(row.binding),
        eligible,
        ...(purgeDigests && { purgeDigests }),
      };
    },

    pendingReviewedPurgeBatchBindings() {
      return db.prepare(`
        SELECT binding FROM run_archive_batches AS batch
        WHERE purgeDigests IS NOT NULL AND EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN json_valid(batch.purgeDigests) THEN batch.purgeDigests ELSE '[]' END) AS member
          WHERE member.type = 'object' AND NOT EXISTS (
            SELECT 1 FROM run_archive_purges AS purge
            WHERE purge.archiveId = json_extract(
              CASE WHEN member.type = 'object' THEN member.value ELSE '{}' END, '$.archiveId'
            )
              AND purge.status = 'succeeded'
          )
        ) ORDER BY batch.createdAt, batch.rowid
      `).all().map(({ binding }) => String(binding));
    },

    admitBatch(
      requestId: string,
      binding: string,
      eligible: readonly string[],
      purgeDigests?: readonly ReviewedPurgeDigest[],
    ) {
      if (
        !uuid.test(requestId) ||
        (purgeDigests && !exactPurgeDigests(eligible, purgeDigests))
      ) return false;
      return db.prepare(`
        INSERT OR IGNORE INTO run_archive_batches
          (requestId, binding, eligible, createdAt, purgeDigests)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        requestId,
        binding,
        JSON.stringify(eligible),
        now(),
        purgeDigests ? JSON.stringify(purgeDigests) : null,
      ).changes === 1;
    },

    admit(raw: RunArchiveActionInput): RunArchiveActionAdmission | undefined {
      const input = normalize(raw);
      if (!input) return undefined;
      const binding = JSON.stringify(input);
      return transaction(db, () => {
        if (
          db.prepare("SELECT 1 FROM run_archive_purges WHERE requestId = ?")
            .get(input.requestId)
        ) return undefined;
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

    recoverPending(
      raw: RunArchiveActionInput,
    ): RunArchiveActionAdmission | undefined {
      const input = normalize(raw);
      if (!input) return;
      const token = crypto.randomUUID();
      const row = db.prepare(`
        UPDATE run_archive_actions SET token = ?, updatedAt = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending' RETURNING *
      `).get(token, now(), input.requestId, JSON.stringify(input));
      return row && { admitted: true, record: project(row), token };
    },

    recordPublication(
      raw: RunArchiveActionInput,
      token: string,
      digest: string,
    ) {
      const input = normalize(raw);
      if (
        input?.action !== "archive" || !uuid.test(token) ||
        !digestPattern.test(digest)
      ) return false;
      return db.prepare(`
        UPDATE run_archive_actions SET archiveDigest = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending'
          AND token = ? AND archiveDigest IS NULL
      `).run(digest, input.requestId, JSON.stringify(input), token).changes ===
        1;
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

    readArchived(archiveId: string, includePurged = false) {
      if (
        typeof archiveId !== "string" || !archiveName.test(archiveId) ||
        archiveId.endsWith(".")
      ) return undefined;
      if (!includePurged && purge.get(archiveId)) return;
      const row = archived.get(archiveId);
      return row && project(row);
    },

    latestArchive(identity: RunArchiveIdentity) {
      const scope = validatedIdentity(identity, false);
      if (!scope) return;
      const row = db.prepare(`
        SELECT * FROM run_archive_actions
        WHERE kind = ? AND identityId = ? AND runId = ? AND revision IS ?
          AND action = 'archive' AND status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM run_archive_purges AS p WHERE p.archiveId = run_archive_actions.archiveId)
        ORDER BY sequence DESC LIMIT 1
      `).get(scope.kind, scope.id, scope.runId, scope.revision ?? null);
      return row && project(row);
    },

    latestRestoreForArchive(archive: RunArchiveActionRecord) {
      if (archive.action !== "archive" || archive.status !== "succeeded") {
        return;
      }
      const { kind, id, runId, revision } = archive.identity;
      const row = db.prepare(`
        SELECT * FROM run_archive_actions
        WHERE kind = ? AND identityId = ? AND runId = ? AND revision IS ?
          AND archiveId = ? AND action = 'restore'
        ORDER BY sequence DESC LIMIT 1
      `).get(kind, id, runId, revision ?? null, archive.archiveId);
      return row && project(row);
    },

    /** Pending publications and quarantines still count as retained. */
    sentinelDependencyCatalog(before: number) {
      return db.prepare(`
        SELECT * FROM run_archive_actions AS a
        WHERE kind = 'sentinel' AND action = 'archive' AND sequence < ?
          AND status IN ('succeeded','pending') AND archiveDigest IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM run_archive_purges AS p
            WHERE p.archiveId = a.archiveId AND p.status = 'succeeded'
          )
        ORDER BY sequence DESC LIMIT 32
      `).all(before).map((row) => ({
        sequence: Number(row.sequence),
        record: project(row),
      }));
    },

    /** Check whether an already quarantined identity lost its last usable package. */
    hasRemovedSentinelSource(id: string, revision: number, runId?: string) {
      return !!db.prepare(`
        SELECT 1 FROM run_archive_actions AS a JOIN run_archive_purges AS p USING(archiveId)
        WHERE a.kind = 'sentinel' AND a.action = 'archive'
          AND a.identityId = ? AND a.revision = ? AND (? IS NULL OR a.runId = ?)
          AND NOT EXISTS (
            SELECT 1 FROM run_archive_actions AS source
            WHERE source.kind = 'sentinel' AND source.action = 'archive'
              AND source.status = 'succeeded' AND source.identityId = a.identityId
              AND source.runId = a.runId AND source.revision = a.revision
              AND NOT EXISTS (SELECT 1 FROM run_archive_purges AS removed WHERE removed.archiveId = source.archiveId)
          )
        LIMIT 1
      `).get(id, revision, runId ?? null, runId ?? null);
    },

    listSentinelArchiveCatalog(
      query: string,
      status: RunArchiveActionRecord["status"] | undefined,
      archiveId: string | undefined,
      before = Number.MAX_SAFE_INTEGER,
    ) {
      return db.prepare(`
        SELECT * FROM run_archive_actions
        WHERE kind = 'sentinel' AND action = 'archive' AND sequence < ?
          AND NOT EXISTS (SELECT 1 FROM run_archive_purges AS p WHERE p.archiveId = run_archive_actions.archiveId)
          AND instr(lower(identityId), ?) > 0
          AND (? IS NULL OR status = ?)
          AND (? IS NULL OR archiveId = ?)
        ORDER BY sequence DESC LIMIT 32
      `).all(
        before,
        query,
        status ?? null,
        status ?? null,
        archiveId ?? null,
        archiveId ?? null,
      ).map((row) => ({
        sequence: Number(row.sequence),
        record: project(row),
      }));
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
