/** Durable operator receipts for exact published inventory withdrawal. */
/// <reference path="../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "@std/path";
import { isSentinelCaseId } from "./cases.ts";
import { normalizeSentinelWithdrawalHost } from "./inventory_host_withdrawal.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

export interface SentinelInventoryWithdrawalRequest {
  readonly requestId: string;
  readonly sourceCaseId: string;
  readonly host: string;
  readonly assetId: string;
  readonly previousDigest: string;
  readonly nextDigest: string;
}

export interface SentinelInventoryWithdrawalReceipt
  extends SentinelInventoryWithdrawalRequest {
  readonly status: "pending" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SentinelInventoryWithdrawalAdmission =
  | {
    readonly admitted: true;
    readonly receipt: SentinelInventoryWithdrawalReceipt;
    readonly token: string;
  }
  | {
    readonly admitted: false;
    readonly receipt: SentinelInventoryWithdrawalReceipt;
  };

const applicationId = 0x53495752;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function normalize(
  raw: SentinelInventoryWithdrawalRequest,
): SentinelInventoryWithdrawalRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { requestId, sourceCaseId, host, assetId, previousDigest, nextDigest } =
    raw;
  if (
    typeof requestId !== "string" || !uuid.test(requestId) ||
    !isSentinelCaseId(sourceCaseId) || typeof host !== "string" ||
    normalizeSentinelWithdrawalHost(host) !== host ||
    typeof assetId !== "string" || !assetId.trim() || assetId.length > 4096 ||
    assetId.includes("\0") ||
    typeof previousDigest !== "string" || !digest.test(previousDigest) ||
    typeof nextDigest !== "string" || !digest.test(nextDigest) ||
    nextDigest === previousDigest
  ) return undefined;
  return {
    requestId: requestId.toLowerCase(),
    sourceCaseId,
    host,
    assetId,
    previousDigest,
    nextDigest,
  };
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function privateDatabase(baseDir: string) {
  const directory = join(resolve(baseDir), "data");
  Deno.mkdirSync(directory, { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
  const path = join(directory, "sentinel-inventory-withdrawal-receipts.db");
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error(
      "Sentinel inventory withdrawals require a private regular receipt journal.",
    );
  }
  return new DatabaseSync(path);
}

function project(row: Row): SentinelInventoryWithdrawalReceipt {
  return {
    ...JSON.parse(String(row.binding)) as SentinelInventoryWithdrawalRequest,
    status: row.status as SentinelInventoryWithdrawalReceipt["status"],
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

/** Record admission before publication. A pending receipt never renews execution authority. */
export function openSentinelInventoryWithdrawalReceipts(
  baseDir: string,
  now = Date.now,
) {
  const db = privateDatabase(baseDir);
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
        throw new Error(
          "Invalid Sentinel inventory withdrawal database or version.",
        );
      }
      db.exec(`
        CREATE TABLE inventory_withdrawals (
          requestId TEXT PRIMARY KEY,
          binding TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
          token TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = 1;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const lookup = db.prepare(
    "SELECT * FROM inventory_withdrawals WHERE requestId = ?",
  );
  return {
    admit(
      raw: SentinelInventoryWithdrawalRequest,
    ): SentinelInventoryWithdrawalAdmission | undefined {
      const input = normalize(raw);
      if (!input) return undefined;
      const binding = JSON.stringify(input);
      return transaction(db, () => {
        const previous = lookup.get(input.requestId);
        if (previous) {
          return previous.binding === binding
            ? { admitted: false, receipt: project(previous) }
            : undefined;
        }
        const at = now();
        const token = crypto.randomUUID();
        const row = db.prepare(`
          INSERT INTO inventory_withdrawals VALUES (?,?,'pending',?,?,?) RETURNING *
        `).get(input.requestId, binding, token, at, at);
        return { admitted: true, receipt: project(row!), token };
      });
    },

    complete(
      raw: SentinelInventoryWithdrawalRequest,
      token: string,
      status: "succeeded" | "failed",
    ) {
      const input = normalize(raw);
      if (
        !input || typeof token !== "string" || !uuid.test(token) ||
        (status !== "succeeded" && status !== "failed")
      ) return undefined;
      const row = db.prepare(`
        UPDATE inventory_withdrawals SET status = ?, token = NULL, updatedAt = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending' AND token = ?
        RETURNING *
      `).get(status, now(), input.requestId, JSON.stringify(input), token);
      return row && project(row);
    },

    read(requestId: string) {
      if (typeof requestId !== "string" || !uuid.test(requestId)) {
        return undefined;
      }
      const row = lookup.get(requestId.toLowerCase());
      return row && project(row);
    },

    close: () => db.close(),
  };
}
