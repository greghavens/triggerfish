/** Review and persist the configured named-assessment admission limit. */
/// <reference path="../core/sqlite_types.d.ts" />
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { MAX_SENTINEL_ASSESSMENT_CONCURRENCY } from "../core/config_types.ts";
import {
  assertOperatorSourceDirectoryInfo,
  assertOperatorSourceSnapshotInfo,
} from "../sentinel/source_snapshot_lock.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function validSentinelAdmissionLimit(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) &&
    input >= 1 && input <= MAX_SENTINEL_ASSESSMENT_CONCURRENCY;
}

function openSettings(baseDir: string, write = false) {
  const directory = join(baseDir, "data");
  const path = join(directory, "sentinel-admission.db");
  try {
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
    assertOperatorSourceSnapshotInfo(Deno.lstatSync(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (!write) return;
    Deno.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
      assertOperatorSourceSnapshotInfo(Deno.lstatSync(path));
    }
  }
  const db = new DatabaseSync(path, { readOnly: !write });
  if (write) {
    db.exec(`CREATE TABLE IF NOT EXISTS admission_edits (
      version INTEGER PRIMARY KEY,
      requestId TEXT NOT NULL UNIQUE,
      previous INTEGER,
      override INTEGER,
      approvedAt TEXT NOT NULL
    ) STRICT`);
  }
  return db;
}

interface AdmissionEdit {
  readonly version: number;
  readonly requestId: string;
  readonly previous: number | null;
  readonly override: number | null;
  readonly approvedAt: string;
}

function latestEdit(db: DatabaseSync): AdmissionEdit | undefined {
  return db.prepare(
    "SELECT * FROM admission_edits ORDER BY version DESC LIMIT 1",
  )
    .get() as AdmissionEdit | undefined;
}

export function readSentinelAdmissionSettings(
  baseDir: string,
  configuredLimit: number,
) {
  const db = openSettings(baseDir);
  try {
    const last = db?.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'admission_edits'",
      ).get()
      ? latestEdit(db!)
      : undefined;
    const override = last?.override ?? null;
    if (override !== null && !validSentinelAdmissionLimit(override)) {
      throw new Error("Invalid saved Sentinel admission limit");
    }
    return {
      configuredLimit,
      override,
      effectiveLimit: override ?? configuredLimit,
      version: last?.version ?? 0,
      ...(last && { lastEdit: last }),
    };
  } finally {
    db?.close();
  }
}

export function replaceSentinelAdmissionLimit(
  baseDir: string,
  input: {
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly override: number | null;
  },
) {
  const { requestId, expectedVersion, override } = input;
  if (
    !uuid.test(requestId) || !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    (override !== null && !validSentinelAdmissionLimit(override))
  ) return;
  const db = openSettings(baseDir, true)!;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = db.prepare(
        "SELECT * FROM admission_edits WHERE requestId = ?",
      )
        .get(requestId) as AdmissionEdit | undefined;
      if (duplicate) {
        db.exec("COMMIT");
        return duplicate.version === expectedVersion + 1 &&
            duplicate.override === override
          ? duplicate
          : undefined;
      }
      const last = latestEdit(db);
      const version = last?.version ?? 0;
      const previous = last?.override ?? null;
      if (
        version !== expectedVersion || version >= Number.MAX_SAFE_INTEGER ||
        previous === override
      ) {
        db.exec("ROLLBACK");
        return;
      }
      const approvedAt = new Date().toISOString();
      db.prepare("INSERT INTO admission_edits VALUES (?, ?, ?, ?, ?)")
        .run(version + 1, requestId, previous, override, approvedAt);
      db.exec("COMMIT");
      return {
        version: version + 1,
        requestId,
        previous,
        override,
        approvedAt,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
