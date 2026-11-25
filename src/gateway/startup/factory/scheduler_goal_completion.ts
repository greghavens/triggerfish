import {
  backgroundGoalStateArgs,
  backgroundGoalStateTool,
  backgroundGoalUnavailable,
  projectBackgroundGoalState,
} from "./background_goal_state.ts";
import type { SchedulerExecutionIdentity } from "../../../scheduler/service_types.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import {
  findRecoveredGoalTrace,
  parseRecoveredGoalReport,
  readRecoveredGoalReport,
  recoveredGoalReportBinding,
  recoveredScheduledGoalUnavailable,
  scheduledGoalReportName,
} from "./recovered_goal_reporting.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Orchestrator } from "../../../core/types/orchestrator.ts";
import type { ToolDefinition } from "../../../core/types/tool.ts";
/** Bind operator-configured scheduler criteria to persisted tool results. */
import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import type { MessageStore } from "../../../core/conversation/mod.ts";
import {
  GoalCompletionStore,
  goalConfirmationDigest,
  type GoalEvidence,
  type GoalObservation,
  managedGoalClassification,
  type ManagedGoalTraceAccess,
} from "../../../core/goal_completion.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { createManagedGoalCommand } from "./managed_goal_command.ts";
import {
  parseManagedGoalCitation,
  parseManagedGoalTraceLocation,
  readScheduledGoalTrace,
  scheduledGoalTraceSource,
} from "./managed_goal_trace_evidence.ts";
import {
  reportPreparedSchedulerGoal,
  type SchedulerGoalCompletionBinding,
  type SchedulerGoalCompletionConfig,
  type SchedulerGoalSource,
  serializeSchedulerGoalReport,
} from "../../../scheduler/service_goal_completion.ts";

interface CriterionBinding extends SchedulerGoalCompletionBinding {
  readonly tool: string;
  readonly resultSha256: string;
  readonly requirement: string;
}

export interface SchedulerGoalController extends SchedulerGoalCompletionConfig {
  statusFromTurn(
    args: Record<string, unknown>,
    sessionId: string,
    authorization: SavedSourceAuthorization,
  ): Promise<string>;
  reportRecovered(
    args: Record<string, unknown>,
    execution: SchedulerExecutionIdentity,
    sessionId: string,
    authorization: SavedSourceAuthorization,
  ): Promise<string>;
  supportsReport(source: SchedulerGoalSource): boolean;
  reportFromTurn(
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<string>;
  wrap(
    orchestrator: Orchestrator,
    source: SchedulerGoalSource,
    sessionId: string,
  ): Orchestrator;
  readonly runCommand: ReturnType<typeof createManagedGoalCommand>;
}

export const scheduledGoalReportTool: ToolDefinition = {
  name: scheduledGoalReportName,
  description:
    "Report one configured criterion from a matching committed tool result in this scheduled turn.",
  parameters: {
    scope: {
      type: "string",
      description: "Configured scheduled goal scope",
      required: true,
    },
    criterion: {
      type: "string",
      description: "Exact configured criterion ID",
      required: true,
    },
    sourceCallId: {
      type: "string",
      description: "Committed batch:index slot for a recovered result",
    },
    requestId: {
      type: "string",
      description: "Unique UUID for a recovered evidence report",
    },
  },
};

function bindingKey(scope: string, criterionId: string): string {
  return JSON.stringify([scope, criterionId]);
}

const persistedReference = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/i;

export function buildSchedulerGoalCompletion(
  config: Pick<TriggerFishConfig, "scheduler">,
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
          criterion.tool === scheduledGoalReportTool.name ||
          criterion.tool === backgroundGoalStateTool.name ||
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
  function key(criterionId: string, evidence: GoalEvidence) {
    const { source, reference, detail, classification } = evidence;
    return JSON.stringify([
      criterionId,
      source,
      reference,
      detail,
      classification,
    ]);
  }

  async function prepareVerification(
    scope: string,
    observations: readonly GoalObservation[],
    request?: {
      ceiling: ClassificationLevel;
      access?: ManagedGoalTraceAccess;
    },
  ) {
    const goal = withStore((store) => store.read(scope));
    if (!goal || goal.status === "completed") return () => false;
    const loaded = new Map<
      string,
      Awaited<ReturnType<MessageStore["loadSession"]>>
    >();
    const verified = new Set<string>();
    const retained = new Set(
      goal.observations.flatMap(({ criterionId, evidence }) =>
        evidence.map((item) => key(criterionId, item))
      ),
    );
    for (
      const { criterionId, evidence } of [
        ...goal.observations,
        ...observations,
      ]
    ) {
      const rule = rules.get(bindingKey(scope, criterionId));
      if (!rule) continue;
      for (const item of evidence) {
        const { source, detail, reference, classification } = item;
        const proofKey = key(criterionId, item);
        if (source === scheduledGoalTraceSource(rule)) {
          const location = parseManagedGoalTraceLocation(
            reference,
            "scheduled",
          );
          if (
            goal.policy !== "operator" || !location ||
            detail !== rule.requirement || classification !== "INTERNAL"
          ) continue;
          if (request?.access) {
            const exact = await readScheduledGoalTrace(
              request.access,
              request.ceiling,
              rule,
              location,
              goal.createdAt,
            );
            if (exact && key(criterionId, exact) === proofKey) {
              verified.add(proofKey);
            }
          } else if (!request && retained.has(proofKey)) {
            // Automation can retain existing citations. Only owner-confirmed
            // proof reaches completion after current source reauthorization.
            verified.add(proofKey);
          }
          continue;
        }
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
          !row || (classification !== undefined &&
            classification !== row.classification) ||
          await computeContentHash(row.content) !== rule.resultSha256
        ) continue;
        verified.add(proofKey);
      }
    }
    return (criterionId: string, item: GoalEvidence) =>
      verified.has(key(criterionId, item));
  }

