/** Approved arguments for recovering exact retained traffic and finding links. */
import {
  type SentinelTrafficReceiptQuery,
  validSentinelTrafficReceiptQuery,
} from "./traffic_receipts.ts";
import { sentinelTrafficEvidenceAnnotation } from "./finding_traffic_links.ts";

export const SENTINEL_TRAFFIC_LINKS = "sentinel_finding_traffic_links";
export const SENTINEL_TRAFFIC_SEARCH = "sentinel_traffic_search";
export const SENTINEL_TRAFFIC_READ = "sentinel_traffic_get";
export const SENTINEL_TRAFFIC_ATTACH = "sentinel_attach_finding_traffic";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validEvidenceId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    value.length <= 100 && !value.includes("\0");
}

function digestHex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

const searchFields = [
  "assetId",
  "family",
  "evidenceId",
  "origin",
  "hostname",
  "method",
  "status",
  "from",
  "until",
  "bodyContains",
  "limit",
  "cursor",
] as const;

export function sentinelTrafficSearchArgs(value: unknown) {
  const input = record(value);
  if (
    !input || typeof input.revision !== "number" ||
    !Number.isSafeInteger(input.revision) || input.revision < 1
  ) return;
  if (
    Object.keys(input).some((key) =>
      key !== "revision" && !searchFields.some((field) => field === key)
    )
  ) return;
  const filters = Object.fromEntries(searchFields.flatMap((key) => {
    const value = input[key];
    return value === undefined ? [] : [[key, value]];
  }));
  if (
    Object.entries(filters).some(([key, value]) =>
      key === "status" || key === "limit"
        ? typeof value !== "number"
        : typeof value !== "string" || !value.trim()
    )
  ) return;
  const typed = filters as SentinelTrafficReceiptQuery;
  if (
    (typed.limit !== undefined && typed.limit > 10) ||
    !validSentinelTrafficReceiptQuery(typed)
  ) return;
  return { revision: input.revision, ...typed };
}

/** Exact page references contain no original search filters or response bodies. */
export function sentinelTrafficPageReference(value: unknown) {
  const input = record(value);
  if (
    !input || !Number.isSafeInteger(input.revision) ||
    typeof input.revision !== "number" || input.revision < 1 ||
    !Array.isArray(input.receipts) || input.receipts.length > 10 ||
    !digestHex(input.sha256)
  ) return;
  const receipts: { evidenceId: string; digest: string }[] = [];
  for (const value of input.receipts) {
    const receipt = record(value);
    if (
      !receipt || typeof receipt.evidenceId !== "string" ||
      !/^(?:har|dns):evidence:[a-f0-9]{64}$/.test(receipt.evidenceId) ||
      !digestHex(receipt.digest)
    ) return;
    receipts.push({ evidenceId: receipt.evidenceId, digest: receipt.digest });
  }
  const nextCursor = input.nextCursor;
  if (
    nextCursor !== null && (typeof nextCursor !== "string" ||
      !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(nextCursor) ||
      !receipts.length || !nextCursor.endsWith("." + receipts.at(-1)!.digest))
  ) return;
  return {
    revision: input.revision,
    receipts,
    nextCursor,
    sha256: input.sha256,
  };
}

export function sentinelTrafficLinksArgs(value: unknown) {
  const args = record(value);
  if (
    !args ||
    Object.keys(args).some((name) =>
      !["revision", "findingId", "recheckId", "limit", "offset"].includes(name)
    )
  ) return;
  const { revision, findingId, recheckId, limit, offset } = args;
  if (
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (findingId !== undefined &&
      (typeof findingId !== "string" ||
        !/^worker-finding:[a-f0-9]{64}$/.test(findingId))) ||
    (recheckId !== undefined && (findingId === undefined ||
      typeof recheckId !== "string" ||
      !/^worker-recheck:[a-f0-9]{64}$/.test(recheckId))) ||
    (limit !== undefined &&
      (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 10)) ||
    (offset !== undefined &&
      (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 4096))
  ) return;
  return {
    revision,
    ...(findingId !== undefined && { findingId }),
    ...(recheckId !== undefined && { recheckId }),
    ...(limit !== undefined && { limit }),
    ...(offset !== undefined && { offset }),
  };
}

export const sentinelTrafficPayloadPartParameter = {
  type: "string",
  enum: ["request", "response", "headers"],
  description:
    "Select a request body, response body, or retained header projection. Defaults to response.",
} as const;

