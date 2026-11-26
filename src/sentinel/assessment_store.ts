import {
  notifySentinelAssessmentInterruption,
  type SentinelAssessmentInterruption,
} from "./assessment_interruptions.ts";
import type {
  CompletedSentinelGraphFollowupBinding,
  CompletedSentinelGraphFollowupReceipt,
  CompletedSentinelGraphFollowupRequest,
} from "./completed_graph_followup.ts";
import {
  parseSentinelModelRoute,
  type SentinelModelRoute,
  type SentinelModelRouteEdit,
  sentinelModelRouteEditLimit,
  type SentinelRoleModels,
  validSentinelModelRouteHistory,
} from "./model_routes.ts";
import {
  parseSentinelLinkedSeedTask,
  type SentinelLinkedSeedTask,
} from "./linked_seed_task.ts";
import {
  parseSentinelLinkedCaseSources,
  type SentinelLinkedCaseSource,
} from "./linked_case_sources.ts";
import { validPlannerHeartbeatSeconds } from "../core/evidence_task_progression.ts";
import {
  isSelectedModelProfile,
  parseModelFallbackProfiles,
  type SelectedModelProfile,
} from "../core/model_profile_selection.ts";
import {
  parseSavedPlannerProvenancePath,
  readSavedSentinelProvenanceNode,
  readSavedSentinelProvenanceSearch,
  readSentinelProvenanceNodeReference,
  readSentinelProvenanceSearchReference,
} from "./worker_goal_recovery.ts";
import {
  type OperatorRunLinkInput,
  type OperatorRunRef,
  recordOperatorRunLink,
  withOperatorRunLinks,
} from "../core/operator_runs.ts";
/** Persist the active defensive assessment and its evidence-driven revisions. */
/// <reference path="../core/sqlite_types.d.ts" />
import {
  correlateSentinelIncidents,
  recoverSentinelIncidentAlerts,
  resolveSentinelIncidentAlerts,
  summarizeSentinelIncident,
} from "./incident_correlation.ts";
import { loadSentinelGraph, sentinelFindingDispositions } from "./graph.ts";
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "@std/path";
import { MAX_SNAPSHOT_BYTES } from "./chat_mode.ts";
import { enrichSentinelNetworkAssets } from "./asset_enrichment.ts";
import { applySharedSentinelTopology } from "./shared_inventory.ts";
import { mergeSentinelSnapshots } from "./merge.ts";
import {
  sentinelAlertsPath,
  sentinelDnsPath,
  sentinelNativeCapturePath,
  sentinelSharedTopologyPath,
  sentinelTrafficPath,
} from "./paths.ts";
import {
  MAX_EDGES,
  runSentinelAssessment,
  type SentinelAssessmentOptions,
} from "./assessment.ts";
import {
  digestSentinelGoalProposal,
  normalizeSentinelFormalGoals,
  type SentinelFormalGoal,
} from "./formal_goals.ts";
import {
  digestSentinelOperatingConstraints,
  normalizeSentinelOperatingConstraints,
  type SentinelOperatingConstraintRecord as BaseOperatingConstraintRecord,
  type SentinelOperatingConstraints,
  sentinelOperatingConstraintsAllow,
  type SentinelOperatingConstraintUpdate as BaseOperatingConstraintUpdate,
  validateSentinelOperatingConstraintAssets,
} from "./operating_constraints.ts";
import {
  resolveSentinelCaseMembership,
  type SentinelCaseMembershipProof,
  verifySentinelCaseMembership,
} from "./case_membership.ts";
import { locateSentinelCase } from "./cases.ts";

type Result = ReturnType<typeof runSentinelAssessment>;

interface OperatingConstraintMembership {
  readonly membership?: SentinelCaseMembershipProof;
}

export type SentinelOperatingConstraintUpdate =
  & BaseOperatingConstraintUpdate
  & OperatingConstraintMembership;

export type SentinelOperatingConstraintRecord =
  & BaseOperatingConstraintRecord
  & OperatingConstraintMembership;

export type AssessmentPlan =
  & Pick<
    SentinelAssessmentOptions,
    "impactAsset" | "traceNode" | "evidenceNode" | "depth"
  >
  & {
    readonly goal?: string;
    readonly runId?: string;
    readonly admissionAt?: number;
    readonly runStartedAt?: number;
    readonly runInactiveAt?: number;
    readonly spawnParent?: OperatorRunRef;
    readonly timeoutSeconds?: number;
    readonly deadlineAt?: number;
    readonly modelProfile?: SelectedModelProfile;
    readonly modelFallbackProfiles?: readonly SelectedModelProfile[];
    readonly modelFallbackIndex?: number;
    readonly modelRouteHistory?: readonly SentinelModelRouteEdit[];
    readonly modelRoleProfiles?: SentinelRoleModels;
    readonly plannerHeartbeatSeconds?: number;
    readonly inventoryCoverageEnabled?: boolean;
    readonly linkedCaseSources?: readonly SentinelLinkedCaseSource[];
    readonly childDescription?: string;
    readonly assessmentTemplate?: SentinelAssessmentTemplateBinding;
    readonly formalGoals?: readonly SentinelFormalGoal[];
    readonly activeFormalGoalIds?: readonly string[];
    readonly completedFormalGoalIds?: readonly string[];
    readonly withdrawnFormalGoalIds?: readonly string[];
  };

interface SentinelAssessmentTemplateBinding {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

export function parseSentinelAssessmentTemplateBinding(
  raw: unknown,
): SentinelAssessmentTemplateBinding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const { id, version, digest } = raw as Partial<
    SentinelAssessmentTemplateBinding
  >;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
    typeof version !== "number" || !Number.isSafeInteger(version) ||
    version < 1 ||
    typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
    Object.keys(raw).length !== 3
  ) return;
  return { id, version, digest };
}

type FormalGoalPlan = Pick<
  AssessmentPlan,
  | "goal"
  | "impactAsset"
  | "traceNode"
  | "evidenceNode"
  | "depth"
  | "inventoryCoverageEnabled"
  | "childDescription"
  | "assessmentTemplate"
>;

export interface SentinelFormalGoalApproval {
  readonly mode: "start" | "append" | "revise" | "withdraw";
  readonly requestId: string;
  readonly proposalDigest: string;
  readonly sourceProposalId?: string;
  readonly goals: readonly SentinelFormalGoal[];
  readonly expectedRevision?: number;
  readonly expectedRunId?: string;
  readonly plan?: FormalGoalPlan;
  readonly initialConstraints?: SentinelOperatingConstraints;
}

export interface SentinelSavedWorkerTrace {
  readonly sourceTaskId: string;
  readonly evidenceRevision: number;
  readonly stepIndices: readonly number[];
}

export interface SentinelAssignedTargetReceipt {
  readonly targetId: string;
  readonly linkedNodeIds: readonly string[];
}

export interface SentinelGitHubWorkflowReadReceipt {
  readonly repository: string;
  readonly workflowId: number;
  readonly connectorId: string;
  readonly observedAt: string;
  readonly evidenceRevision: number;
  readonly resultSha256: string;
  readonly runs: readonly {
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
    readonly repositoryId?: number;
    readonly createdAt?: string;
  }[];
}

export interface SentinelReviewStep {
  readonly tool: string;
  readonly target?: string;
  readonly outcome: "returned" | "error";
  readonly provenanceNodePage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelProvenanceNodeReference
    >
  >;
  readonly provenanceSearchPage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelProvenanceSearchReference
    >
  >;
  readonly workerTracePage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelWorkerTracePageReference
    >
  >;
  readonly workerTrace?: SentinelSavedWorkerTrace;
  readonly assignedTarget?: SentinelAssignedTargetReceipt;
  readonly resultSha256?: string;
  readonly githubWorkflowRead?: SentinelGitHubWorkflowReadReceipt;
  readonly discoveryPage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelDiscoveryPageReference
    >
  >;
  readonly sharedAssetDiscovery?: {
    readonly id: string;
    readonly version?: number;
    readonly sourceCaseId: string;
    readonly taskId: string;
    readonly evidenceRevision: number;
    readonly sourceDigest: string;
    readonly evidenceId: string;
  };
  readonly intermediateWorkflowPage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").sentinelIntermediateWorkflowPageReference
    >
  >;
  readonly intermediateWorkflowObservation?: {
    readonly observationId: string;
    readonly sourceTaskId: string;
    readonly sourceStepIndex?: number;
    readonly targetId: string;
    readonly evidenceRevision: number;
    readonly resultSha256: string;
  };
  readonly observationSearch?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelObservationSearchReference
    >
  >;
  readonly taskObservationPage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelTaskObservationPageReference
    >
  >;
  readonly findingPage?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelFindingPageReference
    >
  >;
  readonly graphFactPage?: NonNullable<
    ReturnType<
      typeof import("./worker_graph_facts.ts").readSentinelGraphFactPageReference
    >
  >;
  readonly goalStateProjection?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelGoalStateProjection
    >
  >;
  readonly caseHintFirstId?: number | null;
  readonly goalReceiptRead?: {
    readonly args: NonNullable<
      ReturnType<
        typeof import("./worker_goal_recovery.ts").sentinelGoalReceiptReadArguments
      >
    >;
    readonly sha256: string;
  };
  readonly graphOverviewProjection?: NonNullable<
    ReturnType<
      typeof import("./worker_goal_recovery.ts").readSentinelGraphOverviewProjection
    >
  >;
  /** Persisted planner inventory page. The legacy key also carries exact asset pages. */
  readonly plannerCoverageResult?: {
    readonly args: Record<string, unknown>;
    readonly text: string;
    readonly sha256: string;
  };
  readonly plannerDigestResult?: {
    readonly args: Record<string, unknown>;
    readonly text: string;
    readonly sha256: string;
  };
  readonly sharedAssetLinksPage?: string;
  readonly plannerProvenancePath?: string;
  readonly plannerProvenanceNodeResult?: string;
  readonly provenanceSearchResult?: string;
  readonly workerProvenanceNodeResult?: string;
  readonly plannerDefenseContainment?: boolean | null;
  readonly goalProofRequestId?: string;
  readonly assetDiscoveryRequestId?: string;
  readonly linkedTrafficPayload?: ReturnType<
    typeof import("./traffic_recovery.ts").sentinelLinkedTrafficPayloadReference
  >;
  readonly trafficLinks?: {
    readonly linkIds?: readonly string[];
    readonly evidenceVersion?: string;
    readonly nextOffset?: number | null;
    readonly args: NonNullable<
      ReturnType<
        typeof import("./traffic_recovery.ts").sentinelTrafficLinksArgs
      >
    >;
    readonly sha256: string;
  };
  readonly trafficSearchPage?: ReturnType<
    typeof import("./traffic_recovery.ts").sentinelTrafficPageReference
  >;
  readonly trafficSearch?: {
    readonly args: ReturnType<
      typeof import("./traffic_recovery.ts").sentinelTrafficSearchArgs
    >;
    readonly sha256: string;
  };
  readonly trafficRead?: {
    readonly revision: number;
    readonly evidenceId: string;
    readonly digest: string;
    readonly sha256: string;
  };
  readonly recheckContext?: {
    readonly findingId: string;
    readonly sha256: string;
  };
  readonly resultSnapshot?: {
    readonly sha256: string;
    readonly excerpt: string;
    readonly truncated: boolean;
  };
  readonly peerFinding?:
    import("./adaptive_store.ts").AdaptivePeerFindingCitation;
  readonly aliasMapping?: {
    readonly proof: string;
    readonly sources:
      readonly import("./shared_inventory.ts").SharedAssetMappingSource[];
  };
  readonly sourceSnapshots?: readonly {
    readonly caseId: string;
    readonly assetId?: string;
    readonly snapshotDigest: string;
  }[];
}

/** Publish trace metadata while keeping saved response bodies private. */
export function projectSentinelTraceMetadata<T extends SentinelReviewStep>(
  step: T,
  includeReadResults = false,
) {
  const {
    sharedAssetLinksPage,
    plannerProvenancePath,
    plannerProvenanceNodeResult: _plannerNode,
    provenanceSearchResult,
    workerProvenanceNodeResult,
    resultSnapshot,
    ...metadata
  } = step;
  const resultSha256 = step.resultSha256 ?? resultSnapshot?.sha256;
  return {
    ...metadata,
    ...(resultSha256 && { resultSha256 }),
    ...(includeReadResults && sharedAssetLinksPage !== undefined &&
      { sharedAssetLinksPage }),
    ...(includeReadResults && plannerProvenancePath !== undefined &&
      { plannerProvenancePath }),
    ...(includeReadResults && provenanceSearchResult !== undefined &&
      { provenanceSearchResult }),
    ...(includeReadResults && workerProvenanceNodeResult !== undefined &&
      { workerProvenanceNodeResult }),
  };
}

export function readSentinelGitHubWorkflowReadReceipt(
  value: unknown,
  evidenceRevision: number,
): SentinelGitHubWorkflowReadReceipt | undefined {
  if (!value || typeof value !== "object") return;
  const receipt = value as SentinelGitHubWorkflowReadReceipt;
  const {
    repository,
    workflowId,
    connectorId,
    observedAt,
    resultSha256,
    runs,
  } = receipt;
  if (
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    receipt.evidenceRevision !== evidenceRevision ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[-_.A-Za-z0-9]{1,100}$/.test(
      repository,
    ) ||
    !Number.isSafeInteger(workflowId) || workflowId < 1 ||
    typeof connectorId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(connectorId) ||
    typeof observedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt ||
    typeof resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(resultSha256) ||
    !Array.isArray(runs) || runs.length > 20 ||
    Array.from(runs).some((run) =>
      !run || !Number.isSafeInteger(run.id) || run.id < 1 ||
      typeof run.status !== "string" || !/^[a-z_]{1,40}$/.test(run.status) ||
      (run.conclusion !== null &&
        (typeof run.conclusion !== "string" ||
          !/^[a-z_]{1,40}$/.test(run.conclusion))) ||
      ((run.repositoryId !== undefined || run.createdAt !== undefined) &&
        (typeof run.repositoryId !== "number" ||
          !Number.isSafeInteger(run.repositoryId) ||
          run.repositoryId < 1 || typeof run.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
            run.createdAt,
          ) ||
          !Number.isFinite(Date.parse(run.createdAt)) ||
          new Date(run.createdAt).toISOString() !== run.createdAt ||
          run.createdAt > observedAt))
    ) ||
    new Set(runs.map(({ id }) => id)).size !== runs.length ||
    new Set(runs.map(({ repositoryId }) => repositoryId)).size > 1
  ) return;
  return {
    repository,
    workflowId,
    connectorId,
    observedAt,
    evidenceRevision,
    resultSha256,
    runs: runs.map(({ id, status, conclusion, repositoryId, createdAt }) => ({
      id,
      status,
      conclusion,
      ...(repositoryId !== undefined && { repositoryId, createdAt }),
    })),
  };
}

export function normalizeSentinelWorkflowReviewStep(
  step: SentinelReviewStep,
  evidenceRevision: number,
): SentinelReviewStep {
  if (step.workerProvenanceNodeResult !== undefined) {
    const { workerProvenanceNodeResult, ...metadata } = step;
    const page = readSentinelProvenanceNodeReference(step.provenanceNodePage);
    const valid = step.tool === "sentinel_provenance_node" &&
      step.outcome === "returned" && page && page.args.node === step.target &&
      readSavedSentinelProvenanceNode(
        workerProvenanceNodeResult,
        page,
        evidenceRevision,
      );
    if (!valid) step = metadata;
  }
  if (step.provenanceSearchResult !== undefined) {
    const { provenanceSearchResult, ...metadata } = step;
    const page = readSentinelProvenanceSearchReference(
      step.provenanceSearchPage,
    );
    if (
      step.tool !== "sentinel_provenance_search" ||
      step.outcome !== "returned" ||
      !page ||
      !readSavedSentinelProvenanceSearch(
        provenanceSearchResult,
        page,
        evidenceRevision,
      )
    ) step = metadata;
  }
  if (step.plannerProvenancePath !== undefined) {
    const { plannerProvenancePath, ...metadata } = step;
    const read = step.goalReceiptRead;
    if (
      step.tool !== "sentinel_path" || step.outcome !== "returned" ||
      !read ||
      !parseSavedPlannerProvenancePath(
        plannerProvenancePath,
        read.args,
        evidenceRevision,
      ) ||
      createHash("sha256").update(plannerProvenancePath).digest("hex") !==
        read.sha256
    ) step = metadata;
  }
  if (step.githubWorkflowRead === undefined) return step;
  const { githubWorkflowRead, ...saved } = step;
  const receipt = step.tool === "sentinel_live_workflow_status" &&
      step.outcome === "returned"
    ? readSentinelGitHubWorkflowReadReceipt(
      githubWorkflowRead,
      evidenceRevision,
    )
    : undefined;
  return receipt ? { ...saved, githubWorkflowRead: receipt } : saved;
}

export function readSentinelAssignedTargetReceipt(
  value: unknown,
  targetId: unknown,
): SentinelAssignedTargetReceipt | undefined {
  function validId(id: unknown): id is string {
    return typeof id === "string" && !!id.trim() && id.length <= 4096 &&
      !id.includes("\x00");
  }
  if (!value || typeof value !== "object" || !validId(targetId)) return;
  const receipt = value as Partial<SentinelAssignedTargetReceipt>;
  const linked = receipt.linkedNodeIds;
  if (
    receipt.targetId !== targetId || !Array.isArray(linked) ||
    linked.length > 8 || !linked.every(validId) ||
    new Set(linked).size !== linked.length
  ) return;
  return { targetId, linkedNodeIds: [...linked] };
}

interface GoalCompletion {
  readonly goal: string | null;
  readonly note: string;
  readonly at: string;
  readonly formalGoalIds?: readonly string[];
}

