import type { SentinelModelRoute } from "../sentinel/model_routes.ts";
import {
  canCreateEmptyLinkedSentinelCase,
  publishEmptyLinkedSentinelCase,
  readStagedEmptyLinkedSentinelCase,
  stageEmptyLinkedSentinelCase,
} from "../sentinel/linked_empty_case.ts";
import type { SentinelCaseMembershipProof } from "../sentinel/case_membership.ts";
import { ensureSentinelFormalGoalContract } from "./sentinel_goal_completion.ts";
import type { SentinelLinkedSeedTask } from "../sentinel/linked_seed_task.ts";
import type { SentinelLinkedCaseSource } from "../sentinel/linked_case_sources.ts";
/** Exact Sentinel case adapter for authenticated operator run control. */
import type { SelectedModelProfile } from "../core/model_profile_selection.ts";
import type {
  OperatorRunLinkInput,
  OperatorRunProvider,
  OperatorRunRef,
  OperatorRunSummary,
} from "../core/operator_runs.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  matchesSentinelLinkedStartGoal,
  matchesSentinelLinkedStartTemplate,
  pauseSentinelAssessment,
  previewSentinelLinkedOrganization,
  publishedSentinelGraphDigest,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelCaseStatus,
  readSentinelChildDescription,
  readSentinelEmptyCreationDigest,
  readSentinelFallbackModelsForRevision,
  readSentinelFormalGoalApproval,
  readSentinelInventoryCoverageForRevision,
  readSentinelLinkedSourcesForRevision,
  readSentinelLinkedStartModelRoute,
  readSentinelLinkedStartSeed,
  readSentinelModelProfileForRevision,
  readSentinelOperatingConstraintVersion,
  readSentinelPlannerHeartbeatForRevision,
  readSentinelRunDisplay,
  readSentinelRunIdForRevision,
  readSentinelRunTimeoutForRevision,
  resumeSentinelAssessment,
  type SentinelFormalGoalApproval,
  startSentinelAssessment,
  stopSentinelAssessment,
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
): OperatorRunProvider & {
  discovery(
    ref: OperatorRunRef,
  ):
    | (NonNullable<ReturnType<typeof readSentinelCaseStatus>>["discovery"] & {
      status: NonNullable<ReturnType<typeof readSentinelCaseStatus>>["status"];
    })
    | undefined;
  cancelExact(
    ref: OperatorRunRef,
    runId: string,
  ): OperatorRunSummary | undefined;
  publishedStartDigest(ref: OperatorRunRef): string | undefined;
  canStartEmpty(ref: OperatorRunRef): boolean;
  matchesStartEmpty(ref: OperatorRunRef, creationDigest?: string): boolean;
  finishEmptyStart(ref: OperatorRunRef, creationDigest: string): void;
  previewStartOrganization(
    ref: OperatorRunRef,
    organizationId: string,
  ): SentinelCaseMembershipProof | undefined;
  startOrganization(ref: OperatorRunRef): string | undefined;
  modelProfile(ref: OperatorRunRef): SelectedModelProfile | undefined;
  fallbackModels(
    ref: OperatorRunRef,
  ): readonly SelectedModelProfile[] | undefined;
  startModelRoute(ref: OperatorRunRef): SentinelModelRoute | undefined;
  inventoryCoverage(ref: OperatorRunRef): boolean | undefined;
  plannerHeartbeat(ref: OperatorRunRef): number | undefined;
  linkedCaseSources(
    ref: OperatorRunRef,
  ): readonly SentinelLinkedCaseSource[] | undefined;
  matchesStartGoalApproval(
    ref: OperatorRunRef,
    approval?: SentinelFormalGoalApproval,
  ): boolean;
  childDescription(ref: OperatorRunRef): string | undefined;
  matchesStartTemplate(ref: OperatorRunRef, templateKey?: string): boolean;
  startSeed(ref: OperatorRunRef): SentinelLinkedSeedTask | undefined;
  matchesStartGoal(ref: OperatorRunRef, goal?: string): boolean;
  matchesStartTimeout(ref: OperatorRunRef, timeoutSeconds?: number): boolean;
  startLinked(
    ref: OperatorRunRef,
    link: {
      path: string;
      input: Omit<OperatorRunLinkInput, "right">;
      graphDigest: string;
      emptyCreationDigest?: string;
      childGoal?: string;
      goalApproval?: SentinelFormalGoalApproval;
      membership?: SentinelCaseMembershipProof;
      childDescription?: string;
      templateKey?: string;
      seedTask?: SentinelLinkedSeedTask;
      timeoutSeconds?: number;
      modelProfile?: SelectedModelProfile;
      modelFallbackProfiles?: readonly SelectedModelProfile[];
      plannerHeartbeatSeconds?: number;
      inventoryCoverageEnabled?: boolean;
      linkedCaseSources?: readonly SentinelLinkedCaseSource[];
    },
  ): OperatorRunSummary | undefined;
  workerControl(
    ref: OperatorRunRef,
    action: "steer" | "stop",
    target: {
      readonly runId: string;
      readonly adaptiveRevision: string;
      readonly taskId: string;
      readonly requestId: string;
      readonly note?: string;
    },
  ): ReturnType<typeof requestSentinelWorkerControl>;
} {
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
      label: readSentinelChildDescription(path, publicRef.revision) ?? ref.id,
      status: publicRef.revision === status.revision ? status.status : "saved",
      classification: "INTERNAL",
      evidence: [{
        source: "sentinel_case_revision",
        reference: `${ref.id}:${publicRef.revision}`,
      }],
    };
    if (!full) {
      const runId = readSentinelRunIdForRevision(path, publicRef.revision);
      if (!runId) return summary;
      const display = readSentinelRunDisplay(path, runId);
      if (!display.version) return summary;
      return {
        ...summary,
        label: display.title ?? summary.label,
        details: {
          displayVersion: display.version,
          pinned: display.pinnedAt !== undefined,
          ...(display.pinnedAt && { pinnedAt: display.pinnedAt }),
        },
      };
    }
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
    const modelFallbackProfiles = readSentinelFallbackModelsForRevision(
      path,
      publicRef.revision,
    );
    const modelProfile = readSentinelModelProfileForRevision(
      path,
      publicRef.revision,
    );
    const linkedCaseSources = readSentinelLinkedSourcesForRevision(
      path,
      publicRef.revision,
    );
    const plannerHeartbeatSeconds = readSentinelPlannerHeartbeatForRevision(
      path,
      publicRef.revision,
    );
    return {
      ...summary,
      details: {
        ...(plannerHeartbeatSeconds !== undefined &&
          { plannerHeartbeatSeconds }),
        inventoryCoverageEnabled: readSentinelInventoryCoverageForRevision(
          path,
          publicRef.revision,
        ) !== false,
        runId: state.plan?.runId ?? null,
        ...(linkedCaseSources && { linkedCaseSources }),
        adaptiveRevision: adaptive?.revision ?? null,
        ...(modelProfile && { modelProfile }),
        ...(modelFallbackProfiles && {
          modelFallbackProfiles,
          ...(current.revision === publicRef.revision && {
            activeModelProfile: current.plan.modelFallbackIndex
              ? modelFallbackProfiles[current.plan.modelFallbackIndex - 1]
              : modelProfile,
          }),
        }),
        ...(publicRef.revision === current.revision &&
          state.plan?.timeoutSeconds !== undefined && {
          timeoutSeconds: state.plan.timeoutSeconds,
          deadlineAt: state.plan.deadlineAt,
        }),
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

  function change(
    ref: OperatorRunRef,
    action: "pause" | "resume",
    expectedRunId?: string,
  ) {
    const path = pathFor(ref);
    if (!path || ref.revision === undefined) return undefined;
    const status = readSentinelCaseStatus(path);
    if (
      !status || status.revision !== ref.revision ||
      (expectedRunId !== undefined &&
        readSentinelRunIdForRevision(path, ref.revision) !== expectedRunId)
    ) return undefined;
    if (action === "pause") {
      if (
        status.status !== "paused" &&
        !pauseSentinelAssessment(path, ref.revision, expectedRunId)
      ) return;
    } else if (status.status !== "running") {
      const state = resumeSentinelAssessment(
        path,
        webContainmentConfigured,
        ref.revision,
        expectedRunId,
      );
      if (!state) return;
      advanceAdaptiveSentinel(path, state);
    }
    return inspect({ kind: ref.kind, id: ref.id });
  }

  return {
    list: () =>
      ids().flatMap((id) => {
        const summary = inspect({ kind: "sentinel", id }, false);
        return summary ? [summary] : [];
      }).sort((left, right) =>
        String(right.details?.pinnedAt ?? "").localeCompare(
          String(left.details?.pinnedAt ?? ""),
        )
      ),
    inspect,
    discovery(ref) {
      const path = pathFor(ref);
      if (!path || ref.revision === undefined) return;
      const status = readSentinelCaseStatus(path, true);
      if (status?.revision !== ref.revision || !status.discovery) return;
      return { ...status.discovery, status: status.status };
    },
    cancelExact(ref, runId) {
      const path = pathFor(ref);
      if (
        !path || ref.revision === undefined ||
        !stopSentinelAssessment(path, { revision: ref.revision, runId })
      ) return;
      return inspect(ref);
    },
    canStartEmpty(ref) {
      return ref.kind === "sentinel" && ref.revision === undefined &&
        canCreateEmptyLinkedSentinelCase(baseDir, ref.id);
    },
    matchesStartEmpty(ref, creationDigest) {
      const path = pathFor(ref);
      return !!path && ref.revision !== undefined &&
        readSentinelEmptyCreationDigest(path, ref.revision) === creationDigest;
    },
    finishEmptyStart(ref, creationDigest) {
      if (
        ref.kind !== "sentinel" || ref.revision === undefined || pathFor(ref) ||
        !canCreateEmptyLinkedSentinelCase(baseDir, ref.id)
      ) return;
      const stage = readStagedEmptyLinkedSentinelCase(
        baseDir,
        ref.id,
        creationDigest,
      );
      if (
        !stage || readSentinelCaseStatus(stage)?.revision !== ref.revision ||
        readSentinelEmptyCreationDigest(stage, ref.revision) !== creationDigest
      ) return;
      publishEmptyLinkedSentinelCase(baseDir, ref.id, creationDigest);
    },
    publishedStartDigest(ref) {
      const path = pathFor(ref);
      if (
        !path || ref.id === "main" || ref.revision !== undefined ||
        readSentinelCaseStatus(path)
      ) return;
      return publishedSentinelGraphDigest(path);
    },
    linkedCaseSources(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelLinkedSourcesForRevision(path, ref.revision)
        : undefined;
    },
    previewStartOrganization(ref, organizationId) {
      const path = pathFor(ref);
      return path && ref.revision === undefined
        ? previewSentinelLinkedOrganization(
          path,
          ref.id,
          organizationId,
          webContainmentConfigured,
        )
        : undefined;
    },
    startOrganization(ref) {
      const path = pathFor(ref);
      if (!path || ref.revision === undefined) return;
      const runId = readSentinelRunIdForRevision(path, ref.revision);
      const policy = runId &&
        readSentinelOperatingConstraintVersion(path, runId, 1);
      return policy && policy.operatorScope === "linked-assessment-start" &&
          policy.evidenceRevision === ref.revision &&
          policy.membership?.selector.kind === "organization"
        ? policy.membership.selector.organizationId
        : undefined;
    },
    inventoryCoverage(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelInventoryCoverageForRevision(path, ref.revision)
        : undefined;
    },
    plannerHeartbeat(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelPlannerHeartbeatForRevision(path, ref.revision)
        : undefined;
    },
    startModelRoute(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelLinkedStartModelRoute(path, ref.revision)
        : undefined;
    },
    fallbackModels(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelFallbackModelsForRevision(path, ref.revision)
        : undefined;
    },
    modelProfile(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelModelProfileForRevision(path, ref.revision)
        : undefined;
    },
    matchesStartGoalApproval(ref, approval) {
      const path = pathFor(ref);
      if (!path || ref.revision === undefined) return false;
      if (approval) {
        return readSentinelFormalGoalApproval(path, approval)
          ?.appliedRevision ===
          ref.revision;
      }
      return !readSentinelAssessmentRevision(path, ref.revision)?.formalGoals;
    },
    childDescription(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelChildDescription(path, ref.revision)
        : undefined;
    },
    matchesStartTemplate(ref, templateKey) {
      const path = pathFor(ref);
      return !!path && ref.revision !== undefined &&
        matchesSentinelLinkedStartTemplate(path, ref.revision, templateKey);
    },
    startSeed(ref) {
      const path = pathFor(ref);
      return path && ref.revision !== undefined
        ? readSentinelLinkedStartSeed(path, ref.revision)?.task
        : undefined;
    },
    matchesStartGoal(ref, goal) {
      const path = pathFor(ref);
      return !!path && ref.revision !== undefined &&
        matchesSentinelLinkedStartGoal(path, ref.revision, goal);
    },
    matchesStartTimeout(ref, timeoutSeconds) {
      const path = pathFor(ref);
      if (!path || ref.revision === undefined) return false;
      return readSentinelRunTimeoutForRevision(path, ref.revision) ===
        timeoutSeconds;
    },
    startLinked(ref, link) {
      if (
        ref.kind !== "sentinel" || ref.id === "main" ||
        ref.revision !== undefined
      ) return;
      const stage = link.emptyCreationDigest
        ? stageEmptyLinkedSentinelCase(
          baseDir,
          ref.id,
          link.emptyCreationDigest,
        )
        : pathFor(ref);
      if (!stage) return;
      const started = startSentinelAssessment(
        stage,
        link.childGoal === undefined ? {} : { goal: link.childGoal },
        webContainmentConfigured,
        {
          ...link,
          caseId: ref.id,
        },
      );
      if (
        link.emptyCreationDigest &&
        !publishEmptyLinkedSentinelCase(
          baseDir,
          ref.id,
          link.emptyCreationDigest,
        )
      ) return;
      const path = pathFor(ref);
      if (!path) return;
      if (link.goalApproval) ensureSentinelFormalGoalContract(path, started);
      advanceAdaptiveSentinel(path, started);
      return inspect({ ...ref, revision: started.revision });
    },
    workerControl(ref, action, target) {
      const path = pathFor(ref);
      if (!path || ref.revision === undefined) return undefined;
      const state = readSentinelAssessment(path);
      if (
        state?.revision !== ref.revision || state.plan.runId !== target.runId ||
        readAdaptiveSentinel(path, state, "revision")?.revision !==
          target.adaptiveRevision
      ) return undefined;
      // The shared journal rechecks the active revision under the assessment
      // write lock. The adaptive revision binds the run identity and evidence.
      return requestSentinelWorkerControl(
        path,
        target.adaptiveRevision,
        target.taskId,
        target.requestId,
        action,
        target.note,
      );
    },
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
      pause: (ref, context) => change(ref, "pause", context?.expectedRunId),
      resume: (ref, context) => change(ref, "resume", context?.expectedRunId),
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
            undefined,
            context.assetIds,
            context.trafficReference,
          )
          ? inspect(ref)
          : undefined;
      },
    },
  };
}
