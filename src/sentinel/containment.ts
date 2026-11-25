/// <reference path="../core/sqlite_types.d.ts" />

/** Persistent exact-host quarantine decisions and their audit history. */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "@std/path";
import { isIP } from "node:net";

export interface SentinelBlock {
  readonly target: string;
  readonly reason: string;
  readonly blockedAt: string;
  readonly expiresAt: string;
}

export type SentinelContainmentDecision =
  | { readonly target: string; readonly decision: "allow" }
  | {
    readonly target: string;
    readonly decision: "deny";
    readonly block: SentinelBlock;
  };

interface AuditEvent {
  readonly action: "block" | "release";
  readonly target: string;
  readonly reason: string;
  readonly at: string;
  readonly expiresAt: string | null;
}

const APPLICATION_ID = 0x534e544c;
const VERSION = 1;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const SELECT_ACTIVE =
  "SELECT target, reason, blockedAt, expiresAt FROM active_blocks WHERE expiresAt > ?";
const SELECT_TARGET = SELECT_ACTIVE + " AND target = ?";
const LATEST_BLOCK_REVISION = `SELECT CAST(rowid AS TEXT)
  FROM containment_audit
  WHERE action = 'block' AND target = active_blocks.target
  ORDER BY rowid DESC LIMIT 1`;

function mappedIpv4(ip: string): string | undefined {
  const match = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(ip);
  if (!match) return undefined;
  const upper = Number.parseInt(match[1], 16);
  const lower = Number.parseInt(match[2], 16);
  return [upper >> 8, upper & 255, lower >> 8, lower & 255].join(".");
}

/** Share exact-host canonicalization between management and enforcement. */
export function normalizeSentinelContainmentTarget(input: string): string {
  const host = input.trim().toLowerCase();
  const address = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (isIP(host) === 4) return host;
  if (isIP(address) === 6 && !address.includes("%")) {
    const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    return mappedIpv4(canonical) ?? canonical;
  }

  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    name.length > 253 || !name.split(".").every((part) => dnsLabel.test(part))
  ) {
    throw new Error("Containment requires an exact IP address or DNS hostname");
  }

  // A numeric or abbreviated IPv4 spelling must never become a DNS rule.
  let urlHostname: string;
  try {
    urlHostname = new URL(`https://${name}/`).hostname;
  } catch {
    throw new Error("Containment requires an exact IP address or DNS hostname");
  }
  if (urlHostname !== name || isIP(name) === 4) {
    throw new Error("Use canonical dotted-decimal IPv4 addresses");
  }
  return name;
}

function validateReason(reason: string): string {
  const value = reason.trim();
  if (value.length === 0 || value.length > 512) {
    throw new Error("Containment reason must contain 1–512 characters");
  }
  return value;
}

function assertPrivateFile(path: string): void {
  const info = Deno.lstatSync(path);
  if (!info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1) {
    throw new Error("Containment database must be a regular private file");
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      "Containment database must be accessible only to its owner",
    );
  }
}