interface StoredAssessment {
  readonly plan: AssessmentPlan;
  readonly active: boolean;
  readonly paused: boolean;
  readonly deadlineReviewPending?: true;
  readonly revision: number;
  readonly updatedAt: string;
  readonly result: Result | null;
  readonly completion?: GoalCompletion;
  readonly reviews: readonly {
    task: string;
    analysis: string;
    steps?: readonly SentinelReviewStep[];
  }[];
}

interface AssessmentRow {
  readonly plan: string;
  readonly active: number;
  readonly revision: number;
  readonly fingerprint: string;
  readonly updatedAt: string;
  readonly result: string;
}

function databasePath(snapshotPath: string): string {
  return join(dirname(snapshotPath), "sentinel-assessment.db");
}

function openStore(
  snapshotPath: string,
  create: boolean,
): DatabaseSync | undefined {
  const path = databasePath(snapshotPath);
  if (create) {
    Deno.mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  try {
    const info = Deno.lstatSync(path);
    if (
      !info.isFile || (info.nlink ?? 1) !== 1 ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) {
      throw new Error(
        "Sentinel assessment database must be a private regular file",
      );
    }
  } catch (error) {
    if (!create && error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }

  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 1500");
    if (create) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assessment (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          plan TEXT NOT NULL,
          active INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assessment_history (
          revision INTEGER PRIMARY KEY,
          updatedAt TEXT NOT NULL,
          result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assessment_reviews (
          revision INTEGER NOT NULL,
          task TEXT NOT NULL,
          claim TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          analysis TEXT,
          PRIMARY KEY(revision, task)
        );
      `);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export const SENTINEL_ASSESSMENT_TIMED_OUT = 4;
const assessmentDeadlineReview = 5;
export const MAX_SENTINEL_RUN_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

let lastAssessmentAdmission = 0;

function nextAssessmentAdmission(): number {
  // Unix microseconds retain arrival order for starts in the same millisecond.
  const now = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  lastAssessmentAdmission = Math.max(now, lastAssessmentAdmission + 1);
  return lastAssessmentAdmission;
}

function expireAssessmentRow<
  T extends Pick<
    AssessmentRow,
    "plan" | "active" | "revision" | "updatedAt"
  >,
>(db: DatabaseSync, row: T, now: number): T | undefined {
  if (row.active !== 1 && row.active !== 2) return row;
  const { deadlineAt } = JSON.parse(row.plan) as AssessmentPlan;
  if (
    typeof deadlineAt !== "number" || !Number.isSafeInteger(deadlineAt) ||
    deadlineAt > now
  ) return row;
  const active = assessmentDeadlineReview;
  const updatedAt = new Date(deadlineAt).toISOString();
  return db.prepare(`
    UPDATE assessment SET active = ?, updatedAt = ?
    WHERE id = 1 AND active IN (1, 2) AND revision = ? AND plan = ?
  `).run(active, updatedAt, row.revision, row.plan).changes
    ? { ...row, active, updatedAt }
    : undefined;
}

function getRow(db: DatabaseSync, now = Date.now()): AssessmentRow | undefined {
  const read = () =>
    db.prepare("SELECT * FROM assessment WHERE id = 1").get() as
      | AssessmentRow
      | undefined;
  const row = read();
  return row && (expireAssessmentRow(db, row, now) ?? read());
}

function hasReviewSteps(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_review_steps'",
    ).get(),
  );
}

function readReviews(db: DatabaseSync, revision: number) {
  const stepTables = hasReviewSteps(db);
  return db.prepare(
    "SELECT task, analysis FROM assessment_reviews WHERE revision = ? AND analysis IS NOT NULL ORDER BY task",
  ).all(revision).map(({ task, analysis }) => {
    const trace = stepTables
      ? db.prepare(
        "SELECT steps FROM assessment_review_steps WHERE revision = ? AND task = ?",
      )
        .get(revision, task)?.steps
      : undefined;
    return {
      task: String(task),
      analysis: String(analysis),
      ...(typeof trace === "string" &&
        { steps: JSON.parse(trace) as SentinelReviewStep[] }),
    };
  });
}

function readGoalCompletion(
  db: DatabaseSync,
  revision: number,
): GoalCompletion | undefined {
  if (
    !db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'assessment_goal_completion' AND type = 'table'",
    ).get()
  ) return undefined;
  const completion = db.prepare(
    "SELECT goal, note, at FROM assessment_goal_completion WHERE revision = ?",
  )
    .get(revision) as unknown as GoalCompletion | undefined;
  if (!completion) return undefined;
  const formalGoalIds = readFormalGoalHistory(db, revision)?.closedIds;
  return { ...completion, ...(formalGoalIds && { formalGoalIds }) };
}

function formalGoalHistoryExists(db: DatabaseSync) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_formal_goal_history'",
  ).get();
}

function saveFormalGoalHistory(
  db: DatabaseSync,
  revision: number,
  plan: AssessmentPlan,
  closedIds?: readonly string[],
) {
  if (!plan.formalGoals) return;
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_formal_goal_history (
    revision INTEGER PRIMARY KEY, plan TEXT NOT NULL, closedIds TEXT
  )`);
  db.prepare(`INSERT INTO assessment_formal_goal_history VALUES (?, ?, ?)
    ON CONFLICT(revision) DO UPDATE SET plan = excluded.plan, closedIds = excluded.closedIds`)
    .run(
      revision,
      JSON.stringify({
        runId: plan.runId,
        goal: plan.goal,
        formalGoals: plan.formalGoals,
        activeFormalGoalIds: plan.activeFormalGoalIds,
        completedFormalGoalIds: plan.completedFormalGoalIds,
        withdrawnFormalGoalIds: plan.withdrawnFormalGoalIds,
      }),
      closedIds ? JSON.stringify(closedIds) : null,
    );
}

function readFormalGoalHistory(db: DatabaseSync, revision: number) {
  if (!formalGoalHistoryExists(db)) return undefined;
  const row = db.prepare(
    "SELECT plan, closedIds FROM assessment_formal_goal_history WHERE revision = ?",
  ).get(revision);
  if (!row) return undefined;
  return {
    plan: JSON.parse(String(row.plan)) as AssessmentPlan,
    closedIds: typeof row.closedIds === "string"
      ? JSON.parse(row.closedIds) as string[]
      : undefined,
  };
}

function saveAssessmentRunRevision(
  db: DatabaseSync,
  revision: number,
  {
    runId,
    timeoutSeconds,
    modelProfile,
    modelFallbackProfiles,
    plannerHeartbeatSeconds,
    inventoryCoverageEnabled,
    linkedCaseSources,
    childDescription,
  }: Pick<
    AssessmentPlan,
    | "runId"
    | "timeoutSeconds"
    | "modelProfile"
    | "modelFallbackProfiles"
    | "plannerHeartbeatSeconds"
    | "inventoryCoverageEnabled"
    | "linkedCaseSources"
    | "childDescription"
  >,
) {
  if (!runId) return;
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_run_revisions (
    revision INTEGER PRIMARY KEY, runId TEXT NOT NULL, timeoutSeconds INTEGER,
    modelProfile TEXT, plannerHeartbeatSeconds INTEGER, linkedCaseSources TEXT,
    childDescription TEXT, modelFallbackProfiles TEXT, inventoryCoverageEnabled INTEGER
  )`);
  const columns = db.prepare("PRAGMA table_info(assessment_run_revisions)")
    .all().map(({ name }) => name);
  if (!columns.includes("timeoutSeconds")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN timeoutSeconds INTEGER",
    );
  }
  if (!columns.includes("modelProfile")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN modelProfile TEXT",
    );
  }
  if (!columns.includes("plannerHeartbeatSeconds")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN plannerHeartbeatSeconds INTEGER",
    );
  }
  if (!columns.includes("linkedCaseSources")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN linkedCaseSources TEXT",
    );
  }
  if (!columns.includes("childDescription")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN childDescription TEXT",
    );
  }
  if (!columns.includes("modelFallbackProfiles")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN modelFallbackProfiles TEXT",
    );
  }
  if (!columns.includes("inventoryCoverageEnabled")) {
    db.exec(
      "ALTER TABLE assessment_run_revisions ADD COLUMN inventoryCoverageEnabled INTEGER",
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO assessment_run_revisions
      (revision, runId, timeoutSeconds, modelProfile, plannerHeartbeatSeconds, linkedCaseSources, childDescription, modelFallbackProfiles, inventoryCoverageEnabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revision,
    runId,
    timeoutSeconds ?? null,
    modelProfile ? JSON.stringify(modelProfile) : null,
    plannerHeartbeatSeconds ?? null,
    linkedCaseSources ? JSON.stringify(linkedCaseSources) : null,
    childDescription ?? null,
    modelFallbackProfiles ? JSON.stringify(modelFallbackProfiles) : null,
    inventoryCoverageEnabled === undefined
      ? null
      : Number(inventoryCoverageEnabled),
  );
}

function pruneAssessmentRevisions(db: DatabaseSync, through: number) {
  const formal = formalGoalHistoryExists(db);
  const closedGoalRevisions = formal
    ? "SELECT revision FROM assessment_formal_goal_history WHERE closedIds IS NOT NULL"
    : "SELECT revision FROM assessment_history WHERE 0";
  const runRevisions = hasTable(db, "assessment_run_revisions");
  const retainsMembershipSources = runRevisions &&
    hasTable(db, "sentinel_operating_constraints");
  const membershipSources = retainsMembershipSources
    ? `AND revision NOT IN (
      SELECT policy.evidenceRevision
      FROM assessment_run_revisions AS saved
      JOIN sentinel_operating_constraints AS policy
        ON policy.runId = saved.runId AND policy.version = (
          SELECT MAX(prior.version)
          FROM sentinel_operating_constraints AS prior
          WHERE prior.runId = saved.runId AND prior.evidenceRevision <= saved.revision
        )
      WHERE (saved.revision > ? OR saved.revision IN (${closedGoalRevisions}))
        AND json_type(policy.record, '$.membership') = 'object'
    )`
    : "";
  db.prepare(`DELETE FROM assessment_history WHERE revision <= ?
    AND revision NOT IN (${closedGoalRevisions})
    ${membershipSources}`).run(
    ...(retainsMembershipSources ? [through, through] : [through]),
  );
  if (formal) {
    db.prepare(`DELETE FROM assessment_formal_goal_history
      WHERE revision <= ? AND closedIds IS NULL`).run(through);
  }
  if (runRevisions) {
    db.exec(`DELETE FROM assessment_run_revisions
      WHERE revision NOT IN (SELECT revision FROM assessment_history)`);
  }
}

function readState(db: DatabaseSync, row: AssessmentRow): StoredAssessment {
  return {
    plan: JSON.parse(row.plan),
    active: row.active === 1 || row.active === 2,
    ...(row.active === 3 &&
      { completion: readGoalCompletion(db, row.revision) }),
    paused: row.active === 2,
    ...(row.active === assessmentDeadlineReview &&
      { deadlineReviewPending: true }),
    revision: row.revision,
    updatedAt: row.updatedAt,
    result: JSON.parse(row.result),
    reviews: readReviews(db, row.revision),
  };
}

function transact<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readPublished(path: string): string | undefined {
  try {
    const info = Deno.lstatSync(path);
    if (!info.isFile || info.size > MAX_SNAPSHOT_BYTES) {
      throw new Error(
        "Published assessment evidence must be a regular file up to 1 MiB",
      );
    }
    using file = Deno.openSync(path, { read: true });
    const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = file.readSync(bytes.subarray(length));
      if (count === null) break;
      length += count;
    }
    if (length > MAX_SNAPSHOT_BYTES) {
      throw new Error("Published evidence exceeds 1 MiB");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, length),
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function latestControlBoundary(
  graph: string | undefined,
  evaluatedAt: string,
): string {
  if (!graph?.includes('"controlVerification"')) return "";
  const snapshot = JSON.parse(graph);
  if (!Array.isArray(snapshot?.nodes)) return "";
  let latest = "";
  for (const node of snapshot.nodes) {
    const verification = node?.controlVerification;
    if (!verification || typeof verification !== "object") continue;
    for (const boundary of [verification.observedAt, verification.validUntil]) {
      if (
        typeof boundary === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(boundary)
      ) {
        const time = Date.parse(boundary);
        if (!Number.isFinite(time)) continue;
        const canonical = new Date(time).toISOString();
        if (canonical <= evaluatedAt && canonical > latest) latest = canonical;
      }
    }
  }
  return latest;
}

function readAssessmentInputs(
  snapshotPath: string,
  webContainmentConfigured?: boolean,
  evaluatedAt = new Date().toISOString(),
) {
  const graph = readPublished(snapshotPath);
  const topology = readPublished(sentinelSharedTopologyPath(snapshotPath));
  const traffic = readPublished(sentinelTrafficPath(snapshotPath));
  const native = readPublished(sentinelNativeCapturePath(snapshotPath));
  const dns = readPublished(sentinelDnsPath(snapshotPath));
  const alertData = readPublished(sentinelAlertsPath(snapshotPath));
  const inputFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "network-enrichment-v1",
        graph,
        traffic,
        native,
        dns,
        alertData,
        webContainmentConfigured,
        ...(topology === undefined ? [] : [topology]),
      ]),
    )
    .digest("hex");
  // Re-evaluate existing alert feeds once when the review policy changes.
  const boundary = latestControlBoundary(graph, evaluatedAt);
  const fingerprint = inputFingerprint +
    (alertData === undefined ? "" : ":alert-priority-v5") +
    (boundary ? `:control-boundary:${boundary}` : "");
  return {
    graph,
    topology,
    traffic,
    native,
    dns,
    alertData,
    fingerprint,
    inputFingerprint,
  };
}

/** Check for published inputs that the assessment has yet to evaluate without running a paused assessment. */
export function hasPendingSentinelInputs(
  path: string,
  webContainmentConfigured?: boolean,
): boolean | undefined {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    const row = getRow(db);
    if (row?.active !== 2) return undefined;
    const { inputFingerprint } = readAssessmentInputs(
      path,
      webContainmentConfigured,
    );
    return row.fingerprint.split(":", 1)[0] !== inputFingerprint;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function incidentCandidateCount(result: Result): number {
  const evidence = result.sharedGraph.observations.find(({ task }) =>
    task === "incident_correlation"
  )?.facts as { summary?: { candidates?: unknown } } | undefined;
  const count = evidence?.summary?.candidates;
  return typeof count === "number" ? count : 0;
}

function ensureIncidentNotificationStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_notification_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), enabled INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assessment_incident_notification (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL,
    state TEXT NOT NULL, at TEXT NOT NULL
  );`);
}

function notificationTableExists(db: DatabaseSync) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_incident_notification'",
  ).get();
}

export function readSentinelNotificationState(path: string) {
  const db = openStore(path, false);
  if (!db) return { enabled: null, latest: null };
  try {
    if (!notificationTableExists(db)) return { enabled: null, latest: null };
    const setting = db.prepare(
      "SELECT enabled FROM assessment_notification_settings WHERE singleton = 1",
    ).get();
    const latest = db.prepare(
      "SELECT revision, state, at FROM assessment_incident_notification WHERE singleton = 1",
    ).get();
    return {
      enabled: setting ? setting.enabled === 1 : null,
      latest: latest
        ? {
          revision: Number(latest.revision),
          state: String(latest.state),
          at: String(latest.at),
        }
        : null,
    };
  } finally {
    db.close();
  }
}

export function setSentinelIncidentNotifications(
  path: string,
  enabled: boolean | null,
) {
  const db = openStore(path, true)!;
  try {
    transact(db, () => {
      ensureIncidentNotificationStore(db);
      if (enabled === null) {
        db.exec("DELETE FROM assessment_notification_settings");
      } else {db.prepare(
          "INSERT OR REPLACE INTO assessment_notification_settings VALUES (1, ?)",
        ).run(Number(enabled));}
    });
  } finally {
    db.close();
  }
}

export function claimSentinelIncidentNotification(
  path: string,
  revision: number,
  gatewayEnabled: boolean,
) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (!notificationTableExists(db)) return undefined;
    return transact(db, () => {
      const row = getRow(db);
      if (row?.active !== 1 || row.revision !== revision) return undefined;
      const setting = db.prepare(
        "SELECT enabled FROM assessment_notification_settings WHERE singleton = 1",
      ).get();
      const allowed = gatewayEnabled && setting?.enabled !== 0;
      const changed = db.prepare(
        `UPDATE assessment_incident_notification SET state = ?, at = ?
        WHERE singleton = 1 AND revision <= ? AND state = 'pending' RETURNING revision`,
      )
        .get(
          allowed ? "attempted" : "disabled",
          new Date().toISOString(),
          revision,
        );
      return allowed && changed ? Number(changed.revision) : undefined;
    });
  } finally {
    db.close();
  }
}

export function finishSentinelIncidentNotification(
  path: string,
  revision: number,
  state: "submitted" | "delivered" | "queued" | "failed",
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    db.prepare(`UPDATE assessment_incident_notification SET state = ?, at = ?
        WHERE singleton = 1 AND revision = ? AND state = 'attempted'`)
      .run(state, new Date().toISOString(), revision);
  } finally {
    db.close();
  }
}

export function recordSentinelNotificationRetry(
  path: string,
  revision: number,
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    if (!notificationTableExists(db)) return;
    transact(db, () => {
      const at = new Date().toISOString();
      db.exec(
        `CREATE TABLE IF NOT EXISTS assessment_notification_retry_receipts (
        revision INTEGER PRIMARY KEY, at TEXT NOT NULL
      )`,
      );
      db.prepare(
        "INSERT OR IGNORE INTO assessment_notification_retry_receipts VALUES (?, ?)",
      )
        .run(revision, at);
      db.prepare(
        `DELETE FROM assessment_notification_retry_receipts WHERE revision NOT IN (
        SELECT revision FROM assessment_notification_retry_receipts ORDER BY revision DESC LIMIT 20
      )`,
      ).run();
      db.prepare(
        `UPDATE assessment_incident_notification SET state = 'delivered_after_retry', at = ?
        WHERE singleton = 1 AND revision = ? AND state IN ('attempted', 'queued', 'submitted')`,
      )
        .run(at, revision);
    });
  } finally {
    db.close();
  }
}

