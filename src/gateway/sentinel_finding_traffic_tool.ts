/** Exact leased-worker links from immutable findings to sanitized retained traffic. */
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessmentRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import { isSentinelCaseId, locateSentinelCase } from "../sentinel/cases.ts";
import {
  listSentinelFindingTrafficLinks,
  openSentinelFindingTrafficLinks,
  sentinelFindingTrafficEvidenceVersion,
  type SentinelFindingTrafficLinkInput,
} from "../sentinel/finding_traffic_links.ts";
import {
  readSentinelTrafficReceipt,
  type SentinelTrafficSource,
  sentinelTrafficSources,
} from "../sentinel/traffic_receipts.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
} from "../sentinel/worker_finding_store.ts";
import { sentinelLinkedTrafficPayloadArgs } from "../sentinel/traffic_recovery.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";
import {
  projectSentinelTrafficBlob,
  sentinelTrafficBlobTool,
} from "./sentinel_traffic_tool.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";

type Scope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "snapshotOverride"
  | "assessmentRevision"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
>;

const revisionField = {
  type: "integer",
  description: "Exact case evidence revision",
  required: true,
} as const;
const findingField = {
  type: "string",
  description: "Exact saved worker finding ID",
} as const;
const unavailable =
  "Error: The saved finding traffic link or exact scope is unavailable.";
const requiredReceipt =
  "Error: Open that exact traffic receipt with sentinel_traffic_get before attaching it.";
