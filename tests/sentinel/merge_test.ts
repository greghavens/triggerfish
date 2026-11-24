import { assertEquals, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { mergeSentinelSnapshots } from "../../src/sentinel/merge.ts";

const app = { id: "app", label: "Application", kind: "asset" };
const db = { id: "db", label: "Database", kind: "asset" };
const dependency = { from: "app", to: "db", relation: "depends_on" };
const scan = {
  version: 1,
  nodes: [
    { id: "vuln-1", label: "Missing patch", kind: "finding", severity: "high" },
    db,
    app,
  ],
  edges: [
    dependency,
    { from: "vuln-1", to: "app", relation: "affects" },
  ],
};
const inventory = {
  version: 1,
  nodes: [
    app,
    db,
    { id: "client", label: "Client", kind: "asset" },
  ],
  edges: [
    { from: "client", to: "app", relation: "depends_on" },
    dependency,
    dependency,
  ],
};

Deno.test("Sentinel unions shared assets and relationships deterministically", () => {
  const merged = mergeSentinelSnapshots([scan, inventory]);
  assertEquals(mergeSentinelSnapshots([inventory, scan]), merged);
  assertEquals(merged.version, 1);
  assertEquals(merged.nodes.map(({ id }) => id), [
    "app",
    "client",
    "db",
    "vuln-1",
  ]);
  assertEquals(merged.edges, [
    dependency,
    { from: "client", to: "app", relation: "depends_on" },
    { from: "vuln-1", to: "app", relation: "affects" },
  ]);
  assertEquals(
    loadSentinelGraph(merged).impact("db", 2).assets.map(({ id }) => id),
    ["db", "app", "client"],
  );
});

Deno.test("Sentinel rejects conflicting shared nodes and identifies invalid input sources", () => {
  assertThrows(
    () =>
      mergeSentinelSnapshots([scan, {
        ...inventory,
        nodes: [
          { ...app, label: "New application" },
          ...inventory.nodes.slice(1),
        ],
      }]),
    Error,
    'Conflicting Sentinel node "app" in snapshots 1 and 2',
  );
  assertThrows(
    () =>
      mergeSentinelSnapshots([scan, {
        version: 1,
        nodes: [app],
        edges: [dependency],
      }]),
    Error,
    "Invalid Sentinel snapshot 2: Relationship depends_on requires",
  );
});

Deno.test("Sentinel snapshot export does not expose the graph indexes", () => {
  const graph = loadSentinelGraph(scan);
  const exported = graph.snapshot();
  exported.nodes.length = 0;
  exported.edges.length = 0;
  assertEquals(graph.snapshot(), scan);
});
