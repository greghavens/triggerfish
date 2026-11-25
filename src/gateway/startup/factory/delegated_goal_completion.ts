/** Bind delegated goal criteria to tool results recorded during the exact turn. */
import { join } from "@std/path";
import type { MessageStore } from "../../../core/conversation/mod.ts";
import type { ConversationRecord } from "../../../core/conversation/conversation_types.ts";
import type {
  DelegatedAgentKind,
  DelegatedGoalConfig,
} from "../../../core/delegated_goal_config.ts";
import {
  GoalCompletionStore,
  type GoalEvidence,
  type GoalObservation,
} from "../../../core/goal_completion.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import type { Orchestrator } from "../../../core/types/orchestrator.ts";
import { createManagedGoalCommand } from "./managed_goal_command.ts";

const log = createLogger("delegated-goal-completion");
const referencePattern = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/i;

function parsePlans(settings: readonly DelegatedGoalConfig[]) {
  if (!Array.isArray(settings) || settings.length > 32) {
    throw new Error("Invalid configured delegated goals");
  }
  const scopes = new Set<string>();
  return Array.from(settings, (plan: DelegatedGoalConfig) => {
    if (
      !plan || typeof plan.scope !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,120}$/.test(plan.scope) ||
      scopes.has(plan.scope) || !Array.isArray(plan.criteria)
    ) {
      throw new Error("Invalid configured delegated goal");
    }
    scopes.add(plan.scope);
    return {
      scope: `delegated:${plan.scope}`,
      goal: plan.goal,
      policy: plan.policy,
      criteria: Array.from(
        plan.criteria,
        (criterion: DelegatedGoalConfig["criteria"][number]) => {
          if (
            !criterion ||
            (criterion.kind !== "subagent" && criterion.kind !== "team") ||
            typeof criterion.tool !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(criterion.tool) ||
            typeof criterion.result_sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(criterion.result_sha256)
          ) {
            throw new Error("Invalid configured delegated goal criterion");
          }
          const { id, description, kind, tool, result_sha256 } = criterion;
          const requirement = `${kind}:${tool}:${result_sha256}`;
          return { id, description, kind, tool, result_sha256, requirement };
        },
      ),
    };
  });
}

function evidenceKey(criterionId: string, evidence: GoalEvidence) {
  return JSON.stringify([
    criterionId,
    evidence.source,
    evidence.reference,
    evidence.detail,
    evidence.classification,
  ]);
}

