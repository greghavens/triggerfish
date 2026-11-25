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
  const requestId = crypto.randomUUID();
  try {
    const first = openSentinelAssetDiscoveryStore(directory, now);
    let id: string;
    try {
      const pending = first.propose(proposal, requestId);
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
      const receipt = concurrent.readProposalReceipt(requestId.toUpperCase());
      assertEquals(receipt?.status, "pending");
      assertEquals(receipt?.version, 1);
      assertEquals(concurrent.propose(proposal, requestId), receipt);
      assertThrows(
        () =>
          concurrent.propose(
            { ...proposal, sourceCaseId: "different" },
            requestId,
          ),
        Error,
        "Conflicting Sentinel discovery request ID",
      );
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

Deno.test("Bulk discovery withdrawal applies only the exact approved source-case preview and replays immutably", async () => {
  const dir = await Deno.makeTempDir();
  let time = 1_000;
  const now = () => time;
  const first = openSentinelAssetDiscoveryStore(dir, now);
  const second = openSentinelAssetDiscoveryStore(dir, now);
  const approve = (sourceCaseId: string, alias: string) => {
    const pending = first.propose({
      ...proposal,
      sourceCaseId,
      claim: { kind: "alias", assetId: "asset", alias, evidenceId: "evidence" },
    });
    const approved = first.approve(pending.id, pending.version);
    assert(approved);
    return approved;
  };
  try {
    const a = approve("source", "one");
    const b = approve("source", "two");
    const unrelated = approve("other-source", "other");
    const request = {
      sourceCaseId: "source",
      requestId: crypto.randomUUID(),
      host: "host.example",
      previewDigest: "a".repeat(64),
      discoveries: [
        { id: b.id, version: b.version },
        { id: a.id, version: a.version },
      ],
    };
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        discoveries: [{ id: a.id, version: a.version }, {
          id: unrelated.id,
          version: unrelated.version,
        }],
      }),
      undefined,
    );
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        discoveries: [{ id: a.id, version: a.version }, {
          id: b.id,
          version: b.version - 1,
        }],
      }),
      undefined,
    );
    assertEquals(
      first.withdrawApprovedBatch({ ...request, host: "https://host.example" }),
      undefined,
    );
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        discoveries: [request.discoveries[0], request.discoveries[0]],
      }),
      undefined,
    );
    assertEquals(first.get(a.id), a);
    assertEquals(first.get(b.id), b);
    assertEquals(
      first.listApprovedForSource("source").map(({ id }) => id),
      [a.id, b.id].sort(),
    );
    assertEquals(first.history(a.id).map(({ status }) => status), [
      "pending",
      "approved",
    ]);
    assertEquals(second.readBatchWithdrawal(request.requestId), undefined);
    time += 1_000;
    const receipt = second.withdrawApprovedBatch(request);
    assert(receipt);
    assertEquals(receipt.withdrawnAt, new Date(time).toISOString());
    assertEquals(receipt.withdrawn.map(({ id }) => id), [a.id, b.id].sort());
    assertEquals(
      receipt.withdrawn.map(({ status, version }) => [status, version]),
      [["withdrawn", 3], ["withdrawn", 3]],
    );
    assertEquals(first.readBatchWithdrawal(request.requestId), receipt);
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        requestId: request.requestId.toUpperCase(),
        discoveries: [...request.discoveries].reverse(),
      }),
      receipt,
    );
    assertEquals(
      first.withdrawApprovedBatch({ ...request, host: "different.example" }),
      undefined,
    );
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        previewDigest: "b".repeat(64),
      }),
      undefined,
    );
    assertEquals(
      first.withdrawApprovedBatch({
        ...request,
        requestId: crypto.randomUUID(),
      }),
      undefined,
    );
    assertEquals(first.get(unrelated.id), unrelated);
    assertEquals(first.listApprovedForSource("source"), []);
    assertEquals(first.listApprovedForSource("other-source"), [unrelated]);
    assertEquals(first.history(a.id).map(({ status }) => status), [
      "pending",
      "approved",
      "withdrawn",
    ]);
    const reopened = openSentinelAssetDiscoveryStore(dir, now);
    try {
      assertEquals(reopened.readBatchWithdrawal(request.requestId), receipt);
      assertEquals(reopened.withdrawApprovedBatch(request), receipt);
    } finally {
      reopened.close();
    }
  } finally {
    second.close();
    first.close();
    await Deno.remove(dir, { recursive: true });
  }
});
