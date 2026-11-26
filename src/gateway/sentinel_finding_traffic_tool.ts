/** Exact leased-worker links from immutable findings to sanitized retained traffic. */
import { createHash } from "node:crypto";
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelRunIdForRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import { isSentinelCaseId, locateSentinelCase } from "../sentinel/cases.ts";
import {
  listSentinelFindingTrafficLinks,
  MAX_FINDING_TRAFFIC_BATCH,
  openSentinelFindingTrafficLinks,
  parseSentinelFindingTrafficAnnotationChange,
  previewSentinelFindingTrafficBatch,
  sentinelFindingTrafficEvidenceVersion,
  type SentinelFindingTrafficLinkInput,
  sentinelTrafficBatchMemberRequestId,
  sentinelTrafficEvidenceAnnotation,
  sentinelTrafficEvidenceRoles,
} from "../sentinel/finding_traffic_links.ts";
import {
  parseSentinelTrafficComposition,
  parseTrafficCompositionMove,
  type SentinelTrafficCompositionChange,
  type SentinelTrafficCompositionReceipt,
  trafficCompositionOrderDigest,
  trafficCompositionReceiptId,
} from "../sentinel/finding_traffic_composition.ts";
import {
  readSentinelTrafficReceipt,
  type SentinelTrafficSource,
  sentinelTrafficSources,
} from "../sentinel/traffic_receipts.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
} from "../sentinel/worker_finding_store.ts";
import {
  sentinelLinkedTrafficPayloadArgs,
  sentinelTrafficAttachBatchArgs,
  sentinelTrafficLinksArgs,
  sentinelTrafficPayloadByteLengthParameter,
  sentinelTrafficPayloadOffsetParameter,
  sentinelTrafficPayloadPartParameter,
} from "../sentinel/traffic_recovery.ts";
import {
  readAssignedSentinelModelReview,
  readSentinelOperatorTrafficHint,
} from "./sentinel_adaptive_runtime.ts";
import {
  projectSentinelTrafficBlob,
  readSentinelTrafficAssetScope,
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
    sourceHintId: {
      type: "integer",
      description:
        "Optional exact reviewed planner hint that linked this same traffic receipt to this assigned asset.",
    },
    evidenceRole: {
      type: "string",
      description: "How this receipt supports the finding or recheck.",
      enum: sentinelTrafficEvidenceRoles,
    },
    evidenceNote: {
      type: "string",
      description: "Short explanation of what this retained receipt shows.",
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
    graphFindingId: {
      type: "string",
      description:
        "Exact saved graph finding source ID to discover active attachments. Omit findingId and payload arguments.",
    },
    assetId: {
      type: "string",
      description:
        "Exact affected asset for a graph finding. Optional for leased workers bound to that asset.",
    },
    recheckId: {
      type: "string",
      description:
        "Return only links bound to this recheck. Requires findingId.",
    },
    trafficLinkId: {
      type: "string",
      description:
        "Exact link ID from a previous page. Requires findingId and payloadPart.",
    },
    payloadPart: {
      ...sentinelTrafficPayloadPartParameter,
      description: "Exact retained payload part.",
    },
    payloadOffset: sentinelTrafficPayloadOffsetParameter,
    byteLength: sentinelTrafficPayloadByteLengthParameter,
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

export function sentinelTrafficAttachmentKey(
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
    return sentinelTrafficAttachmentKey(
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

function findingTrafficOriginal(
  path: string,
  caseId: string,
  revision: number,
  policy: NonNullable<ReturnType<typeof readSentinelTrafficAssetScope>>,
  findingId: string,
) {
  const original = readSentinelCaseFindingReceipts(path, [findingId])
    .get(findingId);
  if (
    original?.kind === "finding" && original.caseId === caseId &&
    original.runId === policy.runId && original.evidenceRevision <= revision &&
    policy.assets.has(original.targetId)
  ) return original;
}

/** Resolve one attachment subject through its exact saved/current case policy. */
export function readAuthorizedSentinelFindingTrafficScope(
  path: string,
  caseId: string,
  revision: number,
  findingId: string,
) {
  if (locateSentinelCase(path)?.caseId !== caseId) return;
  const scope = readSentinelTrafficAssetScope(path, revision);
  const original = scope &&
    findingTrafficOriginal(path, caseId, revision, scope, findingId);
  return scope && original ? { ...scope, original } : undefined;
}

/** Check the selected finding and the exact returned attachments before delivery. */
export function currentSentinelFindingTrafficRead(
  path: string,
  args: Readonly<Record<string, unknown>>,
  response: string,
) {
  const revision = args.revision;
  if (!positiveInteger(revision)) return false;
  const caseId = locateSentinelCase(path)?.caseId;
  const scope = readSentinelTrafficAssetScope(path, revision);
  const page = JSON.parse(response);
  if (
    !caseId || !scope || page.caseId !== caseId ||
    page.evidenceRevision !== revision
  ) return false;
  if (typeof args.findingId === "string") {
    const original = findingTrafficOriginal(
      path,
      caseId,
      revision,
      scope,
      args.findingId,
    );
    if (
      !original || (page.evidenceVersion !== undefined &&
        page.evidenceVersion !== sentinelFindingTrafficEvidenceVersion(
            path,
            revision,
            original.id,
            original.targetId,
          ).digest)
    ) return false;
  }
  if (
    typeof args.graphFindingId === "string" &&
    !allowsSentinelGraphFindingTrafficPage(
      path,
      caseId,
      revision,
      args.graphFindingId,
      page.links,
      typeof args.assetId === "string" ? args.assetId : undefined,
    )
  ) return false;
  return (page.link ? [page.link] : page.links).every((link: {
    id: string;
    caseId: string;
    evidenceRevision: number;
    assetId: string;
  }) =>
    link.caseId === caseId && link.evidenceRevision === revision &&
    scope.assets.has(link.assetId) &&
    listSentinelFindingTrafficLinks(path, {
      id: link.id,
      assetId: link.assetId,
      evidenceRevision: revision,
      limit: 1,
    }).some(({ id }) => id === link.id)
  );
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
  const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
  if (selector?.revision !== revision || !scope) return unavailable;
  const {
    findingId,
    recheckId,
    trafficLinkId,
    payloadPart,
    payloadOffset,
    byteLength,
  } = selector;
  const original = findingTrafficOriginal(
    snapshotPath,
    caseId,
    revision,
    scope,
    findingId,
  );
  if (
    !original || (subject && original.targetId !== subject) ||
    allowAsset?.(original.targetId) === false
  ) return unavailable;
  const [link] = listSentinelFindingTrafficLinks(snapshotPath, {
    id: trafficLinkId,
    evidenceRevision: revision,
    assetId: subject,
    findingId,
    recheckId,
    limit: 1,
  });
  if (link?.caseId !== caseId || link.assetId !== original.targetId) {
    return unavailable;
  }
  const receipt = readSentinelTrafficReceipt(
    snapshotPath,
    revision,
    {
      evidenceId: link.trafficId,
      digest: link.trafficDigest,
    },
    link.assetId,
    scope.assets,
  );
  if (!receipt || receipt.family !== link.trafficSource) return unavailable;
  const payload = projectSentinelTrafficBlob(
    receipt,
    payloadPart,
    payloadOffset,
    byteLength,
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
    args.payloadOffset !== undefined || args.byteLength !== undefined
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
  const selector = sentinelTrafficLinksArgs(args);
  const policy = readSentinelTrafficAssetScope(scope.snapshotPath, revision);
  if (!selector || !policy) return unavailable;
  const allows = (asset: string) =>
    policy.assets.has(asset) && allowPayloadAsset?.(asset) !== false;

  const {
    findingId,
    graphFindingId,
    assetId,
    recheckId,
    limit = 5,
    offset = 0,
  } = selector;
  if (graphFindingId !== undefined) {
    if ((!subject && !assetId) || (subject && assetId && subject !== assetId)) {
      return unavailable;
    }
    const ids = discoverSentinelFindingNodeTraffic(
      scope.snapshotPath,
      caseId,
      revision,
      graphFindingId,
      offset,
      limit,
      subject ?? assetId,
      allows,
    );
    if (!ids) return unavailable;
    const links = ids.links.flatMap(({ trafficLinkId, assetId }) =>
      listSentinelFindingTrafficLinks(scope.snapshotPath, {
        id: trafficLinkId,
        assetId,
        evidenceRevision: revision,
      })
    );
    if (links.length !== ids.links.length) return unavailable;
    return boundFindingTrafficPage(
      caseId,
      revision,
      links,
      offset,
      ids.nextOffset !== null,
    );
  }
  let selectedAsset = subject ?? assetId;
  if (
    (subject && assetId && subject !== assetId) ||
    (selectedAsset && !allows(selectedAsset))
  ) return unavailable;
  if (findingId !== undefined) {
    const original = findingTrafficOriginal(
      scope.snapshotPath,
      caseId,
      revision,
      policy,
      findingId,
    );
    if (
      !original || (selectedAsset && selectedAsset !== original.targetId) ||
      !allows(original.targetId)
    ) return unavailable;
    selectedAsset = original.targetId;
  }
  const retained = listSentinelFindingTrafficLinks(scope.snapshotPath, {
    evidenceRevision: revision,
    assetId: selectedAsset,
    allowedAssetIds: [...policy.assets].filter(allows),
    findingId,
    recheckId,
    limit: limit + 1,
    offset,
  });
  const links = retained.slice(0, limit);
  const evidenceVersion = typeof findingId === "string"
    ? sentinelFindingTrafficEvidenceVersion(
      scope.snapshotPath,
      revision,
      findingId,
      selectedAsset,
    ).digest
    : undefined;
  return boundFindingTrafficPage(
    caseId,
    revision,
    links,
    offset,
    links.length < retained.length,
    evidenceVersion,
  );
}

function boundFindingTrafficPage(
  caseId: string,
  revision: number,
  links: ReturnType<typeof listSentinelFindingTrafficLinks>,
  offset: number,
  more: boolean,
  evidenceVersion?: string,
): string {
  const originalLength = links.length;
  do {
    const output = JSON.stringify({
      _classification: "INTERNAL",
      caseId,
      evidenceRevision: revision,
      links,
      evidenceVersion,
      nextOffset: more || links.length < originalLength
        ? offset + links.length
        : null,
    });
    if (output.length <= maxOutput && (links.length || !originalLength)) {
      return output;
    }
  } while (links.pop());
  return "Error: Use an exact finding filter to narrow the traffic link page.";
}

export const sentinelReporterTrafficAttachTool: ToolDefinition = {
  ...sentinelFindingTrafficAttachTool,
  description: sentinelFindingTrafficAttachTool.description +
    " Use trafficRefs instead of evidenceId and digest to attach two to four receipts atomically.",
  parameters: {
    ...sentinelFindingTrafficAttachTool.parameters,
    evidenceId: {
      ...sentinelFindingTrafficAttachTool.parameters.evidenceId,
      required: false,
    },
    digest: {
      ...sentinelFindingTrafficAttachTool.parameters.digest,
      required: false,
    },
    trafficRefs: {
      type: "array",
      description:
        "Ordered exact traffic evidenceId and digest pairs from this reporter's prior reads. Each may supply an evidenceRole or evidenceNote.",
      items: { type: "object" },
    },
  },
};

type TrafficReadStep = { readonly stepIndex: number; readonly sha256: string };

function attachReporterBatch(
  scope: Scope,
  caseId: string,
  runId: string,
  assetId: string,
  taskId: string,
  raw: Record<string, unknown>,
  approved: ReadonlyMap<string, TrafficReadStep>,
  signal?: AbortSignal,
): string {
  const args = sentinelTrafficAttachBatchArgs(raw);
  if (!args || !hasSentinelWorkerFindingJournal(scope.snapshotPath)) {
    return unavailable;
  }
  const inputs: SentinelFindingTrafficLinkInput[] = [];
  for (const [index, member] of args.trafficRefs.entries()) {
    const { evidenceId, digest, ...annotation } = member;
    const family = sentinelTrafficSources.find((source) =>
      approved.has(
        sentinelTrafficAttachmentKey(
          caseId,
          args.revision,
          assetId,
          evidenceId,
          digest,
          source,
        ),
      )
    );
    const sourceStep = family && approved.get(
      sentinelTrafficAttachmentKey(
        caseId,
        args.revision,
        assetId,
        evidenceId,
        digest,
        family,
      ),
    );
    if (!sourceStep) return requiredReceipt;
    const receipt = readSentinelTrafficReceipt(
      scope.snapshotPath,
      args.revision,
      { evidenceId, digest },
      assetId,
    );
    if (receipt?.family !== family || !receipt) return unavailable;
    const requestId = sentinelTrafficBatchMemberRequestId(
      args.requestId,
      index,
    );
    inputs.push({
      caseId,
      evidenceRevision: args.revision,
      assetId,
      findingId: args.findingId,
      reportVersion: args.reportVersion,
      trafficId: evidenceId,
      trafficSource: receipt.family,
      trafficDigest: receipt.digest,
      ...annotation,
      sourceStep,
      authority: { kind: "assignment", taskId },
      requestId,
    });
  }
  const findings = openSentinelWorkerFindingStore(scope.snapshotPath);
  try {
    const original = findings.readFinding(args.findingId);
    if (
      original?.caseId !== caseId || original.runId !== runId ||
      original.targetId !== assetId ||
      original.evidenceRevision !== args.revision
    ) {
      return unavailable;
    }
    const journal = openSentinelFindingTrafficLinks(scope.snapshotPath);
    try {
      const links = journal.recordBatch(
        args.requestId,
        runId,
        inputs,
        () =>
          !signal?.aborted && assignedAsset(scope, args.revision) === assetId &&
          findings.readFindingReport(args.findingId, args.revision)?.version ===
            args.reportVersion,
      );
      const exact = links && journal.readAssignmentBatch({
        caseId,
        runId,
        evidenceRevision: args.revision,
        taskId,
        assetId,
      }, args.requestId);
      return exact
        ? JSON.stringify({ _classification: "INTERNAL", ...exact })
        : unavailable;
    } finally {
      journal.close();
    }
  } finally {
    findings.close();
  }
}

function attachForScope(
  scope: Scope,
  caseId: string,
  revision: number,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  runId: string,
  assetId: string,
  taskId: string,
  args: Record<string, unknown>,
  approvedTraffic: ReadonlySet<string>,
  signal?: AbortSignal,
): string {
  const {
    findingId,
    recheckId,
    reportVersion,
    evidenceId,
    digest,
    requestId,
    sourceHintId,
  } = args;
  const annotation = sentinelTrafficEvidenceAnnotation(args);
  if (
    !annotation || typeof findingId !== "string" ||
    !findingPattern.test(findingId) ||
    recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheckPattern.test(recheckId)) ||
    !positiveInteger(reportVersion) ||
    (sourceHintId !== undefined && !positiveInteger(sourceHintId)) ||
    !exactId(evidenceId, 100) || typeof digest !== "string" ||
    !digestPattern.test(digest) ||
    typeof requestId !== "string" || !uuidPattern.test(requestId)
  ) return unavailable;
  const { snapshotPath } = scope;
  // Check the approved receipt identity before reopening traffic or finding journals.
  const family = sentinelTrafficSources.find((source) =>
    approvedTraffic.has(
      sentinelTrafficAttachmentKey(
        caseId,
        revision,
        assetId,
        evidenceId,
        digest,
        source,
      ),
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
  if (sourceHintId !== undefined) {
    const source = readSentinelOperatorTrafficHint(
      snapshotPath,
      state,
      sourceHintId,
      assetId,
      { evidenceId, digest },
    );
    if (source?.evidenceId !== evidenceId || source.digest !== digest) {
      return unavailable;
    }
  }
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
        ...annotation,
        ...(sourceHintId !== undefined &&
          { sourceHint: { id: sourceHintId, runId } }),
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
  reporterTrafficReads?: ReadonlyMap<string, TrafficReadStep>,
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
    ? reporterTrafficReads
      ? sentinelReporterTrafficAttachTool
      : sentinelFindingTrafficAttachTool
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
        if ("trafficRefs" in args) {
          return reporterTrafficReads && subject && assignedTaskId &&
              state.plan.runId
            ? attachReporterBatch(
              scope,
              caseId,
              state.plan.runId,
              subject,
              assignedTaskId,
              args,
              reporterTrafficReads,
              signal,
            )
            : unavailable;
        }
        return subject && assignedTaskId && state.plan.runId
          ? attachForScope(
            scope,
            caseId,
            revision,
            state,
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
  authorize?: () => Promise<boolean>,
): Promise<string> {
  const { receiptId, recheckId, reportVersion, evidenceId, digest, requestId } =
    args;
  const annotation = sentinelTrafficEvidenceAnnotation(args);
  if (
    !annotation || typeof receiptId !== "string" ||
    !findingPattern.test(receiptId) ||
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
      const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
      if (
        !runId || scope?.runId !== runId || !state.active ||
        state.revision !== revision ||
        !hasSentinelWorkerFindingJournal(snapshotPath)
      ) return;
      const findings = openSentinelWorkerFindingStore(snapshotPath);
      try {
        const report = findings.readFindingReport(receiptId, revision);
        const original = report?.finding;
        if (
          !original || report.version !== reportVersion ||
          original.caseId !== caseId || original.runId !== runId ||
          !scope.assets.has(original.targetId)
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
        const traffic = readSentinelTrafficReceipt(
          snapshotPath,
          revision,
          {
            evidenceId,
            digest,
          },
          original.targetId,
          scope.assets,
        );
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
          ...annotation,
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
      } in Sentinel case ${caseId}, revision ${revision}, report version ${reportVersion}?${
        Object.keys(annotation).length ? `\n${JSON.stringify(annotation)}` : ""
      }`,
    )
  ) return "Error: The operator declined the traffic attachment.";
  if (authorize && !await authorize()) return unavailable;
  const committed = inspect(preview);
  return committed && "link" in committed && committed.link
    ? JSON.stringify({ _classification: "INTERNAL", link: committed.link })
    : unavailable;
}

/** Amend descriptive metadata while retaining the original attachment and payload. */
export async function annotateOperatorSentinelFindingTraffic(
  snapshotPath: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
  authorize?: () => Promise<boolean>,
): Promise<string> {
  const { receiptId } = args;
  const change = parseSentinelFindingTrafficAnnotationChange({
    ...args,
    linkId: args.trafficLinkId,
  });
  const caseId = locateSentinelCase(snapshotPath)?.caseId;
  if (
    !caseId || !change || typeof receiptId !== "string" ||
    !findingPattern.test(receiptId)
  ) return unavailable;
  const inspect = (approvedRunId?: string) =>
    withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      const runId = state?.plan.runId;
      const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
      if (
        !runId || scope?.runId !== runId || !state.active ||
        state.revision !== revision ||
        (approvedRunId !== undefined && approvedRunId !== runId) ||
        !hasSentinelWorkerFindingJournal(snapshotPath)
      ) return;
      const [link] = listSentinelFindingTrafficLinks(snapshotPath, {
        id: change.linkId,
        findingId: receiptId,
        evidenceRevision: revision,
        limit: 1,
      });
      if (!link || link.caseId !== caseId) return;
      const findings = openSentinelWorkerFindingStore(snapshotPath);
      try {
        const report = findings.readFindingReport(receiptId, revision);
        if (
          !report || report.finding.caseId !== caseId ||
          report.finding.runId !== runId ||
          report.finding.targetId !== link.assetId ||
          !scope.assets.has(link.assetId)
        ) return;
        const evidence = readSentinelTrafficReceipt(
          snapshotPath,
          revision,
          {
            evidenceId: link.trafficId,
            digest: link.trafficDigest,
          },
          link.assetId,
          scope.assets,
        );
        if (evidence?.family !== link.trafficSource) return;
        const links = openSentinelFindingTrafficLinks(snapshotPath);
        try {
          const replay = links.reviewAnnotation(link, change, false);
          if (!replay) return;
          if (replay.saved) return { runId, link, amendment: replay.amendment };
          if (report.version !== change.reportVersion) return;
          const result = approvedRunId
            ? links.reviewAnnotation(link, change, true)
            : replay;
          return result && { runId, link, amendment: result.amendment };
        } finally {
          links.close();
        }
      } finally {
        findings.close();
      }
    });
  const preview = inspect();
  if (!preview) return unavailable;
  if (preview.amendment) {
    return JSON.stringify({
      _classification: "INTERNAL",
      amendment: preview.amendment,
    });
  }
  if (
    !await confirm(
      `Amend retained traffic annotation for ${receiptId} in case ${caseId}, revision ${revision}?\n${
        JSON.stringify({
          assetId: preview.link.assetId,
          trafficDigest: preview.link.trafficDigest,
          ...change,
        })
      }`,
    )
  ) return "Error: The operator declined the traffic annotation.";
  if (authorize && !await authorize()) return unavailable;
  const committed = inspect(preview.runId);
  return committed?.amendment
    ? JSON.stringify({
      _classification: "INTERNAL",
      amendment: committed.amendment,
    })
    : unavailable;
}

export async function editOperatorSentinelFindingTrafficSet(
  snapshotPath: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
  authorize?: () => Promise<boolean>,
): Promise<string> {
  const { receiptId } = args;
  const caseId = locateSentinelCase(snapshotPath)?.caseId;
  if (
    !caseId || typeof receiptId !== "string" || !findingPattern.test(receiptId)
  ) return unavailable;
  const { moveTrafficLinkId, beforeTrafficLinkId, trafficLinkIds } = args;
  const move = parseTrafficCompositionMove(
    moveTrafficLinkId,
    beforeTrafficLinkId,
  );
  if (
    (moveTrafficLinkId !== undefined || beforeTrafficLinkId !== undefined) &&
    (!move || args.action !== "reorder_finding_traffic" ||
      trafficLinkIds !== undefined || args.trafficLinkId !== undefined)
  ) return unavailable;
  const present = (receipt: SentinelTrafficCompositionReceipt): string => {
    if (receipt.operation !== "reorder" || receipt.linkIds.length <= 32) {
      return JSON.stringify({
        _classification: "INTERNAL",
        amendment: receipt,
      });
    }
    const { linkIds, ...scope } = receipt;
    return JSON.stringify({
      _classification: "INTERNAL",
      amendment: {
        ...scope,
        linkCount: linkIds.length,
        orderDigest: trafficCompositionOrderDigest(linkIds),
      },
    });
  };
  const inspect = (approved?: SentinelTrafficCompositionChange) =>
    withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      const runId = state?.plan.runId;
      const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
      if (
        !runId || scope?.runId !== runId || !state.active ||
        state.revision !== revision ||
        (approved !== undefined && approved.runId !== runId) ||
        !hasSentinelWorkerFindingJournal(snapshotPath)
      ) return;
      const findings = openSentinelWorkerFindingStore(snapshotPath);
      try {
        const report = findings.readFindingReport(receiptId, revision);
        const target = report?.finding.targetId;
        if (
          !report || !target || report.finding.caseId !== caseId ||
          report.finding.runId !== runId ||
          !scope.assets.has(target)
        ) return;
        const links = openSentinelFindingTrafficLinks(snapshotPath);
        try {
          const scopedIds = links.activeCompositionIds(
            revision,
            receiptId,
            target,
          );
          let linkIds = trafficLinkIds;
          if (move) {
            const request = typeof args.requestId === "string"
              ? links.compositionRequest(args.requestId.toLowerCase())
              : undefined;
            if (request) {
              if (request.operation !== "reorder" || !request.move) return;
              linkIds = request.linkIds;
            } else {
              if (
                !scopedIds.includes(move.linkId) ||
                (move.beforeLinkId && !scopedIds.includes(move.beforeLinkId))
              ) return;
              const order = scopedIds.filter((id) => id !== move.linkId);
              order.splice(
                move.beforeLinkId
                  ? order.indexOf(move.beforeLinkId)
                  : order.length,
                0,
                move.linkId,
              );
              linkIds = order;
            }
          }
          const proposal = parseSentinelTrafficComposition({
            caseId,
            runId,
            evidenceRevision: revision,
            findingId: receiptId,
            reportVersion: args.reportVersion,
            evidenceVersion: args.evidenceVersion,
            requestId: args.requestId,
            operation: args.action === "reorder_finding_traffic"
              ? "reorder"
              : "withdraw",
            linkId: args.trafficLinkId,
            linkIds,
            ...(move && { move }),
          });
          if (
            !proposal ||
            (approved && JSON.stringify(approved) !== JSON.stringify(proposal))
          ) return;
          const prior = links.reviewComposition(proposal, false);
          if (!prior) return;
          if (prior.saved) {
            return { proposal, amendment: prior.amendment, target };
          }
          if (proposal.reportVersion !== report.version) return;
          const ids = proposal.operation === "withdraw"
            ? [proposal.linkId]
            : proposal.linkIds;
          const currentScope = new Set(scopedIds);
          if (ids.some((id) => !currentScope.has(id))) return;
          const committed = approved
            ? links.reviewComposition(proposal, true)
            : prior;
          return committed &&
            { proposal, amendment: committed.amendment, target };
        } finally {
          links.close();
        }
      } finally {
        findings.close();
      }
    });
  const preview = inspect();
  if (!preview) return unavailable;
  if (preview.amendment) return present(preview.amendment);
  const review = preview.proposal.operation === "reorder" &&
      preview.proposal.linkIds.length > 32
    ? (() => {
      const { linkIds, ...scope } = preview.proposal;
      return {
        ...scope,
        linkCount: linkIds.length,
        first: linkIds.slice(0, 2),
        last: linkIds.slice(-2),
        orderDigest: trafficCompositionOrderDigest(linkIds),
        receiptId: trafficCompositionReceiptId(
          JSON.stringify(preview.proposal),
        ),
      };
    })()
    : preview.proposal;
  if (
    !await confirm(
      `Review this exact retained traffic set change?\n${
        JSON.stringify({ targetAssetId: preview.target, ...review })
      }`,
    )
  ) return "Error: The operator declined the traffic set change.";
  if (authorize && !await authorize()) return unavailable;
  const saved = inspect(preview.proposal)?.amendment;
  return saved ? present(saved) : unavailable;
}

/** Review and atomically attach a bounded set of already-retained evidence. */
export async function attachOperatorSentinelFindingTrafficBatch(
  snapshotPath: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
  authorize?: () => Promise<boolean>,
): Promise<string> {
  const { receiptId, recheckId, reportVersion, requestId, trafficRefs } = args;
  const caseId = locateSentinelCase(snapshotPath)?.caseId;
  if (
    !caseId || typeof receiptId !== "string" ||
    !findingPattern.test(receiptId) ||
    (recheckId !== undefined &&
      (typeof recheckId !== "string" || !recheckPattern.test(recheckId))) ||
    !positiveInteger(reportVersion) || typeof requestId !== "string" ||
    !uuidPattern.test(requestId) ||
    !Array.isArray(trafficRefs) || trafficRefs.length < 2 ||
    trafficRefs.length > MAX_FINDING_TRAFFIC_BATCH
  ) return unavailable;
  const canonicalRequest = requestId.toLowerCase();
  const submitted: {
    evidenceId: string;
    digest: string;
    annotation: NonNullable<
      ReturnType<typeof sentinelTrafficEvidenceAnnotation>
    >;
    itemRequestId: string;
  }[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of trafficRefs.entries()) {
    if (
      !raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some((key) =>
        !["evidenceId", "digest", "evidenceRole", "evidenceNote"].includes(key)
      )
    ) return unavailable;
    const { evidenceId, digest } = raw as Record<string, unknown>;
    const annotation = sentinelTrafficEvidenceAnnotation(raw);
    if (
      !annotation || !exactId(evidenceId, 100) || ids.has(evidenceId) ||
      typeof digest !== "string" || !digestPattern.test(digest)
    ) return unavailable;
    ids.add(evidenceId);
    const hash = createHash("sha256").update(
      JSON.stringify(["sentinel-traffic-link-batch", canonicalRequest, index]),
    ).digest("hex");
    const itemRequestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${
      hash.slice(13, 16)
    }-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    submitted.push({ evidenceId, digest, annotation, itemRequestId });
  }
  const inspect = (approvedBinding?: string) =>
    withSentinelAssessmentWriteLock(snapshotPath, (state) => {
      const runId = state?.plan.runId;
      const scope = readSentinelTrafficAssetScope(snapshotPath, revision);
      if (
        !runId || scope?.runId !== runId || !state.active ||
        state.revision !== revision ||
        !hasSentinelWorkerFindingJournal(snapshotPath)
      ) return;
      const journal = openSentinelWorkerFindingStore(snapshotPath);
      try {
        const report = journal.readFindingReport(receiptId, revision);
        const original = report?.finding;
        if (
          !original || original.caseId !== caseId || original.runId !== runId ||
          !scope.assets.has(original.targetId)
        ) return;
        if (recheckId !== undefined) {
          const recheck = journal.read(recheckId);
          if (
            recheck?.kind !== "recheck" || recheck.findingId !== original.id ||
            recheck.caseId !== caseId || recheck.runId !== runId ||
            recheck.targetId !== original.targetId ||
            recheck.evidenceRevision > revision
          ) return;
        }
        const inputs: SentinelFindingTrafficLinkInput[] = [];
        for (
          const { evidenceId, digest, annotation, itemRequestId } of submitted
        ) {
          const receipt = readSentinelTrafficReceipt(
            snapshotPath,
            revision,
            {
              evidenceId,
              digest,
            },
            original.targetId,
            scope.assets,
          );
          if (!receipt) return;
          inputs.push({
            caseId,
            evidenceRevision: revision,
            assetId: original.targetId,
            findingId: receiptId,
            ...(typeof recheckId === "string" && { recheckId }),
            reportVersion,
            trafficId: evidenceId,
            trafficDigest: digest,
            trafficSource: receipt.family,
            ...annotation,
            authority: { kind: "operator" },
            requestId: itemRequestId,
          });
        }
        const preview = previewSentinelFindingTrafficBatch(
          snapshotPath,
          canonicalRequest,
          runId,
          inputs,
        );
        if (
          !preview ||
          (approvedBinding !== undefined && approvedBinding !== preview.binding)
        ) return;
        if (preview.saved) return { ...preview, links: preview.saved };
        if (report.version !== reportVersion) return;
        if (approvedBinding === undefined) {
          return { ...preview, links: undefined };
        }
        const links = openSentinelFindingTrafficLinks(snapshotPath);
        try {
          return {
            ...preview,
            links: links.recordBatch(
              canonicalRequest,
              runId,
              inputs,
              () =>
                journal.readFindingReport(receiptId, revision)?.version ===
                  reportVersion,
            ),
          };
        } finally {
          links.close();
        }
      } finally {
        journal.close();
      }
    });
  const preview = inspect();
  if (!preview) return unavailable;
  if (preview.links) {
    return JSON.stringify({
      _classification: "INTERNAL",
      links: preview.links,
    });
  }
  if (
    !await confirm(
      `Attach these exact retained records to ${receiptId} at Sentinel case ${caseId}, revision ${revision}, report version ${reportVersion}?\n${
        JSON.stringify(
          preview.canonical.map(({ requestId: _requestId, ...input }) => input),
        )
      }`,
    )
  ) return "Error: The operator declined the traffic attachment batch.";
  if (authorize && !await authorize()) return unavailable;
  const links = inspect(preview.binding)?.links;
  return links
    ? JSON.stringify({ _classification: "INTERNAL", links })
    : unavailable;
}

/** Reauthorize the exact graph finding and scoped assets without reopening payloads. */
export function scopedSentinelFindingTrafficAssets(
  path: string,
  revision: number,
  graphFindingId: string,
  assetId?: string,
  allowAsset?: (id: string) => boolean,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const saved = readSentinelAssessmentRevision(path, revision);
  const graph = saved?.result.sharedGraph.snapshot;
  if (
    !runId || readSentinelAssessment(path)?.plan.runId !== runId ||
    !graph?.nodes.some(({ id, kind }) =>
      id === graphFindingId && kind === "finding"
    )
  ) return;
  const allowed = readSentinelTrafficAssetScope(path, revision)?.assets;
  if (!allowed) return;
  const assets = new Set(
    graph.edges.flatMap(({ from, to, relation }) =>
      from === graphFindingId && relation === "affects" &&
        (assetId === undefined || assetId === to) &&
        allowed.has(to) &&
        (!allowAsset || allowAsset(to)) &&
        graph.nodes.some(({ id, kind }) => id === to && kind === "asset")
        ? [to]
        : []
    ),
  );
  if (assets.size) return assets;
}

/** Check a saved attachment page against current scope and exact original findings. */
export function allowsSentinelGraphFindingTrafficPage(
  path: string,
  caseId: string,
  revision: number,
  graphFindingId: string | undefined,
  links: ReturnType<typeof listSentinelFindingTrafficLinks>,
  assetId?: string,
): boolean {
  if (graphFindingId === undefined) {
    const boundary = readSentinelTrafficAssetScope(path, revision);
    return !!boundary &&
      links.every((link) =>
        link.caseId === caseId && link.evidenceRevision === revision &&
        (!assetId || assetId === link.assetId) &&
        boundary.assets.has(link.assetId)
      );
  }
  const assets = scopedSentinelFindingTrafficAssets(
    path,
    revision,
    graphFindingId,
    assetId,
  );
  if (!assets) return false;
  const runId = readSentinelRunIdForRevision(path, revision);
  const reports = readSentinelCaseFindingReceipts(
    path,
    [...new Set(links.map(({ findingId }) => findingId))],
  );
  return links.every((link) => {
    const report = reports.get(link.findingId);
    return report?.kind === "finding" &&
      link.caseId === caseId && report.caseId === caseId &&
      report.runId === runId && report.evidenceRevision <= revision &&
      link.evidenceRevision === revision &&
      report.graphFindingId === graphFindingId &&
      report.targetId === link.assetId && assets.has(link.assetId);
  });
}

/** Offer discovery metadata for reports anchored to one authorized graph finding. */
export function discoverSentinelFindingNodeTraffic(
  path: string,
  caseId: string,
  revision: number,
  graphFindingId: string,
  offset: number,
  limit: number,
  assetId?: string,
  allowAsset?: (id: string) => boolean,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const assets = scopedSentinelFindingTrafficAssets(
    path,
    revision,
    graphFindingId,
    assetId,
    allowAsset,
  );
  if (!runId || !assets) return;
  const entries: {
    findingId: string;
    assetId: string;
    trafficLinkId: string;
    recheckId?: string;
    evidenceVersion: string;
  }[] = [];
  if (hasSentinelWorkerFindingJournal(path)) {
    const findings = openSentinelWorkerFindingStore(path);
    try {
      const ids = findings.listFindingIds(
        caseId,
        runId,
        revision,
        129,
        graphFindingId,
      );
      if (ids.length > 128) return;
      for (const findingId of ids) {
        const finding = findings.readFinding(findingId);
        if (!finding || !assets.has(finding.targetId)) continue;
        const count = offset + limit + 1 - entries.length;
        if (count <= 0) break;
        const links = [];
        for (let linkOffset = 0; linkOffset < count; linkOffset += 100) {
          const page = listSentinelFindingTrafficLinks(path, {
            findingId,
            assetId: finding.targetId,
            evidenceRevision: revision,
            limit: Math.min(100, count - linkOffset),
            offset: linkOffset,
          });
          links.push(...page.filter((link) => link.caseId === caseId));
          if (page.length < 100) break;
        }
        if (!links.length) continue;
        const evidenceVersion = sentinelFindingTrafficEvidenceVersion(
          path,
          revision,
          findingId,
          finding.targetId,
        ).digest;
        entries.push(...links.map((link) => ({
          findingId,
          assetId: finding.targetId,
          trafficLinkId: link.id,
          ...(link.recheckId && { recheckId: link.recheckId }),
          evidenceVersion,
        })));
      }
    } finally {
      findings.close();
    }
  }
  return {
    graphFindingId,
    revision,
    links: entries.slice(offset, offset + limit),
    nextOffset: entries.length > offset + limit ? offset + limit : null,
  };
}
