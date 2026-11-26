import { parseSentinelSteeringNote } from "../core/approval_inbox.ts";
import {
  parseSentinelIncidentRecommendation,
  sentinelIncidentRecommendationToolName,
} from "../core/sentinel_incident_review_intent.ts";
import { parseSentinelFindingReview } from "../core/sentinel_finding_review_intent.ts";
/** Owner-only inbox controls shared by authenticated chat transports. */
import type { ApprovalInboxRecord } from "../core/approval_inbox.ts";
import { parseChatGoalApprovalReview } from "../core/chat_goal_intent.ts";

type MaybePromise<T> = T | Promise<T>;

export interface ApprovalInboxPage {
  readonly records: readonly ApprovalInboxRecord[];
  readonly nextBefore: number | null;
}

export interface ApprovalInboxSocketService {
  list(limit?: number, before?: number): MaybePromise<ApprovalInboxPage>;
  decide(
    approvalId: string,
    decision: "approved" | "denied",
  ): MaybePromise<ApprovalInboxRecord | undefined>;
  isWaiting(signal: AbortSignal): boolean;
}

export type ApprovalInboxSocketRequest =
  | {
    readonly type: "approval_inbox_list";
    readonly requestId: string;
    readonly limit?: number;
    readonly before?: number;
  }
  | {
    readonly type: "approval_inbox_decide";
    readonly requestId: string;
    readonly approvalId: string;
    readonly approved: boolean;
  };

type ReplyBase = {
  readonly type: "approval_inbox_result";
  readonly requestId: string | null;
  readonly operation: "list" | "decide";
};

export type ApprovalInboxSocketReply =
  & ReplyBase
  & (
    | {
      readonly ok: true;
      readonly result: ApprovalInboxPage | ApprovalInboxRecord;
    }
    | { readonly ok: false; readonly error: string }
  );

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function numberWithin(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= min && value <= max;
}

function project(record: ApprovalInboxRecord): ApprovalInboxRecord {
  const {
    id,
    scope,
    sessionId,
    runId,
    assignmentId,
    tool,
    description,
    mcpLifecycle,
    status,
    decision,
    dispatchOutcome,
    handlerReturnedAt,
    createdAt,
    updatedAt,
    expiresAt,
  } = record;
  const chatGoal = parseChatGoalApprovalReview(record.chatGoal, tool);
  const finding = parseSentinelFindingReview(record.sentinelFindingReview);
  const incident = tool === sentinelIncidentRecommendationToolName &&
    record.sentinelIncidentRecommendation &&
    parseSentinelIncidentRecommendation(
      record.sentinelIncidentRecommendation,
      parseSentinelSteeringNote,
    );
  return {
    id,
    scope,
    sessionId,
    tool,
    description,
    ...(mcpLifecycle && { mcpLifecycle }),
    ...(chatGoal && { chatGoal }),
    ...(finding && { sentinelFindingReview: finding }),
    ...(incident && { sentinelIncidentRecommendation: incident }),
    status,
    ...(decision !== undefined && { decision }),
    ...(dispatchOutcome !== undefined && { dispatchOutcome }),
    ...(handlerReturnedAt !== undefined && { handlerReturnedAt }),
    createdAt,
    updatedAt,
    expiresAt,
    ...(runId !== undefined && { runId }),
    ...(assignmentId !== undefined && { assignmentId }),
  };
}

/** Handle inbox traffic before the normal turn lock so reconnects can decide pending work. */
export function routeApprovalInboxSocketRequest(
  raw: unknown,
  inbox: ApprovalInboxSocketService | undefined,
  send: (response: ApprovalInboxSocketReply) => void,
): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const msg = raw as Record<string, unknown>;
  if (
    msg.type !== "approval_inbox_list" && msg.type !== "approval_inbox_decide"
  ) return false;
  const operation = msg.type === "approval_inbox_list" ? "list" : "decide";
  const requestId = opaqueId(msg.requestId) ? msg.requestId : null;
  const base: ReplyBase = {
    type: "approval_inbox_result",
    requestId,
    operation,
  };
  if (!inbox) {
    send({
      ...base,
      ok: false,
      error: "Approval inbox requires authenticated owner access.",
    });
    return true;
  }
  const { approvalId, approved, limit = 20, before } = msg;
  const fields = operation === "list"
    ? ["type", "requestId", "limit", "before"]
    : ["type", "requestId", "approvalId", "approved"];
  if (
    !requestId || Object.keys(msg).some((key) => !fields.includes(key)) ||
    !numberWithin(limit, 1, 100) ||
    (before !== undefined &&
      !numberWithin(before, 1, Number.MAX_SAFE_INTEGER)) ||
    (operation === "decide" && (typeof approvalId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(approvalId) ||
      typeof approved !== "boolean"))
  ) {
    send({ ...base, ok: false, error: "Invalid approval inbox request." });
    return true;
  }
  void Promise.resolve().then(async () => {
    if (operation === "list") {
      const page = await inbox.list(limit, before);
      send({
        ...base,
        ok: true,
        result: {
          records: page.records.slice(0, limit).map(project),
          nextBefore: page.nextBefore,
        },
      });
      return;
    }
    const id = (approvalId as string).toLowerCase();
    const record = await inbox.decide(
      id,
      approved === true ? "approved" : "denied",
    );
    if (!record || record.id !== id) {
      throw new Error("Approval inbox response unavailable.");
    }
    send({ ...base, ok: true, result: project(record) });
  }).catch(() => {
    send({
      ...base,
      ok: false,
      error: "The requested approval inbox operation is unavailable.",
    });
  });
  return true;
}
