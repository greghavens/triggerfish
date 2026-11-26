import {
  parseSentinelScopeRuleIntent,
  type SentinelScopeRuleIntent,
  sentinelScopeRuleToolName,
} from "./sentinel_scope_rule_intent.ts";
import {
  parseSentinelIncidentRecommendation,
  type SentinelIncidentRecommendation,
  sentinelIncidentRecommendationToolName,
} from "./sentinel_incident_review_intent.ts";
import {
  parseSentinelFindingReview,
  type SentinelFindingReview,
  sentinelPlannerFindingToolName,
} from "./sentinel_finding_review_intent.ts";
import { redactCredentialText } from "./logger/redactor.ts";
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

import {
  type CustomToolApprovalReview,
  customToolManageName,
  parseCustomToolApprovalReview,
} from "./custom_tool_intent.ts";

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
  readonly customTool?: CustomToolApprovalReview;
  readonly sentinelSteeringNote?: string;
  readonly sentinelFindingReview?: SentinelFindingReview;
  readonly sentinelScopeRuleReview?: SentinelScopeRuleIntent;
  readonly sentinelIncidentRecommendation?: SentinelIncidentRecommendation;
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
  readonly customTool?: CustomToolApprovalReview;
  readonly sentinelSteeringNote?: string;
  readonly sentinelFindingReview?: SentinelFindingReview;
  readonly sentinelScopeRuleReview?: SentinelScopeRuleIntent;
  readonly sentinelIncidentRecommendation?: SentinelIncidentRecommendation;
  readonly status: ApprovalInboxStatus;
  readonly decision?: ApprovalInboxDecision;
  readonly dispatchOutcome?: ApprovalInboxDispatchOutcome;
  readonly handlerReturnedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}

/** Terminal audit history without any live-claim or policy-binding fields. */
export type ArchivedToolDecision = Pick<
  ApprovalInboxRecord,
  | "id"
  | "runId"
  | "assignmentId"
  | "tool"
  | "status"
  | "decision"
  | "dispatchOutcome"
  | "handlerReturnedAt"
  | "createdAt"
  | "updatedAt"
>;

export const MAX_ARCHIVED_TOOL_DECISIONS = 1000;

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

const fields = new Set([
  "id",
  "runId",
  "assignmentId",
  "tool",
  "status",
  "decision",
  "dispatchOutcome",
  "handlerReturnedAt",
  "createdAt",
  "updatedAt",
]);

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate archived terminal metadata without accepting any dispatch authority. */
export function decodeArchivedToolDecisions(
  raw: unknown,
  runId: string,
  requireAssignment = false,
): readonly ArchivedToolDecision[] {
  if (
    !exactReference(runId) || !Array.isArray(raw) ||
    raw.length > MAX_ARCHIVED_TOOL_DECISIONS
  ) {
    throw new Error("Invalid archived tool decisions.");
  }
  const identities = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid archived tool decision.");
    }
    const itemRecord = item as Record<string, unknown>;
    const {
      id,
      assignmentId,
      tool,
      status,
      decision,
      dispatchOutcome,
      handlerReturnedAt,
      createdAt,
      updatedAt,
    } = itemRecord;
    const completed = status === "completed";
    if (
      Object.keys(itemRecord).some((key) => !fields.has(key)) ||
      typeof id !== "string" || requestId(id) !== id || identities.has(id) ||
      itemRecord.runId !== runId ||
      ((tool === sentinelPlannerFindingToolName ||
          tool === sentinelScopeRuleToolName)
        ? assignmentId !== undefined
        : ((requireAssignment || assignmentId !== undefined) &&
          !exactReference(assignmentId))) ||
      typeof tool !== "string" || !toolPattern.test(tool) ||
      (status !== "completed" && status !== "denied" && status !== "stale") ||
      decision !== (status === "denied" ? "denied" : "approved") ||
      !timestamp(createdAt) || !timestamp(updatedAt) || updatedAt < createdAt ||
      (completed
        ? (dispatchOutcome !== "returned" && dispatchOutcome !== "blocked" &&
          dispatchOutcome !== "failed") ||
          (handlerReturnedAt !== undefined &&
            (!timestamp(handlerReturnedAt) || handlerReturnedAt < createdAt ||
              handlerReturnedAt > updatedAt))
        : dispatchOutcome !== undefined || handlerReturnedAt !== undefined)
    ) throw new Error("Invalid archived tool decision.");
    identities.add(id);
  }
  return raw as ArchivedToolDecision[];
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
  tool: string,
): ChatGoalApprovalReview | undefined {
  if (typeof value !== "string") return;
  try {
    return parseChatGoalApprovalReview(JSON.parse(value), tool);
  } catch {
    return undefined;
  }
}

