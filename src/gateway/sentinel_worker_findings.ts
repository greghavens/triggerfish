import {
  nativeRepositoryVisibilityEvidenceId,
  type SentinelRepositoryVisibilityReference,
} from "../sentinel/github_repository_visibility.ts";
import { verifySentinelNativeRepositoryRecheck } from "./sentinel_native_repository_recheck.ts";

import {
  initialSentinelFindingTrafficEvidenceVersion,
  openSentinelFindingTrafficLinks,
  type SentinelFindingTrafficLinkInput,
  sentinelTrafficBatchMemberRequestId,
} from "../sentinel/finding_traffic_links.ts";
import { readSentinelTrafficReceipt } from "../sentinel/traffic_receipts.ts";
import { sentinelTrafficAttachmentKey } from "./sentinel_finding_traffic_tool.ts";
import {
  INCONCLUSIVE_RECHECK_TOOL,
  inconclusiveRecheckArgs,
} from "../sentinel/recheck_inconclusive.ts";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { isDeepStrictEqual } from "node:util";
import { digestSentinelSnapshot } from "../sentinel/shared_inventory.ts";
import { notifyCommittedEvidence } from "../core/evidence_task_progression.ts";
import { sentinelFindingTrafficEvidenceVersion } from "../sentinel/finding_traffic_links.ts";
import { readSentinelFindingPageReference } from "../sentinel/worker_goal_recovery.ts";
import { SENTINEL_RECHECK_CONTEXT_TOOL } from "../sentinel/worker_finding_recovery.ts";
import {
  type ExecutionControlReceipt,
  executionReceiptSupportsCheck,
  executionRecheckScope,
  receiptRecheckCandidate,
} from "./sentinel_execution_rechecks.ts";
import {
  MAX_SENTINEL_FINDING_RESULT_CHARS,
  parseSentinelInitialTrafficSelection,
} from "../sentinel/worker_finding_recovery.ts";
/** Exact case/lease gate for worker findings and retained remediation evidence. */
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraintDigest,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  type SentinelOperatingConstraintRecord,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import {
  sentinelFindingDispositions,
  sentinelFindingSeverities,
} from "../sentinel/graph.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import {
  executionFindingAsset,
  readWorkerFindingRechecks,
  verifyWorkerFindingRecheck,
} from "../sentinel/worker_finding_evidence.ts";
import {
  findingReportMetadata,
  hasSentinelWorkerFindingJournal,
  initialFindingMetadata,
  normalizeFindingReportCategory,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
  readSentinelStagedTrafficFinding,
  readSentinelWorkerFindingReport,
  readSentinelWorkerFindingWriteReceipt,
  readStagedTrafficLinks,
  type SentinelAnalystFindingInput,
} from "../sentinel/worker_finding_store.ts";
import {
  readAssignedSentinelModelReview,
  readSentinelOperatorTrafficHint,
} from "./sentinel_adaptive_runtime.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";

import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";

function allowedFindingContext(
  path: string,
  state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
  caseId: string,
  finding: {
    readonly caseId: string;
    readonly runId: string;
    readonly evidenceRevision: number;
    readonly targetId: string;
    readonly analyst?: unknown;
    readonly graphFindingId?: string;
    readonly controlId?: string;
    readonly evidenceId?: string;
  },
) {
  return finding.caseId === caseId && finding.runId === state.plan.runId &&
    finding.evidenceRevision <= state.revision &&
    (finding.analyst === undefined ||
      readSentinelFindingReceiptScope(path, state.revision)?.allowsRecord(
          finding,
        ) === true) &&
    sentinelOperatingConstraintsAllow(
      readSentinelOperatingConstraints(path, finding.runId)?.constraints,
      { kind: "review_evidence", nodeId: finding.targetId },
      state.result?.sharedGraph.snapshot,
    );
}

/** Fence a completed context response against changes during root hooks. */
export function currentSentinelFindingContext(
  scope: Scope,
  response: string,
  contextRevision: number | undefined,
) {
  const { finding } = JSON.parse(response);
  const caseId = locateSentinelCase(scope.snapshotPath)?.caseId;
  const state = readSentinelAssessment(scope.snapshotPath);
  return !!caseId && !!state && state.revision === contextRevision &&
    !!finding &&
    allowedFindingContext(scope.snapshotPath, state, caseId, finding) &&
    (!scope.assignedTaskId || !!assignedTask(scope));
}

/** Bind a finding receipt query to the saved and current policy for its run. */
export function readSentinelFindingReceiptScope(
  path: string,
  revision: number,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  if (!runId) return;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const saved = readSentinelOperatingConstraints(path, runId, revision)
    ?.constraints;
  const current = readSentinelOperatingConstraints(path, runId)?.constraints;
  const allows = (
    targetId: string,
    kind: "review_evidence" | "review_finding" | "review_incident" =
      "review_evidence",
  ) => {
    const target = { kind, nodeId: targetId };
    return sentinelOperatingConstraintsAllow(saved, target, snapshot) &&
      sentinelOperatingConstraintsAllow(current, target, snapshot);
  };
  return {
    runId,
    allows,
    allowsRecord: (record: {
      targetId: string;
      analyst?: unknown;
      graphFindingId?: string;
      controlId?: string;
      evidenceId?: string;
    }) => {
      if (!allows(record.targetId)) return false;
      if (record.analyst === undefined) return true;
      const { graphFindingId, controlId, evidenceId } = record;
      return !!graphFindingId && !!evidenceId &&
        allows(graphFindingId, "review_finding") && allows(evidenceId) &&
        !!snapshot?.edges.some(({ from, to, relation }) =>
          from === controlId && to === graphFindingId &&
          relation === "mitigates"
        );
    },
  };
}

