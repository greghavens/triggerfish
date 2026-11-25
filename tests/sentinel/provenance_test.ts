import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import { join } from "@std/path";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  type AdaptiveProvenanceView,
  buildSentinelProvenance,
  sentinelAlertProvenanceId,
} from "../../src/sentinel/provenance.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

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

Deno.test("Adaptive fact satisfaction resolves only the exact saved source observation", () => {
  const source = {
    id: "source-trace",
    kind: "trace",
    status: "completed",
    depth: 1,
    nodeId: "evidence",
    prerequisites: [],
    evidenceIds: [],
    observation: { relatedNodeIds: ["evidence", "finding"] },
  };
  const target = {
    ...source,
    id: "policy-review",
    kind: "review_evidence",
    factSatisfaction: {
      sourceTaskId: source.id,
      sourceObservationSha256: createHash("sha256")
        .update(JSON.stringify(source.observation)).digest("hex"),
    },
  };
  const targetId = "task:adaptive:policy-review";
  const sourceId = "observation:adaptive:source-trace";
  function inspect(tasks: AdaptiveProvenanceView["tasks"]) {
    return buildSentinelProvenance(assessment(), {
      goal: { id: "goal", label: "Verify evidence" },
      tasks,
    }).inspect(targetId)!;
  }
  const exact = inspect([target, source]);
  assert("factSatisfaction" in exact.node);
  assertEquals(exact.node.factSatisfaction, target.factSatisfaction);
  assert(
    exact.connections.some((edge) =>
      edge.kind === "edge" && edge.from === targetId && edge.to === sourceId &&
      edge.relation === "references"
    ),
  );
  for (
    const tasks of [
      [target],
      [target, { ...source, depth: 2 }],
      [target, { ...source, nodeId: "finding" }],
      [target, { ...source, status: "queued" }],
      [target, { ...source, kind: "impact" }],
      [target, { ...source, observation: { relatedNodeIds: ["finding"] } }],
    ]
  ) {
    const rejected = inspect(tasks);
    assertEquals("factSatisfaction" in rejected.node, false);
    assertEquals(
      rejected.connections.some((edge) =>
        edge.kind === "edge" && edge.to === sourceId
      ),
      false,
    );
  }
});

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

Deno.test("Saved assigned-target reads resolve the exact task anchor despite a colliding ID prefix", () => {
  const prefix = "asset:".padEnd(256, "a");
  const assigned = `${prefix}:assigned`;
  const inventory = runSentinelAssessment({
    snapshot: {
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: prefix, kind: "asset", label: "Prefix collision" },
        { id: assigned, kind: "asset", label: "Assigned target" },
      ],
    },
  });
  const output = buildSentinelProvenance(inventory, {
    ...adaptive,
    tasks: adaptive.tasks.map((task) =>
      task.id === "review" ? { ...task, nodeId: assigned } : task
    ),
    modelReviews: [{
      taskId: "review",
      summary: "Reviewed the assigned target.",
      at: "2026-01-01T00:00:00Z",
      steps: [
        {
          tool: "sentinel_assigned_target",
          target: prefix,
          outcome: "returned",
        },
        {
          tool: "sentinel_assigned_target",
          target: "app",
          outcome: "returned",
          targetRef: "asset:app",
        },
        {
          tool: "sentinel_assigned_target",
          target: prefix,
          outcome: "error",
        },
      ],
    }],
  });
  const reviewId = "observation:adaptive:review:review";
  const exactRef = `asset:${assigned}`;
  const steps = output.searchReviewSteps("sentinel_assigned_target", "review");
  assertEquals(
    steps.map(({ index, reviewId, targetRef }) => ({
      index,
      reviewId,
      targetRef,
    })),
    [
      { index: 0, reviewId, targetRef: exactRef },
      { index: 1, reviewId, targetRef: undefined },
      { index: 2, reviewId, targetRef: undefined },
    ],
  );
  assertEquals(
    output.snapshot().edges.filter(({ from }) => from === reviewId),
    [{ from: reviewId, to: exactRef, relation: "references" }],
  );
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

