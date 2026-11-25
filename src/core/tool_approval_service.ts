/** Hold an exact live tool call while an operator reviews metadata in the inbox. */
import { createHmac, randomBytes } from "node:crypto";
import { resolve } from "@std/path";
import { parseMcpLifecycleIntent } from "./mcp_lifecycle_intent.ts";
import {
  chatGoalMutation,
  parseChatGoalApprovalReview,
} from "./chat_goal_intent.ts";
import { parseCustomToolMutation } from "./custom_tool_intent.ts";
import { openApprovalInbox } from "./approval_inbox.ts";

export interface ToolApprovalContext {
  readonly runId?: string;
  readonly assignmentId?: string;
  readonly isCurrent?: (sessionId: string) => boolean | Promise<boolean>;
}

const ownerScope = "workspace-owner";
const services = new Map<string, ReturnType<typeof buildToolApprovalService>>();

function buildToolApprovalService(path: string) {
  const key = randomBytes(32);
  const waits = new Map<string, {
    signal: AbortSignal;
    wake: () => void;
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
  return {
    list(limit?: number, before?: number) {
      return use((db) => db.list(ownerScope, limit, before));
    },
    decide(id: string, decision: "approved" | "denied") {
      return use((db) => {
        const existing = db.read(ownerScope, id);
        if (!existing) return undefined;
        const waiting = waits.get(existing.id);
        if (!waiting || waiting.signal.aborted) {
          return existing.decision === decision ? existing : undefined;
        }
        const record = db.decide(ownerScope, id, decision);
        if (record) waiting.wake();
        return record;
      });
    },
    isWaiting(signal: AbortSignal) {
      return [...waits.values()].some((wait) => wait.signal === signal);
    },
    async wait(input: {
      readonly sessionId: string;
      readonly runId?: string;
      readonly assignmentId?: string;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly ruleId: string | null;
      readonly signal: AbortSignal;
    }) {
      const { sessionId, runId, assignmentId, tool, args, ruleId, signal } =
        input;
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
      const request = use((db) =>
        db.submit({
          id,
          scope: ownerScope,
          sessionId,
          runId,
          assignmentId,
          tool,
          ...(chatGoal && { chatGoal }),
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
      const stale = () => use((db) => db.stale(ownerScope, id, binding));
      const settled = Promise.withResolvers<void>();
      waits.set(id, { signal, wake: () => settled.resolve() });
      const wake = () => settled.resolve();
      signal.addEventListener("abort", wake, { once: true });
      const timer = setTimeout(
        wake,
        Math.max(0, request.expiresAt - Date.now()),
      );
      try {
        if (!signal.aborted) await settled.promise;
        const current = use((db) => db.read(ownerScope, id));
        if (signal.aborted || current?.status !== "approved") {
          stale();
          return undefined;
        }
        return {
          stale,
          claim(currentArgs: Record<string, unknown>) {
            if (signal.aborted || bind(currentArgs) !== binding) {
              return undefined;
            }
            const claim = use((db) => db.claim(ownerScope, id, binding));
            return claim && {
              requestId: id,
              recordHandlerReturn: () =>
                use((db) =>
                  db.recordHandlerReturn(ownerScope, id, claim.token)
                ),
              finish: (outcome: "returned" | "blocked" | "failed") =>
                use((db) => db.complete(ownerScope, id, claim.token, outcome)),
            };
          },
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", wake);
        waits.delete(id);
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
