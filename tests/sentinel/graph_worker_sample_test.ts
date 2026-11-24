import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assignSentinelTask,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  executeSentinelTask,
} from "../../src/sentinel/adaptive_planner.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";

type Kind = "trace" | "impact";

interface SampleFacts {
  readonly edgeCount: number;
  readonly edges: readonly { from: string; to: string }[];
  readonly truncated: boolean;
}

type SampleNode = { readonly id: string; readonly distance: number };

function sample(snapshot: unknown, kind: Kind) {
  const state = {
    plan: {},
    active: true,
    paused: false,
    revision: 1,
    result: runSentinelAssessment({ snapshot }),
    updatedAt: "",
    reviews: [],
  };
  const result = executeSentinelTask(state, {
    id: "test-worker",
    revision: adaptiveRevision(state),
    kind,
    nodeId: "root",
    depth: 2,
    status: "running",
    attempts: 1,
    prerequisites: [],
    evidenceIds: [],
  }) as {
    readonly relatedNodeIds: readonly string[];
    readonly trace?: SampleFacts & {
      readonly nodes: readonly SampleNode[];
      readonly nodeCount: number;
    };
    readonly impact?: SampleFacts & {
      readonly assets: readonly SampleNode[];
      readonly assetCount: number;
    };
  };
  if (kind === "trace") {
    assert(result.trace);
    const { nodes, nodeCount, ...metadata } = result.trace;
    return { ...metadata, nodes, nodeCount, references: result.relatedNodeIds };
  }
  assert(result.impact);
  const { assets, assetCount, ...metadata } = result.impact;
  return {
    ...metadata,
    nodes: assets,
    nodeCount: assetCount,
    references: result.relatedNodeIds,
  };
}

const assets = (ids: readonly string[]) =>
  ids.map((id) => ({ id, kind: "asset", label: id }));
const edge = (from: string, to: string) => ({
  from,
  to,
  relation: "depends_on",
});

for (const kind of ["trace", "impact"] as const) {
  Deno.test(`Adaptive ${kind} excludes edges with an omitted endpoint and reports exact totals`, () => {
    const children = Array.from({ length: 30 }, (_, i) => `child-${i}`);
    const result = sample({
      version: 1,
      nodes: assets(["root", ...children]),
      edges: children.map((id) => edge(id, "root")),
    }, kind);
    assertEquals(result.nodeCount, 31);
    assertEquals(result.edgeCount, 30);
    assertEquals(result.truncated, true);
    assertEquals(result.nodes.length, 24);
    assertEquals(result.edges.length, 23);
    assertEquals(result.references, result.nodes.map(({ id }) => id));
    assert(
      result.edges.every(({ from, to }) =>
        result.references.includes(from) && result.references.includes(to)
      ),
    );
  });

  Deno.test(`Adaptive ${kind} keeps shortest parent edges before filling the edge cap`, () => {
    const children = Array.from({ length: 22 }, (_, i) => `child-${i}`);
    const parents = children.map((id) => edge(id, "root"));
    const extra = children.slice(0, 2).flatMap((id) =>
      children.slice(2).map((other) => edge(id, other))
    );
    const result = sample({
      version: 1,
      nodes: assets(["root", ...children, "leaf"]),
      edges: [...parents, ...extra, edge("leaf", children.at(-1)!)],
    }, kind);
    assertEquals(result.nodeCount, 24);
    assertEquals(result.edgeCount, 63);
    assertEquals(result.nodes.length, 24);
    assertEquals(result.edges.length, 40);
    assertEquals(result.truncated, true);

    const distances = new Map(
      result.nodes.map(({ id, distance }) => [id, distance]),
    );
    for (const { id, distance } of result.nodes) {
      if (distance === 0) continue;
      assert(
        result.edges.some(({ from, to }) =>
          (from === id && distances.get(to) === distance - 1) ||
          (kind === "trace" && to === id &&
            distances.get(from) === distance - 1)
        ),
        `Missing parent for ${id}`,
      );
    }
  });
}

Deno.test("Adaptive graph worker retains structured counts under the persisted result size limit", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "graph.json");
  const snapshot = {
    version: 1,
    nodes: [
      ...assets(["root", "near"]),
      { id: "large", kind: "asset", label: "x".repeat(15_000) },
    ],
    edges: [edge("near", "root"), edge("large", "root")],
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    for (const kind of ["trace", "impact"] as const) {
      assignSentinelTask(path, adaptiveRevision(state), kind, "root");
    }
    const { tasks } = readAdaptiveSentinel(path, state)!;
    assertEquals(tasks.length, 2);
    for (const task of tasks) {
      assertEquals(task.status, "completed");
      const observation = task.observation as Record<string, unknown>;
      assertEquals(observation.relatedNodeIds, ["root", "near"]);
      assertEquals(observation.resultDigest, undefined);
      const facts = observation[task.kind] as Record<string, unknown>;
      assertEquals(
        facts[task.kind === "trace" ? "nodeCount" : "assetCount"],
        3,
      );
      assertEquals(facts.edgeCount, 2);
      assertEquals(facts.truncated, true);
      assertEquals(facts.edges, [edge("near", "root")]);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
