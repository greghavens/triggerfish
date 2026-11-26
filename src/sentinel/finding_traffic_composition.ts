/** Immutable operator decisions about the active attachments on one finding. */
import { createHash } from "node:crypto";
import { isSentinelCaseId } from "./cases.ts";

export const MAX_TRAFFIC_COMPOSITION_LINKS = 4096;
export const MAX_TRAFFIC_COMPOSITION_JOURNAL_BYTES = 8 * 1024 * 1024;
export const trafficCompositionTable = "traffic_link_composition";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const findingIdPattern = /^worker-finding:[a-f0-9]{64}$/;
const linkIdPattern = /^finding-traffic-link:[a-f0-9]{64}$/;

type CompositionChange =
  & {
    readonly caseId: string;
    readonly runId: string;
    readonly evidenceRevision: number;
    readonly findingId: string;
    readonly reportVersion: number;
    readonly evidenceVersion: string;
    readonly requestId: string;
  }
  & (
    | {
      readonly operation: "reorder";
      readonly linkIds: readonly string[];
      readonly move?: {
        readonly linkId: string;
        readonly beforeLinkId?: string;
      };
    }
    | { readonly operation: "withdraw"; readonly linkId: string }
  );

export type SentinelTrafficCompositionChange = CompositionChange;
export type SentinelTrafficCompositionReceipt = CompositionChange & {
  readonly id: string;
  readonly recordedAt: string;
};

export function parseTrafficCompositionMove(
  linkId: unknown,
  beforeLinkId: unknown,
) {
  if (
    typeof linkId !== "string" || !linkIdPattern.test(linkId) ||
    (beforeLinkId !== undefined &&
      (typeof beforeLinkId !== "string" || !linkIdPattern.test(beforeLinkId) ||
        beforeLinkId === linkId))
  ) return;
  return { linkId, ...(typeof beforeLinkId === "string" && { beforeLinkId }) };
}

export function trafficCompositionOrderDigest(
  linkIds: readonly string[],
): string {
  return createHash("sha256").update(JSON.stringify(linkIds)).digest("hex");
}

export function parseSentinelTrafficComposition(
  raw: Record<string, unknown>,
): SentinelTrafficCompositionChange | undefined {
  const {
    caseId,
    runId,
    evidenceRevision,
    findingId,
    reportVersion,
    evidenceVersion,
    requestId,
    operation,
    linkIds,
    linkId,
    move: rawMove,
  } = raw;
  const move = rawMove && typeof rawMove === "object" && "linkId" in rawMove
    ? parseTrafficCompositionMove(
      rawMove.linkId,
      "beforeLinkId" in rawMove ? rawMove.beforeLinkId : undefined,
    )
    : undefined;
  if (rawMove !== undefined && !move) return;
  if (
    !isSentinelCaseId(caseId) || typeof runId !== "string" ||
    !uuid.test(runId) ||
    typeof findingId !== "string" || !findingIdPattern.test(findingId) ||
    typeof evidenceRevision !== "number" ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    typeof reportVersion !== "number" || !Number.isSafeInteger(reportVersion) ||
    reportVersion < 1 ||
    typeof evidenceVersion !== "string" || !digest.test(evidenceVersion) ||
    typeof requestId !== "string" || !uuid.test(requestId)
  ) return;
  const scope = {
    caseId,
    runId: runId.toLowerCase(),
    evidenceRevision,
    findingId,
    reportVersion,
    evidenceVersion,
    requestId: requestId.toLowerCase(),
  };
  if (
    operation === "withdraw" && typeof linkId === "string" &&
    linkIdPattern.test(linkId) &&
    linkIds === undefined && rawMove === undefined
  ) return { ...scope, operation, linkId };
  if (
    operation === "reorder" && linkId === undefined &&
    Array.isArray(linkIds) && linkIds.length > 0 &&
    linkIds.length <= MAX_TRAFFIC_COMPOSITION_LINKS &&
    new Set(linkIds).size === linkIds.length &&
    linkIds.every((id) => typeof id === "string" && linkIdPattern.test(id)) &&
    (!move || (linkIds.includes(move.linkId) &&
      (move.beforeLinkId
        ? linkIds[linkIds.indexOf(move.linkId) + 1] === move.beforeLinkId
        : linkIds.at(-1) === move.linkId)))
  ) {
    return { ...scope, operation, linkIds, ...(move && { move }) };
  }
}

export function trafficCompositionReceiptId(serialized: string): string {
  return "finding-traffic-set:" +
    createHash("sha256").update(serialized).digest("hex");
}

export function decodeSentinelTrafficComposition(
  row: Readonly<Record<string, unknown>>,
): SentinelTrafficCompositionReceipt {
  const input = parseSentinelTrafficComposition(JSON.parse(String(row.input)));
  const serialized = JSON.stringify(input);
  if (
    !input || serialized !== row.input ||
    trafficCompositionReceiptId(serialized) !== row.id ||
    input.requestId !== row.request_id || input.findingId !== row.finding_id ||
    input.evidenceRevision !== row.revision ||
    typeof row.recorded_at !== "number" ||
    !Number.isSafeInteger(row.recorded_at)
  ) {
    throw new Error("Invalid Sentinel traffic composition receipt");
  }
  return {
    ...input,
    id: String(row.id),
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

/** After explicit ordering, later attachments append in insertion order. */
export function composeFindingTrafficLinks(
  original: readonly string[],
  changes: readonly SentinelTrafficCompositionReceipt[],
): string[] {
  let active = [...original];
  const insertionRank = new Map(original.map((id, index) => [id, index]));
  for (const change of changes) {
    if (change.operation === "withdraw") {
      active = active.filter((id) => id !== change.linkId);
    } else {
      const order = new Set(change.linkIds);
      const available = new Set(active);
      active = [
        ...change.linkIds.filter((id) => available.has(id)),
        ...active.filter((id) => !order.has(id)).sort((a, b) =>
          insertionRank.get(b)! - insertionRank.get(a)!
        ),
      ];
    }
  }
  return active;
}
