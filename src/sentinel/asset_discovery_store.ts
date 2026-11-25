/** Private workspace journal for exact, operator-reviewed asset discoveries. */
/// <reference path="../core/sqlite_types.d.ts" />

import { createHash } from "node:crypto";
import { isIP } from "node:net";
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

export interface SentinelAssetDiscoveryBatchWithdrawalRequest {
  readonly sourceCaseId: string;
  readonly requestId: string;
  readonly host: string;
  readonly previewDigest: string;
  readonly discoveries: readonly {
    readonly id: string;
    readonly version: number;
  }[];
}

export interface SentinelAssetDiscoveryBatchWithdrawal
  extends SentinelAssetDiscoveryBatchWithdrawalRequest {
  readonly withdrawn: readonly SentinelAssetDiscoveryRecord[];
  readonly withdrawnAt: string;
}

const VERSION = 2;
const APPLICATION_ID = 0x53414449;
export const MAX_SENTINEL_DISCOVERY_BATCH_WITHDRAWAL = 100;
const MAX_RECORDS = 4096;
export { MAX_RECORDS as sentinelAssetDiscoveryRecordLimit };
const MAX_PENDING_PER_CASE = 128;
const statusSet = new Set(["pending", "approved", "withdrawn"]);
const assetRelations = ["depends_on", "resolved_to", "uses_hostname"] as const;
const discoveryIdPattern = /^asset-discovery:[a-f0-9]{64}$/;
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

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

function normalizeWithdrawal(
  input: SentinelAssetDiscoveryBatchWithdrawalRequest,
): SentinelAssetDiscoveryBatchWithdrawalRequest | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { sourceCaseId, requestId, host, previewDigest, discoveries } = input;
  if (
    !isSentinelCaseId(sourceCaseId) ||
    typeof requestId !== "string" || !requestIdPattern.test(requestId) ||
    typeof host !== "string" || host.length < 1 || host.length > 253 ||
    host !== host.toLowerCase() || host.includes("%") ||
    (!isIP(host) &&
      !host.split(".").every((label) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
      )) ||
    typeof previewDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(previewDigest) ||
    !Array.isArray(discoveries) || discoveries.length < 1 ||
    discoveries.length > MAX_SENTINEL_DISCOVERY_BATCH_WITHDRAWAL
  ) return undefined;
  const selected = new Map<string, number>();
  for (const entry of discoveries) {
    if (
      !entry || typeof entry.id !== "string" ||
      !discoveryIdPattern.test(entry.id) || selected.has(entry.id) ||
      !Number.isSafeInteger(entry.version) || entry.version < 1 ||
      entry.version >= Number.MAX_SAFE_INTEGER
    ) return undefined;
    selected.set(entry.id, entry.version);
  }
  return {
    sourceCaseId,
    requestId: requestId.toLowerCase(),
    host,
    previewDigest,
    discoveries: [...selected.keys()].sort().map((id) => ({
      id,
      version: selected.get(id)!,
    })),
  };
}

