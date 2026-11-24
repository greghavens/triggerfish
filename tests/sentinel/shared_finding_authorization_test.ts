import { assertEquals } from "@std/assert";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { publishSentinelInput } from "../../src/sentinel/published_input.ts";
import {
  createPinnedSentinelSharedFindingVerifier,
  digestSentinelSnapshot,
  readPinnedSentinelSharedFindingSource,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";

function asset(id: string, aliases: string[] = []) {
  return { id, kind: "asset", label: id, aliases };
}

function snapshot(
  assets: ReturnType<typeof asset>[],
  findingAsset?: string,
) {
  return loadSentinelGraph({
    version: 1,
    nodes: [
      ...assets,
      ...(findingAsset
        ? [{
          id: "reported",
          kind: "finding",
          label: "Finding",
          severity: "high",
        }]
        : []),
    ],
    edges: findingAsset
      ? [{ from: "reported", to: findingAsset, relation: "affects" }]
      : [],
  }).snapshot();
}

Deno.test("A pinned shared finding requires an exact retained source and an unambiguous assigned asset match", async () => {
  const base = await Deno.makeTempDir();
  try {
    const local = snapshot([asset("local", ["shared-id"]), asset("unrelated")]);
    const source = snapshot([asset("source", ["shared-id"])], "source");
    const reference = {
      caseId: "peer",
      localAssetId: "local",
      assetId: "source",
      findingId: "reported",
      snapshotDigest: digestSentinelSnapshot(source),
    };
    const publication = resolveSentinelCasePath(base, reference.caseId);
    await publishSentinelInput(publication, source);
    assertEquals(
      await readPinnedSentinelSharedFindingSource(
        base,
        local,
        reference,
        "main",
      ),
      undefined,
    );

    const archive = sentinelSourceSnapshotPath(
      base,
      reference.caseId,
      reference.snapshotDigest,
    );
    await publishSentinelInput(archive, source);
    await publishSentinelInput(publication, snapshot([asset("new-peer")]));
    assertEquals(
      await readPinnedSentinelSharedFindingSource(
        base,
        local,
        reference,
        "main",
      ),
      source,
    );
    assertEquals(
      await readPinnedSentinelSharedFindingSource(
        base,
        local,
        reference,
        "peer",
      ),
      undefined,
    );
    assertEquals(
      await readPinnedSentinelSharedFindingSource(base, local, {
        ...reference,
        localAssetId: "unrelated",
      }),
      undefined,
    );
    assertEquals(
      await readPinnedSentinelSharedFindingSource(base, local, {
        ...reference,
        localAssetId: "shared-id",
      }),
      undefined,
    );
    assertEquals(
      await readPinnedSentinelSharedFindingSource(base, local, {
        ...reference,
        findingId: "unreported",
      }),
      undefined,
    );

    const ambiguous = snapshot([
      asset("local", ["shared-id"]),
      asset("conflict", ["shared-id"]),
    ]);
    assertEquals(
      await readPinnedSentinelSharedFindingSource(base, ambiguous, reference),
      undefined,
    );

    const competing = snapshot(
      [asset("source", ["shared-id"]), asset("local")],
      "source",
    );
    const competingDigest = digestSentinelSnapshot(competing);
    await publishSentinelInput(
      sentinelSourceSnapshotPath(base, reference.caseId, competingDigest),
      competing,
    );
    assertEquals(
      await readPinnedSentinelSharedFindingSource(base, local, {
        ...reference,
        snapshotDigest: competingDigest,
      }),
      undefined,
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Synchronous carryover validates exact citations and isolates invalid archives", async () => {
  const base = await Deno.makeTempDir();
  try {
    const local = snapshot([asset("local", ["shared-id"]), asset("other")]);
    const source = snapshot([asset("peer-app", ["shared-id"])], "peer-app");
    const reference = {
      caseId: "peer",
      localAssetId: "local",
      assetId: "peer-app",
      findingId: "reported",
      snapshotDigest: digestSentinelSnapshot(source),
    };
    const archive = sentinelSourceSnapshotPath(
      base,
      reference.caseId,
      reference.snapshotDigest,
      true,
    );
    await publishSentinelInput(archive, source);
    const tampered = sentinelSourceSnapshotPath(
      base,
      "tampered",
      reference.snapshotDigest,
    );
    await publishSentinelInput(tampered, snapshot([asset("different")]));
    const linked = sentinelSourceSnapshotPath(
      base,
      "symlink",
      reference.snapshotDigest,
    );
    await publishSentinelInput(linked, source);
    await Deno.remove(linked);
    await Deno.symlink(archive, linked);
    const oversize = sentinelSourceSnapshotPath(
      base,
      "oversize",
      reference.snapshotDigest,
    );
    await publishSentinelInput(oversize, source);
    await Deno.truncate(oversize, 1024 * 1024 + 1);
    await publishSentinelInput(resolveSentinelCasePath(base, "live"), source);

    const { verify } = createPinnedSentinelSharedFindingVerifier(
      base,
      local,
      "main",
    );
    for (const caseId of ["tampered", "symlink", "oversize", "live", "main"]) {
      assertEquals(verify({ ...reference, caseId }), "invalid");
    }
    assertEquals(verify({ ...reference, findingId: "absent" }), "invalid");
    assertEquals(verify({ ...reference, localAssetId: "other" }), "invalid");
    assertEquals(verify(reference), "valid");
    const ambiguous = snapshot([
      asset("local", ["shared-id"]),
      asset("other", ["shared-id"]),
    ]);
    assertEquals(
      createPinnedSentinelSharedFindingVerifier(base, ambiguous, "main").verify(
        reference,
      ),
      "invalid",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Synchronous carryover resumes a valid deferred archive and keeps hot entries usable at the limit", async () => {
  const base = await Deno.makeTempDir();
  try {
    const local = snapshot([asset("local", ["shared-id"])]);
    const source = snapshot([asset("remote", ["shared-id"])], "remote");
    const reference = {
      caseId: "cached",
      localAssetId: "local",
      assetId: "remote",
      findingId: "reported",
      snapshotDigest: digestSentinelSnapshot(source),
    };
    const pending = { ...reference, caseId: "pending" };
    for (const { caseId, snapshotDigest } of [reference, pending]) {
      await publishSentinelInput(
        sentinelSourceSnapshotPath(base, caseId, snapshotDigest),
        source,
      );
    }
    const { verify, nextBatch } = createPinnedSentinelSharedFindingVerifier(
      base,
      local,
      "main",
    );
    const fill = (prefix: string) => {
      for (let index = 0; index < 31; index++) {
        assertEquals(
          verify({ ...reference, caseId: `${prefix}-${index}` }),
          "invalid",
        );
      }
    };
    assertEquals(verify(reference), "valid");
    fill("first");
    assertEquals(verify(pending), "deferred");
    assertEquals(verify(reference), "valid");

    nextBatch();
    assertEquals(verify(pending), "valid");
    assertEquals(verify(reference), "valid");
    fill("second");
    assertEquals(verify({ ...reference, caseId: "new" }), "deferred");
    assertEquals(verify(reference), "valid");
    assertEquals(verify({ ...reference, caseId: "first-0" }), "deferred");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
