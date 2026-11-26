/** Canonical input and output for finding writes verified by their journal. */
import { dirname, join } from "@std/path";
import { readAdaptiveOperatorTrafficHint } from "./adaptive_store.ts";
import { redactCredentialText } from "../core/logger/redactor.ts";
import {
  INCONCLUSIVE_RECHECK_TOOL,
  inconclusiveRecheckArgs,
} from "./recheck_inconclusive.ts";
import {
  hasSentinelWorkerFindingJournal,
  initialFindingMetadata,
  openSentinelWorkerFindingStore,
  readSentinelStagedTrafficFinding,
  readSentinelWorkerFindingWriteReceipt,
  readStagedTrafficLinks,
  stagedTrafficItems,
} from "./worker_finding_store.ts";

import { MAX_FINDING_TRAFFIC_BATCH } from "./finding_traffic_links.ts";
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
  [INCONCLUSIVE_RECHECK_TOOL]: ["findingId", "evidenceId", "rationale"],
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

export function parseSentinelInitialTrafficSelection(
  args: Record<string, unknown>,
) {
  const { trafficEvidenceId, trafficDigest, trafficRefs, sourceHintId } = args;
  const valid = (evidenceId: unknown, digest: unknown, hint: unknown) =>
    typeof evidenceId === "string" && evidenceId.length <= 100 &&
      !!evidenceId.trim() && !evidenceId.includes("\0") &&
      typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) &&
      (hint === undefined ||
        typeof hint === "number" && Number.isSafeInteger(hint) && hint > 0)
      ? {
        evidenceId,
        digest,
        ...(typeof hint === "number" && { sourceHintId: hint }),
      }
      : undefined;
  if (trafficRefs !== undefined) {
    if (
      trafficEvidenceId !== undefined || trafficDigest !== undefined ||
      sourceHintId !== undefined ||
      !Array.isArray(trafficRefs) || trafficRefs.length < 2 ||
      trafficRefs.length > MAX_FINDING_TRAFFIC_BATCH
    ) return;
    const refs: {
      evidenceId: string;
      digest: string;
      sourceHintId?: number;
    }[] = [];
    for (const member of trafficRefs) {
      if (
        !member || typeof member !== "object" ||
        Object.keys(member).some((key) =>
          !["evidenceId", "digest", "sourceHintId"].includes(key)
        )
      ) return;
      const ref = valid(member.evidenceId, member.digest, member.sourceHintId);
      if (
        !ref || refs.some(({ evidenceId }) => evidenceId === ref.evidenceId)
      ) return;
      refs.push(ref);
    }
    return { refs, batch: true as const };
  }
  const ref = valid(trafficEvidenceId, trafficDigest, sourceHintId);
  return ref ? { refs: [ref], batch: false as const } : undefined;
}

export function sentinelFindingMutationArguments(
  name: FindingTool,
  input: Record<string, unknown>,
) {
  if (name === INCONCLUSIVE_RECHECK_TOOL) return inconclusiveRecheckArgs(input);
  const keys = name === "sentinel_update_finding_report" &&
      input.evidenceVersion !== undefined
    ? [...fields[name], "evidenceVersion"] as const
    : name === "sentinel_report_finding" &&
        (input.trafficEvidenceId !== undefined ||
          input.trafficDigest !== undefined || input.sourceHintId !== undefined)
    ? [
      ...fields[name],
      "trafficEvidenceId",
      "trafficDigest",
      ...(input.sourceHintId !== undefined ? ["sourceHintId"] as const : []),
    ] as const
    : name === "sentinel_report_finding" && input.trafficRefs !== undefined
    ? [...fields[name], "trafficRefs"] as const
    : fields[name];
  const { requestId } = input;
  const classification = name === "sentinel_report_finding"
    ? initialFindingMetadata(input)
    : {};
  if (
    !classification ||
    Object.keys(input).length !==
      keys.length + Object.keys(classification).length + 1 ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return;
  const args: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (key === "trafficRefs") {
      const selected = parseSentinelInitialTrafficSelection(input);
      if (!selected?.batch) return;
      args[key] = selected.refs;
      continue;
    }
    if (
      key === "expectedVersion" || key === "sourceHintId"
        ? typeof value !== "number" ||
          !Number.isSafeInteger(value) || value < 1
        : key === "evidenceVersion" || key === "trafficDigest"
        ? typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)
        : typeof value !== "string" ||
          !value.trim() || value.length > (key === "title"
              ? 256
              : key === "trafficEvidenceId"
              ? 100
              : 4096) ||
          value.includes("\0")
    ) {
      return;
    }
    args[key] = value;
  }
  return { ...args, ...classification, requestId: requestId.toLowerCase() };
}