export function readSentinelNotificationReceipt(
  path: string,
  revision: number,
) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (!notificationTableExists(db)) return undefined;
    const hasRetries = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'assessment_notification_retry_receipts' AND type = 'table'",
    ).get();
    const retry = hasRetries &&
      db.prepare(
        "SELECT at FROM assessment_notification_retry_receipts WHERE revision = ?",
      ).get(revision);
    if (retry) {
      return { revision, state: "delivered_after_retry", at: String(retry.at) };
    }
    const row = db.prepare(
      "SELECT state, at FROM assessment_incident_notification WHERE revision = ?",
    ).get(revision);
    return row
      ? { revision, state: String(row.state), at: String(row.at) }
      : undefined;
  } finally {
    db.close();
  }
}

function parseAssessmentAlerts(alertData: string | undefined) {
  const alerts: unknown = alertData === undefined
    ? undefined
    : JSON.parse(alertData);
  if (alerts !== undefined && !Array.isArray(alerts)) {
    throw new Error("Published Sentinel alerts must be a JSON array");
  }
  return alerts;
}

function evaluateSentinelAssessment(
  { graph, topology, traffic, native, dns }: ReturnType<
    typeof readAssessmentInputs
  >,
  plan: AssessmentPlan,
  previous: Result | null,
  alerts: readonly unknown[] | undefined,
  webContainmentConfigured: boolean | undefined,
  evaluatedAt: string,
) {
  const publishedInventory = graph === undefined
    ? undefined
    : JSON.parse(graph);
  const inventory = graph === undefined || topology === undefined
    ? publishedInventory
    : applySharedSentinelTopology(publishedInventory, JSON.parse(topology));
  return runSentinelAssessment({
    ...plan,
    snapshot: traffic === undefined && native === undefined && dns === undefined
      ? inventory
      : enrichSentinelNetworkAssets(
        mergeSentinelSnapshots([
          ...(inventory === undefined ? [] : [inventory]),
          ...[traffic, native, dns].flatMap((data) =>
            data === undefined ? [] : [JSON.parse(data)]
          ),
        ]),
        MAX_EDGES,
      ),
    alerts,
    webContainmentConfigured,
    controlEvaluationAt: evaluatedAt,
    previous,
  });
}

/** Preview the exact first-revision membership without creating assessment state. */
export function previewSentinelLinkedOrganization(
  path: string,
  caseId: string,
  organizationId: string,
  webContainmentConfigured?: boolean,
): SentinelCaseMembershipProof | undefined {
  const evaluatedAt = new Date().toISOString();
  const inputs = readAssessmentInputs(
    path,
    webContainmentConfigured,
    evaluatedAt,
  );
  if (inputs.graph === undefined) return;
  const assessment = evaluateSentinelAssessment(
    inputs,
    {},
    null,
    parseAssessmentAlerts(inputs.alertData),
    webContainmentConfigured,
    evaluatedAt,
  );
  return resolveSentinelCaseMembership(assessment.sharedGraph.snapshot, {
    caseId,
    evidenceRevision: 1,
    selector: { kind: "organization", organizationId },
  });
}

function refresh(
  db: DatabaseSync,
  row: AssessmentRow,
  snapshotPath: string,
  webContainmentConfigured?: boolean,
  evaluatedAt = new Date().toISOString(),
  forceEvidenceRevision = false,
  expectedGraphDigest?: string,
  expectedSeed?: SentinelLinkedSeedTask,
): StoredAssessment {
  if (row.active !== 1) return readState(db, row);
  const inputs = readAssessmentInputs(
    snapshotPath,
    webContainmentConfigured,
    evaluatedAt,
  );
  const { graph, alertData, fingerprint } = inputs;
  if (
    expectedGraphDigest !== undefined &&
    (graph === undefined ||
      createHash("sha256").update(graph).digest("hex") !== expectedGraphDigest)
  ) {
    throw new Error("Published Sentinel graph changed during approval");
  }
  if (!forceEvidenceRevision && fingerprint === row.fingerprint) {
    return readState(db, row);
  }

  const publishedInventory = expectedSeed && graph !== undefined
    ? JSON.parse(graph)
    : undefined;
  if (
    expectedSeed &&
    (!Array.isArray(publishedInventory?.nodes) ||
      !publishedInventory.nodes.some((node: { id?: unknown; kind?: unknown }) =>
        node?.id === expectedSeed.nodeId && node.kind === "asset"
      ))
  ) {
    throw new Error(
      "The linked seed target must be an asset in the approved graph",
    );
  }
  const plan: AssessmentPlan = JSON.parse(row.plan);
  const alerts = parseAssessmentAlerts(alertData);
  const assessment = evaluateSentinelAssessment(
    inputs,
    plan,
    JSON.parse(row.result),
    alerts,
    webContainmentConfigured,
    evaluatedAt,
  );
  const prior = JSON.parse(row.result) as Result | null;
  if (!forceEvidenceRevision && prior?.revision === assessment.revision) {
    db.prepare("UPDATE assessment SET fingerprint = ? WHERE id = 1").run(
      fingerprint,
    );
    return readState(db, row);
  }
  const updatedAt = evaluatedAt;
  const revision = row.revision + 1;
  const result = JSON.stringify(assessment);
  db.prepare(
    "UPDATE assessment SET revision = ?, fingerprint = ?, updatedAt = ?, result = ? WHERE id = 1",
  ).run(revision, fingerprint, updatedAt, result);
  db.prepare("INSERT INTO assessment_history VALUES (?, ?, ?)").run(
    revision,
    updatedAt,
    result,
  );
  saveAssessmentRunRevision(db, revision, plan);
  saveFormalGoalHistory(db, revision, plan);
  if (
    prior && incidentCandidateCount(assessment) > incidentCandidateCount(prior)
  ) {
    ensureIncidentNotificationStore(db);
    db.prepare(
      "INSERT OR REPLACE INTO assessment_incident_notification VALUES (1, ?, 'pending', ?)",
    )
      .run(revision, updatedAt);
  } else if (
    (!prior ||
      incidentCandidateCount(assessment) < incidentCandidateCount(prior)) &&
    notificationTableExists(db)
  ) {
    db.prepare(
      "DELETE FROM assessment_incident_notification WHERE state = 'pending' AND revision < ?",
    )
      .run(revision);
  }
  pruneAssessmentRevisions(db, revision - 20);
  if (alerts !== undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS assessment_alert_history (
      revision INTEGER PRIMARY KEY,
      alerts TEXT NOT NULL
    )`);
    const normalized = alerts.map((alert, index) =>
      parseSentinelTelemetryAlert(alert, index + 1)
    );
    db.prepare("INSERT INTO assessment_alert_history VALUES (?, ?)").run(
      revision,
      JSON.stringify(normalized),
    );
  }
  if (prior) {
    carrySentinelReviews(
      db,
      "finding",
      row.revision,
      revision,
      () => [
        findingEvidenceSignatures(prior),
        findingEvidenceSignatures(assessment),
      ],
    );
    if (alerts !== undefined) {
      carrySentinelReviews(
        db,
        "incident",
        row.revision,
        revision,
        (subjects) => [
          incidentEvidenceSignatures(db, row.revision, prior, subjects),
          incidentEvidenceSignatures(db, revision, assessment, subjects),
        ],
      );
    }
  }
  if (
    db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_alert_history'",
    ).get()
  ) {
    db.prepare("DELETE FROM assessment_alert_history WHERE revision <= ?").run(
      revision - 20,
    );
  }
  if (hasReviewSteps(db)) {
    db.prepare("DELETE FROM assessment_review_steps WHERE revision <= ?").run(
      revision - 20,
    );
  }
  db.prepare("DELETE FROM assessment_reviews WHERE revision <= ?").run(
    revision - 20,
  );
  return readState(db, { ...row, revision, fingerprint, updatedAt, result });
}

export function publishedSentinelGraphDigest(path: string): string | undefined {
  const graph = readPublished(path);
  return graph === undefined
    ? undefined
    : createHash("sha256").update(graph).digest("hex");
}

/** A linked assessment title is exact, bounded, and safe to render on one line. */
export function validSentinelChildDescription(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 160 &&
    !Array.from(value).some((char) =>
      char.charCodeAt(0) < 32 || char === "\x7f"
    );
}

export function startSentinelAssessment(
  path: string,
  plan: AssessmentPlan = {},
  webContainmentConfigured?: boolean,
  linkedStart?: {
    path: string;
    input: Omit<OperatorRunLinkInput, "right">;
    caseId: string;
    graphDigest: string;
    emptyCreationDigest?: string;
    seedTask?: SentinelLinkedSeedTask;
    goalApproval?: SentinelFormalGoalApproval;
    membership?: SentinelCaseMembershipProof;
    childDescription?: string;
    templateKey?: string;
    timeoutSeconds?: number;
    modelProfile?: SelectedModelProfile;
    modelFallbackProfiles?: readonly SelectedModelProfile[];
    plannerHeartbeatSeconds?: number;
    inventoryCoverageEnabled?: boolean;
    linkedCaseSources?: readonly SentinelLinkedCaseSource[];
  },
): StoredAssessment {
  if (
    plan.formalGoals !== undefined || plan.activeFormalGoalIds !== undefined ||
    plan.completedFormalGoalIds !== undefined ||
    plan.withdrawnFormalGoalIds !== undefined
  ) throw new Error("Formal Sentinel goals require an approved goal proposal");
  const childDescription = linkedStart?.childDescription;
  if (
    plan.childDescription !== undefined ||
    (childDescription !== undefined &&
      !validSentinelChildDescription(childDescription))
  ) throw new Error("Invalid linked Sentinel description");
  const linkedCaseSources = parseSentinelLinkedCaseSources(
    linkedStart?.linkedCaseSources,
  );
  if (
    plan.linkedCaseSources !== undefined ||
    (linkedStart?.linkedCaseSources !== undefined &&
      (!linkedCaseSources ||
        linkedCaseSources.some(({ caseId }) => caseId === linkedStart.caseId)))
  ) {
    throw new Error("Invalid linked Sentinel case sources");
  }
  const {
    timeoutSeconds,
    modelProfile,
    plannerHeartbeatSeconds,
    modelFallbackProfiles,
  } = linkedStart ?? {};
  if (
    plan.modelFallbackProfiles !== undefined ||
    plan.modelFallbackIndex !== undefined ||
    plan.modelRouteHistory !== undefined ||
    plan.modelRoleProfiles !== undefined ||
    (modelFallbackProfiles !== undefined &&
      !parseModelFallbackProfiles(modelFallbackProfiles, modelProfile))
  ) {
    throw new Error("Invalid Sentinel fallback model profiles");
  }
  if (
    plan.plannerHeartbeatSeconds !== undefined ||
    (plannerHeartbeatSeconds !== undefined &&
      !validPlannerHeartbeatSeconds(plannerHeartbeatSeconds))
  ) throw new Error("Invalid Sentinel planner heartbeat interval");
  if (
    plan.modelProfile !== undefined ||
    (modelProfile !== undefined && !isSelectedModelProfile(modelProfile))
  ) {
    throw new Error("Invalid Sentinel assessment model profile");
  }
  if (
    timeoutSeconds !== undefined &&
    (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 ||
      timeoutSeconds > MAX_SENTINEL_RUN_TIMEOUT_SECONDS)
  ) throw new Error("Invalid Sentinel assessment timeout");
  const inventoryCoverageEnabled = linkedStart?.inventoryCoverageEnabled ??
    plan.inventoryCoverageEnabled;
  if (
    inventoryCoverageEnabled !== undefined &&
    typeof inventoryCoverageEnabled !== "boolean"
  ) {
    throw new Error("Invalid Sentinel inventory coverage setting");
  }
  const approval = linkedStart?.goalApproval;
  const formal = approval && formalGoalApprovalBinding(approval);
  if (
    approval && (approval.mode !== "start" ||
      approval.requestId !== linkedStart!.input.requestId ||
      approval.expectedRevision !== 0 ||
      approval.expectedRunId !== undefined ||
      !isDeepStrictEqual(
        formal?.planChanges,
        plan.goal === undefined ? {} : { goal: plan.goal },
      ))
  ) throw new Error("Invalid linked Sentinel goal approval");
  if (formal) validateActiveSentinelCriteria(formal.goals);
  const seedTask = parseSentinelLinkedSeedTask(linkedStart?.seedTask);
  if (linkedStart?.seedTask !== undefined && !seedTask) {
    throw new Error("Invalid linked Sentinel seed task");
  }
  const db = openStore(path, true)!;
  try {
    return withOperatorRunLinks(
      db,
      linkedStart?.path,
      () =>
        transact(db, () => {
          const row = getRow(db);
          if (linkedStart && row) {
            throw new Error("Sentinel case already has a run");
          }
          if (
            row?.active === 1 || row?.active === 2 ||
            row?.active === assessmentDeadlineReview
          ) {
            throw new Error("A Sentinel assessment is already active");
          }
          if (
            plan.goal !== undefined &&
            (typeof plan.goal !== "string" || !plan.goal.trim() ||
              plan.goal.length > 500)
          ) {
            throw new Error("Sentinel goal must contain 1–500 characters");
          }
          const {
            timeoutSeconds: _timeout,
            deadlineAt: _deadline,
            runInactiveAt: _inactive,
            spawnParent: _parent,
            ...settings
          } = plan;
          const startedAt = Date.now();
          const asJson = JSON.stringify({
            ...settings,
            runId: crypto.randomUUID(),
            admissionAt: nextAssessmentAdmission(),
            runStartedAt: startedAt,
            ...(linkedStart && { spawnParent: linkedStart.input.left }),
            ...(modelProfile && { modelProfile }),
            ...(modelFallbackProfiles && { modelFallbackProfiles }),
            ...(linkedCaseSources && { linkedCaseSources }),
            ...(childDescription !== undefined && { childDescription }),
            ...(formal && {
              goal: plan.goal ?? formal.goals[0].title,
              formalGoals: formal.goals,
              activeFormalGoalIds: formal.goals.map(({ id }) => id),
              completedFormalGoalIds: [],
            }),
            ...(inventoryCoverageEnabled !== undefined &&
              { inventoryCoverageEnabled }),
            ...(plannerHeartbeatSeconds !== undefined &&
              { plannerHeartbeatSeconds }),
            ...(timeoutSeconds !== undefined && {
              timeoutSeconds,
              deadlineAt: startedAt + timeoutSeconds * 1000,
            }),
          });
          if (
            formal
              ? new TextEncoder().encode(asJson).byteLength > MAX_SNAPSHOT_BYTES
              : asJson.length > 4096
          ) {
            throw new Error("Sentinel assessment plan is too large");
          }
          db.prepare(`
        INSERT INTO assessment VALUES (1, ?, 1, ?, '', ?, 'null')
        ON CONFLICT(id) DO UPDATE SET
          plan = excluded.plan, active = 1, fingerprint = '', result = 'null'
      `).run(asJson, row?.revision ?? 0, new Date(startedAt).toISOString());
          const started = refresh(
            db,
            getRow(db)!,
            path,
            webContainmentConfigured,
            undefined,
            false,
            linkedStart?.graphDigest,
            seedTask,
          );
          const membership = linkedStart?.membership;
          let constraints = formal?.constraints;
          if (membership) {
            if (
              membership.selector.kind !== "organization" ||
              !verifySentinelCaseMembership(
                started.result?.sharedGraph.snapshot,
                membership,
                {
                  caseId: linkedStart!.caseId,
                  evidenceRevision: started.revision,
                },
              ) ||
              (constraints?.allowedAssetIds !== undefined &&
                !isDeepStrictEqual(
                  constraints.allowedAssetIds,
                  membership.assetIds,
                ))
            ) {
              throw new Error(
                "Invalid or stale approved linked Sentinel membership",
              );
            }
            constraints = normalizeSentinelOperatingConstraints({
              ...(constraints ?? { deniedKinds: [] }),
              allowedAssetIds: membership.assetIds,
            });
          }
          if (
            seedTask && !sentinelOperatingConstraintsAllow(
              constraints,
              seedTask,
              started.result?.sharedGraph.snapshot,
            )
          ) {
            throw new Error(
              "The approved constraints prohibit the linked seed task",
            );
          }
          if (linkedStart && constraints) {
            saveInitialSentinelConstraints(
              db,
              started,
              linkedStart.input.requestId,
              constraints,
              membership,
            );
          }
          if (approval && formal) {
            saveFormalGoalRequest(db, approval, formal.binding, started);
          }
          if (linkedStart) {
            if (linkedStart.templateKey !== undefined) {
              if (!/^[a-f0-9]{64}$/.test(linkedStart.templateKey)) {
                throw new Error("Invalid linked Sentinel template version");
              }
              if (
                !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
                  .some(({ name }) => name === "linkedStartTemplateKey")
              ) {
                db.exec(
                  "ALTER TABLE assessment_run_revisions ADD COLUMN linkedStartTemplateKey TEXT",
                );
              }
              db.prepare(
                "UPDATE assessment_run_revisions SET linkedStartTemplateKey = ? WHERE revision = ?",
              ).run(linkedStart.templateKey, started.revision);
            }
            if (linkedStart.emptyCreationDigest !== undefined) {
              if (!/^[a-f0-9]{64}$/.test(linkedStart.emptyCreationDigest)) {
                throw new Error("Invalid linked Sentinel creation approval");
              }
              if (
                !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
                  .some(({ name }) => name === "emptyCreationDigest")
              ) {
                db.exec(
                  "ALTER TABLE assessment_run_revisions ADD COLUMN emptyCreationDigest TEXT",
                );
              }
              db.prepare(
                "UPDATE assessment_run_revisions SET emptyCreationDigest = ? WHERE revision = ?",
              ).run(linkedStart.emptyCreationDigest, started.revision);
            }
            if (plan.goal !== undefined) {
              if (
                !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
                  .some(({ name }) => name === "linkedStartGoalDigest")
              ) {
                db.exec(
                  "ALTER TABLE assessment_run_revisions ADD COLUMN linkedStartGoalDigest TEXT",
                );
              }
              db.prepare(
                "UPDATE assessment_run_revisions SET linkedStartGoalDigest = ? WHERE revision = ?",
              ).run(hashGoal(plan.goal), started.revision);
            }
            if (seedTask) {
              if (
                !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
                  .some(({ name }) => name === "linkedStartSeed")
              ) {
                db.exec(
                  "ALTER TABLE assessment_run_revisions ADD COLUMN linkedStartSeed TEXT",
                );
              }
              db.prepare(
                "UPDATE assessment_run_revisions SET linkedStartSeed = ? WHERE revision = ?",
              ).run(
                JSON.stringify({
                  task: seedTask,
                  requestId: crypto.randomUUID(),
                }),
                started.revision,
              );
            }
            recordOperatorRunLink(db, {
              ...linkedStart.input,
              origin: "spawn",
              right: {
                kind: "sentinel",
                id: linkedStart.caseId,
                revision: started.revision,
              },
            }, "run_links");
          }
          return started;
        }),
    );
  } finally {
    db.close();
  }
}

function normalizeFormalGoalPlan(
  raw: FormalGoalPlan | undefined,
): FormalGoalPlan {
  if (raw === undefined) return {};
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).some((key) =>
      ![
        "goal",
        "impactAsset",
        "traceNode",
        "evidenceNode",
        "depth",
        "inventoryCoverageEnabled",
        "childDescription",
        "assessmentTemplate",
      ].includes(key)
    )
  ) {
    throw new Error("Invalid approved Sentinel goal plan");
  }
  const {
    goal,
    impactAsset,
    traceNode,
    evidenceNode,
    depth,
    inventoryCoverageEnabled,
    childDescription,
    assessmentTemplate: rawTemplate,
  } = raw;
  const assessmentTemplate = parseSentinelAssessmentTemplateBinding(
    rawTemplate,
  );
  if (
    (rawTemplate === undefined) !== (childDescription === undefined) ||
    (rawTemplate !== undefined &&
      (!assessmentTemplate || !validSentinelChildDescription(childDescription)))
  ) throw new Error("Invalid approved Sentinel assessment template");
  if (
    inventoryCoverageEnabled !== undefined &&
    typeof inventoryCoverageEnabled !== "boolean"
  ) {
    throw new Error("Invalid Sentinel inventory coverage setting");
  }
  for (
    const [value, max] of [
      [goal, 500],
      [impactAsset, 4096],
      [traceNode, 4096],
      [evidenceNode, 4096],
    ] as const
  ) {
    if (
      value !== undefined && (typeof value !== "string" || !value.trim() ||
        value.length > max || value.includes("\x00"))
    ) {
      throw new Error("Invalid approved Sentinel goal plan");
    }
  }
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0)) {
    throw new Error("Invalid approved Sentinel goal plan depth");
  }
  return {
    goal: goal?.trim(),
    impactAsset,
    traceNode,
    evidenceNode,
    depth,
    inventoryCoverageEnabled,
    ...(assessmentTemplate && { assessmentTemplate, childDescription }),
  };
}

export interface SentinelWorkerGoalProposal {
  readonly id: string;
  readonly runId: string;
  readonly revision: number;
  readonly assignmentId: string;
  readonly targetId: string;
  readonly goal: SentinelFormalGoal;
}

function readWorkerGoalProposal(db: DatabaseSync, id: string) {
  if (!hasTable(db, "assessment_worker_goal_proposals")) return;
  const row = db.prepare(
    "SELECT record, acceptedRevision FROM assessment_worker_goal_proposals WHERE id = ?",
  ).get(id);
  return row && {
    ...(JSON.parse(String(row.record)) as SentinelWorkerGoalProposal),
    acceptedRevision: typeof row.acceptedRevision === "number"
      ? row.acceptedRevision
      : null,
  };
}

export function readSentinelWorkerGoalProposals(
  path: string,
  runId: string,
  revision: number,
) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    if (!hasTable(db, "assessment_worker_goal_proposals")) return [];
    return db.prepare(`
      SELECT id FROM assessment_worker_goal_proposals WHERE runId = ? AND revision = ?
      ORDER BY rowid DESC
    `).all(runId, revision).flatMap(({ id }) =>
      readWorkerGoalProposal(db, String(id)) ?? []
    );
  } finally {
    db.close();
  }
}

function workerGoalProposalId(
  runId: string,
  revision: number,
  assignmentId: string,
  requestId: string,
) {
  return "goal-proposal:" + createHash("sha256").update(JSON.stringify([
    runId,
    revision,
    assignmentId,
    requestId,
  ])).digest("hex");
}

export function readSentinelWorkerGoalProposalReceipt(
  path: string,
  scope: Pick<
    SentinelWorkerGoalProposal,
    "runId" | "revision" | "assignmentId" | "targetId"
  >,
  requestId: string,
): SentinelWorkerGoalProposal | undefined {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId)) return;
  return readSentinelWorkerGoalProposalTraceReceipt(
    path,
    scope,
    workerGoalProposalId(
      scope.runId,
      scope.revision,
      scope.assignmentId,
      requestId.toLowerCase(),
    ),
  );
}

/** Reopen the original proposal response independently of a later decision. */
export function readSentinelWorkerGoalProposalTraceReceipt(
  path: string,
  scope: Pick<
    SentinelWorkerGoalProposal,
    "runId" | "revision" | "assignmentId" | "targetId"
  >,
  id: string,
): SentinelWorkerGoalProposal | undefined {
  if (!/^goal-proposal:[a-f0-9]{64}$/.test(id)) return;
  const db = openStore(path, false);
  if (!db) return;
  try {
    const saved = readWorkerGoalProposal(db, id);
    if (
      !saved || saved.id !== id || saved.runId !== scope.runId ||
      saved.revision !== scope.revision ||
      saved.assignmentId !== scope.assignmentId ||
      saved.targetId !== scope.targetId
    ) return;
    const { acceptedRevision: _acceptedRevision, ...receipt } = saved;
    return receipt;
  } finally {
    db.close();
  }
}

export function recordSentinelWorkerGoalProposal(
  path: string,
  input: Omit<SentinelWorkerGoalProposal, "id"> & { requestId: string },
  authorize: () => boolean,
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (
        !row || row.active !== 1 || row.revision !== input.revision ||
        (JSON.parse(row.plan) as AssessmentPlan).runId !== input.runId ||
        !authorize()
      ) return;
      const { requestId, ...fields } = input;
      const id = workerGoalProposalId(
        input.runId,
        input.revision,
        input.assignmentId,
        requestId,
      );
      const record = {
        id,
        ...fields,
        goal: normalizeSentinelFormalGoals([input.goal])[0],
      };
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_worker_goal_proposals (
        id TEXT PRIMARY KEY, runId TEXT NOT NULL, revision INTEGER NOT NULL,
        record TEXT NOT NULL, acceptedRevision INTEGER
      )`);
      const encoded = JSON.stringify(record);
      const prior = db.prepare(
        "SELECT record FROM assessment_worker_goal_proposals WHERE id = ?",
      ).get(id);
      if (prior) return prior.record === encoded ? record : undefined;
      const count = db.prepare(
        "SELECT COUNT(*) AS total FROM assessment_worker_goal_proposals WHERE runId = ?",
      ).get(input.runId);
      if (Number(count?.total) >= 128) return;
      db.prepare(
        "INSERT INTO assessment_worker_goal_proposals VALUES (?, ?, ?, ?, NULL)",
      )
        .run(id, input.runId, input.revision, encoded);
      return record;
    });
  } finally {
    db.close();
  }
}

