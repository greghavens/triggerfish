import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";

const base = {
  version: 1,
  nodes: [
    { id: "db", kind: "asset", label: "Database" },
    {
      id: "audit",
      kind: "finding",
      label: "Missing audit logging",
      severity: "high",
    },
    { id: "record", kind: "evidence", label: "Audit record" },
  ],
  edges: [{ from: "audit", to: "db", relation: "affects" }],
};
const full = {
  ...base,
  nodes: [...base.nodes, { id: "web", kind: "asset", label: "Web frontend" }],
  edges: [
    ...base.edges,
    { from: "record", to: "audit", relation: "supports" },
    { from: "web", to: "db", relation: "depends_on" },
  ],
};
const alerts = [
  {
    type: "endpoint_execution_alert",
    severity: "high",
    asset: "db",
    subject: "endpoint",
    observedAt: "2026-11-24T12:34:56.000Z",
    evidenceIds: ["endpoint:1"],
  },
  {
    type: "network_security_alert",
    severity: "high",
    asset: "db",
    subject: "network",
    observedAt: "2026-11-24T12:35:00.000Z",
    evidenceIds: ["network:2"],
  },
];

Deno.test("Assessment waits for exact graph nodes and supporting evidence edges", () => {
  const choices = {
    impactAsset: "web",
    traceNode: "audit",
    evidenceNode: "record",
  };
  const earlier = runSentinelAssessment({ snapshot: base, alerts, ...choices });
  assertEquals(
    earlier.tasks.map(({ id, status, reason }) => [id, status, reason]),
    [
      ["coverage", "completed", undefined],
      ["defense_coverage", "completed", undefined],
      ["impact", "waiting", "selected_asset_missing"],
      ["trace", "completed", undefined],
      ["case", "waiting", "supporting_evidence_missing"],
      ["incident_correlation", "waiting", "prerequisite_pending"],
    ],
  );

  const updated = runSentinelAssessment({
    snapshot: full,
    alerts,
    ...choices,
    previous: earlier,
  });
  assertEquals(updated.summary, { completed: 6, waiting: 0, skipped: 0 });
  assertEquals(updated.transitions, [
    { task: "impact", from: "waiting", to: "completed" },
    { task: "case", from: "waiting", to: "completed" },
    { task: "incident_correlation", from: "waiting", to: "completed" },
  ]);
  assertNotEquals(updated.revision, earlier.revision);
  assertEquals(updated.previousRevision, earlier.revision);
  assertEquals<unknown>(updated.sharedGraph.snapshot, full);
  assertEquals(updated.sharedGraph.observations.map(({ id }) => id), [
    "assessment:coverage",
    "assessment:defense_coverage",
    "assessment:impact",
    "assessment:trace",
    "assessment:case",
    "assessment:incident_correlation",
  ]);
  assertEquals(updated.sharedGraph.observations.at(-1)?.facts.summary, {
    inputAlerts: 2,
    distinctAlerts: 2,
    candidates: 1,
    correlatedAlerts: 2,
    uncorrelatedAlerts: 0,
    duplicateAlerts: 0,
  });
});

Deno.test("Assessment keeps a stable revision and reevaluates removed evidence", () => {
  const selected = { impactAsset: "db", evidenceNode: "record" };
  const first = runSentinelAssessment({
    snapshot: full,
    alerts: [],
    ...selected,
  });
  const same = runSentinelAssessment({
    snapshot: full,
    alerts: [],
    ...selected,
    previous: JSON.parse(JSON.stringify(first)),
  });
  assertEquals(same.revision, first.revision);
  assertEquals(same.transitions, []);

  const changed = runSentinelAssessment({
    snapshot: base,
    ...selected,
    previous: same,
  });
  assertEquals(changed.transitions, [
    { task: "defense_coverage", from: "completed", to: "waiting" },
    { task: "case", from: "completed", to: "waiting" },
    { task: "incident_correlation", from: "completed", to: "waiting" },
  ]);
  assertEquals(changed.sharedGraph.observations.map(({ task }) => task), [
    "coverage",
    "impact",
  ]);
});

Deno.test("Assessment validates inputs and distinguishes absent graphs and feeds", () => {
  assertEquals(runSentinelAssessment().summary, {
    completed: 0,
    waiting: 4,
    skipped: 2,
  });
  assertEquals(runSentinelAssessment({ alerts: [] }).summary, {
    completed: 1,
    waiting: 3,
    skipped: 2,
  });
  assertThrows(() => runSentinelAssessment({ depth: 17 }), Error, "depth");
  assertThrows(
    () => runSentinelAssessment({ alerts: [{}] }),
    Error,
    "alert at record 1",
  );
  assertThrows(
    () => runSentinelAssessment({ previous: { version: 1 } }),
    Error,
    "prior",
  );
});
