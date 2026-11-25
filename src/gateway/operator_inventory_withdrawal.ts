/** Publish an approved inventory host withdrawal without discarding source evidence. */
import type { OperatorRunRef } from "../core/operator_runs.ts";
import { refreshSentinelAssessment } from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { readSentinelChatSnapshot } from "../sentinel/chat_mode.ts";
import {
  normalizeSentinelWithdrawalHost,
  proposeSentinelInventoryHostWithdrawal,
} from "../sentinel/inventory_host_withdrawal.ts";
import { openSentinelInventoryWithdrawalReceipts } from "../sentinel/inventory_withdrawal_receipts.ts";
import { publishSentinelInput } from "../sentinel/published_input.ts";
import { retainSentinelSourceSnapshot } from "../sentinel/shared_inventory.ts";
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const unavailable =
  "Error: The exact published inventory withdrawal is unavailable.";

export async function executeOperatorInventoryWithdrawal(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
  webContainmentConfigured?: boolean,
): Promise<Record<string, unknown> | string> {
  const applying = args.action === "withdraw_inventory_host";
  const host = normalizeSentinelWithdrawalHost(args.host);
  if (
    ref.kind !== "sentinel" || ref.revision !== undefined || !host ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "host",
        ...(applying ? ["requestId", "previewDigest"] : []),
      ].includes(key)
    )
  ) return unavailable;
  const path = resolveSentinelCasePath(baseDir, ref.id);
  const proposal = async () => {
    const original = loadSentinelGraph(await readSentinelChatSnapshot(path))
      .snapshot();
    const change = proposeSentinelInventoryHostWithdrawal(original, host);
    return change && { original, change };
  };
  const review = (
    change: NonNullable<
      ReturnType<typeof proposeSentinelInventoryHostWithdrawal>
    >,
  ) => ({
    sourceCaseId: ref.id,
    host,
    assetId: change.assetId,
    previewDigest: change.previousDigest,
    nextDigest: change.nextDigest,
    removedEdges: change.removedEdges,
    detachedChildren: change.detachedChildIds.length,
  });
  if (!applying) {
    const planned = await proposal();
    return planned ? { preview: review(planned.change) } : unavailable;
  }
  const { requestId, previewDigest } = args;
  if (
    typeof requestId !== "string" || !uuid.test(requestId) ||
    typeof previewDigest !== "string" || !digest.test(previewDigest)
  ) return unavailable;
  const id = requestId.toLowerCase();
  const receipts = openSentinelInventoryWithdrawalReceipts(baseDir);
  const replay = () => {
    const receipt = receipts.read(id);
    if (!receipt) return undefined;
    return receipt.sourceCaseId === ref.id && receipt.host === host &&
        receipt.previousDigest === previewDigest
      ? { receipt }
      : unavailable;
  };
  try {
    const prior = replay();
    if (prior !== undefined) return prior;
    const planned = await proposal();
    if (!planned || planned.change.previousDigest !== previewDigest) {
      return unavailable;
    }
    if (
      !await confirm(
        `Withdraw this exact asset from published Sentinel inventory?\n${
          JSON.stringify(review(planned.change))
        }`,
      )
    ) return "Error: The operator declined the run action.";
    return await withSentinelSourceSnapshotLock(baseDir, true, async () => {
      const prior = replay();
      if (prior !== undefined) return prior;
      const current = await proposal();
      if (
        !current || current.change.previousDigest !== previewDigest ||
        current.change.nextDigest !== planned.change.nextDigest
      ) return unavailable;
      const { change, original } = current;
      const input = {
        sourceCaseId: ref.id,
        requestId: id,
        host,
        assetId: change.assetId,
        previousDigest: change.previousDigest,
        nextDigest: change.nextDigest,
      };
      const admitted = receipts.admit(input);
      if (!admitted) return unavailable;
      if (!admitted.admitted) return { receipt: admitted.receipt };
      let status: "succeeded" | "failed" = "failed";
      try {
        await retainSentinelSourceSnapshot(
          baseDir,
          ref.id,
          change.previousDigest,
          original,
        );
        await publishSentinelInput(path, change.snapshot);
        status = "succeeded";
      } catch {
        // Keep the public receipt limited to the operation outcome.
      }
      const receipt = receipts.complete(input, admitted.token, status);
      if (status === "succeeded") {
        try {
          refreshSentinelAssessment(path, webContainmentConfigured);
        } catch {
          // The gateway coordinator can refresh the already-published change.
        }
      }
      return receipt ? { receipt } : unavailable;
    });
  } finally {
    receipts.close();
  }
}
