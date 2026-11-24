import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { importSentinelSarif } from "../../src/sentinel/sarif.ts";

const message = { text: "Missing audit logging" };
const location = {
  physicalLocation: {
    artifactLocation: { index: 0 },
    region: { startLine: 4, startColumn: 2 },
  },
};

function log(results: unknown) {
  return {
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Static Analyzer",
          rules: [{
            id: "audit-001",
            defaultConfiguration: { level: "error" },
          }],
        },
      },
      artifacts: [{
        location: { uri: "https://example.invalid/path", uriBaseId: "SRC" },
      }],
      results,
    }],
  };
}

Deno.test("SARIF materializes literal artifact references and line evidence", () => {
  const graph = loadSentinelGraph(importSentinelSarif(
    log([
      { ruleIndex: 0, message, locations: [location] },
      { kind: "pass", message },
      { baselineState: "absent", message },
    ]),
    "repo",
  ));
  const findings = graph.report();
  assertEquals(findings.length, 1);
  const [finding] = findings;
  assertEquals(finding.severity, "high");
  assertEquals(
    finding.label,
    "Static Analyzer audit-001: Missing audit logging",
  );
  assertEquals(graph.trace(finding.id, 1).nodes.map((node) => node.label), [
    finding.label,
    "SRC https://example.invalid/path",
    "SRC https://example.invalid/path:4:2",
  ]);
});

Deno.test("SARIF finding IDs survive result and fingerprint ordering and line shifts", () => {
  const original = {
    ruleId: "audit-001",
    message,
    level: "warning",
    fingerprints: { algorithm1: "result", algorithm2: "result-2" },
    locations: [location],
  };
  const updated = {
    ...original,
    level: "error",
    fingerprints: { algorithm2: "result-2", algorithm1: "result" },
    locations: [{
      physicalLocation: {
        ...location.physicalLocation,
        region: { startLine: 7 },
      },
    }],
  };
  const before =
    loadSentinelGraph(importSentinelSarif(log([original]), "repo")).report()[0];
  const after = loadSentinelGraph(
    importSentinelSarif(log([original, updated]), "repo"),
  ).report();
  assertEquals(after.length, 1);
  assertEquals(after[0].id, before.id);
  assertEquals(after[0].severity, "high");
  assertEquals(after[0].evidence.length, 2);
  const [other] = loadSentinelGraph(
    importSentinelSarif(log([original]), "other"),
  ).report();
  assertNotEquals(other.id, before.id);
});

Deno.test("SARIF falls back to source as asset and supports non-fail review results", () => {
  const graph = loadSentinelGraph(importSentinelSarif(
    log([
      { kind: "review", message: { id: "needs-review" } },
    ]),
    "repo",
  ));
  const [finding] = graph.report();
  assertEquals(finding.severity, "info");
  assertEquals(finding.evidence, []);
  assertEquals(graph.trace(finding.id, 1).nodes.map((node) => node.label), [
    "Static Analyzer: needs-review",
    "repo",
  ]);
});

Deno.test("SARIF rejects malformed versions, results, severity and artifact references", () => {
  assertThrows(
    () => importSentinelSarif({ version: "2.0.0" }, "repo"),
    Error,
    "version",
  );
  assertThrows(() => importSentinelSarif(log(null), "repo"), Error, "results");
  assertThrows(
    () => importSentinelSarif(log([{ message, level: "critical" }]), "repo"),
    Error,
    "level",
  );
  assertThrows(
    () =>
      importSentinelSarif(
        log([{
          message,
          locations: [{ physicalLocation: { artifactLocation: { index: 5 } } }],
        }]),
        "repo",
      ),
    Error,
    "indexed artifact",
  );
});
