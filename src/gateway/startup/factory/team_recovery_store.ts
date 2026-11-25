/** Private admission and execution-context records for authorized team recovery. */
/// <reference path="../../../core/sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { TeamId } from "../../../agent/team/types.ts";

export interface TeamRecoveryMember {
  readonly teamId: TeamId;
  readonly creatorSessionId: SessionId;
  readonly sessionId: SessionId;
  readonly channelId: string;
  readonly workspaceId: string;
  readonly role: string;
  readonly model: string;
  readonly ceiling: ClassificationLevel;
  readonly rosterDigest: string;
  readonly profileBinding: string;
}

export interface TeamRecoveryAdmission {
  readonly id: string;
  readonly teamId: TeamId;
  readonly senderSessionId: SessionId;
  readonly recipientSessionId: SessionId;
  readonly requestDigest: string;
  readonly memberContextDigest: string;
  readonly senderTaint: ClassificationLevel;
  readonly memberTaint: ClassificationLevel;
  readonly ownerTargetClassification: ClassificationLevel;
  readonly targetClassification: ClassificationLevel;
}

function privateDatabase(path: string): DatabaseSync {
  path = resolve(path);
  const parent = dirname(path);
  Deno.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = Deno.lstatSync(parent);
  if (
    !directory.isDirectory || directory.isSymlink ||
    (directory.mode !== null && (directory.mode & 0o022) !== 0)
  ) {
    throw new Error("Team recovery requires a private directory");
  }
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Team recovery requires a private regular file");
  }
  return new DatabaseSync(path);
}

export function withTeamRecoveryStore<T>(
  path: string,
  action: (store: {
    member(id: SessionId): TeamRecoveryMember | undefined;
    registerMember(context: TeamRecoveryMember): boolean;
    admit(candidate: TeamRecoveryAdmission): boolean;
  }) => T,
): T {
  const db = privateDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const application = db.prepare("PRAGMA application_id").get()
        ?.application_id;
      if (
        version === 0 && application === 0 &&
        !db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        db.exec(`
          CREATE TABLE team_recovery_members (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE team_recovery_deliveries (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA application_id = 1414677315;
          PRAGMA user_version = 1;
        `);
      } else if (version !== 1 || application !== 1414677315) {
        throw new Error("Invalid team recovery database");
      }
      const exactInsert = (
        table: "team_recovery_members" | "team_recovery_deliveries",
        id: string,
        value: unknown,
      ) => {
        const encoded = JSON.stringify(value);
        if (new TextEncoder().encode(encoded).length > 4096) return false;
        db.prepare(`INSERT OR IGNORE INTO ${table} VALUES (?, ?)`).run(
          id,
          encoded,
        );
        return db.prepare(`SELECT value FROM ${table} WHERE id = ?`).get(id)
          ?.value === encoded;
      };
      const result = action({
        member(id) {
          const row = db.prepare(
            "SELECT value FROM team_recovery_members WHERE id = ?",
          ).get(id);
          return typeof row?.value === "string"
            ? JSON.parse(row.value) as TeamRecoveryMember
            : undefined;
        },
        registerMember: (context) =>
          exactInsert("team_recovery_members", context.sessionId, context),
        admit: (candidate) =>
          exactInsert("team_recovery_deliveries", candidate.id, candidate),
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
