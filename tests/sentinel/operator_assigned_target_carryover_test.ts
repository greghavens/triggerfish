import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

Deno.test("Operator takeover preserves exact historical evidence on pending and completed assignments at rollover", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    const graph = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Application" },
        { id: "record", kind: "evidence", label: "Retained record" },
      ],
      edges: [{ from: "record", to: "app", relation: "observed_on" }],
    };
    const publish = async (...extra: string[]) => {
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...graph,
          nodes: [
            ...graph.nodes,
            ...extra.map((id) => ({ id, label: id, kind: "asset" })),
          ],
        }),
      );
    };
    await publish();
    const origin = startSentinelAssessment(path, {
      goal: "Review retained evidence",
    });
    advanceAdaptiveSentinel(path, origin);
    const firstRevision = adaptiveRevision(origin);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(firstRevision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], firstRevision);
      advanceAdaptiveSentinel(path, origin);
      const source = store.claimModelReview(
        firstRevision,
        MODEL_ASSIGNMENT_REASON,
      );
      assert(source);
      assert(
        store.finishModelReview(firstRevision, source.task.id, source.token, {
          note: "Reviewed the assigned graph evidence.",
          steps: [{
            tool: "sentinel_assigned_target",
            target: "app",
            outcome: "returned",
            assignedTarget: { targetId: "app", linkedNodeIds: ["record"] },
          }],
        }),
      );
      const tasks = [
        { kind: "review_evidence" as const, nodeId: "record" },
        { kind: "trace" as const, nodeId: "record", depth: 2 },
      ];
      store.sync(
        firstRevision,
        tasks.map((task) => ({
          ...task,
          reason: MODEL_ASSIGNMENT_REASON,
          prerequisites: [source.task.id],
          plannerRound: {
            identity: firstRevision,
            attempt: 1,
            workerSources: [{ taskId: source.task.id, kind: "model_review" }],
          },
        })),
        firstRevision,
      );
      await publish("new");
      const middle = refreshSentinelAssessment(path)!;
      const middleRevision = adaptiveRevision(middle);
      const citation = {
        sourceTaskId: source.task.id,
        evidenceRevision: origin.revision,
        targetId: "record",
        stepIndex: 0,
      };
      const goal = store.forEvidence(origin.revision)!.goal;
      const earlier = store.list(firstRevision).filter(({ nodeId }) =>
        nodeId === "record"
      );
      const middleTasks = store.sync(
        middleRevision,
        tasks.map((task) => ({
          ...task,
          reason: MODEL_ASSIGNMENT_REASON,
          carriedFrom: earlier.find(({ kind }) => kind === task.kind)!.id,
          plannerRound: { identity: firstRevision, attempt: 1 },
          revalidatedAssignedTargetCitations: [citation],
        })),
        firstRevision,
        { number: middle.revision, goal },
      );
      for (const task of middleTasks) {
        assert(store.assignQueuedTask(
          middleRevision,
          task.id,
          "Assigned by the operator in Tidepool.",
        ));
      }
      const unclaimed = middleTasks.find(({ kind }) =>
        kind === "review_evidence"
      )!;
      const claimed = store.claim(middleRevision, 60, new Set([unclaimed.id]));
      assert(claimed);
      assertEquals(claimed.task.kind, "trace");
      assert(
        store.complete({
          taskId: claimed.task.id,
          leaseToken: claimed.leaseToken,
          observation: {},
        }),
      );

      await publish("new", "newer");
      const current = refreshSentinelAssessment(path)!;
      advanceAdaptiveSentinel(path, current);
      const carried = readAdaptiveSentinel(path, current)!.tasks
        .filter(({ nodeId }) => nodeId === "record");
      assertEquals(carried.length, 2);
      for (const task of carried) {
        assertEquals(task.reason, "Assigned by the operator in Tidepool.");
        assertEquals(task.plannerRound?.priorAssignedTargetCitations, [
          citation,
        ]);
      }
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Operator takeover remaps approved chains and recovers a broken chain when its prerequisite returns", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    const nodes = [
      ...["source", "middle", "target", "removed"].map((id) => ({
        id,
        kind: "asset",
        label: id,
      })),
      {
        id: "finding",
        kind: "finding",
        label: "Retained finding",
        severity: "high",
      },
    ];
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes, edges: [] }),
    );
    const before = startSentinelAssessment(path, {
      goal: "Review the approved chains",
    });
    const oldRevision = adaptiveRevision(before);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const trace = (nodeId: string) => ({
        kind: "trace" as const,
        nodeId,
        depth: 2,
      });
      const source = trace("source");
      const middle = trace("middle");
      const target = trace("target");
      const removed = trace("removed");
      const finding = { kind: "review_finding" as const, nodeId: "finding" };
      const id = (task: typeof source | typeof finding) =>
        sentinelAdaptiveTaskId(oldRevision, task);
      const round = { identity: oldRevision, attempt: 1 };
      store.sync(
        oldRevision,
        [
          source,
          { ...middle, prerequisites: [id(source)] },
          { ...target, prerequisites: [id(middle)] },
          { ...removed, prerequisites: [id(source)] },
          { ...finding, prerequisites: [id(removed)] },
        ].map((task) => ({
          ...task,
          reason: MODEL_ASSIGNMENT_REASON,
          plannerRound: round,
        })),
        null,
        {
          number: before.revision,
          goal: { id: before.plan.runId!, label: before.plan.goal! },
        },
      );
      for (const task of [target, finding]) {
        assert(
          store.assignQueuedTask(
            oldRevision,
            id(task),
            "Assigned by the operator in Tidepool.",
          ),
        );
      }
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: nodes.filter(({ id }) => id !== "removed"),
          edges: [],
        }),
      );
      const current = refreshSentinelAssessment(path)!;
      advanceAdaptiveSentinel(path, current);
      advanceAdaptiveSentinel(path, current);
      const currentId = (task: typeof source | typeof finding) =>
        sentinelAdaptiveTaskId(adaptiveRevision(current), task);
      const after = readAdaptiveSentinel(path, current)!.tasks;
      const currentTarget = after.find(({ id }) => id === currentId(target));
      assert(currentTarget);
      assertEquals(
        currentTarget.reason,
        "Assigned by the operator in Tidepool.",
      );
      assertEquals(currentTarget.prerequisites, [currentId(middle)]);
      assertEquals(
        after.find(({ id }) => id === currentId(middle))?.prerequisites,
        [currentId(source)],
      );
      assert(!after.some(({ id }) => id === currentId(finding)));
      const unavailable = () =>
        store.recentActivity(100, oldRevision).filter(
          ({ event, taskId }) =>
            event === "assignment_unavailable" && taskId === id(finding),
        );
      assertEquals(unavailable().length, 1);

      await Deno.writeTextFile(
        path,
        JSON.stringify({ version: 1, nodes, edges: [] }),
      );
      const restored = refreshSentinelAssessment(path)!;
      assert(restored.revision > current.revision);
      advanceAdaptiveSentinel(path, restored);
      const restoredId = (task: typeof source | typeof finding) =>
        sentinelAdaptiveTaskId(adaptiveRevision(restored), task);
      const recovered = readAdaptiveSentinel(path, restored)!.tasks;
      const recoveredFinding = recovered.find(({ id }) =>
        id === restoredId(finding)
      );
      assert(recoveredFinding);
      assertEquals(
        recoveredFinding.reason,
        "Assigned by the operator in Tidepool.",
      );
      assertEquals(recoveredFinding.prerequisites, [restoredId(removed)]);
      assertEquals(
        recovered.find(({ id }) => id === restoredId(removed))?.prerequisites,
        [restoredId(source)],
      );
      assertEquals(unavailable().length, 1);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
