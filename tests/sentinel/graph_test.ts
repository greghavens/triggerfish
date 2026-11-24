import { assertEquals, assertThrows } from "@std/assert";
import { parseCommand } from "../../src/cli/main_commands.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { detectSentinelRegressions } from "../../src/sentinel/monitor.ts";

const snapshot = {
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
    { id: "patch", kind: "control", label: "Apply update" },
    { id: "ticket", kind: "evidence", label: "Inventory record" },
    { id: "unrelated", kind: "finding", label: "Unrelated", severity: "low" },
  ],
  edges: [
    { from: "app", to: "db", relation: "depends_on" },
    { from: "db", to: "app", relation: "depends_on" },
    { from: "finding", to: "app", relation: "affects" },
    { from: "finding", to: "db", relation: "affects" },
    { from: "patch", to: "finding", relation: "mitigates" },
    { from: "ticket", to: "finding", relation: "supports" },
  ],
};

Deno.test("Sentinel trace visits each node once at its shortest distance", () => {
  const graph = loadSentinelGraph(snapshot);
  const trace = graph.trace("app", 2);
  assertEquals(trace.nodes.map(({ id, distance }) => [id, distance]), [
    ["app", 0],
    ["db", 1],
    ["finding", 1],
    ["patch", 2],
    ["ticket", 2],
  ]);
  assertEquals(trace.edges.length, 6);
  assertEquals(graph.trace("app", 0).nodes.map(({ id }) => id), ["app"]);
  assertEquals(graph.trace("app", 1).edges.length, 4);
});

Deno.test("Sentinel path preserves edge orientation and honors direction and depth", () => {
  const graph = loadSentinelGraph(snapshot);
  const forward = graph.shortestPath("ticket", "db", 2, "outgoing")!;
  assertEquals(forward.nodes.map(({ id }) => id), ["ticket", "finding", "db"]);
  assertEquals(forward.edges, [snapshot.edges[5], snapshot.edges[3]]);
  const reverse = graph.shortestPath("db", "ticket", 2, "incoming")!;
  assertEquals(reverse.nodes.map(({ id }) => id), ["db", "finding", "ticket"]);
  assertEquals(reverse.edges, [...forward.edges].reverse());
  assertEquals(graph.shortestPath("ticket", "db", 1), null);
  assertEquals(graph.shortestPath("db", "ticket", 2, "outgoing"), null);
  assertEquals(graph.shortestPath("db", "db", 0)?.edges, []);
  assertThrows(() => graph.shortestPath("db", "missing", 2));
});

Deno.test("Sentinel ranks findings and deduplicates relationship evidence", () => {
  const report = loadSentinelGraph({
    ...snapshot,
    edges: [...snapshot.edges, snapshot.edges[2]],
  }).report();
  assertEquals(report.map(({ id }) => id), ["finding", "unrelated"]);
  assertEquals(report[0].assets, ["app", "db"]);
  assertEquals(report[0].controls, ["patch"]);
  assertEquals(report[0].evidence, ["ticket"]);
  assertEquals(report[1].controls, []);
});

Deno.test("Sentinel rejects invalid relationship endpoints and duplicate node IDs", () => {
  for (const to of ["missing", "patch"]) {
    assertThrows(
      () =>
        loadSentinelGraph({
          ...snapshot,
          edges: [{ from: "finding", to, relation: "affects" }],
        }),
      Error,
      "requires finding",
    );
  }
  assertThrows(
    () =>
      loadSentinelGraph({
        ...snapshot,
        nodes: [...snapshot.nodes, snapshot.nodes[0]],
      }),
    Error,
    "Duplicate",
  );
});

Deno.test("CLI routes Sentinel on an unconfigured installation", () => {
  assertEquals(
    parseCommand(["sentinel", "trace", "--node=app"], { configExists: false }),
    { command: "sentinel", subcommand: "trace", flags: { node: "app" } },
  );
});

Deno.test("Sentinel reports regressions once across accepted snapshots", () => {
  const baseline = loadSentinelGraph({
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => node.id !== "unrelated"),
    edges: snapshot.edges.filter((edge) =>
      !(edge.from === "finding" && edge.to === "db")
    ),
  }).report();
  const current = loadSentinelGraph({
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.id === "finding" ? { ...node, severity: "critical" } : node
    ),
    edges: snapshot.edges.filter((edge) => edge.from !== "patch"),
  }).report();

  const alerts = detectSentinelRegressions(baseline, current);
  assertEquals(alerts.map((alert) => alert.type), [
    "finding_escalated",
    "assets_added",
    "mitigation_links_removed",
    "finding_added",
  ]);
  assertEquals(detectSentinelRegressions(current, current), []);
});

Deno.test("Alternate shortest paths retain distinct evidence chains and report truncation", () => {
  const graph = loadSentinelGraph({
    ...snapshot,
    edges: [...snapshot.edges, {
      from: "ticket",
      to: "app",
      relation: "observed_on",
    }],
  });
  const two = graph.alternatePaths("ticket", "db", 2, "outgoing", undefined, 2);
  assertEquals(two.paths.map(({ nodes }) => nodes.map(({ id }) => id)), [
    ["ticket", "finding", "db"],
    ["ticket", "app", "db"],
  ]);
  assertEquals(two.truncated, false);
  assertEquals(
    graph.alternatePaths("ticket", "db", 2, "outgoing", undefined, 1),
    {
      paths: two.paths.slice(0, 1),
      truncated: true,
    },
  );
  const filtered = graph.alternatePaths(
    "ticket",
    "db",
    2,
    "outgoing",
    "observed_on,depends_on",
    2,
  );
  assertEquals(filtered.paths, [two.paths[1]]);
  assertEquals(
    graph.alternatePaths("db", "ticket", 2, "outgoing", undefined, 2),
    {
      paths: [],
      truncated: false,
    },
  );
});
