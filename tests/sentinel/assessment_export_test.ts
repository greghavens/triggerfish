import { assertEquals, assertStringIncludes } from "@std/assert";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import {
  renderSentinelFindingsCsv,
  renderSentinelInvestigationMarkdown,
  type SentinelAssessmentExportInput,
} from "../../src/sentinel/assessment_export.ts";

const snapshot = {
  version: 1,
  nodes: [
    { id: "db", kind: "asset", label: "Database" },
    {
      id: "=1+2",
      kind: "finding",
      label: '\t ＝SUM(1,2) and "quotes"',
      severity: "high",
    },
    {
      id: "second",
      kind: "finding",
      label: "[open](https://example.invalid) | <script> & `literal`",
      severity: "medium",
    },
    { id: "source-document", kind: "evidence", label: "Imported record" },
  ],
  edges: [
    { from: "=1+2", to: "db", relation: "affects" },
    { from: "source-document", to: "=1+2", relation: "supports" },
  ],
};

const state: SentinelAssessmentExportInput = {
  revision: 8,
  updatedAt: "2026-11-24T12:34:56.000Z",
  plan: { goal: "![](https://example.invalid/pixel)" },
  active: true,
  paused: false,
  result: runSentinelAssessment({ snapshot, alerts: [] }),
  reviews: [{
    task: "model-review",
    analysis: "<img src='remote'>\nsecond line\u061c\u202e",
    steps: [{
      tool: "sentinel_shared_asset_links",
      target: "db",
      outcome: "returned",
      sourceSnapshots: [{ caseId: "source", snapshotDigest: "a".repeat(64) }],
    }],
  }],
};

Deno.test("Sentinel CSV preserves quoted references and neutralizes spreadsheet formulas", () => {
  const csv = renderSentinelFindingsCsv(state);
  const [header, first, second, end] = csv.split("\r\n");
  assertEquals(
    header,
    '"id","severity","label","affected_asset_ids","mitigation_control_ids","supporting_evidence_ids","supporting_evidence_status","disposition"',
  );
  assertEquals(
    first,
    `"'=1+2","high","'\t ＝SUM(1,2) and ""quotes""","[""db""]","[]","[""source-document""]","linked","open"`,
  );
  assertStringIncludes(second, '"[]","[]","[]","unlinked"');
  assertEquals(end, "");
});

Deno.test("Sentinel Markdown distinguishes imported and derived evidence and neutralizes markup", () => {
  const report = renderSentinelInvestigationMarkdown(state, {
    goal: { id: "goal", label: "Review control coverage" },
    tasks: [{
      id: "task-1",
      kind: "review_finding",
      status: "completed",
      prerequisites: [],
      evidenceIds: ["source-document", "unresolved-id"],
      observation: { relatedNodeIds: ["db"] },
    }],
  });
  assertStringIncludes(report, "## Imported observations");
  assertStringIncludes(report, "## Derived assessment observations");
  assertStringIncludes(report, "## Adaptive task observations");
  assertStringIncludes(report, "## Provenance");
  assertStringIncludes(report, "Unresolved references in this report total 1.");
  assertStringIncludes(report, "## Review notes");
  assertStringIncludes(report, "unverified review analysis");
  assertStringIncludes(report, "second line&#91;U+061C&#93;&#91;U+202E&#93;");
  assertStringIncludes(report, "source · " + "a".repeat(64));
  assertStringIncludes(
    report,
    "&#91;open&#93;&#40;https&#58;&#47;&#47;example&#46;invalid&#41;",
  );
  assertStringIncludes(report, "&#60;script&#62;");
  assertStringIncludes(report, "&#91;U+000A&#93;second line");
  assertEquals(report.includes("https://example.invalid"), false);
  assertEquals(report.includes("<img"), false);
});

Deno.test("Sentinel exports work before an assessment has results", () => {
  const incomplete = { ...state, result: null, reviews: [] };
  assertEquals(renderSentinelFindingsCsv(incomplete).split("\r\n").length, 2);
  const report = renderSentinelInvestigationMarkdown(incomplete);
  assertStringIncludes(report, "No graph snapshot was supplied.");
  assertStringIncludes(report, "No assessment results have been saved.");
});

Deno.test("Sentinel Markdown includes structured relationship sources independently of display labels", () => {
  const digest = "c".repeat(64);
  const report = renderSentinelInvestigationMarkdown({
    ...state,
    result: runSentinelAssessment({
      snapshot: {
        version: 1,
        nodes: [{
          id: "corroboration",
          label: "Shared link",
          kind: "evidence",
          relationshipSources: [{
            caseId: "reporting",
            from: "source|asset",
            to: "target",
            snapshotDigest: digest,
          }],
        }],
        edges: [],
      },
    }),
  }, {
    goal: { id: "goal", label: "Review shared links" },
    tasks: [{
      id: "trace",
      kind: "trace",
      status: "queued",
      prerequisites: [],
      evidenceIds: [],
      plannerRound: { identity: "round:hint:8", attempt: 2, hintId: 8 },
    }],
  });
  assertStringIncludes(report, "round&#58;hint&#58;8 · Attempt 2");
  assertStringIncludes(report, "### Relationship sources");
  assertStringIncludes(
    report,
    "| corroboration | reporting | source&#124;asset | target | " + digest +
      " |",
  );
});

Deno.test("Sentinel Markdown exports the control record as evaluated at the saved revision", () => {
  const observedAt = "2026-11-24T12:00:00.000Z";
  const validUntil = "2026-11-24T13:00:00.000Z";
  const inventory = {
    ...snapshot,
    nodes: [
      ...snapshot.nodes,
      { id: "firewall", kind: "control", label: "Recorded mitigation" },
      {
        id: "check",
        kind: "evidence",
        label: "Verification record",
        controlVerification: {
          outcome: "pass",
          observedAt,
          validUntil,
        },
      },
    ],
    edges: [
      ...snapshot.edges,
      { from: "firewall", to: "second", relation: "mitigates" },
      { from: "check", to: "firewall", relation: "verifies" },
    ],
  };
  const result = runSentinelAssessment({
    snapshot: inventory,
    controlEvaluationAt: state.updatedAt,
  });
  const saved = { ...state, result };
  const report = renderSentinelInvestigationMarkdown(saved);
  assertStringIncludes(report, "## Recorded control verification");
  assertStringIncludes(
    report,
    `| second | firewall | pass | check | ${observedAt} | ${validUntil} |`,
  );
  const completed = renderSentinelInvestigationMarkdown({
    ...saved,
    updatedAt: validUntil,
  });
  assertStringIncludes(
    completed,
    `| second | firewall | pass | check | ${observedAt} | ${validUntil} |`,
  );
  const expired = renderSentinelInvestigationMarkdown(
    {
      ...saved,
      updatedAt: validUntil,
      result: runSentinelAssessment({
        snapshot: inventory,
        controlEvaluationAt: validUntil,
        previous: result,
      }),
    },
    undefined,
    "es",
  );
  assertStringIncludes(expired, "## Verificación de controles registrada");
  assertStringIncludes(expired, "## Cambios en la verificación de controles");
  assertStringIncludes(
    expired,
    "| second | firewall | Aprobado · check | Vencido · check |",
  );
  assertStringIncludes(
    expired,
    `| second | firewall | Vencido | check | ${observedAt} | ${validUntil} |`,
  );
});
