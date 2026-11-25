/** Durable metadata-only approvals for one trusted tool dispatch. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type McpLifecycleReview,
  parseMcpLifecycleReview,
} from "./mcp_lifecycle_intent.ts";
import {
  type ChatGoalApprovalReview,
  parseChatGoalApprovalReview,
} from "./chat_goal_intent.ts";

export type ApprovalInboxStatus =
  | "pending"
  | "approved"
  | "denied"
  | "claimed"
  | "completed"
  | "stale";
export type ApprovalInboxDecision = "approved" | "denied";
export type ApprovalInboxDispatchOutcome = "returned" | "blocked" | "failed";

export interface ApprovalInboxRequest {
  readonly id: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly assignmentId?: string;
  readonly tool: string;
  readonly mcpLifecycle?: McpLifecycleReview;
  readonly chatGoal?: ChatGoalApprovalReview;
  /** Trusted context fingerprint. Never projected from the journal. */
  readonly binding: string;
  readonly expiresAt: number;
}

export interface ApprovalInboxRecord {
  readonly id: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly assignmentId?: string;
  readonly tool: string;
  readonly description: string;
  readonly mcpLifecycle?: McpLifecycleReview;
  readonly chatGoal?: ChatGoalApprovalReview;
  readonly status: ApprovalInboxStatus;
  readonly decision?: ApprovalInboxDecision;
  readonly dispatchOutcome?: ApprovalInboxDispatchOutcome;
  readonly handlerReturnedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}

const applicationId = 0x4150494e;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const tokenPattern = /^[a-f0-9]{64}$/;
const toolPattern = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,127}$/;
const referencePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,255}$/;
type Row = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function exactReference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}