/** Build the worker evidence section from visible case/run records only. */
export function readScopedSentinelWorkerFindingReport(
  path: string,
  caseId: string,
  revision: number,
) {
  const scope = readSentinelFindingReceiptScope(path, revision);
  const report = scope && readSentinelWorkerFindingReport(path, revision);
  if (!scope || !report) return null;
  const allows = ({ caseId: recordCase, runId, evidenceRevision, targetId }: {
    caseId: string;
    runId: string;
    evidenceRevision: number;
    targetId: string;
  }) =>
    recordCase === caseId && runId === scope.runId &&
    evidenceRevision <= revision && scope.allows(targetId);
  const findings = report.findings.filter((finding) =>
    allows(finding) && scope.allowsRecord(finding)
  );
  if (!findings.length) return null;
  const visible = new Set(findings.map(({ id }) => id));
  return {
    findings,
    rechecks: report.rechecks.filter((item) =>
      !item.nativeRepositoryVisibility && visible.has(item.findingId) &&
      allows(item) &&
      scope.allows(item.evidenceId)
    ),
    amendments: report.amendments.filter((item) =>
      visible.has(item.findingId) && allows(item)
    ),
    reports: report.reports.filter(({ finding }) => visible.has(finding.id)),
  };
}

/** Check every delivered receipt against the case's current read policy. */
export function currentSentinelFindingReceipts(
  scope: Scope,
  response: string,
  revision: number | undefined,
  requireCurrentRevision = false,
) {
  if (
    revision === undefined ||
    (requireCurrentRevision &&
      readSentinelAssessment(scope.snapshotPath)?.revision !== revision)
  ) return false;
  const { record, records } = JSON.parse(response);
  const caseId = locateSentinelCase(scope.snapshotPath)?.caseId;
  const policy = readSentinelFindingReceiptScope(scope.snapshotPath, revision);
  return !!caseId && !!policy &&
    (!scope.assignedTaskId || !!assignedTask(scope)) &&
    (record ? [record] : records).every((item: {
      caseId: string;
      runId: string;
      evidenceRevision: number;
      targetId: string;
    }) =>
      item.caseId === caseId && item.runId === policy.runId &&
      item.evidenceRevision <= revision && policy.allowsRecord(item)
    );
}

/** Keep historical policy context scoped to the assigned asset. */
function recheckConstraintProjection(
  policy: SentinelOperatingConstraintRecord | undefined,
  assetId: string,
) {
  if (!policy) return null;
  const { allowedAssetIds, deniedKinds } = policy.constraints;
  return {
    digest: policy.digest,
    deniedKinds,
    assetInScope: allowedAssetIds?.includes(assetId) ?? true,
  };
}

/** Compare one authorized saved report with the selected revision's attachments. */
export function readSentinelFindingReportAttachmentReview(
  path: string,
  caseId: string,
  revision: number,
  findingId: string,
  requestedVersion?: number,
) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  if (!runId || !snapshot || !hasSentinelWorkerFindingJournal(path)) return;
  const journal = openSentinelWorkerFindingStore(path);
  try {
    const report = journal.readFindingReport(findingId, revision);
    const finding = report?.finding;
    if (
      !finding || finding.caseId !== caseId || finding.runId !== runId ||
      ("analyst" in finding &&
        !readSentinelFindingReceiptScope(path, revision)?.allowsRecord(
          finding,
        )) ||
      !sentinelOperatingConstraintsAllow(
        readSentinelOperatingConstraints(path, runId)?.constraints,
        { kind: "review_evidence", nodeId: finding.targetId },
        snapshot,
      )
    ) return;
    const reportVersion = requestedVersion ?? report.version;
    const amendment = report.amendments.find(({ version }) =>
      version === reportVersion
    );
    if (reportVersion !== 1 && !amendment) return;
    const currentDigest = sentinelFindingTrafficEvidenceVersion(
      path,
      revision,
      findingId,
      finding.targetId,
    ).digest;
    const reviewedRevision = amendment?.evidenceRevision ??
      finding.evidenceRevision;
    let reviewedDigest = amendment?.evidenceVersion;
    if (!amendment) {
      const staged = readSentinelStagedTrafficFinding(
        path,
        { ...finding, taskId: finding.taskId },
        finding.requestId,
      );
      const attachments = staged?.findingId === finding.id &&
        readStagedTrafficLinks(path, staged);
      if (attachments) {
        reviewedDigest = initialSentinelFindingTrafficEvidenceVersion(
          reviewedRevision,
          findingId,
          attachments.links ?? [attachments.link],
        );
      }
    }
    return {
      reportVersion,
      current: { evidenceRevision: revision, digest: currentDigest },
      reviewed: reviewedDigest
        ? { evidenceRevision: reviewedRevision, digest: reviewedDigest }
        : null,
      status: !reviewedDigest
        ? "unbound"
        : reviewedRevision !== revision
        ? "different_revision"
        : reviewedDigest === currentDigest
        ? "current"
        : "changed",
    };
  } finally {
    journal.close();
  }
}

type Scope = Pick<
  SentinelAgentOptions,
  | "snapshotPath"
  | "assessmentRevision"
  | "assignedTaskId"
  | "assignedTaskLeaseToken"
>;

const exactId = {
  type: "string",
  description: "Exact saved identifier",
  required: true,
};
const summary = {
  type: "string",
  description: "Bounded defensive observation",
  required: true,
};

export const sentinelFindingReadTools: readonly ToolDefinition[] = [
  {
    name: "sentinel_worker_findings",
    description:
      "List saved findings and rechecks, or reopen one exact receipt. After opening your assigned execution receipt, list findings it can recheck.",
    parameters: {
      receiptId: {
        type: "string",
        description: "Exact saved worker finding or recheck ID",
      },
      revision: {
        type: "integer",
        description: "Exact evidence revision for published records",
      },
      limit: { type: "integer", description: "Bounded record count" },
      beforeReceiptId: {
        type: "string",
        description:
          "Use nextBeforeReceiptId from the previous page with the same revision filter",
      },
    },
  },
  {
    name: SENTINEL_RECHECK_CONTEXT_TOOL,
    description:
      "Read a saved worker finding and current admissible verification for the original asset and control.",
    parameters: { findingId: exactId },
  },
];

