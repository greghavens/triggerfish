import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { proposeSentinelInventoryHostWithdrawal } from "../../src/sentinel/inventory_host_withdrawal.ts";
import {
  openSentinelInventoryWithdrawalReceipts,
  type SentinelInventoryWithdrawalRequest,
} from "../../src/sentinel/inventory_withdrawal_receipts.ts";

function request(): SentinelInventoryWithdrawalRequest {
  const proposal = proposeSentinelInventoryHostWithdrawal({
    version: 1,
    nodes: [{
      id: "asset",
      kind: "asset",
      label: "Fixture",
      aliases: ["local.example"],
    }],
    edges: [],
  }, "LOCAL.EXAMPLE.");
  assert(proposal);
  const { host, assetId, previousDigest, nextDigest } = proposal;
  return {
    requestId: crypto.randomUUID(),
    sourceCaseId: "source-case",
    host,
    assetId,
    previousDigest,
    nextDigest,
  };
}

Deno.test("Inventory withdrawal admits one exact digest pair and closes only the owning receipt", async () => {
  const baseDir = await Deno.makeTempDir();
  let now = 10_000;
  const first = openSentinelInventoryWithdrawalReceipts(baseDir, () => now);
  const second = openSentinelInventoryWithdrawalReceipts(baseDir, () => now);
  const input = request();
  try {
    const accepted = first.admit(
      {
        ...input,
        rawInventory: "not recorded",
      } as SentinelInventoryWithdrawalRequest,
    );
    assert(accepted?.admitted);
    assertEquals(accepted.receipt, {
      ...input,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    assertEquals(second.admit(input), {
      admitted: false,
      receipt: accepted.receipt,
    });
    for (
      const changed of [
        { sourceCaseId: "different-case" },
        { host: "different.example" },
        { assetId: "other-asset" },
        { previousDigest: "a".repeat(64) },
        { nextDigest: "b".repeat(64) },
      ]
    ) {
      assertEquals(second.admit({ ...input, ...changed }), undefined);
      assertEquals(
        second.complete({ ...input, ...changed }, accepted.token, "succeeded"),
        undefined,
      );
    }
    assertEquals(
      second.complete(input, crypto.randomUUID(), "failed"),
      undefined,
    );
    now++;
    const succeeded = first.complete(input, accepted.token, "succeeded");
    assert(succeeded);
    assertEquals(succeeded.status, "succeeded");
    assertEquals(succeeded.updatedAt, new Date(now).toISOString());
    assertEquals(
      second.admit({ ...input, requestId: input.requestId.toUpperCase() }),
      { admitted: false, receipt: succeeded },
    );
    assertEquals(second.read(input.requestId), succeeded);
    assertEquals(second.complete(input, accepted.token, "failed"), undefined);
  } finally {
    second.close();
    first.close();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Inventory withdrawal retries expose interrupted or failed receipts without renewing authority", async () => {
  const baseDir = await Deno.makeTempDir();
  const input = request();
  const other = request();
  const first = openSentinelInventoryWithdrawalReceipts(baseDir);
  try {
    assert(first.admit(input)?.admitted);
    const failed = first.admit(other);
    assert(failed?.admitted);
    assertEquals(
      first.complete(other, failed.token, "failed")?.status,
      "failed",
    );
  } finally {
    first.close();
  }
  const restarted = openSentinelInventoryWithdrawalReceipts(baseDir);
  try {
    assertEquals(restarted.admit(input)?.admitted, false);
    assertEquals(restarted.read(input.requestId)?.status, "pending");
    assertEquals(restarted.admit(other)?.receipt.status, "failed");
    assertEquals(
      restarted.admit({
        ...input,
        requestId: crypto.randomUUID(),
        host: "LOCAL.EXAMPLE.",
      }),
      undefined,
    );
    assertEquals(
      restarted.admit({
        ...input,
        requestId: crypto.randomUUID(),
        nextDigest: input.previousDigest,
      }),
      undefined,
    );
  } finally {
    restarted.close();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Inventory withdrawal journal rejects a linked file", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const data = join(baseDir, "data");
    await Deno.mkdir(data);
    const other = join(data, "other.db");
    await Deno.writeTextFile(other, "unrelated");
    await Deno.symlink(
      other,
      join(data, "sentinel-inventory-withdrawal-receipts.db"),
    );
    assertThrows(
      () => openSentinelInventoryWithdrawalReceipts(baseDir),
      Error,
      "private regular receipt journal",
    );
    assertEquals(await Deno.readTextFile(other), "unrelated");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
