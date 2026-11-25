/** Bind shared goal completion to exact Sentinel case evidence and lifecycle. */
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "@std/path";
import { GoalCompletionStore } from "../core/goal_completion.ts";
import { adaptiveRevision } from "../sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../sentinel/adaptive_store.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import {
  completeSentinelAssessmentGoal,
  readSentinelAssessment,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";

type State = NonNullable<ReturnType<typeof readSentinelAssessment>>;
type GoalRecord = NonNullable<ReturnType<GoalCompletionStore["read"]>>;
type Observation = Parameters<GoalCompletionStore["report"]>[1][number];
type Evidence = Observation["evidence"][number];
type EvidenceSource = "graph_evidence" | "adaptive_task";

const defaultGoal = "Investigate prioritized defensive findings";

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
  return { ...record, caseEvidence: visibleGoalEvidence(snapshotPath, state) };
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

function requirement(source: string, reference: string) {
  if (
    source === "adaptive_task" && /^adaptive:[a-f0-9]{64}$/.test(reference) ||
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
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 32) {
    throw new Error("Supply between one and 32 exact Sentinel goal criteria.");
  }
  const rules = criteria.map((criterion) => {
    const binding = typeof criterion?.source === "string" &&
        typeof criterion.reference === "string"
      ? requirement(criterion.source, criterion.reference)
      : undefined;
    if (!binding || binding.length > 1024) {
      throw new Error(
        "Goal criteria need an exact evidence node or adaptive task.",
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

function goalEvidenceVerifier(
  snapshotPath: string,
  state: State,
  record: GoalRecord,
) {
  const rules = new Map(
    record.criteria.map(({ id, requirement }) => [id, requirement]),
  );
  const graphEvidence = new Set(
    state.result?.sharedGraph.snapshot?.nodes.filter(({ kind }) =>
      kind === "evidence"
    ).map(({ id }) => id),
  );
  let completedTasks: Set<string> | undefined;
  const loadCompletedTasks = () => {
    const completed = new Set<string>();
    const path = join(dirname(snapshotPath), "sentinel-adaptive.db");
    if (!exists(path)) return completed;
    const store = openSentinelAdaptiveStore(path);
    try {
      const map = store.forEvidence(state.revision);
      if (
        !map || store.activeRevision() !== map.revision ||
        map.goal.id !== (state.plan.runId ?? "sentinel-assessment") ||
        map.goal.label !== (state.plan.goal ?? defaultGoal) ||
        (map.revision !== adaptiveRevision(state) &&
          map.revision !== adaptiveRevision(state, true))
      ) return completed;
      for (const task of store.list(map.revision)) {
        if (
          task.status === "completed" && task.observation !== undefined &&
          task.observation !== null
        ) completed.add(task.id);
      }
      return completed;
    } finally {
      store.close();
    }
  };
  return (criterionId: string, { source, reference }: Evidence) => {
    const binding = requirement(source, reference);
    if (!binding || rules.get(criterionId) !== binding) return false;
    return source === "graph_evidence"
      ? graphEvidence.has(reference)
      : (completedTasks ??= loadCompletedTasks()).has(reference);
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
            : "Committed result from an exact Sentinel adaptive task."
          : detail,
      })),
    };
  });
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
    record.status === "completed" &&
    !record.criteria.every(({ id }) =>
      record.observations.find(({ criterionId }) => criterionId === id)
        ?.evidence
        .some((evidence) => verify(id, evidence))
    )
  ) {
    throw new Error(
      "The recorded Sentinel goal proof is no longer verifiable.",
    );
  }
  const store = new GoalCompletionStore(goalDatabasePath(snapshotPath));
  try {
    return store.report(
      record.scope,
      observations,
      verify,
      operatorConfirmed,
    );
  } finally {
    store.close();
  }
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
  );
  if (!record) {
    throw new Error("The Sentinel goal or its evaluated evidence has changed.");
  }
  return {
    record: visibleGoalRecord(snapshotPath, current, record),
    assessmentCompleted,
  };
}

/** Finish a previously verified automatic decision after an interrupted case write. */
export function reconcileSentinelAutomaticGoal(
  snapshotPath: string,
  webContainmentConfigured?: boolean,
): boolean {
  const state = readSentinelAssessment(snapshotPath);
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

/** Keep legacy manual completion available when no criteria were registered. */
export function completeSentinelRegisteredGoal(
  snapshotPath: string,
  revision: number,
  expectedGoal: string | null,
  note: string,
  webContainmentConfigured?: boolean,
) {
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
      return registered
        ? recordGoalEvidence(snapshotPath, state, registered, [], true)
          .status === "completed"
        : !hadContract(snapshotPath, state);
    },
  ) || hasRecordedDecision(snapshotPath, revision, expectedGoal, note);
}

function hasRecordedDecision(
  snapshotPath: string,
  revision: number,
  expectedGoal: string | null,
  note: string,
): boolean {
  const state = readSentinelAssessment(snapshotPath);
  return state?.revision === revision &&
    state.completion?.goal === expectedGoal &&
    state.completion.note === note.trim();
}