export const sentinelFindingWriteTools: readonly ToolDefinition[] = [
  {
    name: "sentinel_report_finding",
    description:
      "Record a defensive control gap backed by an exact failed verification on your assigned asset. For a receipt review, reopen its exact execution evidence before reporting the failed check.",
    parameters: {
      graphFindingId: exactId,
      controlId: exactId,
      evidenceId: exactId,
      requestId: exactId,
      title: summary,
      summary,
      severity: {
        type: "string",
        enum: [...sentinelFindingSeverities],
        description: "Optional initial severity of the verified control gap",
      },
      findingCategory: {
        type: "string",
        description: "Optional short defensive finding category",
      },
      trafficRefs: {
        type: "array",
        description:
          "Optional ordered set of two to four already-opened exact {evidenceId,digest,sourceHintId?} traffic receipts. Omit singular traffic fields when using this set.",
        items: { type: "object" },
      },
      trafficEvidenceId: {
        type: "string",
        description:
          "Optional exact retained traffic receipt already opened by this assignment.",
      },
      sourceHintId: {
        type: "number",
        description:
          "Optional exact approved operator traffic hint for the singular receipt.",
      },
      trafficDigest: {
        type: "string",
        description: "Exact digest paired with trafficEvidenceId.",
      },
    },
  },
  {
    name: "sentinel_record_finding_recheck",
    description:
      "Save a distinct remediation check from current retained evidence for a prior worker finding. The verified check determines the outcome.",
    parameters: {
      findingId: exactId,
      evidenceId: exactId,
      requestId: exactId,
      summary,
    },
  },
  {
    name: INCONCLUSIVE_RECHECK_TOOL,
    description:
      "Record a reason why the exact assigned retained-evidence recheck could not establish a verdict. This records no verified finding result.",
    parameters: {
      findingId: exactId,
      evidenceId: exactId,
      requestId: exactId,
      rationale: {
        type: "string",
        description:
          "Concise explanation of what prevented a verified verdict.",
        required: true,
      },
    },
  },
  {
    name: "sentinel_update_finding_report",
    description:
      "Append a new text version to a scoped finding report while retaining the original evidence and prior versions.",
    parameters: {
      findingId: exactId,
      requestId: exactId,
      expectedVersion: {
        type: "integer",
        description: "Current report version from the recheck context",
        required: true,
      },
      evidenceVersion: {
        type: "string",
        description:
          "Exact attachment digest from sentinel_finding_traffic_links. Required when the finding has traffic attachments.",
      },
      title: summary,
      summary,
    },
  },
];

const findTool = (name: string) =>
  [...sentinelFindingReadTools, ...sentinelFindingWriteTools].find((tool) =>
    tool.name === name
  );
export const isSentinelWorkerFindingTool = (name: string) => !!findTool(name);
const unavailable =
  "Error: The requested finding, evidence, or current assignment is unavailable.";
const receiptIdPattern = /^worker-(?:finding|recheck):[a-f0-9]{64}$/;

function assignedTask(scope: Scope) {
  const {
    snapshotPath,
    assessmentRevision,
    assignedTaskId,
    assignedTaskLeaseToken,
  } = scope;
  return assessmentRevision !== undefined && assignedTaskId &&
      assignedTaskLeaseToken
    ? readAssignedSentinelModelReview(
      snapshotPath,
      assessmentRevision,
      assignedTaskId,
      assignedTaskLeaseToken,
    )
    : undefined;
}

function withFindingJournal<T>(
  scope: Scope,
  signal: AbortSignal | undefined,
  write: boolean,
  run: (
    state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
    caseId: string,
    store: ReturnType<typeof openSentinelWorkerFindingStore>,
    target?: string,
  ) => T,
  historicalRevision?: number,
): T | undefined {
  return withSentinelAssessmentWriteLock(scope.snapshotPath, (state) => {
    const caseId = locateSentinelCase(scope.snapshotPath)?.caseId;
    const target = assignedTask(scope)?.nodeId;
    if (
      signal?.aborted || !state?.result?.sharedGraph.snapshot ||
      !caseId || !state.plan.runId ||
      scope.assessmentRevision !== undefined &&
        state.revision !== scope.assessmentRevision &&
        scope.assessmentRevision !== historicalRevision ||
      scope.assignedTaskId !== undefined && !target ||
      write && (!state.active || state.paused || !target ||
          !scope.assignedTaskId || !scope.assignedTaskLeaseToken)
    ) return undefined;
    let journal;
    try {
      if (!write && !hasSentinelWorkerFindingJournal(scope.snapshotPath)) {
        return undefined;
      }
      journal = openSentinelWorkerFindingStore(scope.snapshotPath);
      return run(state, caseId, journal, target);
    } finally {
      journal?.close();
    }
  });
}

function projectResult(value: unknown): string {
  if (value === undefined) return unavailable;
  const result = JSON.stringify(value);
  return result.length <= MAX_SENTINEL_FINDING_RESULT_CHARS
    ? result
    : "Error: The finding result exceeds the tool output limit.";
}