const maxOutput = 6000;
const findingPattern = /^worker-finding:[a-f0-9]{64}$/;
const recheckPattern = /^worker-recheck:[a-f0-9]{64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const sentinelFindingTrafficAttachTool: ToolDefinition = {
  name: "sentinel_attach_finding_traffic",
  description:
    "Attach a retained traffic receipt already opened in this turn to an exact assigned finding or recheck. The receipt does not establish a verification outcome.",
  parameters: {
    revision: revisionField,
    findingId: { ...findingField, required: true },
    recheckId: {
      type: "string",
      description: "Exact saved recheck within the finding",
    },
    reportVersion: {
      type: "integer",
      description: "Expected current finding report version",
      required: true,
    },
    evidenceId: {
      type: "string",
      description: "Exact traffic evidence ID returned by the receipt read",
      required: true,
    },
    digest: {
      type: "string",
      description: "Exact traffic receipt digest returned by the receipt read",
      required: true,
    },
    requestId: {
      type: "string",
      description: "Unique request UUID for idempotent retry",
      required: true,
    },
  },
};

export const sentinelFindingTrafficListTool: ToolDefinition = {
  name: "sentinel_finding_traffic_links",
  description:
    "List saved finding traffic links, or reopen a reviewed payload through an exact finding and link. Leased workers see only their assigned asset.",
  parameters: {
    revision: revisionField,
    findingId: findingField,
    trafficLinkId: {
      type: "string",
      description:
        "Exact link ID from a previous page. Requires findingId and payloadPart.",
    },
    payloadPart: sentinelTrafficBlobTool.parameters.payloadPart,
    payloadOffset: sentinelTrafficBlobTool.parameters.offset,
    limit: { type: "integer", description: "Page size from 1 to 10" },
    offset: {
      type: "integer",
      description: "Next offset from a previous page",
    },
  },
};

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exactId(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length !== 0 &&
    value.length <= maxLength && !value.includes("\0");
}

function attachmentKey(
  caseId: string,
  revision: number,
  assetId: string,
  evidenceId: string,
  digest: string,
  family: SentinelTrafficSource,
) {
  return JSON.stringify([
    caseId,
    revision,
    assetId,
    evidenceId,
    digest,
    family,
  ]);
}

/** Only call on an authorized response from the exact traffic GET tool. */
export function approvedSentinelTrafficAttachmentKey(
  resultText: string,
): string | undefined {
  if (resultText.length > maxOutput) return undefined;
  try {
    const { caseId, evidenceRevision, _classification, receipt } = JSON.parse(
      resultText,
    );
    if (
      !isSentinelCaseId(caseId) || !positiveInteger(evidenceRevision) ||
      _classification !== "INTERNAL" || !receipt || Array.isArray(receipt)
    ) return undefined;
    const { assetIds, evidenceId, digest, family } = receipt;
    if (
      !Array.isArray(assetIds) || assetIds.length !== 1 ||
      !exactId(assetIds[0], 4096) || !exactId(evidenceId, 100) ||
      typeof digest !== "string" || !digestPattern.test(digest) ||
      !sentinelTrafficSources.includes(family)
    ) return undefined;
    return attachmentKey(
      caseId,
      evidenceRevision,
      assetIds[0],
      evidenceId,
      digest,
      family,
    );
  } catch {
    return undefined;
  }
}

function assignedAsset(scope: Scope, revision: number) {
  if (!scope.assignedTaskId || !scope.assignedTaskLeaseToken) return undefined;
  return readAssignedSentinelModelReview(
    scope.snapshotPath,
    revision,
    scope.assignedTaskId,
    scope.assignedTaskLeaseToken,
  )?.nodeId;
}

export function reopenSentinelLinkedTrafficPayload(
  snapshotPath: string,
  caseId: string,
  revision: number,
  subject: string | undefined,
  args: Record<string, unknown>,
  allowAsset?: (id: string) => boolean,
): string {
  const selector = sentinelLinkedTrafficPayloadArgs(args);
  if (selector?.revision !== revision) return unavailable;
  const { findingId, trafficLinkId, payloadPart, payloadOffset } = selector;
  const [link] = listSentinelFindingTrafficLinks(snapshotPath, {
    id: trafficLinkId,
    evidenceRevision: revision,
    assetId: subject,
    findingId,
    limit: 1,
  });
  if (link?.caseId !== caseId || allowAsset?.(link.assetId) === false) {
    return unavailable;
  }
  const receipt = readSentinelTrafficReceipt(snapshotPath, revision, {
    evidenceId: link.trafficId,
    digest: link.trafficDigest,
  }, link.assetId);
  if (!receipt || receipt.family !== link.trafficSource) return unavailable;
  const payload = projectSentinelTrafficBlob(
    receipt,
    payloadPart,
    payloadOffset,
  );
  if (typeof payload === "string") return payload;
  const result = JSON.stringify({
    _classification: "INTERNAL",
    caseId,
    evidenceRevision: revision,
    link,
    payload,
  });
  return result.length <= maxOutput ? result : unavailable;
}

function listForScope(
  scope: Scope,
  caseId: string,
  revision: number,
  subject: string | undefined,
  args: Record<string, unknown>,
  allowPayloadAsset?: (id: string) => boolean,
) {
  if (
    args.trafficLinkId !== undefined || args.payloadPart !== undefined ||
    args.payloadOffset !== undefined
  ) {
    return reopenSentinelLinkedTrafficPayload(
      scope.snapshotPath,
      caseId,
      revision,
      subject,
      args,
      allowPayloadAsset,
    );
  }
  const { findingId, limit = 5, offset = 0 } = args;
  if (
    findingId !== undefined &&
      (typeof findingId !== "string" || !findingPattern.test(findingId)) ||
    !positiveInteger(limit) || limit > 10 ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
    offset > 4096
  ) return unavailable;
  const retained = listSentinelFindingTrafficLinks(scope.snapshotPath, {
    evidenceRevision: revision,
    assetId: subject,
    findingId,
    limit: limit + 1,
    offset,
  });
  const links = retained.slice(0, limit);
  const evidenceVersion = typeof findingId === "string"
    ? sentinelFindingTrafficEvidenceVersion(
      scope.snapshotPath,
      revision,
      findingId,
      subject,
    ).digest
    : undefined;
  do {
    const output = JSON.stringify({
      _classification: "INTERNAL",
      caseId,
      evidenceRevision: revision,
      links,
      evidenceVersion,
      nextOffset: links.length < retained.length ? offset + links.length : null,
    });
    if (output.length <= maxOutput && (links.length || !retained.length)) {
      return output;
    }
  } while (links.pop());
  return "Error: Use an exact finding filter to narrow the traffic link page.";
}

function attachForScope(
  scope: Scope,
  caseId: string,
  revision: number,
  runId: string,
  assetId: string,
  taskId: string,
  args: Record<string, unknown>,
  approvedTraffic: ReadonlySet<string>,
  signal?: AbortSignal,
): string {
  const { findingId, recheckId, reportVersion, evidenceId, digest, requestId } =
    args;
  if (
    typeof findingId !== "string" || !findingPattern.test(findingId) ||
    recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheckPattern.test(recheckId)) ||
    !positiveInteger(reportVersion) ||
    !exactId(evidenceId, 100) || typeof digest !== "string" ||
    !digestPattern.test(digest) ||
    typeof requestId !== "string" || !uuidPattern.test(requestId)
  ) return unavailable;
  const { snapshotPath } = scope;
  // Check the approved receipt identity before reopening traffic or finding journals.
  const family = sentinelTrafficSources.find((source) =>
    approvedTraffic.has(
      attachmentKey(caseId, revision, assetId, evidenceId, digest, source),
    )
  );
  if (!family) return requiredReceipt;
  const traffic = readSentinelTrafficReceipt(snapshotPath, revision, {
    evidenceId,
    digest,
  }, assetId);
  if (
    !traffic || traffic.family !== family ||
    !hasSentinelWorkerFindingJournal(snapshotPath)
  ) return unavailable;
  const findings = openSentinelWorkerFindingStore(snapshotPath);
  try {
    const original = findings.readFinding(findingId);
    const recheck = recheckId === undefined
      ? undefined
      : findings.read(recheckId);
    if (
      original?.caseId !== caseId || original.runId !== runId ||
      original.targetId !== assetId ||
      original.evidenceRevision > revision ||
      recheckId !== undefined &&
        (recheck?.kind !== "recheck" || recheck.findingId !== original.id ||
          recheck.caseId !== caseId || recheck.runId !== runId ||
          recheck.targetId !== assetId ||
          recheck.evidenceRevision > revision) ||
      signal?.aborted || assignedAsset(scope, revision) !== assetId
    ) return unavailable;
    const journal = openSentinelFindingTrafficLinks(snapshotPath);
    try {
      const link = journal.record({
        caseId,
        evidenceRevision: revision,
        assetId,
        findingId,
        ...(recheckId !== undefined && { recheckId }),
        reportVersion,
        trafficId: evidenceId,
        trafficSource: traffic.family,
        trafficDigest: traffic.digest,
        authority: { kind: "assignment", taskId },
        requestId,
      }, () =>
        !signal?.aborted && assignedAsset(scope, revision) === assetId &&
        findings.readFindingReport(findingId, revision)?.version ===
          reportVersion);
      return link
        ? JSON.stringify({ _classification: "INTERNAL", link })
        : unavailable;
    } finally {
      journal.close();
    }
  } finally {
    findings.close();
  }
}

