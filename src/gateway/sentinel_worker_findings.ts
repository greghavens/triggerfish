import { notifyCommittedEvidence } from "../core/evidence_task_progression.ts";
import { sentinelFindingTrafficEvidenceVersion } from "../sentinel/finding_traffic_links.ts";
import { readSentinelFindingPageReference } from "../sentinel/worker_goal_recovery.ts";
import {
  type ExecutionControlReceipt,
  executionReceiptSupportsCheck,
  executionRecheckScope,
  receiptRecheckCandidate,
} from "./sentinel_execution_rechecks.ts";
import { MAX_SENTINEL_FINDING_RESULT_CHARS } from "../sentinel/worker_finding_recovery.ts";
/** Exact case/lease gate for worker findings and retained remediation evidence. */
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  readSentinelAssessment,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import { sentinelFindingSeverities } from "../sentinel/graph.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import {
  executionFindingAsset,
  readWorkerFindingRechecks,
  verifyWorkerFindingRecheck,
} from "../sentinel/worker_finding_evidence.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingWriteReceipt,
} from "../sentinel/worker_finding_store.ts";
import { readAssignedSentinelModelReview } from "./sentinel_adaptive_runtime.ts";
import type { SentinelAgentOptions } from "./sentinel_agent.ts";

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
    name: "sentinel_finding_recheck_context",
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
          const runId = historicalRevision !== undefined &&
              historicalRevision !== state.revision
            ? readSentinelRunIdForRevision(
              scope.snapshotPath,
              historicalRevision,
            )
            : state.plan.runId;
          if (!runId) return;
          const selectedRevision = historicalRevision ?? state.revision;
          const revisionFilter = revision ??
            (historicalRevision !== state.revision
              ? historicalRevision
              : undefined);
          const eligible = (record: ReturnType<typeof store.read>): boolean =>
            !!record && record.caseId === caseId &&
            record.runId === runId &&
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
    if (name === "sentinel_finding_recheck_context") {
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
              !finding || finding.caseId !== caseId ||
              target && (finding.runId !== state.plan.runId ||
                  !direct && finding.targetId !== target)
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
            return {
              _classification: "INTERNAL",
              finding,
              originalOutcome: "fail",
              ...(report && { reportVersion: report.version }),
              current: check ?? null,
              rechecks: store.list().filter((item) =>
                item.kind === "recheck" && item.findingId === finding.id
              ).slice(0, 5),
            };
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
      !(readEvidence.has(evidenceId) || executionReads?.has(evidenceId)) ||
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
          if (
            typeof graphId !== "string" || typeof control !== "string" ||
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
          if (boundary === false) return;
          const outcome = verifyWorkerFindingRecheck(
            snapshot,
            {
              caseId,
              evidenceRevision: state.revision,
              evaluatedAt: state.result!.controlEvaluationAt ?? state.updatedAt,
            },
            {
              assetId: asset,
              findingId: graphId,
              controlId: control,
              evidenceId,
            },
            boundary,
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
          const record = initial && typeof title === "string"
            ? store.recordFinding({ ...receipt, title }, notify)
            : previous && store.recordRecheck({
              ...receipt,
              findingId: previous.id,
              outcome: outcome.outcome,
            }, (recheck) => {
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
    requestId,
  } = args;
  const rating = sentinelFindingSeverities.find((value) => value === severity);
  const caseId = locateSentinelCase(path)?.caseId;
  if (
    !caseId || typeof receiptId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
    typeof reportVersion !== "number" || !Number.isSafeInteger(reportVersion) ||
    reportVersion < 1 || typeof evidenceVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidenceVersion) ||
    (severity !== undefined && rating === undefined) ||
    (rating === undefined && (title === undefined || summary === undefined)) ||
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
        if (rating !== undefined) {
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
