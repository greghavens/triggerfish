/**
 * SQLite-backed StorageProvider implementation.
 *
 * Uses `@db/sqlite` for native SQLite access via FFI. Data persists across
 * process restarts. WAL mode is enabled for concurrent read performance.
 *
 * Default location: `~/.triggerfish/data/triggerfish.db`
 *
 * @module
 */

import { Database } from "@db/sqlite";
import type { StorageProvider } from "./provider.ts";

/** Row shape returned by SELECT value queries. */
interface ValueRow {
  readonly value: string;
}

/** Row shape returned by SELECT key queries. */
interface KeyRow {
  readonly key: string;
}

/** Prepared statements for the key-value table. */
interface SqliteStatements {
  readonly set: ReturnType<Database["prepare"]>;
  readonly get: ReturnType<Database["prepare"]>;
  readonly del: ReturnType<Database["prepare"]>;
  readonly listAll: ReturnType<Database["prepare"]>;
  readonly listPrefix: ReturnType<Database["prepare"]>;
}

/** Open the database, enable WAL mode, and ensure the kv schema exists. */
function initSqliteDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  return db;
}

/** Prepare all reusable SQL statements for the kv table. */
function prepareSqliteStatements(db: Database): SqliteStatements {
  return {
    set: db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
    get: db.prepare("SELECT value FROM kv WHERE key = ?"),
    del: db.prepare("DELETE FROM kv WHERE key = ?"),
    listAll: db.prepare("SELECT key FROM kv"),
    // Range scan, NOT `LIKE prefix || '%'`: a `%` or `_` inside the prefix
    // would act as a wildcard and over-broaden the listing across key
    // namespaces. The range scan matches the prefix literally (and
    // case-sensitively, like the memory provider's startsWith).
    listPrefix: db.prepare("SELECT key FROM kv WHERE key >= ? AND key < ?"),
  };
}

/**
 * Exclusive upper bound for a literal-prefix range scan.
 *
 * Appends U+10FFFF (the highest code point — last in SQLite's UTF-8 byte
 * ordering), so the scan covers exactly the keys that start with the
 * prefix byte-for-byte. Keys containing the noncharacter U+10FFFF itself
 * are not supported by prefix listing.
 */
function prefixUpperBound(prefix: string): string {
  return prefix + "\u{10FFFF}";
}

/** List keys, optionally filtered by a literal (non-wildcard) prefix. */
function listSqliteKeys(
  stmts: SqliteStatements,
  prefix?: string,
): string[] {
  if (prefix === undefined) {
    return stmts.listAll.all<KeyRow>().map((r) => r.key);
  }
  return stmts.listPrefix
    .all<KeyRow>(prefix, prefixUpperBound(prefix))
    .map((r) => r.key);
}

/** Finalize all prepared statements and close the database. */
function closeSqliteDatabase(db: Database, stmts: SqliteStatements): void {
  stmts.set.finalize();
  stmts.get.finalize();
  stmts.del.finalize();
  stmts.listAll.finalize();
  stmts.listPrefix.finalize();
  db.close();
}

/** Build the StorageProvider method set backed by SQLite statements. */
function buildSqliteProvider(
  db: Database,
  stmts: SqliteStatements,
): StorageProvider {
  return {
    // deno-lint-ignore require-await
    async set(key: string, value: string): Promise<void> {
      stmts.set.run(key, value);
    },
    // deno-lint-ignore require-await
    async get(key: string): Promise<string | null> {
      const row = stmts.get.get<ValueRow>(key);
      return row ? row.value : null;
    },
    // deno-lint-ignore require-await
    async delete(key: string): Promise<void> {
      stmts.del.run(key);
    },
    // deno-lint-ignore require-await
    async list(prefix?: string): Promise<string[]> {
      return listSqliteKeys(stmts, prefix);
    },
    // deno-lint-ignore require-await
    async close(): Promise<void> {
      closeSqliteDatabase(db, stmts);
    },
  };
}

/**
 * Create a SQLite-backed StorageProvider.
 *
 * Opens (or creates) a SQLite database at `dbPath`, initialises the schema
 * if it does not exist, and returns a `StorageProvider`.
 */
export function createSqliteStorage(dbPath: string): StorageProvider {
  const db = initSqliteDatabase(dbPath);
  const stmts = prepareSqliteStatements(db);
  return buildSqliteProvider(db, stmts);
}
