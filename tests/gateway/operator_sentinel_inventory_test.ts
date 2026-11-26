import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname } from "@std/path";
import { readOperatorSentinelInventory } from "../../src/gateway/operator_sentinel_inventory.ts";
import {
  readSentinelAssessmentRevision,
  recordSentinelFindingReview,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";

const original = {
  version: 1,
  nodes: [
    {
      id: "asset-a",
      kind: "asset",
      label: "Original asset",
      aliases: ["legacy.example"],
      organization: { id: "ops", label: "Operations" },
    },
    {
      id: "asset-b",
      kind: "asset",
      label: "Second asset",
      organization: { id: "ops", label: "Operations" },
    },
    { id: "finding", kind: "finding", label: "Finding", severity: "medium" },
    { id: "evidence", kind: "evidence", label: "Evidence receipt" },
  ],
  edges: [
    { from: "finding", to: "asset-a", relation: "affects" },
    { from: "evidence", to: "finding", relation: "supports" },
  ],
};

Deno.test("operator inventory binds exact historical graph, organization and review status to one revision", async () => {
  const base = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(base, "main");
    const peer = resolveSentinelCasePath(base, "peer-case");
    const published = resolveSentinelCasePath(base, "published-only");
    for (const file of [path, peer, published]) {
      await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(file, JSON.stringify(original));
    }
    const old = startSentinelAssessment(path);
    const other = startSentinelAssessment(peer);
    assert(
      recordSentinelFindingReview(
        path,
        old.revision,
        "finding",
        "confirmed",
        "Private analyst notes.",
      ),
    );
    const scoped = {
      kind: "sentinel",
      id: "main",
      revision: old.revision,
    } as const;
    const view = (args: Record<string, unknown>) =>
      readOperatorSentinelInventory(base, scoped, args);
    const oldSnapshot = readSentinelAssessmentRevision(path, old.revision)
      ?.result.sharedGraph.snapshot;
    assertExists(oldSnapshot);
    const first = view({ organizationId: "ops", limit: 1 });
    assert(first?.view === "assets");
    assertEquals(first.assets.map(({ label }) => label), ["Original asset"]);
    assertEquals(first.snapshotDigest, digestSentinelSnapshot(oldSnapshot));
    const cursor = first.nextCursor;
    assertExists(cursor);
    const retained = view({ organizationId: "ops", cursor });
    assert(retained?.view === "assets");
    assertEquals(retained.assets.map(({ id }) => id), ["asset-b"]);
    assertEquals(view({ cursor }), undefined);
    assertEquals(
      readOperatorSentinelInventory(base, {
        kind: "sentinel",
        id: "peer-case",
        revision: other.revision,
      }, { organizationId: "ops", cursor }),
      undefined,
    );
    assertEquals(
      readOperatorSentinelInventory(base, scoped, { view: "assets" }, "PUBLIC"),
      undefined,
    );
    assertEquals(
      readOperatorSentinelInventory(
        base,
        { ...scoped, id: "published-only" },
        {},
      ),
      undefined,
    );
    assertEquals(view({ scopeBinding: "other" }), undefined);
    const organizations = view({
      view: "organizations",
      alias: "legacy.example",
    });
    assert(organizations?.view === "organizations");
    assertEquals(organizations.organizations, [{
      id: "ops",
      label: "Operations",
      assetCount: 1,
    }]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...original,
        nodes: original.nodes.map((node) =>
          node.id === "asset-a"
            ? { ...node, label: "Current asset", aliases: ["renewed.example"] }
            : node
        ),
      }),
    );
    const current = refreshSentinelAssessment(path);
    assert(current && current.revision > old.revision);
    assert(
      recordSentinelFindingReview(
        path,
        current.revision,
        "finding",
        "resolved",
        "Current revision only.",
      ),
    );
    const oldCoverage = view({ view: "coverage", assetId: "asset-a" });
    const newCoverage = readOperatorSentinelInventory(base, {
      ...scoped,
      revision: current.revision,
    }, { view: "coverage", assetId: "asset-a" });
    assert(
      oldCoverage?.view === "coverage" && "assets" in oldCoverage &&
        newCoverage?.view === "coverage" && "assets" in newCoverage,
    );
    assertEquals(oldCoverage.assets[0].asset.label, "Original asset");
    assertEquals(
      oldCoverage.assets[0].findings[0].review?.disposition,
      "confirmed",
    );
    assertEquals(newCoverage.assets[0].asset.label, "Current asset");
    assertEquals(
      newCoverage.assets[0].findings[0].review?.disposition,
      "resolved",
    );
    assertEquals(oldCoverage.assets[0].evidence.map(({ id }) => id), [
      "evidence",
    ]);
    assert(!JSON.stringify(oldCoverage).includes("Private analyst notes."));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("operator membership inventory uses the latest exact approved membership version", async () => {
  const base = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(base);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, JSON.stringify(original));
    const state = startSentinelAssessment(path);
    const ref = {
      kind: "sentinel",
      id: "main",
      revision: state.revision,
    } as const;
    const read = (filters: Record<string, unknown> = {}) =>
      readOperatorSentinelInventory(base, ref, {
        scope: "membership",
        ...filters,
      });
    assertEquals(read(), undefined);
    const snapshot = readSentinelAssessmentRevision(path, state.revision)
      ?.result.sharedGraph.snapshot;
    const baseUpdate = {
      runId: state.plan.runId!,
      evidenceRevision: state.revision,
      operatorScope: "owner",
    };
    const approve = (assetIds: string[], expectedVersion: number) => {
      const membership = resolveSentinelCaseMembership(snapshot, {
        caseId: "main",
        evidenceRevision: state.revision,
        selector: { kind: "assets", assetIds },
      });
      assertExists(membership);
      const record = recordSentinelOperatingConstraints(path, {
        ...baseUpdate,
        expectedVersion,
        requestId: crypto.randomUUID(),
        constraints: { deniedKinds: [], allowedAssetIds: membership.assetIds },
        membership,
      });
      assertExists(record);
      return record;
    };
    const first = approve(["asset-b"], 0);
    const coverage = read({ view: "coverage" });
    assert(coverage?.view === "coverage" && "assets" in coverage);
    assertEquals(coverage.assets.map(({ asset }) => asset.id), ["asset-b"]);
    assertEquals(coverage.membership?.version, first.version);
    assertEquals(
      coverage.membership?.sourceSnapshotDigest,
      first.membership?.snapshotDigest,
    );
    const organizations = read({ view: "organizations" });
    assert(organizations?.view === "organizations");
    assertEquals(
      organizations.organizations.map(({ assetCount }) => assetCount),
      [1],
    );
    const second = approve(["asset-a", "asset-b"], 1);
    const page = read({ limit: 1 });
    assert(page?.view === "assets");
    assertExists(page.nextCursor);
    assertEquals(page.membership?.version, second.version);
    assertEquals(read({ scope: "case", cursor: page.nextCursor }), undefined);
    const later = read({ cursor: page.nextCursor });
    assert(later?.view === "assets");
    assertEquals(later.assets.map(({ id }) => id), ["asset-b"]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...original,
        nodes: [...original.nodes, {
          id: "asset-c",
          kind: "asset",
          label: "New organization member",
          organization: { id: "ops", label: "Operations" },
        }],
      }),
    );
    const refreshed = refreshSentinelAssessment(path);
    assert(refreshed && refreshed.revision > state.revision);
    const newRef = { ...ref, revision: refreshed.revision };
    const carried = readOperatorSentinelInventory(base, newRef, {
      scope: "membership",
    });
    assert(carried?.view === "assets");
    assertEquals(carried.assets.map(({ id }) => id), ["asset-a", "asset-b"]);
    assertEquals(carried.membership?.sourceEvidenceRevision, state.revision);
    assertEquals(
      carried.membership?.sourceSnapshotDigest,
      second.membership?.snapshotDigest,
    );
    assertEquals(
      readOperatorSentinelInventory(base, newRef, {
        scope: "membership",
        cursor: page.nextCursor,
      }),
      undefined,
    );
    assert(recordSentinelOperatingConstraints(path, {
      ...baseUpdate,
      evidenceRevision: refreshed.revision,
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
      constraints: { deniedKinds: [] },
    }));
    assertEquals(
      readOperatorSentinelInventory(base, newRef, { scope: "membership" }),
      undefined,
    );
    assertEquals(read()?.membership?.version, second.version);
    stopSentinelAssessment(path);
    const replacement = startSentinelAssessment(path);
    assertEquals(
      readOperatorSentinelInventory(base, {
        ...ref,
        revision: replacement.revision,
      }, { scope: "membership" }),
      undefined,
    );
    assertEquals(read()?.membership?.version, second.version);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
