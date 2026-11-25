import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  pauseSentinelAssessment,
  readSentinelOperatingConstraintHistory,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintVersion,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  normalizeSentinelOperatingConstraints,
  sentinelOperatingConstraintsAllow,
} from "../../src/sentinel/operating_constraints.ts";

const graph = {
  version: 1,
  nodes: [
    {
      id: "app",
      kind: "asset",
      label: "Application",
      aliases: ["application"],
    },
    { id: "peer", kind: "asset", label: "Peer" },
    { id: "finding", kind: "finding", label: "Defensive gap", severity: "low" },
    { id: "mixed", kind: "evidence", label: "Shared review record" },
    { id: "local", kind: "evidence", label: "Local review record" },
  ],
  edges: [
    { from: "finding", to: "app", relation: "affects" },
    { from: "local", to: "finding", relation: "supports" },
    { from: "mixed", to: "finding", relation: "supports" },
    { from: "mixed", to: "peer", relation: "observed_on" },
  ],
};

Deno.test("operating constraints accept only bounded typed baseline restrictions and exact assets", () => {
  const constraints = normalizeSentinelOperatingConstraints({
    deniedKinds: ["trace", "trace"],
    allowedAssetIds: ["app", "app"],
    note: "Limit local review.",
  });
  const snapshot = loadSentinelGraph(graph).snapshot();
  assertEquals(constraints, {
    deniedKinds: ["trace"],
    allowedAssetIds: ["app"],
    note: "Limit local review.",
  });
  assert(
    sentinelOperatingConstraintsAllow(constraints, {
      kind: "impact",
      nodeId: "app",
    }, snapshot),
  );
  assert(
    sentinelOperatingConstraintsAllow(constraints, {
      kind: "review_finding",
      nodeId: "finding",
    }, snapshot),
  );
  assert(
    sentinelOperatingConstraintsAllow(constraints, {
      kind: "review_evidence",
      nodeId: "local",
    }, snapshot),
  );
  for (
    const task of [
      { kind: "trace", nodeId: "app" },
      { kind: "impact", nodeId: "application" },
      { kind: "impact", nodeId: "peer" },
      { kind: "review_evidence", nodeId: "mixed" },
      { kind: "coverage" },
    ] as const
  ) assert(!sentinelOperatingConstraintsAllow(constraints, task, snapshot));
  assert(
    !sentinelOperatingConstraintsAllow(
      { deniedKinds: [], allowedAssetIds: [] },
      { kind: "trace", nodeId: "app" },
      snapshot,
    ),
  );
  assertThrows(
    () =>
      normalizeSentinelOperatingConstraints({
        deniedKinds: ["arbitrary_tool"],
      }),
    Error,
    "Invalid",
  );
  assertThrows(
    () =>
      normalizeSentinelOperatingConstraints({
        deniedKinds: [],
        allowTools: ["arbitrary_tool"],
      }),
    Error,
    "Invalid",
  );
  assertThrows(
    () =>
      normalizeSentinelOperatingConstraints({
        deniedKinds: [],
        allowedAssetIds: Array.from(
          { length: 9 },
          (_, index) => String(index) + "a".repeat(500),
        ),
      }),
    Error,
    "serialized limit",
  );
});

Deno.test("operating constraint versions use current run and immutable exact revision CAS", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const started = startSentinelAssessment(path);
    const runId = started.plan.runId!;
    assertEquals(readSentinelOperatingConstraints(path), undefined);
    const input = {
      runId,
      evidenceRevision: started.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "local:owner",
      constraints: {
        deniedKinds: ["trace"] as const,
        allowedAssetIds: ["app"],
      },
    };
    for (
      const rejected of [
        { runId: crypto.randomUUID() },
        { evidenceRevision: started.revision + 1 },
        { expectedVersion: 1 },
        { constraints: { deniedKinds: [], allowedAssetIds: ["application"] } },
        { constraints: { deniedKinds: [], allowedAssetIds: ["finding"] } },
      ]
    ) {
      assertEquals(
        recordSentinelOperatingConstraints(path, { ...input, ...rejected }),
        undefined,
      );
    }
    const first = recordSentinelOperatingConstraints(path, input);
    assertExists(first);
    assertEquals(first.version, 1);
    assertEquals(recordSentinelOperatingConstraints(path, input), first);
    assertEquals(
      recordSentinelOperatingConstraints(path, {
        ...input,
        operatorScope: "other",
      }),
      undefined,
    );
    assertEquals(
      recordSentinelOperatingConstraints(path, {
        ...input,
        requestId: crypto.randomUUID(),
      }),
      undefined,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: graph.nodes.map((node) => ({
          ...node,
          label: node.label + " updated",
        })),
      }),
    );
    const refreshed = refreshSentinelAssessment(path);
    assertExists(refreshed);
    assert(refreshed.revision > started.revision);
    assertEquals(readSentinelOperatingConstraints(path), first);
    pauseSentinelAssessment(path);
    const second = recordSentinelOperatingConstraints(path, {
      ...input,
      requestId: crypto.randomUUID(),
      evidenceRevision: refreshed.revision,
      expectedVersion: 1,
      constraints: { deniedKinds: [] },
    });
    assertExists(second);
    assertEquals(second.version, 2);
    assertEquals(readSentinelOperatingConstraints(path), second);
    assertEquals(
      readSentinelOperatingConstraints(path, runId, started.revision),
      first,
    );
    assertEquals(readSentinelOperatingConstraintVersion(path, runId, 1), first);
    assertEquals(readSentinelOperatingConstraintHistory(path, runId), [
      second,
      first,
    ]);
    assertEquals(
      readSentinelOperatingConstraintHistory(path, runId, 30, started.revision),
      [first],
    );
    stopSentinelAssessment(path);
    const replacement = startSentinelAssessment(path);
    assertEquals(readSentinelOperatingConstraints(path), undefined);
    assertEquals(readSentinelOperatingConstraints(path, runId), second);
    assertEquals(recordSentinelOperatingConstraints(path, input), first);
    assertEquals(
      recordSentinelOperatingConstraints(path, {
        ...input,
        requestId: crypto.randomUUID(),
        evidenceRevision: replacement.revision,
        expectedVersion: 2,
      }),
      undefined,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
