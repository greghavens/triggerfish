/** Durable owner approval receipts for workspace-authored skill drafts. */

/// <reference path="../../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";

const APPLICATION_ID = 0x534b4150;
const VERSION = 2;
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

const CREATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS creations (
    workspace TEXT NOT NULL,
    skillName TEXT NOT NULL,
    proposalDigest TEXT NOT NULL,
    draftDigest TEXT NOT NULL,
    receiptId TEXT NOT NULL,
    ownerSessionId TEXT NOT NULL,
    stagedAt TEXT NOT NULL,
    PRIMARY KEY (workspace, skillName)
  ) STRICT
`;

export interface SkillCreationReceipt {
  readonly skillName: string;
  readonly proposalDigest: string;
  readonly draftDigest: string;
  readonly receiptId: string;
  readonly ownerSessionId: string;
  readonly stagedAt: string;
}

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
  creation(
    workspace: string,
    skillName: string,
  ): SkillCreationReceipt | undefined;
  reserveCreation(
    workspace: string,
    skillName: string,
    proposalDigest: string,
    draftDigest: string,
    ownerSessionId: string,
  ): SkillCreationReceipt | undefined;
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
    if (application_id === APPLICATION_ID && user_version === 1) {
      if (!readOnly) {
        db.exec(`BEGIN IMMEDIATE;
        ${CREATIONS_SCHEMA};
        PRAGMA user_version = ${VERSION};
        COMMIT;`);
      }
      return db;
    }
    if (
      readOnly || application_id !== 0 || user_version !== 0 ||
      db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
    ) throw new Error("Invalid skill approval registry.");
    db.exec(`BEGIN IMMEDIATE;
      ${SCHEMA};
      ${CREATIONS_SCHEMA};
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

function openWritableRegistry(path: string): DatabaseSync {
  if (!hasRegistry(path)) {
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists) || !hasRegistry(path)) {
        throw error;
      }
    }
  }
  return openRegistry(path, false);
}

function readCreation(
  db: DatabaseSync,
  workspace: string,
  skillName: string,
): SkillCreationReceipt | undefined {
  if (db.prepare("PRAGMA user_version").get()?.user_version !== VERSION) return;
  const row = db.prepare(`SELECT * FROM creations
    WHERE workspace = ? AND skillName = ?`).get(workspace, skillName);
  if (!row) return;
  return {
    skillName: String(row.skillName),
    proposalDigest: String(row.proposalDigest),
    draftDigest: String(row.draftDigest),
    receiptId: String(row.receiptId),
    ownerSessionId: String(row.ownerSessionId),
    stagedAt: String(row.stagedAt),
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
        if (db.prepare("PRAGMA user_version").get()?.user_version === VERSION) {
          for (
            const row of db.prepare(
              "SELECT skillName FROM creations WHERE workspace = ?",
            ).all(workspace)
          ) {
            out.set(String(row.skillName), new Map());
          }
        }
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
      const db = openWritableRegistry(path);
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
    creation(workspace, skillName) {
      if (!hasRegistry(path)) return undefined;
      const db = openRegistry(path, true);
      try {
        return readCreation(db, workspace, skillName);
      } finally {
        db.close();
      }
    },
    reserveCreation(
      workspace,
      skillName,
      proposalDigest,
      draftDigest,
      ownerSessionId,
    ) {
      const db = openWritableRegistry(path);
      try {
        db.prepare(`INSERT INTO creations VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace, skillName) DO NOTHING`).run(
          workspace,
          skillName,
          proposalDigest,
          draftDigest,
          crypto.randomUUID(),
          ownerSessionId,
          new Date().toISOString(),
        );
        const receipt = readCreation(db, workspace, skillName);
        return receipt?.proposalDigest === proposalDigest &&
            receipt.draftDigest === draftDigest
          ? receipt
          : undefined;
      } finally {
        db.close();
      }
    },
  };
}
