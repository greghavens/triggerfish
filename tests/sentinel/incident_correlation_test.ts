import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { planSentinelTasks } from "../../src/sentinel/adaptive_planner.ts";
import {
  readSavedSentinelIncident,
  readSavedSentinelIncidentPage,
  renderSavedSentinelIncidentJson,
} from "../../src/sentinel/incident_archive.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  correlateSentinelIncidents,
  resolveSentinelIncidentAlerts,
} from "../../src/sentinel/incident_correlation.ts";
import {
  createTelemetryDetector,
  sentinelAlertReference,
  type TelemetryAlert,
  telemetryAlertSeverities,
} from "../../src/sentinel/telemetry.ts";

const epoch = Date.parse("2026-01-01T00:00:00Z");

function alert(
  type: TelemetryAlert["type"],
  seconds: number,
  evidenceIds: readonly string[],
  asset = "server",
): TelemetryAlert {
  return {
    type,
    severity: telemetryAlertSeverities[type],
    asset,
    subject: "test",
    observedAt: new Date(epoch + seconds * 1000).toISOString(),
    evidenceIds,
  };
}

Deno.test("Sentinel groups bounded distinct evidence and preserves original event record references", () => {
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      { id: "server", kind: "asset", label: "Application server" },
      { id: "other", kind: "asset", label: "Other server" },
      { id: "F-1", kind: "finding", label: "Missing update", severity: "high" },
    ],
    edges: [
      { from: "F-1", to: "server", relation: "affects" },
      { from: "other", to: "server", relation: "depends_on" },
    ],
  });
  const inputs = [
    alert("network_security_alert", 301, ["net"]),
    alert("authentication_failure_burst", 299, ["auth-1", "auth-2"]),
    alert("authentication_failure_burst", 0, ["old"]),
    alert("authentication_failure_burst", 300, ["auth-2", "auth-1"]),
    alert("endpoint_execution_alert", 301, ["endpoint"], "other"),
  ];
  const report = correlateSentinelIncidents(inputs, {
    graph,
    windowSeconds: 300,
  });
  assertEquals(report.summary, {
    inputAlerts: 5,
    distinctAlerts: 4,
    candidates: 1,
    correlatedAlerts: 2,
    uncorrelatedAlerts: 2,
    duplicateAlerts: 1,
  });
  const [candidate] = report.candidates;
  assertEquals(candidate.asset, "server");
  assertEquals(candidate.status, "requires_review");
  assertEquals(candidate.findingIds, ["F-1"]);
  assertEquals(candidate.signals, ["authentication", "network"]);
  assertEquals(candidate.alerts.map((alert) => alert.sourceRecord), [2, 1]);
  assertEquals(candidate.evidenceIds, ["auth-1", "auth-2", "net"]);
  assertEquals(report.duplicateAlerts, [{ sourceRecord: 4, duplicateOf: 2 }]);
  assertEquals(report.uncorrelatedAlerts.map((alert) => alert.sourceRecord), [
    3,
    5,
  ]);
  assertEquals(
    correlateSentinelIncidents([...inputs].reverse(), { graph }).candidates[0]
      .id,
    candidate.id,
  );
});

Deno.test("Sentinel requires different signal classes with class-specific evidence", () => {
  const inputs = [
    alert("authentication_success_after_failures", 0, ["auth-ok"]),
    alert("authentication_failure_burst", 1, ["shared", "auth"]),
    alert("integrity_change", 2, ["shared"]),
    alert("endpoint_execution_alert", 3, ["endpoint"]),
  ];
  assertEquals(
    correlateSentinelIncidents(inputs.slice(0, 3)).candidates.length,
    0,
  );
  const [candidate] = correlateSentinelIncidents(inputs).candidates;
  assertEquals(candidate.signals, ["authentication", "endpoint"]);
  assertEquals(candidate.gaps, [
    "source_independence_unverified",
    "sequence_and_attribution_unverified",
    "graph_context_not_provided",
  ]);
});

Deno.test("Sentinel caps each individual window without transitive chaining", () => {
  const alerts = [
    alert("network_security_alert", 0, ["network"]),
    alert("cloud_security_alert", 30, ["cloud"]),
    alert("endpoint_execution_alert", 31, ["endpoint"]),
    alert("sensitive_egress_alert", 61, ["egress"]),
  ];
  const report = correlateSentinelIncidents(alerts, { windowSeconds: 30 });
  assertEquals(
    report.candidates.map(({ alerts }) =>
      alerts.map(({ sourceRecord }) => sourceRecord)
    ),
    [
      [1, 2],
      [3, 4],
    ],
  );
});

