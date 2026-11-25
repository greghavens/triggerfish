import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  digestSentinelSnapshot,
  readSharedSentinelAssetCatalog,
  readSharedSentinelAssets,
} from "../../src/sentinel/shared_inventory.ts";

const main = {
  version: 1,
  nodes: [
    {
      id: "a-main",
      kind: "asset",
      label: "Main",
      aliases: ["shared"],
      organization: { id: "ops", label: "Operations" },
    },
    { id: "b-main", kind: "asset", label: "Another" },
  ],
  edges: [],
};
const peer = {
  version: 1,
  nodes: [
    { id: "root", kind: "asset", label: "Root", assetType: "root_domain" },
    {
      id: "peer-service",
      kind: "asset",
      label: "Service",
      aliases: ["shared"],
      assetType: "service",
      parentId: "root",
      organization: { id: "sec", label: "Security" },
    },
  ],
  edges: [],
};

async function writeCase(base: string, id: string, snapshot: unknown) {
  const path = resolveSentinelCasePath(base, id);
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(path, JSON.stringify(snapshot), { mode: 0o600 });
}

Deno.test("shared catalog preserves exact source tuples and filters within a single publication", async () => {
  const base = await Deno.makeTempDir();
  try {
    await writeCase(base, "main", main);
    await writeCase(base, "peer", peer);
    const catalog = await readSharedSentinelAssetCatalog(base, {
      alias: "shared",
    });
    assertEquals(catalog.assets.map(({ id }) => id), ["a-main"]);
    const expectedPeerSource = {
      caseId: "peer",
      assetId: "peer-service",
      label: "Service",
      aliases: ["shared"],
      assetType: "service" as const,
      parentId: "root",
      organization: { id: "sec", label: "Security" },
      snapshotDigest: digestSentinelSnapshot(
        loadSentinelGraph(peer).snapshot(),
      ),
    };
    assertEquals(catalog.assets[0].sources[1], expectedPeerSource);
    const filtered = await readSharedSentinelAssetCatalog(base, {
      caseId: "peer",
      parentId: "root",
      alias: "shared",
      assetType: "service",
      organizationId: "sec",
    });
    assertEquals(filtered.assets, [{
      id: "peer-service",
      sources: [expectedPeerSource],
    }]);
    for (
      const wrong of [
        { caseId: "peer", organizationId: "ops" },
        { assetType: "service" as const, organizationId: "ops" },
        { alias: "Shared" },
      ]
    ) {
      assertEquals(
        (await readSharedSentinelAssetCatalog(base, wrong)).assets,
        [],
      );
    }
    const legacy = await readSharedSentinelAssets(base, "shared", 0, 20);
    assertEquals(legacy.assets[0].sources, [
      { caseId: "main", label: "Main", aliases: ["shared"] },
      {
        caseId: "peer",
        label: "Service",
        aliases: ["shared"],
        assetId: "peer-service",
        assetType: "service",
        parentId: "root",
      },
    ]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("shared catalog keyset cursors reject changed filters and published manifests", async () => {
  const base = await Deno.makeTempDir();
  try {
    await writeCase(base, "main", main);
    await writeCase(base, "peer", peer);
    const first = await readSharedSentinelAssetCatalog(base, { limit: 1 });
    assertEquals(first.assets.map(({ id }) => id), ["a-main"]);
    assertExists(first.nextCursor);
    const next = await readSharedSentinelAssetCatalog(base, {
      cursor: first.nextCursor,
    });
    assertEquals(next.assets.map(({ id }) => id), ["b-main", "root"]);
    assertEquals(next.manifestDigest, first.manifestDigest);
    assertEquals(next.nextCursor, null);
    await assertRejects(
      () =>
        readSharedSentinelAssetCatalog(base, {
          caseId: "main",
          cursor: first.nextCursor!,
        }),
      Error,
      "Stale Sentinel catalog cursor",
    );
    await writeCase(base, "peer", {
      ...peer,
      nodes: peer.nodes.map((node) => ({
        ...node,
        label: node.label + " updated",
      })),
    });
    await assertRejects(
      () => readSharedSentinelAssetCatalog(base, { cursor: first.nextCursor! }),
      Error,
      "Stale Sentinel catalog cursor",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
