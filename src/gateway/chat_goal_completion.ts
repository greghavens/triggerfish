/** Owner-chat goal registration and evidence reporting. */
import type { MessageStore } from "../core/conversation/mod.ts";
import {
  type GoalCompletionRecord,
  GoalCompletionStore,
  goalConfirmationDigest,
  type GoalRegistration,
  summarizeGoalCriteria,
} from "../core/goal_completion.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import { computeContentHash } from "../core/session/lineage_serde.ts";
import type { ToolDefinition } from "../core/types/tool.ts";

export const CHAT_GOAL_REPORT_TOOL: ToolDefinition = {
  name: "goal_report",
  description:
    "Report acceptance criteria using matching tool results already saved in this chat. Returns the decision and open criteria. Omit criterion to inspect status.",
  parameters: {
    criterion: { type: "string", description: "Acceptance criterion ID" },
  },
};

export const MANAGED_GOAL_STATE_TOOL: ToolDefinition = {
  name: "managed_goal_state",
  description:
    "Read configured scheduled or delegated goals in the current owner classification. List visible scopes or inspect one exact scope and its saved decision. Operators confirm using the separate /goal command.",
  parameters: {
    role: {
      type: "string",
      description: "Configured goal role",
      required: true,
      enum: ["scheduler", "delegated"],
    },
    action: {
      type: "string",
      description: "List goal scopes or read an exact goal's current status",
      required: true,
      enum: ["list", "status"],
    },
    scope: { type: "string", description: "Exact scope for status" },
    afterScope: { type: "string", description: "List page cursor" },
  },
};

/** Translate one validated root read into the same backend used by owner chat. */
export async function readManagedChatGoal(
  runCommand: (
    command: string,
    taint: ClassificationLevel,
  ) => Promise<string | undefined>,
  args: Record<string, unknown>,
  taint: ClassificationLevel,
): Promise<string> {
  const { role, action, scope, afterScope } = args;
  const key = /^[A-Za-z0-9_.:-]{1,120}$/;
  const unavailable = "Error: Managed goal state is unavailable.";
  if (
    (role !== "scheduler" && role !== "delegated") ||
    Object.keys(args).some((field) =>
      !Object.hasOwn(MANAGED_GOAL_STATE_TOOL.parameters, field)
    ) ||
    (action === "status"
      ? typeof scope !== "string" || !key.test(scope) ||
        afterScope !== undefined
      : action !== "list" || scope !== undefined ||
        (afterScope !== undefined &&
          (typeof afterScope !== "string" || !key.test(afterScope))))
  ) return "Error: Select a managed goal role and a valid list or status read.";
  const suffix = action === "status" ? scope : afterScope;
  try {
    const result = await runCommand(
      `/goal ${role} ${action}${suffix ? ` ${suffix}` : ""}`,
      taint,
    );
    if (!result) return unavailable;
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
      const rows = await messages.loadSession(sessionId);
      const afterSequence = rows.reduce(
        (highest, { sequence }) => Math.max(highest, sequence),
        0,
      );
      return describeRegistration(
        store.registerSuccessive(
          family,
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
    const status = command.match(/^\/goal status(?: (\S+))?$/);
    if (status) {
      return describeRegistration(
        store.readRegistration(family, status[1]),
        taint,
      );
    }
    const history = command.match(/^\/goal history(?: (\S+))?$/);
    if (history) {
      const page = store.registrationHistory(family, history[1]);
      for (const registration of page.registrations) {
        visibleRecord(registration, taint);
      }
      return JSON.stringify({
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
      });
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

/** An agent may propose evidence, while operator confirmation stays in chat. */
export async function reportChatGoal(
  path: string,
  messages: MessageStore,
  sessionId: string,
  taint: ClassificationLevel,
  criterion: unknown,
): Promise<string> {
  const store = new GoalCompletionStore(path);
  try {
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
