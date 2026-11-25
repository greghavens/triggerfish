/** Durable owner approval receipts for workspace-authored skill drafts. */

/// <reference path="../../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";

const APPLICATION_ID = 0x534b4150;
const VERSION = 1;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS approvals (
    workspace TEXT NOT NULL,
    skillName TEXT NOT NULL,
    digest TEXT NOT NULL,
    receiptId TEXT NOT NULL,
    ownerSessionId TEXT NOT NULL,
    approvedAt TEXT NOT NULL,
    PRIMARY KEY (workspace, skillName, digest)
  ) STRICT
`;

export interface SkillDraftReceipt {
  readonly skillName: string;
  readonly digest: string;
  readonly receiptId: string;
  readonly ownerSessionId: string;
  readonly approvedAt: string;
}

export interface SkillDraftApprovals {
  list(workspace: string): ReadonlyMap<
    string,
    ReadonlyMap<string, SkillDraftReceipt>
  >;
  record(
    workspace: string,
    skillName: string,
    digest: string,
    ownerSessionId: string,
  ): SkillDraftReceipt;
}

function hasRegistry(path: string): boolean {
  try {
    if (!Deno.lstatSync(path).isFile) {
      throw new Error("Invalid skill approval file.");
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function openRegistry(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF");
    const { application_id } = db.prepare("PRAGMA application_id").get()!;
    const { user_version } = db.prepare("PRAGMA user_version").get()!;
    if (application_id === APPLICATION_ID && user_version === VERSION) {
      return db;
    }
    if (
      readOnly || application_id !== 0 || user_version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) throw new Error("Invalid skill approval registry.");
    db.exec(`BEGIN IMMEDIATE;
      ${SCHEMA};
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${VERSION};
      COMMIT;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function receiptFromRow(
  { skillName, digest, receiptId, ownerSessionId, approvedAt }: Record<
    string,
    unknown
  >,
): SkillDraftReceipt {
  return {
    skillName: String(skillName),
    digest: String(digest),
    receiptId: String(receiptId),
    ownerSessionId: String(ownerSessionId),
    approvedAt: String(approvedAt),
  };
}

/** The registry path is configured outside the editable skills directory. */
export function createSkillDraftApprovals(path: string): SkillDraftApprovals {
  return {
    list(workspace) {
      const out = new Map<string, Map<string, SkillDraftReceipt>>();
      if (!hasRegistry(path)) return out;
      const db = openRegistry(path, true);
      try {
        for (
          const row of db.prepare(
            "SELECT * FROM approvals WHERE workspace = ?",
          ).all(workspace)
        ) {
          const receipt = receiptFromRow(row);
          const versions = out.get(receipt.skillName) ?? new Map();
          versions.set(receipt.digest, receipt);
          out.set(receipt.skillName, versions);
        }
        return out;
      } finally {
        db.close();
      }
    },
    record(workspace, skillName, digest, ownerSessionId) {
      if (!hasRegistry(path)) {
        try {
          Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
            .close();
        } catch (error) {
          if (
            !(error instanceof Deno.errors.AlreadyExists) || !hasRegistry(path)
          ) throw error;
        }
      }
      const db = openRegistry(path, false);
      try {
        db.prepare(`INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace, skillName, digest) DO NOTHING`).run(
          workspace,
          skillName,
          digest,
          crypto.randomUUID(),
          ownerSessionId,
          new Date().toISOString(),
        );
        return receiptFromRow(
          db.prepare(`SELECT * FROM approvals
          WHERE workspace = ? AND skillName = ? AND digest = ?`).get(
            workspace,
            skillName,
            digest,
          )!,
        );
      } finally {
        db.close();
      }
    },
  };
}
