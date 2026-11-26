/** Durable admission and outcome for operator-reviewed inventory publication. */
/// <reference path="../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "@std/path";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";

type InventoryPublicationNamespace = "withdrawal" | "affiliation";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

export type InventoryPublicationReceipt<T> = T & {
  readonly status: "pending" | "succeeded" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type InventoryPublicationAdmission<T> =
  | {
    readonly admitted: true;
    readonly receipt: InventoryPublicationReceipt<T>;
    readonly token: string;
  }
  | {
    readonly admitted: false;
    readonly receipt: InventoryPublicationReceipt<T>;
  };

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

function privateDatabase(
  baseDir: string,
  namespace: InventoryPublicationNamespace,
) {
  const directory = join(resolve(baseDir), "data");
  Deno.mkdirSync(directory, { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
  const path = join(directory, `sentinel-inventory-${namespace}-receipts.db`);
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
      "Sentinel inventory publication requires a private regular receipt journal.",
    );
  }
  return new DatabaseSync(path);
}

function project<T>(row: Row): InventoryPublicationReceipt<T> {
  return {
    ...JSON.parse(String(row.binding)) as T,
    status: row.status as InventoryPublicationReceipt<T>["status"],
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

/** Record admission before publication. A pending receipt never renews execution authority. */
export function openSentinelInventoryPublicationReceipts<
  T extends { requestId: string },
>(
  baseDir: string,
  namespace: InventoryPublicationNamespace,
  normalize: (input: T) => T | undefined,
  now = Date.now,
) {
  const applicationId = namespace === "withdrawal" ? 0x53495752 : 0x53494152;
  const table = namespace === "withdrawal"
    ? "inventory_withdrawals"
    : "inventory_affiliations";
  const db = privateDatabase(baseDir, namespace);
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
          "Invalid Sentinel inventory publication database or version.",
        );
      }
      db.exec(`
        CREATE TABLE ${table} (
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
    `SELECT * FROM ${table} WHERE requestId = ?`,
  );
  return {
    admit(raw: T): InventoryPublicationAdmission<T> | undefined {
      const input = normalize(raw);
      if (!input) return undefined;
      const binding = JSON.stringify(input);
      return transaction(db, () => {
        const previous = lookup.get(input.requestId);
        if (previous) {
          return previous.binding === binding
            ? { admitted: false, receipt: project<T>(previous) }
            : undefined;
        }
        const at = now();
        const token = crypto.randomUUID();
        const row = db.prepare(`
          INSERT INTO ${table} VALUES (?,?,'pending',?,?,?) RETURNING *
        `).get(input.requestId, binding, token, at, at);
        return { admitted: true, receipt: project<T>(row!), token };
      });
    },

    complete(
      raw: T,
      token: string,
      status: "succeeded" | "failed",
    ) {
      const input = normalize(raw);
      if (
        !input || typeof token !== "string" || !uuid.test(token) ||
        (status !== "succeeded" && status !== "failed")
      ) return undefined;
      const row = db.prepare(`
        UPDATE ${table} SET status = ?, token = NULL, updatedAt = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending' AND token = ?
        RETURNING *
      `).get(status, now(), input.requestId, JSON.stringify(input), token);
      return row && project<T>(row);
    },

    /** Caller holds the publication lock and verified the exact committed graph digest. */
    reconcilePublished(raw: T) {
      const input = normalize(raw);
      if (!input) return undefined;
      const row = db.prepare(`
        UPDATE ${table} SET status = 'succeeded', token = NULL, updatedAt = ?
        WHERE requestId = ? AND binding = ? AND status = 'pending'
        RETURNING *
      `).get(now(), input.requestId, JSON.stringify(input));
      return row && project<T>(row);
    },

    read(requestId: string) {
      if (typeof requestId !== "string" || !uuid.test(requestId)) {
        return undefined;
      }
      const row = lookup.get(requestId.toLowerCase());
      return row && project<T>(row);
    },

    close: () => db.close(),
  };
}
