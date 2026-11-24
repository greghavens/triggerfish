import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { dirname } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { syncSentinelTopology } from "../../src/gateway/sentinel_topology_sync.ts";
import { planSentinelTasks } from "../../src/sentinel/adaptive_planner.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import {
  applySharedSentinelTopology,
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
} from "../../src/sentinel/shared_inventory.ts";
import { indexSharedSentinelTopologyEvidence } from "../../src/sentinel/shared_topology_work.ts";

const local = {
  version: 1,
  nodes: [
    { id: "app", label: "Application", kind: "asset" },
    { id: "db", label: "Database", kind: "asset" },
    { id: "other", label: "Unrelated asset", kind: "asset" },
  ],
  edges: [],
};
const remote = {
  version: 1,
  nodes: [
    { id: "app", label: "Reported application", kind: "asset" },
    { id: "db", label: "Reported database", kind: "asset" },
  ],
  edges: [{ from: "app", to: "db", relation: "depends_on" }],
};
const topology = [{
  ...remote.edges[0],
  caseIds: ["source"],
  sourceDigests: {
    source: digestSentinelSnapshot(loadSentinelGraph(remote).snapshot()),
  },
}];

Deno.test("Shared topology work requires an exact observed relationship and respects local scope", () => {
  const snapshot = applySharedSentinelTopology(local, topology);
  const ids = [...indexSharedSentinelTopologyEvidence(snapshot).keys()];
  assertEquals(ids.length, 1);
  const [id] = ids;
  const state = {
    plan: {},
    active: true,
    paused: false,
    updatedAt: "",
    reviews: [],
    revision: 1,
    result: runSentinelAssessment({ snapshot }),
  };
  assertEquals(
    planSentinelTasks(state, []).map(({ kind, nodeId }) => [kind, nodeId]),
    [
      ["review_evidence", id],
    ],
  );
  assertEquals(
    planSentinelTasks({ ...state, plan: { traceNode: "other" } }, []),
    [],
  );
  assertEquals(
    planSentinelTasks({ ...state, plan: { traceNode: "db" } }, [])
      .map(({ nodeId }) => nodeId),
    [id],
  );

  const altered = loadSentinelGraph({
    ...snapshot,
    edges: snapshot.edges.map((edge) =>
      edge.from === id && edge.to === "db" ? { ...edge, to: "other" } : edge
    ),
  }).snapshot();
  assertEquals(indexSharedSentinelTopologyEvidence(altered).size, 0);
});

Deno.test("Synchronized shared facts schedule scoped work and reopen on source changes", async () => {
  const base = await Deno.makeTempDir();
  const currentPath = resolveSentinelCasePath(base);
  const remotePath = resolveSentinelCasePath(base, "source");
  try {
    await Deno.mkdir(dirname(remotePath), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(currentPath, JSON.stringify(local));
    await Deno.writeTextFile(remotePath, JSON.stringify(remote));
    const started = startSentinelAssessment(currentPath, { traceNode: "db" });
    advanceAdaptiveSentinel(currentPath, started);
    assertEquals(readAdaptiveSentinel(currentPath, started)?.tasks ?? [], []);

    await syncSentinelTopology(base, "main", currentPath);
    const first = refreshSentinelAssessment(currentPath)!;
    advanceAdaptiveSentinel(currentPath, first);
    const saved = readAdaptiveSentinel(currentPath, first)!;
    const review = saved.tasks.find(({ kind }) => kind === "review_evidence")!;
    assert(review?.nodeId);
    assertEquals(review.status, "completed");
    const trace = saved.tasks.find(({ kind }) => kind === "trace")!;
    assertEquals(trace.nodeId, "db");
    assertEquals(trace.prerequisites, [review.id]);
    assertEquals(trace.evidenceIds, [review.nodeId]);
    assertEquals(trace.status, "completed");
    const provenance = buildSentinelProvenance(first.result, saved).snapshot();
    assert(
      provenance.edges.some(({ from, to, relation }) =>
        from === `evidence:${review.nodeId}` &&
        to === `task:adaptive:${trace.id}` && relation === "prompted"
      ),
    );

    const revisedRemote = {
      ...remote,
      nodes: remote.nodes.map((node) => ({
        ...node,
        label: node.label + " verified",
      })),
    };
    await Deno.writeTextFile(remotePath, JSON.stringify(revisedRemote));
    await syncSentinelTopology(base, "main", currentPath);
    const revised = refreshSentinelAssessment(currentPath)!;
    advanceAdaptiveSentinel(currentPath, revised);
    const revisedTasks = readAdaptiveSentinel(currentPath, revised)!;
    const second = revisedTasks.tasks.find(({ kind }) =>
      kind === "review_evidence"
    )!;
    assertEquals(second.nodeId, review.nodeId);
    assertNotEquals(second.id, review.id);
    assertNotEquals(second.observation, review.observation);
    assert(
      revisedTasks.history.some(({ event, taskId }) =>
        event === "reopened" && taskId === second.id
      ),
    );
    assertEquals(
      await readArchivedSentinelSnapshot(
        base,
        "source",
        topology[0].sourceDigests.source,
      ),
      loadSentinelGraph(remote).snapshot(),
    );

    await Deno.writeTextFile(
      remotePath,
      JSON.stringify({ ...revisedRemote, edges: [] }),
    );
    await syncSentinelTopology(base, "main", currentPath);
    const removed = refreshSentinelAssessment(currentPath)!;
    advanceAdaptiveSentinel(currentPath, removed);
    assert(
      !readAdaptiveSentinel(currentPath, removed)?.tasks.some(({ kind }) =>
        kind === "review_evidence"
      ),
    );
    assertEquals(
      readHistoricalAdaptiveSentinel(currentPath, first.revision)?.tasks.find(
        ({ id }) => id === review.id,
      )?.observation,
      review.observation,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
