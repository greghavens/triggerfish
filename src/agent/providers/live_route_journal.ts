/** Durable reviewed overrides of the operator's approved route file. */
/// <reference path="../../core/sqlite_types.d.ts" />
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { SelectedModelProfile } from "../../core/model_profile_selection.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";

export interface LiveRouteEdit {
  readonly classification: ClassificationLevel;
  readonly requestId: string;
  readonly version: number;
  readonly override: SelectedModelProfile | null;
  readonly effective: SelectedModelProfile;
  readonly previous: SelectedModelProfile;
}

export function openLiveRouteJournal(baseDir: string, write = false) {
  const parent = join(baseDir, "data");
  const dir = Deno.lstatSync(parent);
  if (
    !dir.isDirectory || dir.isSymlink || (dir.mode !== null && dir.mode & 0o022)
  ) {
    throw new Error("Invalid live route directory");
  }
  const path = join(parent, "model-route-edits.db");
  try {
    const stat = Deno.lstatSync(path);
    if (
      !stat.isFile || stat.isSymlink || (stat.nlink ?? 1) !== 1 ||
      (stat.mode !== null && stat.mode & 0o022)
    ) {
      throw new Error("Invalid live route journal");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (!write) return;
    try {
      Deno.openSync(path, { write: true, createNew: true, mode: 0o600 })
        .close();
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
      return openLiveRouteJournal(baseDir, write);
    }
  }
  const db = new DatabaseSync(path, { readOnly: !write });
  if (write) {
    db.exec(`CREATE TABLE IF NOT EXISTS route_edits (
      classification TEXT NOT NULL,
      version INTEGER NOT NULL,
      requestId TEXT NOT NULL UNIQUE,
      receipt TEXT NOT NULL,
      PRIMARY KEY(classification, version)
    ) STRICT`);
  }
  return db;
}

export function readLiveRouteEdits(
  baseDir: string,
): Map<ClassificationLevel, LiveRouteEdit> {
  const result = new Map<ClassificationLevel, LiveRouteEdit>();
  const db = openLiveRouteJournal(baseDir);
  try {
    if (
      !db?.prepare(
        "SELECT 1 FROM sqlite_schema WHERE name = 'route_edits' AND type = 'table'",
      ).get()
    ) return result;
    for (
      const row of db.prepare(`SELECT receipt FROM route_edits AS entry
      WHERE version = (SELECT max(version) FROM route_edits WHERE classification = entry.classification)`)
        .all()
    ) {
      const edit = JSON.parse(String(row.receipt)) as LiveRouteEdit;
      result.set(edit.classification, edit);
    }
    return result;
  } finally {
    db?.close();
  }
}