function formalGoalApprovalBinding(approval: SentinelFormalGoalApproval) {
  const { mode, requestId, proposalDigest, expectedRevision, expectedRunId } =
    approval;
  if (
    (mode !== "start" && mode !== "append" && mode !== "revise" &&
      mode !== "withdraw") ||
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ||
    (expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
    (expectedRunId !== undefined &&
      (typeof expectedRunId !== "string" || expectedRunId.length > 128))
  ) throw new Error("Invalid Sentinel formal goal approval");
  const goals = normalizeSentinelFormalGoals(approval.goals);
  if (proposalDigest !== digestSentinelGoalProposal(goals)) {
    throw new Error(
      "The Sentinel goal proposal digest does not match its definitions",
    );
  }
  if (
    approval.sourceProposalId !== undefined &&
    (mode !== "append" ||
      !/^goal-proposal:[a-f0-9]{64}$/.test(approval.sourceProposalId))
  ) {
    throw new Error("Invalid Sentinel worker goal proposal source");
  }
  if (
    mode === "withdraw" && (goals.length !== 1 || approval.plan !== undefined)
  ) {
    throw new Error("Withdraw requires one exact registered Sentinel goal");
  }
  if (mode === "revise" && approval.plan !== undefined) {
    throw new Error("Revise changes only existing active formal goals");
  }
  if (approval.initialConstraints !== undefined && mode !== "start") {
    throw new Error("Initial operating constraints require a new assessment");
  }
  const constraints = approval.initialConstraints === undefined
    ? undefined
    : normalizeSentinelOperatingConstraints(approval.initialConstraints);
  const patch = normalizeFormalGoalPlan(approval.plan);
  if (mode !== "start" && patch.inventoryCoverageEnabled !== undefined) {
    throw new Error("Inventory coverage settings require a new assessment");
  }
  if (mode !== "start" && patch.assessmentTemplate) {
    throw new Error("Assessment templates require a new assessment");
  }
  const planChanges = JSON.parse(JSON.stringify(patch)) as FormalGoalPlan;
  const binding = createHash("sha256").update(JSON.stringify([
    mode,
    proposalDigest,
    expectedRevision ?? null,
    expectedRunId ?? null,
    planChanges,
    ...(approval.sourceProposalId ? [approval.sourceProposalId] : []),
    ...(constraints === undefined ? [] : [constraints]),
  ])).digest("hex");
  return { binding, goals, planChanges, constraints };
}

function validateActiveSentinelCriteria(goals: readonly SentinelFormalGoal[]) {
  if (goals.reduce((count, goal) => count + goal.criteria.length, 0) > 32) {
    throw new Error(
      "An active Sentinel goal set can contain at most 32 criteria",
    );
  }
}

function saveInitialSentinelConstraints(
  db: DatabaseSync,
  state: StoredAssessment,
  requestId: string,
  constraints?: SentinelOperatingConstraints,
  membership?: SentinelCaseMembershipProof,
) {
  if (constraints) {
    if (
      !state.result ||
      !validateSentinelOperatingConstraintAssets(
        constraints,
        state.result.sharedGraph.snapshot,
      )
    ) {
      throw new Error(
        "Initial operating constraints require published case assets.",
      );
    }
    const original = createHash("sha256").update(JSON.stringify([
      "assessment-initial-constraints",
      state.plan.runId,
      requestId,
    ])).digest("hex");
    const constraintRequestId = [
      original.slice(0, 8),
      original.slice(8, 12),
      original.slice(12, 16),
      original.slice(16, 20),
      original.slice(20, 32),
    ].join("-");
    ensureOperatingConstraintsTable(db);
    insertOperatingConstraintRecord(db, {
      runId: state.plan.runId!,
      evidenceRevision: state.revision,
      expectedVersion: 0,
      requestId: constraintRequestId,
      operatorScope: membership
        ? "linked-assessment-start"
        : "assessment-goal-start",
      ...(membership && { membership }),
      constraints,
      digest: digestSentinelOperatingConstraints(constraints),
      version: 1,
      recordedAt: state.updatedAt,
    });
  }
}

function ensureFormalGoalRequests(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_formal_goal_requests (
    requestId TEXT PRIMARY KEY, binding TEXT NOT NULL, appliedRevision INTEGER NOT NULL,
    proposalDigest TEXT NOT NULL, mode TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
  )`);
}

function saveFormalGoalRequest(
  db: DatabaseSync,
  approval: SentinelFormalGoalApproval,
  binding: string,
  state: StoredAssessment,
) {
  ensureFormalGoalRequests(db);
  db.prepare(
    "INSERT INTO assessment_formal_goal_requests VALUES (?, ?, ?, ?, ?, 'operator', ?)",
  ).run(
    approval.requestId,
    binding,
    state.revision,
    approval.proposalDigest,
    approval.mode,
    state.updatedAt,
  );
}

function readFormalGoalRequest(
  db: DatabaseSync,
  requestId: string,
  binding: string,
) {
  const prior = db.prepare(
    "SELECT binding, appliedRevision, at FROM assessment_formal_goal_requests WHERE requestId = ?",
  ).get(requestId);
  if (!prior) return undefined;
  if (prior.binding !== binding) {
    throw new Error(
      "A conflicting Sentinel goal approval already used this request ID",
    );
  }
  return {
    appliedRevision: Number(prior.appliedRevision),
    duplicate: true as const,
    actor: "operator" as const,
    at: String(prior.at),
  };
}

export function readSentinelFormalGoalApproval(
  path: string,
  approval: SentinelFormalGoalApproval,
) {
  const { binding } = formalGoalApprovalBinding(approval);
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (!hasTable(db, "assessment_formal_goal_requests")) return undefined;
    return readFormalGoalRequest(db, approval.requestId, binding);
  } finally {
    db.close();
  }
}

/** Apply a trusted operator approval and publish its new revision atomically. */
function publishSentinelGoalWithdrawal(
  db: DatabaseSync,
  row: AssessmentRow,
  plan: AssessmentPlan,
  encoded: string,
) {
  const result = JSON.parse(row.result) as Result | null;
  if (!result || (row.active !== 1 && row.active !== 2)) {
    throw new Error("There is no active or paused Sentinel evidence to amend");
  }
  const revision = row.revision + 1;
  const updatedAt = new Date().toISOString();
  db.prepare(
    "UPDATE assessment SET plan = ?, revision = ?, updatedAt = ? WHERE id = 1",
  )
    .run(encoded, revision, updatedAt);
  db.prepare("INSERT INTO assessment_history VALUES (?, ?, ?)")
    .run(revision, updatedAt, row.result);
  saveAssessmentRunRevision(db, revision, plan);
  saveFormalGoalHistory(db, revision, plan);
  carrySentinelReviews(db, "finding", row.revision, revision, () => [
    findingEvidenceSignatures(result),
    findingEvidenceSignatures(result),
  ]);
  if (hasAssessmentAlertHistory(db)) {
    db.prepare(
      "INSERT INTO assessment_alert_history SELECT ?, alerts FROM assessment_alert_history WHERE revision = ?",
    )
      .run(revision, row.revision);
    carrySentinelReviews(db, "incident", row.revision, revision, (subjects) => [
      incidentEvidenceSignatures(db, row.revision, result, subjects),
      incidentEvidenceSignatures(db, revision, result, subjects),
    ]);
  }
  pruneAssessmentRevisions(db, revision - 20);
  return readState(db, { ...row, plan: encoded, revision, updatedAt });
}

export function applySentinelFormalGoals(
  path: string,
  approval: SentinelFormalGoalApproval,
  webContainmentConfigured?: boolean,
  replayOnly = false,
): {
  readonly state: StoredAssessment;
  readonly appliedRevision: number;
  readonly duplicate: boolean;
  readonly actor: "operator";
  readonly at: string;
} {
  const { mode, requestId, proposalDigest, expectedRevision, expectedRunId } =
    approval;
  const { binding, goals, planChanges, constraints } =
    formalGoalApprovalBinding(approval);
  const db = openStore(path, true)!;
  try {
    return transact(db, () => {
      ensureFormalGoalRequests(db);
      const prior = readFormalGoalRequest(db, requestId, binding);
      const row = getRow(db);
      if (prior) {
        if (!row) {
          throw new Error("The approved Sentinel assessment is unavailable");
        }
        return { state: readState(db, row), ...prior };
      }
      if (replayOnly) {
        throw new Error(
          "This assessment template version is no longer current",
        );
      }
      const previousPlan = row ? JSON.parse(row.plan) as AssessmentPlan : {};
      if (
        (expectedRevision !== undefined &&
          expectedRevision !== (row?.revision ?? 0)) ||
        (expectedRunId !== undefined && expectedRunId !== previousPlan.runId)
      ) {
        throw new Error(
          "The Sentinel assessment changed after the goal proposal",
        );
      }
      if (
        mode === "start" && (row?.active === 1 || row?.active === 2 ||
          row?.active === assessmentDeadlineReview)
      ) {
        throw new Error("A Sentinel assessment is already active");
      }
      if (
        mode !== "start" &&
        (!row || ![1, 2, 3].includes(row.active) ||
          expectedRevision !== row.revision ||
          expectedRunId !== previousPlan.runId ||
          (previousPlan.deadlineAt !== undefined &&
            Date.now() >= previousPlan.deadlineAt))
      ) {
        throw new Error(
          "Goal changes require the exact active, paused or completed Sentinel assessment within its deadline",
        );
      }
      if (approval.sourceProposalId) {
        const proposal = readWorkerGoalProposal(db, approval.sourceProposalId);
        if (
          !proposal || proposal.acceptedRevision !== null ||
          proposal.runId !== expectedRunId ||
          proposal.revision !== expectedRevision ||
          digestSentinelGoalProposal([proposal.goal]) !== proposalDigest
        ) {
          throw new Error(
            "The worker goal proposal is stale or already accepted",
          );
        }
      }
      const current = mode === "start" ? {} : previousPlan;
      const existingGoals = current.formalGoals ?? [];
      const completedFormalGoalIds = current.completedFormalGoalIds ?? [];
      const pending = mode !== "start" && row?.active !== 3
        ? current.activeFormalGoalIds ?? existingGoals.map(({ id }) => id)
        : [];
      const replacements = new Map(goals.map((goal) => [goal.id, goal]));
      if (mode === "revise") {
        const prior: SentinelFormalGoal[] = [];
        for (const { id } of goals) {
          const goal = existingGoals.find((goal) => goal.id === id);
          if (
            !goal || !pending.includes(id) ||
            completedFormalGoalIds.includes(id)
          ) {
            throw new Error(
              "Revise requires existing active goals with no completion decision",
            );
          }
          prior.push(goal);
        }
        if (digestSentinelGoalProposal(prior) === proposalDigest) {
          throw new Error(
            "The approved Sentinel goal definitions are unchanged",
          );
        }
      }
      const withdrawn = mode === "withdraw" ? goals[0].id : undefined;
      if (
        withdrawn && (
          !pending.includes(withdrawn) ||
          completedFormalGoalIds.includes(withdrawn) ||
          !isDeepStrictEqual(
            existingGoals.find(({ id }) => id === withdrawn),
            goals[0],
          )
        )
      ) {
        throw new Error(
          "Withdraw requires the exact current active, uncompleted Sentinel goal",
        );
      }
      const formalGoals = mode === "revise"
        ? existingGoals.map((goal) => replacements.get(goal.id) ?? goal)
        : withdrawn
        ? existingGoals
        : [...existingGoals, ...goals];
      if (
        new Set(formalGoals.map(({ id }) => id)).size !== formalGoals.length
      ) {
        throw new Error(
          "The approved Sentinel goal IDs already exist in this assessment",
        );
      }
      const activeFormalGoalIds = withdrawn
        ? pending.filter((id) => id !== withdrawn)
        : mode === "revise"
        ? [...pending]
        : [...pending, ...goals.map(({ id }) => id)];
      const active = new Set(activeFormalGoalIds);
      validateActiveSentinelCriteria(
        formalGoals.filter(({ id }) => active.has(id)),
      );
      const plan: AssessmentPlan = {
        ...current,
        ...planChanges,
        goal: planChanges.goal ?? current.goal ?? goals[0].title,
        runId: current.runId ?? crypto.randomUUID(),
        ...(mode === "start" && { runStartedAt: Date.now() }),
        ...(row?.active !== 1 && !withdrawn &&
          { admissionAt: nextAssessmentAdmission() }),
        ...(withdrawn &&
          {
            withdrawnFormalGoalIds: [
              ...current.withdrawnFormalGoalIds ?? [],
              withdrawn,
            ],
          }),
        formalGoals,
        activeFormalGoalIds,
        completedFormalGoalIds,
      };
      const encoded = JSON.stringify(plan);
      if (new TextEncoder().encode(encoded).byteLength > MAX_SNAPSHOT_BYTES) {
        throw new Error("The Sentinel formal goal set is too large");
      }
      if (mode === "start") {
        db.prepare(`
          INSERT INTO assessment VALUES (1, ?, 1, ?, '', ?, 'null')
          ON CONFLICT(id) DO UPDATE SET
            plan = excluded.plan, active = 1, fingerprint = '', result = 'null'
        `).run(encoded, row?.revision ?? 0, new Date().toISOString());
      } else if (!withdrawn) {
        db.prepare("UPDATE assessment SET plan = ?, active = 1 WHERE id = 1")
          .run(encoded);
      }
      const state = withdrawn
        ? publishSentinelGoalWithdrawal(db, row!, plan, encoded)
        : refresh(
          db,
          getRow(db)!,
          path,
          webContainmentConfigured,
          undefined,
          true,
        );
      saveInitialSentinelConstraints(db, state, requestId, constraints);
      if (approval.sourceProposalId) {
        const prior = JSON.parse(row!.result) as Result;
        if (
          !isDeepStrictEqual(
            prior.sharedGraph.snapshot,
            state.result?.sharedGraph.snapshot,
          )
        ) {
          throw new Error(
            "Sentinel evidence changed after the worker goal proposal",
          );
        }
      }
      saveFormalGoalRequest(db, approval, binding, state);
      if (approval.sourceProposalId) {
        db.prepare(
          "UPDATE assessment_worker_goal_proposals SET acceptedRevision = ? WHERE id = ?",
        )
          .run(state.revision, approval.sourceProposalId);
      }
      return {
        state,
        appliedRevision: state.revision,
        duplicate: false,
        actor: "operator",
        at: state.updatedAt,
      };
    });
  } finally {
    db.close();
  }
}

/** Reactivate a stopped case and assess new evidence under its existing plan. */
export function continueSentinelAssessment(
  path: string,
  webContainmentConfigured?: boolean,
): StoredAssessment | undefined {
  return activateSentinelAssessment(path, 0, webContainmentConfigured);
}

/** Resume a paused case only if its published inputs can be evaluated. */
export function resumeSentinelAssessment(
  path: string,
  webContainmentConfigured?: boolean,
  expectedRevision?: number,
  expectedRunId?: string,
): StoredAssessment | undefined {
  return activateSentinelAssessment(
    path,
    2,
    webContainmentConfigured,
    expectedRevision,
    expectedRunId,
  );
}

function activateSentinelAssessment(
  path: string,
  priorState: 0 | 2,
  webContainmentConfigured?: boolean,
  expectedRevision?: number,
  expectedRunId?: string,
): StoredAssessment | undefined {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    return transact(db, () => {
      const row = getRow(db);
      const plan = row ? JSON.parse(row.plan) as AssessmentPlan : {};
      const { deadlineAt } = plan;
      if (
        row?.active !== priorState ||
        (expectedRevision !== undefined && row.revision !== expectedRevision) ||
        (expectedRunId !== undefined && plan.runId !== expectedRunId) ||
        (deadlineAt !== undefined && Date.now() >= deadlineAt)
      ) return undefined;
      const changed = db.prepare(
        "UPDATE assessment SET active = 1, plan = ? WHERE id = 1 AND active = ?",
      ).run(
        JSON.stringify({ ...plan, admissionAt: nextAssessmentAdmission() }),
        priorState,
      );
      if (!changed.changes) return undefined;
      return refresh(db, getRow(db)!, path, webContainmentConfigured);
    });
  } finally {
    db.close();
  }
}

export function refreshSentinelAssessment(
  path: string,
  webContainmentConfigured?: boolean,
  now?: Date,
) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    return transact(db, () => {
      const row = getRow(db, now?.getTime());
      return row
        ? refresh(db, row, path, webContainmentConfigured, now?.toISOString())
        : undefined;
    });
  } finally {
    db.close();
  }
}

export function readSentinelAssessment(path: string) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    const row = getRow(db);
    return row ? readState(db, row) : undefined;
  } finally {
    db.close();
  }
}

/** Keep assessment writers behind a synchronous commit to a related case store. */
export function withSentinelAssessmentWriteLock<T>(
  path: string,
  action: (state: StoredAssessment | undefined) => T,
): T {
  const db = openStore(path, false);
  if (!db) return action(undefined);
  try {
    return transact(db, () => {
      const row = getRow(db);
      return action(row ? readState(db, row) : undefined);
    });
  } finally {
    db.close();
  }
}

const constraintUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function decodeOperatingConstraint(row: {
  readonly record: unknown;
}): SentinelOperatingConstraintRecord {
  return JSON.parse(String(row.record)) as SentinelOperatingConstraintRecord;
}

function ensureOperatingConstraintsTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinel_operating_constraints (
      runId TEXT NOT NULL,
      version INTEGER NOT NULL,
      evidenceRevision INTEGER NOT NULL,
      requestId TEXT NOT NULL UNIQUE,
      record TEXT NOT NULL,
      PRIMARY KEY(runId, version)
    )
  `);
}

