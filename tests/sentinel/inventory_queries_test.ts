import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  querySentinelAssetInventory,
  querySentinelAssetReviewCoverage,
  querySentinelOrganizations,
} from "../../src/sentinel/inventory_queries.ts";

const security = { id: "sec", label: "Security" };
const ops = { id: "ops", label: "Operations" };
const digest = "a".repeat(64);
const snapshot = {
  version: 1,
  nodes: [
    {
      id: "service",
      kind: "asset",
      label: "Web service",
      assetType: "service",
      parentId: "host",
      organization: security,
    },
    {
      id: "host",
      kind: "asset",
      label: "Host",
      assetType: "root_domain",
      aliases: ["Host.example"],
      organization: security,
    },
    { id: "other", kind: "asset", label: "Other", organization: ops },
    { id: "unknown", kind: "asset", label: "Unassigned" },
    { id: "finding", kind: "finding", label: "Finding", severity: "high" },
    { id: "historical", kind: "finding", label: "Historical", severity: "low" },
    {
      id: "source",
      kind: "evidence",
      label: "Record",
      relationshipSources: [
        {
          caseId: "peer",
          from: "collector",
          to: "peer-host",
          snapshotDigest: digest,
        },
        { caseId: "legacy", from: "collector", to: "legacy-host" },
      ],
    },
    { id: "observed", kind: "evidence", label: "Direct" },
    { id: "unrelated", kind: "evidence", label: "Other evidence" },
  ],
  edges: [
    { from: "finding", to: "host", relation: "affects" },
    { from: "historical", to: "host", relation: "affects" },
    { from: "source", to: "finding", relation: "supports" },
    { from: "observed", to: "host", relation: "observed_on" },
    { from: "unrelated", to: "other", relation: "observed_on" },
  ],
};

Deno.test("published organization metadata survives round trip and rejects ambiguity", () => {
  const canonical = loadSentinelGraph(snapshot).snapshot();
  assertEquals(loadSentinelGraph(canonical).snapshot(), canonical);
  const old = canonical.nodes.find((node) => node.id === "unknown");
  assertEquals(Object.hasOwn(old!, "organization"), false);
  assertThrows(
    () =>
      loadSentinelGraph({
        ...snapshot,
        nodes: [...snapshot.nodes, {
          kind: "asset",
          id: "additional",
          label: "Additional",
          organization: { ...security, label: "Conflicting" },
        }],
      }),
    Error,
    "Conflicting Sentinel organization labels",
  );
  for (
    const invalid of [{ ...security, extra: true }, {
      ...security,
      id: "sec\0ops",
    }]
  ) {
    assertThrows(
      () =>
        loadSentinelGraph({
          ...snapshot,
          nodes: [{
            ...snapshot.nodes[0],
            parentId: undefined,
            organization: invalid,
          }],
        }),
      Error,
      "Invalid Sentinel asset organization",
    );
  }
  assertThrows(
    () =>
      loadSentinelGraph({
        ...snapshot,
        nodes: [{ ...snapshot.nodes[4], organization: security }],
      }),
    Error,
    "belongs on an asset node",
  );
});