export const sentinelTrafficPayloadOffsetParameter = {
  type: "integer",
  description:
    "Unicode code-point offset for text or byte offset for binary. Use nextOffset to continue.",
} as const;

export function sentinelLinkedTrafficPayloadArgs(value: unknown) {
  const args = record(value);
  if (
    !args || Object.keys(args).some((key) =>
      ![
        "revision",
        "findingId",
        "trafficLinkId",
        "recheckId",
        "payloadPart",
        "payloadOffset",
      ]
        .includes(key)
    )
  ) return;
  const {
    revision,
    findingId,
    recheckId,
    trafficLinkId,
    payloadPart,
    payloadOffset,
  } = args;
  if (
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 || typeof findingId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(findingId) ||
    (recheckId !== undefined && (typeof recheckId !== "string" ||
      !/^worker-recheck:[a-f0-9]{64}$/.test(recheckId))) ||
    typeof trafficLinkId !== "string" ||
    !/^finding-traffic-link:[a-f0-9]{64}$/.test(trafficLinkId) ||
    (payloadPart !== "request" && payloadPart !== "response" &&
      payloadPart !== "headers") ||
    (payloadOffset !== undefined &&
      (typeof payloadOffset !== "number" ||
        !Number.isSafeInteger(payloadOffset) ||
        payloadOffset < 0))
  ) return;
  return {
    revision,
    findingId,
    ...(recheckId !== undefined && { recheckId }),
    trafficLinkId,
    payloadPart,
    ...(payloadOffset !== undefined && { payloadOffset }),
  };
}

export function sentinelLinkedTrafficPayloadReference(value: unknown) {
  const input = record(value);
  const args = sentinelLinkedTrafficPayloadArgs(input?.args);
  const sha256 = input?.sha256;
  if (args && digestHex(sha256)) return { args, sha256 };
}

export function sentinelTrafficLinkPageReference(value: unknown) {
  const input = record(value);
  const args = sentinelTrafficLinksArgs(input?.args);
  const { linkIds, nextOffset, sha256, evidenceVersion } = input ?? {};
  if (
    !args || !digestHex(sha256) || !Array.isArray(linkIds) ||
    (evidenceVersion !== undefined &&
      (!args.findingId || !digestHex(evidenceVersion))) ||
    linkIds.length > (args.limit ?? 5) ||
    new Set(linkIds).size !== linkIds.length ||
    !linkIds.every((id) =>
      typeof id === "string" && /^finding-traffic-link:[a-f0-9]{64}$/.test(id)
    ) ||
    (nextOffset !== null &&
      (!linkIds.length || nextOffset !== (args.offset ?? 0) + linkIds.length))
  ) return;
  return {
    args,
    linkIds: linkIds as string[],
    ...(evidenceVersion !== undefined && { evidenceVersion }),
    nextOffset: nextOffset as number | null,
    sha256,
  };
}

export function sentinelTrafficReadArgs(value: unknown) {
  const args = record(value);
  if (!args || Object.keys(args).length !== 3) return;
  const { revision, evidenceId, digest } = args;
  if (
    typeof revision === "number" && Number.isSafeInteger(revision) &&
    revision > 0 && validEvidenceId(evidenceId) && digestHex(digest)
  ) return { revision, evidenceId, digest };
}

export function sentinelTrafficAttachArgs(value: unknown) {
  const args = record(value);
  if (!args) return;
  const {
    revision,
    findingId,
    recheckId,
    reportVersion,
    evidenceId,
    digest,
    requestId,
  } = args;
  const annotation = sentinelTrafficEvidenceAnnotation(args);
  if (
    !annotation ||
    Object.keys(args).length !== (recheckId === undefined ? 6 : 7) +
        Object.keys(annotation).length ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof findingId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(findingId) ||
    (recheckId !== undefined &&
      (typeof recheckId !== "string" ||
        !/^worker-recheck:[a-f0-9]{64}$/.test(recheckId))) ||
    typeof reportVersion !== "number" || !Number.isSafeInteger(reportVersion) ||
    reportVersion < 1 || !validEvidenceId(evidenceId) || !digestHex(digest) ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  return {
    revision,
    findingId,
    ...(recheckId !== undefined && { recheckId }),
    reportVersion,
    evidenceId,
    digest,
    ...annotation,
    requestId: requestId.toLowerCase(),
  };
}
