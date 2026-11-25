/** Owner-chat goal registration and evidence reporting. */
import type { MessageStore } from "../core/conversation/mod.ts";
import {
  type GoalCompletionRecord,
  GoalCompletionStore,
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

function scope(sessionId: string): string {
  return `chat:${sessionId}`;
}

function parseRegistration(text: string) {
  const input = JSON.parse(text);
  if (
    !input || typeof input.goal !== "string" ||
    !["automatic", "operator"].includes(input.policy) ||
    !Array.isArray(input.criteria)
  ) {
    throw new Error("Expected goal, policy, and criteria.");
  }
  return {
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
  try {
    if (command.startsWith("/goal register ")) {
      const input = parseRegistration(command.slice("/goal register ".length));
      return describe(store.register(
        scope(sessionId),
        input.goal,
        input.criteria,
        input.policy,
      ));
    }
    if (command === "/goal status") {
      return describe(store.read(scope(sessionId)));
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
    return "Usage: /goal register <JSON>, /goal status, /goal confirm";
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
      return describe(store.read(scope(sessionId)));
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
  const key = scope(sessionId);
  const goal = store.read(key);
  if (!goal || goal.status === "completed") return describe(goal);
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
      row.timestamp < goal.createdAt || !canFlowTo(row.classification, taint) ||
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
  return describe(store.report(
    key,
    observations,
    (id, evidence) =>
      evidence.source === "chat_tool_result" &&
      evidence.detail === verified.get(evidence.reference) &&
      evidence.detail ===
        goal.criteria.find((item) => item.id === id)?.requirement,
    confirm,
  ));
}