Deno.test("Sentinel validates correlation options and alert records", () => {
  assertThrows(
    () => correlateSentinelIncidents([], { windowSeconds: 0 }),
    Error,
    "1 to 86400",
  );
  assertThrows(() => correlateSentinelIncidents([null]), Error, "record 1");
});

Deno.test("Incident correlation resolves unique aliases and retains collector asset IDs", () => {
  const graph = loadSentinelGraph({
    version: 1,
    nodes: [
      {
        id: "server",
        kind: "asset",
        label: "Server",
        aliases: ["sensor-host", "shared", "other"],
      },
      { id: "other", kind: "asset", label: "Other", aliases: ["shared"] },
      { id: "finding", kind: "finding", label: "Finding", severity: "medium" },
    ],
    edges: [{ from: "finding", to: "server", relation: "affects" }],
  });
  const report = correlateSentinelIncidents([
    alert("authentication_failure_burst", 0, ["auth"]),
    alert("network_security_alert", 1, ["net"], "sensor-host"),
    alert("endpoint_execution_alert", 2, ["ambiguous"], "shared"),
    alert("endpoint_execution_alert", 3, ["other"], "other"),
    alert("network_security_alert", 4, ["net"], "server"),
  ], { graph });
  assertEquals(report.candidates.length, 1);
  const [candidate] = report.candidates;
  assertEquals(candidate.asset, "server");
  assertEquals(candidate.reportedAssets, ["sensor-host", "server"]);
  assertEquals(candidate.alerts.map(({ asset }) => asset), [
    "server",
    "sensor-host",
  ]);
  assertEquals(candidate.findingIds, ["finding"]);
  assertEquals(report.uncorrelatedAlerts.map(({ asset }) => asset), [
    "shared",
    "other",
  ]);
  assertEquals(report.duplicateAlerts, [{ sourceRecord: 5, duplicateOf: 2 }]);
});

Deno.test("Saved incident membership resolves exact references in recorded order", () => {
  const first = alert(
    "authentication_failure_burst",
    1,
    ["auth"],
    "collector-app",
  );
  const second = alert("network_security_alert", 2, ["net"]);
  const unrelated = alert("endpoint_execution_alert", 3, ["endpoint"]);
  const duplicate = {
    ...first,
    observedAt: new Date(epoch + 10_000).toISOString(),
  };
  const resolved = resolveSentinelIncidentAlerts(
    [duplicate, unrelated, second, first],
    [sentinelAlertReference(second), sentinelAlertReference(first)],
  );
  assertEquals(
    resolved.map(({ sourceRecord, asset, evidenceIds }) => ({
      sourceRecord,
      asset,
      evidenceIds,
    })),
    [
      { sourceRecord: 3, asset: "server", evidenceIds: ["net"] },
      { sourceRecord: 4, asset: "collector-app", evidenceIds: ["auth"] },
    ],
  );
});

