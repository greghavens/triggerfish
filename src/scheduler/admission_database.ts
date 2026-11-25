/** Open scheduler admission files only from an operator-controlled directory. */
/// <reference path="../core/sqlite_types.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "@std/path";

export function schedulerAdmissionDatabase(path: string) {
  const absolute = resolve(path);
  return function withDatabase<T>(action: (db: DatabaseSync) => T): T {
    const parent = Deno.lstatSync(dirname(absolute));
    if (
      !parent.isDirectory || parent.isSymlink ||
      (parent.mode !== null && (parent.mode & 0o022) !== 0)
    ) throw new Error("Invalid scheduler admission directory.");
    try {
      Deno.openSync(absolute, { write: true, createNew: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const stat = Deno.lstatSync(absolute);
    if (
      !stat.isFile || stat.isSymlink || (stat.nlink ?? 1) !== 1 ||
      (stat.mode !== null && (stat.mode & 0o077) !== 0)
    ) throw new Error("Invalid scheduler admission file.");
    const db = new DatabaseSync(absolute);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      return action(db);
    } finally {
      db.close();
    }
  };
}
