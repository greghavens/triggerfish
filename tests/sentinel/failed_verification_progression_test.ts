import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { planSentinelTasks } from "../../src/sentinel/adaptive_planner.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

const observedAt = "2000-01-01T00:00:00.000Z";
const expiresAt = "2200-01-01T00:00:00.000Z";
const asOf = "2026-11-19T00:00:00.000Z";

function verifiedFinding(
  id: string,
  outcome: "fail" | "pass",
  validUntil = expiresAt,
) {
  return {
    nodes: [
      { id, kind: "finding", label: id, severity: "low" },
      { id: `${id}-control`, kind: "control", label: `Control for ${id}` },
      {
        id: `${id}-check`,
        kind: "evidence",
        label: `Verification for ${id}`,
        controlVerification: { outcome, observedAt, validUntil },
      },
    ],
    edges: [
      { from: `${id}-control`, to: id, relation: "mitigates" },
      { from: `${id}-check`, to: `${id}-control`, relation: "verifies" },
      { from: `${id}-check`, to: id, relation: "supports" },
    ],
  };
}

function snapshot(...findings: ReturnType<typeof verifiedFinding>[]) {
  return {
    version: 1,
    nodes: findings.flatMap(({ nodes }) => nodes),
    edges: findings.flatMap(({ edges }) => edges),
  };
}

function state(input: unknown, traceNode?: string) {
  return {
    plan: traceNode ? { traceNode } : {},
    active: true,
    paused: false,
    revision: 1,
    result: runSentinelAssessment({
      snapshot: input,
      traceNode,
      controlEvaluationAt: asOf,
    }),
    updatedAt: expiresAt,
    reviews: [],
  };
}

Deno.test("A failed verified control prioritizes a supported low-severity finding within case scope", () => {
  const graph = snapshot(
    verifiedFinding("failed", "fail"),
    verifiedFinding("passing", "pass"),
    verifiedFinding("expired", "fail", "2001-01-01T00:00:00Z"),
  );
  const critical = Array.from({ length: 20 }, (_, i) => ({
    id: `ordinary-${i}`,
    kind: "finding",
    label: `High priority ${i}`,
    severity: "critical",
  }));
  const input = { ...graph, nodes: [...graph.nodes, ...critical] };
  const tasks = planSentinelTasks(state(input), []);
  assertEquals(tasks.length, 18);
  assertEquals(tasks[0].nodeId, "failed");
  assertEquals(tasks[0].evidenceIds, ["failed-check"]);
  assert(
    !tasks.some(({ nodeId }) => nodeId === "passing" || nodeId === "expired"),
  );

  const focused = planSentinelTasks(
    state({
      ...input,
      edges: input.edges.filter(({ from, relation }) =>
        from !== "failed-check" || relation !== "supports"
      ),
    }, "failed-check"),
    [],
  );
  assertEquals(focused.map(({ nodeId }) => nodeId), ["failed"]);
});

Deno.test("Completed verification prompts one exact failed-check review with graph provenance", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const source = verifiedFinding("finding", "fail");
  const graph = snapshot(source);
  // Force the verifier's retained result into the gateway's digest fallback.
  const enlarged = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind === "finding" ? { ...node, label: "x".repeat(15_000) } : node
    ),
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(enlarged));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const view = readAdaptiveSentinel(path, state)!;
    const verification = view.tasks.find(({ kind }) =>
      kind === "verify_control_coverage"
    );
    assert(verification);
    assertEquals(verification.status, "completed");
    assert(
      typeof (verification.observation as Record<string, unknown>)
        .resultDigest === "string",
    );

    const evidence = view.tasks.filter(({ kind }) =>
      kind === "review_evidence"
    );
    assertEquals(evidence.length, 1);
    assertEquals(evidence[0].nodeId, "finding-check");
    assertEquals(evidence[0].prerequisites, [verification.id]);
    assertEquals(evidence[0].evidenceIds, ["finding-check"]);
    assertEquals(evidence[0].status, "completed");

    const provenance = buildSentinelProvenance(state.result, view).snapshot();
    const edge = (from: string, relation: string, to: string) =>
      provenance.edges.some((record) =>
        record.from === from && record.relation === relation && record.to === to
      );
    assert(
      edge("evidence:finding-check", "verifies", "control:finding-control"),
    );
    assert(
      edge(
        "evidence:finding-check",
        "prompted",
        `task:adaptive:${evidence[0].id}`,
      ),
    );
    assert(
      edge(
        `task:adaptive:${evidence[0].id}`,
        "requires",
        `task:adaptive:${verification.id}`,
      ),
    );

    const revised = snapshot(verifiedFinding("finding", "pass"));
    assertEquals(
      planSentinelTasks(
        {
          ...state,
          result: runSentinelAssessment({
            snapshot: revised,
            controlEvaluationAt: asOf,
          }),
        },
        [verification],
        view.revision,
      ).filter(({ kind }) => kind === "review_evidence"),
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
