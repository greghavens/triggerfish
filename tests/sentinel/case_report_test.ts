import { assertEquals, assertThrows } from "@std/assert";
import { buildSentinelCaseReport } from "../../src/sentinel/case_report.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { createTelemetryDetector } from "../../src/sentinel/telemetry.ts";

function graph() {
  return loadSentinelGraph({
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "internal" },
      { id: "db", kind: "asset", label: "database" },
      {
        id: "vuln-1",
        kind: "finding",
        label: "Missing update",
        severity: "high",
      },
      { id: "vuln-2", kind: "finding", label: "Weak policy", severity: "low" },
      {
        id: "vuln-3",
        kind: "finding",
        label: "Unknown source",
        severity: "info",
      },
      { id: "ticket-1", kind: "evidence", label: "Inventory record" },
      { id: "patch-1", kind: "control", label: "Patch deployed" },
    ],
    edges: [
      { from: "app", to: "db", relation: "depends_on" },
      { from: "vuln-1", to: "app", relation: "affects" },
      { from: "vuln-2", to: "app", relation: "affects" },
      { from: "ticket-1", to: "vuln-1", relation: "supports" },
      { from: "patch-1", to: "vuln-1", relation: "mitigates" },
    ],
  });
}

const { ingest } = createTelemetryDetector();
const alerts = ["db", "app", "internal"].flatMap((asset, index) =>
  ingest({
    version: 1,
    kind: "integrity_change",
    id: `source-${index}`,
    timestamp: "2026-01-01T00:00:00Z",
    asset,
    subject: "policy",
  })
);

Deno.test("Sentinel case report matches only exact affected asset IDs", () => {
  const report = buildSentinelCaseReport(graph(), alerts);
  assertEquals(report.summary, {
    findings: 3,
    findingsWithEvidence: 1,
    findingsWithRelatedAlerts: 2,
    matchedAlerts: 1,
    unmatchedAlerts: 2,
  });
  assertEquals(report.matchedAlerts[0].sourceRecord, 2);
  assertEquals(report.matchedAlerts[0].evidenceIds, ["source-1"]);
  assertEquals(report.matchedAlerts[0].affectedFindingIds, [
    "vuln-1",
    "vuln-2",
  ]);
  assertEquals(
    report.unmatchedAlerts.map(({ asset, sourceRecord }) => [
      asset,
      sourceRecord,
    ]),
    [["db", 1], ["internal", 3]],
  );

  const [supported, contextualOnly, unmapped] = report.findings;
  assertEquals(supported.evidence, ["ticket-1"]);
  assertEquals(supported.controls, ["patch-1"]);
  assertEquals(supported.gaps, []);
  assertEquals(contextualOnly.relatedAlertRecords, [2]);
  assertEquals(contextualOnly.evidenceStatus, "supporting_evidence_missing");
  assertEquals(contextualOnly.gaps, [
    "no_supporting_evidence_link",
    "no_mitigation_control_link",
  ]);
  assertEquals(unmapped.gaps, [
    "no_affected_asset_link",
    "no_supporting_evidence_link",
    "no_mitigation_control_link",
    "no_related_alert",
  ]);
});

Deno.test("Sentinel case report accepts an empty alert source and rejects invalid records", () => {
  assertEquals(buildSentinelCaseReport(graph()).matchedAlerts, []);
  assertThrows(
    () =>
      buildSentinelCaseReport(graph(), [
        alerts[0],
        { ...alerts[1], evidenceIds: [null] },
      ]),
    Error,
    "Invalid Sentinel alert at record 2",
  );
});

Deno.test("Sentinel correlates unique aliases while preserving the reported asset", () => {
  const snapshot = graph().snapshot();
  const aliased = loadSentinelGraph({
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.kind === "asset" && node.id === "app"
        ? { ...node, aliases: ["internal", "ambiguous", "db"] }
        : node.kind === "asset" && node.id === "db"
        ? { ...node, aliases: ["ambiguous"] }
        : node
    ),
  });
  const report = buildSentinelCaseReport(aliased, [...alerts, {
    ...alerts[0],
    asset: "ambiguous",
  }]);
  assertEquals(
    report.matchedAlerts.map((
      { asset, matchedAsset },
    ) => [asset, matchedAsset]),
    [
      ["app", undefined],
      ["internal", "app"],
    ],
  );
  assertEquals(report.unmatchedAlerts.map(({ asset }) => asset), [
    "db",
    "ambiguous",
  ]);
});
