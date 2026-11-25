import {
  backgroundGoalStateArgs,
  backgroundGoalStateTool,
  backgroundGoalUnavailable,
  projectBackgroundGoalState,
} from "./background_goal_state.ts";
import { type TeamObservationSource } from "../../../core/config_types.ts";
import type { SessionId } from "../../../core/types/session.ts";
import {
  delegatedSubagentSessionId,
  teamDeliveryExecutionId,
  teamDeliveryTraceSource,
} from "./delegated_agent_recovery.ts";
import type { SavedSourceAuthorization } from "../../../core/types/orchestrator.ts";
import {
  delegatedGoalReportName,
  findRecoveredGoalTrace,
  parseRecoveredGoalReport,
  readRecoveredGoalReport,
  recoveredGoalReportBinding,
  recoveredGoalUnavailable,
} from "./recovered_goal_reporting.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolDefinition } from "../../../core/types/tool.ts";
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
  goalConfirmationDigest,
  type GoalEvidence,
  type GoalObservation,
  managedGoalClassification,
  type ManagedGoalTraceAccess,
} from "../../../core/goal_completion.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import { computeContentHash } from "../../../core/session/lineage_serde.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import type { Orchestrator } from "../../../core/types/orchestrator.ts";
import { createManagedGoalCommand } from "./managed_goal_command.ts";
import {
  delegatedGoalTraceSource,
  delegatedTeamGoalId,
  delegatedTeamGoalTraceSource,
  parseManagedGoalCitation,
  parseManagedGoalTraceLocation,
  readDelegatedGoalTrace,
} from "./managed_goal_trace_evidence.ts";

const log = createLogger("delegated-goal-completion");
const referencePattern = /^([a-f0-9-]{36}):([a-f0-9-]{36})$/i;