export function executeSentinelWorkerFindingTool(
  scope: Scope,
  name: string,
  args: Record<string, unknown>,
  readEvidence: ReadonlySet<string>,
  signal?: AbortSignal,
  executionReads?: ReadonlyMap<
    string,
    ExecutionControlReceipt
  >,
  allowReadTarget?: (target: string) => boolean,
  trafficReads?: ReadonlyMap<string, { stepIndex: number; sha256: string }>,
  nativeRepositoryVisibility?: SentinelRepositoryVisibilityReference,
): string {
  const tool = findTool(name);
  if (
    !tool ||
    Object.keys(args).some((key) => !Object.hasOwn(tool.parameters, key))
  ) return unavailable;
  try {
    const reporter = assignedTask(scope);
    if (
      reporter?.kind === "report_finding" &&
      ((name === "sentinel_worker_findings"
            ? args.receiptId
            : args.findingId) !== reporter.evidenceIds?.[0] ||
        (name === "sentinel_update_finding_report" &&
          args.evidenceVersion === undefined))
    ) return unavailable;
    if (name === "sentinel_worker_findings") {
      const { receiptId, revision, limit = 5, beforeReceiptId } = args;
      if (
        receiptId !== undefined &&
          (typeof receiptId !== "string" ||
            !receiptIdPattern.test(receiptId) ||
            args.limit !== undefined || beforeReceiptId !== undefined) ||
        beforeReceiptId !== undefined &&
          (typeof beforeReceiptId !== "string" ||
            !receiptIdPattern.test(beforeReceiptId)) ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 10 || revision !== undefined &&
          (typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1)
      ) return unavailable;
      const assignment = assignedTask(scope);
      const direct = assignment?.kind === "review_evidence";
      const selectedFinding = assignment?.plannerRound?.recheckFindingId;
      const historicalRevision = !assignment && !allowReadTarget
        ? (revision as number | undefined) ?? scope.assessmentRevision
        : undefined;
      const report = withFindingJournal(
        scope,
        signal,
        false,
        (state, caseId, store, target) => {
          const selectedRevision = historicalRevision ?? state.revision;
          const policy = readSentinelFindingReceiptScope(
            scope.snapshotPath,
            selectedRevision,
          );
          if (!policy) return;
          const revisionFilter = revision ??
            (historicalRevision !== state.revision
              ? historicalRevision
              : undefined);
          const eligible = (record: ReturnType<typeof store.read>): boolean =>
            !!record && record.caseId === caseId &&
            !(record.kind === "recheck" && record.nativeRepositoryVisibility) &&
            record.runId === policy.runId && policy.allowsRecord(record) &&
            (!allowReadTarget || allowReadTarget(record.targetId)) &&
            record.evidenceRevision <= selectedRevision &&
            (revisionFilter === undefined ||
              record.evidenceRevision === revisionFilter) &&
            (direct && target
              ? record.kind === "finding" &&
                (!selectedFinding || record.id === selectedFinding) &&
                !!receiptRecheckCandidate(
                  scope.snapshotPath,
                  state,
                  record,
                  target,
                  executionReads?.get(target),
                )
              : target === undefined || record.targetId === target);
          if (typeof receiptId === "string") {
            const record = store.read(receiptId);
            return eligible(record)
              ? { _classification: "INTERNAL", record }
              : undefined;
          }
          const retained = store.list(revisionFilter as number | undefined);
          const before = beforeReceiptId === undefined
            ? -1
            : retained.findIndex(({ id }) => id === beforeReceiptId);
          if (
            beforeReceiptId !== undefined &&
            (before === -1 || !eligible(retained[before]))
          ) return;
          const matching: typeof retained = [];
          for (
            let index = before + 1;
            index < retained.length && matching.length <= limit;
            index++
          ) {
            if (eligible(retained[index])) matching.push(retained[index]);
          }
          const records = matching.slice(0, limit);
          const page = () => ({
            _classification: "INTERNAL",
            caseId,
            evidenceRevision: revisionFilter ?? state.revision,
            records,
            nextBeforeReceiptId: records.length < matching.length
              ? records.at(-1)?.id ?? null
              : null,
          });
          while (
            records.length > 1 &&
            JSON.stringify(page()).length > MAX_SENTINEL_FINDING_RESULT_CHARS
          ) {
            records.pop();
          }
          return page();
        },
        historicalRevision,
      );
      return projectResult(
        report ?? (receiptId === undefined && beforeReceiptId === undefined
          ? {
            _classification: "INTERNAL",
            records: [],
            nextBeforeReceiptId: null,
          }
          : undefined),
      );
    }

    const { findingId, graphFindingId, controlId, evidenceId, requestId } =
      args;
    if (name === SENTINEL_RECHECK_CONTEXT_TOOL) {
      if (typeof findingId !== "string") return unavailable;
      return projectResult(
        withFindingJournal(
          scope,
          signal,
          false,
          (state, caseId, store, target) => {
            const finding = store.readFinding(findingId);
            const task = assignedTask(scope);
            const selectedFinding = task?.plannerRound?.recheckFindingId;
            if (selectedFinding && findingId !== selectedFinding) return;
            const direct = target !== undefined &&
              task?.kind === "review_evidence";
            if (
              !finding ||
              !allowedFindingContext(
                scope.snapshotPath,
                state,
                caseId,
                finding,
              ) ||
              (target && !direct && finding.targetId !== target)
            ) return;
            const check = direct
              ? receiptRecheckCandidate(
                scope.snapshotPath,
                state,
                finding,
                target,
                executionReads?.get(target),
              )
              : executionRecheckScope(
                  scope.snapshotPath,
                  finding,
                  "",
                  undefined,
                ) === false
              ? undefined
              : readWorkerFindingRechecks(
                state.result!.sharedGraph.snapshot,
                {
                  caseId,
                  evidenceRevision: state.revision,
                  evaluatedAt: state.result!.controlEvaluationAt ??
                    state.updatedAt,
                },
                {
                  assetId: finding.targetId,
                  findingId: finding.graphFindingId,
                },
              )?.receipts.find((item) => item.controlId === finding.controlId);
            if (direct && !check) return;
            const report = store.readFindingReport(finding.id, state.revision);
            const baseline = task?.plannerRound?.recheckBaseline;
            const reviewedReport = baseline && report &&
              (baseline.reportVersion === 1
                ? report.finding
                : report.amendments.find(({ version }) =>
                  version === baseline.reportVersion
                ));
            if (baseline && !reviewedReport) return;
            const reviewedPolicy = baseline?.constraintsDigest
              ? readSentinelOperatingConstraintDigest(
                scope.snapshotPath,
                finding.runId,
                state.revision,
                baseline.constraintsDigest,
              )
              : undefined;
            if (baseline?.constraintsDigest && !reviewedPolicy) return;
            const currentPolicy = baseline
              ? readSentinelOperatingConstraints(
                scope.snapshotPath,
                finding.runId,
              )
              : undefined;
            const currentAttachmentDigest = baseline &&
              sentinelFindingTrafficEvidenceVersion(
                scope.snapshotPath,
                state.revision,
                finding.id,
                finding.targetId,
              ).digest;
            return {
              _classification: "INTERNAL",
              finding,
              originalOutcome: "fail",
              ...(task?.plannerRound?.findingFollowup
                ?.nativeRepositoryVisibility &&
                task.plannerRound.findingFollowup.findingId === finding.id && {
                nativeRepositoryVisibilityEvidenceId:
                  nativeRepositoryVisibilityEvidenceId(task.id),
              }),
              ...(selectedFinding === finding.id &&
                task?.plannerRound?.recheckNote &&
                { recheckNote: task.plannerRound.recheckNote }),
              ...(baseline && report && reviewedReport
                ? {
                  reportVersion: baseline.reportVersion,
                  recheckBaseline: baseline,
                  attachmentReview: {
                    approvedDigest: baseline.evidenceVersion,
                    currentDigest: currentAttachmentDigest,
                    status: currentAttachmentDigest === baseline.evidenceVersion
                      ? "unchanged"
                      : "changed",
                  },
                  reviewedConstraints: recheckConstraintProjection(
                    reviewedPolicy,
                    finding.targetId,
                  ),
                  currentConstraints: recheckConstraintProjection(
                    currentPolicy,
                    finding.targetId,
                  ),
                  reviewedReport: {
                    title: reviewedReport.title,
                    summary: reviewedReport.summary,
                    ...findingReportMetadata(
                      report.amendments,
                      baseline.reportVersion,
                      report.finding,
                    ),
                  },
                }
                : report && { reportVersion: report.version }),
              current: check ?? null,
              rechecks: store.listFindingRechecks(finding.id, state.revision)
                .filter((item) =>
                  item.caseId === caseId && item.runId === finding.runId &&
                  item.targetId === finding.targetId &&
                  !item.nativeRepositoryVisibility
                ).slice(0, 5),
            };
          },
        ),
      );
    }

    if (name === INCONCLUSIVE_RECHECK_TOOL) {
      const input = inconclusiveRecheckArgs(args);
      if (!input) return unavailable;
      return projectResult(
        withFindingJournal(
          scope,
          signal,
          true,
          (state, caseId, journal, target) => {
            const task = assignedTask(scope);
            const runId = state.plan.runId;
            const snapshot = state.result?.sharedGraph.snapshot;
            if (
              !task || !runId || !snapshot || signal?.aborted ||
              task.kind !== "review_evidence" ||
              task.plannerRound?.recheckFindingId !== input.findingId ||
              task.nodeId !== target || target !== input.evidenceId
            ) return;
            const original = journal.readFinding(input.findingId);
            if (
              !original ||
              executionFindingAsset(snapshot, input.evidenceId) !==
                original.targetId ||
              !snapshot.edges.some(({ from, to, relation }) =>
                from === input.evidenceId && to === original.controlId &&
                relation === "verifies"
              )
            ) return;
            const record = journal.recordInconclusive({
              ...input,
              caseId,
              runId,
              taskId: task.id,
              targetId: original.targetId,
              evidenceRevision: state.revision,
              snapshotDigest: digestSentinelSnapshot(snapshot),
            });
            return record && { _classification: "INTERNAL", record };
          },
        ),
      );
    }

    if (name === "sentinel_update_finding_report") {
      const { expectedVersion, evidenceVersion, title, summary } = args;
      if (
        typeof findingId !== "string" || typeof requestId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId) ||
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        (evidenceVersion !== undefined &&
          (typeof evidenceVersion !== "string" ||
            !/^[a-f0-9]{64}$/.test(evidenceVersion))) ||
        typeof title !== "string" || typeof summary !== "string"
      ) return unavailable;
      return projectResult(withFindingJournal(
        scope,
        signal,
        true,
        (state, caseId, store, target) => {
          if (
            !target || !scope.assignedTaskId || !state.plan.runId ||
            signal?.aborted || assignedTask(scope)?.nodeId !== target
          ) return;
          const amendment = store.updateFindingReport({
            caseId,
            runId: state.plan.runId,
            targetId: target,
            evidenceRevision: state.revision,
            taskId: scope.assignedTaskId,
            requestId: requestId.toLowerCase(),
            findingId,
            expectedVersion,
            evidenceVersion,
            title,
            summary,
          }, () => {
            const current = sentinelFindingTrafficEvidenceVersion(
              scope.snapshotPath,
              state.revision,
              findingId,
              target,
            );
            if (
              reporter?.kind === "report_finding" &&
              store.readFindingReport(findingId, state.revision)?.amendments
                .some(({ taskId }) => taskId === scope.assignedTaskId)
            ) return false;
            return evidenceVersion === undefined
              ? current.count === 0
              : evidenceVersion === current.digest;
          });
          return amendment && { _classification: "INTERNAL", amendment };
        },
      ));
    }

    if (
      typeof evidenceId !== "string" ||
      !(readEvidence.has(evidenceId) || executionReads?.has(evidenceId) ||
        (name === "sentinel_record_finding_recheck" &&
          nativeRepositoryVisibility)) ||
      typeof requestId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId) ||
      typeof args.summary !== "string"
    ) {
      return "Error: Read the exact linked evidence for this assignment before recording it.";
    }
    const summary = args.summary;
    return projectResult(
      withFindingJournal(
        scope,
        signal,
        true,
        (state, caseId, store, target) => {
          if (!target || !scope.assignedTaskId || !state.plan.runId) return;
          const initial = name === "sentinel_report_finding";
          const task = assignedTask(scope);
          const selectedFinding = task?.plannerRound?.recheckFindingId;
          if (selectedFinding && (initial || findingId !== selectedFinding)) {
            return;
          }
          const snapshot = state.result!.sharedGraph.snapshot!;
          const direct = task?.kind === "review_evidence";
          const asset = direct
            ? evidenceId === target && executionReads?.has(evidenceId)
              ? executionFindingAsset(snapshot, evidenceId)
              : undefined
            : target;
          if (!asset) return;
          const previous = !initial && typeof findingId === "string"
            ? store.readFinding(findingId)
            : undefined;
          const graphId = initial ? graphFindingId : previous?.graphFindingId;
          const control = initial ? controlId : previous?.controlId;
          const title = args.title;
          const classification = initial ? initialFindingMetadata(args) : {};
          if (
            !classification || typeof graphId !== "string" ||
            typeof control !== "string" ||
            initial && typeof title !== "string" || !initial &&
              (!previous || previous.caseId !== caseId ||
                previous.runId !== state.plan.runId ||
                previous.targetId !== asset)
          ) return;
          const boundary = previous && executionRecheckScope(
            scope.snapshotPath,
            previous,
            evidenceId,
            executionReads?.get(evidenceId),
          );
          if (boundary === false && !nativeRepositoryVisibility) return;
          const outcome = nativeRepositoryVisibility
            ? previous && task && verifySentinelNativeRepositoryRecheck(
              scope.snapshotPath,
              state,
              task,
              previous,
              evidenceId,
              nativeRepositoryVisibility,
            )
            : verifyWorkerFindingRecheck(
              snapshot,
              {
                caseId,
                evidenceRevision: state.revision,
                evaluatedAt: state.result!.controlEvaluationAt ??
                  state.updatedAt,
              },
              {
                assetId: asset,
                findingId: graphId,
                controlId: control,
                evidenceId,
              },
              boundary === false ? undefined : boundary,
            );
          const evidence = snapshot.nodes.find(({ id }) => id === evidenceId);
          if (
            !outcome || initial && outcome.outcome !== "fail" ||
            (!initial && !boundary && evidence?.kind === "evidence" &&
              evidence.nativeWorkflowSource) ||
            (direct ||
                evidence?.kind === "evidence" &&
                  evidence.nativeWorkflowSource) &&
              !executionReceiptSupportsCheck(
                evidence,
                state.plan.runId,
                asset,
                control,
                outcome.outcome,
                executionReads?.get(evidenceId),
              ) ||
            (direct || boundary) && previous &&
              (previous.evidenceId === evidenceId ||
                outcome.observedAt <= previous.observedAt) ||
            signal?.aborted || assignedTask(scope)?.nodeId !== target
          ) return;
          const receipt = {
            caseId,
            runId: state.plan.runId,
            evidenceRevision: state.revision,
            taskId: scope.assignedTaskId,
            targetId: asset,
            graphFindingId: graphId,
            controlId: control,
            evidenceId,
            snapshotDigest: outcome.snapshotDigest,
            observedAt: outcome.observedAt,
            validUntil: outcome.validUntil,
            evaluatedAt: outcome.evaluatedAt,
            requestId: requestId.toLowerCase(),
            summary,
          };
          const notify = ({ id }: { id: string }) => {
            notifyCommittedEvidence({
              case: caseId,
              run_id: receipt.runId,
              revision: receipt.evidenceRevision,
              observation_id: id,
            });
          };
          if (
            initial && typeof title === "string" &&
            (args.trafficEvidenceId !== undefined ||
              args.trafficDigest !== undefined ||
              args.trafficRefs !== undefined || args.sourceHintId !== undefined)
          ) {
            const selected = parseSentinelInitialTrafficSelection(args);
            if (!selected) return;
            const attachments = [];
            for (
              const {
                evidenceId: trafficEvidenceId,
                digest: trafficDigest,
                sourceHintId,
              } of selected.refs
            ) {
              const traffic = readSentinelTrafficReceipt(
                scope.snapshotPath,
                state.revision,
                {
                  evidenceId: trafficEvidenceId,
                  digest: trafficDigest,
                },
                asset,
              );
              const step = traffic &&
                trafficReads?.get(sentinelTrafficAttachmentKey(
                  caseId,
                  state.revision,
                  asset,
                  trafficEvidenceId,
                  trafficDigest,
                  traffic.family,
                ));
              if (!traffic || !step) return;
              const hint = sourceHintId === undefined
                ? undefined
                : readSentinelOperatorTrafficHint(
                  scope.snapshotPath,
                  state,
                  sourceHintId,
                  asset,
                  { evidenceId: trafficEvidenceId, digest: trafficDigest },
                );
              if (
                sourceHintId !== undefined &&
                (hint?.evidenceId !== trafficEvidenceId ||
                  hint.digest !== trafficDigest)
              ) return;
              attachments.push({
                traffic,
                step,
                staged: {
                  evidenceId: trafficEvidenceId,
                  digest: trafficDigest,
                  ...(sourceHintId !== undefined && { sourceHintId }),
                  stepIndex: step.stepIndex,
                  resultSha256: step.sha256,
                },
              });
            }
            if (
              JSON.stringify([
                    { ...receipt, title, ...classification },
                    ...attachments.map(({ staged }) => ({
                      caseId,
                      asset,
                      id: staged.evidenceId,
                    })),
                  ]).length + 800 + 500 * attachments.length >
                MAX_SENTINEL_FINDING_RESULT_CHARS
            ) return;
            const stagedItems = attachments.map(({ staged }) => staged);
            const staged = store.stageTrafficFinding(
              { ...receipt, title, ...classification },
              selected.batch ? stagedItems : stagedItems[0],
            );
            if (!staged) return;
            const inputs: SentinelFindingTrafficLinkInput[] = attachments.map((
              { traffic, step, staged: source },
              index,
            ) => ({
              caseId,
              evidenceRevision: state.revision,
              assetId: asset,
              findingId: staged.findingId,
              reportVersion: 1,
              trafficId: traffic.evidenceId,
              trafficDigest: traffic.digest,
              trafficSource: traffic.family,
              authority: { kind: "assignment", taskId: receipt.taskId },
              sourceStep: step,
              ...(source.sourceHintId !== undefined &&
                {
                  sourceHint: { id: source.sourceHintId, runId: receipt.runId },
                }),
              requestId: selected.batch
                ? sentinelTrafficBatchMemberRequestId(receipt.requestId, index)
                : receipt.requestId,
            }));
            const current = () =>
              !signal?.aborted && assignedTask(scope)?.id === receipt.taskId;
            const links = openSentinelFindingTrafficLinks(scope.snapshotPath);
            try {
              const attached = selected.batch
                ? links.recordBatch(
                  receipt.requestId,
                  receipt.runId,
                  inputs,
                  current,
                  true,
                )
                : links.recordStagedPublication(inputs[0], current);
              if (!attached) return;
            } finally {
              links.close();
            }
            if (!current()) return;
            const saved = store.publishTrafficFinding(
              receipt.requestId,
              notify,
            );
            return saved && { _classification: "INTERNAL", ...saved };
          }
          const record = initial && typeof title === "string"
            ? store.recordFinding(
              { ...receipt, title, ...classification },
              notify,
            )
            : previous && store.recordRecheck({
              ...receipt,
              findingId: previous.id,
              outcome: outcome.outcome,
              ...(nativeRepositoryVisibility && { nativeRepositoryVisibility }),
            }, (recheck) => {
              if (
                task?.plannerRound?.recheckFindingId ||
                nativeRepositoryVisibility
              ) return;
              notify(recheck);
              if (recheck.outcome === "pass") notify({ id: recheck.findingId });
            });
          return record && { _classification: "INTERNAL", record };
        },
      ),
    );
  } catch {
    return unavailable;
  }
}

