import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  executeSentinelTask,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

Deno.test("The gateway satisfies an exact queued prerequisite from a committed fact and releases its dependent", async () => {
  const dir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(dir);
  const inventory = {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Application" },
      { id: "record", kind: "evidence", label: "Exact evidence" },
      { id: "other", kind: "evidence", label: "Unrelated evidence" },
    ],
    edges: [{ from: "record", relation: "observed_on", to: "app" }],
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "review_evidence",
        nodeId: "other",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const unrelated = store.claim(revision)!;
      assertEquals(unrelated.task.nodeId, "other");
      const unrelatedFact = executeSentinelTask(state, unrelated.task);
      store.complete({
        taskId: unrelated.task.id,
        leaseToken: unrelated.leaseToken,
        observation: unrelatedFact,
      });
      store.sync(revision, [{
        kind: "trace",
        nodeId: "record",
        depth: 1,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const queued = store.list(revision).find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      )!;
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [queued.id],
      }, {
        kind: "review_evidence",
        nodeId: "record",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const source = store.list(revision).find(({ kind, nodeId }) =>
        kind === "review_evidence" && nodeId === "record"
      )!;
      const dependent = store.list(revision).find(({ kind }) =>
        kind === "impact"
      )!;
      assertEquals(dependent.status, "queued");
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: queued.id,
          sourceTaskId: unrelated.task.id,
          sourceObservationSha256: createHash("sha256").update(
            JSON.stringify(unrelatedFact),
          ).digest("hex"),
        }),
      );
      assertEquals(
        store.list(revision).find(({ id }) => id === queued.id)?.status,
        "queued",
      );
      assert(store.prioritize(revision, source.id));

      advanceAdaptiveSentinel(path, state);
      advanceAdaptiveSentinel(path, state);
      const view = readAdaptiveSentinel(path, state)!;
      const satisfied = view.tasks.find(({ id }) => id === queued.id)!;
      assertEquals(satisfied.status, "completed");
      assertEquals(satisfied.attempts, 0);
      assertEquals(satisfied.factSatisfaction?.sourceTaskId, source.id);
      assertEquals(
        view.tasks.find(({ id }) => id === dependent.id)?.status,
        "completed",
      );
      assertEquals(
        view.history.filter(({ taskId, event }) =>
          taskId === queued.id && event === "fact_satisfied"
        ).length,
        1,
      );
      assert(
        !view.history.some(({ taskId, event }) =>
          taskId === queued.id && event === "claimed"
        ),
      );
      const graph = buildSentinelProvenance(state.result, view).snapshot();
      assert(
        graph.edges.some(({ from, to, relation }) =>
          from.endsWith(queued.id) && to.endsWith(source.id) &&
          relation === "references"
        ),
      );

      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...inventory,
          nodes: inventory.nodes.map((node) =>
            node.id === "record" ? { ...node, label: "Updated evidence" } : node
          ),
        }),
      );
      const next = refreshSentinelAssessment(path)!;
      assert(next.revision > state.revision);
      advanceAdaptiveSentinel(path, next);
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: queued.id,
          sourceTaskId: source.id,
          sourceObservationSha256:
            satisfied.factSatisfaction!.sourceObservationSha256,
        }),
      );
      assert(
        !readAdaptiveSentinel(path, next)!.tasks.some(({ factSatisfaction }) =>
          factSatisfaction?.sourceTaskId === source.id
        ),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
