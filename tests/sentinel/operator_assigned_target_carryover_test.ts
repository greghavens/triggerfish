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
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
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
