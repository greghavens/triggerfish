/** Case-local immutable references from verified finding reports to saved traffic. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { locateSentinelCase } from "./cases.ts";
import { assertOperatorSourceDirectoryInfo } from "./source_snapshot_lock.ts";
import {
  type SentinelTrafficSource,
  sentinelTrafficSources,
} from "./traffic_receipts.ts";

const journalName = "sentinel-finding-traffic-links.db";
const applicationId = 0x5346544c;
const maxLinks = 4096;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const finding = /^worker-finding:[a-f0-9]{64}$/;
const recheck = /^worker-recheck:[a-f0-9]{64}$/;
const assignment = /^adaptive:[a-f0-9]{64}$/;

export type SentinelFindingTrafficAuthority =
  | { readonly kind: "assignment"; readonly taskId: string }
  | { readonly kind: "operator" };

export interface SentinelFindingTrafficLinkInput {
  readonly caseId: string;
  readonly evidenceRevision: number;
  readonly assetId: string;
  readonly findingId: string;
  readonly recheckId?: string;
  readonly reportVersion: number;
  readonly trafficId: string;
  readonly trafficSource: SentinelTrafficSource;
  readonly trafficDigest: string;
  readonly authority: SentinelFindingTrafficAuthority;
  readonly requestId: string;
}

export interface SentinelFindingTrafficLink
  extends SentinelFindingTrafficLinkInput {
  readonly id: string;
  readonly recordedAt: string;
}

export interface SentinelFindingTrafficLinkFilter {
  readonly findingId?: string;
  readonly evidenceRevision?: number;
  readonly limit?: number;
  readonly offset?: number;
}

function exactText(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 &&
    !value.includes("\0");
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalize(
  input: SentinelFindingTrafficLinkInput,
  expectedCase: string,
): SentinelFindingTrafficLinkInput {
  const {
    caseId,
    evidenceRevision,
    assetId,
    findingId,
    recheckId,
    reportVersion,
    trafficId,
    trafficSource,
    trafficDigest,
    authority,
    requestId,
  } = input;
  if (
    caseId !== expectedCase || !positive(evidenceRevision) ||
    !positive(reportVersion) || !exactText(assetId) || !exactText(trafficId) ||
    typeof findingId !== "string" || !finding.test(findingId) ||
    recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheck.test(recheckId)) ||
    !sentinelTrafficSources.includes(trafficSource) ||
    typeof trafficDigest !== "string" || !digest.test(trafficDigest) ||
    typeof requestId !== "string" || !uuid.test(requestId) ||
    !authority ||
    (authority.kind !== "operator" &&
      (authority.kind !== "assignment" ||
        typeof authority.taskId !== "string" ||
        !assignment.test(authority.taskId)))
  ) throw new Error("Invalid Sentinel finding traffic link scope");
  return {
    caseId,
    evidenceRevision,
    assetId,
    findingId,
    ...(recheckId !== undefined && { recheckId }),
    reportVersion,
    trafficId,
    trafficSource,
    trafficDigest,
    authority: authority.kind === "assignment"
      ? { kind: "assignment", taskId: authority.taskId }
      : { kind: "operator" },
    requestId: requestId.toLowerCase(),
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

function initialize(db: DatabaseSync, readOnly: boolean) {
  const validate = () => {
    const app = db.prepare("PRAGMA application_id").get()?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (app === applicationId && version === 1) return;
    if (
      readOnly || app !== 0 || version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) throw new Error("Invalid Sentinel finding traffic journal");
    db.exec(`
      CREATE TABLE traffic_links (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        finding_id TEXT NOT NULL,
        input TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX traffic_links_revision ON traffic_links(revision);
      CREATE INDEX traffic_links_finding ON traffic_links(finding_id, revision);
      PRAGMA application_id = ${applicationId};
      PRAGMA user_version = 1;`);
  };
  if (readOnly) validate();
  else transaction(db, validate);
}

function openLinks(snapshotPath: string, readOnly: boolean, now: () => number) {
  const snapshot = resolve(snapshotPath);
  const caseId = locateSentinelCase(snapshot)?.caseId;
  if (!caseId) {
    throw new Error("Sentinel traffic links require an exact case path");
  }
  const parent = dirname(snapshot);
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const path = join(parent, journalName);
  if (!readOnly) {
    try {
      Deno.openSync(path, { write: true, createNew: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) throw new Error("Sentinel traffic links require a private regular journal");
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 1500; PRAGMA trusted_schema = OFF");
    initialize(db, readOnly);
  } catch (error) {
    db.close();
    throw error;
  }

  function identifier(serialized: string) {
    return "finding-traffic-link:" +
      createHash("sha256").update(serialized).digest("hex");
  }
  type Row = NonNullable<
    ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>
  >;
  function decode(row: Row): SentinelFindingTrafficLink {
    const input = normalize(JSON.parse(String(row.input)), caseId!);
    const id = identifier(JSON.stringify(input));
    if (
      id !== row.id || input.requestId !== row.request_id ||
      input.evidenceRevision !== row.revision ||
      input.findingId !== row.finding_id ||
      typeof row.recorded_at !== "number" ||
      !Number.isSafeInteger(row.recorded_at)
    ) {
      throw new Error("Invalid Sentinel finding traffic receipt");
    }
    return {
      ...input,
      id,
      recordedAt: new Date(Number(row.recorded_at)).toISOString(),
    };
  }

  return {
    /** The caller must gate case and lease for every request, including retries. */
    record(
      raw: SentinelFindingTrafficLinkInput,
      verifyNew: (input: SentinelFindingTrafficLinkInput) => boolean,
    ): SentinelFindingTrafficLink | undefined {
      if (readOnly) {
        throw new Error("The Sentinel traffic journal is read-only");
      }
      const input = normalize(raw, caseId);
      const serialized = JSON.stringify(input);
      const id = identifier(serialized);
      return transaction(db, () => {
        const existing = db.prepare(
          "SELECT * FROM traffic_links WHERE request_id = ?",
        ).get(input.requestId);
        if (existing) return existing.id === id ? decode(existing) : undefined;
        if (verifyNew(input) !== true) return undefined;
        const count = Number(
          db.prepare(
            "SELECT COUNT(*) AS count FROM traffic_links",
          ).get()?.count,
        );
        if (count >= maxLinks) {
          throw new Error("Sentinel traffic link limit reached");
        }
        const time = now();
        if (!Number.isSafeInteger(time)) {
          throw new Error("Invalid traffic link clock");
        }
        const recordedAt = new Date(time).toISOString();
        db.prepare(`INSERT INTO traffic_links
          (id,request_id,revision,finding_id,input,recorded_at) VALUES (?,?,?,?,?,?)`)
          .run(
            id,
            input.requestId,
            input.evidenceRevision,
            input.findingId,
            serialized,
            time,
          );
        return { ...input, id, recordedAt };
      });
    },
    list(filter: SentinelFindingTrafficLinkFilter = {}) {
      const { findingId, evidenceRevision, limit = 20, offset = 0 } = filter;
      if (
        findingId !== undefined &&
          (typeof findingId !== "string" || !finding.test(findingId)) ||
        evidenceRevision !== undefined && !positive(evidenceRevision) ||
        !positive(limit) || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0
      ) throw new Error("Invalid Sentinel finding traffic link filter");
      return db.prepare(`SELECT * FROM traffic_links
        WHERE (? IS NULL OR finding_id = ?) AND (? IS NULL OR revision = ?)
        ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(
        findingId ?? null,
        findingId ?? null,
        evidenceRevision ?? null,
        evidenceRevision ?? null,
        limit,
        offset,
      ).map(decode);
    },
    exportRevision(
      evidenceRevision: number,
    ): readonly SentinelFindingTrafficLink[] {
      const rows = db.prepare(`SELECT * FROM traffic_links
        WHERE revision = ? ORDER BY rowid DESC LIMIT ?`).all(
        evidenceRevision,
        maxLinks + 1,
      );
      if (rows.length > maxLinks) {
        throw new Error("Invalid Sentinel traffic link journal size");
      }
      return rows.map(decode);
    },
    close() {
      db.close();
    },
  };
}

/** Open the writable journal for an authenticated broker operating in the case lock. */
export function openSentinelFindingTrafficLinks(
  snapshotPath: string,
  now = Date.now,
) {
  return openLinks(snapshotPath, false, now);
}

/** Read a case's retained links without creating an empty journal. */
export function listSentinelFindingTrafficLinks(
  snapshotPath: string,
  filter?: SentinelFindingTrafficLinkFilter,
) {
  return readFindingTrafficLinks(snapshotPath, (links) => links.list(filter));
}

/** Export the complete retained receipt set for an exact evidence revision. */
export function exportSentinelFindingTrafficLinks(
  snapshotPath: string,
  evidenceRevision: number,
) {
  if (!positive(evidenceRevision)) {
    throw new Error("Invalid Sentinel traffic link evidence revision");
  }
  return readFindingTrafficLinks(
    snapshotPath,
    (links) => links.exportRevision(evidenceRevision),
  );
}

function readFindingTrafficLinks(
  snapshotPath: string,
  read: (
    links: ReturnType<typeof openLinks>,
  ) => readonly SentinelFindingTrafficLink[],
): readonly SentinelFindingTrafficLink[] {
  let links;
  try {
    links = openLinks(snapshotPath, true, Date.now);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  try {
    return read(links);
  } finally {
    links.close();
  }
}
