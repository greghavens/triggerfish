import { gzipSync } from "node:zlib";
import { MAX_SNAPSHOT_BYTES } from "../../src/sentinel/chat_mode.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  applySharedSentinelTopology,
  collectSharedSentinelTopology,
  decodeSentinelSourceBundleEntry,
  digestSentinelSnapshot,
  encodeSentinelSourceBundleEntry,
  readArchivedSentinelSnapshot,
  readSharedSentinelAssetLinks,
} from "../../src/sentinel/shared_inventory.ts";

const local = {
  version: 1,
  nodes: [
    {
      id: "app",
      kind: "asset",
      label: "Application",
      aliases: ["app.example.invalid"],
    },
    {
      id: "db",
      kind: "asset",
      label: "Database",
      aliases: ["db.example.invalid"],
    },
  ],
  edges: [],
};
const original = {
  version: 1,
  nodes: [
    { ...local.nodes[0], id: "source-app" },
    { ...local.nodes[1], id: "source-db" },
  ],
  edges: [{ from: "source-app", to: "source-db", relation: "depends_on" }],
};

Deno.test("Republished shared topology does not create independent evidence or retain withdrawn links", async () => {
  const base = await Deno.makeTempDir();

  async function publish(caseId: string, snapshot: unknown) {
    const path = resolveSentinelCasePath(base, caseId);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    return path;
  }

  try {
    const main = await publish("main", local);
    await publish("original", original);
    const relayPath = await publish("relay", local);
    const relayOverlay = await collectSharedSentinelTopology(
      base,
      "relay",
      relayPath,
      undefined,
      true,
    );
    const [reported] = relayOverlay;
    assert(reported);
    assertEquals(reported.caseIds, ["original"]);
    const digest = reported.sourceDigests?.original;
    assert(digest);

    const relay = applySharedSentinelTopology(local, relayOverlay);
    relay.edges.push({ from: "app", to: "db", relation: "uses_hostname" });
    await publish("relay", relay);

    // Old exported overlays may lack digests, but still claim borrowed provenance.
    const legacy = applySharedSentinelTopology(local, [{
      from: "app",
      to: "db",
      relation: "depends_on",
      caseIds: ["original"],
    }]);
    await publish("legacy", legacy);

    const reference = loadSentinelGraph(local).snapshot();
    const before = await readSharedSentinelAssetLinks(
      base,
      "app",
      0,
      20,
      undefined,
      reference,
    );
    assertEquals(
      before.links.map(({ relation, caseIds }) => [relation, caseIds]),
      [
        ["depends_on", ["original"]],
        ["uses_hostname", ["relay"]],
      ],
    );
    const synchronized = await collectSharedSentinelTopology(
      base,
      "main",
      main,
    );
    assertEquals(
      synchronized.map(({ relation, caseIds }) => [relation, caseIds]),
      [
        ["depends_on", ["original"]],
        ["uses_hostname", ["relay"]],
      ],
    );

    await publish("original", { ...original, edges: [] });
    const after = await readSharedSentinelAssetLinks(
      base,
      "app",
      0,
      20,
      undefined,
      reference,
    );
    assertEquals(
      after.links.map(({ relation, caseIds }) => [relation, caseIds]),
      [
        ["uses_hostname", ["relay"]],
      ],
    );
    assertEquals(
      (await collectSharedSentinelTopology(base, "main", main)).map((
        { relation },
      ) => relation),
      [
        "uses_hostname",
      ],
    );
    assertEquals(
      await readArchivedSentinelSnapshot(base, "original", digest),
      loadSentinelGraph(original).snapshot(),
    );
    assert(
      relay.nodes.find((node) =>
        node.kind === "evidence" &&
        node.relationshipSources?.[0]?.snapshotDigest === digest
      ),
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Compressed Sentinel source entries enforce snapshot integrity and decompression bounds", () => {
  const snapshot = loadSentinelGraph({
    ...original,
    nodes: [
      ...original.nodes,
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `record-${index}`,
        kind: "evidence",
        label: "Saved evidence metadata ".repeat(12),
      })),
    ],
  }).snapshot();
  const digest = digestSentinelSnapshot(snapshot);
  const entry = JSON.parse(
    encodeSentinelSourceBundleEntry("source", digest, snapshot),
  );
  assert(typeof entry.gzip === "string");
  assertEquals(decodeSentinelSourceBundleEntry(entry, digest), snapshot);
  assertThrows(
    () => decodeSentinelSourceBundleEntry(entry, "0".repeat(64)),
    Error,
    "integrity check failed",
  );
  assertThrows(
    () => decodeSentinelSourceBundleEntry({ ...entry, snapshot }, digest),
    Error,
    "Invalid compressed Sentinel source snapshot",
  );
  const oversized = gzipSync(new Uint8Array(MAX_SNAPSHOT_BYTES + 1).fill(32))
    .toString("base64");
  assertThrows(
    () => decodeSentinelSourceBundleEntry({ gzip: oversized }, digest),
    RangeError,
  );
});