export const delegatedGoalReportTool: ToolDefinition = {
  name: delegatedGoalReportName,
  description:
    "Report one configured goal criterion using a matching committed tool result from this delegated turn.",
  parameters: {
    scope: {
      type: "string",
      description: "Configured delegated goal scope",
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

type RecoveredGoalSource = {
  readonly kind: "subagent";
  readonly parentSessionId: string;
} | {
  readonly kind: "team";
  readonly source: TeamObservationSource;
  readonly authorizeScope: () => Promise<boolean>;
};

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
            criterion.tool === delegatedGoalReportTool.name ||
            criterion.tool === backgroundGoalStateTool.name ||
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
    readonly signal?: AbortSignal;
  };
  const activeTurn = new AsyncLocalStorage<Invocation>();

  type OperatorProof =
    & {
      readonly ceiling: ClassificationLevel;
      readonly access?: ManagedGoalTraceAccess;
    }
    & (
      | { kind: "confirm"; digest: string }
      | { kind: "inspect" }
      | { kind: "cite"; target: ReturnType<typeof parseManagedGoalCitation> }
    );

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
    operator?: OperatorProof,
    selectedCriterion?: string,
    recovered?: {
      readonly proof: GoalEvidence;
      readonly requestId: string;
      readonly binding: string;
      readonly reauthorize: () => Promise<boolean>;
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
    const unavailable = "The exact delegated goal evidence is unavailable";
    const verified = new Set<string>();
    const supplied: GoalObservation[] = [];
    let citedProof: string | undefined;
    if (operator?.kind === "cite") {
      const { target, access, ceiling } = operator;
      const criterion = plan.criteria.find(({ id }) => id === target.criterion);
      if (
        criterion?.kind !==
          (target.teamId === undefined ? "subagent" : "team") ||
        record.policy !== "operator" ||
        !access || !canFlowTo(managedGoalClassification(record), ceiling)
      ) throw new Error(unavailable);
      const evidence = await readDelegatedGoalTrace(
        access,
        ceiling,
        {
          tool: criterion.tool,
          resultSha256: criterion.result_sha256,
          requirement: criterion.requirement,
        },
        target,
        record.createdAt,
      );
      if (!evidence || !access.current()) throw new Error(unavailable);
      const key = evidenceKey(criterion.id, evidence);
      citedProof = key;
      if (
        record.status === "completed" &&
        !record.observations.some((entry) =>
          entry.criterionId === criterion.id &&
          entry.evidence.some((item) => evidenceKey(criterion.id, item) === key)
        )
      ) throw new Error(unavailable);
      verified.add(key);
      supplied.push({ criterionId: criterion.id, evidence: [evidence] });
    }
    if (record.status === "completed") {
      return operator?.kind === "confirm"
        ? withStore((store) =>
          store.confirmManagedDecision(
            plan.scope,
            operator.digest,
            () => false,
            operator.ceiling,
          )
        )
        : record;
    }
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
        const teamId = delegatedTeamGoalId(evidence.source);
        if (
          evidence.source === delegatedGoalTraceSource || teamId !== undefined
        ) {
          const location = parseManagedGoalTraceLocation(
            evidence.reference,
            "delegated",
          );
          if (
            criterion.kind !== (teamId === undefined ? "subagent" : "team") ||
            record.policy !== "operator" ||
            evidence.detail !== criterion.requirement ||
            evidence.classification !== "INTERNAL" || !location
          ) continue;
          const key = evidenceKey(criterion.id, evidence);
          if (verified.has(key)) continue;
          if (!operator) {
            // A background report can retain a pending archive citation.
            // Completion still requires an owner to reauthorize the receipt.
            verified.add(key);
            continue;
          }
          if (!operator.access) continue;
          const reopened = await readDelegatedGoalTrace(
            operator.access,
            operator.ceiling,
            {
              tool: criterion.tool,
              resultSha256: criterion.result_sha256,
              requirement: criterion.requirement,
            },
            { ...location, ...(teamId !== undefined && { teamId }) },
            record.createdAt,
          );
          if (reopened && evidenceKey(criterion.id, reopened) === key) {
            verified.add(key);
          }
          continue;
        }
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
        criterion.kind !== invocation?.kind ||
        (selectedCriterion !== undefined && selectedCriterion !== criterion.id)
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
    if (recovered && selectedCriterion) {
      if (!await recovered.reauthorize()) return;
      verified.add(evidenceKey(selectedCriterion, recovered.proof));
      supplied.push({
        criterionId: selectedCriterion,
        evidence: [recovered.proof],
      });
    }
    const verify = (criterionId: string, evidence: GoalEvidence) =>
      verified.has(evidenceKey(criterionId, evidence));
    if (
      operator?.access && (
        (operator.kind === "confirm" && operator.access.reauthorizeDecision &&
          !await operator.access.reauthorizeDecision()) ||
        !operator.access.current()
      )
    ) {
      throw new Error(unavailable);
    }
    if (invocation?.signal?.aborted) return;
    if (operator?.kind === "inspect") {
      return {
        ...record,
        observations: record.observations.map(({ criterionId, evidence }) => ({
          criterionId,
          evidence: evidence.filter((item) => verify(criterionId, item)),
        })),
      };
    }
    const decision = withStore((store) => {
      if (recovered && selectedCriterion) {
        store.reportEvidenceSubmission(
          plan.scope,
          supplied,
          verify,
          {
            requestId: recovered.requestId,
            binding: recovered.binding,
            criterionId: selectedCriterion,
            source: recovered.proof.source,
            reference: recovered.proof.reference,
          },
        );
        return store.read(plan.scope);
      }
      return operator?.kind === "confirm"
        ? store.confirmManagedDecision(
          plan.scope,
          operator.digest,
          verify,
          operator.ceiling,
        )
        : store.report(
          plan.scope,
          supplied,
          verify,
          false,
          operator?.kind === "cite"
            ? goalConfirmationDigest(record)
            : undefined,
        );
    });
    if (
      citedProof &&
      !decision?.observations.some(({ criterionId, evidence }) =>
        evidence.some((item) => evidenceKey(criterionId, item) === citedProof)
      )
    ) throw new Error(unavailable);
    return decision;
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

  const managedCommand = createManagedGoalCommand(
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
    (scope, digest, ceiling, access) =>
      withLock(async () => {
        const plan = plans.find((plan) => plan.scope === scope);
        const record = plan &&
          await reportScope(plan, undefined, {
            kind: "confirm",
            digest,
            ceiling,
            access,
          });
        if (!record) throw new Error("Unknown configured delegated goal");
        return record;
      }),
    async (record, ceiling, access) => {
      const plan = plans.find(({ scope }) => scope === record.scope);
      const reviewed = plan && await reportScope(plan, undefined, {
        kind: "inspect",
        ceiling,
        access,
      });
      const verified = new Set(
        reviewed?.observations.flatMap(({ criterionId, evidence }) =>
          evidence.map((item) => evidenceKey(criterionId, item))
        ),
      );
      return (criterionId, evidence) =>
        verified.has(evidenceKey(criterionId, evidence));
    },
  );

  return {
    supportsReport(kind: DelegatedAgentKind) {
      return plans.some(({ criteria }) =>
        criteria.some((entry) => entry.kind === kind)
      );
    },
    async statusFromTurn(
      args: Record<string, unknown>,
      sessionId: string,
      authorization: SavedSourceAuthorization,
    ) {
      const invocation = activeTurn.getStore();
      const query = backgroundGoalStateArgs(args);
      if (
        !query || !invocation || invocation.sessionId !== sessionId ||
        invocation.signal?.aborted
      ) {
        return backgroundGoalUnavailable;
      }
      const scope = `delegated:${query.scope}`;
      const plan = plans.find((entry) => entry.scope === scope);
      const record = plan && withStore((store) => store.read(scope));
      if (!plan || !record) return backgroundGoalUnavailable;
      return await projectBackgroundGoalState({
        args: query,
        record,
        criteria: plan.criteria.filter(({ kind }) => kind === invocation.kind)
          .map(({ id, tool, result_sha256 }) => ({
            id,
            tool,
            resultSha256: result_sha256,
          })),
        messages: messages!,
        sessionId,
        after: invocation.after,
        source: `delegated:${invocation.kind}`,
        ceiling: invocation.classification,
        current: () => !invocation.signal?.aborted,
        authorization,
      });
    },
    async reportFromTurn(
      args: Record<string, unknown>,
      sessionId: string,
    ) {
      const invocation = activeTurn.getStore();
      const { scope, criterion } = args;
      const unavailable = "Error: Delegated goal criterion is unavailable.";
      if (
        !invocation || invocation.sessionId !== sessionId ||
        invocation.signal?.aborted ||
        typeof scope !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(scope) ||
        typeof criterion !== "string" || Object.keys(args).length !== 2
      ) return unavailable;
      const plan = plans.find((candidate) =>
        candidate.scope === `delegated:${scope}` &&
        candidate.criteria.some(({ id, kind }) =>
          id === criterion && kind === invocation.kind
        )
      );
      if (!plan) return unavailable;
      try {
        return await withLock(async () => {
          if (invocation.signal?.aborted) return unavailable;
          const record = await reportScope(
            plan,
            invocation,
            undefined,
            criterion,
          );
          if (!record || invocation.signal?.aborted) return unavailable;
          const evidence = record.observations.find(({ criterionId }) =>
            criterionId === criterion
          )?.evidence.find((entry) =>
            entry.reference.startsWith(`${sessionId}:`) &&
            entry.source === `delegated:${invocation.kind}` &&
            entry.classification !== undefined &&
            canFlowTo(entry.classification, invocation.classification)
          );
          if (!evidence) return unavailable;
          const messageId = evidence.reference.slice(sessionId.length + 1);
          const rows = await messages!.loadSession(sessionId);
          if (
            invocation.signal?.aborted ||
            !rows.some((row) =>
              row.session_id === sessionId && row.message_id === messageId &&
              row.sequence > invocation.after
            )
          ) return unavailable;
          return JSON.stringify({
            scope,
            criterion,
            verified: true,
            evidenceReference: evidence.reference,
            _classification: evidence.classification,
          });
        });
      } catch {
        return unavailable;
      }
    },
    async reportRecovered(
      args: Record<string, unknown>,
      executionId: string,
      sessionId: string,
      binding: RecoveredGoalSource,
      authorization: SavedSourceAuthorization,
    ) {
      const request = parseRecoveredGoalReport(args);
      if (!request) return recoveredGoalUnavailable;
      const scope = `delegated:${request.scope}`;
      const plan = plans.find((entry) =>
        entry.scope === scope && entry.policy === "operator"
      );
      const criterion = plan?.criteria.find((entry) =>
        entry.id === request.criterion && entry.kind === binding.kind
      );
      if (!plan || !criterion) return recoveredGoalUnavailable;
      const team = binding.kind === "team" ? binding.source : undefined;
      let traceSource: string;
      try {
        if (binding.kind === "subagent") {
          if (delegatedSubagentSessionId(executionId) !== sessionId) {
            return recoveredGoalUnavailable;
          }
          traceSource = binding.parentSessionId;
        } else {
          const { ownerSessionId, memberSessionId, teamId, deliveryId } =
            binding.source;
          if (
            memberSessionId !== sessionId ||
            executionId !== await teamDeliveryExecutionId(
                ownerSessionId as SessionId,
                sessionId as SessionId,
                deliveryId,
              )
          ) return recoveredGoalUnavailable;
          traceSource = teamDeliveryTraceSource(
            ownerSessionId as SessionId,
            teamId,
            deliveryId,
          );
        }
      } catch {
        return recoveredGoalUnavailable;
      }
      const findSource = async () => {
        if (binding.kind === "team" && !await binding.authorizeScope()) return;
        const step = await findRecoveredGoalTrace(
          baseDir,
          {
            role: "delegated",
            executionId,
            sessionId,
            sourceId: traceSource,
            callId: request.sourceCallId,
          },
          { tool: criterion.tool, resultSha256: criterion.result_sha256 },
          authorization,
        );
        if (binding.kind === "team" && !await binding.authorizeScope()) return;
        return step;
      };
      try {
        return await withLock(async () => {
          const exact = await findSource();
          const goal = withStore((store) => store.read(scope));
          if (
            !exact || !goal || authorization.signal?.aborted ||
            exact.recordedAt < goal.createdAt
          ) {
            return recoveredGoalUnavailable;
          }
          const proof = {
            source: team
              ? delegatedTeamGoalTraceSource(team.teamId)
              : delegatedGoalTraceSource,
            reference: `${executionId}:${exact.ordinal}:${exact.id}`,
            detail: criterion.requirement,
            classification: exact.classification,
          };
          const validReplay = readRecoveredGoalReport(
            baseDir,
            executionId,
            sessionId,
            args,
          );
          if (validReplay) {
            return JSON.parse(validReplay).evidenceReference === proof.reference
              ? validReplay
              : recoveredGoalUnavailable;
          }
          await reportScope(plan, undefined, undefined, request.criterion, {
            proof,
            requestId: request.requestId,
            binding: recoveredGoalReportBinding(
              executionId,
              sessionId,
              request,
            ),
            reauthorize: async () => (await findSource())?.id === exact.id,
          });
          return readRecoveredGoalReport(
            baseDir,
            executionId,
            sessionId,
            args,
          ) ?? recoveredGoalUnavailable;
        });
      } catch {
        return recoveredGoalUnavailable;
      }
    },
    async runCommand(
      command: string,
      ceiling: ClassificationLevel = "PUBLIC",
      access?: ManagedGoalTraceAccess,
    ) {
      const prefix = "/goal delegated cite ";
      if (!command.startsWith(prefix)) {
        return await managedCommand(command, ceiling, access);
      }
      const target = parseManagedGoalCitation(
        command.slice(prefix.length),
        "delegated",
      );
      return await withLock(async () => {
        const plan = plans.find(({ scope }) =>
          scope === `delegated:${target.scope}`
        );
        if (!plan) throw new Error("Unknown configured delegated goal");
        await reportScope(plan, undefined, {
          kind: "cite",
          target,
          ceiling,
          access,
        });
        return await managedCommand(
          `/goal delegated status ${target.scope}`,
          ceiling,
          access,
        );
      });
    },
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
            const invocation = after !== undefined
              ? {
                kind,
                sessionId,
                classification: options.targetClassification,
                after,
                signal: options.signal,
              }
              : undefined;
            const result = invocation && !options.toolPersistence
              ? await activeTurn.run(
                invocation,
                () => orchestrator.executeAgentTurn(options),
              )
              : await orchestrator.executeAgentTurn(options);
            if (invocation && !options.signal?.aborted) {
              try {
                await report(invocation);
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
