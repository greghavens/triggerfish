import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
  readSharedSentinelAssetLinks,
  readSharedSentinelFindingSource,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";

function graph(source: string) {
  return {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Application" },
      { id: "other", kind: "asset", label: "Unrelated asset" },
      {
        id: "reported",
        kind: "finding",
        label: `Finding from ${source}`,
        severity: "high",
      },
      {
        id: "unlinked",
        kind: "finding",
        label: "Unlinked finding",
        severity: "low",
      },
      { id: "original-record", kind: "evidence", label: "Original record" },
    ],
    edges: [
      { from: "reported", to: "app", relation: "affects" },
      { from: "original-record", to: "reported", relation: "supports" },
    ],
  };
}

Deno.test("Shared finding pages retain exact sources without archiving other pages", async () => {
  const base = await Deno.makeTempDir();
  try {
    for (const source of ["first", "second"]) {
      const path = resolveSentinelCasePath(base, source);
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(path, JSON.stringify(graph(source)));
    }
    const page = await readSharedSentinelAssetLinks(
      base,
      "app",
      0,
      1,
      undefined,
      undefined,
      true,
      { retainSourceSnapshots: true },
    );
    assertEquals(page.links, []);
    assertEquals(page.totalFindings, 2);
    assertEquals(page.findings?.[0]?.caseId, "first");
    assertEquals(page.nextOffset, 1);
    const first = page.findings![0];
    const secondDigest = digestSentinelSnapshot(
      loadSentinelGraph(graph("second")).snapshot(),
    );
    await assertRejects(
      () => readArchivedSentinelSnapshot(base, "second", secondDigest),
      Deno.errors.NotFound,
    );
    const currentOnly = await readSharedSentinelFindingSource(base, {
      caseId: "second",
      snapshotDigest: secondDigest,
      assetId: "app",
      findingId: "reported",
    });
    assertEquals(currentOnly.status, "available");
    assert(currentOnly.status === "available" && currentOnly.published);

    const path = resolveSentinelCasePath(base, "first");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...graph("republished"), edges: [] }),
    );
    const reference = {
      caseId: first.caseId,
      assetId: first.assetId,
      snapshotDigest: first.snapshotDigest,
      findingId: first.finding.id,
    };
    const archived = await readSharedSentinelFindingSource(base, reference);
    assert(archived.status === "available");
    assertEquals(archived.published, false);
    assertEquals(archived.graph, loadSentinelGraph(graph("first")).snapshot());
    assertEquals(
      await readSharedSentinelFindingSource(base, {
        ...reference,
        assetId: "other",
      }),
      {
        status: "finding_unavailable",
      },
    );
    assertEquals(
      await readSharedSentinelFindingSource(base, {
        ...reference,
        findingId: "unlinked",
      }),
      {
        status: "finding_unavailable",
      },
    );
    assertEquals(
      await readSharedSentinelFindingSource(base, {
        ...reference,
        caseId: "second",
      }),
      {
        status: "source_changed",
      },
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Corrupt archived shared finding sources fail integrity checks even when the live source matches", async () => {
  const base = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(base, "source");
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const original = graph("source");
    await Deno.writeTextFile(path, JSON.stringify(original));
    const page = await readSharedSentinelAssetLinks(
      base,
      "app",
      0,
      1,
      undefined,
      undefined,
      true,
      { retainSourceSnapshots: true },
    );
    const { caseId, assetId, snapshotDigest, finding } = page.findings![0];
    await Deno.writeTextFile(
      sentinelSourceSnapshotPath(base, caseId, snapshotDigest),
      JSON.stringify(graph("incorrect content")),
    );
    await assertRejects(
      () =>
        readSharedSentinelFindingSource(base, {
          caseId,
          assetId,
          snapshotDigest,
          findingId: finding.id,
        }),
      Error,
      "integrity check failed",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
