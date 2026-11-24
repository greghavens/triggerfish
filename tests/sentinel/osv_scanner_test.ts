import { assert, assertEquals, assertThrows } from "@std/assert";
import { importSentinelOsvScanner } from "../../src/sentinel/osv_scanner.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

Deno.test("OSV-Scanner findings link to exact package versions and report evidence", () => {
  const scan = (path: string, version: string, severity: string) => ({
    source: { type: "lockfile", path },
    packages: [{
      package: {
        ecosystem: "npm",
        name: "example",
        version,
        purl: "pkg:npm/example@1.0.0",
      },
      vulnerabilities: [
        {
          id: "OSV-example",
          database_specific: { severity },
          details: "Unneeded advisory text",
        },
        { id: "OSV-withdrawn", withdrawn: "2024-01-01T00:00:00Z" },
      ],
    }],
  });
  const input = [
    scan("app/package-lock.json", "1.0.0", "HIGH"),
    scan("other/package-lock.json", "2.0.0", "LOW"),
  ];
  const snapshot = importSentinelOsvScanner({ results: input }, "project");
  const graph = loadSentinelGraph(snapshot);
  assertEquals(graph.report().length, 1);
  assertEquals(graph.report()[0].severity, "high");
  assertEquals(graph.report()[0].assets.length, 2);
  assertEquals(graph.report()[0].evidence.length, 2);
  const asset = snapshot.nodes.find(({ label }) =>
    label === "npm example@1.0.0"
  );
  assert(asset?.kind === "asset");
  assertEquals(asset.aliases, ["pkg:npm/example@1.0.0"]);
  const mismatch = snapshot.nodes.find(({ label }) =>
    label === "npm example@2.0.0"
  );
  assert(mismatch?.kind === "asset");
  assertEquals(mismatch.aliases, undefined);
  assertEquals(
    snapshot,
    importSentinelOsvScanner({ results: input.toReversed() }, "project"),
  );
  assert(!JSON.stringify(snapshot).includes("Unneeded advisory text"));
  assertThrows(() =>
    importSentinelOsvScanner({ results: "invalid" }, "project")
  );
});

Deno.test("OSV-Scanner applies numeric group severity only to that group's advisory IDs", () => {
  const snapshot = importSentinelOsvScanner({
    results: [{
      source: { path: "lock.json" },
      packages: [{
        package: { ecosystem: "npm", name: "example", version: "1.0.0" },
        groups: [
          { ids: ["A"], max_severity: "9.8" },
          { ids: ["B"], max_severity: "9.8" },
          { ids: ["C"], max_severity: "5.4" },
          { ids: ["D"], max_severity: "12" },
          { ids: ["E"], max_severity: "4.2" },
        ],
        vulnerabilities: [
          { id: "A" },
          { id: "B" },
          { id: "C" },
          { id: "D" },
          { id: "E", database_specific: { severity: "HIGH" } },
          { id: "F" },
        ],
      }],
    }],
  }, "project");
  const findings = loadSentinelGraph(snapshot).report();
  assertEquals(
    Object.fromEntries(
      findings.map(({ label, severity }) => [label, severity]),
    ),
    {
      A: "critical",
      B: "critical",
      C: "medium",
      D: "info",
      E: "high",
      F: "info",
    },
  );
});

Deno.test("OSV-Scanner groups merge equivalent advisory IDs with original evidence labels", () => {
  const scan = (
    path: string,
    name: string,
    ids: string[],
    group: string[],
  ) => ({
    source: { path },
    packages: [{
      package: { ecosystem: "npm", name, version: "1" },
      vulnerabilities: ids.map((id) => ({ id })),
      groups: [{ ids: group, max_severity: "8.8" }],
    }],
  });
  const results = [
    scan("first.lock", "first", ["OSV-A", "OSV-B"], ["OSV-A", "OSV-B"]),
    scan("second.lock", "second", ["OSV-C"], ["OSV-B", "OSV-C"]),
  ];
  const snapshot = importSentinelOsvScanner({ results }, "project");
  const graph = loadSentinelGraph(snapshot);
  const [finding] = graph.report();
  assertEquals(graph.report().length, 1);
  assertEquals(finding.label, "OSV-A");
  assertEquals(finding.assets.length, 2);
  assertEquals(finding.evidence.length, 3);
  assert(
    snapshot.nodes.some(({ label }) => label.includes("second.lock · OSV-C")),
  );
  assertEquals(
    snapshot,
    importSentinelOsvScanner({ results: results.toReversed() }, "project"),
  );
});

Deno.test("OSV-Scanner infers versioned package URLs for known ecosystem coordinates", () => {
  const packages = [
    ["npm", "@scope/example", "pkg:npm/%40scope/example@1.0.0"],
    [
      "Go",
      "example.org/team/module/v2",
      "pkg:golang/example.org/team/module/v2@1.0.0",
    ],
    ["PyPI", "Example__Module", "pkg:pypi/example-module@1.0.0"],
    ["crates.io", "test_crate", "pkg:cargo/test_crate@1.0.0"],
    ["Maven", "org.example:artifact", "pkg:maven/org.example/artifact@1.0.0"],
    ["Debian:12", "example", undefined],
  ] as const;
  const graph = loadSentinelGraph(importSentinelOsvScanner({
    results: [{
      source: { path: "dependencies" },
      packages: packages.map(([ecosystem, name]) => ({
        package: { ecosystem, name, version: "1.0.0" },
        vulnerabilities: [],
      })),
    }],
  }, "project"));
  for (const [ecosystem, name, expected] of packages) {
    const asset = graph.snapshot().nodes.find(({ label }) =>
      label === `${ecosystem} ${name}@1.0.0`
    );
    assert(asset?.kind === "asset");
    assertEquals(asset.aliases, expected ? [expected] : undefined);
    if (expected) assertEquals(graph.resolveAssetId(expected), asset.id);
  }
  assertEquals(
    graph.resolveAssetId("pkg:npm/%40scope/example@2.0.0"),
    undefined,
  );
});