/** Reopen exact planner records by their originally returned IDs. */
export function reopenSentinelPlannerFindings(
  path: string,
  scope: { caseId: string; runId: string; evidenceRevision: number },
  selector: { receiptId?: string; revision?: number; beforeReceiptId?: string },
  allowTarget: (id: string) => boolean,
  page?: NonNullable<ReturnType<typeof readSentinelFindingPageReference>>,
) {
  const { caseId, runId, evidenceRevision } = scope;
  const revision = selector.revision ?? evidenceRevision;
  if (revision > evidenceRevision) return;
  const envelope = { _classification: "INTERNAL" };
  if (page?.empty) {
    return JSON.stringify({
      ...envelope,
      records: [],
      nextBeforeReceiptId: null,
    });
  }
  const ids = selector.receiptId ? [selector.receiptId] : [
    ...(selector.beforeReceiptId ? [selector.beforeReceiptId] : []),
    ...(page?.ids ?? []),
  ];
  const retained = readSentinelCaseFindingReceipts(path, ids);
  const read = (id: string) => {
    const record = retained.get(id);
    if (
      !record || record.caseId !== caseId || record.runId !== runId ||
      record.evidenceRevision > evidenceRevision ||
      (selector.revision !== undefined &&
        record.evidenceRevision !== revision) ||
      !allowTarget(record.targetId)
    ) return;
    return record;
  };
  if (selector.receiptId) {
    const record = read(selector.receiptId);
    return record && JSON.stringify({ ...envelope, record });
  }
  if (
    !page || (selector.beforeReceiptId && !read(selector.beforeReceiptId))
  ) return;
  const records = page.ids.map(read);
  if (records.some((record) => !record)) return;
  return JSON.stringify({
    ...envelope,
    caseId,
    evidenceRevision: revision,
    records,
    nextBeforeReceiptId: page.nextBeforeReceiptId,
  });
}