function insertOperatingConstraintRecord(
  db: DatabaseSync,
  record: SentinelOperatingConstraintRecord,
) {
  const { runId, evidenceRevision, requestId, version } = record;
  saveAssessmentRunRevision(db, evidenceRevision, { runId });
  db.prepare(
    "INSERT INTO sentinel_operating_constraints VALUES (?, ?, ?, ?, ?)",
  ).run(runId, version, evidenceRevision, requestId, JSON.stringify(record));
}

/** Commit a confirmed constraint version on the same lock as case/evidence writers. */
export function recordSentinelOperatingConstraints(
  path: string,
  raw: SentinelOperatingConstraintUpdate,
): SentinelOperatingConstraintRecord | undefined {
  const {
    runId,
    evidenceRevision,
    expectedVersion,
    requestId,
    operatorScope,
    membership,
  } = raw;
  if (
    typeof runId !== "string" || !constraintUuid.test(runId) ||
    typeof requestId !== "string" || !constraintUuid.test(requestId) ||
    typeof operatorScope !== "string" || !operatorScope.trim() ||
    operatorScope.length > 256 || operatorScope.includes("\0") ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    expectedVersion >= Number.MAX_SAFE_INTEGER
  ) return undefined;
  const constraints = normalizeSentinelOperatingConstraints(raw.constraints);
  const digest = digestSentinelOperatingConstraints(constraints);
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    return transact(db, () => {
      ensureOperatingConstraintsTable(db);
      const replay = db.prepare(
        "SELECT record FROM sentinel_operating_constraints WHERE requestId = ?",
      ).get(requestId);
      if (replay) {
        const prior = decodeOperatingConstraint({ record: replay.record });
        return prior.runId === runId &&
            prior.evidenceRevision === evidenceRevision &&
            prior.expectedVersion === expectedVersion &&
            prior.operatorScope === operatorScope &&
            prior.digest === digest &&
            isDeepStrictEqual(prior.membership, membership)
          ? prior
          : undefined;
      }
      const row = getRow(db);
      if (
        !row || (row.active !== 1 && row.active !== 2) ||
        row.revision !== evidenceRevision
      ) {
        return undefined;
      }
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      if (plan.runId !== runId) return undefined;
      const priorVersion = db.prepare(
        "SELECT MAX(version) AS version FROM sentinel_operating_constraints WHERE runId = ?",
      ).get(runId)?.version;
      if (Number(priorVersion ?? 0) !== expectedVersion) return undefined;
      const current = JSON.parse(row.result) as Result | null;
      if (
        !validateSentinelOperatingConstraintAssets(
          constraints,
          current?.sharedGraph.snapshot,
        )
      ) {
        return undefined;
      }
      if (membership !== undefined) {
        const caseId = locateSentinelCase(path)?.caseId;
        if (
          !caseId || !verifySentinelCaseMembership(
            current?.sharedGraph.snapshot,
            membership,
            { caseId, evidenceRevision },
          ) ||
          !isDeepStrictEqual(membership.assetIds, constraints.allowedAssetIds)
        ) {
          return undefined;
        }
      }
      if (membership?.selector.kind === "addition") {
        const priorRow = db.prepare(
          "SELECT record FROM sentinel_operating_constraints WHERE runId = ? AND version = ?",
        ).get(runId, expectedVersion);
        const prior = priorRow &&
          decodeOperatingConstraint({ record: priorRow.record });
        if (
          !prior?.membership ||
          (!isDeepStrictEqual(prior.membership, membership) &&
            (!isDeepStrictEqual(
              prior.constraints.allowedAssetIds,
              membership.selector.baselineAssetIds,
            ) ||
              !isDeepStrictEqual(constraints, {
                ...prior.constraints,
                allowedAssetIds: membership.assetIds,
              })))
        ) return;
      }
      const record = {
        runId,
        evidenceRevision,
        expectedVersion,
        requestId,
        operatorScope,
        constraints,
        ...(membership !== undefined && { membership }),
        digest,
        version: expectedVersion + 1,
        recordedAt: new Date().toISOString(),
      };
      insertOperatingConstraintRecord(db, record);
      return record;
    });
  } finally {
    db.close();
  }
}

function operatingConstraintRecords(
  path: string,
  runId: string | undefined,
  limit: number,
  throughRevision?: number,
  version?: number,
): SentinelOperatingConstraintRecord[] {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    if (!hasTable(db, "sentinel_operating_constraints")) return [];
    const id = runId ??
      (JSON.parse(getRow(db)?.plan ?? "{}") as AssessmentPlan).runId;
    if (!id || !constraintUuid.test(id)) return [];
    const rows = version === undefined
      ? db.prepare(
        "SELECT record FROM sentinel_operating_constraints WHERE runId = ? AND evidenceRevision <= ? ORDER BY version DESC LIMIT ?",
      ).all(id, throughRevision ?? Number.MAX_SAFE_INTEGER, limit)
      : db.prepare(
        "SELECT record FROM sentinel_operating_constraints WHERE runId = ? AND version = ?",
      ).all(id, version);
    return rows.map((row) => decodeOperatingConstraint({ record: row.record }));
  } finally {
    db.close();
  }
}

/** Read the latest policy for a case run, optionally through a saved evidence revision. */
export function readSentinelOperatingConstraints(
  path: string,
  runId?: string,
  throughRevision?: number,
): SentinelOperatingConstraintRecord | undefined {
  if (
    throughRevision !== undefined &&
    (!Number.isSafeInteger(throughRevision) || throughRevision < 1)
  ) return undefined;
  return operatingConstraintRecords(path, runId, 1, throughRevision)[0];
}

export function readSentinelOperatingConstraintVersion(
  path: string,
  runId: string,
  version: number,
): SentinelOperatingConstraintRecord | undefined {
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return operatingConstraintRecords(path, runId, 1, undefined, version)[0];
}

/** Bind a linked run to its original empty-graph creation approval. */
export function readSentinelEmptyCreationDigest(
  path: string,
  revision: number,
): string | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    if (!hasTable(db, "assessment_run_revisions")) return;
    const digest = db.prepare(
      "SELECT * FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision)?.emptyCreationDigest;
    if (digest == null) return;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Invalid saved linked Sentinel creation approval");
    }
    return digest;
  } finally {
    db.close();
  }
}

/** Read the title for this exact saved assessment revision. */
export function readSentinelChildDescription(
  path: string,
  revision: number,
): string | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    const description: unknown = current?.revision === revision
      ? (JSON.parse(current.plan) as AssessmentPlan).childDescription
      : hasTable(db, "assessment_run_revisions")
      ? db.prepare(
        "SELECT * FROM assessment_run_revisions WHERE revision = ?",
      ).get(revision)?.childDescription
      : undefined;
    if (description == null) return;
    if (!validSentinelChildDescription(description)) {
      throw new Error("Invalid saved linked Sentinel description");
    }
    return description;
  } finally {
    db.close();
  }
}

/** Compare the exact template-version binding saved at linked admission. */
export function matchesSentinelLinkedStartTemplate(
  path: string,
  revision: number,
  templateKey: string | undefined,
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    const row = hasTable(db, "assessment_run_revisions")
      ? db.prepare("SELECT * FROM assessment_run_revisions WHERE revision = ?")
        .get(revision)
      : undefined;
    return (row?.linkedStartTemplateKey ?? undefined) === templateKey;
  } finally {
    db.close();
  }
}

/** Reopen the approved first assignment and its durable request identity. */
export function readSentinelLinkedStartSeed(
  path: string,
  revision: number,
): { requestId: string; task: SentinelLinkedSeedTask } | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    if (
      !hasTable(db, "assessment_run_revisions") ||
      !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
        .some(({ name }) => name === "linkedStartSeed")
    ) return;
    const saved = db.prepare(
      "SELECT linkedStartSeed FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision)?.linkedStartSeed;
    if (saved == null) return;
    const { requestId, task: raw } = JSON.parse(String(saved));
    const task = parseSentinelLinkedSeedTask(raw);
    if (
      typeof requestId !== "string" || !constraintUuid.test(requestId) || !task
    ) {
      throw new Error("Invalid saved Sentinel seed task");
    }
    return { requestId, task };
  } finally {
    db.close();
  }
}

function hashGoal(goal: string): string {
  return createHash("sha256").update(goal).digest("hex");
}

/** Match the originally approved goal even after the assessment advances. */
export function matchesSentinelLinkedStartGoal(
  path: string,
  revision: number,
  goal?: string,
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    if (
      !hasTable(db, "assessment_run_revisions") ||
      !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
        .some(({ name }) => name === "linkedStartGoalDigest")
    ) return goal === undefined;
    const digest = db.prepare(
      "SELECT linkedStartGoalDigest FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision)?.linkedStartGoalDigest ?? undefined;
    return digest === (goal === undefined ? undefined : hashGoal(goal));
  } finally {
    db.close();
  }
}

export function readSentinelRunTimeoutForRevision(
  path: string,
  revision: number,
): number | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    if (current?.revision === revision) {
      return (JSON.parse(current.plan) as AssessmentPlan).timeoutSeconds;
    }
    if (!hasTable(db, "assessment_run_revisions")) return;
    // Legacy rows lack timeout metadata and represent unlimited runs.
    const row = db.prepare(
      "SELECT * FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision);
    return typeof row?.timeoutSeconds === "number"
      ? row.timeoutSeconds
      : undefined;
  } finally {
    db.close();
  }
}

/** Read authoritative run identity for an available exact evidence revision. */
export function readSentinelRunIdForRevision(
  path: string,
  revision: number,
): string | undefined {
  if (!Number.isSafeInteger(revision) || revision < 1) return;
  const db = openStore(path, false);
  if (!db) return;
  try {
    if (
      !db.prepare("SELECT 1 FROM assessment_history WHERE revision = ?").get(
        revision,
      )
    ) return;
    const current = getRow(db);
    const runId = current?.revision === revision
      ? (JSON.parse(current.plan) as AssessmentPlan).runId
      : (hasTable(db, "assessment_run_revisions")
        ? db.prepare(
          "SELECT runId FROM assessment_run_revisions WHERE revision = ?",
        ).get(revision)?.runId
        : undefined) ?? readFormalGoalHistory(db, revision)?.plan.runId;
    return typeof runId === "string" && constraintUuid.test(runId)
      ? runId
      : undefined;
  } finally {
    db.close();
  }
}

