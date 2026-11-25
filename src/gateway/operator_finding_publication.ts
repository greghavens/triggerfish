/** Explicit operator approval for sharing a verified local worker finding. */
import { isDeepStrictEqual } from "node:util";
import { redactCredentialText } from "../core/logger/redactor.ts";
import type { ExecutionTraceApprovedPayload } from "../core/execution_traces.ts";
import {
  executionControlReceipt,
  executionReceiptSupportsCheck,
} from "./sentinel_execution_rechecks.ts";
import {
  readSentinelOperatingConstraints,
  withSentinelAssessmentWriteLock,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import { sentinelFindingTrafficEvidenceVersion } from "../sentinel/finding_traffic_links.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { verifyWorkerFindingRecheck } from "../sentinel/worker_finding_evidence.ts";
import {
  readSentinelWorkerFindingPublications,
  type SentinelWorkerFindingPublication,
  writeSentinelWorkerFindingPublications,
} from "../sentinel/worker_finding_publications.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
} from "../sentinel/worker_finding_store.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const unavailable =
  "Error: The exact verified finding publication is unavailable.";

export async function executeOperatorFindingPublication(
  baseDir: string,
  caseId: string,
  revision: number,
  args: Record<string, unknown>,
  confirm: (prompt: string) => Promise<boolean>,
  reopenSource?: (
    node: string,
    isCurrent: () => boolean,
  ) => Promise<{ payload: ExecutionTraceApprovedPayload } | undefined>,
): Promise<Record<string, unknown> | string> {
  const { action, receiptId, requestId, reportVersion, evidenceVersion } = args;
  const preview = action === "preview_finding_publication";
  const withdraw = action === "withdraw_published_finding";
  if (
    typeof receiptId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
    (!preview && (typeof requestId !== "string" || !uuid.test(requestId))) ||
    (!preview && !withdraw && (typeof reportVersion !== "number" ||
      !Number.isSafeInteger(reportVersion) || reportVersion < 1 ||
      typeof evidenceVersion !== "string" || !digest.test(evidenceVersion))) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "kind",
        "id",
        "revision",
        "receiptId",
        ...(!preview ? ["requestId"] : []),
        ...(!preview && !withdraw ? ["reportVersion", "evidenceVersion"] : []),
      ].includes(key)
    )
  ) return unavailable;
  const request = typeof requestId === "string"
    ? requestId.toLowerCase()
    : undefined;
  const path = resolveSentinelCasePath(baseDir, caseId);

  function inspect(approved?: {
    readonly runId: string;
    readonly record: Omit<
      SentinelWorkerFindingPublication,
      "approvedAt" | "requestId"
    >;
  }) {
    return withSentinelAssessmentWriteLock(path, (state) => {
      const rows = readSentinelWorkerFindingPublications(path, caseId);
      const existing = rows.find(({ finding }) => finding.id === receiptId);
      const replay = request &&
        rows.find((entry) =>
          entry.requestId === request || entry.withdrawal?.requestId === request
        );
      if (replay) {
        const same = replay === existing &&
          (withdraw
            ? replay.withdrawal?.requestId === request &&
              replay.withdrawal?.revision === revision
            : replay.requestId === request &&
              replay.finding.workerFindingSource?.revision === revision &&
              replay.finding.workerFindingSource?.reportVersion ===
                reportVersion &&
              replay.evidenceVersion === evidenceVersion);
        return same
          ? { publication: replay, replay: true as const }
          : undefined;
      }

      const runId = state?.plan.runId;
      const snapshot = state?.result?.sharedGraph.snapshot;
      if (
        !runId || state?.revision !== revision || !snapshot ||
        (approved && approved.runId !== runId)
      ) return;
      if (withdraw) {
        if (!existing || existing.withdrawal || !request) return;
        const { approvedAt: _approvedAt, requestId: _requestId, ...record } =
          existing;
        if (!approved) return { record, runId };
        if (!isDeepStrictEqual(record, approved.record)) return;
        const publication = {
          ...existing,
          withdrawal: {
            requestId: request,
            at: new Date().toISOString(),
            revision,
            runId,
          },
        };
        writeSentinelWorkerFindingPublications(
          path,
          caseId,
          rows.map((entry) => entry === existing ? publication : entry),
        );
        return { publication };
      }
      if (existing) return preview ? { publication: existing } : undefined;
      if (!hasSentinelWorkerFindingJournal(path)) return;

      const journal = openSentinelWorkerFindingStore(path);
      try {
        const report = journal.readFindingReport(receiptId as string, revision);
        const finding = report?.finding;
        if (
          !finding || finding.caseId !== caseId || finding.runId !== runId ||
          finding.evidenceRevision !== revision
        ) return;
        const original = snapshot.nodes.find(({ id }) =>
          id === finding.graphFindingId
        );
        const evidence = snapshot.nodes.find(({ id }) =>
          id === finding.evidenceId
        );
        if (
          original?.kind !== "finding" || evidence?.kind !== "evidence" ||
          evidence.nativeWorkflowSource
        ) return;
        const proof = verifyWorkerFindingRecheck(snapshot, {
          caseId,
          evidenceRevision: revision,
          evaluatedAt: finding.evaluatedAt,
        }, {
          findingId: finding.graphFindingId,
          assetId: finding.targetId,
          evidenceId: finding.evidenceId,
          controlId: finding.controlId,
        });
        const verifiedVersion =
          sentinelFindingTrafficEvidenceVersion(path, revision, finding.id)
            .digest;
        if (
          !proof || proof.outcome !== "fail" ||
          proof.snapshotDigest !== finding.snapshotDigest ||
          proof.observedAt !== finding.observedAt ||
          proof.validUntil !== finding.validUntil ||
          (!preview &&
            (report.version !== reportVersion ||
              verifiedVersion !== evidenceVersion))
        ) return;
        const policy = readSentinelOperatingConstraints(path, runId);
        if (
          !sentinelOperatingConstraintsAllow(policy?.constraints, {
            kind: "review_evidence",
            nodeId: finding.targetId,
          }, snapshot)
        ) return;
        const execution = evidence.executionSource && {
          node: evidence,
          asset: finding.targetId,
          control: finding.controlId,
        };
        const record = {
          targetId: finding.targetId,
          finding: {
            kind: "finding" as const,
            id: finding.id,
            label: execution
              ? "Repository visibility control failed"
              : redactCredentialText(report.title).slice(0, 256),
            severity: original.severity,
            workerFindingSource: {
              caseId,
              runId,
              revision,
              taskId: finding.taskId,
              receiptId: finding.id,
              evidenceId: finding.evidenceId,
              snapshotDigest: finding.snapshotDigest,
              reportVersion: report.version,
            },
          },
          evidence: {
            kind: "evidence" as const,
            id: `published-finding-evidence:${
              finding.id.slice("worker-finding:".length)
            }`,
            label: execution
              ? "Retained repository visibility verification"
              : redactCredentialText(evidence.label).slice(0, 512),
          },
          evidenceVersion: verifiedVersion,
          policyVersion: policy?.version ?? 0,
          policyDigest: policy?.digest ?? null,
        };
        if (!approved) return { record, runId, execution };
        if (!request || !isDeepStrictEqual(record, approved.record)) return;
        const publication = {
          ...record,
          requestId: request,
          approvedAt: new Date().toISOString(),
        };
        writeSentinelWorkerFindingPublications(path, caseId, [
          ...rows,
          publication,
        ]);
        return { publication };
      } finally {
        journal.close();
      }
    });
  }

  try {
    const candidate = inspect();
    if (!candidate) return unavailable;
    if (candidate.publication) return { publication: candidate.publication };
    if (!candidate.record || !candidate.runId) return unavailable;
    const { execution, record, runId } = candidate;
    const authorized = async () => {
      if (!execution) return true;
      const isCurrent = () => {
        const current = inspect();
        return current?.runId === runId &&
          isDeepStrictEqual(current.record, record) &&
          isDeepStrictEqual(current.execution, execution);
      };
      const saved = await reopenSource?.(execution.node.id, isCurrent);
      return saved?.payload.kind === "github_repository_status" &&
        isCurrent() &&
        executionReceiptSupportsCheck(
          execution.node,
          runId,
          execution.asset,
          execution.control,
          "fail",
          executionControlReceipt(saved.payload),
        );
    };
    if (!await authorized()) return unavailable;
    if (preview) return { preview: record };
    if (
      !await confirm(
        `${
          withdraw ? "Withdraw" : "Publish"
        } this exact verified Sentinel finding?\n${
          JSON.stringify(candidate.record)
        }`,
      )
    ) {
      return "Error: The operator declined the run action.";
    }
    if (execution && !await authorized()) return unavailable;
    const committed = inspect({ runId, record });
    return committed?.publication
      ? { publication: committed.publication }
      : unavailable;
  } catch {
    return unavailable;
  }
}
