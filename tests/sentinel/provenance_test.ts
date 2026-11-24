import { assert, assertEquals, assertThrows } from "@std/assert";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  type AdaptiveProvenanceView,
  buildSentinelProvenance,
} from "../../src/sentinel/provenance.ts";

const graph = {
  version: 1,
  nodes: [
    { id: "app", kind: "asset", label: "Application" },
    { id: "db", kind: "asset", label: "Database" },
    {
      id: "finding",
      kind: "finding",
      label: "Missing update",
      severity: "high",
    },
    { id: "evidence", kind: "evidence", label: "Patch inventory record" },
    { id: "control", kind: "control", label: "Package update" },
  ],
  edges: [
    { from: "app", to: "db", relation: "depends_on" },
    { from: "db", to: "app", relation: "depends_on" },
    { from: "finding", to: "app", relation: "affects" },
    { from: "evidence", to: "finding", relation: "supports" },
    { from: "control", to: "finding", relation: "mitigates" },
  ],
};

function assessment() {
  return runSentinelAssessment({
    snapshot: graph,
    evidenceNode: "evidence",
    alerts: [],
  });
}

Deno.test("Sentinel provenance preserves imported edges and connects worker outputs separately", () => {
  const output = buildSentinelProvenance(assessment()).snapshot();
  assertEquals(output.edges.filter((edge) => edge.relation === "supports"), [
    { from: "evidence:evidence", to: "finding:finding", relation: "supports" },
  ]);
  assert(
    output.nodes.some((node) =>
      node.id === "finding:finding" && node.kind === "finding" &&
      node.origin === "imported" && node.severity === "high"
    ),
  );
  assert(
    output.edges.some((edge) =>
      edge.from === "evidence:evidence" && edge.to === "task:assessment:case" &&
      edge.relation === "prompted"
    ),
  );
  assert(output.edges.some((edge) =>
    edge.from === "task:assessment:case" &&
    edge.to === "observation:assessment:assessment:case" &&
    edge.relation === "produces"
  ));
  assert(
    output.edges.some((edge) =>
      edge.from === "observation:assessment:assessment:case" &&
      edge.to === "finding:finding" && edge.relation === "references"
    ),
  );
});

const adaptive: AdaptiveProvenanceView = {
  goal: { id: "review", label: "Review active findings" },
  tasks: [
    {
      id: "review",
      kind: "trace",
      status: "completed",
      prerequisites: [],
      evidenceIds: ["evidence", "not-imported", "finding"],
      observation: {
        relatedNodeIds: ["app", "retired-asset", "app"],
        unrelatedKey: "db",
      },
    },
    {
      id: "coverage",
      kind: "coverage",
      status: "queued",
      prerequisites: ["review"],
      evidenceIds: [],
      observation: { relatedNodeIds: ["db"] },
    },
  ],
};

Deno.test("Sentinel provenance searches operator reviews through the owning finding", () => {
  const graph = buildSentinelProvenance(
    assessment(),
    undefined,
    undefined,
    [],
    [{
      id: 1,
      findingId: "finding",
      revision: 1,
      disposition: "confirmed",
      note: "Verified against audit logs.",
      at: "2026-01-01T00:00:00.000Z",
    }],
  );
  assertEquals(graph.searchNodes("audit logs").map(({ id }) => id), [
    "finding:finding",
  ]);
  assertEquals(graph.searchNodes("confirmed", "asset"), []);
});

Deno.test("Sentinel provenance links a queued task to its explicitly assigned finding", () => {
  const graph = buildSentinelProvenance(assessment(), {
    goal: adaptive.goal,
    tasks: [{
      id: "verify",
      kind: "review_finding",
      status: "queued",
      nodeId: "finding",
      prerequisites: [],
      evidenceIds: [],
    }],
  }).snapshot();
  assert(
    graph.edges.some(({ from, to, relation }) =>
      from === "finding:finding" && to === "task:adaptive:verify" &&
      relation === "prompted"
    ),
  );
});

