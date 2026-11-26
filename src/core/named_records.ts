/// <reference path="./sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { redactCredentialText } from "./logger/redactor.ts";

export interface NamedRecord {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly pinnedAt: string | null;
  readonly updatedAt: string;
  readonly deleted: boolean;
}

export interface NamedRecordChange {
  readonly id: string;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly pinned?: boolean;
  readonly deleted?: true;
}

export function parseDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const name = value.trim();
  if (
    !name || Array.from(name).length > 200 || /[\p{Cc}\p{Cf}]/u.test(name) ||
    redactCredentialText(name) !== name
  ) return;
  return name;
}

/** Durable list metadata. Transactional tombstones keep existing audit history. */
export function namedConversations(baseDir: string) {
  const collection = "conversation";
  const path = join(baseDir, "named-records.db");
  function use<T>(run: (db: DatabaseSync) => T, empty: T, write = false): T {
    if (!write) {
      try {
        Deno.statSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return empty;
        throw error;
      }
    }
    const db = new DatabaseSync(path, { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      if (write) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS named_records (
            collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY (collection,id)
          );
          CREATE TABLE IF NOT EXISTS named_record_requests (
            collection TEXT NOT NULL, id TEXT NOT NULL, input TEXT NOT NULL,
            data TEXT NOT NULL, PRIMARY KEY (collection,id)
          )
        `);
      }
      return run(db);
    } finally {
      db.close();
    }
  }

  function load(db: DatabaseSync, id: string): NamedRecord | undefined {
    const row = db.prepare(
      "SELECT data FROM named_records WHERE collection=? AND id=?",
    ).get(collection, id);
    return row && JSON.parse(String(row.data)) as NamedRecord;
  }

  function receipt(
    db: DatabaseSync,
    request: string,
    changes: readonly NamedRecordChange[],
  ) {
    const saved = db.prepare(
      "SELECT input,data FROM named_record_requests WHERE collection=? AND id=?",
    ).get(collection, request);
    return saved?.input === JSON.stringify(changes)
      ? JSON.parse(String(saved.data)) as NamedRecord[]
      : undefined;
  }

  return {
    read(id: string) {
      return use((db) => load(db, id), undefined);
    },
    list(limit: number, offset: number) {
      return use(
        (db) =>
          db.prepare(`
          SELECT data FROM named_records WHERE collection=?
            AND json_extract(data,'$.deleted')=0
            ORDER BY json_extract(data,'$.pinnedAt') DESC NULLS LAST,
              json_extract(data,'$.updatedAt') DESC, id ASC
            LIMIT ? OFFSET ?
        `).all(collection, limit, offset)
            .map((row) => JSON.parse(String(row.data)) as NamedRecord),
        [],
      );
    },
    receipt(request: string, changes: readonly NamedRecordChange[]) {
      return use((db) => receipt(db, request, changes), undefined);
    },
    apply(request: string, changes: readonly NamedRecordChange[]) {
      return use(
        (db) => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const duplicate = receipt(db, request, changes);
            if (duplicate) {
              db.exec("COMMIT");
              return duplicate;
            }
            const prior = changes.map(({ id }) => load(db, id));
            if (
              !changes.length ||
              new Set(changes.map(({ id }) => id)).size !== changes.length ||
              changes.some((change, i) =>
                (prior[i]?.version ?? 0) !== change.expectedVersion ||
                prior[i]?.deleted || (change.deleted && !prior[i])
              )
            ) {
              db.exec("ROLLBACK");
              return;
            }
            const now = new Date().toISOString();
            const records = changes.map((change, i): NamedRecord => ({
              id: change.id,
              version: change.expectedVersion + 1,
              name: change.name ?? prior[i]?.name ?? change.id,
              pinnedAt: change.pinned === undefined
                ? prior[i]?.pinnedAt ?? null
                : change.pinned
                ? prior[i]?.pinnedAt ?? now
                : null,
              updatedAt: now,
              deleted: change.deleted === true,
            }));
            db.prepare("INSERT INTO named_record_requests VALUES (?,?,?,?)")
              .run(
                collection,
                request,
                JSON.stringify(changes),
                JSON.stringify(records),
              );
            const save = db.prepare(`
            INSERT INTO named_records VALUES (?,?,?)
            ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data
          `);
            for (const record of records) {
              save.run(collection, record.id, JSON.stringify(record));
            }
            db.exec("COMMIT");
            return records;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
        undefined,
        true,
      );
    },
  };
}
