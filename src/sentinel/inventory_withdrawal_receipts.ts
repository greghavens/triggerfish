/** Durable operator receipts for exact published inventory withdrawal. */
import { isSentinelCaseId } from "./cases.ts";
import { normalizeSentinelWithdrawalHost } from "./inventory_host_withdrawal.ts";
import { openSentinelInventoryPublicationReceipts } from "./inventory_publication_receipts.ts";

export interface SentinelInventoryWithdrawalRequest {
  readonly requestId: string;
  readonly sourceCaseId: string;
  readonly host: string;
  readonly assetId: string;
  readonly previousDigest: string;
  readonly nextDigest: string;
}

export type SentinelInventoryWithdrawalReceipt =
  import("./inventory_publication_receipts.ts").InventoryPublicationReceipt<
    SentinelInventoryWithdrawalRequest
  >;

export type SentinelInventoryWithdrawalAdmission =
  import("./inventory_publication_receipts.ts").InventoryPublicationAdmission<
    SentinelInventoryWithdrawalRequest
  >;

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;

function normalize(
  raw: SentinelInventoryWithdrawalRequest,
): SentinelInventoryWithdrawalRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { requestId, sourceCaseId, host, assetId, previousDigest, nextDigest } =
    raw;
  if (
    typeof requestId !== "string" || !uuid.test(requestId) ||
    !isSentinelCaseId(sourceCaseId) || typeof host !== "string" ||
    normalizeSentinelWithdrawalHost(host) !== host ||
    typeof assetId !== "string" || !assetId.trim() || assetId.length > 4096 ||
    assetId.includes("\0") ||
    typeof previousDigest !== "string" || !digest.test(previousDigest) ||
    typeof nextDigest !== "string" || !digest.test(nextDigest) ||
    nextDigest === previousDigest
  ) return undefined;
  return {
    requestId: requestId.toLowerCase(),
    sourceCaseId,
    host,
    assetId,
    previousDigest,
    nextDigest,
  };
}

export function openSentinelInventoryWithdrawalReceipts(
  baseDir: string,
  now = Date.now,
) {
  const { admit, complete, read, close } =
    openSentinelInventoryPublicationReceipts(
      baseDir,
      "withdrawal",
      normalize,
      now,
    );
  return { admit, complete, read, close };
}