type FindingActorDraft = {
  readonly operatorScope: "owner";
  readonly planner?: Omit<
    NonNullable<SentinelAnalystFindingInput["analyst"]["planner"]>,
    "approvalId"
  >;
};

function sentinelLocalFindingAdmission<Actor extends FindingActorDraft>(
  path: string,
  revision: number,
  args: Record<string, unknown>,
  isCurrent: () => boolean,
  analyst: Actor,
) {
  const {
    runId,
    targetId,
    graphFindingId,
    controlId,
    evidenceId,
    requestId,
    title,
    summary,
  } = args;
  const classification = initialFindingMetadata(args);
  const caseId = locateSentinelCase(path)?.caseId;
  const text = (value: unknown, limit: number): value is string =>
    typeof value === "string" && !!value.trim() && value.length <= limit &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && redactCredentialText(value) === value;
  if (
    !caseId || !classification || typeof runId !== "string" ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId) ||
    !text(targetId, 4096) || !text(graphFindingId, 4096) ||
    !text(controlId, 4096) || !text(evidenceId, 4096) ||
    !text(title, 256) || !text(summary, 4096)
  ) return;
  const sources = [
    `asset:${targetId}`,
    `finding:${graphFindingId}`,
    `control:${controlId}`,
    `evidence:${evidenceId}`,
  ];
  const inspect = (state: ReturnType<typeof readSentinelAssessment>) => {
    const snapshot = state?.result?.sharedGraph.snapshot;
    if (
      !isCurrent() || !state?.active || state.paused ||
      state.plan.runId !== runId ||
      state.revision !== revision || !snapshot
    ) return;
    const evidence = snapshot.nodes.find(({ id }) => id === evidenceId);
    if (
      evidence?.kind !== "evidence" || evidence.executionSource ||
      evidence.nativeWorkflowSource || evidence.relationshipSources?.length
    ) return;
    const policy = readSentinelFindingReceiptScope(path, revision);
    if (
      !policy?.allowsRecord({
        analyst: true,
        targetId,
        graphFindingId,
        controlId,
        evidenceId,
      })
    ) return;
    const proof = verifyWorkerFindingRecheck(snapshot, {
      caseId,
      evidenceRevision: revision,
      evaluatedAt: state.result?.controlEvaluationAt ?? state.updatedAt,
    }, { assetId: targetId, findingId: graphFindingId, controlId, evidenceId });
    if (proof?.outcome !== "fail") return;
    return {
      caseId,
      runId,
      evidenceRevision: revision,
      targetId,
      graphFindingId,
      controlId,
      evidenceId,
      requestId: requestId.toLowerCase(),
      ...classification,
      title: title.trim(),
      summary: summary.trim(),
      snapshotDigest: proof.snapshotDigest,
      observedAt: proof.observedAt,
      validUntil: proof.validUntil,
      evaluatedAt: proof.evaluatedAt,
      analyst,
    };
  };
  return { sources, inspect, caseId, runId };
}

