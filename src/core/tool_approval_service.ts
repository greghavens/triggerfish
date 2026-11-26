import type { PendingApprovalAdvice } from "./policy/approval_advice.ts";
import {
  parseSentinelScopeRuleIntent,
  sentinelScopeRuleToolName,
} from "./sentinel_scope_rule_intent.ts";
import {
  parseSentinelIncidentRecommendation,
  sentinelIncidentRecommendationToolName,
} from "./sentinel_incident_review_intent.ts";
import {
  parseSentinelFindingReview,
  sentinelPlannerFindingToolName,
} from "./sentinel_finding_review_intent.ts";
import { AsyncLocalStorage } from "node:async_hooks";
/** Hold an exact live tool call while an operator reviews metadata in the inbox. */
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "@std/path";
import { parseMcpLifecycleIntent } from "./mcp_lifecycle_intent.ts";
import {
  chatGoalMutation,
  parseChatGoalApprovalReview,
} from "./chat_goal_intent.ts";
import { parseCustomToolMutation } from "./custom_tool_intent.ts";
import {
  type ApprovalInboxRecord,
  openApprovalInbox,
  parseSentinelSteeringNote,
  sentinelPlannerSteerToolName,
} from "./approval_inbox.ts";

export interface ToolApprovalContext {
  readonly runId?: string;
  readonly assignmentId?: string;
  readonly assignmentForCall?: (
    name: string,
    args: Record<string, unknown>,
  ) => string | undefined;
  readonly scopeForCall?: (
    name: string,
    args: Record<string, unknown>,
  ) =>
    | { readonly assignmentId?: string; readonly binding?: string }
    | undefined;
  readonly isCurrent?: (sessionId: string) => boolean | Promise<boolean>;
}

const currentApprovalRun = new AsyncLocalStorage<{
  readonly sessionId: string;
  readonly runId: string;
  active: boolean;
}>();

/** Bind approvals to the trusted execution for this asynchronous turn only. */
export async function withExactToolApprovalRun<T>(
  scope: { readonly sessionId: string; readonly runId: string },
  execute: () => Promise<T>,
): Promise<T> {
  const current = { ...scope, active: true };
  try {
    return await currentApprovalRun.run(current, execute);
  } finally {
    current.active = false;
  }
}

export function exactToolApprovalRun(sessionId: string): string | undefined {
  const scope = currentApprovalRun.getStore();
  return scope?.active && scope.sessionId === sessionId
    ? scope.runId
    : undefined;
}

export const toolApprovalOwnerScope = "workspace-owner";
const services = new Map<string, ReturnType<typeof buildToolApprovalService>>();