export function buildDelegatedGoalCompletion(
  baseDir: string,
  settings: readonly DelegatedGoalConfig[] | undefined,
  messages: MessageStore | undefined,
) {
  if (settings === undefined) return undefined;
  const plans = parsePlans(settings);
  if (!plans.length) return undefined;
  if (!messages) {
    throw new Error("Delegated goals require persisted tool evidence");
  }
  const path = join(baseDir, "goal-completion.db");
  const lockPath = join(baseDir, "delegated-goal-completion.lock");
  const withStore = <T>(action: (store: GoalCompletionStore) => T): T => {
    const store = new GoalCompletionStore(path);
    try {
      return action(store);
    } finally {
      store.close();
    }
  };
  withStore((store) => {
    for (const { scope, goal, criteria, policy } of plans) {
      store.register(scope, goal, criteria, policy);
    }
  });

  type Invocation = {
    readonly kind: DelegatedAgentKind;
    readonly sessionId: string;
    readonly classification: Parameters<
      Orchestrator["executeAgentTurn"]
    >[0]["targetClassification"];
    readonly after: number;
  };

  async function withLock<T>(action: () => Promise<T>): Promise<T> {
    using lock = await Deno.open(lockPath, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    await lock.lock(true);
    return await action();
  }

  async function reportScope(
    plan: typeof plans[number],
    invocation?: Invocation,
    confirmation?: {
      digest: string;
      ceiling: ClassificationLevel;
    },
  ) {
    const current = invocation
      ? await messages!.loadSession(invocation.sessionId)
      : [];
    const loaded = new Map<string, readonly ConversationRecord[]>();
    if (invocation) loaded.set(invocation.sessionId, current);
    const digests = new Map<string, string>();
    const record = withStore((store) => store.read(plan.scope));
    if (!record) return;
    if (record.status === "completed") {
      return confirmation
        ? withStore((store) =>
          store.confirmManagedDecision(
            plan.scope,
            confirmation.digest,
            () => false,
            confirmation.ceiling,
          )
        )
        : record;
    }
    const verified = new Set<string>();
    const supplied: GoalObservation[] = [];
    for (const criterion of plan.criteria) {
      const source = `delegated:${criterion.kind}`;
      const matches = async (row: ConversationRecord | undefined) => {
        if (
          !row || row.role !== "tool_call" ||
          row.tool_name !== criterion.tool ||
          row.timestamp < record.createdAt
        ) return false;
        const rowKey = `${row.session_id}:${row.message_id}`;
        let digest = digests.get(rowKey);
        if (!digest) {
          digest = await computeContentHash(row.content);
          digests.set(rowKey, digest);
        }
        return digest === criterion.result_sha256;
      };
      const old = record.observations.find(({ criterionId }) =>
        criterionId === criterion.id
      );
      for (const evidence of old?.evidence ?? []) {
        const reference = referencePattern.exec(evidence.reference);
        if (
          !reference || evidence.source !== source ||
          evidence.detail !== criterion.requirement
        ) continue;
        const [, evidenceSession, messageId] = reference;
        let rows = loaded.get(evidenceSession);
        if (!rows) {
          rows = await messages!.loadSession(evidenceSession);
          loaded.set(evidenceSession, rows);
        }
        const row = rows.find(({ session_id, message_id }) =>
          session_id === evidenceSession && message_id === messageId
        );
        if (
          (evidence.classification === undefined ||
            evidence.classification === row?.classification) &&
          await matches(row)
        ) {
          verified.add(evidenceKey(criterion.id, evidence));
        }
      }
      if (
        old?.evidence.some((evidence) =>
          verified.has(evidenceKey(criterion.id, evidence))
        ) ||
        criterion.kind !== invocation?.kind
      ) continue;
      for (const row of current.toReversed()) {
        if (
          row.session_id !== invocation?.sessionId ||
          row.sequence <= invocation.after ||
          !canFlowTo(row.classification, invocation.classification) ||
          !await matches(row)
        ) continue;
        const evidence = {
          source,
          reference: `${row.session_id}:${row.message_id}`,
          detail: criterion.requirement,
          classification: row.classification,
        };
        verified.add(evidenceKey(criterion.id, evidence));
        supplied.push({ criterionId: criterion.id, evidence: [evidence] });
        break;
      }
    }
    const verify = (criterionId: string, evidence: GoalEvidence) =>
      verified.has(evidenceKey(criterionId, evidence));
    return withStore((store) =>
      confirmation
        ? store.confirmManagedDecision(
          plan.scope,
          confirmation.digest,
          verify,
          confirmation.ceiling,
        )
        : store.report(plan.scope, supplied, verify)
    );
  }

  function report(invocation: Invocation) {
    return withLock(async () => {
      for (const plan of plans) {
        if (plan.criteria.some(({ kind }) => kind === invocation.kind)) {
          await reportScope(plan, invocation);
        }
      }
    });
  }

  return {
    runCommand: createManagedGoalCommand(
      "delegated",
      () =>
        withStore((store) =>
          plans.map(({ scope }) => store.read(scope)).filter((goal) =>
            goal !== undefined
          )
        ),
      (scope) =>
        plans.some((plan) => plan.scope === scope)
          ? withStore((store) => store.read(scope))
          : undefined,
      (scope, digest, ceiling) =>
        withLock(async () => {
          const plan = plans.find((plan) => plan.scope === scope);
          const record = plan &&
            await reportScope(plan, undefined, { digest, ceiling });
          if (!record) throw new Error("Unknown configured delegated goal");
          return record;
        }),
    ),

    wrap(
      orchestrator: Orchestrator,
      kind: DelegatedAgentKind,
      sessionId: string,
    ): Orchestrator {
      if (
        !plans.some(({ criteria }) =>
          criteria.some((entry) => entry.kind === kind)
        )
      ) return orchestrator;
      let previous = Promise.resolve();
      return {
        ...orchestrator,
        executeAgentTurn(options) {
          if (options.session.id !== sessionId) {
            return orchestrator.executeAgentTurn(options);
          }
          const turn = previous.then(async () => {
            let after: number | undefined;
            try {
              after = (await messages.loadSession(sessionId)).reduce(
                (max, row) => Math.max(max, row.sequence),
                -1,
              );
            } catch {
              log.warn("Delegated goal evidence boundary could not be read");
            }
            const result = await orchestrator.executeAgentTurn(options);
            if (after !== undefined && !options.signal?.aborted) {
              try {
                await report({
                  kind,
                  sessionId,
                  classification: options.targetClassification,
                  after,
                });
              } catch {
                log.warn("Delegated goal evidence could not be committed");
              }
            }
            return result;
          });
          previous = turn.then(() => {}, () => {});
          return turn;
        },
      };
    },
  };
}