export function readSentinelPlannerFindingDraft(
  path: string,
  revision: number,
  args: Record<string, unknown>,
  isCurrent: () => boolean,
  planner: NonNullable<FindingActorDraft["planner"]>,
) {
  const admission = sentinelLocalFindingAdmission(
    path,
    revision,
    args,
    isCurrent,
    { operatorScope: "owner", planner },
  );
  return admission?.inspect(readSentinelAssessment(path));
}

/** Record a reviewed defensive finding without inventing a worker assignment. */
export async function recordOperatorSentinelFinding(
  path: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
  authorize: (
    sources: readonly string[],
    projection: string,
  ) => Promise<boolean>,
  isCurrent: () => boolean,
  analyst: SentinelAnalystFindingInput["analyst"] = { operatorScope: "owner" },
): Promise<string> {
  const admission = sentinelLocalFindingAdmission(
    path,
    revision,
    args,
    isCurrent,
    analyst,
  );
  if (!admission) return unavailable;
  const { sources, inspect, caseId, runId } = admission;
  const draft = inspect(readSentinelAssessment(path));
  if (!draft || !await authorize(sources, projectResult(draft))) {
    return unavailable;
  }
  const lookup = () =>
    readSentinelWorkerFindingWriteReceipt(
      path,
      { ...draft, taskId: undefined },
      draft.requestId,
    );
  const same = (receipt: ReturnType<typeof lookup>) => {
    if (receipt?.kind !== "finding" || !("analyst" in receipt)) return false;
    const { kind: _kind, id: _id, recordedAt: _at, ...input } = receipt;
    return isDeepStrictEqual(input, draft);
  };
  const prior = lookup();
  if (!isDeepStrictEqual(inspect(readSentinelAssessment(path)), draft)) {
    return unavailable;
  }
  if (prior) return same(prior) ? projectResult(prior) : unavailable;
  if (
    !await confirm(
      `Record this exact retained Sentinel control gap?\n${
        projectResult(draft)
      }`,
    )
  ) {
    return unavailable;
  }
  if (!await authorize(sources, projectResult(draft))) return unavailable;
  return withSentinelAssessmentWriteLock(path, (state) => {
    if (!isDeepStrictEqual(inspect(state), draft)) return unavailable;
    const duplicate = lookup();
    if (duplicate) {
      return same(duplicate) ? projectResult(duplicate) : unavailable;
    }
    const journal = openSentinelWorkerFindingStore(path);
    try {
      return projectResult(
        journal.recordAnalystFinding(
          draft,
          ({ id }) =>
            notifyCommittedEvidence({
              case: caseId,
              run_id: runId,
              revision,
              observation_id: id,
            }),
        ),
      );
    } finally {
      journal.close();
    }
  }) ?? unavailable;
}