Deno.test("Sentinel links a successful follow-up to the exact fan-out in the assigned evidence", () => {
  const sourceReference = `source:${"a".repeat(64)}`;
  const detector = createTelemetryDetector();
  const evidence = Array.from({ length: 6 }, (_, i) => ({
    version: 1,
    id: `entra:fixture-${i}`,
    timestamp: `2026-01-01T00:00:0${i}.000Z`,
    asset: "app",
    subject: i === 5 ? "account-0" : `account-${i}`,
    kind: i === 5 ? "auth_success" : "auth_failure",
    sourceReference,
  }));
  const [fanout, followUp] = evidence.flatMap(detector.ingest);
  assertEquals(fanout.type, "authentication_failure_fanout");
  assertEquals(followUp.type, "authentication_success_after_fanout");
  const from = sentinelAlertProvenanceId(followUp);
  const to = sentinelAlertProvenanceId(fanout);
  const build = (alerts: readonly typeof fanout[]) =>
    buildSentinelProvenance(
      runSentinelAssessment({ snapshot: graph, alerts }),
      undefined,
      followUp,
    );
  assert(
    build([followUp, fanout]).inspect(from)?.connections.some((edge) =>
      edge.kind === "edge" && edge.from === from && edge.to === to &&
      edge.relation === "references"
    ),
  );
  for (
    const alerts of [
      [],
      [{ ...fanout, asset: "db" }],
      [{ ...fanout, evidenceIds: fanout.evidenceIds.toReversed() }],
      [{ ...fanout, observedAt: followUp.observedAt }],
      [{ ...fanout, observedAt: "2026-01-01T00:06:00.000Z" }],
      [{ ...fanout, observedAt: "2025-12-31T23:55:00.000Z" }],
      [{
        ...fanout,
        subject: `source:${"b".repeat(64)}`,
        sourceReference: `source:${"b".repeat(64)}`,
      }],
    ]
  ) {
    assertEquals(
      build(alerts).inspect(from)?.connections.some((edge) =>
        edge.kind === "edge" && edge.from === from && edge.to === to
      ),
      false,
    );
  }
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

Deno.test("Saved worker trace provenance resolves exact steps independent of review order and imported ID collisions", () => {
  const caller = `adaptive:${"a".repeat(64)}`;
  const source = `adaptive:${"b".repeat(64)}`;
  const sourceRef = `observation:adaptive:review:${source}`;
  const callerRef = `observation:adaptive:review:${caller}`;
  const inventory = runSentinelAssessment({
    snapshot: {
      ...graph,
      nodes: [...graph.nodes, {
        id: sourceRef,
        kind: "asset",
        label: "Colliding imported asset",
      }],
    },
  });
  const recorded = {
    sourceTaskId: source,
    evidenceRevision: 4,
    stepIndices: [1],
  };
  const when = "2026-01-01T00:00:00Z";
  const output = buildSentinelProvenance(inventory, {
    evidenceRevision: 4,
    goal: adaptive.goal,
    tasks: [caller, source].map((id) => ({
      id,
      kind: "trace",
      status: "completed",
      prerequisites: [],
      evidenceIds: [],
    })),
    modelReviews: [
      {
        taskId: caller,
        summary: "Consulted an exact saved review step.",
        at: when,
        steps: [
          {
            tool: "sentinel_worker_trace_search",
            target: sourceRef,
            outcome: "returned",
            workerTrace: recorded,
          },
          {
            tool: "sentinel_worker_trace_search",
            target: sourceRef,
            outcome: "returned",
            workerTrace: { ...recorded, evidenceRevision: 3 },
          },
          {
            tool: "sentinel_worker_trace_search",
            target: sourceRef,
            outcome: "returned",
            workerTrace: { ...recorded, stepIndices: [10] },
          },
          {
            tool: "sentinel_worker_trace_search",
            target: sourceRef,
            outcome: "returned",
          },
        ],
      },
      {
        taskId: source,
        summary: "Saved source review.",
        at: when,
        steps: [
          { tool: "sentinel_trace", target: "app", outcome: "returned" },
          { tool: "sentinel_trace", target: "db", outcome: "returned" },
        ],
      },
    ],
  });
  const projected = output.searchReviewSteps(
    "sentinel_worker_trace_search",
    caller,
  );
  assertEquals(
    projected.map(({ workerTrace, targetRef }) => ({ workerTrace, targetRef })),
    [
      { workerTrace: recorded, targetRef: sourceRef },
      {
        workerTrace: { ...recorded, evidenceRevision: 3 },
        targetRef: undefined,
      },
      { workerTrace: { ...recorded, stepIndices: [10] }, targetRef: undefined },
      { workerTrace: undefined, targetRef: undefined },
    ],
  );
  assertEquals(
    output.snapshot().edges.filter(({ from }) => from === callerRef),
    [{
      from: callerRef,
      to: sourceRef,
      relation: "references",
    }],
  );
});

Deno.test("Worker trace citations survive a committed review and database restart", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "adaptive.sqlite");
  const revision = "evidence:20";
  try {
    const store = openSentinelAdaptiveStore(path);
    try {
      const [sourceTask, consumingTask] = store.sync(
        revision,
        ["app", "db"].map((nodeId) => ({
          kind: "trace",
          nodeId,
          reason: "fixture",
        })),
      );
      for (const { id } of [sourceTask, consumingTask]) {
        assert(store.prioritize(revision, id));
        const lease = store.claim(revision)!;
        store.complete({
          taskId: id,
          leaseToken: lease.leaseToken,
          observation: {},
        });
        const review = store.claimModelReview(revision, "fixture")!;
        assertEquals(review.task.id, id);
        const steps = id === sourceTask.id
          ? [{
            tool: "sentinel_trace",
            outcome: "returned" as const,
            target: "app",
          }]
          : [{
            tool: "sentinel_worker_trace_search",
            outcome: "returned" as const,
            workerTrace: {
              sourceTaskId: sourceTask.id,
              evidenceRevision: 20,
              stepIndices: [0],
            },
          }];
        assert(
          store.finishModelReview(revision, id, review.token, {
            note: "Saved",
            steps,
          }),
        );
      }
    } finally {
      store.close();
    }
    const reopened = openSentinelAdaptiveStore(path);
    try {
      const provenance = buildSentinelProvenance(assessment(), {
        evidenceRevision: 20,
        goal: adaptive.goal,
        tasks: reopened.list(revision),
        modelReviews: reopened.modelReviewNotes(revision),
      });
      const [exact] = provenance.searchReviewSteps(
        "sentinel_worker_trace_search",
      );
      assertEquals(exact.workerTrace?.evidenceRevision, 20);
      assertEquals(exact.workerTrace?.stepIndices, [0]);
      assertEquals(
        exact.targetRef,
        `observation:adaptive:review:${exact.workerTrace?.sourceTaskId}`,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Intermediate workflow observations keep exact producer and peer-review lineage before completion", () => {
  const evidenceRevision = 3;
  const revision = "assignment-revision";
  const source = {
    id: "source-task",
    revision,
    nodeId: "app",
    kind: "trace",
    status: "completed",
    prerequisites: [],
    evidenceIds: [],
  };
  const peer = { ...source, id: "peer-task", kind: "impact" };
  const runs = [{ id: 51, status: "completed", conclusion: "failure" }];
  const receipt = {
    repository: "example/pipeline",
    workflowId: 17,
    connectorId: "github-actions",
    observedAt: "2026-11-01T00:00:00.000Z",
    evidenceRevision,
    resultSha256: createHash("sha256").update(JSON.stringify(runs)).digest(
      "hex",
    ),
    runs,
  };
  const stepIndex = 2;
  const observationId = "workflow-observation:" +
    createHash("sha256").update(JSON.stringify([
      revision,
      source.id,
      source.nodeId,
      evidenceRevision,
      stepIndex,
      receipt,
    ])).digest("hex");
  const observation = {
    id: observationId,
    taskId: source.id,
    targetId: source.nodeId,
    evidenceRevision,
    stepIndex,
    receipt,
  };
  const citation = {
    observationId,
    sourceTaskId: source.id,
    targetId: source.nodeId,
    evidenceRevision,
    resultSha256: receipt.resultSha256,
  };
  const step = {
    tool: "sentinel_intermediate_workflow_observation",
    target: observationId,
    outcome: "returned" as const,
    intermediateWorkflowObservation: citation,
  };
  const view: AdaptiveProvenanceView = {
    goal: { id: "goal", label: "Review workflow evidence" },
    evidenceRevision,
    tasks: [source, peer],
    modelReviews: [{
      taskId: peer.id,
      summary: "Inspected the stored workflow status.",
      at: receipt.observedAt,
      steps: [step],
    }],
    workflowObservations: [observation],
  };
  const sourceRef = `observation:adaptive:${observationId}`;
  const peerRef = `observation:adaptive:review:${peer.id}`;
  for (const status of ["running", "interrupted"]) {
    const graph = buildSentinelProvenance(assessment(), {
      ...view,
      modelReviewStates: [{ taskId: source.id, status }],
    });
    const exact = graph.inspect(sourceRef);
    assert(exact?.node && "workflowObservation" in exact.node);
    assertEquals(exact.node.status, status);
    assertEquals(exact.node.workflowObservation?.stepIndex, 2);
    assertEquals(exact.node.githubWorkflowRead, receipt);
    assert(
      exact.connections.some((edge) =>
        edge.kind === "edge" && edge.from === "task:adaptive:source-task" &&
        edge.relation === "produces"
      ),
    );
    assert(
      exact.connections.some((edge) =>
        edge.kind === "edge" && edge.from === peerRef &&
        edge.relation === "references"
      ),
    );
    assertEquals(
      graph.inspect("observation:adaptive:review:source-task"),
      undefined,
    );
  }

  for (
    const invalid of [
      { ...step, target: "wrong-target" },
      { ...step, outcome: "error" as const },
      {
        ...step,
        intermediateWorkflowObservation: { ...citation, sourceTaskId: peer.id },
      },
      {
        ...step,
        intermediateWorkflowObservation: { ...citation, evidenceRevision: 2 },
      },
      {
        ...step,
        intermediateWorkflowObservation: {
          ...citation,
          resultSha256: "0".repeat(64),
        },
      },
    ]
  ) {
    const graph = buildSentinelProvenance(assessment(), {
      ...view,
      modelReviews: [{ ...view.modelReviews![0], steps: [invalid] }],
    });
    const exact = graph.inspect(sourceRef);
    assert(exact);
    assertEquals(
      exact.connections.some((edge) =>
        edge.kind === "edge" && edge.from === peerRef
      ),
      false,
    );
  }
  for (
    const invalid of [
      { ...observation, evidenceRevision: 2 },
      { ...observation, stepIndex: 1 },
      { ...observation, targetId: "db" },
      { ...observation, receipt: { ...receipt, resultSha256: "0".repeat(64) } },
    ]
  ) {
    const graph = buildSentinelProvenance(assessment(), {
      ...view,
      workflowObservations: [invalid],
    });
    assertEquals(graph.inspect(sourceRef), undefined);
  }
});
