import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  registerSentinelGoalCompletion,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const NOW = "2026-11-05T11:00:00Z";
const before = "2026-11-01T11:00:00Z";
const expires = "2026-11-06T11:00:00Z";
const ancient = "2000-01-01T00:00:00Z";
const distant = "2200-01-01T00:00:00Z";

function finding(id: string) {
  return { id, kind: "finding", label: id, severity: "high" };
}

function control(id: string) {
  return { id, kind: "control", label: id };
}

function evidence(
  id: string,
  outcome: "pass" | "fail",
  observedAt: string,
  validUntil: string,
) {
  return {
    id,
    kind: "evidence",
    label: id,
    controlVerification: { outcome, observedAt, validUntil },
  };
}

function verifies(from: string, to: string) {
  return { from, relation: "verifies", to };
}

function mitigates(from: string, to: string) {
  return { from, relation: "mitigates", to };
}

Deno.test("Control coverage uses the latest exact verification eligible for the requested time", () => {
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      finding("finding"),
      control("control"),
      evidence("prior", "pass", ancient, distant),
      evidence("pass-tie", "pass", before, expires),
      evidence("fail-tie", "fail", before, expires),
      evidence("future", "pass", expires, distant),
    ],
    edges: [
      mitigates("control", "finding"),
      ...["prior", "pass-tie", "fail-tie", "future"].map((id) =>
        verifies(id, "control")
      ),
    ],
  });
  const current = graph.controlCoverage("finding", NOW);
  assertEquals(current.status, "fail");
  assertEquals(current.controls[0].evidenceId, "fail-tie");
  assertEquals(current.asOf, "2026-11-05T11:00:00.000Z");
  assertEquals(
    current.controls[0].verification?.observedAt,
    "2026-11-01T11:00:00.000Z",
  );
  assertEquals(graph.controlCoverage("finding", expires).status, "pass");
  assertEquals(
    graph.controlCoverage("finding", "1999-01-01T00:00:00Z").status,
    "unverified",
  );
  assertEquals(graph.controlCoverage("finding", distant).status, "stale");
  assertEquals(graph.coverage(NOW).findings[0].controlVerification, current);
  assertEquals(graph.coverage().findings[0].controlVerification, undefined);
  assertEquals(
    graph.trace("control", 1).edges.filter(({ relation }) =>
      relation === "verifies"
    ).length,
    4,
  );
  assertEquals(
    loadSentinelGraph(graph.snapshot()).controlCoverage("finding", NOW),
    current,
  );
});

Deno.test("Control coverage never treats a linked but unverified mitigation as passing", () => {
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      finding("none"),
      finding("both"),
      control("first"),
      control("second"),
      evidence("test", "pass", before, expires),
    ],
    edges: [
      mitigates("first", "both"),
      mitigates("second", "both"),
      verifies("test", "first"),
    ],
  });

  assertEquals(graph.controlCoverage("none", NOW).status, "no_control_link");
  assertEquals(graph.controlCoverage("both", NOW).status, "unverified");
  assertEquals(
    graph.controlCoverage("both", NOW).controls.map(({ status }) => status),
    ["pass", "unverified"],
  );
});

Deno.test("Control verification rejects untyped links, invalid dates, and invalid outcomes", () => {
  const record = evidence("record", "pass", before, expires);
  const plain = { id: "record", kind: "evidence", label: "record" };
  const graph = (node: object) => ({
    version: 1,
    nodes: [control("control"), node],
    edges: [verifies("record", "control")],
  });
  assertThrows(
    () => loadSentinelGraph(graph(plain)),
    Error,
    "requires control verification",
  );
  assertThrows(
    () => loadSentinelGraph(graph({ ...record, kind: "control" })),
    Error,
    "belongs on an evidence node",
  );
  assertThrows(
    () =>
      loadSentinelGraph(
        graph(evidence("record", "pass", "2026-02-30T11:00:00Z", before)),
      ),
    Error,
    "calendar timestamp",
  );
  assertThrows(
    () => loadSentinelGraph(graph(evidence("record", "pass", expires, before))),
    Error,
    "must end after observation",
  );
  assertThrows(
    () =>
      loadSentinelGraph(graph({
        ...record,
        controlVerification: {
          ...record.controlVerification,
          outcome: "unknown",
        },
      })),
    Error,
    "Invalid Sentinel control outcome",
  );
});

Deno.test("Adaptive verification follows recorded failure, stale and unverified results with citations", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const expected = ["fail", "pass", "stale", "unverified"];
  const graph = {
    version: 1,
    nodes: [
      ...expected.map(finding),
      ...expected.map((status) => control(`control-${status}`)),
      evidence("evidence-fail", "fail", ancient, distant),
      evidence("evidence-pass", "pass", ancient, distant),
      evidence("evidence-stale", "pass", ancient, "2000-01-02T00:00:00Z"),
    ],
    edges: [
      ...expected.map((status) => mitigates(`control-${status}`, status)),
      ...expected.slice(0, 3).map((status) =>
        verifies(`evidence-${status}`, `control-${status}`)
      ),
    ],
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const { tasks } = readAdaptiveSentinel(path, state)!;
    const reviews = tasks.filter(({ kind }) =>
      kind === "verify_control_coverage"
    );
    assertEquals(reviews.map(({ nodeId }) => nodeId).sort(), [
      "fail",
      "stale",
      "unverified",
    ]);
    for (const task of reviews) {
      assertEquals(task.status, "completed");
      assertEquals(task.prerequisites.length, 1);
      const observation = task.observation as Record<string, unknown>;
      assertEquals(observation.coverage, task.nodeId);
      const id = `evidence-${task.nodeId}`;
      assert(Array.isArray(observation.relatedNodeIds));
      if (task.nodeId === "unverified") assertEquals(task.evidenceIds, []);
      else {
        assertEquals(task.evidenceIds, [id]);
        assert(observation.relatedNodeIds.includes(id));
      }
    }
    const store = openSentinelAdaptiveStore(
      join(directory, "sentinel-adaptive.db"),
    );
    try {
      const revision = adaptiveRevision(state);
      const goal = registerSentinelGoalCompletion(
        path,
        expected.map((id) => ({
          id,
          description: "Verify that all linked controls passed",
          source: "adaptive_task" as const,
          reference: `task:verify_control_coverage:pass:${id}`,
        })),
        "automatic",
      );
      store.sync(revision, [{
        kind: "verify_control_coverage",
        nodeId: "pass",
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const completed = store.list(revision).filter(({ kind }) =>
        kind === "verify_control_coverage"
      );
      assertEquals(completed.length, 4);
      const observations = completed.map((task) => ({
        criterionId: task.nodeId!,
        evidence: [{
          source: "adaptive_task",
          reference: task.id,
          detail: "Control coverage checked",
        }],
      }));
      const pass = observations.find(({ criterionId }) =>
        criterionId === "pass"
      );
      assert(pass);
      const report = reportSentinelGoalCompletion(path, goal.scope, [
        ...observations,
        { ...pass, criterionId: "fail" },
      ]);
      assertEquals(report.assessmentCompleted, false);
      assertEquals(report.record.status, "open");
      assertEquals(
        report.record.observations.map(({ criterionId, evidence }) => ({
          criterionId,
          references: evidence.map(({ reference }) => reference),
        })),
        [{ criterionId: "pass", references: [pass.evidence[0].reference] }],
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