/** Reopen the reviewed read-only source cases for the exact child revision. */
export function readSentinelLinkedSourcesForRevision(
  path: string,
  revision: number,
): readonly SentinelLinkedCaseSource[] | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    let raw: unknown;
    if (current?.revision === revision) {
      raw = (JSON.parse(current.plan) as AssessmentPlan).linkedCaseSources;
    } else if (hasTable(db, "assessment_run_revisions")) {
      const encoded = db.prepare(
        "SELECT * FROM assessment_run_revisions WHERE revision = ?",
      ).get(revision)?.linkedCaseSources;
      raw = typeof encoded === "string"
        ? JSON.parse(encoded)
        : encoded ?? undefined;
    }
    if (raw === undefined) return;
    const sources = parseSentinelLinkedCaseSources(raw);
    if (!sources) throw new Error("Invalid saved linked Sentinel case sources");
    return sources;
  } finally {
    db.close();
  }
}

/** Reopen the optional inventory coverage policy for one evidence revision. */
export function readSentinelInventoryCoverageForRevision(
  path: string,
  revision?: number,
): boolean | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    if (current && (revision === undefined || current.revision === revision)) {
      return (JSON.parse(current.plan) as AssessmentPlan)
        .inventoryCoverageEnabled;
    }
    if (
      revision === undefined ||
      !hasTable(db, "assessment_run_revisions") ||
      !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
        .some(({ name }) => name === "inventoryCoverageEnabled")
    ) return;
    const value = db.prepare(
      "SELECT inventoryCoverageEnabled FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision)?.inventoryCoverageEnabled;
    if (value == null) return;
    if (value !== 0 && value !== 1) {
      throw new Error("Invalid saved Sentinel inventory coverage setting");
    }
    return value === 1;
  } finally {
    db.close();
  }
}

/** Reopen the reviewed planner heartbeat override for an exact saved revision. */
export function readSentinelPlannerHeartbeatForRevision(
  path: string,
  revision: number,
): number | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    if (current?.revision === revision) {
      return (JSON.parse(current.plan) as AssessmentPlan)
        .plannerHeartbeatSeconds;
    }
    if (
      !hasTable(db, "assessment_run_revisions") ||
      !db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
        .some(({ name }) => name === "plannerHeartbeatSeconds")
    ) return;
    const value = db.prepare(
      "SELECT plannerHeartbeatSeconds FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision)?.plannerHeartbeatSeconds;
    if (value == null) return;
    if (!validPlannerHeartbeatSeconds(value)) {
      throw new Error("Invalid saved Sentinel planner heartbeat interval");
    }
    return value;
  } finally {
    db.close();
  }
}

/** Read the immutable approval for each alternate in the exact saved revision. */
export function readSentinelFallbackModelsForRevision(
  path: string,
  revision: number,
) {
  const primary = readSentinelModelProfileForRevision(path, revision);
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    const encoded = current?.revision === revision
      ? undefined
      : hasTable(db, "assessment_run_revisions")
      ? db.prepare("SELECT * FROM assessment_run_revisions WHERE revision = ?")
        .get(revision)?.modelFallbackProfiles
      : undefined;
    const raw = current?.revision === revision
      ? (JSON.parse(current.plan) as AssessmentPlan).modelFallbackProfiles
      : typeof encoded === "string"
      ? JSON.parse(encoded)
      : encoded ?? undefined;
    if (raw === undefined) return;
    const fallbackProfiles = parseModelFallbackProfiles(raw, primary);
    if (!fallbackProfiles) {
      throw new Error("Invalid saved Sentinel fallback model profiles");
    }
    return fallbackProfiles;
  } finally {
    db.close();
  }
}

function savedModelRoute(plan: AssessmentPlan, revision: number) {
  const route = parseSentinelModelRoute({
    primary: plan.modelProfile,
    alternates: plan.modelFallbackProfiles,
    activeIndex: plan.modelFallbackIndex ?? 0,
    roles: plan.modelRoleProfiles,
  });
  const history = plan.modelRouteHistory ?? [];
  if (
    !route || !plan.runId || (plan.modelRouteHistory !== undefined &&
      !validSentinelModelRouteHistory(
        plan.modelRouteHistory,
        plan.runId,
        revision,
        route,
      ))
  ) return;
  return { route, history, version: history.length };
}

export function readSentinelModelRoute(
  path: string,
  scope: { readonly runId: string; readonly revision: number },
) {
  const current = readSentinelAssessment(path);
  if (
    !current || current.revision !== scope.revision ||
    current.plan.runId !== scope.runId
  ) return;
  const saved = savedModelRoute(current.plan, current.revision);
  return saved && {
    ...saved,
    runnable: current.active && !current.paused &&
      (current.plan.deadlineAt === undefined ||
        Date.now() < current.plan.deadlineAt),
  };
}

/** Commit one exact approved update, independent of model call and worker state. */
export function replaceSentinelModelRoute(
  path: string,
  scope: { readonly runId: string; readonly revision: number },
  input: {
    readonly requestId: string;
    readonly expectedVersion: number;
    readonly before: SentinelModelRoute;
    readonly after: SentinelModelRoute;
  },
) {
  const after = parseSentinelModelRoute(input.after);
  if (!after || !constraintUuid.test(input.requestId)) return;
  const db = openStore(path, false);
  if (!db) return;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (!row || row.revision !== scope.revision) return;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      if (plan.runId !== scope.runId) return;
      const current = savedModelRoute(plan, row.revision);
      if (!current) return;
      const prior = current.history.find(({ requestId }) =>
        requestId === input.requestId
      );
      if (prior) {
        return prior.version === input.expectedVersion + 1 &&
            isDeepStrictEqual(prior.after, after)
          ? prior
          : undefined;
      }
      if (
        input.expectedVersion !== current.version ||
        current.history.length >= sentinelModelRouteEditLimit ||
        !isDeepStrictEqual(input.before, current.route) ||
        isDeepStrictEqual(current.route, after)
      ) return;
      const applied: SentinelModelRouteEdit = {
        requestId: input.requestId,
        runId: scope.runId,
        revision: scope.revision,
        version: current.version + 1,
        operator: "owner",
        approvedAt: new Date().toISOString(),
        before: current.route,
        after,
      };
      db.prepare("UPDATE assessment SET plan = ? WHERE id = 1").run(
        JSON.stringify({
          ...plan,
          modelProfile: after.primary,
          modelFallbackProfiles: after.alternates,
          modelFallbackIndex: after.activeIndex || undefined,
          modelRouteHistory: [...current.history, applied],
          modelRoleProfiles: after.roles,
        }),
      );
      return applied;
    });
  } finally {
    db.close();
  }
}

/** Linked start receipts bind initial approved choices even when the active route changes. */
export function readSentinelLinkedStartModelRoute(
  path: string,
  revision: number,
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    if (!hasTable(db, "assessment_run_revisions")) return;
    const stored = db.prepare(
      "SELECT * FROM assessment_run_revisions WHERE revision = ?",
    ).get(revision);
    return stored && parseSentinelModelRoute({
      primary: typeof stored.modelProfile === "string"
        ? JSON.parse(stored.modelProfile)
        : undefined,
      alternates: typeof stored.modelFallbackProfiles === "string"
        ? JSON.parse(stored.modelFallbackProfiles)
        : undefined,
      activeIndex: 0,
    });
  } finally {
    db.close();
  }
}

/** Advance once, leaving the approved model choices and evidence revision intact. */
export function advanceSentinelModelFallback(
  path: string,
  scope: {
    readonly runId: string;
    readonly revision: number;
    readonly allowInactive?: boolean;
  },
  failedIndex: number,
  expectedVersion = 0,
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (
        !row || (row.active !== 1 && !scope.allowInactive) ||
        row.revision !== scope.revision
      ) return;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      const fallbacks = parseModelFallbackProfiles(
        plan.modelFallbackProfiles,
        plan.modelProfile,
      );
      const index = plan.modelFallbackIndex ?? 0;
      if (
        plan.runId !== scope.runId || !fallbacks ||
        (plan.modelRouteHistory?.length ?? 0) !== expectedVersion ||
        (!scope.allowInactive && plan.deadlineAt !== undefined &&
          Date.now() >= plan.deadlineAt) ||
        !Number.isSafeInteger(failedIndex) || failedIndex < 0 ||
        failedIndex >= fallbacks.length || !Number.isSafeInteger(index) ||
        index < failedIndex || index > fallbacks.length
      ) return;
      if (index > failedIndex) return index;
      const next = index + 1;
      db.prepare("UPDATE assessment SET plan = ? WHERE id = 1").run(
        JSON.stringify({ ...plan, modelFallbackIndex: next }),
      );
      return next;
    });
  } finally {
    db.close();
  }
}

/** Reopen the immutable selected model for an exact saved revision. */
export function readSentinelModelProfileForRevision(
  path: string,
  revision: number,
): SelectedModelProfile | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const current = getRow(db);
    let profile: unknown;
    if (current?.revision === revision) {
      profile = (JSON.parse(current.plan) as AssessmentPlan).modelProfile;
    } else if (
      hasTable(db, "assessment_run_revisions") &&
      db.prepare("PRAGMA table_info(assessment_run_revisions)").all()
        .some(({ name }) => name === "modelProfile")
    ) {
      const encoded = db.prepare(
        "SELECT modelProfile FROM assessment_run_revisions WHERE revision = ?",
      ).get(revision)?.modelProfile;
      profile = typeof encoded === "string"
        ? JSON.parse(encoded)
        : encoded ?? undefined;
    }
    if (profile === undefined) return;
    if (!isSelectedModelProfile(profile)) {
      throw new Error("Invalid saved Sentinel assessment model profile");
    }
    return profile;
  } finally {
    db.close();
  }
}

/** Select the latest constraint policy for one authoritatively bound saved revision. */
export function readSentinelOperatingConstraintsForRevision(
  path: string,
  revision: number,
): SentinelOperatingConstraintRecord | undefined {
  if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (!hasTable(db, "sentinel_operating_constraints")) return undefined;
    const saved = db.prepare(
      "SELECT result FROM assessment_history WHERE revision = ?",
    ).get(revision);
    if (!saved) return undefined;
    const current = getRow(db);
    let runId: unknown;
    if (current?.revision === revision) {
      runId = (JSON.parse(current.plan) as AssessmentPlan).runId;
    } else {
      runId = (hasTable(db, "assessment_run_revisions")
        ? db.prepare(
          "SELECT runId FROM assessment_run_revisions WHERE revision = ?",
        ).get(revision)?.runId
        : undefined) ?? readFormalGoalHistory(db, revision)?.plan.runId;
    }
    if (!runId) {
      // Legacy ordinary archives can bind only an exact approved membership
      // record for this revision. Do not infer any adjacent revision's run.
      const caseId = locateSentinelCase(path)?.caseId;
      if (!caseId) return undefined;
      const scope = { caseId, evidenceRevision: revision };
      const snapshot = (JSON.parse(String(saved.result)) as Result | null)
        ?.sharedGraph.snapshot;
      const anchors = new Set(
        db.prepare(
          "SELECT record FROM sentinel_operating_constraints WHERE evidenceRevision = ?",
        ).all(revision).flatMap(({ record }) => {
          const candidate = decodeOperatingConstraint({ record });
          return verifySentinelCaseMembership(
              snapshot,
              candidate.membership,
              scope,
            )
            ? [candidate.runId]
            : [];
        }),
      );
      if (anchors.size !== 1) return undefined;
      [runId] = anchors;
    }
    if (typeof runId !== "string" || !constraintUuid.test(runId)) {
      return undefined;
    }
    const row = db.prepare(
      "SELECT record FROM sentinel_operating_constraints WHERE runId = ? AND evidenceRevision <= ? ORDER BY version DESC LIMIT 1",
    ).get(runId, revision);
    return row && decodeOperatingConstraint({ record: row.record });
  } finally {
    db.close();
  }
}

export function readSentinelOperatingConstraintHistory(
  path: string,
  runId: string,
  limit = 30,
  throughRevision?: number,
): SentinelOperatingConstraintRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid Sentinel operating constraint history limit");
  }
  if (
    throughRevision !== undefined &&
    (!Number.isSafeInteger(throughRevision) || throughRevision < 1)
  ) return [];
  return operatingConstraintRecords(path, runId, limit, throughRevision);
}

function saveAssessmentGoalCompletion(
  db: DatabaseSync,
  row: AssessmentRow,
  plan: AssessmentPlan,
  reason: string,
  at: string,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_goal_completion (
    revision INTEGER PRIMARY KEY, goal TEXT, note TEXT NOT NULL, at TEXT NOT NULL
  )`);
  db.prepare("INSERT INTO assessment_goal_completion VALUES (?, ?, ?, ?)")
    .run(row.revision, plan.goal ?? null, reason, at);
  if (plan.formalGoals) {
    const activeFormalGoalIds = plan.activeFormalGoalIds ?? [];
    const closedPlan: AssessmentPlan = {
      ...plan,
      activeFormalGoalIds: [],
      completedFormalGoalIds: [
        ...new Set([
          ...(plan.completedFormalGoalIds ?? []),
          ...activeFormalGoalIds,
        ]),
      ],
    };
    saveFormalGoalHistory(db, row.revision, closedPlan, activeFormalGoalIds);
    db.prepare(
      "UPDATE assessment SET plan = ?, active = 3, updatedAt = ? WHERE id = 1",
    )
      .run(JSON.stringify(closedPlan), at);
  } else {
    db.prepare(
      "UPDATE assessment SET active = 3, updatedAt = ? WHERE id = 1",
    )
      .run(at);
  }
}

/** Apply the cutoff exactly once using a trusted local evidence review. */
export function settleSentinelAssessmentDeadline(
  path: string,
  verifyGoal: (state: StoredAssessment, deadlineAt: number) => boolean,
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (row?.active !== assessmentDeadlineReview) return false;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      const deadlineAt = plan.deadlineAt;
      const state = readState(db, row);
      if (
        deadlineAt !== undefined && state.result &&
        (!plan.formalGoals || !!plan.activeFormalGoalIds?.length) &&
        verifyGoal(state, deadlineAt)
      ) {
        saveAssessmentGoalCompletion(
          db,
          row,
          plan,
          "Verified committed automatic goal proof at the assessment deadline.",
          new Date(deadlineAt).toISOString(),
        );
      } else {
        db.prepare("UPDATE assessment SET active = ? WHERE id = 1")
          .run(SENTINEL_ASSESSMENT_TIMED_OUT);
      }
      return true;
    });
  } finally {
    db.close();
  }
}

/** Bind and commit a read-only follow-up while holding the exact completed case lock. */
export function reviewSentinelCompletedGraphFollowup(
  path: string,
  request: CompletedSentinelGraphFollowupRequest,
  approved?: {
    readonly binding: CompletedSentinelGraphFollowupBinding;
    readonly execute: (
      state: StoredAssessment,
      constraints?: SentinelOperatingConstraints,
    ) => CompletedSentinelGraphFollowupReceipt["observation"];
  },
  readFinding?: (
    state: StoredAssessment,
    finding: NonNullable<CompletedSentinelGraphFollowupRequest["finding"]>,
  ) => CompletedSentinelGraphFollowupBinding["findingFollowup"],
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (row?.active !== 3 || row.revision !== request.evidenceRevision) {
        return;
      }
      const state = readState(db, row);
      const completion = state.completion;
      const snapshot = state.result?.sharedGraph.snapshot;
      if (
        state.plan.runId !== request.runId || !completion || !snapshot ||
        state.plan.activeFormalGoalIds?.length ||
        !snapshot.nodes.some(({ id, kind }) =>
          id === request.nodeId && kind === "asset"
        )
      ) return;
      const policy = readSentinelOperatingConstraints(
        path,
        request.runId,
        state.revision,
      );
      if (
        !sentinelOperatingConstraintsAllow(
          policy?.constraints,
          request,
          snapshot,
        )
      ) return;
      const { finding, ...scope } = request;
      const findingFollowup = finding && request.kind === "trace"
        ? readFinding?.(state, finding)
        : undefined;
      if (finding && !findingFollowup) return;
      const binding: CompletedSentinelGraphFollowupBinding = {
        ...scope,
        ...(findingFollowup && { findingFollowup }),
        graphSha256: createHash("sha256").update(JSON.stringify(snapshot))
          .digest("hex"),
        completionSha256: createHash("sha256").update(
          JSON.stringify(completion),
        ).digest("hex"),
        constraintsVersion: policy?.version ?? 0,
      };
      if (hasTable(db, "assessment_completed_graph_followups")) {
        const saved = db.prepare(
          "SELECT receipt FROM assessment_completed_graph_followups WHERE requestId = ?",
        ).get(request.requestId);
        if (saved) {
          const receipt = JSON.parse(
            String(saved.receipt),
          ) as CompletedSentinelGraphFollowupReceipt;
          const {
            observation: _observation,
            completedAt: _completedAt,
            ...recorded
          } = receipt;
          return isDeepStrictEqual(recorded, binding) ? { receipt } : undefined;
        }
      }
      if (!approved) return { binding };
      if (!isDeepStrictEqual(approved.binding, binding)) return;
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_completed_graph_followups (
        requestId TEXT PRIMARY KEY, receipt TEXT NOT NULL
      ) STRICT`);
      if (
        Number(
          db.prepare(
            "SELECT COUNT(*) AS count FROM assessment_completed_graph_followups",
          ).get()?.count,
        ) >= 128
      ) return;
      const receipt = {
        ...binding,
        completedAt: new Date().toISOString(),
        observation: approved.execute(state, policy?.constraints),
      };
      db.prepare(
        "INSERT INTO assessment_completed_graph_followups VALUES (?, ?)",
      ).run(request.requestId, JSON.stringify(receipt));
      return { receipt };
    });
  } finally {
    db.close();
  }
}