export function executeSentinelFindingTrafficTool(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  approvedTraffic: ReadonlySet<string>,
  signal?: AbortSignal,
  allowPayloadAsset?: (id: string) => boolean,
): string {
  const {
    snapshotPath,
    snapshotOverride,
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
  } = scope;
  const scoped = assignedTaskId !== undefined ||
    assignedTaskLeaseToken !== undefined;
  const attach = name === sentinelFindingTrafficAttachTool.name;
  const definition = attach
    ? sentinelFindingTrafficAttachTool
    : sentinelFindingTrafficListTool;
  const { revision } = args;
  if (
    name !== definition.name || !positiveInteger(revision) ||
    Object.keys(args).some((key) =>
      !Object.hasOwn(definition.parameters, key)
    ) ||
    (scoped || assessmentRevision !== undefined) &&
      revision !== assessmentRevision ||
    snapshotOverride !== undefined && assessmentRevision === undefined
  ) return unavailable;

  try {
    const caseId = locateSentinelCase(snapshotPath)?.caseId;
    if (!caseId || signal?.aborted) return unavailable;
    return withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      if (!state || signal?.aborted) return unavailable;
      const subject =
        scoped && state.active && !state.paused && state.revision === revision
          ? assignedAsset(scope, revision)
          : undefined;
      if (
        scoped && (!subject ||
          !state.result?.sharedGraph.snapshot?.nodes.some(({ id, kind }) =>
            id === subject && kind === "asset"
          ))
      ) return unavailable;
      if (attach) {
        return subject && assignedTaskId && state.plan.runId
          ? attachForScope(
            scope,
            caseId,
            revision,
            state.plan.runId,
            subject,
            assignedTaskId,
            args,
            approvedTraffic,
            signal,
          )
          : unavailable;
      }
      const saved = state.revision === revision
        ? state
        : readSentinelAssessmentRevision(snapshotPath, revision);
      return saved?.result
        ? listForScope(
          scope,
          caseId,
          revision,
          subject,
          args,
          allowPayloadAsset,
        )
        : unavailable;
    });
  } catch {
    return unavailable;
  }
}

