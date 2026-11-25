import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  completeSentinelRegisteredGoal,
  readSentinelGoalCompletion,
  registerSentinelGoalCompletion,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../../src/sentinel/assessment_store.ts";

function inventory(label = "Referenced record") {
  return JSON.stringify({
    version: 1,
    nodes: [
      { id: "record", kind: "evidence", label },
      { id: "unrelated", kind: "evidence", label: "Unrelated valid record" },
    ],
    edges: [],
  });
}

Deno.test("Sentinel goal completion binds exact graph evidence and a committed case task to operator criteria", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, inventory());
    const state = startSentinelAssessment(path, {
      goal: "Review the evidence",
    });
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const task = { kind: "trace" as const, nodeId: "record", depth: 1 };
    const taskId = sentinelAdaptiveTaskId(revision, task);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(revision, [task], revision);
      const registered = registerSentinelGoalCompletion(path, [
        {
          id: "record",
          description: "Check the registered inventory record.",
          source: "graph_evidence",
          reference: "record",
        },
        {
          id: "worker",
          description: "Check the assigned deterministic observation.",
          source: "adaptive_task",
          reference: taskId,
        },
      ], "operator");
      const observe = (
        criterionId: string,
        source: string,
        reference: string,
      ) => ({
        criterionId,
        evidence: [{
          source,
          reference,
          detail: "Untrusted reporter commentary.",
        }],
      });
      const wrong = reportSentinelGoalCompletion(path, registered.scope, [
        observe("record", "graph_evidence", "unrelated"),
        observe("worker", "adaptive_task", taskId),
      ]);
      assertEquals(wrong.record.status, "open");
      assertEquals(wrong.record.observations, []);
      assert(
        !completeSentinelRegisteredGoal(
          path,
          state.revision,
          state.plan.goal!,
          "Verify completion.",
        ),
      );
      advanceAdaptiveSentinel(path, state);
      const verified = reportSentinelGoalCompletion(path, registered.scope, [
        observe("record", "graph_evidence", "record"),
        observe("worker", "adaptive_task", taskId),
      ]);
      assertEquals(verified.record.status, "awaiting_confirmation");
      assertEquals(verified.assessmentCompleted, false);
      assert(
        !JSON.stringify(verified).includes("Untrusted reporter commentary."),
      );
      assert(readSentinelAssessment(path)?.active);
      assert(completeSentinelRegisteredGoal(
        path,
        state.revision,
        state.plan.goal!,
        "Operator verified completion.",
      ));
      const receipt = readSentinelGoalCompletion(path);
      assert(completeSentinelRegisteredGoal(
        path,
        state.revision,
        state.plan.goal!,
        "Operator verified completion.",
      ));
      assertEquals(
        reportSentinelGoalCompletion(path, registered.scope, []).record,
        receipt,
      );
      assertEquals(readSentinelGoalCompletion(path)?.status, "completed");
      assertEquals(
        readSentinelAssessment(path)?.completion?.note,
        "Operator verified completion.",
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel automatic goal reporting rejects stale scope and unpublished evidence and shares terminal completion", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, inventory());
    const state = startSentinelAssessment(path, { goal: "Original goal" });
    const criteria = [{
      id: "record",
      description: "Verify the exact record.",
      source: "graph_evidence" as const,
      reference: "record",
    }];
    const old = registerSentinelGoalCompletion(path, criteria, "automatic");
    const observations = [{
      criterionId: "record",
      evidence: [{
        source: "graph_evidence",
        reference: "record",
        detail: "Verifier input.",
      }],
    }];
    assert(updateSentinelAssessmentGoal(path, "New goal"));
    assertEquals(readSentinelAssessment(path)?.revision, state.revision);
    assertThrows(() =>
      reportSentinelGoalCompletion(path, old.scope, observations)
    );
    const next = registerSentinelGoalCompletion(path, criteria, "automatic");
    await Deno.writeTextFile(path, inventory("New published input"));
    assertThrows(() =>
      reportSentinelGoalCompletion(path, next.scope, observations)
    );
    assert(readSentinelAssessment(path)?.active);
    const refreshed = refreshSentinelAssessment(path)!;
    assert(
      !completeSentinelRegisteredGoal(
        path,
        refreshed.revision,
        refreshed.plan.goal!,
        "Must register current criteria first.",
      ),
    );
    const refreshedContract = registerSentinelGoalCompletion(
      path,
      criteria,
      "automatic",
    );
    assert(refreshedContract.scope !== next.scope);
    const completed = reportSentinelGoalCompletion(
      path,
      refreshedContract.scope,
      observations,
    );
    assertEquals(completed.record.status, "completed");
    assertEquals(completed.assessmentCompleted, true);
    assertEquals(readSentinelAssessment(path)?.revision, refreshed.revision);
    assertEquals(readSentinelAssessment(path)?.active, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("The Sentinel planner reports the exact registered proof from a completed worker", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    await Deno.writeTextFile(path, inventory());
    const state = startSentinelAssessment(path, {
      goal: "Verify the recorded worker fact",
    });
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const task = { kind: "trace" as const, nodeId: "record", depth: 1 };
    const taskId = sentinelAdaptiveTaskId(revision, task);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(revision, [task], revision);
      advanceAdaptiveSentinel(path, state);
    } finally {
      store.close();
    }
    registerSentinelGoalCompletion(path, [{
      id: "review",
      description: "Read the exact worker fact.",
      source: "adaptive_task",
      reference: taskId,
    }], "automatic");
    let shown = false;
    planner = createSentinelModelPlanner(path, (_state, assignedTaskId) => ({
      execute(message, send) {
        if (assignedTaskId) return Promise.resolve();
        const inputs = JSON.parse(String(message).split("\n").at(-1)!);
        const exact = inputs.workerObservations.find((
          { taskId: id }: { taskId: string },
        ) => id === taskId);
        shown = inputs.goalCompletion.criteria[0].id === "review" &&
          exact?.observation?.trace?.nodes?.[0]?.id === "record";
        send({
          type: "response",
          taint: "INTERNAL",
          text: JSON.stringify({
            assignments: [],
            prioritize: [],
            goalObservations: [{
              criterionId: "review",
              evidence: [{
                source: "adaptive_task",
                reference: exact?.taskId,
                detail: "Observed worker result.",
              }],
            }],
          }),
        });
        return Promise.resolve();
      },
      clear() {},
    }));
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(shown);
    assertEquals(readSentinelGoalCompletion(path)?.status, "completed");
    assertEquals(readSentinelAssessment(path)?.active, false);
  } finally {
    planner?.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("The Sentinel coordinator reconciles an interrupted automatic completion without dispatching workers", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "data", "sentinel.json");
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  try {
    await Deno.mkdir(join(dir, "data"));
    await Deno.writeTextFile(path, inventory());
    const state = startSentinelAssessment(path, {
      goal: "Verify the recorded inventory",
    });
    const registration = registerSentinelGoalCompletion(path, [{
      id: "record",
      description: "Verify the exact imported evidence.",
      reference: "record",
      source: "graph_evidence",
    }], "automatic");
    const core = new GoalCompletionStore(
      join(dir, "data", "sentinel-goal-completion.db"),
    );
    try {
      assertEquals(
        core.report(registration.scope, [{
          criterionId: "record",
          evidence: [{
            source: "graph_evidence",
            reference: "record",
            detail: "Exact evidence node in the pinned Sentinel inventory.",
          }],
        }], () => true).status,
        "completed",
      );
    } finally {
      core.close();
    }
    assert(readSentinelAssessment(path)?.active);
    let advanced = 0;
    coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive() {
        advanced++;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(advanced, 0);
    assertEquals(readSentinelAssessment(path)?.active, false);
    const replay = reportSentinelGoalCompletion(path, registration.scope, []);
    assertEquals(replay.assessmentCompleted, true);
    assertEquals(replay.record, readSentinelGoalCompletion(path));
    assertEquals(replay.record.caseEvidence, {
      caseId: "main",
      runId: state.plan.runId ?? null,
      evidenceRevision: state.revision,
      inventoryRevision: state.result?.revision ?? null,
    });
  } finally {
    coordinator?.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
