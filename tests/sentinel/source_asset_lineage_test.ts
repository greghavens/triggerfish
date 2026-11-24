import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { publishSentinelInput } from "../../src/sentinel/published_input.ts";
import {
  digestSentinelSnapshot,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { readSentinelSourceAssetLineage } from "../../src/sentinel/source_asset_lineage.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

function graph(label: string, id = "app", aliases?: string[]) {
  return loadSentinelGraph({
    version: 1,
    nodes: [{ id, kind: "asset", label, assetType: "service", aliases }],
    edges: [],
  }).snapshot();
}

interface WireResponse {
  readonly requestId: number;
  readonly type: string;
  readonly lineage?: Awaited<ReturnType<typeof readSentinelSourceAssetLineage>>;
  readonly graph?: unknown;
}

Deno.test("Source asset lineage verifies case-scoped archive and quarantine versions with exact ID paging", async () => {
  const base = await Deno.makeTempDir();
  try {
    const current = graph("Current service");
    const old = graph("Original service");
    const quarantined = graph("Quarantined source");
    await publishSentinelInput(
      resolveSentinelCasePath(base, "source"),
      current,
    );
    await publishSentinelInput(
      resolveSentinelCasePath(base, "other-case"),
      graph("Other case source"),
    );
    for (
      const [snapshot, quarantine] of [[old, false], [old, true], [
        quarantined,
        true,
      ]] as const
    ) {
      await publishSentinelInput(
        sentinelSourceSnapshotPath(
          base,
          "source",
          digestSentinelSnapshot(snapshot),
          quarantine,
        ),
        snapshot,
      );
    }
    const aliasOnly = graph("Alias without exact anchor", "other-id", ["app"]);
    await publishSentinelInput(
      sentinelSourceSnapshotPath(
        base,
        "source",
        digestSentinelSnapshot(aliasOnly),
      ),
      aliasOnly,
    );
    await publishSentinelInput(
      sentinelSourceSnapshotPath(
        base,
        "source",
        "0".repeat(64),
      ),
      graph("Corrupt digest"),
    );
    await publishSentinelInput(
      sentinelSourceSnapshotPath(
        base,
        "other-case",
        digestSentinelSnapshot(old),
      ),
      old,
    );

    const versions = [];
    let after: string | undefined;
    let unavailable = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const page = await readSentinelSourceAssetLineage(base, "source", "app", {
        limit: 1,
        ...(after !== undefined && { after }),
      });
      assertEquals(page.publicationStatus, "published");
      assert(page.versions.length <= 1);
      versions.push(...page.versions);
      unavailable += page.unavailableArchiveCount;
      if (page.nextAfter === null) break;
      assert(after === undefined || page.nextAfter > after);
      after = page.nextAfter;
    }
    assertEquals(unavailable, 1);
    const byStorage = Object.fromEntries(
      versions.map((item) => [item.storage, item]),
    );
    assertEquals(versions.length, 3);
    assertEquals(byStorage.archive.asset.label, "Original service");
    assertEquals(byStorage.quarantine.asset.label, "Quarantined source");
    assertEquals(byStorage.published.asset.label, "Current service");
    assertEquals(byStorage.published.currentPublication, true);
    assertEquals(byStorage.archive.currentPublication, false);
    assertEquals(byStorage.archive.asset.assetType, "service");

    await Deno.remove(resolveSentinelCasePath(base, "source"));
    const unpublished = await readSentinelSourceAssetLineage(
      base,
      "source",
      "app",
    );
    assertEquals(unpublished.publicationStatus, "not_published");
    assertEquals(unpublished.versions.length, 2);
    await assertRejects(
      () => readSentinelSourceAssetLineage(base, "../other-case", "app"),
      Error,
      "Invalid Sentinel source",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Source asset lineage rejects archive directory aliases", async () => {
  if (Deno.build.os === "windows") return;
  const base = await Deno.makeTempDir();
  try {
    const snapshot = graph("Other case");
    const digest = digestSentinelSnapshot(snapshot);
    const other = sentinelSourceSnapshotPath(base, "other", digest);
    const spoofed = sentinelSourceSnapshotPath(base, "spoofed", digest);
    await publishSentinelInput(other, snapshot);
    await Deno.symlink(dirname(other), dirname(spoofed), { type: "dir" });
    await assertRejects(
      () => readSentinelSourceAssetLineage(base, "spoofed", "app"),
      Error,
      "operator-controlled directory",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Tidepool requires an authenticated socket for exact source lineage and archived reverse lookup", async () => {
  const baseDir = await Deno.makeTempDir();
  const handler = createTidepoolSentinelHandler(
    { baseDir, config: {} } as BootstrapResult,
  );
  let routed = 0;
  const state: A2UIHostState = {
    clients: new Set(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: "sentinel-lineage-test-key",
    lastMcpConnected: -1,
    lastMcpConfigured: 0,
    socketCleanupCallbacks: [],
    canvasRenders: [],
    topicHandlers: {
      sentinel(message, socket) {
        routed++;
        void handler(message, socket);
      },
    },
  };
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen() {},
  }, (request) => routeHostRequest(request, state, undefined));
  let operator: WebSocket | undefined;
  try {
    const address = `ws://127.0.0.1:${server.addr.port}`;
    const denied = new WebSocket(address);
    const closed = await new Promise<CloseEvent>((resolve) =>
      denied.addEventListener("close", resolve, { once: true })
    );
    assertEquals(closed.code, 4401);
    assertEquals(routed, 0);

    const archive = graph("Historical exact anchor");
    const digest = digestSentinelSnapshot(archive);
    await publishSentinelInput(
      sentinelSourceSnapshotPath(baseDir, "source", digest, true),
      archive,
    );
    await publishSentinelInput(
      resolveSentinelCasePath(baseDir, "other-case"),
      graph("Unrelated case"),
    );
    operator = new WebSocket(address + "?key=sentinel-lineage-test-key");
    await new Promise<void>((resolve) =>
      operator!.addEventListener("open", () => resolve(), { once: true })
    );

    const request = async (
      requestId: number,
      input: Record<string, unknown>,
    ) => {
      const websocket = operator!;
      const reply = new Promise<WireResponse>((resolve) => {
        const onMessage = ({ data }: MessageEvent) => {
          const message = JSON.parse(String(data)) as WireResponse;
          if (message.requestId !== requestId) return;
          websocket.removeEventListener("message", onMessage);
          resolve(message);
        };
        websocket.addEventListener("message", onMessage);
      });
      websocket.send(
        JSON.stringify({ topic: "sentinel", requestId, ...input }),
      );
      return await reply;
    };

    const lineage = await request(1, {
      type: "source_asset_lineage",
      sourceCase: "source",
      asset: "app",
    });
    assertEquals(lineage.type, "sentinel_source_asset_lineage");
    assert(lineage.lineage);
    assertEquals(
      lineage.lineage.versions.map((
        { snapshotDigest }: { snapshotDigest: string },
      ) => snapshotDigest),
      [digest],
    );
    assertEquals(lineage.lineage.versions[0].storage, "quarantine");
    const opened = await request(2, {
      type: "source_snapshot",
      sourceCase: "source",
      asset: "app",
      snapshotDigest: digest,
    });
    assertEquals(opened.graph, archive);
    const invalid = await request(3, {
      type: "source_asset_lineage",
      sourceCase: "../other-case",
      asset: "app",
    });
    assertEquals(invalid.type, "error");
  } finally {
    operator?.close();
    await server.shutdown();
    await Deno.remove(baseDir, { recursive: true });
  }
});
