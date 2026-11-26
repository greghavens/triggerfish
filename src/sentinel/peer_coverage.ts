/** Exact approved peer finding evidence used in a local coverage query. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import { isSentinelCaseId } from "./cases.ts";
import { readSentinelPublishedFindingSource } from "./graph.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

export function readSentinelPeerCoverageSelector(value: unknown) {
  const input = record(value);
  const { asset, sourceCase, sourceAsset, finding, snapshotDigest } = input ??
    {};
  if (
    !input || Object.keys(input).length !== 5 ||
    typeof asset !== "string" || !asset.trim() || asset.length > 800 ||
    typeof sourceCase !== "string" || !isSentinelCaseId(sourceCase) ||
    typeof sourceAsset !== "string" || !sourceAsset.trim() ||
    sourceAsset.length > 800 ||
    typeof finding !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(finding) ||
    typeof snapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
    /[\p{Cc}\p{Cf}]/u.test(asset + sourceAsset) ||
    redactCredentialText(asset) !== asset ||
    redactCredentialText(sourceAsset) !== sourceAsset
  ) return;
  return { asset, sourceCase, sourceAsset, finding, snapshotDigest };
}

export function readSentinelPeerCoverageReceipt(value: unknown) {
  const input = record(value);
  const selector = readSentinelPeerCoverageSelector(input?.selector);
  if (!input || Object.keys(input).length !== 2 || !selector) return;
  try {
    const source = readSentinelPublishedFindingSource(input.source);
    if (
      source.caseId !== selector.sourceCase ||
      source.receiptId !== selector.finding ||
      redactCredentialText(source.evidenceId) !== source.evidenceId
    ) return;
    return { selector, source };
  } catch {
    return;
  }
}

export type SentinelPeerCoverageReceipt = NonNullable<
  ReturnType<typeof readSentinelPeerCoverageReceipt>
>;
