/** Owner-chat goal registration and evidence reporting. */
import type { MessageStore } from "../core/conversation/mod.ts";
import {
  chatGoalMutation,
  parseChatGoalApprovalReview,
} from "../core/chat_goal_intent.ts";
import {
  type GoalCompletionRecord,
  GoalCompletionStore,
  goalConfirmationDigest,
  type GoalRegistration,
  type ManagedGoalTraceAccess,
  summarizeGoalCriteria,
} from "../core/goal_completion.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import { computeContentHash } from "../core/session/lineage_serde.ts";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../core/types/tool.ts";

import { parseManagedGoalCitation } from "./startup/factory/managed_goal_trace_evidence.ts";

export const CHAT_GOAL_REPORT_TOOL: ToolDefinition = {
  name: "goal_report",
  description:
    "Report a criterion using matching saved tool results, read exact goal history, or ask the owner to approve a registration, revision, or exact completion decision.",
  parameters: {
    criterion: {
      type: "string",
      description: "Acceptance criterion ID to report",
    },
    action: {
      type: "string",
      enum: ["status", "history", "register", "revise", "confirm"],
      description:
        "Read status/history or request an exact owner-approved goal operation.",
    },
    requestId: {
      type: "string",
      description:
        "Registration ID for status or confirm, or a fresh UUID for register/revise. Status and confirm also accept legacy.",
    },
    decisionSha256: {
      type: "string",
      description: "Exact saved completion decision digest for confirm",
    },
    before: {
      type: "string",
      description: "Registration history cursor from the preceding page",
    },
    expectedRequestId: {
      type: "string",
      description: "Exact current registration for revise.",
    },
    goal: {
      type: "string",
      description: "Formal goal for register or revise.",
    },
    policy: {
      type: "string",
      enum: ["automatic", "operator"],
      description: "Completion policy for the proposed goal.",
    },
    criteria: {
      type: "array",
      description:
        "Verifiable acceptance criteria with a tool name and SHA-256 of its expected result.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          tool: { type: "string" },
          resultSha256: { type: "string" },
        },
      },
    },
  },
};

export const MANAGED_GOAL_STATE_TOOL: ToolDefinition = {
  name: "managed_goal_state",
  description:
    "List or inspect configured scheduled and delegated goals, or cite an exact approved tool trace for an operator-policy criterion. Ask the operator to confirm an exact completion decision through the approval inbox.",
  parameters: {
    role: {
      type: "string",
      description: "Configured goal role",
      required: true,
      enum: ["scheduler", "delegated"],
    },
    action: {
      type: "string",
      description:
        "List scopes, inspect goal status, cite a result, or request exact confirmation",
      required: true,
      enum: ["list", "status", "cite", "confirm"],
    },
    scope: { type: "string", description: "Exact goal scope" },
    decisionSha256: {
      type: "string",
      description: "Exact completion decision digest for confirm",
    },
    afterScope: { type: "string", description: "List page cursor" },
    criterion: { type: "string", description: "Exact criterion ID for cite" },
    runId: { type: "string", description: "Exact execution trace run ID" },
    ordinal: { type: "integer", description: "Exact execution trace step" },
    teamId: {
      type: "string",
      description: "Required for a team delivery citation",
    },
  },
};

/** Translate a validated root operation for the managed goal backend. */
export async function executeManagedChatGoal(
  runCommand: (
    command: string,
    taint: ClassificationLevel,
    access?: ManagedGoalTraceAccess,
  ) => Promise<string | undefined>,
  args: Record<string, unknown>,
  taint: ClassificationLevel,
  access?: ManagedGoalTraceAccess,
): Promise<string> {
  const {
    role,
    action,
    scope,
    afterScope,
    criterion,
    runId,
    ordinal,
    teamId,
    decisionSha256,
  } = args;
  const key = /^[A-Za-z0-9_.:-]{1,120}$/;
  const unavailable = "Error: Managed goal state is unavailable.";
  if (
    (role !== "scheduler" && role !== "delegated") ||
    Object.keys(args).some((field) =>
      !Object.hasOwn(MANAGED_GOAL_STATE_TOOL.parameters, field)
    )
  ) return unavailable;
  const proof = { criterion, runId, ordinal, teamId };
  try {
    let suffix;
    if (action === "confirm") {
      const review = parseChatGoalApprovalReview(
        args,
        MANAGED_GOAL_STATE_TOOL.name,
      );
      if (
        !review || !("role" in review) || !access?.current() ||
        !access.reauthorizeDecision
      ) return unavailable;
      suffix = `${review.scope} ${review.decisionSha256}`;
    } else if (action === "cite") {
      if (
        !access?.current() || afterScope !== undefined ||
        decisionSha256 !== undefined
      ) return unavailable;
      suffix = JSON.stringify({ scope, ...proof });
      parseManagedGoalCitation(
        suffix,
        role === "scheduler" ? "scheduled" : "delegated",
      );
    } else {
      if (
        decisionSha256 !== undefined ||
        Object.values(proof).some((value) => value !== undefined)
      ) {
        return unavailable;
      }
      if (
        action === "status" && typeof scope === "string" && key.test(scope) &&
        afterScope === undefined
      ) {
        suffix = scope;
      } else if (
        action === "list" && scope === undefined && (afterScope === undefined ||
          (typeof afterScope === "string" && key.test(afterScope)))
      ) {
        suffix = afterScope;
      } else {
        return unavailable;
      }
    }
    const result = await runCommand(
      `/goal ${role} ${action}${suffix ? ` ${suffix}` : ""}`,
      taint,
      action === "cite" || action === "confirm" ? access : undefined,
    );
    if (!result) {
      return unavailable;
    }
    const payload = JSON.parse(result);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return unavailable;
    }
    return JSON.stringify({ ...payload, _classification: taint });
  } catch {
    return unavailable;
  }
}