function ensurePrivateFile(path: string): void {
  try {
    Deno.openSync(path, { write: true, createNew: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  assertPrivateFile(path);
}

function databaseVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version);
}

function databaseApplicationId(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA application_id").get()?.application_id);
}

function assertSchema(db: DatabaseSync): void {
  if (
    databaseApplicationId(db) !== APPLICATION_ID ||
    databaseVersion(db) !== VERSION
  ) {
    throw new Error("Invalid Sentinel containment database or version");
  }
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

function initializeSchema(db: DatabaseSync): void {
  transaction(db, () => {
    if (databaseApplicationId(db) !== 0 || databaseVersion(db) !== 0) {
      assertSchema(db);
      return;
    }
    if (db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get()) {
      throw new Error(
        "Containment database path belongs to another application",
      );
    }
    db.exec(`
      CREATE TABLE active_blocks (
        target TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        blockedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
      );
      CREATE TABLE containment_audit (
        action TEXT NOT NULL CHECK (action IN ('block', 'release')),
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        at TEXT NOT NULL,
        expiresAt TEXT
      );
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${VERSION};
    `);
  });
}

function getDecision(
  db: DatabaseSync,
  target: string,
  now: number,
): SentinelContainmentDecision {
  const block = db.prepare(SELECT_TARGET).get(
    new Date(now).toISOString(),
    target,
  ) as unknown as SentinelBlock | undefined;
  return block
    ? { target, decision: "deny", block: { ...block } }
    : { target, decision: "allow" };
}

/** Evaluate a policy from its existing file without modifying it. */
export function checkSentinelContainment(
  path: string,
  target: string,
  now = Date.now(),
): SentinelContainmentDecision {
  const resolved = resolve(path);
  const normalized = normalizeSentinelContainmentTarget(target);
  assertPrivateFile(resolved);
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 250");
    assertSchema(db);
    return getDecision(db, normalized, now);
  } finally {
    db.close();
  }
}

/** Read current quarantines and recent changes without creating the policy. */
export function readSentinelContainmentOverview(
  path: string,
  now = Date.now(),
) {
  const resolved = resolve(path);
  assertPrivateFile(resolved);
  const db = new DatabaseSync(resolved, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 250");
    assertSchema(db);
    db.exec("BEGIN");
    const time = new Date(now).toISOString();
    return {
      total: Number(
        db.prepare(
          "SELECT COUNT(*) AS count FROM active_blocks WHERE expiresAt > ?",
        ).get(time)?.count,
      ),
      active: db.prepare(
        `SELECT target, reason, blockedAt, expiresAt,
          (${LATEST_BLOCK_REVISION}) AS revision
          FROM active_blocks WHERE expiresAt > ? ORDER BY target LIMIT 100`,
      ).all(time) as unknown as (SentinelBlock & { revision: string | null })[],
      audit: db.prepare(
        "SELECT action, target, reason, at, expiresAt FROM containment_audit ORDER BY rowid DESC LIMIT 100",
      ).all() as unknown as AuditEvent[],
    };
  } finally {
    db.close();
  }
}

/** Open or initialize the policy in an operator-controlled directory. */
export function openSentinelContainment(
  path: string,
  now = Date.now,
  initialize = true,
) {
  const resolved = resolve(path);
  if (initialize) ensurePrivateFile(resolved);
  else assertPrivateFile(resolved);
  const db = new DatabaseSync(resolved);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (initialize) initializeSchema(db);
    else assertSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    block(
      request: { target: string; reason: string; ttlSeconds: number },
    ): SentinelBlock {
      const target = normalizeSentinelContainmentTarget(request.target);
      const reason = validateReason(request.reason);
      const ttl = request.ttlSeconds;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
        throw new Error(
          `Containment duration must be 1–${MAX_TTL_SECONDS} seconds`,
        );
      }
      return transaction(db, () => {
        const time = now();
        const blockedAt = new Date(time).toISOString();
        const expiresAt = new Date(time + ttl * 1000).toISOString();
        db.prepare(
          `INSERT INTO active_blocks (target, reason, blockedAt, expiresAt)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(target) DO UPDATE SET
            reason = excluded.reason, blockedAt = excluded.blockedAt,
            expiresAt = excluded.expiresAt`,
        ).run(
          target,
          reason,
          blockedAt,
          expiresAt,
        );
        db.prepare(
          "INSERT INTO containment_audit VALUES ('block', ?, ?, ?, ?)",
        ).run(
          target,
          reason,
          blockedAt,
          expiresAt,
        );
        return { target, reason, blockedAt, expiresAt };
      });
    },

    release(
      request: { target: string; reason: string; expectedRevision?: string },
    ) {
      const target = normalizeSentinelContainmentTarget(request.target);
      const reason = validateReason(request.reason);
      return transaction(db, () => {
        const released = db.prepare(
          `DELETE FROM active_blocks WHERE target = ?
            AND (? IS NULL OR (${LATEST_BLOCK_REVISION}) = ?)`,
        )
          .run(
            target,
            request.expectedRevision ?? null,
            request.expectedRevision ?? null,
          )
          .changes > 0;
        if (released) {
          db.prepare(
            "INSERT INTO containment_audit VALUES ('release', ?, ?, ?, NULL)",
          ).run(
            target,
            reason,
            new Date(now()).toISOString(),
          );
        }
        return { target, released };
      });
    },

    check(input: string): SentinelContainmentDecision {
      return getDecision(db, normalizeSentinelContainmentTarget(input), now());
    },

    list(): SentinelBlock[] {
      return db.prepare(SELECT_ACTIVE + " ORDER BY target").all(
        new Date(now()).toISOString(),
      ).map((row) => ({ ...row }) as unknown as SentinelBlock);
    },

    audit(limit = 100): AuditEvent[] {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        throw new Error("Containment audit limit must be 1–10000");
      }
      return db.prepare(
        "SELECT action, target, reason, at, expiresAt FROM containment_audit ORDER BY rowid DESC LIMIT ?",
      ).all(limit).map((row) => ({ ...row }) as unknown as AuditEvent);
    },

    close(): void {
      db.close();
    },
  };
}
