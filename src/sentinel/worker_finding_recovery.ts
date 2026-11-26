/** Canonical input and output for finding writes verified by their journal. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import { readSentinelWorkerFindingWriteReceipt } from "./worker_finding_store.ts";

export const MAX_SENTINEL_FINDING_RESULT_CHARS = 6000;

export const SENTINEL_RECHECK_CONTEXT_TOOL = "sentinel_finding_recheck_context";

export function normalizeSentinelRecheckNote(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" || !value.trim() || value.length > 1000 ||
    /[\p{Cc}\p{Cf}]/u.test(value) || redactCredentialText(value) !== value
  ) return;
  return value.trim();
}

export function sentinelRecheckContextArgs(input: unknown) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 1) {
    return;
  }
  const findingId = (input as { findingId?: unknown }).findingId;
  if (
    typeof findingId === "string" &&
    /^worker-finding:[a-f0-9]{64}$/.test(findingId)
  ) {
    return { findingId };
  }
}

const fields = {
  sentinel_report_finding: [
    "graphFindingId",
    "controlId",
    "evidenceId",
    "title",
    "summary",
  ],
  sentinel_record_finding_recheck: ["findingId", "evidenceId", "summary"],
  sentinel_update_finding_report: [
    "findingId",
    "expectedVersion",
    "title",
    "summary",
  ],
} as const;

type FindingTool = keyof typeof fields;

export function isSentinelFindingMutation(name: string): name is FindingTool {
  return Object.hasOwn(fields, name);
}

export function sentinelFindingMutationArguments(
  name: FindingTool,
  input: Record<string, unknown>,
) {
  const keys = name === "sentinel_update_finding_report" &&
      input.evidenceVersion !== undefined
    ? [...fields[name], "evidenceVersion"] as const
    : fields[name];
  const { requestId } = input;
  if (
    Object.keys(input).length !== keys.length + 1 ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  const args: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      key === "expectedVersion"
        ? typeof value !== "number" ||
          !Number.isSafeInteger(value) || value < 1
        : key === "evidenceVersion"
        ? typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)
        : typeof value !== "string" ||
          !value.trim() || value.length > (key === "title" ? 256 : 4096) ||
          value.includes("\0")
    ) return;
    args[key] = value;
  }
  return { ...args, requestId: requestId.toLowerCase() };
}

export function lookupSentinelFindingMutation(
  path: string,
  scope: Parameters<typeof readSentinelWorkerFindingWriteReceipt>[1],
  name: FindingTool,
  requestId: string,
  snapshotDigest: string,
  evidenceId?: string,
) {
  const receipt = readSentinelWorkerFindingWriteReceipt(path, scope, requestId);
  if (
    !receipt ||
    (evidenceId !== undefined &&
      (receipt.kind === "report_amendment" ||
        receipt.evidenceId !== evidenceId)) ||
    (receipt.kind !== "report_amendment" &&
      receipt.snapshotDigest !== snapshotDigest)
  ) return;
  const expected = receipt.kind === "finding"
    ? "sentinel_report_finding"
    : receipt.kind === "recheck"
    ? "sentinel_record_finding_recheck"
    : "sentinel_update_finding_report";
  if (name !== expected) return;
  const args = sentinelFindingMutationArguments(name, {
    ...Object.fromEntries(
      fields[name].map((key) => [key, Reflect.get(receipt, key)]),
    ),
    ...(receipt.kind === "report_amendment" &&
      receipt.evidenceVersion !== undefined &&
      { evidenceVersion: receipt.evidenceVersion }),
    requestId,
  });
  if (!args) return;
  const result = JSON.stringify(
    receipt.kind === "report_amendment"
      ? { _classification: "INTERNAL", amendment: receipt }
      : { _classification: "INTERNAL", record: receipt },
  );
  if (result.length > MAX_SENTINEL_FINDING_RESULT_CHARS) return;
  return { args, result, id: receipt.id };
}