function requestId(value: unknown): string | undefined {
  return typeof value === "string" && idPattern.test(value)
    ? value.toLowerCase()
    : undefined;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openPrivateDatabase(path: string) {
  const dbPath = resolve(path);
  const directory = dirname(dbPath);
  Deno.mkdirSync(directory, { mode: 0o700, recursive: true });
  const dir = Deno.lstatSync(directory);
  if (!dir.isDirectory || dir.isSymlink || ((dir.mode ?? 0) & 0o022) !== 0) {
    throw new Error(
      "Approval inbox requires an operator-controlled directory.",
    );
  }
  try {
    Deno.openSync(dbPath, { createNew: true, mode: 0o600, write: true })
      .close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(dbPath);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error("Approval inbox requires a private regular database.");
  }
  return new DatabaseSync(dbPath);
}

function projectChatGoalReview(
  value: unknown,
): ChatGoalApprovalReview | undefined {
  if (typeof value !== "string") return;
  try {
    return parseChatGoalApprovalReview(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function project(row: Row | undefined): ApprovalInboxRecord | undefined {
  if (!row) return undefined;
  const tool = String(row.tool);
  const review = tool === "mcp_manage"
    ? parseMcpLifecycleReview(row.mcpLifecycleAction, row.mcpConnectorId)
    : undefined;
  const chatGoal = tool === "goal_report"
    ? projectChatGoalReview(row.chatGoal)
    : undefined;
  return {
    id: String(row.id),
    scope: String(row.scope),
    sessionId: String(row.sessionId),
    ...(typeof row.runId === "string" && { runId: row.runId }),
    ...(typeof row.assignmentId === "string" &&
      { assignmentId: row.assignmentId }),
    tool,
    description: chatGoal
      ? `Approve the owner goal ${chatGoal.action} request '${chatGoal.requestId}' (${chatGoal.criterionCount} criteria).`
      : review?.action === "add"
      ? `Approve staging the operator proposal for MCP connector '${review.connectorId}' as disabled.`
      : review?.action === "replace"
      ? "Approve replacing configured MCP connector '" + review.connectorId +
        "' with the disabled operator proposal."
      : review
      ? `Approve ${review.action} for configured MCP connector '${review.connectorId}'.`
      : `Approval required for tool ${tool}.`,
    ...(review && { mcpLifecycle: review }),
    ...(chatGoal && { chatGoal }),
    status: row.status as ApprovalInboxStatus,
    ...((row.decision === "approved" || row.decision === "denied") && {
      decision: row.decision,
    }),
    ...((row.dispatchOutcome === "returned" ||
      row.dispatchOutcome === "blocked" ||
      row.dispatchOutcome === "failed") && {
      dispatchOutcome: row.dispatchOutcome,
    }),
    ...(typeof row.handlerReturnedAt === "number" && {
      handlerReturnedAt: row.handlerReturnedAt,
    }),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    expiresAt: Number(row.expiresAt),
  };
}

/** Open a journal scoped by trusted broker identity. Calls accept no raw arguments. */
export function openApprovalInbox(path: string, now = Date.now) {
  const db = openPrivateDatabase(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF");
    transaction(db, () => {
      const id = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (id === applicationId && version === 5) return;
      if (id === applicationId && version === 4) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          PRAGMA user_version = 5;
        `);
        return;
      }
      if (id === applicationId && version === 3) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN mcpLifecycleAction TEXT;
          ALTER TABLE approval_requests ADD COLUMN mcpConnectorId TEXT;
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          PRAGMA user_version = 5;
        `);
        return;
      }
      if (id === applicationId && version === 2) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN handlerReturnedAt INTEGER;
          ALTER TABLE approval_requests ADD COLUMN mcpLifecycleAction TEXT;
          ALTER TABLE approval_requests ADD COLUMN mcpConnectorId TEXT;
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          PRAGMA user_version = 5;
        `);
        return;
      }
      if (id === applicationId && version === 1) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN decision TEXT
            CHECK (decision IN ('approved','denied'));
          ALTER TABLE approval_requests ADD COLUMN dispatchOutcome TEXT
            CHECK (dispatchOutcome IN ('returned','blocked','failed'));
          UPDATE approval_requests SET decision = 'approved'
            WHERE status IN ('approved','claimed','completed');
          UPDATE approval_requests SET decision = 'denied'
            WHERE status = 'denied';
          ALTER TABLE approval_requests ADD COLUMN handlerReturnedAt INTEGER;
          ALTER TABLE approval_requests ADD COLUMN mcpLifecycleAction TEXT;
          ALTER TABLE approval_requests ADD COLUMN mcpConnectorId TEXT;
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          PRAGMA user_version = 5;
        `);
        return;
      }
      if (
        id !== 0 || version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      ) {
        throw new Error("Invalid approval inbox database or version.");
      }
      db.exec(`
        CREATE TABLE approval_requests (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          scope TEXT NOT NULL,
          sessionId TEXT NOT NULL,
          runId TEXT,
          assignmentId TEXT,
          tool TEXT NOT NULL,
          mcpLifecycleAction TEXT,
          mcpConnectorId TEXT,
          chatGoal TEXT,
          binding TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','claimed','completed','stale')),
          decision TEXT CHECK (decision IN ('approved','denied')),
          dispatchOutcome TEXT CHECK (dispatchOutcome IN ('returned','blocked','failed')),
          claimToken TEXT,
          handlerReturnedAt INTEGER,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          expiresAt INTEGER NOT NULL
        );
        CREATE INDEX approval_by_scope ON approval_requests(scope, sequence DESC);
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = 5;
      `);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const read = db.prepare(
    "SELECT * FROM approval_requests WHERE scope = ? AND id = ?",
  );
  const expired = db.prepare(`
    UPDATE approval_requests SET status = 'stale', updatedAt = ?
    WHERE scope = ? AND status IN ('pending','approved') AND expiresAt <= ?
  `);

  return {
    submit(raw: ApprovalInboxRequest): ApprovalInboxRecord | undefined {
      const id = requestId(raw.id);
      const {
        scope,
        sessionId,
        runId,
        assignmentId,
        tool,
        mcpLifecycle,
        chatGoal,
        binding,
        expiresAt,
      } = raw;
      const approvedGoalReview = chatGoal &&
        parseChatGoalApprovalReview(chatGoal);
      const encodedGoalReview = approvedGoalReview
        ? JSON.stringify(approvedGoalReview)
        : null;
      if (
        !id || !exactReference(scope) || !exactReference(sessionId) ||
        runId !== undefined && !exactReference(runId) ||
        assignmentId !== undefined && !exactReference(assignmentId) ||
        typeof tool !== "string" || !toolPattern.test(tool) ||
        mcpLifecycle !== undefined &&
          (!mcpLifecycle || tool !== "mcp_manage" ||
            !parseMcpLifecycleReview(
              mcpLifecycle.action,
              mcpLifecycle.connectorId,
            )) ||
        chatGoal !== undefined &&
          (tool !== "goal_report" || !approvedGoalReview) ||
        typeof binding !== "string" || !tokenPattern.test(binding) ||
        !Number.isSafeInteger(expiresAt) || expiresAt < 1
      ) return undefined;
      return transaction(db, () => {
        const at = now();
        expired.run(at, scope, at);
        const previous = read.get(scope, id);
        if (previous) {
          return previous.sessionId === sessionId &&
              previous.runId === (runId ?? null) &&
              previous.assignmentId === (assignmentId ?? null) &&
              previous.tool === tool &&
              previous.mcpLifecycleAction === (mcpLifecycle?.action ?? null) &&
              previous.mcpConnectorId === (mcpLifecycle?.connectorId ?? null) &&
              previous.chatGoal === encodedGoalReview &&
              previous.binding === binding && previous.expiresAt === expiresAt
            ? project(previous)
            : undefined;
        }
        if (expiresAt <= at) return undefined;
        const row = db.prepare(`
          INSERT INTO approval_requests (id,scope,sessionId,runId,assignmentId,tool,mcpLifecycleAction,mcpConnectorId,chatGoal,binding,status,createdAt,updatedAt,expiresAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)
          ON CONFLICT(id) DO NOTHING RETURNING *
        `).get(
          id,
          scope,
          sessionId,
          runId ?? null,
          assignmentId ?? null,
          tool,
          mcpLifecycle?.action ?? null,
          mcpLifecycle?.connectorId ?? null,
          encodedGoalReview,
          binding,
          at,
          at,
          expiresAt,
        );
        return project(row);
      });
    },

    read(scope: string, rawId: string): ApprovalInboxRecord | undefined {
      const id = requestId(rawId);
      if (!id || !exactReference(scope)) return undefined;
      const at = now();
      expired.run(at, scope, at);
      return project(read.get(scope, id));
    },

    list(scope: string, limit = 20, before?: number) {
      if (
        !exactReference(scope) || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 100 ||
        before !== undefined && (!Number.isSafeInteger(before) || before < 1)
      ) return { records: [], nextBefore: null };
      const at = now();
      expired.run(at, scope, at);
      const rows = db.prepare(`
        SELECT * FROM approval_requests WHERE scope = ? AND sequence < ?
        ORDER BY sequence DESC LIMIT ?
      `).all(scope, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
      const page = rows.slice(0, limit);
      return {
        records: page.map((row) => project(row)!),
        nextBefore: rows.length > limit ? Number(page.at(-1)!.sequence) : null,
      };
    },

    decide(scope: string, rawId: string, decision: ApprovalInboxDecision) {
      const id = requestId(rawId);
      if (
        !id || !exactReference(scope) ||
        (decision !== "approved" && decision !== "denied")
      ) return undefined;
      return transaction(db, () => {
        const at = now();
        expired.run(at, scope, at);
        const row = db.prepare(`
          UPDATE approval_requests SET status = ?, decision = ?, updatedAt = ?
          WHERE scope = ? AND id = ? AND status = 'pending' RETURNING *
        `).get(decision, decision, at, scope, id);
        if (row) return project(row);
        const existing = read.get(scope, id);
        return existing?.status === decision ? project(existing) : undefined;
      });
    },

    claim(scope: string, rawId: string, binding: string) {
      const id = requestId(rawId);
      if (
        !id || !exactReference(scope) || typeof binding !== "string" ||
        !tokenPattern.test(binding)
      ) return undefined;
      const token = crypto.randomUUID();
      return transaction(db, () => {
        const at = now();
        expired.run(at, scope, at);
        const row = db.prepare(`
          UPDATE approval_requests SET status = 'claimed', updatedAt = ?, claimToken = ?
          WHERE scope = ? AND id = ? AND binding = ? AND status = 'approved' AND expiresAt > ?
          RETURNING *
        `).get(at, token, scope, id, binding, at);
        return row ? { token, record: project(row)! } : undefined;
      });
    },

    recordHandlerReturn(scope: string, rawId: string, token: string) {
      const id = requestId(rawId);
      if (!id || !exactReference(scope) || !requestId(token)) return;
      return project(
        db.prepare(`
        UPDATE approval_requests
        SET handlerReturnedAt = COALESCE(handlerReturnedAt, ?), updatedAt = ?
        WHERE scope = ? AND id = ? AND status = 'claimed' AND claimToken = ?
        RETURNING *
      `).get(now(), now(), scope, id, token),
      );
    },

    complete(
      scope: string,
      rawId: string,
      token: string,
      outcome: ApprovalInboxDispatchOutcome = "returned",
    ) {
      const id = requestId(rawId);
      if (
        !id || !exactReference(scope) || !requestId(token) ||
        (outcome !== "returned" && outcome !== "blocked" &&
          outcome !== "failed")
      ) return undefined;
      return project(
        db.prepare(`
        UPDATE approval_requests SET status = 'completed', updatedAt = ?, claimToken = NULL, dispatchOutcome = ?
        WHERE scope = ? AND id = ? AND status = 'claimed' AND claimToken = ? RETURNING *
      `).get(now(), outcome, scope, id, token),
      );
    },

    stale(scope: string, rawId: string, binding: string) {
      const id = requestId(rawId);
      if (
        !id || !exactReference(scope) || typeof binding !== "string" ||
        !tokenPattern.test(binding)
      ) return undefined;
      return project(
        db.prepare(`
        UPDATE approval_requests SET status = 'stale', updatedAt = ?
        WHERE scope = ? AND id = ? AND binding = ? AND status IN ('pending','approved') RETURNING *
      `).get(now(), scope, id, binding),
      );
    },

    close() {
      db.close();
    },
  };
}
