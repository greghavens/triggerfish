import { assertEquals, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const graph = loadSentinelGraph({
  version: 1,
  nodes: [
    ...["queue", "database", "worker", "monitor", "api", "frontend"].map(
      (id) => ({ id, kind: "asset", label: id }),
    ),
    {
      id: "database-finding",
      kind: "finding",
      label: "Database patch",
      severity: "high",
    },
    {
      id: "worker-finding",
      kind: "finding",
      label: "Worker patch",
      severity: "medium",
    },
    {
      id: "queue-finding",
      kind: "finding",
      label: "Queue patch",
      severity: "low",
    },
    { id: "control", kind: "control", label: "Isolate database" },
    { id: "evidence", kind: "evidence", label: "Worker report" },
  ],
  edges: [
    { from: "database", to: "queue", relation: "depends_on" },
    { from: "worker", to: "database", relation: "depends_on" },
    { from: "monitor", to: "database", relation: "depends_on" },
    { from: "api", to: "worker", relation: "depends_on" },
    { from: "api", to: "monitor", relation: "depends_on" },
    { from: "worker", to: "api", relation: "depends_on" },
    { from: "frontend", to: "api", relation: "depends_on" },
    { from: "database-finding", to: "database", relation: "affects" },
    { from: "worker-finding", to: "worker", relation: "affects" },
    { from: "queue-finding", to: "queue", relation: "affects" },
    { from: "control", to: "database-finding", relation: "mitigates" },
    { from: "evidence", to: "worker-finding", relation: "supports" },
  ],
});

Deno.test("Sentinel reports evidence and mitigation link gaps independently", () => {
  const coverage = graph.coverage();
  assertEquals(coverage.summary, {
    totalFindings: 3,
    withoutControlLink: 2,
    withoutEvidenceLink: 2,
  });
  assertEquals(
    coverage.findings.map(({ id, hasControlLink, hasEvidenceLink }) => [
      id,
      hasControlLink,
      hasEvidenceLink,
    ]),
    [
      ["database-finding", true, false],
      ["worker-finding", false, true],
      ["queue-finding", false, false],
    ],
  );
});

Deno.test("Sentinel impact follows incoming dependency edges, with cycle and depth handling", () => {
  const impact = graph.impact("database", 2);
  assertEquals(
    impact.assets.map(({ id, distance, findings }) => [id, distance, findings]),
    [
      ["database", 0, ["database-finding"]],
      ["worker", 1, ["worker-finding"]],
      ["monitor", 1, []],
      ["api", 2, []],
    ],
  );
  assertEquals(impact.edges.length, 5);
  assertEquals(
    graph.impact("database", 0).assets.map(({ id }) => id),
    ["database"],
  );
  assertEquals(
    graph.impact("database", 3).assets.map(({ id }) => id),
    ["database", "worker", "monitor", "api", "frontend"],
  );
  assertThrows(
    () => graph.impact("database-finding", 0),
    Error,
    "Unknown Sentinel asset",
  );
});