function describe(
  record: GoalCompletionRecord | undefined,
  registration?: GoalRegistration,
): string {
  const revisesRequestId = registration?.revisesRequestId;
  return JSON.stringify(
    record
      ? {
        ...record,
        ...(revisesRequestId !== undefined && { revisesRequestId }),
        ...(registration && record.policy === "operator" &&
          record.status !== "open" && {
          confirmation: {
            requestId: registration.requestId,
            decisionSha256: goalConfirmationDigest(record),
          },
        }),
        criterionStatus: summarizeGoalCriteria(record),
      }
      : null,
  );
}

function visibleRecord(
  registration: GoalRegistration | undefined,
  taint: ClassificationLevel,
): GoalCompletionRecord | undefined {
  if (registration && !canFlowTo(registration.classification, taint)) {
    throw new Error("Goal registration is unavailable at this classification");
  }
  return registration?.record;
}

function describeRegistration(
  value: GoalRegistration | undefined,
  taint: ClassificationLevel,
): string {
  return describe(visibleRecord(value, taint), value);
}

function scope(sessionId: string): string {
  return `chat:${sessionId}`;
}

function parseRegistration(text: string, revise: boolean) {
  const input = JSON.parse(text);
  if (
    !input || typeof input.goal !== "string" ||
    !["automatic", "operator"].includes(input.policy) ||
    !Array.isArray(input.criteria) ||
    (input.requestId !== undefined && typeof input.requestId !== "string")
  ) {
    throw new Error("Expected goal, policy, and criteria.");
  }
  if (
    (revise && (typeof input.requestId !== "string" ||
      typeof input.expectedRequestId !== "string")) ||
    (!revise && input.expectedRequestId !== undefined)
  ) {
    throw new Error(
      "Use /goal revise with a new requestId and expectedRequestId.",
    );
  }
  return {
    requestId: input.requestId as string | undefined,
    expectedRequestId: input.expectedRequestId as string | undefined,
    goal: input.goal as string,
    policy: input.policy as "automatic" | "operator",
    criteria: input.criteria.map((criterion: Record<string, unknown>) => {
      if (
        !criterion || typeof criterion.id !== "string" ||
        typeof criterion.description !== "string" ||
        typeof criterion.tool !== "string" ||
        !/^(?!goal_report$)[a-zA-Z0-9_-]{1,128}$/.test(criterion.tool) ||
        typeof criterion.resultSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(criterion.resultSha256)
      ) {
        throw new Error(
          "Each criterion requires id, description, tool, and resultSha256.",
        );
      }
      return {
        id: criterion.id,
        description: criterion.description,
        requirement: `${criterion.tool}:${criterion.resultSha256}`,
      };
    }),
  };
}

function describeRegistrationHistory(
  store: GoalCompletionStore,
  family: string,
  taint: ClassificationLevel,
  before?: string,
) {
  const page = store.registrationHistory(family, before);
  for (const registration of page.registrations) {
    visibleRecord(registration, taint);
  }
  return {
    registrations: page.registrations.map((
      { requestId, revisesRequestId, record },
    ) => ({
      requestId,
      ...(revisesRequestId !== undefined && { revisesRequestId }),
      goal: record.goal,
      status: record.status,
      createdAt: record.createdAt,
      ...(record.completedAt && { completedAt: record.completedAt }),
    })),
    nextBefore: page.nextBefore,
  };
}

