import {
  readSavedSentinelProvenanceNode,
  readSentinelProvenanceNodeReference,
} from "./worker_goal_recovery.ts";
import {
  type OperatorRunLinkInput,
  recordOperatorRunLink,
  withOperatorRunLinks,
} from "../core/operator_runs.ts";
/** Persist the active defensive assessment and its evidence-driven revisions. */
/// <reference path="./sqlite_types.d.ts" />
import {
  correlateSentinelIncidents,
  recoverSentinelIncidentAlerts,
  resolveSentinelIncidentAlerts,
  summarizeSentinelIncident,
} from "./incident_correlation.ts";
import { loadSentinelGraph } from "./graph.ts";
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
  type SentinelOperatingConstraintUpdate as BaseOperatingConstraintUpdate,
  validateSentinelOperatingConstraintAssets,
} from "./operating_constraints.ts";
import {
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
    readonly formalGoals?: readonly SentinelFormalGoal[];
    readonly activeFormalGoalIds?: readonly string[];
    readonly completedFormalGoalIds?: readonly string[];
  };

type FormalGoalPlan = Pick<
  AssessmentPlan,
  "goal" | "impactAsset" | "traceNode" | "evidenceNode" | "depth"
>;

export interface SentinelFormalGoalApproval {
  readonly mode: "start" | "append" | "revise";
  readonly requestId: string;
  readonly proposalDigest: string;
  readonly sourceProposalId?: string;
  readonly goals: readonly SentinelFormalGoal[];
  readonly expectedRevision?: number;
  readonly expectedRunId?: string;
  readonly plan?: FormalGoalPlan;
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
  readonly workerProvenanceNodeResult?: string;
  readonly plannerDefenseContainment?: boolean | null;
  readonly goalProofRequestId?: string;
  readonly assetDiscoveryRequestId?: string;
  readonly trafficLinks?: {
    readonly linkIds?: readonly string[];
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
    plannerProvenancePath: _path,
    plannerProvenanceNodeResult: _plannerNode,
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

function getRow(db: DatabaseSync): AssessmentRow | undefined {
  return db.prepare("SELECT * FROM assessment WHERE id = 1").get() as
    | AssessmentRow
    | undefined;
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
  runId: string | undefined,
) {
  if (!runId) return;
  db.exec(`CREATE TABLE IF NOT EXISTS assessment_run_revisions (
    revision INTEGER PRIMARY KEY, runId TEXT NOT NULL
  )`);
  db.prepare(
    "INSERT OR IGNORE INTO assessment_run_revisions VALUES (?, ?)",
  ).run(revision, runId);
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

function refresh(
  db: DatabaseSync,
  row: AssessmentRow,
  snapshotPath: string,
  webContainmentConfigured?: boolean,
  evaluatedAt = new Date().toISOString(),
  forceEvidenceRevision = false,
  expectedGraphDigest?: string,
): StoredAssessment {
  if (row.active !== 1) return readState(db, row);
  const { graph, topology, traffic, native, dns, alertData, fingerprint } =
    readAssessmentInputs(snapshotPath, webContainmentConfigured, evaluatedAt);
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

  const alerts: unknown = alertData === undefined
    ? undefined
    : JSON.parse(alertData);
  if (alerts !== undefined && !Array.isArray(alerts)) {
    throw new Error("Published Sentinel alerts must be a JSON array");
  }
  const plan: AssessmentPlan = JSON.parse(row.plan);
  const inventory = graph === undefined
    ? undefined
    : topology === undefined
    ? JSON.parse(graph)
    : applySharedSentinelTopology(JSON.parse(graph), JSON.parse(topology));
  const assessment = runSentinelAssessment({
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
    previous: JSON.parse(row.result),
  });
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
  saveAssessmentRunRevision(db, revision, plan.runId);
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

export function startSentinelAssessment(
  path: string,
  plan: AssessmentPlan = {},
  webContainmentConfigured?: boolean,
  linkedStart?: {
    path: string;
    input: Omit<OperatorRunLinkInput, "right">;
    caseId: string;
    graphDigest: string;
  },
): StoredAssessment {
  if (
    plan.formalGoals !== undefined || plan.activeFormalGoalIds !== undefined ||
    plan.completedFormalGoalIds !== undefined
  ) throw new Error("Formal Sentinel goals require an approved goal proposal");
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
          if (row?.active === 1 || row?.active === 2) {
            throw new Error("A Sentinel assessment is already active");
          }
          if (
            plan.goal !== undefined &&
            (typeof plan.goal !== "string" || !plan.goal.trim() ||
              plan.goal.length > 500)
          ) {
            throw new Error("Sentinel goal must contain 1–500 characters");
          }
          const asJson = JSON.stringify({
            ...plan,
            runId: crypto.randomUUID(),
          });
          if (asJson.length > 4096) {
            throw new Error("Sentinel assessment plan is too large");
          }
          db.prepare(`
        INSERT INTO assessment VALUES (1, ?, 1, ?, '', ?, 'null')
        ON CONFLICT(id) DO UPDATE SET
          plan = excluded.plan, active = 1, fingerprint = '', result = 'null'
      `).run(asJson, row?.revision ?? 0, new Date().toISOString());
          const started = refresh(
            db,
            getRow(db)!,
            path,
            webContainmentConfigured,
            undefined,
            false,
            linkedStart?.graphDigest,
          );
          if (linkedStart) {
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
      !["goal", "impactAsset", "traceNode", "evidenceNode", "depth"].includes(
        key,
      )
    )
  ) {
    throw new Error("Invalid approved Sentinel goal plan");
  }
  const { goal, impactAsset, traceNode, evidenceNode, depth } = raw;
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
  return { goal: goal?.trim(), impactAsset, traceNode, evidenceNode, depth };
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
    (mode !== "start" && mode !== "append" && mode !== "revise") ||
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
  if (mode === "revise" && approval.plan !== undefined) {
    throw new Error("Revise changes only existing active formal goals");
  }
  const patch = normalizeFormalGoalPlan(approval.plan);
  const planChanges = JSON.parse(JSON.stringify(patch)) as FormalGoalPlan;
  const binding = createHash("sha256").update(JSON.stringify([
    mode,
    proposalDigest,
    expectedRevision ?? null,
    expectedRunId ?? null,
    planChanges,
    ...(approval.sourceProposalId ? [approval.sourceProposalId] : []),
  ])).digest("hex");
  return { binding, goals, planChanges };
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
export function applySentinelFormalGoals(
  path: string,
  approval: SentinelFormalGoalApproval,
  webContainmentConfigured?: boolean,
): {
  readonly state: StoredAssessment;
  readonly appliedRevision: number;
  readonly duplicate: boolean;
  readonly actor: "operator";
  readonly at: string;
} {
  const { mode, requestId, proposalDigest, expectedRevision, expectedRunId } =
    approval;
  const { binding, goals, planChanges } = formalGoalApprovalBinding(approval);
  const db = openStore(path, true)!;
  try {
    return transact(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_formal_goal_requests (
        requestId TEXT PRIMARY KEY, binding TEXT NOT NULL, appliedRevision INTEGER NOT NULL,
        proposalDigest TEXT NOT NULL, mode TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
      )`);
      const prior = readFormalGoalRequest(db, requestId, binding);
      const row = getRow(db);
      if (prior) {
        if (!row) {
          throw new Error("The approved Sentinel assessment is unavailable");
        }
        return { state: readState(db, row), ...prior };
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
      if (mode === "start" && (row?.active === 1 || row?.active === 2)) {
        throw new Error("A Sentinel assessment is already active");
      }
      if (
        mode !== "start" &&
        (!row || ![1, 2, 3].includes(row.active) ||
          expectedRevision !== row.revision ||
          expectedRunId !== previousPlan.runId)
      ) {
        throw new Error(
          "Goal changes require the exact active, paused or completed Sentinel assessment",
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
      const formalGoals = mode === "revise"
        ? existingGoals.map((goal) => replacements.get(goal.id) ?? goal)
        : [...existingGoals, ...goals];
      if (
        new Set(formalGoals.map(({ id }) => id)).size !== formalGoals.length
      ) {
        throw new Error(
          "The approved Sentinel goal IDs already exist in this assessment",
        );
      }
      const activeFormalGoalIds = mode === "revise"
        ? [...pending]
        : [...pending, ...goals.map(({ id }) => id)];
      const active = new Set(activeFormalGoalIds);
      if (
        formalGoals.reduce(
          (count, goal) =>
            count + (active.has(goal.id) ? goal.criteria.length : 0),
          0,
        ) > 32
      ) {
        throw new Error(
          "An active Sentinel goal set can contain at most 32 criteria",
        );
      }
      const plan: AssessmentPlan = {
        ...current,
        ...planChanges,
        goal: planChanges.goal ?? current.goal ?? goals[0].title,
        runId: current.runId ?? crypto.randomUUID(),
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
      } else {
        db.prepare("UPDATE assessment SET plan = ?, active = 1 WHERE id = 1")
          .run(encoded);
      }
      const state = refresh(
        db,
        getRow(db)!,
        path,
        webContainmentConfigured,
        undefined,
        true,
      );
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
      db.prepare(
        "INSERT INTO assessment_formal_goal_requests VALUES (?, ?, ?, ?, ?, 'operator', ?)",
      )
        .run(
          requestId,
          binding,
          state.revision,
          proposalDigest,
          mode,
          state.updatedAt,
        );
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
): StoredAssessment | undefined {
  return activateSentinelAssessment(
    path,
    2,
    webContainmentConfigured,
    expectedRevision,
  );
}

function activateSentinelAssessment(
  path: string,
  priorState: 0 | 2,
  webContainmentConfigured?: boolean,
  expectedRevision?: number,
): StoredAssessment | undefined {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    return transact(db, () => {
      if (
        expectedRevision !== undefined &&
        getRow(db)?.revision !== expectedRevision
      ) return undefined;
      const changed = db.prepare(
        "UPDATE assessment SET active = 1 WHERE id = 1 AND active = ?",
      ).run(priorState);
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
      const row = getRow(db);
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
      saveAssessmentRunRevision(db, evidenceRevision, runId);
      db.prepare(
        "INSERT INTO sentinel_operating_constraints VALUES (?, ?, ?, ?, ?)",
      ).run(
        runId,
        record.version,
        evidenceRevision,
        requestId,
        JSON.stringify(record),
      );
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
      db.exec(`CREATE TABLE IF NOT EXISTS assessment_goal_completion (
        revision INTEGER PRIMARY KEY, goal TEXT, note TEXT NOT NULL, at TEXT NOT NULL
      )`);
      const at = new Date().toISOString();
      db.prepare("INSERT INTO assessment_goal_completion VALUES (?, ?, ?, ?)")
        .run(revision, goal, reason, at);
      if (plan.formalGoals) {
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
        saveFormalGoalHistory(db, revision, closedPlan, activeFormalGoalIds);
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
      return true;
    });
  } finally {
    db.close();
  }
}

export function stopSentinelAssessment(
  path: string,
  expected?: { revision: number; runId: string },
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    if (expected) {
      return transact(db, () => {
        const row = getRow(db);
        if (
          !row || row.revision !== expected.revision ||
          (JSON.parse(row.plan) as AssessmentPlan).runId !== expected.runId
        ) return false;
        if (row.active === 0) return true;
        return db.prepare(
          "UPDATE assessment SET active = 0 WHERE id = 1 AND active IN (1, 2)",
        ).run().changes === 1;
      });
    }
    return Boolean(
      db.prepare(
        "UPDATE assessment SET active = 0 WHERE id = 1 AND active IN (1, 2)",
      ).run().changes,
    );
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
): boolean {
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return Boolean(
      db.prepare(
        "UPDATE assessment SET active = 2 WHERE id = 1 AND active = 1 AND (? IS NULL OR revision = ?)",
      ).run(expectedRevision ?? null, expectedRevision ?? null).changes,
    );
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
export function readSentinelCaseStatus(path: string) {
  const db = openStore(path, false);
  if (!db) return undefined;
  try {
    const row = db.prepare(
      "SELECT active, revision, updatedAt FROM assessment WHERE id = 1",
    ).get();
    if (!row) return undefined;
    return {
      status: row.active === 2
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
): boolean {
  if (
    !Number.isSafeInteger(revision) || revision < 1 ||
    !/^incident:[0-9a-f]{64}$/.test(incidentId) ||
    !sentinelIncidentDispositions.includes(disposition) ||
    !note.trim() || note.length > 1000
  ) return false;
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
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
      db.prepare(`INSERT INTO assessment_incident_reviews
        (revision, incidentId, disposition, note, at) VALUES (?, ?, ?, ?, ?)`)
        .run(
          revision,
          incidentId,
          disposition,
          note.trim(),
          new Date().toISOString(),
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

export const sentinelFindingDispositions = [
  "open",
  "confirmed",
  "resolved",
  "dismissed",
] as const;

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
): boolean {
  if (
    !Number.isSafeInteger(revision) || revision < 1 || !findingId ||
    !sentinelFindingDispositions.includes(disposition) ||
    !note.trim() || note.length > 1000
  ) return false;
  const db = openStore(path, false);
  if (!db) return false;
  try {
    return transact(db, () => {
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
      db.prepare(`INSERT INTO assessment_finding_reviews
        (revision, findingId, disposition, note, at) VALUES (?, ?, ?, ?, ?)`)
        .run(
          revision,
          findingId,
          disposition,
          note.trim(),
          new Date().toISOString(),
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
    const size = 10;
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
