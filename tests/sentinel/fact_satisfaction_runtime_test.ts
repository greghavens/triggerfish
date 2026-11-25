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
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";

Deno.test("Sentinel satisfies the exact evidence queue head from a committed fact and releases its child", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "asset", kind: "asset", label: "Application" },
          { id: "record", kind: "evidence", label: "Imported telemetry" },
          { id: "other", kind: "evidence", label: "Unverified record" },
        ],
        edges: [{ from: "record", to: "asset", relation: "observed_on" }],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const source = { kind: "trace" as const, nodeId: "record", depth: 1 };
      const unrelated = { ...source, nodeId: "other" };
      const id = (task: Parameters<typeof sentinelAdaptiveTaskId>[1]) =>
        sentinelAdaptiveTaskId(revision, task);
      store.sync(revision, [
        { ...source, reason: MODEL_ASSIGNMENT_REASON },
        { ...unrelated, reason: MODEL_ASSIGNMENT_REASON },
      ], revision);
      const bogus = store.claim(revision, 60, new Set([id(source)]));
      assert(bogus);
      assertEquals(bogus.task.id, id(unrelated));
      assert(store.complete({
        taskId: bogus.task.id,
        leaseToken: bogus.leaseToken,
        observation: { relatedNodeIds: ["other"], trace: { nodes: [] } },
      }));
      advanceAdaptiveSentinel(path, state);
      const target = { kind: "review_evidence" as const, nodeId: "record" };
      const child = { ...source, depth: 2 };
      const noFact = { ...target, nodeId: "other" };
      store.sync(revision, [{
        ...target,
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [id(source)],
        plannerRound: {
          identity: revision,
          attempt: 1,
          workerSources: [{ taskId: id(source), kind: "worker_result" }],
        },
      }, {
        ...child,
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [id(target)],
      }, { ...noFact, reason: MODEL_ASSIGNMENT_REASON }], revision);
      advanceAdaptiveSentinel(path, state);
      const tasks = readAdaptiveSentinel(path, state)!.tasks;
      const completed = tasks.find((task) => task.id === id(target));
      const original = tasks.find((task) => task.id === id(source));
      assert(completed?.factSatisfaction);
      assertEquals(completed.factSatisfaction.sourceTaskId, id(source));
      assertEquals(completed.observation, original?.observation);
      assertEquals(completed.attempts, 0);
      assertEquals(
        tasks.find((task) => task.id === id(child))?.status,
        "completed",
      );
      assertEquals(tasks.find((task) => task.id === id(noFact))?.attempts, 1);
      assert(
        !store.modelReviewAvailable(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.id === id(target),
        ),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