const goalReference =
  /^(?:legacy|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;

async function registerChatGoal(
  store: GoalCompletionStore,
  messages: MessageStore,
  sessionId: string,
  taint: ClassificationLevel,
  input: ReturnType<typeof parseRegistration>,
  isCurrent?: () => boolean,
) {
  const rows = await messages.loadSession(sessionId);
  const afterSequence = rows.reduce(
    (highest, { sequence }) => Math.max(highest, sequence),
    0,
  );
  if (isCurrent?.() === false) {
    throw new Error("Owner goal approval is unavailable.");
  }
  return describeRegistration(
    store.registerSuccessive(
      scope(sessionId),
      input.requestId,
      input.goal,
      input.criteria,
      input.policy,
      afterSequence,
      taint,
      input.expectedRequestId,
    ),
    taint,
  );
}

/** Handle an explicit owner command outside the model tool dispatcher. */
export async function runChatGoalCommand(
  path: string,
  messages: MessageStore,
  sessionId: string,
  taint: ClassificationLevel,
  command: string,
): Promise<string> {
  const store = new GoalCompletionStore(path);
  const family = scope(sessionId);
  try {
    const mutation = command.match(/^\/goal (register|revise) /);
    if (mutation) {
      const input = parseRegistration(
        command.slice(mutation[0].length),
        mutation[1] === "revise",
      );
      return await registerChatGoal(store, messages, sessionId, taint, input);
    }
    const status = command.match(/^\/goal status(?: (\S+))?$/);
    if (status) {
      return describeRegistration(
        store.readRegistration(family, status[1]),
        taint,
      );
    }
    const history = command.match(/^\/goal history(?: (\S+))?$/);
    if (history) {
      return JSON.stringify(
        describeRegistrationHistory(store, family, taint, history[1]),
      );
    }
    const confirm = command.match(/^\/goal confirm(?: (\S+) ([a-f0-9]{64}))?$/);
    if (confirm) {
      return await reportEvidence(
        store,
        messages,
        sessionId,
        taint,
        undefined,
        confirm[1]
          ? { requestId: confirm[1], decisionSha256: confirm[2] }
          : true,
      );
    }
    return "Usage: /goal register <JSON> (successors need a UUID requestId), " +
      "/goal revise <JSON> (new requestId and expectedRequestId), " +
      "/goal status [requestId|legacy], /goal history [before], " +
      "/goal confirm <requestId> <decisionSha256>";
  } finally {
    store.close();
  }
}

/** Handle model reads, evidence reports, and exactly approved registrations. */
export async function reportChatGoal(
  path: string,
  messages: MessageStore,
  sessionId: string,
  taint: ClassificationLevel,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<string> {
  const { action, requestId, before, criterion } = args;
  const unavailable = "Error: Owner goal state is unavailable.";
  const mutation = chatGoalMutation(CHAT_GOAL_REPORT_TOOL.name, args);
  if (mutation) {
    const current = () =>
      context?.ownerSessionId === sessionId &&
      !!context.toolApprovalRequestId &&
      context.isCurrentInteractiveOwner?.() === true;
    if (!current()) return unavailable;
    if (mutation === "confirm") {
      const decision = parseChatGoalApprovalReview(args);
      const reauthorize = context?.reauthorizeOwnerApproval;
      if (
        decision?.action !== "confirm" || !("requestId" in decision) ||
        !reauthorize
      ) {
        return unavailable;
      }
      const store = new GoalCompletionStore(path);
      try {
        const result = await reportEvidence(
          store,
          messages,
          sessionId,
          taint,
          undefined,
          decision,
          async () => current() && await reauthorize() && current(),
        );
        const completed = JSON.parse(result);
        if (completed?.status !== "completed") return unavailable;
        return JSON.stringify({ ...completed, _classification: taint });
      } catch {
        return "Error: The approved goal decision is no longer current or the evidence could not be reverified.";
      } finally {
        store.close();
      }
    }
    if (
      typeof requestId !== "string" ||
      requestId === "legacy" || !goalReference.test(requestId) ||
      Object.keys(args).some((key) =>
        ![
          "action",
          "requestId",
          "expectedRequestId",
          "goal",
          "policy",
          "criteria",
        ].includes(key)
      ) ||
      !Array.isArray(args.criteria) ||
      args.criteria.some((item) =>
        !item || typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((key) =>
          !["id", "description", "tool", "resultSha256"].includes(key)
        )
      )
    ) return unavailable;
    let store: GoalCompletionStore | undefined;
    try {
      const registration = parseRegistration(
        JSON.stringify(args),
        mutation === "revise",
      );
      store = new GoalCompletionStore(path);
      return await registerChatGoal(
        store,
        messages,
        sessionId,
        taint,
        registration,
        current,
      );
    } catch {
      return "Error: The approved goal registration is invalid, conflicting, or no longer current.";
    } finally {
      store?.close();
    }
  }
  if (
    Object.keys(args).some((key) =>
      !["action", "requestId", "before", "criterion"].includes(key)
    ) ||
    (action === "status"
      ? criterion !== undefined || before !== undefined ||
        (requestId !== undefined &&
          (typeof requestId !== "string" || !goalReference.test(requestId)))
      : action === "history"
      ? criterion !== undefined || requestId !== undefined ||
        (before !== undefined &&
          (typeof before !== "string" || !goalReference.test(before)))
      : action !== undefined || requestId !== undefined || before !== undefined)
  ) return unavailable;
  const store = new GoalCompletionStore(path);
  try {
    if (action === "history" || action === "status") {
      try {
        if (action === "history") {
          if (typeof before === "string") {
            const anchor = store.readRegistration(scope(sessionId), before);
            if (!anchor || !visibleRecord(anchor, taint)) return unavailable;
          }
          return JSON.stringify({
            ...describeRegistrationHistory(
              store,
              scope(sessionId),
              taint,
              before as string | undefined,
            ),
            _classification: taint,
          });
        }
        const registration = store.readRegistration(
          scope(sessionId),
          requestId as string | undefined,
        );
        if (!registration) return unavailable;
        return JSON.stringify({
          ...JSON.parse(describeRegistration(registration, taint)),
          _classification: taint,
        });
      } catch {
        return unavailable;
      }
    }
    if (criterion === undefined) {
      return describeRegistration(
        store.readRegistration(scope(sessionId)),
        taint,
      );
    }
    if (typeof criterion !== "string") throw new Error("Invalid criterion ID.");
    return await reportEvidence(
      store,
      messages,
      sessionId,
      taint,
      criterion,
      false,
    );
  } finally {
    store.close();
  }
}

async function reportEvidence(
  store: GoalCompletionStore,
  messages: MessageStore,
  sessionId: string,
  taint: ClassificationLevel,
  criterionId: string | undefined,
  confirm: boolean | {
    readonly requestId: string;
    readonly decisionSha256: string;
  },
  reauthorize?: () => Promise<boolean>,
): Promise<string> {
  const family = scope(sessionId);
  const exact = typeof confirm === "object" ? confirm : undefined;
  const registration = store.readRegistration(family, exact?.requestId);
  if (exact && !registration) throw new Error("Unknown goal registration");
  const goal = visibleRecord(registration, taint);
  if (confirm === true && registration && registration.requestId !== "legacy") {
    throw new Error(
      "Use /goal confirm <requestId> <decisionSha256> for this goal",
    );
  }
  if (!registration || !goal || (goal.status === "completed" && !exact)) {
    return describe(goal, registration);
  }
  const { afterSequence } = registration;
  if (
    criterionId !== undefined &&
    !goal.criteria.some((item) => item.id === criterionId)
  ) {
    throw new Error("Unknown criterion ID.");
  }
  const rules = new Set(goal.criteria.map((item) => item.requirement));
  const verified = new Map<string, string>();
  const latest = new Map<string, string>();
  const rows = goal.status === "completed"
    ? []
    : await messages.loadSession(sessionId);
  for (const row of rows) {
    if (
      row.role !== "tool_call" || !row.tool_name ||
      (afterSequence === undefined
        ? row.timestamp < goal.createdAt
        : row.sequence <= afterSequence) ||
      !canFlowTo(row.classification, taint) ||
      !goal.criteria.some((item) =>
        item.requirement?.startsWith(`${row.tool_name}:`)
      )
    ) {
      continue;
    }
    const rule = `${row.tool_name}:${await computeContentHash(row.content)}`;
    if (!rules.has(rule)) continue;
    verified.set(row.message_id, rule);
    latest.set(rule, row.message_id);
  }
  const observations = goal.criteria
    .filter((item) => item.id === criterionId)
    .flatMap((item) => {
      const rule = item.requirement;
      const reference = rule && (
        goal.observations.find((entry) => entry.criterionId === item.id)
          ?.evidence.find((entry) => verified.get(entry.reference) === rule)
          ?.reference ?? latest.get(rule)
      );
      return reference && rule
        ? [{
          criterionId: item.id,
          evidence: [{
            source: "chat_tool_result",
            reference,
            detail: rule,
          }],
        }]
        : [];
    });
  if (reauthorize && !await reauthorize()) {
    throw new Error("Owner goal approval is no longer current.");
  }
  const record = store.reportRegistration(
    family,
    registration.requestId,
    observations,
    (id, evidence) =>
      evidence.source === "chat_tool_result" &&
      evidence.detail === verified.get(evidence.reference) &&
      evidence.detail ===
        goal.criteria.find((item) => item.id === id)?.requirement,
    taint,
    !!confirm,
    exact?.decisionSha256,
  );
  return describe(record, registration);
}
