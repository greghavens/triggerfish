/** Bind operator-configured scheduler criteria to persisted tool results. */
import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import type { MessageStore } from "../../../core/conversation/mod.ts";
import { GoalCompletionStore } from "../../../core/goal_completion.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import {
  reportPreparedSchedulerGoal,
  type SchedulerGoalCompletionBinding,
  type SchedulerGoalCompletionConfig,
} from "../../../scheduler/service_goal_completion.ts";

interface CriterionBinding extends SchedulerGoalCompletionBinding {
  readonly tool: string;
  readonly resultSha256: string;
  readonly requirement: string;
}

interface SchedulerGoalController extends SchedulerGoalCompletionConfig {
  readonly runCommand: (command: string) => Promise<string>;
}

function bindingKey(scope: string, criterionId: string): string {
  return JSON.stringify([scope, criterionId]);
}

const persistedReference = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/i;

export function buildSchedulerGoalCompletion(
  config: TriggerFishConfig,
  baseDir: string,
  messages: MessageStore,
): SchedulerGoalController | undefined {
  const settings = config.scheduler?.goal_completion;
  if (settings === undefined) return undefined;
  if (!Array.isArray(settings)) {
    throw new Error("Expected scheduler goal completion to be an array.");
  }
  if (!settings.length) return undefined;
  const goalsPath = join(baseDir, "goal-completion.db");
  const rules = new Map<string, CriterionBinding>();
  const scopes = new Set<string>();
  const plans = settings.map((plan) => {
    if (
      !plan || typeof plan.scope !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,120}$/.test(plan.scope) ||
      scopes.has(plan.scope) || !Array.isArray(plan.criteria)
    ) throw new Error("Invalid configured scheduler goal.");
    scopes.add(plan.scope);
    const scope = `scheduler:${plan.scope}`;
    return {
      scope,
      goal: plan.goal,
      policy: plan.policy,
      criteria: plan.criteria.map((
        criterion: NonNullable<
          NonNullable<TriggerFishConfig["scheduler"]>["goal_completion"]
        >[number]["criteria"][number],
      ) => {
        if (
          !criterion ||
          !["cron", "trigger", "webhook"].includes(criterion.kind) ||
          typeof criterion.source_id !== "string" ||
          !/^[A-Za-z0-9_.-]{1,96}$/.test(criterion.source_id) ||
          (criterion.kind === "trigger" && criterion.source_id !== "trigger") ||
          (criterion.kind === "webhook" &&
            !Object.hasOwn(
              config.scheduler?.webhooks?.sources ?? {},
              criterion.source_id,
            )) ||
          typeof criterion.tool !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(criterion.tool) ||
          typeof criterion.result_sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(criterion.result_sha256)
        ) throw new Error("Invalid configured scheduler goal criterion.");
        const { id, description, kind, source_id, tool, result_sha256 } =
          criterion;
        const requirement = `${kind}:${source_id}:${tool}:${result_sha256}`;
        const key = bindingKey(scope, id);
        if (rules.has(key)) {
          throw new Error("Duplicate scheduler goal criterion.");
        }
        rules.set(key, {
          scope,
          criterionId: id,
          kind,
          sourceId: source_id,
          tool,
          resultSha256: result_sha256,
          requirement,
        });
        return { id, description, requirement };
      }),
    };
  });
  function withStore<T>(operation: (store: GoalCompletionStore) => T): T {
    const store = new GoalCompletionStore(goalsPath);
    try {
      return operation(store);
    } finally {
      store.close();
    }
  }
  withStore((store) => {
    for (const { scope, goal, criteria, policy } of plans) {
      store.register(scope, goal, criteria, policy);
    }
  });
  const completion: SchedulerGoalController = {
    bindings: [...rules.values()],
    store: {
      report(scope, observations, verify, operatorConfirmed) {
        return withStore((store) =>
          store.report(scope, observations, verify, operatorConfirmed)
        );
      },
    },
    async readEvidence(invocation) {
      const { scope, criterionId, sessionId, classification } = invocation;
      const rule = rules.get(bindingKey(scope, criterionId));
      const goal = withStore((store) => store.read(scope));
      if (!rule || !goal || goal.status === "completed") return [];
      for (const row of (await messages.loadSession(sessionId)).toReversed()) {
        if (
          row.session_id === sessionId && row.role === "tool_call" &&
          row.tool_name === rule.tool && row.timestamp >= goal.createdAt &&
          canFlowTo(row.classification, classification) &&
          rule.resultSha256 === await computeContentHash(row.content)
        ) {
          return [{
            reference: `${sessionId}:${row.message_id}`,
            detail: rule.requirement,
          }];
        }
      }
      return [];
    },
    async prepareVerification(scope, observations) {
      const goal = withStore((store) => store.read(scope));
      if (!goal || goal.status === "completed") return () => false;
      const loaded = new Map<
        string,
        Awaited<ReturnType<MessageStore["loadSession"]>>
      >();
      const verified = new Map<string, Set<string>>();
      for (
        const { criterionId, evidence } of [
          ...goal.observations,
          ...observations,
        ]
      ) {
        const rule = rules.get(bindingKey(scope, criterionId));
        if (!rule) continue;
        for (const item of evidence) {
          const { source, detail, reference } = item;
          const match = persistedReference.exec(reference);
          if (
            !match || detail !== rule.requirement ||
            source !== `scheduler:${rule.kind}:${rule.sourceId}`
          ) continue;
          const [, sessionId, messageId] = match;
          let rows = loaded.get(sessionId);
          if (!rows) {
            rows = await messages.loadSession(sessionId);
            loaded.set(sessionId, rows);
          }
          const row = rows.find((entry) =>
            entry.message_id === messageId && entry.session_id === sessionId &&
            entry.role === "tool_call" && entry.tool_name === rule.tool &&
            entry.timestamp >= goal.createdAt
          );
          if (
            !row || await computeContentHash(row.content) !== rule.resultSha256
          ) continue;
          const ids = verified.get(criterionId) ?? new Set<string>();
          ids.add(JSON.stringify([source, reference, detail]));
          verified.set(criterionId, ids);
        }
      }
      return (criterionId, { source, reference, detail }) =>
        verified.get(criterionId)?.has(
          JSON.stringify([source, reference, detail]),
        ) === true;
    },
    async runCommand(command: string) {
      const action =
        /^\/goal scheduler (status|confirm) ([A-Za-z0-9_.:-]{1,120})$/.exec(
          command,
        );
      if (!action) {
        return "Usage: /goal scheduler status <scope> or /goal scheduler confirm <scope>";
      }
      const [, verb, name] = action;
      if (!scopes.has(name)) {
        throw new Error("Unknown configured scheduler goal.");
      }
      const scope = `scheduler:${name}`;
      return JSON.stringify(
        verb === "confirm"
          ? await reportPreparedSchedulerGoal(completion, scope, [], true)
          : withStore((store) => store.read(scope)) ?? null,
      );
    },
  };
  return completion;
}