function projectCustomToolReview(
  value: unknown,
): CustomToolApprovalReview | undefined {
  if (typeof value !== "string") return;
  try {
    const { action, name } = JSON.parse(value);
    return parseCustomToolApprovalReview(action, name);
  } catch {
    return undefined;
  }
}

export const sentinelPlannerSteerToolName = "sentinel_request_worker_steer";

export function parseSentinelSteeringNote(value: unknown): string | undefined {
  if (
    typeof value !== "string" || !value.trim() || value.trim() !== value ||
    value.length > 1000 || /[\p{Cc}\p{Cf}]/u.test(value) ||
    redactCredentialText(value) !== value
  ) return;
  return value;
}

function projectFindingReview(value: unknown) {
  if (typeof value !== "string") return;
  try {
    return parseSentinelFindingReview(JSON.parse(value));
  } catch {
    return;
  }
}

function projectIncidentRecommendation(value: unknown) {
  if (typeof value !== "string") return;
  try {
    return parseSentinelIncidentRecommendation(
      JSON.parse(value),
      parseSentinelSteeringNote,
    );
  } catch {
    return;
  }
}

function project(row: Row | undefined): ApprovalInboxRecord | undefined {
  if (!row) return undefined;
  const tool = String(row.tool);
  const review = tool === "mcp_manage"
    ? parseMcpLifecycleReview(row.mcpLifecycleAction, row.mcpConnectorId)
    : undefined;
  const chatGoal = projectChatGoalReview(row.chatGoal, tool);
  const customTool = tool === customToolManageName
    ? projectCustomToolReview(row.customTool)
    : undefined;
  const steering = tool === sentinelPlannerSteerToolName
    ? parseSentinelSteeringNote(row.sentinelSteeringNote)
    : undefined;
  const finding = tool === sentinelPlannerFindingToolName
    ? projectFindingReview(row.sentinelFindingReview)
    : undefined;
  const scopeRule = tool === sentinelScopeRuleToolName &&
      typeof row.sentinelScopeRuleReview === "string"
    ? parseSentinelScopeRuleIntent(JSON.parse(row.sentinelScopeRuleReview))
    : undefined;
  const incident = tool === sentinelIncidentRecommendationToolName
    ? projectIncidentRecommendation(row.sentinelIncidentRecommendation)
    : undefined;
  return {
    id: String(row.id),
    scope: String(row.scope),
    sessionId: String(row.sessionId),
    ...(typeof row.runId === "string" && { runId: row.runId }),
    ...(typeof row.assignmentId === "string" &&
      { assignmentId: row.assignmentId }),
    tool,
    description: scopeRule
      ? `Approve Sentinel ${
        scopeRule.scope === "company"
          ? "shared company scope"
          : "case membership"
      } rule replacement for '${scopeRule.caseId}' revision ${scopeRule.evidenceRevision}: ${
        JSON.stringify(scopeRule)
      }`
      : incident
      ? `Approve changing Sentinel incident '${incident.incidentId}' to '${incident.disposition}'. ${incident.note}`
      : finding
      ? `Approve recording Sentinel finding '${finding.title}' on '${finding.targetId}' from retained evidence '${finding.evidenceId}'. ${finding.summary}`
      : steering && typeof row.assignmentId === "string"
      ? `Approve steering Sentinel assignment '${row.assignmentId}': ${steering}`
      : tool === "sentinel_request_worker_stop" &&
          typeof row.assignmentId === "string"
      ? `Approve stopping Sentinel assignment '${row.assignmentId}'.`
      : customTool
      ? "Approve " + customTool.action + " for custom tool '" +
        customTool.name + "'."
      : chatGoal?.action === "confirm"
      ? "role" in chatGoal
        ? `Confirm the exact ${chatGoal.role} goal decision for scope '${chatGoal.scope}'.`
        : `Confirm the exact owner goal decision for registration '${chatGoal.requestId}'.`
      : chatGoal
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
    ...(customTool && { customTool }),
    ...(steering && { sentinelSteeringNote: steering }),
    ...(finding && { sentinelFindingReview: finding }),
    ...(scopeRule && { sentinelScopeRuleReview: scopeRule }),
    ...(incident && { sentinelIncidentRecommendation: incident }),
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
      if (id === applicationId && version === 10) return;
      if (id === applicationId && version === 9) {
        db.exec(
          `ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;`,
        );
        return;
      }
      if (id === applicationId && version === 8) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 7) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 6) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 5) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN customTool TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 4) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          ALTER TABLE approval_requests ADD COLUMN customTool TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 3) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN mcpLifecycleAction TEXT;
          ALTER TABLE approval_requests ADD COLUMN mcpConnectorId TEXT;
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          ALTER TABLE approval_requests ADD COLUMN customTool TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
        `);
        return;
      }
      if (id === applicationId && version === 2) {
        db.exec(`
          ALTER TABLE approval_requests ADD COLUMN handlerReturnedAt INTEGER;
          ALTER TABLE approval_requests ADD COLUMN mcpLifecycleAction TEXT;
          ALTER TABLE approval_requests ADD COLUMN mcpConnectorId TEXT;
          ALTER TABLE approval_requests ADD COLUMN chatGoal TEXT;
          ALTER TABLE approval_requests ADD COLUMN customTool TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
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
          ALTER TABLE approval_requests ADD COLUMN customTool TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelSteeringNote TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelFindingReview TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelIncidentRecommendation TEXT;
          ALTER TABLE approval_requests ADD COLUMN sentinelScopeRuleReview TEXT;
          PRAGMA user_version = 10;
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
          customTool TEXT,
          sentinelSteeringNote TEXT,
          sentinelFindingReview TEXT,
          sentinelIncidentRecommendation TEXT,
          sentinelScopeRuleReview TEXT,
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
        PRAGMA user_version = 10;
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
        customTool,
        sentinelSteeringNote,
        sentinelFindingReview,
        sentinelScopeRuleReview,
        sentinelIncidentRecommendation,
        binding,
        expiresAt,
      } = raw;
      const approvedGoalReview = chatGoal &&
        parseChatGoalApprovalReview(chatGoal, tool);
      const encodedGoalReview = approvedGoalReview
        ? JSON.stringify(approvedGoalReview)
        : null;
      const approvedCustomTool = customTool &&
        parseCustomToolApprovalReview(customTool.action, customTool.name);
      const encodedCustomTool = approvedCustomTool
        ? JSON.stringify(approvedCustomTool)
        : null;
      const steering = parseSentinelSteeringNote(sentinelSteeringNote);
      const finding = parseSentinelFindingReview(sentinelFindingReview);
      const encodedFinding = finding ? JSON.stringify(finding) : null;
      const scopeRule = parseSentinelScopeRuleIntent(sentinelScopeRuleReview);
      const encodedScopeRule = scopeRule ? JSON.stringify(scopeRule) : null;
      const incident = sentinelIncidentRecommendation &&
        parseSentinelIncidentRecommendation(
          sentinelIncidentRecommendation,
          parseSentinelSteeringNote,
        );
      const encodedIncident = incident ? JSON.stringify(incident) : null;
      if (
        (tool === sentinelScopeRuleToolName
          ? !scopeRule || assignmentId !== undefined || runId === undefined
          : sentinelScopeRuleReview !== undefined) ||
        (tool === sentinelIncidentRecommendationToolName
          ? !incident || assignmentId === undefined || runId === undefined
          : sentinelIncidentRecommendation !== undefined) ||
        (tool === sentinelPlannerFindingToolName
          ? !finding || assignmentId !== undefined || runId === undefined
          : sentinelFindingReview !== undefined) ||
        (tool === sentinelPlannerSteerToolName
          ? !steering || assignmentId === undefined
          : sentinelSteeringNote !== undefined) ||
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
          !approvedGoalReview ||
        customTool !== undefined &&
          (tool !== customToolManageName || !approvedCustomTool) ||
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
              previous.customTool === encodedCustomTool &&
              previous.sentinelSteeringNote === (steering ?? null) &&
              previous.sentinelFindingReview === encodedFinding &&
              previous.sentinelScopeRuleReview === encodedScopeRule &&
              previous.sentinelIncidentRecommendation === encodedIncident &&
              previous.binding === binding && previous.expiresAt === expiresAt
            ? project(previous)
            : undefined;
        }
        if (expiresAt <= at) return undefined;
        const row = db.prepare(`
          INSERT INTO approval_requests (id,scope,sessionId,runId,assignmentId,tool,mcpLifecycleAction,mcpConnectorId,chatGoal,customTool,sentinelSteeringNote,sentinelFindingReview,sentinelIncidentRecommendation,sentinelScopeRuleReview,binding,status,createdAt,updatedAt,expiresAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)
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
          encodedCustomTool,
          steering ?? null,
          encodedFinding,
          encodedIncident,
          encodedScopeRule,
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

    archiveRunDecisions(
      scope: string,
      runId: string,
      sessionId?: string,
    ): ArchivedToolDecision[] {
      if (
        !exactReference(scope) || !exactReference(runId) ||
        (sessionId !== undefined && !exactReference(sessionId))
      ) {
        throw new Error("Invalid approval archive scope.");
      }
      const rows = db.prepare(`
        SELECT id, runId, assignmentId, tool, status, decision, dispatchOutcome,
          handlerReturnedAt, createdAt, updatedAt
        FROM approval_requests WHERE scope = ? AND runId = ?
          AND ((? IS NULL AND (assignmentId IS NOT NULL OR tool IN (?,?))) OR sessionId = ?)
          AND status IN ('denied','completed','stale') AND decision IS NOT NULL
        ORDER BY updatedAt DESC, id ASC LIMIT ?
      `).all(
        scope,
        runId,
        sessionId ?? null,
        sentinelPlannerFindingToolName,
        sentinelScopeRuleToolName,
        sessionId ?? null,
        MAX_ARCHIVED_TOOL_DECISIONS + 1,
      );
      if (rows.length > MAX_ARCHIVED_TOOL_DECISIONS) {
        throw new Error("Too many approval decisions to archive.");
      }
      return rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([, value]) => value !== null),
        )
      ) as ArchivedToolDecision[];
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
      retainedRead?: { binding: string; resultSha256: string },
    ) {
      const id = requestId(rawId);
      if (
        !id || !exactReference(scope) || !requestId(token) ||
        (outcome !== "returned" && outcome !== "blocked" &&
          outcome !== "failed")
      ) return undefined;
      const finish = () =>
        db.prepare(`
        UPDATE approval_requests SET status = 'completed', updatedAt = ?, claimToken = NULL, dispatchOutcome = ?
        WHERE scope = ? AND id = ? AND status = 'claimed' AND claimToken = ? RETURNING *
      `).get(now(), outcome, scope, id, token);
      if (
        outcome !== "returned" || !retainedRead ||
        !tokenPattern.test(retainedRead.binding) ||
        !tokenPattern.test(retainedRead.resultSha256)
      ) return project(finish());
      return transaction(db, () => {
        const row = finish();
        if (
          row?.decision === "approved" &&
          typeof row.handlerReturnedAt === "number"
        ) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS approval_completed_reads (
              requestId TEXT PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
              binding TEXT NOT NULL,
              resultSha256 TEXT NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS approval_completed_read_scope
              ON approval_completed_reads(binding, resultSha256);
          `);
          db.prepare("INSERT INTO approval_completed_reads VALUES (?, ?, ?)")
            .run(id, retainedRead.binding, retainedRead.resultSha256);
        }
        return project(row);
      });
    },

    /** Check an approved completed read without reusing its claim or dispatching. */
    hasCompletedRead(scope: string, binding: string, resultSha256: string) {
      if (
        !exactReference(scope) || !tokenPattern.test(binding) ||
        !tokenPattern.test(resultSha256) || !db.prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'approval_completed_reads'",
        ).get()
      ) return false;
      return !!db.prepare(`
        SELECT 1 FROM approval_completed_reads AS receipt
        JOIN approval_requests AS request ON request.id = receipt.requestId
        WHERE receipt.binding = ? AND receipt.resultSha256 = ?
          AND request.scope = ? AND request.status = 'completed'
          AND request.decision = 'approved' AND request.dispatchOutcome = 'returned'
          AND request.handlerReturnedAt IS NOT NULL
        LIMIT 1
      `).get(binding, resultSha256, scope);
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