function buildToolApprovalService(path: string) {
  const key = randomBytes(32);
  const waits = new Map<string, {
    signal: AbortSignal;
    wake: () => void;
    canProject?: () => boolean;
    stale: () => unknown;
  }>();
  const use = <T>(
    operation: (db: ReturnType<typeof openApprovalInbox>) => T,
  ) => {
    const db = openApprovalInbox(path);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  };
  function project(record: ApprovalInboxRecord) {
    if (
      (!record.sentinelIncidentRecommendation &&
        !record.sentinelScopeRuleReview) ||
      waits.get(record.id)?.canProject?.()
    ) {
      return record;
    }
    const {
      sentinelIncidentRecommendation: _recommendation,
      sentinelScopeRuleReview: _scope,
      ...metadata
    } = record;
    return {
      ...metadata,
      description: record.sentinelScopeRuleReview
        ? "Sentinel membership rules approval."
        : "Sentinel incident disposition approval.",
    };
  }
  return {
    list(limit?: number, before?: number) {
      const page = use((db) => db.list(toolApprovalOwnerScope, limit, before));
      return { ...page, records: page.records.map(project) };
    },
    decide(id: string, decision: "approved" | "denied") {
      return use((db) => {
        const existing = db.read(toolApprovalOwnerScope, id);
        if (!existing) return undefined;
        const waiting = waits.get(existing.id);
        if (!waiting || waiting.signal.aborted) {
          return existing.decision === decision ? project(existing) : undefined;
        }
        if (waiting.canProject && !waiting.canProject()) {
          waiting.stale();
          waiting.wake();
          return undefined;
        }
        const record = db.decide(toolApprovalOwnerScope, id, decision);
        if (record) waiting.wake();
        return record && project(record);
      });
    },
    isWaiting(signal: AbortSignal) {
      return [...waits.values()].some((wait) => wait.signal === signal);
    },
    async wait(input: {
      readonly sessionId: string;
      readonly runId?: string;
      readonly assignmentId?: string;
      readonly scopeBinding?: string;
      readonly canProject?: () => boolean;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly ruleId: string | null;
      readonly advise?: (input: PendingApprovalAdvice) => Promise<void>;
      readonly authorizeAdvice?: PendingApprovalAdvice["authorize"];
      readonly signal: AbortSignal;
    }) {
      const {
        sessionId,
        runId,
        assignmentId,
        scopeBinding,
        tool,
        args,
        ruleId,
        signal,
      } = input;
      if (signal.aborted) return undefined;
      const id = crypto.randomUUID();
      const bind = (args: Record<string, unknown>) =>
        createHmac("sha256", key).update(
          JSON.stringify([
            id,
            sessionId,
            runId,
            assignmentId,
            tool,
            args,
            ruleId,
            ...(scopeBinding ? [scopeBinding] : []),
          ]),
        ).digest("hex");
      const binding = bind(args);
      const lifecycle = parseMcpLifecycleIntent(tool, args);
      const custom = parseCustomToolMutation(tool, args);
      const goalAction = chatGoalMutation(tool, args);
      const chatGoal = goalAction === "confirm"
        ? parseChatGoalApprovalReview(args, tool)
        : goalAction && parseChatGoalApprovalReview({
          action: goalAction,
          requestId: args.requestId,
          criterionCount: Array.isArray(args.criteria)
            ? args.criteria.length
            : undefined,
          ...(args.expectedRequestId !== undefined &&
            { expectedRequestId: args.expectedRequestId }),
        });
      if (goalAction && !chatGoal) return undefined;
      const steering = tool === sentinelPlannerSteerToolName
        ? parseSentinelSteeringNote(args.note)
        : undefined;
      if (tool === sentinelPlannerSteerToolName && !steering) return undefined;
      const finding = tool === sentinelPlannerFindingToolName
        ? parseSentinelFindingReview(args)
        : undefined;
      if (
        tool === sentinelPlannerFindingToolName &&
        (!finding || !scopeBinding || !/^[a-f0-9]{64}$/.test(scopeBinding))
      ) return undefined;
      const scopeRule = tool === sentinelScopeRuleToolName
        ? parseSentinelScopeRuleIntent(args)
        : undefined;
      if (
        tool === sentinelScopeRuleToolName &&
        (!scopeRule || !input.canProject || !scopeBinding ||
          !/^[a-f0-9]{64}$/.test(scopeBinding))
      ) return undefined;
      const incident = tool === sentinelIncidentRecommendationToolName
        ? parseSentinelIncidentRecommendation(args, parseSentinelSteeringNote)
        : undefined;
      if (
        tool === sentinelIncidentRecommendationToolName &&
        (!incident || !input.canProject || !scopeBinding ||
          !/^[a-f0-9]{64}$/.test(scopeBinding))
      ) return undefined;
      const request = use((db) =>
        db.submit({
          id,
          scope: toolApprovalOwnerScope,
          sessionId,
          runId,
          assignmentId,
          tool,
          ...(chatGoal && { chatGoal }),
          ...(steering && { sentinelSteeringNote: steering }),
          ...(finding && { sentinelFindingReview: finding }),
          ...(scopeRule && { sentinelScopeRuleReview: scopeRule }),
          ...(incident && { sentinelIncidentRecommendation: incident }),
          ...(custom &&
            { customTool: { action: custom.action, name: custom.name } }),
          ...(lifecycle && {
            mcpLifecycle: {
              action: lifecycle.action,
              connectorId: lifecycle.connectorId,
            },
          }),
          binding,
          expiresAt: Date.now() + 120_000,
        })
      );
      if (!request) return undefined;
      const settled = Promise.withResolvers<void>();
      const wake = () => settled.resolve();
      const dispose = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abandon);
        waits.delete(id);
      };
      const abandon = () => {
        dispose();
        wake();
      };
      const stale = () => {
        dispose();
        return use((db) => db.stale(toolApprovalOwnerScope, id, binding));
      };
      const timer = setTimeout(
        abandon,
        Math.max(0, request.expiresAt - Date.now()),
      );
      waits.set(id, {
        signal,
        wake,
        stale,
        canProject: (incident || scopeRule) && input.canProject,
      });
      signal.addEventListener("abort", abandon, { once: true });
      if (input.advise && input.authorizeAdvice) {
        const authorize = input.authorizeAdvice;
        void Promise.resolve().then(() =>
          input.advise?.({
            id,
            tool,
            scoped: assignmentId !== undefined,
            ruleId,
            signal,
            authorize,
            isCurrent: () =>
              !signal.aborted &&
              waits.has(id) &&
              use((db) => db.read(toolApprovalOwnerScope, id))?.status ===
                "pending" &&
              (!input.canProject || input.canProject()),
          })
        ).catch(() => undefined);
      }
      let released = false;
      try {
        if (!signal.aborted) await settled.promise;
        const current = use((db) => db.read(toolApprovalOwnerScope, id));
        if (signal.aborted || current?.status !== "approved") {
          stale();
          return undefined;
        }
        // Keep the initiating turn attached to the inbox while root dispatch
        // revalidates policy and assignment state. Claim or stale settles it.
        released = true;
        return {
          stale,
          claim(currentArgs: Record<string, unknown>) {
            dispose();
            if (signal.aborted || bind(currentArgs) !== binding) {
              return undefined;
            }
            const claim = use((db) =>
              db.claim(toolApprovalOwnerScope, id, binding)
            );
            return claim && {
              requestId: id,
              recordHandlerReturn: () =>
                use((db) =>
                  db.recordHandlerReturn(
                    toolApprovalOwnerScope,
                    id,
                    claim.token,
                  )
                ),
              finish: (outcome: "returned" | "blocked" | "failed") =>
                use((db) =>
                  db.complete(toolApprovalOwnerScope, id, claim.token, outcome)
                ),
            };
          },
        };
      } finally {
        if (!released) dispose();
      }
    },
  };
}

export type ToolApprovalService = ReturnType<typeof buildToolApprovalService>;

export function createToolApprovalService(path: string): ToolApprovalService {
  const absolute = resolve(path);
  let service = services.get(absolute);
  if (!service) {
    service = buildToolApprovalService(absolute);
    services.set(absolute, service);
  }
  return service;
}
