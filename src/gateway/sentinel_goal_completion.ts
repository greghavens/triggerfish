import { sentinelGoalProofArguments } from "../sentinel/worker_goal_recovery.ts";
import { readSentinelCaseGraphFacts } from "../sentinel/worker_graph_facts.ts";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
/** Bind shared goal completion to exact Sentinel case evidence and lifecycle. */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "@std/path";
import { GoalCompletionStore } from "../core/goal_completion.ts";
import { adaptiveRevision } from "../sentinel/adaptive_planner.ts";
import { readSentinelCompletedGoalTask } from "../sentinel/adaptive_store.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { verifyWorkerFindingRecheck } from "../sentinel/worker_finding_evidence.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
} from "../sentinel/worker_finding_store.ts";
import {
  normalizeSentinelGoalGraphFactReference,
  parseSentinelGoalTaskReference,
  sentinelGoalGraphFactId,
} from "../sentinel/formal_goals.ts";
import {
  completeSentinelAssessmentGoal,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  settleSentinelAssessmentDeadline,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";

type State = NonNullable<ReturnType<typeof readSentinelAssessment>>;
type GoalRecord = NonNullable<ReturnType<GoalCompletionStore["read"]>>;
type Observation = Parameters<GoalCompletionStore["report"]>[1][number];
type Evidence = Observation["evidence"][number];
type EvidenceSource =
  | "graph_evidence"
  | "adaptive_task"
  | "finding_recheck"
  | "graph_fact";

export function digestSentinelGoalProof(record: GoalRecord): string {
  return createHash("sha256").update(JSON.stringify([
    record.scope,
    record.goal,
    record.policy,
    record.criteria,
    record.observations,
  ])).digest("hex");
}

const defaultGoal = "Investigate prioritized defensive findings";
const workerProofPrefix = "Verified Sentinel assignment ";

export interface SentinelGoalCriterion {
  readonly id: string;
  readonly description: string;
  readonly source: EvidenceSource;
  readonly reference: string;
}

function goalDatabasePath(snapshotPath: string) {
  return join(dirname(snapshotPath), "sentinel-goal-completion.db");
}

function exists(path: string) {
  try {
    Deno.lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function goalScopePrefix(snapshotPath: string, state: State) {
  return "sentinel:" + createHash("sha256").update(JSON.stringify([
    resolve(snapshotPath),
    state.plan.runId ?? null,
    state.plan.goal ?? null,
  ])).digest("hex") + ":";
}

function goalScope(snapshotPath: string, state: State) {
  return goalScopePrefix(snapshotPath, state) +
    createHash("sha256").update(JSON.stringify([
      state.revision,
      state.result?.revision ?? null,
    ])).digest("hex");
}

function visibleGoalEvidence(snapshotPath: string, state: State) {
  return {
    caseId: locateSentinelCase(snapshotPath)?.caseId ?? null,
    runId: state.plan.runId ?? null,
    evidenceRevision: state.revision,
    inventoryRevision: state.result?.revision ?? null,
  };
}

function visibleGoalRecord(
  snapshotPath: string,
  state: State,
  record: GoalRecord,
) {
  return {
    ...record,
    caseEvidence: visibleGoalEvidence(snapshotPath, state),
    ...(state.plan.formalGoals && {
      formalGoals: state.plan.formalGoals.filter(({ id }) =>
        state.plan.activeFormalGoalIds?.includes(id) ||
        state.completion?.formalGoalIds?.includes(id)
      ).map(({ id, title, policy }) => ({ id, title, policy })),
    }),
  };
}

function hadContract(snapshotPath: string, state: State) {
  const path = goalDatabasePath(snapshotPath);
  if (!exists(path)) return false;
  const store = new GoalCompletionStore(path);
  try {
    return store.hasScopePrefix(goalScopePrefix(snapshotPath, state));
  } finally {
    store.close();
  }
}

function readContract(snapshotPath: string, scope: string) {
  const path = goalDatabasePath(snapshotPath);
  if (!exists(path)) return undefined;
  const store = new GoalCompletionStore(path);
  try {
    return store.read(scope);
  } finally {
    store.close();
  }
}

export function readSentinelGoalCompletion(snapshotPath: string) {
  const state = readSentinelAssessment(snapshotPath);
  return state && readSentinelGoalCompletionForState(snapshotPath, state);
}

export function readSentinelGoalCompletionForState(
  snapshotPath: string,
  state: State,
) {
  if (!state.result) return undefined;
  const record = readContract(snapshotPath, goalScope(snapshotPath, state));
  return record && visibleGoalRecord(snapshotPath, state, record);
}

function goalAssessmentAtRevision(
  path: string,
  revision: number,
): State | undefined {
  const state = readSentinelAssessment(path);
  if (!state || state.revision === revision) return state;
  const archived = readSentinelAssessmentRevision(path, revision);
  if (!archived) return;
  return {
    ...state,
    plan: archived.plan ?? state.plan,
    completion: archived.completion,
    revision,
    result: archived.result,
  };
}

export function readSentinelGoalCompletionAtRevision(
  path: string,
  revision: number,
) {
  const state = goalAssessmentAtRevision(path, revision);
  return state && readSentinelGoalCompletionForState(path, state);
}

export function readSentinelWorkerGoalProofTraceReceipt(
  path: string,
  revision: number,
  runId: string,
  taskId: string,
  targetId: string,
  requestId: string,
) {
  const state = goalAssessmentAtRevision(path, revision);
  if (state?.plan.runId !== runId) return;
  return readSentinelWorkerGoalProofReceipt(
    path,
    state,
    taskId,
    targetId,
    requestId,
  );
}

function requirement(
  source: string,
  reference: string,
  allowSelector = false,
) {
  if (source === "graph_fact") {
    const normalized = allowSelector
      ? normalizeSentinelGoalGraphFactReference(reference)
      : sentinelGoalGraphFactId.test(reference)
      ? reference
      : undefined;
    return normalized ? JSON.stringify([source, normalized]) : undefined;
  }
  if (
    source === "adaptive_task" && (/^adaptive:[a-f0-9]{64}$/.test(reference) ||
        (allowSelector && parseSentinelGoalTaskReference(reference))) ||
    source === "finding_recheck" &&
      /^pass:worker-finding:[a-f0-9]{64}$/.test(reference) ||
    source === "graph_evidence" && reference.trim().length > 0 &&
      reference.length <= 800 && !reference.includes("\x00")
  ) return JSON.stringify([source, reference]);
  return undefined;
}

export function registerSentinelGoalCompletion(
  snapshotPath: string,
  criteria: readonly SentinelGoalCriterion[],
  policy: "automatic" | "operator",
) {
  return registerSentinelGoalRules(snapshotPath, criteria, policy);
}

function registerSentinelGoalRules(
  snapshotPath: string,
  criteria: readonly SentinelGoalCriterion[],
  policy: "automatic" | "operator",
  expectedState?: State,
) {
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 32) {
    throw new Error("Supply between one and 32 exact Sentinel goal criteria.");
  }
  const rules = criteria.map((criterion) => {
    const binding = typeof criterion?.source === "string" &&
        typeof criterion.reference === "string"
      ? requirement(criterion.source, criterion.reference, true)
      : undefined;
    if (!binding || binding.length > 1024) {
      throw new Error(
        "Goal criteria need an exact evidence node, graph fact, adaptive task, or remediation recheck requirement.",
      );
    }
    return {
      id: criterion.id,
      description: criterion.description,
      requirement: binding,
    };
  });
  return withSentinelAssessmentWriteLock(snapshotPath, (state) => {
    if (!state?.active || !state.result) {
      throw new Error("A saved active Sentinel assessment is required.");
    }
    if (expectedState) {
      if (
        goalScope(snapshotPath, state) !==
          goalScope(snapshotPath, expectedState)
      ) {
        throw new Error("The approved Sentinel goal revision changed.");
      }
    } else if (state.plan.formalGoals?.length) {
      throw new Error(
        "Use the approved formal goal criteria for this assessment.",
      );
    }
    const store = new GoalCompletionStore(goalDatabasePath(snapshotPath));
    try {
      const record = store.register(
        goalScope(snapshotPath, state),
        state.plan.goal ?? defaultGoal,
        rules,
        policy,
      );
      return visibleGoalRecord(snapshotPath, state, record);
    } finally {
      store.close();
    }
  });
}

/** Rebuild the current revision contract from atomically approved definitions. */
export function ensureSentinelFormalGoalContract(path: string, state: State) {
  const existing = readSentinelGoalCompletionForState(path, state);
  if (existing || !state.active || state.paused || !state.result) {
    return existing;
  }
  const goals = state.plan.formalGoals?.filter(({ id }) =>
    state.plan.activeFormalGoalIds?.includes(id)
  );
  if (!goals?.length) return undefined;
  return registerSentinelGoalRules(
    path,
    goals.flatMap(({ id, criteria }) =>
      criteria.map((criterion) => ({
        ...criterion,
        id: `${id}/${criterion.id}`,
      }))
    ),
    goals.some(({ policy }) => policy === "operator")
      ? "operator"
      : "automatic",
    state,
  );
}

function goalEvidenceVerifier(
  snapshotPath: string,
  state: State,
  record: GoalRecord,
  deadlineAt?: number,
) {
  const rules = new Map(
    record.criteria.map(({ id, requirement }) => [id, requirement]),
  );
  const graphEvidence = new Set(
    state.result?.sharedGraph.snapshot?.nodes.filter(({ kind }) =>
      kind === "evidence"
    ).map(({ id }) => id),
  );
  const loadCompletedTask = (id: string) => {
    if (!/^adaptive:[a-f0-9]{64}$/.test(id)) return;
    const task = readSentinelCompletedGoalTask(
      join(dirname(snapshotPath), "sentinel-adaptive.db"),
      {
        number: state.revision,
        goal: {
          id: state.plan.runId ?? "sentinel-assessment",
          label: state.plan.goal ?? defaultGoal,
        },
        revisions: [adaptiveRevision(state), adaptiveRevision(state, true)],
      },
      id,
    );
    if (!task || task.observation === undefined || task.observation === null) {
      return;
    }
    const coverageTask = task.kind === "verify_control_coverage";
    if (coverageTask && deadlineAt !== undefined) {
      const snapshot = state.result?.sharedGraph.snapshot;
      if (
        !snapshot || !task.nodeId ||
        loadSentinelGraph(snapshot).controlCoverage(
            task.nodeId,
            new Date(deadlineAt).toISOString(),
          ).status !== "pass"
      ) return;
    }
    const pass = coverageTask && typeof task.observation === "object" &&
      "coverage" in task.observation && task.observation.coverage === "pass";
    return {
      target: task.nodeId,
      shape: pass && task.nodeId !== undefined
        ? requirement(
          "adaptive_task",
          `task:verify_control_coverage:pass:${task.nodeId}`,
          true,
        )
        : task.depth !== undefined && task.nodeId !== undefined
        ? requirement(
          "adaptive_task",
          `task:${task.kind}:${task.depth}:${task.nodeId}`,
          true,
        )
        : undefined,
      digest: createHash("sha256").update(JSON.stringify(task.observation))
        .digest("hex"),
    };
  };
  const verifyRecheck = (rule: string, reference: string, target?: string) => {
    const location = locateSentinelCase(snapshotPath);
    if (
      !/^worker-recheck:[a-f0-9]{64}$/.test(reference) ||
      !location || !state.plan.runId || !state.result?.sharedGraph.snapshot ||
      !hasSentinelWorkerFindingJournal(snapshotPath)
    ) return false;
    const store = openSentinelWorkerFindingStore(snapshotPath);
    try {
      const recheck = store.read(reference);
      if (
        recheck?.kind !== "recheck" || recheck.outcome !== "pass" ||
        recheck.caseId !== location.caseId ||
        recheck.runId !== state.plan.runId ||
        recheck.evidenceRevision !== state.revision ||
        (target !== undefined && target !== recheck.targetId) ||
        rule !== requirement("finding_recheck", `pass:${recheck.findingId}`)
      ) return false;
      const original = store.readFinding(recheck.findingId);
      if (
        original?.caseId !== recheck.caseId ||
        original.runId !== recheck.runId ||
        original.targetId !== recheck.targetId ||
        original.graphFindingId !== recheck.graphFindingId ||
        original.controlId !== recheck.controlId ||
        original.evidenceRevision > recheck.evidenceRevision ||
        (deadlineAt !== undefined &&
          Date.parse(recheck.validUntil) <= deadlineAt)
      ) return false;
      const receipt = verifyWorkerFindingRecheck(
        state.result.sharedGraph.snapshot,
        {
          caseId: recheck.caseId,
          evidenceRevision: state.revision,
          evaluatedAt: state.result.controlEvaluationAt ?? state.updatedAt,
        },
        {
          findingId: recheck.graphFindingId,
          assetId: recheck.targetId,
          controlId: recheck.controlId,
          evidenceId: recheck.evidenceId,
        },
      );
      return receipt?.outcome === "pass" &&
        receipt.snapshotDigest === recheck.snapshotDigest &&
        receipt.observedAt === recheck.observedAt &&
        receipt.validUntil === recheck.validUntil;
    } finally {
      store.close();
    }
  };
  return (
    criterionId: string,
    { source, reference, detail }: Evidence,
    assignment?: { target: string; digest?: string },
  ) => {
    const rule = rules.get(criterionId);
    if (!rule) return false;
    if (source === "finding_recheck") {
      return verifyRecheck(rule, reference, assignment?.target);
    }
    const binding = requirement(source, reference);
    if (!binding) return false;
    if (source === "graph_evidence") {
      return rule === binding && graphEvidence.has(reference);
    }
    if (source === "graph_fact") {
      const caseId = locateSentinelCase(snapshotPath)?.caseId;
      const runId = state.plan.runId;
      const snapshot = state.result?.sharedGraph.snapshot;
      if (!caseId || !runId || !snapshot) return false;
      const receipt = readSentinelCaseGraphFacts(snapshotPath, {
        caseId,
        runId,
        evidenceRevision: state.revision,
      }, { id: reference });
      if (!receipt || !("fact" in receipt)) return false;
      const { snapshotDigest, relationship, targetId } = receipt.fact;
      if (assignment && assignment.target !== targetId) return false;
      const shape = requirement(
        source,
        JSON.stringify([
          relationship.from,
          relationship.relation,
          relationship.to,
        ]),
        true,
      );
      return (rule === binding || rule === shape) &&
        snapshotDigest === digestSentinelSnapshot(snapshot) &&
        snapshot.edges.some(({ from, to, relation }) =>
          from === relationship.from && to === relationship.to &&
          relation === relationship.relation
        );
    }
    const result = loadCompletedTask(reference);
    if (!result || (rule !== binding && rule !== result.shape)) return false;
    if (
      assignment &&
      (result.target !== assignment.target ||
        result.digest !== assignment.digest)
    ) return false;
    if (!detail.startsWith(workerProofPrefix)) return true;
    return /result SHA-256 ([a-f0-9]{64})\.$/.exec(detail)?.[1] ===
      result.digest;
  };
}

function normalizedEvidence(observations: readonly Observation[]) {
  if (!Array.isArray(observations) || observations.length > 32) {
    throw new Error("Supply a bounded array of goal evidence observations.");
  }
  return observations.map((observation) => {
    if (
      !observation || !Array.isArray(observation.evidence) ||
      observation.evidence.length > 16
    ) {
      throw new Error("Invalid goal evidence observation.");
    }
    return {
      criterionId: observation.criterionId,
      evidence: observation.evidence.map((
        { source, reference, detail }: Evidence,
      ) => ({
        source,
        reference,
        detail: typeof detail === "string"
          ? source === "graph_evidence"
            ? "Exact evidence node in the pinned Sentinel inventory."
            : source === "finding_recheck"
            ? "Verified passing remediation recheck for the original Sentinel finding."
            : source === "graph_fact"
            ? "Verified relationship receipt from the pinned Sentinel graph."
            : "Committed result from an exact Sentinel adaptive task."
          : detail,
      })),
    };
  });
}

function savedGoalCriteriaVerify(
  record: GoalRecord,
  verify: ReturnType<typeof goalEvidenceVerifier>,
): boolean {
  return record.criteria.every(({ id }) =>
    record.observations.find(({ criterionId }) => criterionId === id)
      ?.evidence.some((proof) => verify(id, proof))
  );
}

function recordGoalEvidence(
  snapshotPath: string,
  state: State,
  record: GoalRecord,
  observations: readonly Observation[],
  operatorConfirmed: boolean,
) {
  const verify = goalEvidenceVerifier(snapshotPath, state, record);
  if (
    record.status === "completed" && !savedGoalCriteriaVerify(record, verify)
  ) {
    throw new Error(
      "The recorded Sentinel goal proof is no longer verifiable.",
    );
  }
  const store = new GoalCompletionStore(goalDatabasePath(snapshotPath));
  try {
    const supplied = withoutDuplicateWorkerProofs(record, observations);
    return store.report(
      record.scope,
      supplied,
      verify,
      operatorConfirmed,
    );
  } finally {
    store.close();
  }
}

function withoutDuplicateWorkerProofs(
  record: GoalRecord,
  observations: readonly Observation[],
) {
  const workerProofs = new Set(record.observations.flatMap(
    ({ criterionId, evidence }) =>
      evidence.filter(({ detail }) => detail.startsWith(workerProofPrefix))
        .map(({ source, reference }) =>
          JSON.stringify([criterionId, source, reference])
        ),
  ));
  return observations.map(({ criterionId, evidence }) => ({
    criterionId,
    evidence: evidence.filter(({ source, reference }) =>
      !workerProofs.has(JSON.stringify([criterionId, source, reference]))
    ),
  }));
}

function workerProofRequestBinding(
  assignmentId: string,
  targetId: string,
  args: NonNullable<ReturnType<typeof sentinelGoalProofArguments>>,
) {
  return createHash("sha256").update(
    JSON.stringify([assignmentId, targetId, args]),
  ).digest("hex");
}

export function readSentinelWorkerGoalProofReceipt(
  snapshotPath: string,
  state: State,
  assignmentId: string,
  targetId: string,
  requestId: string,
) {
  const scope = goalScope(snapshotPath, state);
  const path = goalDatabasePath(snapshotPath);
  if (!state.plan.runId || !exists(path)) return;
  const store = new GoalCompletionStore(path);
  try {
    const registered = store.read(scope);
    const saved = store.readEvidenceSubmission(scope, requestId);
    if (!saved || !registered) return;
    const { criterionId, proof, status } = saved.receipt;
    const [goalId, localCriterion] = criterionId.split("/");
    if (!state.plan.activeFormalGoalIds?.includes(goalId)) return;
    const args = sentinelGoalProofArguments({
      goalId,
      criterionId: localCriterion,
      evidenceId: proof.reference,
      source: proof.source,
      requestId,
    });
    if (
      !args ||
      saved.binding !==
        workerProofRequestBinding(assignmentId, targetId, args) ||
      !registered.observations.some((observation) =>
        observation.criterionId === criterionId && observation.evidence.some(
          (evidence) =>
            evidence.source === proof.source &&
            evidence.reference === proof.reference &&
            evidence.detail === proof.detail,
        )
      ) ||
      !goalEvidenceVerifier(snapshotPath, state, registered)(criterionId, proof)
    ) return;
    return {
      args,
      receipt: {
        runId: state.plan.runId,
        evidenceRevision: state.revision,
        criterionId,
        proof,
        status,
      },
    };
  } finally {
    store.close();
  }
}

export function reportSentinelWorkerGoalProof(
  snapshotPath: string,
  input: {
    revision: number;
    assignmentId: string;
    goalId: string;
    criterionId: string;
    evidenceId: string;
    requestId?: string;
    targetId?: string;
    taskProof?: { target: string; digest: string };
    scopedProof?: { source: "graph_fact" | "finding_recheck"; target: string };
  },
  authorize: () => boolean,
  webContainmentConfigured?: boolean,
) {
  const current = readSentinelAssessment(snapshotPath);
  if (current?.revision !== input.revision) return;
  let receipt: {
    runId: string;
    evidenceRevision: number;
    criterionId: string;
    proof: Evidence;
    status: GoalRecord["status"];
  } | undefined;
  completeSentinelAssessmentGoal(
    snapshotPath,
    input.revision,
    current.plan.goal ?? null,
    "Verified Sentinel assignment goal evidence.",
    webContainmentConfigured,
    (state) => {
      if (
        !state?.active || state.paused || !state.plan.runId ||
        state.revision !== input.revision || !authorize() ||
        !state.plan.activeFormalGoalIds?.includes(input.goalId)
      ) return false;
      const criterionId = `${input.goalId}/${input.criterionId}`;
      const registered = readContract(
        snapshotPath,
        goalScope(snapshotPath, state),
      );
      if (!registered) return false;
      const evidence = {
        source: input.taskProof
          ? "adaptive_task"
          : input.scopedProof?.source ?? "graph_evidence",
        reference: input.evidenceId,
        detail:
          `${workerProofPrefix}${input.assignmentId} at evidence revision ${input.revision}` +
          (input.taskProof
            ? `, result SHA-256 ${input.taskProof.digest}.`
            : "."),
      };
      if (
        !goalEvidenceVerifier(snapshotPath, state, registered)(
          criterionId,
          evidence,
          input.taskProof ?? input.scopedProof,
        )
      ) return false;
      const observations = [{ criterionId, evidence: [evidence] }];
      let proof: Evidence | undefined;
      let status: GoalRecord["status"];
      if (input.requestId !== undefined) {
        const args = sentinelGoalProofArguments({
          goalId: input.goalId,
          criterionId: input.criterionId,
          evidenceId: input.evidenceId,
          source: evidence.source,
          requestId: input.requestId,
        });
        if (!args || !input.targetId) return false;
        const store = new GoalCompletionStore(goalDatabasePath(snapshotPath));
        try {
          const saved = store.reportEvidenceSubmission(
            registered.scope,
            withoutDuplicateWorkerProofs(registered, observations),
            goalEvidenceVerifier(snapshotPath, state, registered),
            {
              requestId: args.requestId,
              binding: workerProofRequestBinding(
                input.assignmentId,
                input.targetId,
                args,
              ),
              criterionId,
              source: evidence.source,
              reference: evidence.reference,
            },
          );
          ({ proof, status } = saved);
        } finally {
          store.close();
        }
      } else {
        const saved = recordGoalEvidence(
          snapshotPath,
          state,
          registered,
          observations,
          false,
        );
        proof = saved.observations.find((observation) =>
          observation.criterionId === criterionId
        )
          ?.evidence.find(({ source, reference }) =>
            source === evidence.source && reference === evidence.reference
          );
        status = saved.status;
      }
      if (!proof) return false;
      receipt = {
        runId: state.plan.runId,
        evidenceRevision: state.revision,
        criterionId,
        proof,
        status,
      };
      // The assessment service applies the decision after the worker returns.
      return false;
    },
    current.plan.activeFormalGoalIds,
  );
  return receipt;
}

export function reportSentinelGoalCompletion(
  snapshotPath: string,
  expectedScope: string,
  observations: readonly Observation[],
  webContainmentConfigured?: boolean,
) {
  const current = readSentinelAssessment(snapshotPath);
  if (
    !current?.result ||
    goalScope(snapshotPath, current) !== expectedScope
  ) {
    throw new Error("The Sentinel goal evidence scope has changed.");
  }
  if (!current.active) {
    const existing = current.completion &&
      readContract(snapshotPath, expectedScope);
    if (existing?.status === "completed") {
      return {
        record: visibleGoalRecord(snapshotPath, current, existing),
        assessmentCompleted: true,
      };
    }
    throw new Error("The Sentinel goal is no longer active.");
  }
  if (current.paused) throw new Error("The Sentinel assessment is paused.");
  const submitted = normalizedEvidence(observations);
  let record: GoalRecord | undefined;
  const assessmentCompleted = completeSentinelAssessmentGoal(
    snapshotPath,
    current.revision,
    current.plan.goal ?? null,
    "Verified all registered Sentinel goal criteria.",
    webContainmentConfigured,
    (state) => {
      if (state.paused) return false;
      const scope = goalScope(snapshotPath, state);
      const registered = scope === expectedScope &&
        readContract(snapshotPath, scope);
      if (!registered) return false;
      record = recordGoalEvidence(
        snapshotPath,
        state,
        registered,
        submitted,
        false,
      );
      return record.policy === "automatic" && record.status === "completed";
    },
    current.plan.activeFormalGoalIds,
  );
  if (!record) {
    throw new Error("The Sentinel goal or its evaluated evidence has changed.");
  }
  return {
    record: visibleGoalRecord(snapshotPath, current, record),
    assessmentCompleted,
  };
}

/** Settle a timed assessment from its already committed automatic decision. */
export function reconcileSentinelDeadlineGoal(snapshotPath: string): boolean {
  return settleSentinelAssessmentDeadline(
    snapshotPath,
    (state, deadlineAt) => {
      const registered = readContract(
        snapshotPath,
        goalScope(snapshotPath, state),
      );
      const completedAt = Date.parse(registered?.completedAt ?? "");
      if (
        registered?.policy !== "automatic" ||
        registered.status !== "completed" ||
        !Number.isFinite(completedAt) || completedAt > deadlineAt
      ) return false;
      const verify = goalEvidenceVerifier(
        snapshotPath,
        state,
        registered,
        deadlineAt,
      );
      return savedGoalCriteriaVerify(registered, verify);
    },
  );
}

/** Finish a previously verified automatic decision after an interrupted case write. */
export function reconcileSentinelAutomaticGoal(
  snapshotPath: string,
  webContainmentConfigured?: boolean,
): boolean {
  const state = readSentinelAssessment(snapshotPath);
  if (state?.deadlineReviewPending) {
    return reconcileSentinelDeadlineGoal(snapshotPath);
  }
  if (!state?.active || state.paused || !state.result) return false;
  const record = readSentinelGoalCompletionForState(snapshotPath, state);
  if (record?.policy !== "automatic" || record.status !== "completed") {
    return false;
  }
  try {
    return reportSentinelGoalCompletion(
      snapshotPath,
      record.scope,
      [],
      webContainmentConfigured,
    )
      .assessmentCompleted;
  } catch {
    // Changed inputs or revoked proof leave the case active for review.
    return false;
  }
}

/** Null permits only unregistered manual completion. A supplied proof binds confirmation to the reviewed record. */
export function completeSentinelRegisteredGoal(
  snapshotPath: string,
  revision: number,
  expectedGoal: string | null,
  note: string,
  webContainmentConfigured?: boolean,
  approvedProof?: { runId: string; digest: string } | null,
) {
  const current = readSentinelAssessment(snapshotPath);
  if (current?.revision === revision && current.plan.formalGoals?.length) {
    ensureSentinelFormalGoalContract(snapshotPath, current);
  }
  return completeSentinelAssessmentGoal(
    snapshotPath,
    revision,
    expectedGoal,
    note,
    webContainmentConfigured,
    (state) => {
      const registered = readContract(
        snapshotPath,
        goalScope(snapshotPath, state),
      );
      if (approvedProof === null && registered) return false;
      if (
        approvedProof &&
        (state.plan.runId !== approvedProof.runId || !registered ||
          registered.policy !== "operator" ||
          !["awaiting_confirmation", "completed"].includes(registered.status) ||
          digestSentinelGoalProof(registered) !== approvedProof.digest)
      ) return false;
      return registered
        ? recordGoalEvidence(snapshotPath, state, registered, [], true)
          .status === "completed"
        : !hadContract(snapshotPath, state);
    },
    current?.plan.activeFormalGoalIds,
  ) ||
    hasRecordedDecision(
      snapshotPath,
      revision,
      expectedGoal,
      note,
      approvedProof,
    );
}

function hasRecordedDecision(
  snapshotPath: string,
  revision: number,
  expectedGoal: string | null,
  note: string,
  approvedProof?: { runId: string; digest: string } | null,
): boolean {
  const state = readSentinelAssessment(snapshotPath);
  if (
    state?.revision !== revision || state.completion?.goal !== expectedGoal ||
    state.completion.note !== note.trim()
  ) return false;
  if (approvedProof === undefined) return true;
  const registered = readContract(snapshotPath, goalScope(snapshotPath, state));
  return approvedProof === null
    ? !registered
    : state.plan.runId === approvedProof.runId &&
      registered?.status === "completed" &&
      digestSentinelGoalProof(registered) === approvedProof.digest;
}