/** Confirm an exact owner amendment, then recheck its report and evidence under the case lock. */
export async function amendOperatorSentinelFindingReport(
  path: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
): Promise<string> {
  const {
    receiptId,
    reportVersion,
    evidenceVersion,
    title,
    summary,
    severity,
    findingCategory,
    disposition,
    requestId,
  } = args;
  const rating = sentinelFindingSeverities.find((value) => value === severity);
  const category = normalizeFindingReportCategory(findingCategory);
  const decision = sentinelFindingDispositions.find((value) =>
    value === disposition
  );
  const caseId = locateSentinelCase(path)?.caseId;
  if (
    !caseId || typeof receiptId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
    typeof reportVersion !== "number" || !Number.isSafeInteger(reportVersion) ||
    reportVersion < 1 || typeof evidenceVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidenceVersion) ||
    (severity !== undefined && rating === undefined) ||
    (findingCategory !== undefined && category === undefined) ||
    (disposition !== undefined && decision === undefined) ||
    (rating === undefined && category === undefined && decision === undefined &&
      (title === undefined || summary === undefined)) ||
    (title !== undefined &&
      (typeof title !== "string" || !title.trim() || title.length > 256 ||
        title.includes("\0"))) ||
    (summary !== undefined &&
      (typeof summary !== "string" || !summary.trim() ||
        summary.length > 4096 || summary.includes("\0"))) ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)
  ) return unavailable;
  const inspect = (approvedRunId?: string) =>
    withSentinelAssessmentWriteLock(path, (state) => {
      const runId = state?.plan.runId;
      if (
        !runId || state.revision !== revision ||
        (approvedRunId !== undefined && runId !== approvedRunId) ||
        !hasSentinelWorkerFindingJournal(path)
      ) return;
      const journal = openSentinelWorkerFindingStore(path);
      try {
        const report = journal.readFindingReport(receiptId, revision);
        const finding = report?.finding;
        if (!finding || finding.caseId !== caseId || finding.runId !== runId) {
          return;
        }
        if (
          rating !== undefined || category !== undefined ||
          decision !== undefined
        ) {
          const policy = readSentinelOperatingConstraints(
            path,
            runId,
            revision,
          );
          if (
            policy?.constraints.allowedAssetIds?.includes(finding.targetId) ===
              false ||
            !state.result?.sharedGraph.snapshot?.nodes.some(({ id, kind }) =>
              kind === "asset" && id === finding.targetId
            )
          ) return;
        }
        const input = {
          caseId,
          runId,
          evidenceRevision: revision,
          taskId: "operator",
          targetId: finding.targetId,
          requestId: requestId.toLowerCase(),
          findingId: receiptId,
          expectedVersion: reportVersion,
          evidenceVersion,
          ...(rating !== undefined && { severity: rating }),
          ...(category !== undefined && { findingCategory: category }),
          ...(decision !== undefined && { disposition: decision }),
          title: typeof title === "string" ? title : report.title,
          summary: typeof summary === "string" ? summary : report.summary,
        };
        const receipt = readSentinelWorkerFindingWriteReceipt(
          path,
          input,
          input.requestId,
        );
        if (receipt) {
          if (
            receipt.kind === "report_amendment" &&
            receipt.findingId === receiptId &&
            receipt.expectedVersion === reportVersion &&
            receipt.evidenceVersion === evidenceVersion &&
            receipt.severity === rating &&
            receipt.findingCategory === category &&
            receipt.disposition === decision &&
            (title === undefined || receipt.title === title) &&
            (summary === undefined || receipt.summary === summary)
          ) return { runId, amendment: receipt };
          return;
        }
        const evidenceIsCurrent = () =>
          sentinelFindingTrafficEvidenceVersion(path, revision, receiptId)
            .digest === evidenceVersion;
        if (
          !state.active || report.version !== reportVersion ||
          !evidenceIsCurrent()
        ) {
          return;
        }
        return {
          runId,
          priorSeverity: report.severity,
          priorCategory: report.findingCategory,
          priorDisposition: report.disposition,
          amendment: approvedRunId === undefined
            ? undefined
            : journal.updateFindingReport(input, evidenceIsCurrent),
        };
      } finally {
        journal.close();
      }
    });
  try {
    const preview = inspect();
    if (!preview) return unavailable;
    if (preview.amendment) {
      return projectResult({
        _classification: "INTERNAL",
        amendment: preview.amendment,
      });
    }
    if (
      !await confirm(
        `Amend Sentinel finding ${receiptId} in case ${caseId}, revision ${revision}, report version ${reportVersion}, with attachment digest ${evidenceVersion}?${
          rating !== undefined
            ? `\nSeverity: ${preview.priorSeverity ?? "unrated"} → ${rating}`
            : ""
        }${
          category !== undefined
            ? `\nFinding category: ${
              preview.priorCategory === undefined
                ? "(none)"
                : JSON.stringify(preview.priorCategory)
            } → ${category ? JSON.stringify(category) : "(clear)"}`
            : ""
        }${
          decision !== undefined
            ? `\nAnalyst disposition: ${
              preview.priorDisposition ?? "unreviewed"
            } → ${decision}`
            : ""
        }${typeof title === "string" ? `\nTitle: ${title}` : ""}${
          typeof summary === "string" ? `\nSummary: ${summary}` : ""
        }`,
      )
    ) return "Error: The operator declined the report amendment.";
    const amendment = inspect(preview.runId)?.amendment;
    return projectResult(
      amendment && { _classification: "INTERNAL", amendment },
    );
  } catch {
    return unavailable;
  }
}
