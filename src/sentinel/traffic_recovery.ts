/** Approved arguments for recovering exact retained traffic and finding links. */
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
  if (
    Object.keys(args).length !== (recheckId === undefined ? 6 : 7) ||
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
    requestId: requestId.toLowerCase(),
  };
}