/** Revalidate the exact proposed attachment under the case lock after approval. */
export async function attachOperatorSentinelFindingTraffic(
  snapshotPath: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
): Promise<string> {
  const { receiptId, recheckId, reportVersion, evidenceId, digest, requestId } =
    args;
  if (
    typeof receiptId !== "string" || !findingPattern.test(receiptId) ||
    recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheckPattern.test(recheckId)) ||
    !positiveInteger(reportVersion) || !exactId(evidenceId, 100) ||
    typeof digest !== "string" || !digestPattern.test(digest) ||
    typeof requestId !== "string" || !uuidPattern.test(requestId)
  ) return unavailable;
  const caseId = locateSentinelCase(snapshotPath)?.caseId;
  if (!caseId) return unavailable;
  const inspect = (
    approved?: { runId: string; input: SentinelFindingTrafficLinkInput },
  ) =>
    withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      const runId = state?.plan.runId;
      if (
        !runId || !state.active || state.revision !== revision ||
        !hasSentinelWorkerFindingJournal(snapshotPath)
      ) return;
      const findings = openSentinelWorkerFindingStore(snapshotPath);
      try {
        const report = findings.readFindingReport(receiptId, revision);
        const original = report?.finding;
        if (
          !original || report.version !== reportVersion ||
          original.caseId !== caseId || original.runId !== runId
        ) return;
        if (recheckId !== undefined) {
          const recheck = findings.read(recheckId);
          if (
            recheck?.kind !== "recheck" || recheck.findingId !== original.id ||
            recheck.caseId !== caseId || recheck.runId !== runId ||
            recheck.targetId !== original.targetId ||
            recheck.evidenceRevision > revision
          ) return;
        }
        const traffic = readSentinelTrafficReceipt(snapshotPath, revision, {
          evidenceId,
          digest,
        }, original.targetId);
        if (!traffic) return;
        const input: SentinelFindingTrafficLinkInput = {
          caseId,
          evidenceRevision: revision,
          assetId: original.targetId,
          findingId: original.id,
          ...(recheckId !== undefined && { recheckId }),
          reportVersion,
          trafficId: evidenceId,
          trafficSource: traffic.family,
          trafficDigest: digest,
          authority: { kind: "operator" },
          requestId: requestId.toLowerCase(),
        };
        if (!approved) return { runId, input };
        if (
          runId !== approved.runId ||
          JSON.stringify(input) !== JSON.stringify(approved.input)
        ) return;
        const links = openSentinelFindingTrafficLinks(snapshotPath);
        try {
          const link = links.record(input, () =>
            findings.readFindingReport(receiptId, revision)?.version ===
              reportVersion);
          return link && { runId, input, link };
        } finally {
          links.close();
        }
      } finally {
        findings.close();
      }
    });
  const preview = inspect();
  if (!preview) return unavailable;
  if (
    !await confirm(
      `Attach retained traffic ${evidenceId} (SHA-256 ${digest}) to ${
        recheckId ?? receiptId
      } in Sentinel case ${caseId}, revision ${revision}, report version ${reportVersion}?`,
    )
  ) return "Error: The operator declined the traffic attachment.";
  const committed = inspect(preview);
  return committed && "link" in committed && committed.link
    ? JSON.stringify({ _classification: "INTERNAL", link: committed.link })
    : unavailable;
}