/** Record an operator judgment against the exact evaluated revision and goal. */
export function completeSentinelAssessmentGoal(
  path: string,
  revision: number,
  expectedGoal: string | null,
  note: string,
  webContainmentConfigured?: boolean,
  verifyGoal?: (state: StoredAssessment) => boolean,
  completedFormalGoalIds?: readonly string[],
): boolean {
  const reason = note.trim();
  if (
    !Number.isSafeInteger(revision) || revision < 1 || !reason ||
    reason.length > 1000
  ) return false;
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (
        !row || (row.active !== 1 && row.active !== 2) ||
        row.revision !== revision || row.result === "null"
      ) return false;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      const goal = plan.goal ?? null;
      if (
        goal !== expectedGoal ||
        readAssessmentInputs(path, webContainmentConfigured).fingerprint !==
          row.fingerprint
      ) return false;
      const activeFormalGoalIds = plan.activeFormalGoalIds ?? [];
      if (plan.formalGoals) {
        if (
          !verifyGoal || !activeFormalGoalIds.length ||
          !Array.isArray(completedFormalGoalIds) ||
          completedFormalGoalIds.length !== activeFormalGoalIds.length ||
          !activeFormalGoalIds.every((id) =>
            completedFormalGoalIds.includes(id)
          )
        ) return false;
      } else if (completedFormalGoalIds?.length) return false;
      if (verifyGoal && !verifyGoal(readState(db, row))) return false;
      saveAssessmentGoalCompletion(
        db,
        row,
        plan,
        reason,
        new Date().toISOString(),
      );
      return true;
    });
  } finally {
    db.close();
  }
}

function markAssessmentInactive(
  db: DatabaseSync,
  row: AssessmentRow,
  plan: AssessmentPlan,
  active: 0 | 2,
): boolean {
  return db.prepare(
    "UPDATE assessment SET active = ?, plan = ? WHERE id = 1 AND active = ?",
  )
    .run(
      active,
      JSON.stringify({ ...plan, runInactiveAt: Date.now() }),
      row.active,
    ).changes === 1;
}

export function stopSentinelAssessment(
  path: string,
  expected?: { revision: number; runId: string },
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  let interruption: SentinelAssessmentInterruption | undefined;
  try {
    const applied = transact(db, () => {
      const row = getRow(db);
      if (!row) return false;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      if (
        expected &&
        (row.revision !== expected.revision || plan.runId !== expected.runId)
      ) return false;
      if (row.active === 0) return expected !== undefined;
      if (row.active !== 1 && row.active !== 2) return false;
      const stopped = markAssessmentInactive(db, row, plan, 0);
      if (stopped && plan.runId) {
        interruption = {
          runId: plan.runId,
          revision: row.revision,
          action: "stopped",
        };
      }
      return stopped;
    });
    if (interruption) notifySentinelAssessmentInterruption(path, interruption);
    return applied;
  } finally {
    db.close();
  }
}

export function readSentinelAssessmentHistory(path: string) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT revision, updatedAt, result FROM assessment_history ORDER BY revision DESC",
    ).all().map(({ revision, updatedAt, result }) => ({
      revision: Number(revision),
      updatedAt: String(updatedAt),
      summary: (JSON.parse(String(result)) as Result).summary,
    }));
  } finally {
    db.close();
  }
}

/** Read the revision picker index without decoding retained assessments. */
export function readSentinelAssessmentRevisionIndex(path: string) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT revision, updatedAt FROM assessment_history ORDER BY revision DESC",
    ).all().map(({ revision, updatedAt }) => ({
      revision: Number(revision),
      updatedAt: String(updatedAt),
    }));
  } finally {
    db.close();
  }
}

/** Claim at most two model reviews per revision and throttle new revisions. */
export function claimSentinelAssessmentReview(
  path: string,
  revision: number,
  task: string,
): string | undefined {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (row?.active !== 1 || row.revision !== revision) return undefined;
      const state = JSON.parse(row.result) as Result | null;
      if (
        !state?.tasks.some((item) =>
          item.id === task && item.status === "completed"
        )
      ) {
        return undefined;
      }
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      const recent = db.prepare(
        "SELECT 1 FROM assessment_reviews WHERE revision <> ? AND startedAt > ? LIMIT 1",
      ).get(revision, cutoff);
      const claims = Number(
        db.prepare(
          "SELECT count(*) AS count FROM assessment_reviews WHERE revision = ?",
        ).get(revision)?.count ?? 0,
      );
      if (recent || claims >= 2) return undefined;

      const claim = crypto.randomUUID();
      const inserted = db.prepare(
        "INSERT OR IGNORE INTO assessment_reviews VALUES (?, ?, ?, ?, NULL)",
      ).run(revision, task, claim, new Date().toISOString());
      return inserted.changes ? claim : undefined;
    });
  } finally {
    db.close();
  }
}

export function completeSentinelAssessmentReview(
  path: string,
  revision: number,
  task: string,
  claim: string,
  analysis: string,
  steps: readonly SentinelReviewStep[] = [],
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const state = getRow(db);
      if (state?.active !== 1 || state.revision !== revision) return false;
      const updated = Boolean(
        db.prepare(`
      UPDATE assessment_reviews SET analysis = ?
      WHERE revision = ? AND task = ? AND claim = ? AND analysis IS NULL
        AND EXISTS (SELECT 1 FROM assessment WHERE id = 1 AND active = 1 AND revision = ?)
    `).run(analysis.slice(0, 6000), revision, task, claim, revision).changes,
      );
      if (updated && steps.length) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS assessment_review_steps (revision INTEGER NOT NULL, task TEXT NOT NULL, steps TEXT NOT NULL, PRIMARY KEY(revision, task))",
        );
        db.prepare("INSERT INTO assessment_review_steps VALUES (?, ?, ?)").run(
          revision,
          task,
          JSON.stringify(
            steps.slice(0, 16).map((step) =>
              normalizeSentinelWorkflowReviewStep(step, revision)
            ),
          ),
        );
      }
      return updated;
    });
  } finally {
    db.close();
  }
}

function hasAssessmentAlertHistory(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_alert_history'",
    ).get(),
  );
}

export function hasSavedSentinelAlerts(
  path: string,
  revision: number,
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return hasAssessmentAlertHistory(db) && Boolean(
      db.prepare(
        "SELECT 1 FROM assessment_alert_history WHERE revision = ?",
      ).get(revision),
    );
  } finally {
    db.close();
  }
}

/** Read the normalized alert feed captured with a retained assessment. */
export function readSentinelAssessmentAlerts(path: string, revision: number) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (!hasAssessmentAlertHistory(db)) return undefined;
    const row = db.prepare(
      "SELECT alerts FROM assessment_alert_history WHERE revision = ?",
    ).get(revision);
    return row
      ? JSON.parse(String(row.alerts)) as ReturnType<
        typeof parseSentinelTelemetryAlert
      >[]
      : undefined;
  } finally {
    db.close();
  }
}

export function readSentinelAssessmentRevision(path: string, revision: number) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    const row = db.prepare(
      "SELECT revision, updatedAt, result FROM assessment_history WHERE revision = ?",
    ).get(revision);
    if (!row) return undefined;
    const formal = readFormalGoalHistory(db, revision)?.plan;
    return {
      revision,
      updatedAt: String(row.updatedAt),
      result: JSON.parse(String(row.result)) as Result,
      reviews: readReviews(db, revision),
      completion: readGoalCompletion(db, revision),
      ...(formal && {
        plan: formal,
        formalGoals: formal.formalGoals,
        activeFormalGoalIds: formal.activeFormalGoalIds,
        completedFormalGoalIds: formal.completedFormalGoalIds,
      }),
    };
  } finally {
    db.close();
  }
}

export function pauseSentinelAssessment(
  path: string,
  expectedRevision?: number,
  expectedRunId?: string,
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  let interruption: SentinelAssessmentInterruption | undefined;
  try {
    const applied = transact(db, () => {
      const row = getRow(db);
      if (
        row?.active !== 1 ||
        (expectedRevision !== undefined && row.revision !== expectedRevision) ||
        (expectedRunId !== undefined &&
          (JSON.parse(row.plan) as AssessmentPlan).runId !== expectedRunId)
      ) return false;
      const plan = JSON.parse(row.plan) as AssessmentPlan;
      const paused = markAssessmentInactive(db, row, plan, 2);
      if (paused && plan.runId) {
        interruption = {
          runId: plan.runId,
          revision: row.revision,
          action: "paused",
        };
      }
      return paused;
    });
    if (interruption) notifySentinelAssessmentInterruption(path, interruption);
    return applied;
  } finally {
    db.close();
  }
}

export function updateSentinelAssessmentGoal(
  path: string,
  goal: string,
): boolean {
  const text = goal.trim();
  if (!text || text.length > 500) {
    throw new Error("Sentinel goal must contain 1–500 characters");
  }
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (row?.active !== 1 && row?.active !== 2) return false;
      const plan: AssessmentPlan = JSON.parse(row.plan);
      if (plan.formalGoals) {
        throw new Error(
          "Use an approved Sentinel goal set to change formal goals",
        );
      }
      db.prepare("UPDATE assessment SET plan = ? WHERE id = 1")
        .run(JSON.stringify({ ...plan, goal: text }));
      return true;
    });
  } finally {
    db.close();
  }
}

/** Read case lifecycle without loading retained evidence. */
export function readSentinelCaseStatus(path: string, includeDiscovery = false) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    const read = () =>
      db.prepare(
        "SELECT plan, active, revision, updatedAt FROM assessment WHERE id = 1",
      ).get() as
        | Pick<AssessmentRow, "plan" | "active" | "revision" | "updatedAt">
        | undefined;
    const saved = read();
    const now = Date.now();
    const row = saved && (expireAssessmentRow(db, saved, now) ?? read());
    if (!row) return undefined;
    const plan = includeDiscovery
      ? JSON.parse(row.plan) as AssessmentPlan
      : undefined;
    const end = row.active === 1
      ? now
      : row.active === 0 || row.active === 2
      ? plan?.runInactiveAt
      : Date.parse(row.updatedAt);
    const start = plan?.runStartedAt;
    const timed = start !== undefined && Number.isSafeInteger(start) &&
      start >= 0 &&
      end !== undefined && Number.isSafeInteger(end) && end >= start &&
      end <= 8_640_000_000_000_000;
    const configured = plan?.modelFallbackIndex
      ? plan.modelFallbackProfiles?.[plan.modelFallbackIndex - 1]
      : plan?.modelProfile;
    return {
      ...(plan && {
        discovery: {
          runId: plan.runId,
          goal: plan.goal,
          modelProfile: configured,
          spawnParent: plan.spawnParent,
          ...(timed && {
            startedAt: new Date(start).toISOString(),
            ...(row.active !== 1 &&
              { elapsedThrough: new Date(end).toISOString() }),
            ...([0, 3, SENTINEL_ASSESSMENT_TIMED_OUT].includes(row.active) && {
              completedAt: new Date(end).toISOString(),
            }),
            elapsedSeconds: Math.floor((end - start) / 1000),
          }),
        },
      }),
      status: row.active === assessmentDeadlineReview
        ? "settling_timeout"
        : row.active === SENTINEL_ASSESSMENT_TIMED_OUT
        ? "timed_out"
        : row.active === 2
        ? "paused"
        : row.active === 1
        ? "running"
        : row.active === 3
        ? "completed"
        : "stopped",
      revision: Number(row.revision),
      updatedAt: String(row.updatedAt),
    };
  } finally {
    db.close();
  }
}

export function isSentinelAssessmentRunning(path: string): boolean {
  return readSentinelCaseStatus(path)?.status === "running";
}

/** Read the durable enqueue key without loading case evidence. */
export function readSentinelAssessmentAdmission(
  path: string,
): number | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const row = db.prepare(
      "SELECT plan, updatedAt FROM assessment WHERE id = 1",
    ).get();
    if (!row) return;
    const { admissionAt } = JSON.parse(String(row.plan)) as AssessmentPlan;
    if (
      typeof admissionAt === "number" && Number.isSafeInteger(admissionAt) &&
      admissionAt > 0
    ) {
      return admissionAt;
    }
    const legacy = db.prepare(
      "SELECT updatedAt FROM assessment_history ORDER BY revision ASC LIMIT 1",
    ).get();
    const at = Date.parse(String(legacy?.updatedAt ?? row.updatedAt));
    return Number.isFinite(at) ? at * 1000 : undefined;
  } finally {
    db.close();
  }
}

export function needsSentinelAssessmentCoordinator(path: string): boolean {
  const status = readSentinelCaseStatus(path)?.status;
  return status === "running" || status === "settling_timeout";
}

/** Find saved evidence nodes citing an exact published asset snapshot. */
export function readSentinelAssetSnapshotCitations(
  path: string,
  source: { caseId: string; digest: string; asset: string },
  limit: number,
  offset = 0,
) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    return db.prepare(`
      WITH results AS (
        SELECT revision, result FROM assessment
        UNION ALL
        SELECT revision, result FROM assessment_history
      )
      SELECT DISTINCT results.revision, json_extract(node.value, '$.id') AS evidenceId
      FROM results,
        json_each(results.result, '$.sharedGraph.snapshot.nodes') AS node,
        json_each(node.value, '$.relationshipSources') AS citation
      WHERE json_extract(node.value, '$.kind') = 'evidence'
        AND json_extract(citation.value, '$.caseId') = ?
        AND json_extract(citation.value, '$.snapshotDigest') = ?
        AND (? IN (json_extract(citation.value, '$.from'), json_extract(citation.value, '$.to')))
      ORDER BY results.revision DESC, evidenceId
      LIMIT ? OFFSET ?
    `).all(source.caseId, source.digest, source.asset, limit, offset).map((
      row,
    ) => ({
      revision: Number(row.revision),
      evidenceId: String(row.evidenceId),
    }));
  } finally {
    db.close();
  }
}

/** Find assessment reviews that consulted the exact archived asset snapshot. */
export function readAssessmentReviewSnapshotCitations(
  path: string,
  source: { caseId: string; digest: string; asset: string },
  limit: number,
  offset = 0,
) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    if (!hasReviewSteps(db)) return [];
    return db.prepare(`
      SELECT DISTINCT trace.revision, trace.task
      FROM assessment_review_steps trace
      JOIN assessment_reviews review USING (revision, task),
        json_each(trace.steps) AS step,
        json_each(step.value, '$.sourceSnapshots') AS citation
      WHERE review.analysis IS NOT NULL
        AND json_extract(step.value, '$.outcome') = 'returned'
        AND json_extract(citation.value, '$.caseId') = ?
        AND json_extract(citation.value, '$.snapshotDigest') = ?
        AND json_extract(citation.value, '$.assetId') = ?
      ORDER BY trace.revision DESC, trace.task
      LIMIT ? OFFSET ?
    `).all(source.caseId, source.digest, source.asset, limit, offset).map((
      row,
    ) => ({
      revision: Number(row.revision),
      focusId: `review:assessment:${row.task}`,
    }));
  } finally {
    db.close();
  }
}

/** Find archived source references in live and retained assessment results. */
export function readSentinelSourceSnapshotReferences(path: string) {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    const graphReferences = db.prepare(`
      WITH results AS (
        SELECT result FROM assessment
        UNION ALL
        SELECT result FROM assessment_history
      )
      SELECT DISTINCT
        json_extract(source.value, '$.caseId') AS caseId,
        json_extract(source.value, '$.snapshotDigest') AS digest
      FROM results,
        json_each(results.result, '$.sharedGraph.snapshot.nodes') AS node,
        json_each(node.value, '$.relationshipSources') AS source
      WHERE json_type(source.value, '$.snapshotDigest') = 'text'
    `).all();
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_review_steps'",
      ).get()
    ) return graphReferences;
    return [
      ...graphReferences,
      ...db.prepare(`
      SELECT DISTINCT json_extract(source.value, '$.caseId') AS caseId,
        json_extract(source.value, '$.snapshotDigest') AS digest
      FROM assessment_review_steps AS trace,
        json_each(trace.steps) AS step,
        json_each(json_array(
          json_extract(step.value, '$.sourceSnapshots'),
          json_extract(step.value, '$.aliasMapping.sources'),
          json_extract(step.value, '$.peerFinding.mappingSources')
        )) AS citations,
        json_each(citations.value) AS source
      WHERE json_type(source.value, '$.snapshotDigest') = 'text'
    `).all(),
    ];
  } finally {
    db.close();
  }
}

export const sentinelIncidentDispositions = [
  "investigating",
  "resolved",
  "dismissed",
  "requires_review",
] as const;
type IncidentDisposition = typeof sentinelIncidentDispositions[number];

export function recordSentinelIncidentReview(
  path: string,
  revision: number,
  incidentId: string,
  disposition: IncidentDisposition,
  note: string,
  requestId?: string,
): boolean {
  if (
    !Number.isSafeInteger(revision) || revision < 1 ||
    !/^incident:[0-9a-f]{64}$/.test(incidentId) ||
    !sentinelIncidentDispositions.includes(disposition) ||
    !note.trim() || note.length > 1000 ||
    (requestId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId))
  ) return false;
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const prior = requestId &&
        operatorReviewRequest(db, "incident", requestId);
      if (prior) {
        return prior.revision === revision && prior.subjectId === incidentId &&
          prior.disposition === disposition && prior.note === note.trim();
      }
      const row = getRow(db);
      if (
        (row?.active !== 1 && row?.active !== 2) || row.revision !== revision
      ) return false;
      const result: Result | null = JSON.parse(row.result);
      if (
        !result ||
        !incidentReviewCandidates(db, revision, result, new Set([incidentId]))
          .candidates.length
      ) return false;
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_incident_reviews (
        id INTEGER PRIMARY KEY,
        revision INTEGER NOT NULL,
        incidentId TEXT NOT NULL,
        disposition TEXT NOT NULL,
        note TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assessment_incident_reviews_by_incident
        ON assessment_incident_reviews(revision, incidentId, id);`);
      insertOperatorReview(
        db,
        "incident",
        revision,
        incidentId,
        disposition,
        note,
        requestId,
      );
      return true;
    });
  } finally {
    db.close();
  }
}

export interface SentinelIncidentReview {
  readonly id: number;
  readonly incidentId: string;
  readonly revision: number;
  readonly disposition: IncidentDisposition;
  readonly note: string;
  readonly at: string;
}

function hasReviewRequestColumn(db: DatabaseSync, kind: ReviewKind): boolean {
  return db.prepare(`PRAGMA table_info(assessment_${kind}_reviews)`)
    .all().some(({ name }) => name === "requestId");
}

function insertOperatorReview(
  db: DatabaseSync,
  kind: ReviewKind,
  revision: number,
  subjectId: string,
  disposition: string,
  note: string,
  requestId?: string,
) {
  const table = `assessment_${kind}_reviews`;
  if (requestId && !hasReviewRequestColumn(db, kind)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN requestId TEXT;
      CREATE UNIQUE INDEX ${table}_by_request ON ${table}(requestId);`);
  }
  db.prepare(`INSERT INTO ${table}
    (revision, ${kind}Id, disposition, note, at${
    requestId ? ", requestId" : ""
  })
    VALUES (?, ?, ?, ?, ?${requestId ? ", ?" : ""})`)
    .run(
      revision,
      subjectId,
      disposition,
      note.trim(),
      new Date().toISOString(),
      ...(requestId ? [requestId] : []),
    );
}

