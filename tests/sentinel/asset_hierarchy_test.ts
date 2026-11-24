import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname } from "@std/path";
import {
  MAX_EDGES,
  runSentinelAssessment,
} from "../../src/sentinel/assessment.ts";
import {
  readSentinelAssessmentRevision,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import {
  collectSharedSentinelTopology,
  readArchivedSentinelSnapshot,
  readSharedSentinelAssetLinks,
  readSharedSentinelAssets,
} from "../../src/sentinel/shared_inventory.ts";

const inventory = {
  version: 1,
  nodes: [
    {
      id: "domain",
      kind: "asset",
      label: "example.invalid",
      assetType: "root_domain",
    },
    {
      id: "host",
      kind: "asset",
      label: "app.example.invalid",
      assetType: "subdomain",
      parentId: "domain",
    },
    {
      id: "svc",
      kind: "asset",
      label: "HTTPS service",
      assetType: "service",
      parentId: "host",
      aliases: ["service-alias"],
    },
    {
      id: "app",
      kind: "asset",
      label: "Application",
      assetType: "application",
      parentId: "svc",
    },
    {
      id: "endpoint",
      kind: "asset",
      label: "Status route",
      assetType: "endpoint",
      parentId: "app",
    },
    { id: "address", kind: "asset", label: "192.0.2.1", assetType: "ip" },
    {
      id: "finding",
      kind: "finding",
      label: "Configuration observation",
      severity: "low",
    },
  ],
  edges: [
    { from: "host", to: "address", relation: "resolved_to" },
    { from: "finding", to: "endpoint", relation: "affects" },
    { from: "endpoint", to: "app", relation: "contained_in" },
  ],
};

Deno.test("Sentinel derives typed hierarchy paths deterministically and preserves anchors", () => {
  const graph = loadSentinelGraph(inventory);
  const canonical = graph.snapshot();
  assertEquals(loadSentinelGraph(canonical).snapshot(), canonical);
  assertEquals(
    loadSentinelGraph({
      ...inventory,
      edges: inventory.edges.filter(({ relation }) =>
        relation !== "contained_in"
      ),
    }).snapshot(),
    canonical,
  );
  assertEquals(graph.resolveAssetId("service-alias"), "svc");
  assertEquals(graph.report()[0].assets, ["endpoint"]);
  assertEquals(
    graph.shortestPath("endpoint", "domain", 4, "outgoing", "contained_in")
      ?.nodes
      .map(({ id }) => id),
    ["endpoint", "app", "svc", "host", "domain"],
  );
  assertEquals(graph.impact("domain", 4).assets.map(({ id }) => id), [
    "domain",
  ]);
  assertEquals(
    graph.shortestPath("host", "address", 2, "outgoing", "resolved_to")?.nodes
      .map(({ id }) => id),
    ["host", "address"],
  );
});

Deno.test("Sentinel rejects unresolved, incompatible, cyclic, and conflicting hierarchy", () => {
  function change(id: string, attributes: Record<string, unknown>) {
    return loadSentinelGraph({
      ...inventory,
      nodes: inventory.nodes.map((node) =>
        node.id === id ? { ...node, ...attributes } : node
      ),
    });
  }
  assertThrows(
    () => change("app", { parentId: "service-alias" }),
    Error,
    "exact asset ID",
  );
  assertThrows(() => change("host", { parentId: "host" }), Error, "Cyclic");
  assertThrows(
    () => change("svc", { parentId: "address", assetType: "endpoint" }),
    Error,
    "Incompatible",
  );
  assertThrows(
    () => change("host", { assetType: "arbitrary" }),
    Error,
    "asset type",
  );
  assertThrows(() => change("svc", { aliases: null }), Error, "asset aliases");
  assertThrows(
    () =>
      loadSentinelGraph({
        ...inventory,
        edges: [...inventory.edges, {
          from: "endpoint",
          to: "svc",
          relation: "contained_in",
        }],
      }),
    Error,
    "declared parent",
  );
  assertThrows(
    () =>
      loadSentinelGraph({
        ...inventory,
        edges: [...inventory.edges, {
          from: "endpoint",
          to: "finding",
          relation: "affects",
        }],
      }),
    Error,
    "requires finding",
  );
});

Deno.test("Sentinel counts synthesized containment links against assessment edge limits", () => {
  const assets = Array.from({ length: 90 }, (_, index) => ({
    id: `asset-${index}`,
    kind: "asset",
    label: `Asset ${index}`,
  }));
  const snapshot = {
    version: 1,
    nodes: [...assets, ...inventory.nodes.slice(0, 2)],
    edges: assets.flatMap(({ id: from }) =>
      assets.map(({ id: to }) => ({ from, to, relation: "depends_on" }))
    ).slice(0, MAX_EDGES),
  };
  assertThrows(
    () => runSentinelAssessment({ snapshot }),
    Error,
    "canonical edges",
  );
});

Deno.test("Named hierarchy remains traversable in saved assessments and exact archived sources", async () => {
  const base = await Deno.makeTempDir();
  try {
    const source = resolveSentinelCasePath(base, "source");
    const local = resolveSentinelCasePath(base);
    await Deno.mkdir(dirname(source), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(source, JSON.stringify(inventory));
    await Deno.writeTextFile(
      local,
      JSON.stringify({
        version: 1,
        nodes: inventory.nodes.filter(({ kind }) => kind === "asset").map(
          ({ id, label, kind }) => ({ id, label, kind }),
        ),
        edges: [],
      }),
    );
    const state = startSentinelAssessment(source);
    const saved = readSentinelAssessmentRevision(source, state.revision)!;
    const provenance = buildSentinelProvenance(saved.result);
    const endpoint = provenance.snapshot().nodes.find(({ id }) =>
      id === "asset:endpoint"
    );
    assert(endpoint?.kind === "asset");
    assertEquals(endpoint.assetType, "endpoint");
    assertEquals(endpoint.parentId, "app");
    assertEquals(
      provenance.shortestPath(
        "asset:domain",
        "finding:finding",
        5,
        "incoming",
        "contained_in,affects",
      )
        ?.nodes.map(({ id }) => id),
      [
        "asset:domain",
        "asset:host",
        "asset:svc",
        "asset:app",
        "asset:endpoint",
        "finding:finding",
      ],
    );

    const listed = await readSharedSentinelAssets(base, "svc", 0, 20);
    assertEquals(listed.assets[0].sources, [
      { caseId: "main", label: "HTTPS service" },
      {
        caseId: "source",
        label: "HTTPS service",
        aliases: ["service-alias"],
        assetType: "service",
        parentId: "host",
      },
    ]);
    const links = await readSharedSentinelAssetLinks(
      base,
      "svc",
      0,
      20,
      undefined,
      undefined,
      false,
      { includeSourceDigests: true, retainSourceSnapshots: true },
    );
    assert(links.links.some(({ relation }) => relation === "contained_in"));
    const digest = links.sourceSnapshots?.[0].snapshotDigest;
    assert(digest);
    const synchronized = await collectSharedSentinelTopology(
      base,
      "main",
      local,
    );
    assertEquals(synchronized.map(({ relation }) => relation), ["resolved_to"]);

    await Deno.writeTextFile(
      source,
      JSON.stringify({
        ...inventory,
        nodes: inventory.nodes.map((node) =>
          node.id === "endpoint" ? { ...node, label: "Updated label" } : node
        ),
      }),
    );
    assertEquals(
      await readArchivedSentinelSnapshot(base, "source", digest),
      loadSentinelGraph(inventory).snapshot(),
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
