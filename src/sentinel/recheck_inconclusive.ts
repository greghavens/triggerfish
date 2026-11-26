/** Strict receipt format for a recheck that could not produce a verified verdict. */
import { createHash } from "node:crypto";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { isSentinelCaseId } from "./cases.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const finding = /^worker-finding:[a-f0-9]{64}$/;
const node = /^(?:native-workflow-evidence|execution-evidence):[a-f0-9]{64}$/;
const digest = /^[a-f0-9]{64}$/;
export const INCONCLUSIVE_RECHECK_TOOL = "sentinel_record_inconclusive_recheck";
export const INCONCLUSIVE_RECHECK_ID =
  /^worker-recheck-inconclusive:[a-f0-9]{64}$/;

export interface SentinelInconclusiveRecheckInput {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly taskId: string;
  readonly targetId: string;
  readonly snapshotDigest: string;
  readonly findingId: string;
  readonly evidenceId: string;
  readonly rationale: string;
  readonly requestId: string;
}

export function inconclusiveRecheckArgs(args: Record<string, unknown>) {
  const { findingId, evidenceId, rationale, requestId } = args;
  if (
    Object.keys(args).length !== 4 ||
    typeof findingId !== "string" || !finding.test(findingId) ||
    typeof evidenceId !== "string" || !node.test(evidenceId) ||
    typeof requestId !== "string" || !uuid.test(requestId) ||
    typeof rationale !== "string" || !rationale.trim() ||
    rationale.length > 1000 ||
    /[\p{Cc}\p{Cf}]/u.test(rationale) ||
    redactCredentialText(rationale) !== rationale
  ) return;
  return {
    findingId,
    evidenceId,
    rationale: rationale.trim(),
    requestId: requestId.toLowerCase(),
  };
}

export function normalizeInconclusiveRecheck(
  input: SentinelInconclusiveRecheckInput,
) {
  const {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    snapshotDigest,
    findingId,
    evidenceId,
    rationale,
    requestId,
  } = input;
  const parsed = inconclusiveRecheckArgs({
    findingId,
    evidenceId,
    rationale,
    requestId,
  });
  if (
    !parsed || !isSentinelCaseId(caseId) || !uuid.test(runId) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    typeof targetId !== "string" || !targetId.trim() ||
    targetId.length > 512 ||
    /[\p{Cc}\p{Cf}]/u.test(targetId) || !digest.test(snapshotDigest)
  ) return;
  return {
    caseId,
    runId,
    evidenceRevision,
    taskId,
    targetId,
    snapshotDigest,
    ...parsed,
  };
}

export function inconclusiveRecheckId(input: SentinelInconclusiveRecheckInput) {
  return "worker-recheck-inconclusive:" +
    createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function decodeInconclusiveRecheck(
  row: Readonly<Record<string, unknown>>,
) {
  const input = normalizeInconclusiveRecheck(JSON.parse(String(row.input)));
  if (
    !input || row.input !== JSON.stringify(input) ||
    row.id !== inconclusiveRecheckId(input) ||
    row.requestId !== input.requestId ||
    row.revision !== input.evidenceRevision ||
    row.findingId !== input.findingId || row.taskId !== input.taskId ||
    typeof row.recordedAt !== "number" || !Number.isSafeInteger(row.recordedAt)
  ) {
    throw new Error("Invalid Sentinel inconclusive recheck receipt");
  }
  return {
    ...input,
    id: String(row.id),
    kind: "inconclusive_recheck" as const,
    recordedAt: new Date(row.recordedAt).toISOString(),
  };
}
