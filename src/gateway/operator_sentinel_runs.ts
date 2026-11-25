/** Exact Sentinel case adapter for authenticated operator run control. */
import type {
  OperatorRunMutationContext,
  OperatorRunProvider,
  OperatorRunRef,
  OperatorRunSummary,
} from "../core/operator_runs.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelCaseStatus,
  resumeSentinelAssessment,
  startSentinelAssessment,
} from "../sentinel/assessment_store.ts";
import { readSentinelWorkerFindingReport } from "../sentinel/worker_finding_store.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  recordOperatorSentinelRunHint,
  requestSentinelWorkerControl,
} from "./sentinel_adaptive_runtime.ts";

export function createOperatorSentinelRuns(
  baseDir: string,
  webContainmentConfigured?: boolean,
): OperatorRunProvider {
  const ids = () => ["main", ...listSentinelCaseIds(baseDir)];
  function pathFor(ref: OperatorRunRef) {
    if (ref.kind !== "sentinel" || !ids().includes(ref.id)) return undefined;
    const path = resolveSentinelCasePath(baseDir, ref.id);
    try {
      const file = Deno.lstatSync(path);
      return file.isFile && !file.isSymlink ? path : undefined;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  function inspect(
    ref: OperatorRunRef,
    full = true,
  ): OperatorRunSummary | undefined {
    const path = pathFor(ref);
    if (!path) return undefined;
    const status = readSentinelCaseStatus(path);
    if (!status) {
      return ref.revision === undefined
        ? {
          ref,
          label: ref.id,
          status: "published",
          classification: "INTERNAL",
        }
        : undefined;
    }
    const publicRef = {
      kind: "sentinel" as const,
      id: ref.id,
      revision: ref.revision ?? status.revision,
    };
    const summary: OperatorRunSummary = {
      ref: publicRef,
      label: ref.id,
      status: publicRef.revision === status.revision ? status.status : "saved",
      classification: "INTERNAL",
      evidence: [{
        source: "sentinel_case_revision",
        reference: `${ref.id}:${publicRef.revision}`,
      }],
    };
    if (!full) return summary;
    const current = readSentinelAssessment(path);
    if (!current) return undefined;
    const state = current.revision === publicRef.revision
      ? current
      : readSentinelAssessmentRevision(path, publicRef.revision);
    if (!state?.result) return undefined;
    const adaptive = current.revision === publicRef.revision
      ? readAdaptiveSentinel(path, current, "revision")
      : readHistoricalAdaptiveSentinel(path, publicRef.revision);
    const workerFindings = readSentinelWorkerFindingReport(
      path,
      publicRef.revision,
    );
    return {
      ...summary,
      details: {
        findings: state.result.sharedGraph.snapshot?.nodes
          .filter((node) => node.kind === "finding")
          .slice(0, 6)
          .map(({ id, label }) => ({ id, label })) ?? [],
        reportedFindings: workerFindings?.findings.slice(0, 6)
          .map(({ id, title, evidenceId, evidenceRevision }) => ({
            id,
            title,
            evidenceId,
            evidenceRevision,
          })) ?? [],
        tasks: adaptive?.tasks.slice(0, 8)
          .map(({ id, kind, nodeId, status }) => ({
            id,
            kind,
            nodeId: nodeId ?? null,
            status,
          })) ?? [],
        workerHistory: adaptive?.modelReviewStates.slice(0, 8)
          .map(({ taskId, status, attempts }) => ({
            taskId,
            status,
            attempts,
          })) ?? [],
      },
    };
  }

  function change(ref: OperatorRunRef, action: "pause" | "resume") {
    const path = pathFor(ref);
    if (!path || ref.revision === undefined) return undefined;
    const status = readSentinelCaseStatus(path);
    if (!status || status.revision !== ref.revision) return undefined;
    if (action === "pause") {
      if (
        status.status !== "paused" &&
        !pauseSentinelAssessment(path, ref.revision)
      ) return;
    } else if (status.status !== "running") {
      const state = resumeSentinelAssessment(
        path,
        webContainmentConfigured,
        ref.revision,
      );
      if (!state) return;
      advanceAdaptiveSentinel(path, state);
    }
    return inspect({ kind: ref.kind, id: ref.id });
  }

  function steer(ref: OperatorRunRef, context?: OperatorRunMutationContext) {
    const path = pathFor(ref);
    if (!path || !context?.taskId || !context.requestId || !context.note) {
      return;
    }
    const state = readSentinelAssessment(path);
    if (!state || state.revision !== ref.revision) return;
    const revision = readAdaptiveSentinel(path, state)?.revision;
    if (!revision) return;
    if (
      !requestSentinelWorkerControl(
        path,
        revision,
        context.taskId,
        context.requestId,
        "steer",
        context.note,
      )
    ) return;
    return inspect(ref);
  }

  return {
    list: () =>
      ids().flatMap((id) => {
        const summary = inspect({ kind: "sentinel", id }, false);
        return summary ? [summary] : [];
      }),
    inspect,
    mutations: {
      start(ref) {
        const path = pathFor(ref);
        if (!path || ref.revision !== undefined) return undefined;
        const current = readSentinelAssessment(path);
        if (current?.active) return current.paused ? undefined : inspect(ref);
        if (current?.plan.formalGoals?.length) return undefined;
        const state = startSentinelAssessment(
          path,
          current?.plan,
          webContainmentConfigured,
        );
        advanceAdaptiveSentinel(path, state);
        return inspect(ref);
      },
      pause: (ref) => change(ref, "pause"),
      resume: (ref) => change(ref, "resume"),
      steer,
      hint(ref, context) {
        const path = pathFor(ref);
        if (
          !path || ref.revision === undefined || !context?.requestId ||
          !context.note
        ) return undefined;
        return recordOperatorSentinelRunHint(
            path,
            ref.revision,
            context.requestId,
            context.note,
          )
          ? inspect(ref)
          : undefined;
      },
    },
  };
}
