/** Private workspace journal for exact, operator-reviewed asset discoveries. */
/// <reference path="./sqlite_types.d.ts" />

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "@std/path";
import { isSentinelCaseId } from "./cases.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

export type SentinelAssetDiscoveryClaim =
  | {
    readonly kind: "asset";
    readonly assetId: string;
    readonly evidenceId: string;
  }
  | {
    readonly kind: "alias";
    readonly assetId: string;
    readonly evidenceId: string;
    readonly alias: string;
  }
  | {
    readonly kind: "relationship";
    readonly assetId: string;
    readonly to: string;
    readonly relation: "depends_on" | "resolved_to" | "uses_hostname";
    readonly evidenceId: string;
  };

export interface SentinelAssetDiscoveryRequest {
  readonly sourceCaseId: string;
  readonly taskId: string;
  readonly evidenceRevision: number;
  readonly sourceDigest: string;
  readonly claim: SentinelAssetDiscoveryClaim;
}

export type SentinelAssetDiscoveryStatus = "pending" | "approved" | "withdrawn";

export interface SentinelAssetDiscoveryRecord
  extends SentinelAssetDiscoveryRequest {
  readonly id: string;
  readonly status: SentinelAssetDiscoveryStatus;
  readonly version: number;
  readonly proposedAt: string;
  readonly updatedAt: string;
}

const VERSION = 1;
const APPLICATION_ID = 0x53414449;
const MAX_RECORDS = 4096;
const MAX_PENDING_PER_CASE = 128;
const statusSet = new Set(["pending", "approved", "withdrawn"]);
const assetRelations = ["depends_on", "resolved_to", "uses_hostname"] as const;
const discoveryIdPattern = /^asset-discovery:[a-f0-9]{64}$/;

function exactId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 &&
    !value.includes("\x00");
}

export function normalizeSentinelAssetDiscoveryClaim(
  raw: unknown,
): SentinelAssetDiscoveryClaim {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Sentinel discovery claim");
  }
  const claim = raw as Record<string, unknown>;
  if (!exactId(claim.evidenceId)) {
    throw new Error("Invalid Sentinel discovery evidence ID");
  }
  if (claim.kind === "relationship") {
    const { assetId, to, evidenceId } = claim;
    const relation = assetRelations.find((value) => value === claim.relation);
    if (
      !exactId(assetId) || !exactId(to) || assetId === to ||
      !relation
    ) {
      throw new Error("Invalid Sentinel discovery relationship");
    }
    return { kind: "relationship", assetId, to, relation, evidenceId };
  }
  if (!exactId(claim.assetId)) {
    throw new Error("Invalid Sentinel discovery asset ID");
  }
  const { assetId, evidenceId } = claim;
  if (claim.kind === "asset") return { kind: "asset", assetId, evidenceId };
  if (
    claim.kind === "alias" && exactId(claim.alias) && claim.alias !== assetId
  ) {
    return { kind: "alias", assetId, evidenceId, alias: claim.alias };
  }
  throw new Error("Invalid Sentinel discovery claim");
}