  const managedCommand = createManagedGoalCommand(
    "scheduler",
    () =>
      withStore((store) =>
        plans.map(({ scope }) => store.read(scope)).filter((goal) =>
          goal !== undefined
        )
      ),
    (scope) =>
      scopes.has(scope.slice("scheduler:".length))
        ? withStore((store) => store.read(scope))
        : undefined,
    async (scope, digest, ceiling, access) => {
      const verify = await prepareVerification(scope, [], { ceiling, access });
      if (
        access && (
          (access.reauthorizeDecision && !await access.reauthorizeDecision()) ||
          !access.current()
        )
      ) {
        throw new Error("The scheduled goal proof access is no longer current");
      }
      return withStore((store) =>
        store.confirmManagedDecision(scope, digest, verify, ceiling)
      );
    },
  );
  const activeTurn = new AsyncLocalStorage<
    SchedulerGoalSource & {
      sessionId: string;
      afterSequence: number;
      classification: ClassificationLevel;
      signal?: AbortSignal;
    }
  >();
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
      const {
        scope,
        criterionId,
        sessionId,
        classification,
        afterSequence,
        kind,
        sourceId,
      } = invocation;
      const rule = rules.get(bindingKey(scope, criterionId));
      const goal = withStore((store) => store.read(scope));
      if (
        !rule || rule.kind !== kind || rule.sourceId !== sourceId ||
        !goal || (goal.status === "completed" && afterSequence === undefined)
      ) return [];
      for (const row of (await messages.loadSession(sessionId)).toReversed()) {
        if (
          row.session_id === sessionId && row.role === "tool_call" &&
          row.tool_name === rule.tool && row.timestamp >= goal.createdAt &&
          (afterSequence === undefined || row.sequence > afterSequence) &&
          canFlowTo(row.classification, classification) &&
          rule.resultSha256 === await computeContentHash(row.content)
        ) {
          return [{
            reference: `${sessionId}:${row.message_id}`,
            detail: rule.requirement,
            classification: row.classification,
          }];
        }
      }
      return [];
    },
    prepareVerification,
    supportsReport(source) {
      return [...rules.values()].some((rule) =>
        rule.kind === source.kind && rule.sourceId === source.sourceId
      );
    },
    wrap(orchestrator, source, sessionId) {
      return {
        ...orchestrator,
        async executeAgentTurn(options) {
          if (options.session.id !== sessionId || options.toolPersistence) {
            return await orchestrator.executeAgentTurn(options);
          }
          let afterSequence: number;
          try {
            afterSequence = (await messages.loadSession(sessionId))
              .reduce((max, row) => Math.max(max, row.sequence), -1);
          } catch {
            return await orchestrator.executeAgentTurn(options);
          }
          return await activeTurn.run({
            ...source,
            sessionId,
            afterSequence,
            classification: options.targetClassification,
            signal: options.signal,
          }, () => orchestrator.executeAgentTurn(options));
        },
      };
    },
    async statusFromTurn(args, sessionId, authorization) {
      const invocation = activeTurn.getStore();
      const query = backgroundGoalStateArgs(args);
      if (
        !query || !invocation || invocation.sessionId !== sessionId ||
        invocation.signal?.aborted
      ) {
        return backgroundGoalUnavailable;
      }
      const scope = `scheduler:${query.scope}`;
      const record = withStore((store) => store.read(scope));
      if (!record) return backgroundGoalUnavailable;
      return await projectBackgroundGoalState({
        args: query,
        record,
        criteria: [...rules.values()].filter((rule) =>
          rule.scope === scope && rule.kind === invocation.kind &&
          rule.sourceId === invocation.sourceId
        ).map(({ criterionId, tool, resultSha256 }) => ({
          id: criterionId,
          tool,
          resultSha256,
        })),
        messages,
        sessionId,
        after: invocation.afterSequence,
        source: `scheduler:${invocation.kind}:${invocation.sourceId}`,
        ceiling: invocation.classification,
        current: () => !invocation.signal?.aborted,
        authorization,
      });
    },
    async reportFromTurn(args, sessionId) {
      const invocation = activeTurn.getStore();
      const { scope, criterion } = args;
      const unavailable = "Error: Scheduled goal criterion is unavailable.";
      if (
        !invocation || invocation.sessionId !== sessionId ||
        invocation.signal?.aborted || typeof scope !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,120}$/.test(scope) ||
        typeof criterion !== "string" || Object.keys(args).length !== 2
      ) return unavailable;
      const rule = rules.get(bindingKey(`scheduler:${scope}`, criterion));
      if (
        !rule || rule.kind !== invocation.kind ||
        rule.sourceId !== invocation.sourceId
      ) {
        return unavailable;
      }
      try {
        const [candidate] = await completion.readEvidence({
          ...invocation,
          ...rule,
        });
        if (!candidate || invocation.signal?.aborted) return unavailable;
        const evidence = {
          ...candidate,
          source: `scheduler:${rule.kind}:${rule.sourceId}`,
        };
        const record = await reportPreparedSchedulerGoal(
          completion,
          rule.scope,
          [{
            criterionId: criterion,
            evidence: [evidence],
          }],
          false,
          () => !invocation.signal?.aborted,
        );
        if (
          !record.observations.find(({ criterionId }) =>
            criterionId === criterion
          )
            ?.evidence.some((entry) =>
              key(criterion, entry) === key(criterion, evidence)
            ) ||
          invocation.signal?.aborted
        ) return unavailable;
        return JSON.stringify({
          scope,
          criterion,
          verified: true,
          evidenceReference: evidence.reference,
          _classification: evidence.classification,
        });
      } catch {
        return unavailable;
      }
    },
    async reportRecovered(args, execution, sessionId, authorization) {
      const request = parseRecoveredGoalReport(args);
      const unavailable = recoveredScheduledGoalUnavailable;
      if (
        !request || !execution.id.startsWith(`scheduler-${execution.kind}-`)
      ) return unavailable;
      const scope = `scheduler:${request.scope}`;
      const rule = rules.get(bindingKey(scope, request.criterion));
      if (
        !rule || rule.kind !== execution.kind ||
        rule.sourceId !== execution.sourceId
      ) {
        return unavailable;
      }
      const findSource = () =>
        findRecoveredGoalTrace(
          baseDir,
          {
            role: "scheduled",
            executionId: execution.id,
            sessionId,
            sourceId: execution.sourceId,
            callId: request.sourceCallId,
          },
          rule,
          authorization,
        );
      const read = () =>
        readRecoveredGoalReport(
          baseDir,
          execution.id,
          sessionId,
          args,
          "scheduler",
        );
      try {
        return await serializeSchedulerGoalReport(
          completion,
          scope,
          async () => {
            const goal = withStore((store) => store.read(scope));
            if (!goal || goal.policy !== "operator") return unavailable;
            const step = await findSource();
            if (!step || step.recordedAt < goal.createdAt) return unavailable;
            const evidence: GoalEvidence = {
              source: scheduledGoalTraceSource(rule),
              reference: `${execution.id}:${step.ordinal}:${step.id}`,
              detail: rule.requirement,
              classification: step.classification,
            };
            const replay = read();
            if (replay) {
              return JSON.parse(replay).evidenceReference === evidence.reference
                ? replay
                : unavailable;
            }
            const verify = await completion.prepareVerification(scope, []);
            if ((await findSource())?.id !== step.id) return unavailable;
            const exact = key(request.criterion, evidence);
            withStore((store) =>
              store.reportEvidenceSubmission(
                scope,
                [{ criterionId: request.criterion, evidence: [evidence] }],
                (criterionId, candidate) =>
                  key(criterionId, candidate) === exact ||
                  verify(criterionId, candidate),
                {
                  requestId: request.requestId,
                  binding: recoveredGoalReportBinding(
                    execution.id,
                    sessionId,
                    request,
                  ),
                  criterionId: request.criterion,
                  source: evidence.source,
                  reference: evidence.reference,
                },
              )
            );
            return read() ?? unavailable;
          },
        );
      } catch {
        return unavailable;
      }
    },
    async runCommand(command, ceiling = "PUBLIC", access) {
      if (!command.startsWith("/goal scheduler cite ")) {
        return await managedCommand(command, ceiling, access);
      }
      const citation = parseManagedGoalCitation(
        command.slice("/goal scheduler cite ".length),
        "scheduled",
      );
      const scope = `scheduler:${citation.scope}`;
      const rule = rules.get(bindingKey(scope, citation.criterion));
      const goal = withStore((store) => store.read(scope));
      const unavailable = "The exact scheduled goal evidence is unavailable";
      if (
        !goal || goal.policy !== "operator" || !rule || !access?.current() ||
        !canFlowTo(managedGoalClassification(goal), ceiling)
      ) {
        throw new Error(unavailable);
      }
      const evidence = await readScheduledGoalTrace(
        access,
        ceiling,
        rule,
        citation,
        goal.createdAt,
      );
      if (!evidence) throw new Error(unavailable);
      const observations = [{
        criterionId: citation.criterion,
        evidence: [evidence],
      }];
      const verify = await prepareVerification(scope, observations, {
        ceiling,
        access,
      });
      if (
        !access.current() ||
        (goal.status !== "completed" && !verify(citation.criterion, evidence))
      ) throw new Error(unavailable);
      const record = withStore((store) =>
        store.report(
          scope,
          observations,
          verify,
          false,
          goalConfirmationDigest(goal),
        )
      );
      if (
        !record.observations.some((entry) =>
          entry.criterionId === citation.criterion &&
          entry.evidence.some((item) =>
            key(entry.criterionId, item) === key(citation.criterion, evidence)
          )
        )
      ) throw new Error(unavailable);
      return await managedCommand(
        `/goal scheduler status ${citation.scope}`,
        ceiling,
        access,
      );
    },
  };
  return completion;
}