function operatorReviewRequest(
  db: DatabaseSync,
  kind: ReviewKind,
  requestId: string,
) {
  if (!hasReviewRequestColumn(db, kind)) return;
  const row = db.prepare(
    `SELECT id, revision, ${kind}Id AS subjectId, disposition, note, at
    FROM assessment_${kind}_reviews WHERE requestId = ?`,
  ).get(requestId);
  if (!row) return;
  return {
    id: Number(row.id),
    revision: Number(row.revision),
    subjectId: String(row.subjectId),
    disposition: String(row.disposition),
    note: String(row.note),
    at: String(row.at),
  };
}

export function readSentinelOperatorReviewRequest(
  path: string,
  kind: ReviewKind,
  requestId: string,
) {
  const db = openStore(path, false);
  if (!db) return;
  try {
    const row = operatorReviewRequest(db, kind, requestId);
    if (!row) return;
    const { subjectId, ...record } = row;
    return {
      subjectId,
      record: {
        ...record,
        ...(kind === "incident"
          ? { incidentId: subjectId }
          : { findingId: subjectId }),
      },
    };
  } finally {
    db.close();
  }
}

export function readSentinelIncidentReviews(
  path: string,
  revision: number,
  options?: { readonly fullHistory: boolean },
): SentinelIncidentReview[] {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    return readReviewRows(db, "incident", revision, options?.fullHistory).map(
      ({ subjectId, disposition, ...review }) => ({
        ...review,
        incidentId: subjectId,
        disposition: disposition as IncidentDisposition,
      }),
    );
  } finally {
    db.close();
  }
}

export { sentinelFindingDispositions };

export interface SentinelFindingReview {
  readonly id: number;
  readonly findingId: string;
  readonly revision: number;
  readonly disposition: typeof sentinelFindingDispositions[number];
  readonly note: string;
  readonly at: string;
}

type ReviewKind = "finding" | "incident";

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function findingEvidenceSignatures(result: Result | null): Map<string, string> {
  const graph = result?.sharedGraph.snapshot;
  if (!graph) return new Map();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const findings = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "finding") findings.set(node.id, [JSON.stringify(node)]);
  }
  for (const edge of graph.edges) {
    findings.get(edge.from)?.push(JSON.stringify([edge, nodes.get(edge.to)]));
    findings.get(edge.to)?.push(JSON.stringify([edge, nodes.get(edge.from)]));
  }
  return new Map(
    [...findings].map((
      [id, evidence],
    ) => [id, JSON.stringify(evidence.sort())]),
  );
}

function incidentReviewCandidates(
  db: DatabaseSync,
  revision: number,
  result: Result,
  subjects: ReadonlySet<string>,
) {
  const sampled = result.sharedGraph.observations.find(({ task }) =>
    task === "incident_correlation"
  )?.facts.candidates;
  const candidates = Array.isArray(sampled)
    ? sampled.filter(({ id }) => subjects.has(id))
    : [];
  const graph = result.sharedGraph.snapshot;
  const stored = hasTable(db, "assessment_alert_history")
    ? db.prepare(
      "SELECT alerts FROM assessment_alert_history WHERE revision = ?",
    ).get(revision)
    : undefined;
  const alerts = stored ? JSON.parse(String(stored.alerts)) : undefined;
  if (graph && alerts && candidates.length < subjects.size) {
    const existing = new Set(candidates.map(({ id }) => id));
    const report = correlateSentinelIncidents(alerts, {
      graph: loadSentinelGraph(graph),
    });
    for (const candidate of report.candidates) {
      if (subjects.has(candidate.id) && !existing.has(candidate.id)) {
        candidates.push(summarizeSentinelIncident(candidate));
      }
    }
  }
  return { candidates, graph, alerts };
}

function incidentEvidenceSignatures(
  db: DatabaseSync,
  revision: number,
  result: Result,
  subjects: ReadonlySet<string>,
) {
  const { candidates, graph, alerts } = incidentReviewCandidates(
    db,
    revision,
    result,
    subjects,
  );
  const signatures = new Map<string, string>();
  if (!alerts) return signatures;
  const nodes = new Map(graph?.nodes.map((node) => [node.id, node]));
  const findings = findingEvidenceSignatures(result);
  let legacyGraph: ReturnType<typeof loadSentinelGraph> | undefined;
  for (const candidate of candidates) {
    const {
      id,
      asset,
      alertReferences,
      findingIds,
      evidenceIds,
      alertCount,
      severity: _severity,
      ...details
    } = candidate;
    let members;
    if (alertReferences === undefined && graph) {
      legacyGraph ??= loadSentinelGraph(graph);
      members = recoverSentinelIncidentAlerts(alerts, id, legacyGraph);
    } else if (
      Array.isArray(alertReferences) && alertReferences.length === alertCount &&
      alertReferences.every((reference: unknown) =>
        typeof reference === "string"
      )
    ) {
      members = resolveSentinelIncidentAlerts(alerts, alertReferences);
    }
    if (!members || members.length !== alertCount) continue;
    const records = new Set<string>(evidenceIds);
    for (const alert of members) {
      for (const evidenceId of alert.evidenceIds) records.add(evidenceId);
    }
    const candidateDetails = Object.fromEntries(
      Object.entries(details).sort(([a], [b]) => a.localeCompare(b)),
    );
    signatures.set(
      id,
      JSON.stringify([
        [id, asset, findingIds, evidenceIds, alertCount, candidateDetails],
        members.map(({ sourceRecord: _sourceRecord, ...alert }) =>
          JSON.stringify(alert)
        ).sort(),
        nodes.get(asset),
        findingIds.map((findingId: string) => findings.get(findingId)),
        [...records].sort().map((evidenceId) => nodes.get(evidenceId)),
      ]),
    );
  }
  return signatures;
}

function carrySentinelReviews(
  db: DatabaseSync,
  kind: ReviewKind,
  priorRevision: number,
  revision: number,
  signatures: (
    subjects: ReadonlySet<string>,
  ) => [Map<string, string>, Map<string, string>],
): void {
  const table = `assessment_${kind}_reviews`;
  const carry = `assessment_${kind}_review_carry`;
  const subject = `${kind}Id`;
  if (!hasTable(db, table)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ${carry} (
    revision INTEGER NOT NULL,
    ${subject} TEXT NOT NULL,
    firstRevision INTEGER NOT NULL,
    PRIMARY KEY (revision, ${subject})
  );
  CREATE INDEX IF NOT EXISTS ${table}_by_subject
    ON ${table}(${subject}, revision, id)`);
  const eligible = db.prepare(`
    SELECT ${subject} AS subjectId, firstRevision FROM ${carry}
      WHERE revision = ?
    UNION ALL
    SELECT DISTINCT ${subject}, revision FROM ${table} AS review
      WHERE revision = ? AND NOT EXISTS (
        SELECT 1 FROM ${carry} AS carried
        WHERE carried.revision = review.revision AND carried.${subject} = review.${subject}
      )
  `).all(priorRevision, priorRevision);
  if (eligible.length) {
    const [before, after] = signatures(
      new Set(eligible.map(({ subjectId }) => String(subjectId))),
    );
    const insert = db.prepare(`INSERT INTO ${carry} VALUES (?, ?, ?)`);
    for (const { subjectId, firstRevision } of eligible) {
      const id = String(subjectId);
      if (after.has(id) && after.get(id) === before.get(id)) {
        insert.run(revision, id, Number(firstRevision));
      }
    }
  }
  db.prepare(`DELETE FROM ${carry} WHERE revision <= ?`).run(revision - 20);
}

function readReviewRows(
  db: DatabaseSync,
  kind: ReviewKind,
  revision: number,
  fullHistory?: boolean,
) {
  const table = `assessment_${kind}_reviews`;
  const carry = `assessment_${kind}_review_carry`;
  const subject = `${kind}Id`;
  if (!hasTable(db, table)) return [];
  const hasCarry = hasTable(db, carry);
  const previous = hasCarry
    ? `UNION ALL
    SELECT review.id, review.revision, review.${subject}, review.disposition, review.note, review.at
    FROM ${carry} AS carried JOIN ${table} AS review ON review.${subject} = carried.${subject}
      AND review.revision >= carried.firstRevision AND review.revision < carried.revision
    WHERE carried.revision = ?`
    : "";
  return db.prepare(`
    SELECT id, revision, subjectId, disposition, note, at FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY subjectId ORDER BY id DESC) AS position
      FROM (
        SELECT id, revision, ${subject} AS subjectId, disposition, note, at FROM ${table} WHERE revision = ?
        ${previous}
      )
    ) ${fullHistory ? "" : "WHERE position <= 5"} ORDER BY id DESC
  `).all(...(hasCarry ? [revision, revision] : [revision])).map((row) => ({
    id: Number(row.id),
    revision: Number(row.revision),
    subjectId: String(row.subjectId),
    disposition: String(row.disposition),
    note: String(row.note),
    at: String(row.at),
  }));
}

export function recordSentinelFindingReview(
  path: string,
  revision: number,
  findingId: string,
  disposition: SentinelFindingReview["disposition"],
  note: string,
  requestId?: string,
): boolean {
  if (
    !Number.isSafeInteger(revision) || revision < 1 || !findingId ||
    !sentinelFindingDispositions.includes(disposition) ||
    !note.trim() || note.length > 1000 ||
    (requestId !== undefined &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId))
  ) return false;
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
      const prior = requestId &&
        operatorReviewRequest(db, "finding", requestId);
      if (prior) {
        return prior.revision === revision && prior.subjectId === findingId &&
          prior.disposition === disposition && prior.note === note.trim();
      }
      const row = getRow(db);
      if (!row || row.revision !== revision) return false;
      const result: Result | null = JSON.parse(row.result);
      if (
        !result?.sharedGraph.snapshot?.nodes.some(
          (node) => node.kind === "finding" && node.id === findingId,
        )
      ) return false;
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_finding_reviews (
        id INTEGER PRIMARY KEY,
        revision INTEGER NOT NULL,
        findingId TEXT NOT NULL,
        disposition TEXT NOT NULL,
        note TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assessment_finding_reviews_by_finding
        ON assessment_finding_reviews(revision, findingId, id);`);
      insertOperatorReview(
        db,
        "finding",
        revision,
        findingId,
        disposition,
        note,
        requestId,
      );
      return true;
    });
  } finally {
    db.close();
  }
}

export function readSentinelFindingReviews(
  path: string,
  revision: number,
  options?: { readonly fullHistory: boolean },
): SentinelFindingReview[] {
  const db = openStore(path, false);
  if (!db) return [];
  try {
    return readReviewRows(db, "finding", revision, options?.fullHistory).map(
      ({ subjectId, disposition, ...review }) => ({
        ...review,
        findingId: subjectId,
        disposition: disposition as SentinelFindingReview["disposition"],
      }),
    );
  } finally {
    db.close();
  }
}

/** Page saved decisions independently of the bounded graph preview. */
export function readSentinelDecisionHistory(
  path: string,
  revision: number,
  kind: "finding" | "incident",
  subjectId: string,
  before?: number,
  size = 10,
) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    if (
      !db.prepare("SELECT 1 FROM assessment_history WHERE revision = ?").get(
        revision,
      )
    ) {
      return undefined;
    }
    const table = kind === "finding"
      ? "assessment_finding_reviews"
      : "assessment_incident_reviews";
    const subject = kind === "finding" ? "findingId" : "incidentId";
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table)
    ) {
      return { decisions: [], nextBefore: null };
    }
    const carry = `assessment_${kind}_review_carry`;
    const firstRevision = hasTable(db, carry)
      ? Number(
        db.prepare(`SELECT firstRevision FROM ${carry}
          WHERE revision = ? AND ${subject} = ?`).get(revision, subjectId)
          ?.firstRevision ?? revision,
      )
      : revision;

    const rows = db.prepare(`
      SELECT id, revision, disposition, note, at FROM ${table}
      WHERE ${subject} = ? AND revision BETWEEN ? AND ? AND id < ?
      ORDER BY id DESC LIMIT ?
    `).all(
      subjectId,
      firstRevision,
      revision,
      before ?? Number.MAX_SAFE_INTEGER,
      size + 1,
    );
    const decisions = rows.slice(0, size).map((row) => ({
      id: Number(row.id),
      revision: Number(row.revision),
      disposition: String(row.disposition),
      note: String(row.note),
      at: String(row.at),
    }));
    return {
      decisions,
      nextBefore: rows.length > size ? decisions[size - 1].id : null,
    };
  } finally {
    db.close();
  }
}

/** Read the original decisions referenced by planning rounds in this case. */
export function readSentinelDecisions(
  path: string,
  kind: ReviewKind,
  ids: readonly number[],
) {
  if (!ids.length) return [];
  const db = openStore(path, false);
  if (!db) return [];
  try {
    const table = `assessment_${kind}_reviews`;
    if (!hasTable(db, table)) return [];
    return db.prepare(`
      SELECT review.id, review.${kind}Id AS subjectId, review.revision, review.disposition,
        review.note, review.at, history.revision IS NOT NULL AS retained
      FROM ${table} AS review
      LEFT JOIN assessment_history AS history ON history.revision = review.revision
      WHERE review.id IN (SELECT value FROM json_each(?))
      ORDER BY review.id
    `).all(JSON.stringify(ids)).map((row) => ({
      id: Number(row.id),
      kind,
      subjectId: String(row.subjectId),
      revision: Number(row.revision),
      disposition: String(row.disposition),
      note: String(row.note),
      at: String(row.at),
      retained: Boolean(row.retained),
    }));
  } finally {
    db.close();
  }
}

export function readSentinelDecision(
  path: string,
  kind: ReviewKind,
  id: number,
) {
  return readSentinelDecisions(path, kind, [id])[0];
}

export interface SentinelRunDisplay {
  readonly version: number;
  readonly title?: string;
  readonly pinnedAt?: string;
}

export interface SentinelRunDisplayChange {
  readonly runId: string;
  readonly revision: number;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly pinned?: boolean;
}

function readRunDisplay(db: DatabaseSync, runId: string): SentinelRunDisplay {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessment_run_display'",
  ).get();
  if (!table) return { version: 0 };
  const row = db.prepare(
    "SELECT display FROM assessment_run_display WHERE runId = ? ORDER BY version DESC LIMIT 1",
  ).get(runId);
  return row ? JSON.parse(String(row.display)) : { version: 0 };
}

export function readSentinelRunDisplay(path: string, runId: string) {
  const db = openStore(path, false);
  if (!db) return { version: 0 };
  try {
    return readRunDisplay(db, runId);
  } finally {
    db.close();
  }
}

/** Check or persist a list-only change bound to the current assessment. */
export function changeSentinelRunDisplay(
  path: string,
  change: SentinelRunDisplayChange,
  commit: boolean,
):
  | {
    previous: SentinelRunDisplay;
    display: SentinelRunDisplay;
    saved: boolean;
  }
  | undefined {
  const db = openStore(path, false);
  if (!db) return;
  try {
    return transact(db, () => {
      const row = getRow(db);
      if (
        row?.revision !== change.revision ||
        (JSON.parse(row.plan) as AssessmentPlan).runId !== change.runId
      ) return;
      const expected = JSON.stringify(change);
      const table = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assessment_run_display'",
      ).get();
      if (table) {
        const existing = db.prepare(
          "SELECT change, previous, display FROM assessment_run_display WHERE requestId = ?",
        ).get(change.requestId);
        if (existing) {
          return existing.change === expected
            ? {
              saved: true,
              previous: JSON.parse(String(existing.previous)),
              display: JSON.parse(String(existing.display)),
            }
            : undefined;
        }
      }
      const previous = readRunDisplay(db, change.runId);
      if (previous.version !== change.expectedVersion) return;
      const title = change.title ?? previous.title;
      const pinnedAt = change.pinned === false
        ? undefined
        : previous.pinnedAt ??
          (change.pinned ? new Date().toISOString() : undefined);
      const display = { version: previous.version + 1, title, pinnedAt };
      if (commit) {
        db.exec(`CREATE TABLE IF NOT EXISTS assessment_run_display (
          runId TEXT NOT NULL, version INTEGER NOT NULL, requestId TEXT NOT NULL UNIQUE,
          change TEXT NOT NULL, previous TEXT NOT NULL, display TEXT NOT NULL,
          PRIMARY KEY (runId, version)
        )`);
        db.prepare(
          "INSERT INTO assessment_run_display VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          change.runId,
          display.version,
          change.requestId,
          expected,
          JSON.stringify(previous),
          JSON.stringify(display),
        );
      }
      return { previous, display, saved: commit };
    });
  } finally {
    db.close();
  }
}
