/** Durable owner approval receipts for workspace-authored skill drafts. */

/// <reference path="../../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";

const APPLICATION_ID = 0x534b4150;
const VERSION = 3;
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

const WITHDRAWALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS withdrawals (
    workspace TEXT NOT NULL,
    skillName TEXT NOT NULL,
    digest TEXT NOT NULL,
    receiptId TEXT NOT NULL,
    ownerSessionId TEXT NOT NULL,
    withdrawnAt TEXT NOT NULL,
    PRIMARY KEY (workspace, skillName, digest)
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

export interface SkillWithdrawalReceipt {
  readonly skillName: string;
  readonly digest: string;
  readonly approvalReceiptId: string;
  readonly receiptId: string;
  readonly ownerSessionId: string;
  readonly withdrawnAt: string;
}

export interface SkillDraftReceipt {
  readonly skillName: string;
  readonly digest: string;
  readonly receiptId: string;
  readonly ownerSessionId: string;
  readonly approvedAt: string;
  readonly withdrawal?: SkillWithdrawalReceipt;
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
  withdraw(
    workspace: string,
    skillName: string,
    digest: string,
    approvalReceiptId: string,
    ownerSessionId: string,
  ): SkillWithdrawalReceipt | undefined;
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
    if (
      application_id === APPLICATION_ID &&
      (user_version === 1 || user_version === 2)
    ) {
      if (!readOnly) {
        db.exec(`BEGIN IMMEDIATE;
        ${CREATIONS_SCHEMA};
        ${WITHDRAWALS_SCHEMA};
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
      ${WITHDRAWALS_SCHEMA};
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
  row: Record<string, unknown>,
): SkillDraftReceipt {
  const { skillName, digest, receiptId, ownerSessionId, approvedAt } = row;
  return {
    skillName: String(skillName),
    digest: String(digest),
    receiptId: String(receiptId),
    ownerSessionId: String(ownerSessionId),
    approvedAt: String(approvedAt),
    ...(typeof row.withdrawalId === "string" && {
      withdrawal: {
        skillName: String(skillName),
        digest: String(digest),
        approvalReceiptId: String(receiptId),
        receiptId: row.withdrawalId,
        ownerSessionId: String(row.withdrawingOwner),
        withdrawnAt: String(row.withdrawnAt),
      },
    }),
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

function approvalRows(db: DatabaseSync, where: string) {
  if (db.prepare("PRAGMA user_version").get()?.user_version === VERSION) {
    return db.prepare(`
      SELECT approvals.*, withdrawals.receiptId AS withdrawalId,
        withdrawals.ownerSessionId AS withdrawingOwner, withdrawals.withdrawnAt
      FROM approvals LEFT JOIN withdrawals USING (workspace, skillName, digest)
      WHERE ${where}
    `);
  }
  return db.prepare(`SELECT * FROM approvals WHERE ${where}`);
}

const exactApproval = "workspace = ? AND skillName = ? AND digest = ?";

function readCreation(
  db: DatabaseSync,
  workspace: string,
  skillName: string,
): SkillCreationReceipt | undefined {
  if (Number(db.prepare("PRAGMA user_version").get()?.user_version) < 2) return;
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
        if (
          Number(db.prepare("PRAGMA user_version").get()?.user_version) >= 2
        ) {
          for (
            const row of db.prepare(
              "SELECT skillName FROM creations WHERE workspace = ?",
            ).all(workspace)
          ) {
            out.set(String(row.skillName), new Map());
          }
        }
        for (
          const row of approvalRows(db, "workspace = ?").all(workspace)
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
          approvalRows(db, exactApproval).get(workspace, skillName, digest)!,
        );
      } finally {
        db.close();
      }
    },
    withdraw(workspace, skillName, digest, approvalReceiptId, ownerSessionId) {
      if (!hasRegistry(path)) return;
      const db = openWritableRegistry(path);
      try {
        db.prepare(`
          INSERT INTO withdrawals
          SELECT workspace, skillName, digest, ?, ?, ?
          FROM approvals WHERE ${exactApproval} AND receiptId = ?
          ON CONFLICT(workspace, skillName, digest) DO NOTHING
        `).run(
          crypto.randomUUID(),
          ownerSessionId,
          new Date().toISOString(),
          workspace,
          skillName,
          digest,
          approvalReceiptId,
        );
        const row = approvalRows(db, exactApproval).get(
          workspace,
          skillName,
          digest,
        );
        if (row?.receiptId === approvalReceiptId) {
          return receiptFromRow(row).withdrawal;
        }
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