Deno.test("Sentinel links independent alerts across directly dependent case assets and preserves saved membership", async () => {
  const inventory = {
    version: 1,
    nodes: [
      {
        id: "server",
        kind: "asset",
        label: "Server",
        aliases: ["host.example"],
      },
      { id: "service", kind: "asset", label: "Service" },
      { id: "unlinked", kind: "asset", label: "Unlinked" },
    ],
    edges: [{ from: "service", to: "server", relation: "depends_on" }],
  };
  const graph = loadSentinelGraph(inventory);
  const first = alert(
    "authentication_failure_burst",
    1,
    ["first"],
    "host.example",
  );
  const second = alert("unexpected_remote_access", 20, ["second"], "service");
  const cases = [
    [first, { ...second, asset: "unlinked" }],
    [first, { ...second, subject: "another subject" }],
    [first, { ...second, evidenceIds: first.evidenceIds }],
    [first, alert("unexpected_remote_access", 400, ["late"], "service")],
    [
      first,
      alert(
        "authentication_success_after_failures",
        20,
        ["same-class"],
        "service",
      ),
    ],
  ];
  for (const alerts of cases) {
    assertEquals(correlateSentinelIncidents(alerts, { graph }).candidates, []);
  }
  assertEquals(correlateSentinelIncidents([first, second]).candidates, []);
  const report = correlateSentinelIncidents([first, second], { graph });
  assertEquals(report.candidates.length, 1);
  assertEquals(report.candidates[0].relatedAssetIds, ["service", "server"]);
  assertEquals(
    report.candidates[0].id,
    "incident:246dba175fc5ff4dfadeff7672a074dec6bdf57968246c3460ac87413069d4fb",
  );
  assertEquals(
    report.candidates[0].correlationBasis,
    "shared_reported_subject",
  );
  assertEquals(
    report.candidates[0].gaps.includes("subject_authority_unverified"),
    true,
  );
  assertEquals(report.summary.correlatedAlerts, 2);
  assertEquals(report.uncorrelatedAlerts, []);
  assertEquals(
    correlateSentinelIncidents([second, first], { graph }).candidates[0].id,
    report.candidates[0].id,
  );
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([first, second]),
    );
    const state = startSentinelAssessment(path, { traceNode: "server" });
    const id = report.candidates[0].id;
    const assignment = planSentinelTasks(state, []).find(({ kind }) =>
      kind === "review_incident"
    )!;
    assertEquals(assignment.nodeId, id);
    advanceAdaptiveSentinel(path, state);
    const savedTask = readAdaptiveSentinel(path, state)!.tasks.find((
      { kind },
    ) => kind === "review_incident");
    const savedObservation = savedTask?.observation as
      | { correlationBasis?: string; gaps?: string[] }
      | undefined;
    assertEquals(savedObservation?.correlationBasis, "shared_reported_subject");
    assertEquals(savedObservation?.gaps, report.candidates[0].gaps);
    assertEquals(
      (savedTask?.observation as { relatedNodeIds?: string[] })?.relatedNodeIds,
      [
        "service",
        "server",
      ],
    );
    advanceAdaptiveSentinel(path, state);
    const scoped = readAdaptiveSentinel(path, state)!.tasks.filter((
      { kind, depth },
    ) => kind === "impact" && depth === 2);
    assertEquals(scoped.map(({ nodeId }) => nodeId), ["server"]);
    assertEquals(scoped[0].prerequisites, [savedTask!.id]);

    const full = dir + "/whole-case";
    await Deno.mkdir(full);
    const fullPath = full + "/sentinel.json";
    await Deno.writeTextFile(fullPath, JSON.stringify(inventory));
    await Deno.writeTextFile(
      sentinelAlertsPath(fullPath),
      JSON.stringify([
        first,
        second,
        alert("authentication_failure_burst", 601, ["third"], "host.example"),
        alert("unexpected_remote_access", 620, ["fourth"], "service"),
      ]),
    );
    const wholeCase = startSentinelAssessment(fullPath);
    advanceAdaptiveSentinel(fullPath, wholeCase);
    advanceAdaptiveSentinel(fullPath, wholeCase);
    const tasks = readAdaptiveSentinel(fullPath, wholeCase)!.tasks;
    const parent = tasks.find(({ kind }) => kind === "review_incident")!;
    assertEquals(parent.status, "completed");
    const impacts = tasks.filter(({ kind, depth }) =>
      kind === "impact" && depth === 2
    );
    assertEquals(impacts.map(({ nodeId }) => nodeId).sort(), [
      "server",
      "service",
    ]);
    assertEquals(impacts.map(({ prerequisites }) => prerequisites), [[
      parent.id,
    ], [parent.id]]);
    assertEquals(impacts.map(({ status }) => status), [
      "completed",
      "completed",
    ]);
    const incidents = tasks.filter(({ kind }) => kind === "review_incident")
      .map(({ nodeId }) => nodeId!).sort();
    assertEquals(incidents.length, 2);
    assertEquals(impacts.map(({ evidenceIds }) => evidenceIds), [
      incidents,
      incidents,
    ]);
    const linkedView = readAdaptiveSentinel(fullPath, wholeCase)!;
    const linked = buildSentinelProvenance(wholeCase.result, linkedView)
      .snapshot();
    for (const impact of impacts) {
      assertEquals(
        linked.edges.filter(({ to, relation, from }) =>
          to === `task:adaptive:${impact.id}` && relation === "prompted" &&
          from.startsWith("observation:assessment:incident:")
        ).map(({ from }) => from).sort(),
        incidents.map((id) => `observation:assessment:${id}`),
      );
    }
    advanceAdaptiveSentinel(fullPath, wholeCase);
    assertEquals(
      readAdaptiveSentinel(fullPath, wholeCase)!.history.filter(({ event }) =>
        event === "evidence_attached"
      ).length,
      4,
    );
    const archived = readSavedSentinelIncident(path, state.revision, id);
    assertEquals(
      archived.members?.map(sentinelAlertReference),
      [first, second].map(sentinelAlertReference),
    );
    const provenance = buildSentinelProvenance(state.result).snapshot();
    const node = provenance.nodes.find(({ id: nodeId }) =>
      nodeId === `observation:assessment:${id}`
    );
    const incident = node && "incident" in node ? node.incident : undefined;
    assertEquals(incident?.correlationBasis, "shared_reported_subject");
    assertEquals(incident?.gaps, report.candidates[0].gaps);
    const page = readSavedSentinelIncidentPage(path, state.revision, 0);
    assertEquals(
      page?.incidents[0].incident.correlationBasis,
      "shared_reported_subject",
    );
    const exported = JSON.parse(
      renderSavedSentinelIncidentJson(path, "main", state.revision)!,
    );
    assertEquals(exported.incidents[0].id, id);
    assertEquals(
      exported.incidents[0].correlationBasis,
      "shared_reported_subject",
    );
    assertEquals(exported.incidents[0].gaps, report.candidates[0].gaps);
    assertEquals(
      provenance.edges.filter(({ from, to }) =>
        from === `observation:assessment:${id}` &&
        ["asset:server", "asset:service"].includes(to)
      ).map(({ to }) => to).sort(),
      ["asset:server", "asset:service"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Linked case assets correlate different subjects through exact session or identity references", async () => {
  const sessionReference = `session:${"1".repeat(64)}`;
  const inventory = {
    version: 1,
    nodes: [
      { id: "service", kind: "asset", label: "Service" },
      { id: "server", kind: "asset", label: "Server" },
    ],
    edges: [{ from: "service", to: "server", relation: "depends_on" }],
  };
  const graph = loadSentinelGraph(inventory);
  const detector = createTelemetryDetector();
  const first = detector.ingest({
    version: 1,
    id: "first",
    timestamp: new Date(epoch).toISOString(),
    asset: "service",
    kind: "unexpected_remote_access",
    subject: "operator",
    sessionReference,
  })[0];
  const second = detector.ingest({
    version: 1,
    id: "second",
    timestamp: new Date(epoch + 1000).toISOString(),
    asset: "server",
    kind: "endpoint_execution_alert",
    subject: "service-account",
    sessionReference,
  })[0];
  assertEquals(first.sessionReference, sessionReference);
  assertEquals(second.sessionReference, sessionReference);
  const controls = [
    { ...second, sessionReference: undefined },
    {
      ...second,
      sessionReference: `session:${"2".repeat(64)}`,
      subject: first.subject,
    },
    { ...second, asset: "unknown" },
    { ...second, observedAt: new Date(epoch + 301000).toISOString() },
    { ...second, evidenceIds: first.evidenceIds },
  ];
  for (const control of controls) {
    assertEquals(
      correlateSentinelIncidents([first, control], { graph }).candidates,
      [],
    );
  }
  assertThrows(
    () =>
      correlateSentinelIncidents([
        first,
        { ...second, sessionReference: "raw-session-token" },
      ], { graph }),
    Error,
    "Invalid Sentinel alert",
  );
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([first, second]),
    );
    const state = startSentinelAssessment(path);
    const [candidate] =
      correlateSentinelIncidents([first, second], { graph }).candidates;
    assertEquals(candidate.correlationBasis, "shared_session_reference");
    assertEquals(
      candidate.gaps.includes("subject_authority_unverified"),
      false,
    );
    assertEquals(
      readSavedSentinelIncident(path, state.revision, candidate.id).members
        ?.map(({ sessionReference }) => sessionReference),
      [sessionReference, sessionReference],
    );
    const node = buildSentinelProvenance(state.result).snapshot().nodes.find(
      (node) => node.id === `observation:assessment:${candidate.id}`,
    );
    assertEquals(
      node && "incident" in node ? node.incident?.correlationBasis : undefined,
      "shared_session_reference",
    );
    const identityReference = `identity:${"a".repeat(64)}`;
    const identityOnly = [first, second].map((item) => ({
      ...item,
      sessionReference: undefined,
      identityReference,
    }));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(identityOnly),
    );
    const newer = refreshSentinelAssessment(path)!;
    const [identityCandidate] =
      correlateSentinelIncidents(identityOnly, { graph }).candidates;
    assertEquals(
      identityCandidate.correlationBasis,
      "shared_identity_reference",
    );
    assertEquals(
      identityCandidate.gaps.includes("subject_authority_unverified"),
      false,
    );
    assertEquals(
      readSavedSentinelIncident(path, newer.revision, identityCandidate.id)
        .members?.map(({ identityReference }) => identityReference),
      [identityReference, identityReference],
    );
    assertEquals(
      readSavedSentinelIncident(path, state.revision, identityCandidate.id)
        .members,
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
