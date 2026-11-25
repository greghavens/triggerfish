/** Owner-chat goal registration and evidence reporting. */
import type { MessageStore } from "../core/conversation/mod.ts";
import {
  type GoalCompletionRecord,
  GoalCompletionStore,
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

function describe(record: GoalCompletionRecord | undefined): string {
  return JSON.stringify(
    record
      ? { ...record, criterionStatus: summarizeGoalCriteria(record) }
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

function scope(sessionId: string): string {
  return `chat:${sessionId}`;
}

function parseRegistration(text: string) {
  const input = JSON.parse(text);
  if (
    !input || typeof input.goal !== "string" ||
    !["automatic", "operator"].includes(input.policy) ||
    !Array.isArray(input.criteria) ||
    (input.requestId !== undefined && typeof input.requestId !== "string")
  ) {
    throw new Error("Expected goal, policy, and criteria.");
  }
  return {
    requestId: input.requestId as string | undefined,
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
    if (command.startsWith("/goal register ")) {
      const input = parseRegistration(command.slice("/goal register ".length));
      const rows = await messages.loadSession(sessionId);
      const afterSequence = rows.reduce(
        (highest, { sequence }) => Math.max(highest, sequence),
        0,
      );
      return describe(
        store.registerSuccessive(
          family,
          input.requestId,
          input.goal,
          input.criteria,
          input.policy,
          afterSequence,
          taint,
        ).record,
      );
    }
    const status = command.match(/^\/goal status(?: (\S+))?$/);
    if (status) {
      return describe(
        visibleRecord(store.readRegistration(family, status[1]), taint),
      );
    }
    const history = command.match(/^\/goal history(?: (\S+))?$/);
    if (history) {
      const page = store.registrationHistory(family, history[1]);
      for (const registration of page.registrations) {
        visibleRecord(registration, taint);
      }
      return JSON.stringify({
        registrations: page.registrations.map(({ requestId, record }) => ({
          requestId,
          goal: record.goal,
          status: record.status,
          createdAt: record.createdAt,
          ...(record.completedAt && { completedAt: record.completedAt }),
        })),
        nextBefore: page.nextBefore,
      });
    }
    if (command === "/goal confirm") {
      return await reportEvidence(
        store,
        messages,
        sessionId,
        taint,
        undefined,
        true,
      );
    }
    return "Usage: /goal register <JSON> (successors need a UUID requestId), " +
      "/goal status [requestId|legacy], /goal history [before], /goal confirm";
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
      return describe(
        visibleRecord(store.readRegistration(scope(sessionId)), taint),
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
  confirm: boolean,
): Promise<string> {
  const family = scope(sessionId);
  const registration = store.readRegistration(family);
  const goal = visibleRecord(registration, taint);
  if (!registration || !goal || goal.status === "completed") {
    return describe(goal);
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
  for (const row of await messages.loadSession(sessionId)) {
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
  return describe(store.reportRegistration(
    family,
    registration.requestId,
    observations,
    (id, evidence) =>
      evidence.source === "chat_tool_result" &&
      evidence.detail === verified.get(evidence.reference) &&
      evidence.detail ===
        goal.criteria.find((item) => item.id === id)?.requirement,
    taint,
    confirm,
  ));
}