Deno.test("Sentinel provenance uses explicit adaptive references and tracks unavailable evidence", () => {
  const result = buildSentinelProvenance(assessment(), adaptive).snapshot();
  assert(result.nodes.some((node) => node.id === "task:assessment:coverage"));
  assert(result.nodes.some((node) => node.id === "task:adaptive:coverage"));
  assert(
    result.edges.some((edge) =>
      edge.from === "goal:adaptive:review" &&
      edge.to === "task:adaptive:review" &&
      edge.relation === "requests"
    ),
  );
  assert(
    result.edges.some((edge) =>
      edge.from === "task:adaptive:coverage" &&
      edge.to === "task:adaptive:review" &&
      edge.relation === "requires"
    ),
  );
  assertEquals(
    result.edges.filter((edge) => edge.from === "observation:adaptive:review"),
    [
      {
        from: "observation:adaptive:review",
        to: "asset:app",
        relation: "references",
      },
    ],
  );
  assertEquals(
    result.nodes.some((node) => node.id === "observation:adaptive:coverage"),
    false,
  );
  assertEquals(result.unresolvedReferences, [
    {
      node: "task:adaptive:review",
      reference: "not-imported",
      relation: "prompted",
    },
    {
      node: "task:adaptive:review",
      reference: "finding",
      relation: "prompted",
    },
    {
      node: "observation:adaptive:review",
      reference: "retired-asset",
      relation: "references",
    },
  ]);
});

Deno.test("Sentinel provenance inspects review metadata and unresolved connections", () => {
  const modelReview = {
    taskId: "review",
    summary: "The worker reviewed the inventory.",
    at: "2026-01-01T00:00:00Z",
    steps: [{
      tool: "sentinel_trace",
      target: "app",
      outcome: "returned" as const,
      sourceSnapshots: [{
        caseId: "source-case",
        snapshotDigest: "a".repeat(64),
      }],
    }],
  };
  const graph = buildSentinelProvenance(assessment(), {
    ...adaptive,
    modelReviews: [modelReview],
  });
  const review = graph.inspect("observation:adaptive:review:review")!;
  assert("modelReview" in review.node);
  assertEquals(review.node.modelReview, modelReview);
  assertEquals(graph.searchReviewSteps("a".repeat(64))[0].taskId, "review");
  assert(
    review.connections.some((edge) =>
      edge.kind === "edge" && edge.to === "asset:app"
    ),
  );
  const task = graph.inspect("task:adaptive:review")!;
  assert(
    task.connections.some((entry) =>
      entry.kind === "unresolved" && entry.reference === "not-imported"
    ),
  );
  assertEquals(graph.inspect("missing"), undefined);
});

Deno.test("Sentinel provenance traces cyclic imported edges once with a bounded depth", () => {
  const provenance = buildSentinelProvenance(assessment());
  const trace = provenance.trace("asset:app", 1);
  assertEquals(trace.nodes.map(({ id, distance }) => [id, distance]), [
    ["asset:app", 0],
    ["asset:db", 1],
    ["finding:finding", 1],
  ]);
  assertEquals(trace.edges.length, 3);
  assertEquals(provenance.trace("asset:app", 0).nodes.length, 1);
  assertThrows(() => provenance.trace("asset:app", 17), Error, "depth");
  assertThrows(() => provenance.trace("other:id", 1), Error, "Unknown");
});

Deno.test("Sentinel provenance rejects an adaptive task prerequisite missing from the view", () => {
  assertThrows(
    () =>
      buildSentinelProvenance(assessment(), {
        ...adaptive,
        tasks: [{
          ...adaptive.tasks[0],
          prerequisites: ["unknown-task"],
        }],
      }),
    Error,
    "Missing endpoint",
  );
});

Deno.test("Case alert node identity survives reordered evidence and duplicate input", () => {
  const first = {
    type: "integrity_change",
    severity: "high",
    asset: "app",
    subject: "operator",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: ["operator-log", "evidence"],
  };
  const build = (alerts: unknown[]) =>
    buildSentinelProvenance(
      runSentinelAssessment({ snapshot: graph, alerts }),
    ).snapshot();
  const original = build([first]).nodes.find((node) =>
    "alert" in node && node.alert
  );
  assert(original);
  const newer = {
    ...first,
    observedAt: "2026-01-01T00:00:01.000Z",
    evidenceIds: ["later"],
  };
  const latest = build([
    ...Array(40).fill(newer),
    { ...first, evidenceIds: [...first.evidenceIds].reverse() },
    first,
  ]);
  assertEquals(
    latest.nodes.filter((node) => "alert" in node && node.alert).length,
    2,
  );
  assert(latest.nodes.some((node) => node.id === original.id));
  assert(
    latest.edges.some((edge) =>
      edge.from === original.id && edge.to === "evidence:evidence" &&
      edge.relation === "references"
    ),
  );
});

