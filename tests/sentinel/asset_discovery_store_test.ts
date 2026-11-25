import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  openSentinelAssetDiscoveryStore,
  type SentinelAssetDiscoveryRequest,
} from "../../src/sentinel/asset_discovery_store.ts";

const proposal: SentinelAssetDiscoveryRequest = {
  sourceCaseId: "source",
  taskId: `adaptive:${"a".repeat(64)}`,
  evidenceRevision: 3,
  sourceDigest: "b".repeat(64),
  claim: {
    kind: "alias",
    assetId: "asset",
    alias: "exact-alias",
    evidenceId: "evidence",
  },
};

Deno.test("Verified discovery proposals and operator decisions survive restart with exact source bindings", async () => {
  const directory = await Deno.makeTempDir();
  let time = 1_000;
  const now = () => time;
  try {
    const first = openSentinelAssetDiscoveryStore(directory, now);
    let id: string;
    try {
      const pending = first.propose(proposal);
      id = pending.id;
      assertEquals(pending, {
        ...proposal,
        id,
        status: "pending",
        version: 1,
        proposedAt: new Date(time).toISOString(),
        updatedAt: new Date(time).toISOString(),
      });
      const extra = { ...proposal, token: "discarded" };
      assertEquals(first.propose(extra), pending);
      assertEquals(first.list({ status: "pending", sourceCaseId: "source" }), [
        pending,
      ]);
      assertEquals(first.list({ sourceCaseId: "different" }), []);
      assertEquals(first.approve(id, 2), undefined);
      assertEquals(first.history(id).map(({ status }) => status), ["pending"]);
    } finally {
      first.close();
    }

    const second = openSentinelAssetDiscoveryStore(directory, now);
    const concurrent = openSentinelAssetDiscoveryStore(directory, now);
    try {
      time += 1_000;
      const approved = second.approve(id, 1)!;
      assertEquals(approved.status, "approved");
      assertEquals(concurrent.withdraw(id, 1), undefined);
      assertEquals(concurrent.propose(proposal), approved);
      assertEquals(second.list({ status: "approved" }), [approved]);
      time += 1_000;
      const withdrawn = concurrent.withdraw(id, 2)!;
      assertEquals(withdrawn.status, "withdrawn");
      assertEquals(second.propose(proposal), withdrawn);
      assertEquals(second.approve(id, 3), undefined);
      assertEquals(second.get(id), withdrawn);
      assertEquals(second.list({ status: "approved" }), []);
      assertEquals(
        second.history(id).map(({ version, status }) => [version, status]),
        [
          [1, "pending"],
          [2, "approved"],
          [3, "withdrawn"],
        ],
      );
      const changed = second.propose({
        ...proposal,
        sourceDigest: "c".repeat(64),
      });
      assert(changed.id !== id);
      assertEquals(second.list({ limit: 1, offset: 1 }), [changed]);
      const unapproved = second.withdraw(changed.id, 1)!;
      assertEquals(unapproved.status, "withdrawn");
      assertEquals(second.history(changed.id).map(({ status }) => status), [
        "pending",
        "withdrawn",
      ]);
    } finally {
      concurrent.close();
      second.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Discovery registry rejects invalid source, unsafe paths and unsupported relationship forms", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const data = join(directory, "data");
    await Deno.mkdir(data, { mode: 0o700 });
    const path = join(data, "sentinel-asset-discoveries.db");
    await Deno.writeTextFile(path, "", { mode: 0o644 });
    if (Deno.build.os !== "windows") {
      assertThrows(
        () => openSentinelAssetDiscoveryStore(directory),
        Error,
        "private regular file",
      );
      await Deno.chmod(path, 0o600);
    }
    const store = openSentinelAssetDiscoveryStore(directory);
    try {
      assertThrows(() =>
        store.propose({ ...proposal, sourceCaseId: "../outside" })
      );
      assertThrows(() => store.propose({ ...proposal, evidenceRevision: 0 }));
      assertThrows(() =>
        store.propose({
          ...proposal,
          claim: {
            kind: "relationship",
            assetId: "self",
            to: "self",
            relation: "resolved_to",
            evidenceId: "evidence",
          },
        })
      );
      assertThrows(() => store.list({ limit: 101 }));
      assertEquals(store.list(), []);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