export function lookupSentinelPendingTrafficFinding(
  path: string,
  scope: Parameters<typeof readSentinelStagedTrafficFinding>[1],
  requestId: string,
  snapshotDigest: string,
) {
  const staged = readSentinelStagedTrafficFinding(path, scope, requestId);
  if (!staged || staged.finding.snapshotDigest !== snapshotDigest) return;
  const items = stagedTrafficItems(staged);
  const hintsValid = !items.some((item) => {
    if (item.sourceHintId === undefined) return false;
    const ref = readAdaptiveOperatorTrafficHint(
      join(dirname(path), "sentinel-adaptive.db"),
      item.sourceHintId,
      scope.evidenceRevision,
      scope.runId,
      scope.targetId,
      item,
    );
    return ref?.evidenceId !== item.evidenceId || ref.digest !== item.digest;
  });
  const args = sentinelFindingMutationArguments("sentinel_report_finding", {
    ...Object.fromEntries(
      fields.sentinel_report_finding.map((key) => [key, staged.finding[key]]),
    ),
    ...initialFindingMetadata(staged.finding),
    requestId,
    ...(Array.isArray(staged.traffic)
      ? {
        trafficRefs: items.map(({ evidenceId, digest, sourceHintId }) => ({
          evidenceId,
          digest,
          ...(sourceHintId !== undefined && { sourceHintId }),
        })),
      }
      : {
        trafficEvidenceId: items[0].evidenceId,
        trafficDigest: items[0].digest,
        ...(items[0].sourceHintId !== undefined &&
          { sourceHintId: items[0].sourceHintId }),
      }),
  });
  if (!args) return;
  return {
    args,
    staged,
    hintsValid,
    trafficBatch: items.map((
      { evidenceId, digest, stepIndex, resultSha256 },
    ) => ({
      args: { revision: scope.evidenceRevision, evidenceId, digest },
      stepIndex,
      sha256: resultSha256,
    })),
  };
}

export function lookupSentinelFindingMutation(
  path: string,
  scope: Parameters<typeof readSentinelWorkerFindingWriteReceipt>[1] & {
    runId?: string;
  },
  name: FindingTool,
  requestId: string,
  snapshotDigest: string,
  evidenceId?: string,
) {
  if (name === INCONCLUSIVE_RECHECK_TOOL) {
    if (!hasSentinelWorkerFindingJournal(path)) return;
    const journal = openSentinelWorkerFindingStore(path);
    try {
      const record = journal.readInconclusiveRequest(requestId);
      if (
        !record || record.caseId !== scope.caseId ||
        record.evidenceRevision !== scope.evidenceRevision ||
        record.taskId !== scope.taskId || record.targetId !== scope.targetId ||
        record.snapshotDigest !== snapshotDigest ||
        record.evidenceId !== evidenceId
      ) return;
      const args = inconclusiveRecheckArgs({
        findingId: record.findingId,
        evidenceId: record.evidenceId,
        rationale: record.rationale,
        requestId,
      });
      const result = JSON.stringify({ _classification: "INTERNAL", record });
      return args && result.length <= MAX_SENTINEL_FINDING_RESULT_CHARS
        ? { args, result, id: record.id }
        : undefined;
    } finally {
      journal.close();
    }
  }
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
  if (
    name === "sentinel_report_finding" && scope.runId &&
    receipt.kind === "finding"
  ) {
    const pending = lookupSentinelPendingTrafficFinding(
      path,
      { ...scope, runId: scope.runId },
      requestId,
      snapshotDigest,
    );
    if (pending) {
      if (!pending.hintsValid) return;
      const attached = readStagedTrafficLinks(path, pending.staged);
      if (!attached || pending.staged.findingId !== receipt.id) return;
      const result = JSON.stringify({
        _classification: "INTERNAL",
        record: receipt,
        ...attached,
      });
      return result.length <= MAX_SENTINEL_FINDING_RESULT_CHARS
        ? {
          args: pending.args,
          result,
          id: receipt.id,
          trafficBatch: pending.trafficBatch,
        }
        : undefined;
    }
  }

  const args = sentinelFindingMutationArguments(name, {
    ...Object.fromEntries(
      fields[name].map((key) => [key, Reflect.get(receipt, key)]),
    ),
    ...(receipt.kind === "finding" && initialFindingMetadata(receipt)),
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