Deno.test("Provenance search matches structured relationship sources and asset aliases", () => {
  const digest = "b".repeat(64);
  const result = runSentinelAssessment({
    snapshot: {
      version: 1,
      nodes: [
        {
          id: "service",
          kind: "asset",
          label: "Service",
          aliases: ["DNS:original"],
        },
        {
          id: "report",
          kind: "evidence",
          label: "Relationship",
          relationshipSources: [{
            caseId: "reporting-case",
            from: "remote-source",
            to: "remote-target",
            snapshotDigest: digest,
          }],
        },
      ],
      edges: [],
    },
  });
  const provenance = buildSentinelProvenance(result);
  assertEquals(provenance.searchNodes("dns:original").map(({ id }) => id), [
    "asset:service",
  ]);
  for (const query of [digest, "REPORTING-case", "remote-target"]) {
    assertEquals(
      provenance.searchNodes(query, "evidence", "imported").map(({ id }) => id),
      ["evidence:report"],
    );
    assertEquals(provenance.searchNodes(query, "asset"), []);
  }
});

Deno.test("An alert keeps its reported asset ID and links to the unique graph alias", () => {
  const report = runSentinelAssessment({
    snapshot: {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "app" ? { ...node, aliases: ["entra-tenant"] } : node
      ),
    },
  });
  const provenance = buildSentinelProvenance(report, undefined, {
    type: "integrity_change",
    severity: "high",
    asset: "entra-tenant",
    subject: "account",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: ["event"],
  }).snapshot();
  const alert = provenance.nodes.find((node) => "alert" in node && node.alert);
  assert(alert && "alert" in alert);
  assertEquals(alert.alert?.asset, "entra-tenant");
  assert(
    provenance.edges.some(({ from, to, relation }) =>
      from === alert.id && to === "asset:app" && relation === "observed_on"
    ),
  );
});

Deno.test("Incident candidates link their asset, findings and contributing sampled alerts", () => {
  const report = runSentinelAssessment({
    snapshot: graph,
    alerts: [
      {
        type: "network_security_alert",
        severity: "high",
        asset: "app",
        subject: "network",
        observedAt: "2026-01-01T00:00:00.000Z",
        evidenceIds: ["network"],
      },
      {
        type: "authentication_failure_burst",
        severity: "medium",
        asset: "app",
        subject: "account",
        observedAt: "2026-01-01T00:00:01.000Z",
        evidenceIds: ["auth"],
      },
    ],
  });
  const provenance = buildSentinelProvenance(report).snapshot();
  const candidate = provenance.nodes.find((node) =>
    "incident" in node && node.incident
  );
  assert(candidate && "incident" in candidate);
  assertEquals(candidate.incident?.alertCount, 2);
  const withReview = buildSentinelProvenance(report, {
    goal: { id: "goal", label: "Review the incident" },
    tasks: [{
      id: "review",
      kind: "review_incident",
      nodeId: candidate.sourceId,
      status: "completed",
      prerequisites: [],
      evidenceIds: [],
    }],
    modelReviews: [{
      taskId: "review",
      summary: "Reviewed contributing alerts.",
      at: "2026-01-01T00:00:02.000Z",
      steps: [{
        tool: "sentinel_incident_alerts",
        target: candidate.sourceId,
        outcome: "returned",
      }],
    }],
  }).snapshot();
  assert(
    withReview.edges.some(({ from, to, relation }) =>
      from === candidate.id && to === "task:adaptive:review" &&
      relation === "prompted"
    ),
  );
  assert(
    withReview.edges.some(({ from, to, relation }) =>
      from === "observation:adaptive:review:review" && to === candidate.id &&
      relation === "references"
    ),
  );
  const adjacent = provenance.edges.filter(({ from }) => from === candidate.id);
  assert(adjacent.some(({ to }) => to === "asset:app"));
  assert(adjacent.some(({ to }) => to === "finding:finding"));
  assertEquals(
    adjacent.filter(({ to }) =>
      to.startsWith("observation:assessment:case-alert:")
    ).length,
    2,
  );
});
