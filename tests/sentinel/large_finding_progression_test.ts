import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { planSentinelTasks } from "../../src/sentinel/adaptive_planner.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";

Deno.test("A persisted large finding review still schedules exact evidence and impact follow-ups", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const asset = `a${"0".repeat(4_000)}`;
  const evidence = [
    `e${"0".repeat(4_000)}`,
    `e${"1".repeat(4_000)}`,
  ];
  const nodes = [
    { id: asset, kind: "asset", label: "Service" },
    ...evidence.map((id) => ({ id, kind: "evidence", label: "Source record" })),
    {
      id: "finding",
      kind: "finding",
      label: `Broad finding: ${"x".repeat(15_000)}`,
      severity: "high",
    },
  ];
  const snapshot = {
    version: 1,
    nodes,
    edges: [
      ...evidence.map((id) => ({
        from: id,
        to: "finding",
        relation: "supports",
      })),
      { from: "finding", to: asset, relation: "affects" },
    ],
  };

  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const { revision, tasks } = readAdaptiveSentinel(path, state)!;
    const review = tasks.find(({ kind }) => kind === "review_finding");
    assert(review);
    assertEquals(review.status, "completed");
    assert(review.observation && typeof review.observation === "object");
    const truncated = review.observation as Record<string, unknown>;
    assertEquals(truncated.finding, undefined);
    assert(typeof truncated.resultDigest === "string");

    const dependents = tasks.filter(({ prerequisites }) =>
      prerequisites.includes(review.id)
    );
    assertEquals(dependents.map(({ kind, nodeId }) => [kind, nodeId]).sort(), [
      ["review_evidence", evidence[0]],
      ["review_evidence", evidence[1]],
      ["trace", asset],
      ["verify_control_coverage", "finding"],
    ]);
    assert(dependents.every(({ status }) => status === "completed"));

    const stale = {
      ...state,
      result: runSentinelAssessment({
        snapshot: {
          ...snapshot,
          nodes: nodes.map((node) =>
            node.kind === "finding"
              ? { ...node, label: "Different revision" }
              : node
          ),
        },
      }),
    };
    // Even if handed the old assignment revision, a changed source cannot fill in
    // facts for an oversized review without matching the original worker digest.
    assertEquals(planSentinelTasks(stale, [review], revision), []);
    assertEquals(
      planSentinelTasks(state, [{
        ...review,
        observation: { ...truncated, resultDigest: "0".repeat(64) },
      }], revision),
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
