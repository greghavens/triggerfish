/** Confirm the exact set of verified shared discoveries to withdraw. */
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import type { OperatorRunRef } from "../core/operator_runs.ts";
import {
  openSentinelAssetDiscoveryStore,
  type SentinelAssetDiscoveryBatchWithdrawal,
} from "../sentinel/asset_discovery_store.ts";
import {
  normalizeSentinelWithdrawalHost,
  previewSentinelAssetDiscoveryWithdrawal,
} from "./sentinel_asset_discoveries.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const unavailable =
  "Error: The exact discovery withdrawal scope or preview is unavailable.";

function operatorReceipt(record: SentinelAssetDiscoveryBatchWithdrawal) {
  return {
    sourceCaseId: record.sourceCaseId,
    requestId: record.requestId,
    host: record.host,
    previewDigest: record.previewDigest,
    withdrawnAt: record.withdrawnAt,
    withdrawn: record.withdrawn.map(({ id, version }) => ({ id, version })),
  };
}

export async function executeOperatorAssetWithdrawal(
  baseDir: string,
  ref: OperatorRunRef,
  args: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean>,
): Promise<Record<string, unknown> | string> {
  const applying = args.action === "withdraw_discoveries";
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
  if (!applying) {
    const preview = previewSentinelAssetDiscoveryWithdrawal(
      baseDir,
      ref.id,
      host,
    );
    return preview ? { preview } : unavailable;
  }
  const { requestId, previewDigest } = args;
  if (
    typeof requestId !== "string" || !uuid.test(requestId) ||
    typeof previewDigest !== "string" || !digest.test(previewDigest)
  ) return unavailable;
  const id = requestId.toLowerCase();
  const store = openSentinelAssetDiscoveryStore(baseDir);
  try {
    const replay = () => {
      const existing = store.readBatchWithdrawal(id);
      if (!existing) return undefined;
      return existing.sourceCaseId === ref.id && existing.host === host &&
          existing.previewDigest === previewDigest
        ? { receipt: operatorReceipt(existing) }
        : unavailable;
    };
    const prior = replay();
    if (prior !== undefined) return prior;
    const preview = previewSentinelAssetDiscoveryWithdrawal(
      baseDir,
      ref.id,
      host,
    );
    if (
      !preview?.discoveries.length || preview.previewDigest !== previewDigest
    ) return unavailable;
    if (
      !await confirm(
        `Withdraw these exact shared Sentinel discoveries?\n${
          JSON.stringify(preview)
        }`,
      )
    ) return "Error: The operator declined the run action.";
    return await withSentinelSourceSnapshotLock(baseDir, true, () => {
      const after = previewSentinelAssetDiscoveryWithdrawal(
        baseDir,
        ref.id,
        host,
      );
      if (after?.previewDigest !== previewDigest) {
        return Promise.resolve(replay() ?? unavailable);
      }
      const receipt = store.withdrawApprovedBatch({ ...after, requestId: id });
      return Promise.resolve(
        receipt ? { receipt: operatorReceipt(receipt) } : unavailable,
      );
    });
  } finally {
    store.close();
  }
}