function normalizeRequest(
  request: SentinelAssetDiscoveryRequest,
): SentinelAssetDiscoveryRequest {
  const { sourceCaseId, taskId, evidenceRevision, sourceDigest, claim } =
    request;
  if (
    !isSentinelCaseId(sourceCaseId) || typeof taskId !== "string" ||
    !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    typeof sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(sourceDigest)
  ) throw new Error("Invalid Sentinel discovery source");
  return {
    sourceCaseId,
    taskId,
    evidenceRevision,
    sourceDigest,
    claim: normalizeSentinelAssetDiscoveryClaim(claim),
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

function openDatabase(baseDir: string) {
  const data = join(resolve(baseDir), "data");
  Deno.mkdirSync(data, { recursive: true, mode: 0o700 });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(data));
  const path = join(data, "sentinel-asset-discoveries.db");
  try {
    Deno.openSync(path, { write: true, createNew: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Sentinel discovery registry requires a private regular file",
    );
  }
  return new DatabaseSync(path);
}

type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function decode(row: Row): SentinelAssetDiscoveryRecord {
  return {
    ...normalizeRequest(JSON.parse(String(row.request))),
    id: String(row.id),
    status: String(row.status) as SentinelAssetDiscoveryStatus,
    version: Number(row.version),
    proposedAt: new Date(Number(row.proposedAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

/** The caller must verify the source evidence before proposing and approving. */
export function openSentinelAssetDiscoveryStore(
  baseDir: string,
  now = Date.now,
) {
  const db = openDatabase(baseDir);
  try {
    db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF",
    );
    transaction(db, () => {
      const applicationId = db.prepare("PRAGMA application_id").get()
        ?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (applicationId === APPLICATION_ID && version === VERSION) return;
      if (
        applicationId !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid Sentinel discovery registry or version");
      }
      db.exec(`
        CREATE TABLE discoveries (
          id TEXT PRIMARY KEY,
          sourceCaseId TEXT NOT NULL,
          request TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'withdrawn')),
          version INTEGER NOT NULL,
          proposedAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX discoveries_by_source ON discoveries(sourceCaseId, status);
        CREATE TABLE discovery_events (
          id TEXT NOT NULL REFERENCES discoveries(id),
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (id, version)
        );
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${VERSION};
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const lookup = db.prepare("SELECT * FROM discoveries WHERE id = ?");
  const writeEvent = db.prepare(
    "INSERT INTO discovery_events VALUES (?, ?, ?, ?)",
  );

  function change(
    id: string,
    expectedVersion: number,
    status: "approved" | "withdrawn",
  ): SentinelAssetDiscoveryRecord | undefined {
    if (
      !discoveryIdPattern.test(id) || !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    ) return;
    return transaction(db, () => {
      const old = lookup.get(id);
      if (
        !old || old.version !== expectedVersion || old.status === "withdrawn" ||
        (status === "approved" && old.status !== "pending")
      ) return;
      const time = now();
      const version = expectedVersion + 1;
      db.prepare(
        "UPDATE discoveries SET status = ?, version = ?, updatedAt = ? WHERE id = ?",
      )
        .run(status, version, time, id);
      writeEvent.run(id, version, status, time);
      return decode(lookup.get(id)!);
    });
  }

  return {
    propose(
      request: SentinelAssetDiscoveryRequest,
    ): SentinelAssetDiscoveryRecord {
      const exact = normalizeRequest(request);
      const encoded = JSON.stringify(exact);
      const id = `asset-discovery:${
        createHash("sha256").update(encoded).digest("hex")
      }`;
      return transaction(db, () => {
        const existing = lookup.get(id);
        if (existing) {
          if (existing.request !== encoded) {
            throw new Error("Conflicting Sentinel discovery identity");
          }
          return decode(existing);
        }
        const total = db.prepare("SELECT count(*) AS count FROM discoveries")
          .get()?.count;
        const pending = db.prepare(
          "SELECT count(*) AS count FROM discoveries WHERE sourceCaseId = ? AND status = 'pending'",
        )
          .get(exact.sourceCaseId)?.count;
        if (
          Number(total) >= MAX_RECORDS ||
          Number(pending) >= MAX_PENDING_PER_CASE
        ) {
          throw new Error("Sentinel discovery registry capacity reached");
        }
        const time = now();
        db.prepare(
          "INSERT INTO discoveries VALUES (?, ?, ?, 'pending', 1, ?, ?)",
        )
          .run(id, exact.sourceCaseId, encoded, time, time);
        writeEvent.run(id, 1, "pending", time);
        return decode(lookup.get(id)!);
      });
    },

    get(id: string): SentinelAssetDiscoveryRecord | undefined {
      if (!discoveryIdPattern.test(id)) return;
      const row = lookup.get(id);
      return row ? decode(row) : undefined;
    },

    approve: (id: string, expectedVersion: number) =>
      change(id, expectedVersion, "approved"),
    withdraw: (id: string, expectedVersion: number) =>
      change(id, expectedVersion, "withdrawn"),

    list(
      options: {
        status?: SentinelAssetDiscoveryStatus;
        sourceCaseId?: string;
        offset?: number;
        limit?: number;
      } = {},
    ): SentinelAssetDiscoveryRecord[] {
      const { status, sourceCaseId, offset = 0, limit = 30 } = options;
      if (
        (status !== undefined && !statusSet.has(status)) ||
        (sourceCaseId !== undefined && !isSentinelCaseId(sourceCaseId)) ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_RECORDS ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      ) {
        throw new Error("Invalid Sentinel discovery registry page");
      }
      return db.prepare(`
        SELECT * FROM discoveries WHERE (? IS NULL OR status = ?) AND (? IS NULL OR sourceCaseId = ?)
        ORDER BY rowid LIMIT ? OFFSET ?
      `).all(
        status ?? null,
        status ?? null,
        sourceCaseId ?? null,
        sourceCaseId ?? null,
        limit,
        offset,
      ).map(decode);
    },

    history(
      id: string,
    ): { version: number; status: SentinelAssetDiscoveryStatus; at: string }[] {
      if (!discoveryIdPattern.test(id)) return [];
      return db.prepare(
        "SELECT version, status, at FROM discovery_events WHERE id = ? ORDER BY version",
      )
        .all(id).map(({ version, status, at }) => ({
          version: Number(version),
          status: String(status) as SentinelAssetDiscoveryStatus,
          at: new Date(Number(at)).toISOString(),
        }));
    },

    close: () => db.close(),
  };
}