function createWithdrawalRegistry(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE discovery_batch_withdrawals (
      requestId TEXT PRIMARY KEY,
      binding TEXT NOT NULL,
      receipt TEXT NOT NULL
    );
    PRAGMA user_version = ${VERSION};
  `);
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
      if (applicationId === APPLICATION_ID && version === 1) {
        createWithdrawalRegistry(db);
        return;
      }
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
      `);
      createWithdrawalRegistry(db);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  const lookup = db.prepare("SELECT * FROM discoveries WHERE id = ?");
  const writeEvent = db.prepare(
    "INSERT INTO discovery_events VALUES (?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE discoveries SET status = ?, version = ?, updatedAt = ? WHERE id = ?",
  );
  const lookupWithdrawal = db.prepare(
    "SELECT binding, receipt FROM discovery_batch_withdrawals WHERE requestId = ?",
  );

  function writeChange(
    id: string,
    previousVersion: number,
    status: "approved" | "withdrawn",
    time: number,
  ): SentinelAssetDiscoveryRecord {
    const version = previousVersion + 1;
    update.run(status, version, time, id);
    writeEvent.run(id, version, status, time);
    return decode(lookup.get(id)!);
  }

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
      return writeChange(id, expectedVersion, status, now());
    });
  }

  function hasProposalRequests() {
    return !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'discovery_proposal_requests'",
    ).get();
  }

  function proposalReceipt(
    requestId: string,
  ): SentinelAssetDiscoveryRecord | undefined {
    if (!hasProposalRequests()) return;
    const row = db.prepare(
      `SELECT discoveries.*, events.version AS receiptVersion,
        events.status AS receiptStatus, events.at AS receiptAt
      FROM discovery_proposal_requests AS requests
      JOIN discoveries ON discoveries.id = requests.id
      JOIN discovery_events AS events ON events.id = requests.id AND events.version = requests.version
      WHERE requests.requestId = ?`,
    ).get(requestId);
    if (!row) return;
    const receipt = decode(row);
    const exact = normalizeRequest(receipt);
    if (
      receipt.id !==
        `asset-discovery:${
          createHash("sha256").update(JSON.stringify(exact)).digest("hex")
        }`
    ) {
      throw new Error("Invalid Sentinel discovery proposal receipt");
    }
    return {
      ...receipt,
      version: Number(row.receiptVersion),
      status: String(row.receiptStatus) as SentinelAssetDiscoveryStatus,
      updatedAt: new Date(Number(row.receiptAt)).toISOString(),
    };
  }

  return {
    propose(
      request: SentinelAssetDiscoveryRequest,
      requestId?: string,
    ): SentinelAssetDiscoveryRecord {
      if (requestId !== undefined && !requestIdPattern.test(requestId)) {
        throw new Error("Invalid Sentinel discovery request ID");
      }
      const key = requestId?.toLowerCase();
      const exact = normalizeRequest(request);
      const encoded = JSON.stringify(exact);
      const id = `asset-discovery:${
        createHash("sha256").update(encoded).digest("hex")
      }`;
      return transaction(db, () => {
        const prior = key && proposalReceipt(key);
        if (prior) {
          if (prior.id !== id) {
            throw new Error("Conflicting Sentinel discovery request ID");
          }
          return prior;
        }
        const existing = lookup.get(id);
        if (existing && existing.request !== encoded) {
          throw new Error("Conflicting Sentinel discovery identity");
        }
        if (!existing) {
          const total = db.prepare("SELECT count(*) AS count FROM discoveries")
            .get()?.count;
          const pending = db.prepare(
            "SELECT count(*) AS count FROM discoveries WHERE sourceCaseId = ? AND status = 'pending'",
          ).get(exact.sourceCaseId)?.count;
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
        }
        const receipt = decode(lookup.get(id)!);
        if (key) {
          db.exec(`CREATE TABLE IF NOT EXISTS discovery_proposal_requests (
            requestId TEXT PRIMARY KEY,
            id TEXT NOT NULL REFERENCES discoveries(id),
            version INTEGER NOT NULL,
            FOREIGN KEY (id, version) REFERENCES discovery_events(id, version)
          ) STRICT`);
          if (
            Number(
              db.prepare(
                "SELECT count(*) AS count FROM discovery_proposal_requests",
              ).get()?.count,
            ) >= MAX_RECORDS * 4
          ) {
            throw new Error(
              "Sentinel discovery proposal receipt capacity reached",
            );
          }
          db.prepare("INSERT INTO discovery_proposal_requests VALUES (?, ?, ?)")
            .run(key, id, receipt.version);
        }
        return receipt;
      });
    },

    readProposalReceipt(
      requestId: string,
    ): SentinelAssetDiscoveryRecord | undefined {
      return requestIdPattern.test(requestId)
        ? proposalReceipt(requestId.toLowerCase())
        : undefined;
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

    /** Apply a previously previewed exact approved set with a durable request receipt. */
    withdrawApprovedBatch(
      input: SentinelAssetDiscoveryBatchWithdrawalRequest,
    ): SentinelAssetDiscoveryBatchWithdrawal | undefined {
      const exact = normalizeWithdrawal(input);
      if (!exact) return undefined;
      const binding = JSON.stringify(exact);
      return transaction(db, () => {
        const previous = lookupWithdrawal.get(exact.requestId);
        if (previous) {
          return previous.binding === binding
            ? JSON.parse(
              String(previous.receipt),
            ) as SentinelAssetDiscoveryBatchWithdrawal
            : undefined;
        }
        const { sourceCaseId, discoveries } = exact;
        for (const { id, version } of discoveries) {
          const row = lookup.get(id);
          if (
            !row || row.sourceCaseId !== sourceCaseId ||
            row.status !== "approved" || row.version !== version
          ) return undefined;
        }
        const time = now();
        const receipt: SentinelAssetDiscoveryBatchWithdrawal = {
          ...exact,
          withdrawn: discoveries.map(({ id, version }) =>
            writeChange(id, version, "withdrawn", time)
          ),
          withdrawnAt: new Date(time).toISOString(),
        };
        db.prepare("INSERT INTO discovery_batch_withdrawals VALUES (?, ?, ?)")
          .run(exact.requestId, binding, JSON.stringify(receipt));
        return receipt;
      });
    },

    readBatchWithdrawal(
      requestId: string,
    ): SentinelAssetDiscoveryBatchWithdrawal | undefined {
      if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) {
        return undefined;
      }
      const row = lookupWithdrawal.get(requestId.toLowerCase());
      return row
        ? JSON.parse(
          String(row.receipt),
        ) as SentinelAssetDiscoveryBatchWithdrawal
        : undefined;
    },

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

    /** Freeze candidate order before asynchronous verification of foreign sources. */
    listPeerApprovals(
      caseId: string,
      after?: string,
    ): SentinelAssetDiscoveryRecord[] {
      if (!isSentinelCaseId(caseId)) {
        throw new Error("Invalid Sentinel discovery consumer case");
      }
      if (after !== undefined && !discoveryIdPattern.test(after)) {
        throw new Error("Invalid Sentinel discovery cursor");
      }
      const rows = db.prepare(`
        SELECT * FROM discoveries WHERE status = 'approved' AND sourceCaseId <> ?
          AND (? IS NULL OR rowid > (SELECT rowid FROM discoveries WHERE id = ? AND sourceCaseId <> ?))
        ORDER BY rowid LIMIT ?
      `).all(caseId, after ?? null, after ?? null, caseId, MAX_RECORDS + 1);
      if (rows.length > MAX_RECORDS) {
        throw new Error("Sentinel discovery registry exceeds its record limit");
      }
      return rows.map(decode);
    },

    /** A complete bounded source-case view from a single SQLite statement. */
    listApprovedForSource(
      sourceCaseId: string,
    ): SentinelAssetDiscoveryRecord[] {
      if (!isSentinelCaseId(sourceCaseId)) {
        throw new Error("Invalid Sentinel discovery source case");
      }
      const rows = db.prepare(`
        SELECT * FROM discoveries WHERE sourceCaseId = ? AND status = 'approved'
        ORDER BY id LIMIT ?
      `).all(sourceCaseId, MAX_RECORDS + 1);
      if (rows.length > MAX_RECORDS) {
        throw new Error("Sentinel discovery registry exceeds its record limit");
      }
      return rows.map(decode);
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