Deno.test("inventory and organization cursors retain exact filters and snapshot scope", () => {
  const first = querySentinelAssetInventory(snapshot, {
    organizationId: "sec",
    limit: 1,
  });
  assertEquals(first.assets.map(({ id }) => id), ["host"]);
  assertExists(first.nextCursor);
  const later = querySentinelAssetInventory(snapshot, {
    organizationId: "sec",
    cursor: first.nextCursor,
  });
  assertEquals(later.assets.map(({ id }) => id), ["service"]);
  assertEquals(later.nextCursor, null);
  assertThrows(
    () => querySentinelAssetInventory(snapshot, { cursor: first.nextCursor! }),
    Error,
    "stale",
  );
  assertThrows(
    () =>
      querySentinelAssetInventory({
        ...snapshot,
        nodes: [...snapshot.nodes, { id: "new", kind: "asset", label: "New" }],
      }, { organizationId: "sec", cursor: first.nextCursor! }),
    Error,
    "stale",
  );
  assertEquals(
    querySentinelAssetInventory(snapshot, { onlyAsset: "Host.example" }).assets,
    [],
  );
  assertEquals(
    querySentinelAssetInventory(snapshot, { alias: "host.example" }).assets,
    [],
  );
  assertEquals(
    querySentinelAssetInventory(snapshot, { alias: "Host.example" }).assets.map(
      ({ id }) => id,
    ),
    ["host"],
  );
  assertEquals(
    querySentinelAssetInventory(snapshot, {
      parentId: "host",
      assetType: "service",
    }).assets.map(({ id }) => id),
    ["service"],
  );
  const organizations = querySentinelOrganizations(snapshot, { limit: 1 });
  const scoped = querySentinelOrganizations(snapshot, {
    limit: 1,
    scopeBinding: "case-a/assignment-a",
  });
  assertExists(scoped.nextCursor);
  assertThrows(
    () =>
      querySentinelOrganizations(snapshot, {
        cursor: scoped.nextCursor!,
        scopeBinding: "case-a/assignment-b",
      }),
    Error,
    "stale",
  );
  assertEquals(organizations.organizations, [{ ...ops, assetCount: 1 }]);
  assertExists(organizations.nextCursor);
  assertEquals(
    querySentinelOrganizations(snapshot, { cursor: organizations.nextCursor })
      .organizations,
    [{ ...security, assetCount: 2 }],
  );
  assertEquals(
    querySentinelOrganizations(snapshot, { parentId: "host" }).organizations,
    [{ ...security, assetCount: 1 }],
  );
  assertThrows(
    () => querySentinelOrganizations(snapshot, { cursor: first.nextCursor! }),
    Error,
    "stale",
  );
});

Deno.test("coverage keeps reviews distinct from exact observed evidence and source snapshots", () => {
  const at = "2026-11-24T04:03:02.000Z";
  const reviews = [
    {
      id: 3,
      findingId: "finding",
      revision: 2,
      disposition: "confirmed",
      at,
      note: "Private",
    },
    {
      id: 2,
      findingId: "finding",
      revision: 2,
      disposition: "open",
      at,
      note: "",
    },
    {
      id: 4,
      findingId: "historical",
      revision: 1,
      disposition: "resolved",
      at,
      note: "",
    },
  ] as const;
  const coverage = querySentinelAssetReviewCoverage(snapshot, reviews, {
    evidenceRevision: 2,
    onlyAsset: "host",
    reviewedAssetIds: ["other"],
    evidenceReviewTasks: [{ evidenceId: "source", taskId: "task" }, {
      evidenceId: "unrelated",
      taskId: "outside",
    }],
  });
  assertEquals(coverage.assets.length, 1);
  const { asset, reviewed, findings, evidence } = coverage.assets[0];
  assertEquals(asset.id, "host");
  assertEquals(reviewed, false);
  assertEquals(findings, [
    { id: "finding", review: { id: 3, disposition: "confirmed", at } },
    { id: "historical", review: null },
  ]);
  assertEquals(evidence, [
    {
      id: "observed",
      direct: true,
      supportsFindingIds: [],
      reviewTaskIds: [],
      sourceSnapshots: [],
    },
    {
      id: "source",
      direct: false,
      supportsFindingIds: ["finding"],
      reviewTaskIds: ["task"],
      sourceSnapshots: [{
        caseId: "peer",
        snapshotDigest: digest,
        from: "collector",
        to: "peer-host",
      }],
    },
  ]);
  const paged = querySentinelAssetReviewCoverage(snapshot, reviews, {
    evidenceRevision: 2,
    limit: 1,
  });
  assertExists(paged.nextCursor);
  assertThrows(
    () =>
      querySentinelAssetReviewCoverage(snapshot, reviews, {
        evidenceRevision: 2,
        cursor: paged.nextCursor!,
        reviewedAssetIds: ["host"],
      }),
    Error,
    "stale",
  );
});
