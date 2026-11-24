import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { planSentinelTasks } from "../../src/sentinel/adaptive_planner.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";

function checkedFinding(
  id: string,
  verification: {
    outcome: "pass" | "fail";
    observedAt: string;
    validUntil: string;
  },
) {
  return {
    nodes: [
      { id, kind: "finding", label: id, severity: "low" },
      { id: `${id}-control`, kind: "control", label: "Known mitigation" },
      { id: `${id}-report`, kind: "evidence", label: "Source finding report" },
      {
        id: `${id}-check`,
        kind: "evidence",
        label: "Control check result",
        controlVerification: verification,
      },
    ],
    edges: [
      { from: `${id}-control`, to: id, relation: "mitigates" },
      { from: `${id}-report`, to: id, relation: "supports" },
      { from: `${id}-check`, to: `${id}-control`, relation: "verifies" },
    ],
  };
}

Deno.test("Stale exact checks rank low findings after failures and high severity but ahead of routine lower-severity work", () => {
  const stale = checkedFinding("stale", {
    outcome: "pass",
    observedAt: "2026-01-01T00:00:00Z",
    validUntil: "2026-11-01T00:00:00Z",
  });
  const failed = checkedFinding("failed", {
    outcome: "fail",
    observedAt: "2026-01-01T00:00:00Z",
    validUntil: "2026-12-01T00:00:00Z",
  });
  const snapshot = {
    version: 1,
    nodes: [
      ...stale.nodes,
      ...failed.nodes,
      { id: "ordinary", kind: "finding", label: "Routine", severity: "medium" },
      {
        id: "critical",
        kind: "finding",
        label: "Critical",
        severity: "critical",
      },
    ],
    edges: [...stale.edges, ...failed.edges],
  };
  const evaluatedAt = "2026-11-24T00:00:00Z";
  const context = {
    version: 1,
    active: true,
    paused: false,
    revision: 1,
    updatedAt: evaluatedAt,
    result: runSentinelAssessment({
      snapshot,
      controlEvaluationAt: evaluatedAt,
    }),
    plan: {},
    reviews: [],
  };
  const tasks = planSentinelTasks(context, []);
  assertEquals(tasks.map(({ nodeId }) => nodeId), [
    "failed",
    "critical",
    "stale",
    "ordinary",
  ]);
  assertEquals(tasks[2].evidenceIds, ["stale-check", "stale-report"]);
  assertEquals(
    planSentinelTasks({ ...context, plan: { traceNode: "stale-check" } }, [])
      .map(({ nodeId, evidenceIds }) => [nodeId, evidenceIds]),
    [["stale", ["stale-check", "stale-report"]]],
  );
});

Deno.test("A passed low-severity control re-enters investigation on expiry without new graph input", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const now = Date.now();
  const validUntil = new Date(now + 60_000).toISOString();
  const source = checkedFinding("affected", {
    outcome: "pass",
    observedAt: new Date(now - 1000).toISOString(),
    validUntil,
  });
  try {
    const serialized = JSON.stringify({ version: 1, ...source });
    await Deno.writeTextFile(path, serialized);
    const initial = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, initial);
    assertEquals(readAdaptiveSentinel(path, initial)?.tasks, []);

    const expired = refreshSentinelAssessment(
      path,
      undefined,
      new Date(validUntil),
    );
    assert(expired && expired.revision === initial.revision + 1);
    assertEquals(await Deno.readTextFile(path), serialized);
    advanceAdaptiveSentinel(path, expired);
    const view = readAdaptiveSentinel(path, expired)!;
    const finding = view.tasks.find(({ kind }) => kind === "review_finding");
    const verify = view.tasks.find(({ kind }) =>
      kind === "verify_control_coverage"
    );
    assert(finding && verify);
    assertEquals(finding.evidenceIds, ["affected-check", "affected-report"]);
    assertEquals(verify.prerequisites, [finding.id]);
    assertEquals(verify.evidenceIds, ["affected-check"]);
    assertEquals(verify.status, "completed");
    assertEquals(
      (verify.observation as { coverage?: string }).coverage,
      "stale",
    );
    assertEquals(view.verificationReviewSources, []);
    assertEquals(
      readHistoricalAdaptiveSentinel(path, initial.revision)?.tasks,
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
