import {
  projectRepositoryVisibility,
  repositoryVisibilityReceipt,
  repositoryVisibilityRecheckBinding,
  repositoryVisibilityReference,
  SENTINEL_LIVE_REPOSITORY_VISIBILITY,
} from "./github_repository_visibility.ts";
import { isDeepStrictEqual } from "node:util";
import {
  decodeStagedTrafficFinding,
  stagedTrafficItems,
  stagedTrafficLinkMatches,
  validPortableAnalystFinding,
} from "./worker_finding_store.ts";
import { parseOperatorRunAdmissionCategory } from "../core/operator_run_categories.ts";
import {
  readAdaptiveOperatorTrafficHint,
  readSentinelDedicatedRecheckSettlements,
  retainPortablePausedGraphCheckpoints,
} from "./adaptive_store.ts";
import { decodeInconclusiveRecheck } from "./recheck_inconclusive.ts";
import {
  decodeSentinelTrafficComposition,
  MAX_TRAFFIC_COMPOSITION_JOURNAL_BYTES,
} from "./finding_traffic_composition.ts";
import {
  decodeSentinelFindingTrafficLink,
  decodeSentinelTrafficLinkAnnotation,
  MAX_FINDING_TRAFFIC_BATCH,
  sentinelTrafficBatchBinding,
} from "./finding_traffic_links.ts";
import {
  parseSentinelModelRoute,
  validSentinelModelRouteHistory,
} from "./model_routes.ts";
import { parseSentinelLinkedCaseSources } from "./linked_case_sources.ts";
import { validPlannerHeartbeatSeconds } from "../core/evidence_task_progression.ts";
import {
  isSelectedModelProfile,
  parseModelFallbackProfiles,
} from "../core/model_profile_selection.ts";
import {
  decodeSentinelToolDecisions,
  sentinelArchivedToolDecisionsFile,
} from "./archive_tool_decisions.ts";
import {
  readSentinelArchivedDigestCatalog,
  sentinelArchivedDigestFile,
} from "./evidence_digests.ts";
import {
  sentinelArchivedDiscoveriesFile,
  validateArchivedDiscoveryApprovals,
} from "./archive_asset_discoveries.ts";
import { retainArchivedWorkerTraceMetadata } from "./case_archive_capture.ts";
import {
  sentinelExecutionEvidenceFile,
  validateCaseExecutionEvidence,
} from "./case_execution_evidence.ts";
import { createHash } from "node:crypto";
import { publishSentinelRestoreReservation } from "./restore_reservation.ts";
import {
  type ArchivedOperatorRunLink,
  openOperatorRunLinkStore,
} from "../core/operator_runs.ts";
/** Validate, deactivate, and install a verified named Sentinel case archive. */
/// <reference path="../core/sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { VerifiedRunArchive } from "../core/run_archive.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { readSentinelChatSnapshot } from "./chat_mode.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  openSentinelAdaptiveStore,
  readAdaptiveRepositoryVisibility,
} from "./adaptive_store.ts";
import {
  MAX_SENTINEL_RUN_TIMEOUT_SECONDS,
  parseSentinelAssessmentTemplateBinding,
  parseSentinelGoalSupersession,
  readSentinelAssessmentRevision,
  readSentinelRunIdForRevision,
  SENTINEL_ASSESSMENT_TIMED_OUT,
  validSentinelChildDescription,
} from "./assessment_store.ts";
import { readNativeWorkflowCitation } from "./native_workflow_evidence.ts";
import {
  isWorkerNarrativeId,
  readWorkerNarrativeReceipt,
} from "./worker_narratives.ts";
import { validateArchivedSourceSnapshots } from "./archive_source_snapshots.ts";
import {
  digestSentinelSnapshot,
  sentinelArchivedAssessmentSourcesFile,
  sentinelArchivedFindingSourcesFile,
  sentinelArchivedPlannerSourcesFile,
  sentinelArchivedTopologyFile,
  sentinelArchivedTraceSourcesFile,
} from "./shared_inventory.ts";
import {
  assertOperatorSourceDirectoryInfo,
  withSentinelSourceSnapshotLock,
} from "./source_snapshot_lock.ts";

export const sentinelArchivedLinksFile = "operator-run-links.json";
import {
  decodeSentinelWorkerFindingPublications,
  sentinelWorkerFindingPublicationFile,
} from "./worker_finding_publications.ts";
import {
  decodeExactSentinelFindingReceipt,
  readSentinelCaseFindingReceipts,
} from "./worker_finding_store.ts";
import {
  verifyWorkerFindingRecheck,
  withRepositoryVisibilityVerification,
} from "./worker_finding_evidence.ts";

const snapshotFile = "sentinel.json";
const assessmentFile = "sentinel-assessment.db";
const adaptiveFile = "sentinel-adaptive.db";
const adaptiveApp = 0x53414450;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const auxiliarySchemas = {
  "sentinel-goal-completion.db": {
    app: 0,
    versions: [0],
    tables: { goal_completion: ["scope", "record"] },
  },
  "sentinel-worker-findings.db": {
    app: 0x53574644,
    versions: [1, 2],
    tables: {
      receipts: ["id", "revision", "input", "recordedAt"],
      requests: ["requestId", "receiptId"],
    },
  },
  "sentinel-worker-graph-facts.db": {
    app: 0x53574746,
    versions: [1],
    tables: {
      worker_graph_facts: [
        "id",
        "request_id",
        "run_id",
        "revision",
        "target_id",
        "task_id",
        "receipt",
      ],
    },
  },
  "sentinel-traffic-receipts.db": {
    app: 0,
    versions: [0],
    tables: {
      traffic_receipts_v1: [
        "evidenceId",
        "family",
        "record",
        "proof",
        "retainedAt",
      ],
    },
  },
  "sentinel-finding-traffic-links.db": {
    app: 0x5346544c,
    versions: [1, 2],
    tables: {
      traffic_links: ["id", "request_id", "revision", "finding_id", "input"],
    },
  },
} as const;

type AuxiliaryArtifact = keyof typeof auxiliarySchemas;
const auxiliaryArtifacts = Object.keys(auxiliarySchemas) as AuxiliaryArtifact[];
export const requiredSentinelRestoreArtifacts = [
  snapshotFile,
  assessmentFile,
] as const;
export const permittedSentinelRestoreArtifacts = [
  ...requiredSentinelRestoreArtifacts,
  adaptiveFile,
  sentinelWorkerFindingPublicationFile,
  sentinelArchivedDiscoveriesFile,
  sentinelArchivedDigestFile,
  sentinelExecutionEvidenceFile,
  sentinelArchivedLinksFile,
  sentinelArchivedToolDecisionsFile,
  sentinelArchivedTopologyFile,
  sentinelArchivedFindingSourcesFile,
  sentinelArchivedTraceSourcesFile,
  sentinelArchivedPlannerSourcesFile,
  sentinelArchivedAssessmentSourcesFile,
  ...auxiliaryArtifacts,
] as const;

type Artifact = typeof permittedSentinelRestoreArtifacts[number];

function stagedPath(
  archive: VerifiedRunArchive,
  artifact: Artifact,
): string | undefined {
  const file = archive.artifactPath(artifact);
  if (file === undefined) return undefined;
  const expected = join(resolve(archive.directory), artifact);
  if (resolve(file) !== expected) {
    throw new Error("Invalid staged Sentinel artifact path");
  }
  const info = Deno.lstatSync(expected);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Sentinel restore requires private regular artifacts");
  }
  return expected;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid saved Sentinel assessment");
  }
  return value as Record<string, unknown>;
}

function savedSnapshot(result: unknown) {
  const assessment = object(result);
  const graph = object(assessment.sharedGraph);
  if (!Array.isArray(assessment.tasks) || !Array.isArray(graph.observations)) {
    throw new Error("Invalid saved Sentinel assessment result");
  }
  return loadSentinelGraph(graph.snapshot).snapshot();
}

function checkedDatabase<T>(
  path: string,
  family: "assessment" | "adaptive" | AuxiliaryArtifact,
  action: (db: DatabaseSync, tables: ReadonlySet<string>) => T,
): T {
  const auxiliary = family === "assessment" || family === "adaptive"
    ? undefined
    : auxiliarySchemas[family];
  const db = new DatabaseSync(path, { readOnly: auxiliary !== undefined });
  try {
    db.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON",
    );
    const app = db.prepare("PRAGMA application_id").get()?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const supported = auxiliary
      ? app === auxiliary.app &&
        auxiliary.versions.some((value) => value === version)
      : family === "adaptive"
      ? app === adaptiveApp && version === 1
      : app === 0 && version === 0;
    if (!supported) {
      throw new Error("Unsupported Sentinel archive database version");
    }
    const permitted = (name: unknown) =>
      typeof name === "string" &&
      (auxiliary
        ? Object.hasOwn(auxiliary.tables, name) ||
          family === "sentinel-goal-completion.db" &&
            name === "goal_evidence_submissions" ||
          family === "sentinel-worker-findings.db" &&
            version === 2 &&
            (name === "inconclusive_rechecks" ||
              name === "staged_traffic_findings") ||
          family === "sentinel-finding-traffic-links.db" &&
            version === 2 && (name === "traffic_link_request_aliases" ||
              name === "traffic_link_annotations" ||
              name === "traffic_link_composition" ||
              name === "traffic_link_batches" ||
              name === "staged_publication_links")
        : name === family || name.startsWith(family + "_") ||
          family === "assessment" && name === "sentinel_operating_constraints");
    const tables = new Set<string>();
    for (
      const { name, type, tbl_name, sql } of db.prepare(
        "SELECT name,type,tbl_name,sql FROM sqlite_schema",
      ).all()
    ) {
      if (
        type === "table" && permitted(name) && typeof sql === "string" &&
        /^CREATE TABLE\b/i.test(sql)
      ) {
        tables.add(String(name));
      } else if (
        type !== "index" || !permitted(tbl_name) ||
        !(typeof name === "string" && (name.startsWith("sqlite_autoindex_") ||
          typeof sql === "string" && /^CREATE (?:UNIQUE )?INDEX\b/i.test(sql)))
      ) {
        throw new Error("Unexpected Sentinel archive database schema");
      }
    }
    const check = db.prepare("PRAGMA quick_check(1)").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") {
      throw new Error("Invalid Sentinel archive database integrity");
    }
    return action(db, tables);
  } finally {
    db.close();
  }
}

function requireColumns(
  db: DatabaseSync,
  table: string,
  required: readonly string[],
) {
  // All table names here are literals from the restore schema.
  const found = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name),
  );
  if (!required.every((column) => found.has(column))) {
    throw new Error("Incomplete Sentinel archive database schema");
  }
  return found;
}

function transaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function restoreAssessment(
  path: string,
  caseId: string,
  revision: number,
  runId: string,
  snapshotDigest: string,
) {
  checkedDatabase(path, "assessment", (db, tables) => {
    requireColumns(db, "assessment", [
      "id",
      "plan",
      "active",
      "revision",
      "fingerprint",
      "updatedAt",
      "result",
    ]);
    requireColumns(db, "assessment_history", [
      "revision",
      "updatedAt",
      "result",
    ]);
    requireColumns(db, "assessment_reviews", ["claim", "analysis"]);
    requireColumns(db, "assessment_archive_identity", [
      "caseId",
      "runId",
      "evidenceRevision",
      "snapshotDigest",
    ]);
    const identity = db.prepare(
      "SELECT * FROM assessment_archive_identity LIMIT 2",
    ).all();
    if (
      identity.length !== 1 || identity[0].caseId !== caseId ||
      identity[0].runId !== runId ||
      identity[0].evidenceRevision !== revision ||
      identity[0].snapshotDigest !== snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive case identity does not match its manifest",
      );
    }
    const rows = db.prepare("SELECT * FROM assessment LIMIT 2").all();
    const [row] = rows;
    if (
      rows.length !== 1 || row.id !== 1 ||
      (row.active !== 0 && row.active !== SENTINEL_ASSESSMENT_TIMED_OUT) ||
      row.revision !== revision || typeof row.plan !== "string" ||
      typeof row.result !== "string" || typeof row.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      object(JSON.parse(row.plan)).runId !== runId ||
      digestSentinelSnapshot(savedSnapshot(JSON.parse(row.result))) !==
        snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive does not match the exact stopped case run",
      );
    }
    const {
      childDescription,
      assessmentTemplate,
      admissionCategory,
      goalSupersessions,
      timeoutSeconds,
      deadlineAt,
      modelProfile,
      plannerHeartbeatSeconds,
      inventoryCoverageEnabled,
      runStartedAt,
      runInactiveAt,
      spawnParent,
    } = object(
      JSON.parse(row.plan),
    );
    if (
      childDescription !== undefined &&
      !validSentinelChildDescription(childDescription)
    ) throw new Error("Invalid archived linked Sentinel description");
    if (
      assessmentTemplate !== undefined &&
      (!parseSentinelAssessmentTemplateBinding(assessmentTemplate) ||
        childDescription === undefined)
    ) throw new Error("Invalid archived Sentinel assessment template binding");
    if (
      admissionCategory !== undefined &&
      !parseOperatorRunAdmissionCategory(admissionCategory)
    ) {
      throw new Error("Invalid archived Sentinel admission category");
    }
    if (
      goalSupersessions !== undefined &&
      (!Array.isArray(goalSupersessions) || goalSupersessions.length > 64 ||
        goalSupersessions.some((raw) => {
          const {
            goalId,
            evidenceRevision,
            replacementGoalId,
            completionSha256,
            requestId,
          } = object(raw);
          return Object.keys(raw).length !== 5 ||
            !parseSentinelGoalSupersession({ goalId, evidenceRevision }) ||
            !parseSentinelGoalSupersession({
              goalId: replacementGoalId,
              evidenceRevision,
            }) ||
            replacementGoalId === goalId ||
            typeof completionSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(completionSha256) ||
            typeof requestId !== "string" ||
            !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId);
        }))
    ) throw new Error("Invalid archived Sentinel goal supersessions");
    const {
      linkedCaseSources,
      modelFallbackProfiles,
      modelFallbackIndex,
      modelRouteHistory,
      modelRoleProfiles,
    } = object(JSON.parse(row.plan));
    if (
      linkedCaseSources !== undefined &&
      !parseSentinelLinkedCaseSources(linkedCaseSources)
    ) {
      throw new Error("Invalid archived linked Sentinel case sources");
    }
    if (
      inventoryCoverageEnabled !== undefined &&
      typeof inventoryCoverageEnabled !== "boolean"
    ) {
      throw new Error("Invalid archived Sentinel inventory coverage setting");
    }
    if (spawnParent !== undefined) {
      const parent = object(spawnParent);
      const { kind, id, revision } = parent;
      if (
        (kind !== "sentinel" && kind !== "workflow" && kind !== "delegated" &&
          kind !== "scheduled") ||
        typeof id !== "string" || !id.trim() || id.length > 256 ||
        id.includes("\0") ||
        (revision !== undefined &&
          (kind === "delegated" || kind === "scheduled" ||
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1)) ||
        Object.keys(parent).some((key) =>
          !["kind", "id", "revision"].includes(key)
        )
      ) {
        throw new Error("Invalid archived Sentinel spawn parent");
      }
    }
    for (const time of [runStartedAt, runInactiveAt]) {
      if (
        time !== undefined &&
        (typeof time !== "number" || !Number.isSafeInteger(time) ||
          time < 0 || time > 8_640_000_000_000_000)
      ) {
        throw new Error("Invalid archived Sentinel run timing");
      }
    }
    if (
      plannerHeartbeatSeconds !== undefined &&
      !validPlannerHeartbeatSeconds(plannerHeartbeatSeconds)
    ) {
      throw new Error("Invalid archived Sentinel planner heartbeat interval");
    }
    if (modelProfile !== undefined && !isSelectedModelProfile(modelProfile)) {
      throw new Error("Invalid archived Sentinel assessment model profile");
    }
    const fallbacks = parseModelFallbackProfiles(
      modelFallbackProfiles,
      isSelectedModelProfile(modelProfile) ? modelProfile : undefined,
    );
    if (
      (modelFallbackProfiles !== undefined && !fallbacks) ||
      (modelFallbackIndex !== undefined && (!fallbacks ||
        typeof modelFallbackIndex !== "number" ||
        !Number.isSafeInteger(modelFallbackIndex) || modelFallbackIndex < 1 ||
        modelFallbackIndex > fallbacks.length))
    ) {
      throw new Error("Invalid archived Sentinel fallback model selection");
    }
    if (
      (timeoutSeconds !== undefined || deadlineAt !== undefined ||
        row.active === SENTINEL_ASSESSMENT_TIMED_OUT) &&
      (typeof timeoutSeconds !== "number" ||
        !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > MAX_SENTINEL_RUN_TIMEOUT_SECONDS ||
        typeof deadlineAt !== "number" || !Number.isSafeInteger(deadlineAt) ||
        deadlineAt < 1 || deadlineAt > 8_640_000_000_000_000 ||
        (row.active === SENTINEL_ASSESSMENT_TIMED_OUT &&
          Date.parse(row.updatedAt) !== deadlineAt))
    ) throw new Error("Invalid archived Sentinel assessment deadline");
    if (modelRouteHistory !== undefined || modelRoleProfiles !== undefined) {
      const route = parseSentinelModelRoute({
        primary: modelProfile,
        alternates: modelFallbackProfiles,
        activeIndex: modelFallbackIndex ?? 0,
        roles: modelRoleProfiles,
      });
      if (
        !route ||
        !validSentinelModelRouteHistory(
          modelRouteHistory,
          runId,
          revision,
          route,
        )
      ) {
        throw new Error("Invalid archived Sentinel model route history");
      }
    }
    const archived = db.prepare(
      "SELECT result FROM assessment_history WHERE revision = ?",
    ).get(revision);
    if (
      typeof archived?.result !== "string" ||
      digestSentinelSnapshot(savedSnapshot(JSON.parse(archived.result))) !==
        snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive is missing its exact retained evidence revision",
      );
    }
    if (
      tables.has("assessment_run_revisions") && db.prepare(
          "SELECT runId FROM assessment_run_revisions WHERE revision = ?",
        ).get(revision)?.runId !== runId
    ) {
      throw new Error(
        "Sentinel archive run history does not match its manifest",
      );
    }
    transaction(db, () => {
      db.exec("DELETE FROM assessment_reviews WHERE analysis IS NULL");
      db.exec(
        "UPDATE assessment_reviews SET claim = 'restored' WHERE claim <> 'restored'",
      );
      if (tables.has("assessment_incident_notification")) {
        db.exec("DELETE FROM assessment_incident_notification");
      }
      if (row.active !== SENTINEL_ASSESSMENT_TIMED_OUT) {
        db.exec("UPDATE assessment SET active = 2 WHERE id = 1");
      }
    });
  });
}

function validateArchivedWorkerNarratives(
  db: DatabaseSync,
  assessment: string,
  latestRevision: number,
) {
  const invalid = () =>
    new Error("Invalid archived Sentinel worker observation");
  const schema = db.prepare("PRAGMA table_xinfo(adaptive_worker_narratives)")
    .all();
  const columns: Record<string, string> = {
    id: "TEXT",
    revision: "TEXT",
    taskId: "TEXT",
    targetId: "TEXT",
    evidenceRevision: "INTEGER",
    stepIndex: "INTEGER",
    receipt: "TEXT",
  };
  if (schema.some(({ name }) => name === "publicationStepIndex")) {
    columns.publicationStepIndex = "INTEGER";
  }
  if (
    schema.length !== Object.keys(columns).length ||
    schema.some(({ name, type, pk, hidden }) =>
      typeof name !== "string" || !Object.hasOwn(columns, name) ||
      columns[name] !== type || hidden !== 0 || pk !== (name === "id" ? 1 : 0)
    )
  ) throw invalid();
  const unique = db.prepare("PRAGMA index_list(adaptive_worker_narratives)")
    .all().filter((index) => index.unique === 1 && index.origin !== "pk");
  const key = unique.length === 1 && unique[0].origin === "u" &&
      unique[0].partial === 0 && typeof unique[0].name === "string"
    ? db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(unique[0].name).map(({ name }) => name)
    : undefined;
  const legacyKey = ["revision", "taskId", "evidenceRevision"];
  if (
    !isDeepStrictEqual(key, legacyKey) &&
    !isDeepStrictEqual(key, [...legacyKey, "stepIndex"])
  ) throw invalid();

  type Node = ReturnType<
    ReturnType<typeof loadSentinelGraph>["snapshot"]
  >["nodes"][number];
  let exact: {
    revision: number;
    nodes: Map<string, Node>;
    edges: Set<string>;
    runId: string;
  } | undefined;
  const assignment = db.prepare(`
    SELECT task.nodeId, mapping.goalId
    FROM adaptive_tasks AS task
    JOIN adaptive_evidence_revisions AS mapping ON mapping.revision = task.revision
    WHERE task.id = ? AND task.revision = ? AND mapping.evidenceNumber = ?
  `);
  const rows = db.prepare(
    "SELECT rowid AS position, * FROM adaptive_worker_narratives WHERE ? IS NULL OR rowid > ? ORDER BY rowid LIMIT 256",
  );
  let after: number | null = null;
  for (;;) {
    const page: ReturnType<typeof rows.all> = rows.all(after, after);
    if (!page.length) return;
    for (const row of page) {
      if (
        typeof row.position !== "number" || !Number.isSafeInteger(row.position)
      ) throw invalid();
      after = row.position;
      const { id, revision, taskId, targetId, evidenceRevision, stepIndex } =
        row;
      if (
        !isWorkerNarrativeId(id) ||
        typeof revision !== "string" ||
        !/^[A-Za-z\d._:-]{1,224}$/.test(revision) ||
        typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
        typeof targetId !== "string" || !targetId ||
        typeof evidenceRevision !== "number" ||
        !Number.isSafeInteger(evidenceRevision) ||
        evidenceRevision < 1 || evidenceRevision > latestRevision ||
        typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) ||
        stepIndex < 0 || stepIndex >= 16 || typeof row.receipt !== "string"
      ) throw invalid();
      let receipt;
      try {
        receipt = readWorkerNarrativeReceipt(JSON.parse(row.receipt));
      } catch {
        throw invalid();
      }
      if (
        !receipt || JSON.stringify(receipt) !== row.receipt ||
        id !== `worker-narrative:${
            createHash("sha256").update(JSON.stringify([
              revision,
              taskId,
              targetId,
              evidenceRevision,
              stepIndex,
              receipt,
            ])).digest("hex")
          }`
      ) throw invalid();
      if (
        row.publicationStepIndex != null &&
        (typeof row.publicationStepIndex !== "number" ||
          !Number.isSafeInteger(row.publicationStepIndex) ||
          row.publicationStepIndex <= stepIndex ||
          row.publicationStepIndex >= 16)
      ) throw invalid();
      if (exact?.revision !== evidenceRevision) {
        const snapshot = readSentinelAssessmentRevision(
          assessment,
          evidenceRevision,
        )
          ?.result.sharedGraph.snapshot;
        const runId = readSentinelRunIdForRevision(
          assessment,
          evidenceRevision,
        );
        if (!snapshot || !runId) throw invalid();
        exact = {
          revision: evidenceRevision,
          runId,
          nodes: new Map(snapshot.nodes.map((node) => [node.id, node])),
          edges: new Set(
            snapshot.edges.map(({ from, to }) => JSON.stringify([from, to])),
          ),
        };
      }
      const source = assignment.get(taskId, revision, evidenceRevision);
      const record = exact.nodes.get(receipt.evidenceId);
      if (
        source?.goalId !== exact.runId || source.nodeId !== targetId ||
        record?.kind !== "evidence" || record.executionSource ||
        record.nativeWorkflowSource ||
        exact.nodes.get(targetId)?.kind !== "asset" ||
        (!exact.edges.has(JSON.stringify([targetId, record.id])) &&
          !exact.edges.has(JSON.stringify([record.id, targetId])))
      ) throw invalid();
    }
  }
}

const visibilityResultsTable = "adaptive_repository_visibility_results";

/** Validate preserved receipts without reopening the connector or resolving credentials. */
function validateArchivedRepositoryVisibility(
  db: DatabaseSync,
  tables: ReadonlySet<string>,
  assessment: string,
  retained: readonly number[],
) {
  const invalid = () =>
    new Error("Invalid archived Sentinel repository visibility");
  const columns: Record<
    string,
    { type: string; key: number; required: number }
  > = {
    revision: { type: "TEXT", key: 1, required: 1 },
    taskId: { type: "TEXT", key: 2, required: 1 },
    evidenceRevision: { type: "INTEGER", key: 3, required: 1 },
    receipt: { type: "TEXT", key: 0, required: 1 },
    controlClaimSha256: { type: "TEXT", key: 0, required: 0 },
    sourceStepIndex: { type: "INTEGER", key: 0, required: 0 },
  };
  const schema = db.prepare(
    "PRAGMA table_xinfo(adaptive_repository_visibility_results)",
  ).all();
  if (
    schema.length !== Object.keys(columns).length ||
    schema.some(({ name, type, pk, hidden, notnull }) => {
      const column = typeof name === "string" && Object.hasOwn(columns, name)
        ? columns[name]
        : undefined;
      return !column || column.type !== type || column.key !== pk ||
        column.required !== notnull || hidden !== 0;
    })
  ) throw invalid();
  const assignment = db.prepare(`
    SELECT task.nodeId, mapping.goalId
    FROM adaptive_tasks AS task
    JOIN adaptive_evidence_revisions AS mapping ON mapping.revision = task.revision
    WHERE task.id = ? AND task.revision = ? AND task.status = 'completed'
      AND mapping.evidenceNumber = ?
  `);
  const archivedSteps = tables.has("adaptive_archived_worker_traces")
    ? db.prepare(
      `SELECT steps FROM adaptive_archived_worker_traces WHERE taskId = ? AND revision = ?`,
    )
    : undefined;
  const completedSteps = tables.has("adaptive_note_steps") &&
      tables.has("adaptive_model_reviews")
    ? db.prepare(`SELECT trace.steps
      FROM adaptive_model_reviews AS review
      JOIN adaptive_note_steps AS trace ON trace.note_id = review.noteId
      WHERE review.taskId = ?`)
    : undefined;
  const rows = db.prepare(
    `SELECT rowid AS position, * FROM adaptive_repository_visibility_results
    WHERE ? IS NULL OR rowid > ? ORDER BY rowid LIMIT 256`,
  );
  type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
  let exact:
    | { revision: number; runId: string; snapshot: Snapshot }
    | undefined;
  let after: number | null = null;
  for (;;) {
    const page: ReturnType<typeof rows.all> = rows.all(after, after);
    if (!page.length) break;
    for (const row of page) {
      const {
        position,
        revision,
        taskId,
        evidenceRevision,
        sourceStepIndex,
        controlClaimSha256,
        receipt: encoded,
      } = row;
      if (
        typeof position !== "number" || !Number.isSafeInteger(position) ||
        typeof revision !== "string" ||
        !/^[A-Za-z\d._:-]{1,224}$/.test(revision) ||
        typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
        typeof evidenceRevision !== "number" ||
        !Number.isSafeInteger(evidenceRevision) ||
        evidenceRevision < 1 ||
        evidenceRevision > (retained.at(-1) ?? 0) ||
        typeof encoded !== "string" ||
        (controlClaimSha256 !== null &&
          (typeof controlClaimSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(controlClaimSha256))) ||
        (sourceStepIndex !== null &&
          (typeof sourceStepIndex !== "number" ||
            !Number.isSafeInteger(sourceStepIndex) ||
            sourceStepIndex < 0 || sourceStepIndex >= 16))
      ) throw invalid();
      after = position;
      const receipt = repositoryVisibilityReceipt(JSON.parse(encoded));
      if (
        !receipt || receipt.evidenceRevision !== evidenceRevision ||
        JSON.stringify(receipt) !== encoded
      ) throw invalid();
      if (exact?.revision !== evidenceRevision) {
        const snapshot = readSentinelAssessmentRevision(
          assessment,
          evidenceRevision,
        )
          ?.result.sharedGraph.snapshot;
        const runId = readSentinelRunIdForRevision(
          assessment,
          evidenceRevision,
        );
        if (!snapshot || !runId) throw invalid();
        exact = { revision: evidenceRevision, runId, snapshot };
      }
      const source = assignment.get(taskId, revision, evidenceRevision);
      const target = source?.nodeId;
      if (
        source?.goalId !== exact.runId || typeof target !== "string" ||
        !exact.snapshot.nodes.some(({ id, kind }) =>
          id === target && kind === "asset"
        )
      ) throw invalid();
      if (sourceStepIndex === null) continue;
      const encodedSteps = completedSteps?.get(taskId)?.steps ??
        archivedSteps?.get(taskId, revision)?.steps;
      if (encodedSteps === undefined) continue;
      if (typeof encodedSteps !== "string") throw invalid();
      const steps = JSON.parse(encodedSteps);
      if (
        !Array.isArray(steps) || steps.length > 16 ||
        sourceStepIndex > steps.length
      ) {
        throw invalid();
      }
      const step = steps[sourceStepIndex];
      // The result may have committed just before its trace was recorded.
      if (step === undefined) continue;
      if (
        step?.tool !== SENTINEL_LIVE_REPOSITORY_VISIBILITY ||
        step.outcome !== "returned"
      ) throw invalid();
      const proof = step.goalReceiptRead?.sha256 ?? step.resultSha256;
      if (
        proof !== undefined && proof !== createHash("sha256").update(
            JSON.stringify(
              projectRepositoryVisibility(receipt, taskId, target),
            ),
          ).digest("hex")
      ) throw invalid();
    }
  }
  validateArchivedRepositoryVisibilityCitations(db, true);
}

function validateArchivedRepositoryVisibilityCitations(
  db: DatabaseSync,
  hasResults: boolean,
) {
  if (
    !db.prepare(
      "SELECT name FROM pragma_table_info('adaptive_tasks') WHERE name = 'plannerRound'",
    ).get()
  ) return;
  const invalid = () =>
    new Error("Invalid archived Sentinel repository visibility citation");
  const cited = db.prepare(`
    SELECT id, nodeId, revision, kind, depth, plannerRound
    FROM adaptive_tasks WHERE json_valid(plannerRound)
      AND json_type(plannerRound, '$.repositoryVisibility') IS NOT NULL
  `).all();
  if (!cited.length) return;
  if (!hasResults) throw invalid();
  const receiptFor = db.prepare(`
    SELECT result.receipt, result.evidenceRevision, task.nodeId
    FROM adaptive_repository_visibility_results AS result
    JOIN adaptive_tasks AS task ON task.id = result.taskId AND task.revision = result.revision
    WHERE result.revision = ? AND result.taskId = ? AND result.sourceStepIndex = ?
  `);
  for (const { id, nodeId, revision, kind, depth, plannerRound } of cited) {
    const reference = typeof plannerRound === "string"
      ? repositoryVisibilityReference(
        JSON.parse(plannerRound).repositoryVisibility,
      )
      : undefined;
    if (
      !reference || reference.taskId === id || typeof nodeId !== "string" ||
      kind !== "trace" || depth !== 1
    ) throw invalid();
    const source = receiptFor.get(
      revision,
      reference.taskId,
      reference.sourceStepIndex,
    );
    const receipt = typeof source?.receipt === "string"
      ? repositoryVisibilityReceipt(JSON.parse(source.receipt))
      : undefined;
    if (
      !receipt || source?.nodeId !== nodeId ||
      receipt.evidenceRevision !== source.evidenceRevision ||
      reference.resultSha256 !== createHash("sha256").update(
          JSON.stringify(
            projectRepositoryVisibility(receipt, reference.taskId, nodeId),
          ),
        ).digest("hex")
    ) throw invalid();
  }
}

function restoreAdaptive(
  path: string,
  assessment: string,
  caseId: string,
  revision: number,
  runId: string,
  retained: readonly number[],
) {
  checkedDatabase(path, "adaptive", (db, tables) => {
    requireColumns(db, "adaptive_active", ["singleton", "revision"]);
    requireColumns(db, "adaptive_revisions", ["revision"]);
    const taskColumns = requireColumns(db, "adaptive_tasks", [
      "revision",
      "status",
      "leaseToken",
      "leaseExpiresAt",
    ]);
    const hasMapping = tables.has("adaptive_evidence_revisions");
    if (hasMapping) {
      requireColumns(db, "adaptive_evidence_revisions", [
        "revision",
        "evidenceNumber",
        "goalId",
      ]);
    }
    const mapping = hasMapping
      ? db.prepare(`
      SELECT mapped.revision, mapped.goalId, mapped.evidenceNumber,
             known.revision AS knownRevision
      FROM adaptive_evidence_revisions AS mapped
      LEFT JOIN adaptive_revisions AS known ON known.revision = mapped.revision
      ORDER BY mapped.evidenceNumber DESC, mapped.rowid DESC LIMIT 1
    `).get()
      : undefined;
    // A read can initialize the adaptive database before the first planner turn.
    const unplanned = !mapping &&
      !db.prepare("SELECT 1 FROM adaptive_revisions LIMIT 1").get() &&
      !db.prepare("SELECT 1 FROM adaptive_tasks LIMIT 1").get();
    if (
      !unplanned && (!mapping || typeof mapping.revision !== "string" ||
        mapping.knownRevision !== mapping.revision ||
        mapping.goalId !== runId ||
        typeof mapping.evidenceNumber !== "number" ||
        !retained.includes(mapping.evidenceNumber))
    ) {
      throw new Error(
        "Sentinel archive adaptive state does not match the retained case run",
      );
    }
    if (tables.has("adaptive_worker_narratives")) {
      if (!hasMapping) {
        throw new Error("Invalid archived Sentinel worker revision");
      }
      validateArchivedWorkerNarratives(db, assessment, revision);
    }
    if (tables.has(visibilityResultsTable)) {
      if (!hasMapping) {
        throw new Error("Invalid archived Sentinel repository revision");
      }
      validateArchivedRepositoryVisibility(db, tables, assessment, retained);
    } else {
      validateArchivedRepositoryVisibilityCitations(db, false);
    }
    const predecessor = mapping && mapping.evidenceNumber !== revision
      ? mapping.revision
      : undefined;
    const active = db.prepare("SELECT revision FROM adaptive_active LIMIT 2")
      .all();
    if (
      active.length > 1 || active[0] && active[0].revision !== mapping?.revision
    ) {
      throw new Error(
        "Sentinel archive contains a foreign active adaptive revision",
      );
    }
    transaction(db, () => {
      db.exec("DELETE FROM adaptive_active");
      db.prepare(`UPDATE adaptive_tasks SET
        status = CASE WHEN status = 'running' OR (status = 'queued' AND revision <> ?)
          THEN 'superseded' ELSE status END,
        leaseToken = NULL, leaseExpiresAt = NULL`).run(
        mapping?.revision ?? null,
      );
      if (typeof predecessor === "string") {
        // Resume uses the prior queue as rollover input after revalidating it
        // against the latest case evidence. The restored assessment is paused.
        db.prepare(
          "INSERT INTO adaptive_active (singleton, revision) VALUES (1, ?)",
        )
          .run(predecessor);
      }
      if (taskColumns.has("dependencyRecommendation")) {
        db.exec("UPDATE adaptive_tasks SET dependencyRecommendation = NULL");
      }
      if (tables.has("adaptive_model_reviews")) {
        db.exec(
          "UPDATE adaptive_model_reviews SET token = NULL WHERE token IS NOT NULL",
        );
      }
      if (tables.has("adaptive_model_leases")) {
        db.exec(
          "UPDATE adaptive_model_leases SET completed = 1 WHERE completed = 0",
        );
      }
      if (tables.has("adaptive_model_history")) {
        db.prepare(
          "UPDATE adaptive_model_history SET outcome = -1, finished = ? WHERE outcome = 0",
        )
          .run(Date.now());
      }
      if (tables.has("adaptive_worker_controls")) {
        db.exec(
          "DELETE FROM adaptive_worker_controls WHERE action = 'steer' AND appliedAt IS NULL",
        );
      }
      retainArchivedWorkerTraceMetadata(db, caseId);
      retainPortablePausedGraphCheckpoints(db, revision, true);
      if (tables.has(visibilityResultsTable)) {
        db.exec(
          "DELETE FROM adaptive_repository_visibility_results WHERE sourceStepIndex IS NULL",
        );
      }
      for (
        const table of [
          "adaptive_assigned_target_batch_receipts",
          "adaptive_recheck_context_batch_receipts",
          "adaptive_traffic_links_batch_receipts",
          "adaptive_observation_search_batch_receipts",
          "adaptive_live_workflow_results",
          "adaptive_peer_verifications",
        ]
      ) {
        if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
      }
    });
  });
}

function validateAuxiliary(
  path: string,
  name: AuxiliaryArtifact,
  caseId: string,
  runId: string,
  revision: number,
) {
  checkedDatabase(path, name, (db, tables) => {
    for (
      const [table, fields] of Object.entries(auxiliarySchemas[name].tables)
    ) {
      requireColumns(db, table, fields);
    }
    if (tables.has("goal_evidence_submissions")) {
      requireColumns(db, "goal_evidence_submissions", [
        "scope",
        "requestId",
        "binding",
        "receipt",
      ]);
    }
    if (tables.has("traffic_link_request_aliases")) {
      requireColumns(db, "traffic_link_request_aliases", [
        "request_id",
        "link_id",
      ]);
    }
    if (tables.has("traffic_link_annotations")) {
      requireColumns(db, "traffic_link_annotations", [
        "id",
        "request_id",
        "link_id",
        "input",
        "recorded_at",
      ]);
      if (
        db.prepare(`SELECT 1 FROM traffic_link_annotations AS edit
        LEFT JOIN traffic_links AS link ON link.id = edit.link_id
        WHERE link.id IS NULL
          OR json_extract(edit.input, '$.linkId') IS NOT edit.link_id
          OR json_extract(edit.input, '$.requestId') IS NOT edit.request_id
          OR json_type(edit.input, '$.reportVersion') IS NOT 'integer'
          OR json_type(edit.input, '$.evidenceVersion') IS NOT 'text'
        LIMIT 1`).get()
      ) throw new Error("Invalid archived Sentinel traffic annotation binding");
      const amendments = db.prepare(
        "SELECT * FROM traffic_link_annotations LIMIT 4097",
      ).all();
      if (amendments.length > 4096) {
        throw new Error("Invalid archived Sentinel traffic annotation count");
      }
      for (const row of amendments) decodeSentinelTrafficLinkAnnotation(row);
    }
    if (tables.has("traffic_link_composition")) {
      requireColumns(db, "traffic_link_composition", [
        "sequence",
        "id",
        "request_id",
        "revision",
        "finding_id",
        "input",
        "recorded_at",
      ]);
      const budget = db.prepare(
        "SELECT count(*) AS count, sum(length(input)) AS bytes FROM traffic_link_composition",
      ).get();
      if (
        Number(budget?.count) > 4096 ||
        Number(budget?.bytes ?? 0) > MAX_TRAFFIC_COMPOSITION_JOURNAL_BYTES
      ) {
        throw new Error("Invalid archived Sentinel traffic set budget");
      }
      const rows = db.prepare(
        "SELECT * FROM traffic_link_composition LIMIT 4097",
      ).all();
      if (rows.length > 4096) {
        throw new Error("Invalid archived Sentinel traffic set size");
      }
      const exactLink = db.prepare(
        "SELECT id FROM traffic_links WHERE id = ? AND revision = ? AND finding_id = ?",
      );
      for (const row of rows) {
        const edit = decodeSentinelTrafficComposition(row);
        const ids = edit.operation === "withdraw"
          ? [edit.linkId]
          : edit.linkIds;
        if (
          edit.caseId !== caseId || edit.evidenceRevision > revision ||
          (edit.evidenceRevision === revision && edit.runId !== runId) ||
          ids.some((id) =>
            !exactLink.get(id, edit.evidenceRevision, edit.findingId)
          )
        ) {
          throw new Error("Foreign Sentinel archive traffic set scope");
        }
      }
    }
    if (tables.has("traffic_links")) {
      requireColumns(db, "traffic_links", ["recorded_at"]);
      const links = db.prepare("SELECT * FROM traffic_links LIMIT 4097").all();
      if (links.length > 4096) {
        throw new Error("Invalid archived Sentinel traffic link count");
      }
      for (const row of links) decodeSentinelFindingTrafficLink(row, caseId);
    }
    if (tables.has("traffic_link_batches")) {
      requireColumns(db, "traffic_link_batches", [
        "request_id",
        "run_id",
        "revision",
        "finding_id",
        "binding",
        "link_ids",
      ]);
      const rows = db.prepare("SELECT * FROM traffic_link_batches LIMIT 4097")
        .all();
      if (rows.length > 4096) {
        throw new Error("Invalid archived Sentinel traffic batch count");
      }
      const exactLink = db.prepare(
        "SELECT id FROM traffic_links WHERE id = ? AND revision = ? AND finding_id = ?",
      );
      for (const row of rows) {
        const ids = JSON.parse(String(row.link_ids));
        if (
          typeof row.request_id !== "string" || !uuid.test(row.request_id) ||
          typeof row.run_id !== "string" || !uuid.test(row.run_id) ||
          typeof row.revision !== "number" ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 1 || row.revision > revision ||
          (row.revision === revision && row.run_id !== runId) ||
          typeof row.finding_id !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(row.finding_id) ||
          typeof row.binding !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.binding) ||
          !Array.isArray(ids) || ids.length < 2 ||
          ids.length > MAX_FINDING_TRAFFIC_BATCH ||
          new Set(ids).size !== ids.length ||
          ids.some((id) =>
            typeof id !== "string" ||
            !/^finding-traffic-link:[a-f0-9]{64}$/.test(id) ||
            !exactLink.get(id, row.revision as number, row.finding_id as string)
          )
        ) throw new Error("Invalid archived Sentinel traffic batch scope");
      }
    }
    if (tables.has("inconclusive_rechecks")) {
      requireColumns(db, "inconclusive_rechecks", [
        "id",
        "requestId",
        "revision",
        "taskId",
        "findingId",
        "input",
        "recordedAt",
      ]);
      const rows = db.prepare("SELECT * FROM inconclusive_rechecks LIMIT 4097")
        .all();
      if (rows.length > 4096) {
        throw new Error("Invalid archived Sentinel inconclusive recheck count");
      }
      const origin = db.prepare(
        "SELECT input FROM receipts WHERE id = ? AND findingId IS NULL",
      );
      for (const raw of rows) {
        const record = decodeInconclusiveRecheck(raw);
        const finding = JSON.parse(
          String(origin.get(record.findingId)?.input ?? "null"),
        );
        if (
          !finding || finding.kind !== "finding" || finding.caseId !== caseId ||
          finding.runId !== record.runId ||
          finding.targetId !== record.targetId ||
          finding.evidenceRevision > record.evidenceRevision ||
          finding.taskId === record.taskId ||
          record.caseId !== caseId || record.evidenceRevision > revision ||
          (record.evidenceRevision === revision && record.runId !== runId)
        ) {
          throw new Error(
            "Invalid archived Sentinel inconclusive recheck scope",
          );
        }
      }
    }
    if (name === "sentinel-worker-findings.db") {
      const records = db.prepare(
        "SELECT id, input FROM receipts WHERE json_type(input, '$.analyst') IS NOT NULL LIMIT 4097",
      ).all();
      if (
        records.length > 4096 ||
        records.some(({ input, id }) => !validPortableAnalystFinding(input, id))
      ) throw new Error("Invalid archived Sentinel analyst finding");
    }
    const scoped = name === "sentinel-worker-findings.db"
      ? { table: "receipts", column: "input", hasRun: true }
      : name === "sentinel-worker-graph-facts.db"
      ? { table: "worker_graph_facts", column: "receipt", hasRun: true }
      : name === "sentinel-finding-traffic-links.db"
      ? { table: "traffic_links", column: "input", hasRun: false }
      : undefined;
    if (!scoped) return;
    const { table, column, hasRun } = scoped;
    // Historical earlier runs retain their original scope; current revision must match the manifest run.
    const invalid = db.prepare(`SELECT 1 FROM ${table}
      WHERE json_type(${column}, '$.caseId') IS NOT 'text'
        OR json_extract(${column}, '$.caseId') IS NOT ?
        OR json_type(${column}, '$.evidenceRevision') IS NOT 'integer'
        OR json_extract(${column}, '$.evidenceRevision') NOT BETWEEN 1 AND ?
        ${
      hasRun
        ? `OR (json_extract(${column}, '$.evidenceRevision') = ?
          AND json_extract(${column}, '$.runId') IS NOT ?)`
        : ""
    }
      LIMIT 1`).get(caseId, revision, ...(hasRun ? [revision, runId] : []));
    if (invalid) throw new Error("Foreign Sentinel archive receipt scope");
  });
}

/** Verify typed planner citations against the signed verdict and assignment journals. */
function validateArchivedRepositoryVerdictCitations(
  findingsPath: string | undefined,
  adaptivePath: string | undefined,
) {
  if (!adaptivePath) return;
  const adaptive = new DatabaseSync(adaptivePath, { readOnly: true });
  try {
    adaptive.exec("PRAGMA trusted_schema = OFF");
    if (
      !adaptive.prepare(
        "SELECT name FROM pragma_table_info('adaptive_tasks') WHERE name = 'plannerRound'",
      ).get()
    ) return;
    const citations = adaptive.prepare(`
      SELECT revision, nodeId, plannerRound FROM adaptive_tasks
      WHERE json_valid(plannerRound)
        AND json_type(plannerRound, '$.repositoryVisibility.verdictId') IS NOT NULL
    `).all();
    if (!citations.length) return;
    const invalid = () =>
      new Error("Invalid archived Sentinel repository verdict citation");
    if (!findingsPath) throw invalid();
    const mappingFor = adaptive.prepare(
      "SELECT goalId, evidenceNumber FROM adaptive_evidence_revisions WHERE revision = ?",
    );
    const findings = new DatabaseSync(findingsPath, { readOnly: true });
    try {
      findings.exec("PRAGMA trusted_schema = OFF");
      const receiptFor = findings.prepare(
        "SELECT * FROM receipts WHERE id = ?",
      );
      const settlements = new Map<
        string,
        ReturnType<typeof readSentinelDedicatedRecheckSettlements>
      >();
      for (const citation of citations) {
        const reference = typeof citation.plannerRound === "string"
          ? repositoryVisibilityReference(
            JSON.parse(citation.plannerRound).repositoryVisibility,
          )
          : undefined;
        if (!reference?.verdictId || typeof citation.revision !== "string") {
          throw invalid();
        }
        const mapping = mappingFor.get(citation.revision);
        const row = receiptFor.get(reference.verdictId);
        const receipt = row && decodeExactSentinelFindingReceipt(row);
        if (
          receipt?.kind !== "recheck" || receipt.runId !== mapping?.goalId ||
          receipt.evidenceRevision !== mapping?.evidenceNumber ||
          receipt.targetId !== citation.nodeId ||
          receipt.nativeRepositoryVisibility?.taskId !== reference.taskId ||
          receipt.nativeRepositoryVisibility.sourceStepIndex !==
            reference.sourceStepIndex ||
          receipt.nativeRepositoryVisibility.resultSha256 !==
            reference.resultSha256
        ) throw invalid();
        const scopedSettlements = settlements.get(citation.revision) ??
          readSentinelDedicatedRecheckSettlements(
            adaptivePath,
            receipt.runId,
            receipt.evidenceRevision,
          );
        settlements.set(citation.revision, scopedSettlements);
        const settlement = scopedSettlements.get(reference.taskId);
        if (
          !settlement?.completed ||
          settlement.findingId !== receipt.findingId ||
          settlement.evidenceId !== receipt.evidenceId
        ) throw invalid();
      }
    } finally {
      findings.close();
    }
  } finally {
    adaptive.close();
  }
}

/** Bind retained native rechecks to the original finding and exact repository result. */
function validateArchivedRepositoryRechecks(
  findingsPath: string | undefined,
  adaptivePath: string | undefined,
  assessment: string,
  caseId: string,
) {
  if (!findingsPath) return;
  const findings = new DatabaseSync(findingsPath, { readOnly: true });
  try {
    findings.exec("PRAGMA trusted_schema = OFF");
    const rows = findings.prepare(`SELECT * FROM receipts
      WHERE json_type(input, '$.nativeRepositoryVisibility') IS NOT NULL
      LIMIT 4097`).all();
    if (!rows.length) return;
    const invalid = () =>
      new Error("Invalid archived Sentinel repository visibility recheck");
    if (!adaptivePath || rows.length > 4096) throw invalid();
    const adaptive = new DatabaseSync(adaptivePath, { readOnly: true });
    try {
      adaptive.exec("PRAGMA trusted_schema = OFF");
      const assignment = adaptive.prepare(
        `SELECT task.nodeId, task.kind, task.depth,
          task.plannerRound
        FROM adaptive_tasks AS task
        JOIN adaptive_evidence_revisions AS mapping ON mapping.revision = task.revision
        WHERE task.id = ? AND mapping.goalId = ? AND mapping.evidenceNumber = ?`,
      );
      const finding = findings.prepare("SELECT * FROM receipts WHERE id = ?");
      for (const row of rows) {
        const recheck = decodeExactSentinelFindingReceipt(row);
        if (
          recheck?.kind !== "recheck" || !recheck.nativeRepositoryVisibility ||
          recheck.caseId !== caseId ||
          readSentinelRunIdForRevision(assessment, recheck.evidenceRevision) !==
            recheck.runId
        ) throw invalid();
        const originalRow = finding.get(recheck.findingId);
        const original = originalRow &&
          decodeExactSentinelFindingReceipt(originalRow);
        if (
          original?.kind !== "finding" || original.caseId !== caseId ||
          original.runId !== recheck.runId ||
          readSentinelRunIdForRevision(
              assessment,
              original.evidenceRevision,
            ) !==
            original.runId ||
          original.evidenceRevision > recheck.evidenceRevision ||
          original.targetId !== recheck.targetId ||
          original.graphFindingId !== recheck.graphFindingId ||
          original.controlId !== recheck.controlId
        ) throw invalid();
        const task = assignment.get(
          recheck.taskId,
          recheck.runId,
          recheck.evidenceRevision,
        );
        const followup = typeof task?.plannerRound === "string"
          ? JSON.parse(task.plannerRound)?.findingFollowup
          : undefined;
        const binding = repositoryVisibilityRecheckBinding(
          followup?.nativeRepositoryVisibility,
        );
        const source = readAdaptiveRepositoryVisibility(
          adaptivePath,
          recheck.runId,
          recheck.evidenceRevision,
          recheck.taskId,
          recheck.targetId,
          true,
        );
        const snapshot = readSentinelAssessmentRevision(
          assessment,
          recheck.evidenceRevision,
        )
          ?.result.sharedGraph.snapshot;
        const originalEvidence = snapshot?.nodes.find(({ id }) =>
          id === original.evidenceId
        );
        if (
          task?.nodeId !== recheck.targetId ||
          task.kind !== "trace" || task.depth !== 1 ||
          followup?.findingId !== original.id ||
          followup.sourceTaskId !== original.taskId ||
          followup.sourceAnalystSha256 !==
            ("analyst" in original
              ? createHash("sha256").update(JSON.stringify(original.analyst))
                .digest("hex")
              : undefined) ||
          followup.evidenceId !== original.evidenceId ||
          followup.sourceRevision !== original.evidenceRevision ||
          followup.assignedRevision !== recheck.evidenceRevision ||
          followup.snapshotDigest !== original.snapshotDigest ||
          !binding || !source?.reference ||
          source.reference.sourceStepIndex !==
            recheck.nativeRepositoryVisibility.sourceStepIndex ||
          source.reference.resultSha256 !==
            recheck.nativeRepositoryVisibility.resultSha256 ||
          source.receipt.repository !== binding.repository ||
          source.receipt.repositoryId !== binding.repositoryId ||
          !snapshot ||
          digestSentinelSnapshot(snapshot) !== recheck.snapshotDigest ||
          originalEvidence?.kind !== "evidence" ||
          originalEvidence.executionSource?.resultSha256 !==
            binding.originalSha256 ||
          source.receipt.observedAt !== recheck.observedAt ||
          (source.receipt.visibility === "private" ? "pass" : "fail") !==
            recheck.outcome ||
          recheck.observedAt <= original.observedAt ||
          Date.parse(recheck.validUntil) - Date.parse(recheck.observedAt) !==
            Date.parse(original.validUntil) - Date.parse(original.observedAt)
        ) throw invalid();
        const originalSnapshot = readSentinelAssessmentRevision(
          assessment,
          original.evidenceRevision,
        )?.result.sharedGraph.snapshot;
        if (!originalSnapshot) throw invalid();
        const control = {
          assetId: recheck.targetId,
          findingId: recheck.graphFindingId,
          controlId: recheck.controlId,
        };
        const initial = verifyWorkerFindingRecheck(
          originalSnapshot,
          {
            caseId,
            evidenceRevision: original.evidenceRevision,
            evaluatedAt: original.evaluatedAt,
          },
          { ...control, evidenceId: original.evidenceId },
          ({ id }) => id === original.evidenceId,
        );
        const latest = verifyWorkerFindingRecheck(
          withRepositoryVisibilityVerification(
            snapshot,
            recheck.evidenceId,
            recheck.targetId,
            recheck.controlId,
            recheck,
          ),
          {
            caseId,
            evidenceRevision: recheck.evidenceRevision,
            evaluatedAt: recheck.evaluatedAt,
          },
          { ...control, evidenceId: recheck.evidenceId },
          ({ id }) => id === recheck.evidenceId,
        );
        if (
          initial?.outcome !== "fail" ||
          initial.snapshotDigest !== original.snapshotDigest ||
          initial.observedAt !== original.observedAt ||
          initial.validUntil !== original.validUntil ||
          latest?.outcome !== recheck.outcome ||
          latest.observedAt !== recheck.observedAt ||
          latest.validUntil !== recheck.validUntil
        ) throw invalid();
      }
    } finally {
      adaptive.close();
    }
  } finally {
    findings.close();
  }
}

/** Require the two archived journal halves to name the same finished publication. */
function validateArchivedTrafficFindingPublications(
  findingsPath: string | undefined,
  linksPath: string | undefined,
  adaptivePath: string | undefined,
  caseId: string,
) {
  const findings = findingsPath &&
    new DatabaseSync(findingsPath, { readOnly: true });
  const links = linksPath && new DatabaseSync(linksPath, { readOnly: true });
  try {
    const table = (db: DatabaseSync | undefined, name: string) =>
      db?.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(name);
    const published = findings && table(findings, "staged_traffic_findings")
      ? findings.prepare(
        `SELECT stage.*, receipt.input AS saved FROM staged_traffic_findings AS stage
        LEFT JOIN receipts AS receipt ON receipt.id = stage.findingId
        LIMIT 4097`,
      ).all()
      : [];
    const attachments = links && table(links, "staged_publication_links")
      ? links.prepare(`SELECT links.* FROM staged_publication_links AS stage
        LEFT JOIN traffic_links AS links ON links.id = stage.link_id LIMIT 4097`)
        .all()
      : [];
    if (published.length > 4096 || attachments.length > 4096) {
      throw new Error(
        "Invalid archived Sentinel finding traffic publication count",
      );
    }
    const retained = attachments.map((row) =>
      decodeSentinelFindingTrafficLink(row, caseId)
    );
    const byRequest = new Map(retained.map((link) => [link.requestId, link]));
    const byId = new Map(retained.map((link) => [link.id, link]));
    const used = new Set<string>();
    const batches = links && table(links, "traffic_link_batches")
      ? links.prepare("SELECT * FROM traffic_link_batches WHERE request_id = ?")
      : undefined;
    for (const row of published) {
      const staged = decodeStagedTrafficFinding(row, caseId);
      if (!staged || row.input !== row.saved) {
        throw new Error(
          "Invalid archived Sentinel finding traffic publication",
        );
      }
      const items = stagedTrafficItems(staged);
      for (const item of items) {
        if (item.sourceHintId === undefined) continue;
        const ref = adaptivePath &&
          readAdaptiveOperatorTrafficHint(
            adaptivePath,
            item.sourceHintId,
            staged.finding.evidenceRevision,
            staged.finding.runId,
            staged.finding.targetId,
            item,
          );
        if (
          !ref || ref.evidenceId !== item.evidenceId ||
          ref.digest !== item.digest
        ) throw new Error("Invalid archived Sentinel finding traffic hint");
      }
      const batch = Array.isArray(staged.traffic) &&
        batches?.get(staged.finding.requestId);
      const bound = Array.isArray(staged.traffic)
        ? batch && batch.run_id === staged.finding.runId &&
            batch.revision === staged.finding.evidenceRevision &&
            batch.finding_id === staged.findingId
          ? (JSON.parse(String(batch.link_ids)) as string[]).map((id) =>
            byId.get(id)
          )
          : []
        : [byRequest.get(staged.finding.requestId)];
      if (
        bound.length !== items.length ||
        bound.some((link, index) =>
          !link || used.has(link.id) ||
          !stagedTrafficLinkMatches(staged, link, items[index], index)
        )
      ) {
        throw new Error(
          "Mismatched archived Sentinel finding traffic publication",
        );
      }
      if (
        batch && sentinelTrafficBatchBinding(
            caseId,
            staged.finding.runId,
            staged.finding.requestId,
            bound.filter((link): link is NonNullable<typeof link> => !!link),
          ) !== batch.binding
      ) {
        throw new Error("Invalid archived staged traffic batch binding");
      }
      for (const link of bound) used.add(link!.id);
    }
    if (used.size !== retained.length) {
      throw new Error(
        "Incomplete archived Sentinel finding traffic publication",
      );
    }
  } finally {
    if (findings) findings.close();
    if (links) links.close();
  }
}

function rejectDuplicateRun(baseDir: string, caseId: string, runId: string) {
  for (const existing of ["main", ...listSentinelCaseIds(baseDir)]) {
    if (existing === caseId) continue;
    const path = join(
      dirname(resolveSentinelCasePath(baseDir, existing)),
      assessmentFile,
    );
    try {
      const info = Deno.lstatSync(path);
      if (
        !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
        (info.mode !== null && (info.mode & 0o077) !== 0)
      ) {
        throw new Error("Unable to verify existing Sentinel case identity");
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      const row = db.prepare("SELECT plan FROM assessment WHERE id = 1").get();
      if (
        typeof row?.plan === "string" &&
        object(JSON.parse(row.plan)).runId === runId
      ) {
        throw new Deno.errors.AlreadyExists(
          "The Sentinel run already belongs to another case",
        );
      }
    } finally {
      db.close();
    }
  }
}

const restoreMarker = ".restore-in-progress";
const restoreReceipt = ".restore-receipt.json";

function fileDigest(path: string) {
  return createHash("sha256").update(Deno.readFileSync(path)).digest("hex");
}

function readRestoreMarker(marker: string) {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(marker);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    info.size > 4096 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) return undefined;
  return object(JSON.parse(Deno.readTextFileSync(marker)));
}

function matchesPublishedRestore(
  destination: string,
  archiveDigest: string,
  requestId: string,
  snapshotDigest: string,
  files: readonly { name: Artifact }[],
) {
  const directory = dirname(destination);
  for (const name of [restoreReceipt, restoreMarker]) {
    const marker = readRestoreMarker(join(directory, name));
    if (
      marker?.archiveDigest !== archiveDigest || marker.requestId !== requestId
    ) continue;
    const digests = object(marker.digests);
    if (
      Object.keys(digests).length !== files.length ||
      digests[snapshotFile] !== snapshotDigest
    ) return false;
    try {
      assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
      return files.every(({ name }) => {
        const path = join(directory, name);
        const info = Deno.lstatSync(path);
        return info.isFile && !info.isSymlink && (info.nlink ?? 1) === 1 &&
          ((info.mode ?? 0) & 0o077) === 0 && info.size <= 64 * 1024 * 1024 &&
          fileDigest(path) === digests[name];
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  return false;
}

/** Reclaim only an unpublished directory containing exact files from this restore. */
function reclaimUnpublishedRestore(directory: string, archiveDigest: string) {
  const directoryInfo = Deno.lstatSync(directory);
  if (
    !directoryInfo.isDirectory || directoryInfo.isSymlink ||
    ((directoryInfo.mode ?? 0) & 0o077) !== 0
  ) return false;
  const marker = join(directory, restoreMarker);
  const saved = readRestoreMarker(marker);
  if (saved?.archiveDigest !== archiveDigest) return false;
  const digests = object(saved.digests);
  const files: string[] = [];
  for (const { name } of Deno.readDirSync(directory)) {
    if (name === restoreMarker) continue;
    if (
      name === snapshotFile ||
      !permittedSentinelRestoreArtifacts.some((allowed) => allowed === name)
    ) return false;
    const path = join(directory, name);
    const file = Deno.lstatSync(path);
    if (
      !file.isFile || file.isSymlink || file.size > 64 * 1024 * 1024 ||
      ((file.mode ?? 0) & 0o077) !== 0 ||
      typeof digests[name] !== "string" || fileDigest(path) !== digests[name]
    ) return false;
    files.push(path);
  }
  for (const file of files) Deno.removeSync(file);
  Deno.removeSync(marker);
  Deno.removeSync(directory);
  return true;
}

function install(
  destination: string,
  files: readonly { name: Artifact; source: string }[],
  archiveDigest: string,
  requestId: string | undefined,
  recordLinks: (stageFiles: () => void) => void,
) {
  const directory = dirname(destination);
  const parent = dirname(directory);
  Deno.mkdirSync(parent, { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(Deno.lstatSync(parent));
  const installed: string[] = [];
  let reserved = false;
  const snapshot = files.find(({ name }) => name === snapshotFile);
  if (!snapshot) throw new Error("Sentinel restore has no snapshot");
  try {
    recordLinks(() => {
      const marker = join(directory, restoreMarker);
      const contents = JSON.stringify({
        archiveDigest,
        ...(requestId && { requestId }),
        digests: Object.fromEntries(
          files.map(({ name, source }) => [name, fileDigest(source)]),
        ),
      });
      const writeMarker = (path: string) =>
        Deno.writeTextFileSync(path, contents, {
          createNew: true,
          mode: 0o600,
        });
      if (Deno.build.os === "linux") {
        const prepared = Deno.makeTempDirSync({
          dir: parent,
          prefix: ".restore-",
        });
        try {
          writeMarker(join(prepared, restoreMarker));
          reserved = publishSentinelRestoreReservation(prepared, directory);
        } finally {
          if (!reserved) Deno.removeSync(prepared, { recursive: true });
        }
      }
      if (!reserved) {
        Deno.mkdirSync(directory, { mode: 0o700 });
        reserved = true;
        writeMarker(marker);
      }
      installed.push(marker);
      for (const { name, source } of files) {
        if (name === snapshotFile) continue;
        const target = join(directory, name);
        Deno.linkSync(source, target);
        installed.push(target);
        Deno.removeSync(source);
      }
    });
    // Readers discover the case only after its link journal has committed.
    // A retry can reclaim the exact staged files if this process stops here.
    try {
      Deno.lstatSync(destination);
      throw new Deno.errors.AlreadyExists(
        "Sentinel restore snapshot already exists",
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    Deno.renameSync(snapshot.source, destination);
    try {
      const marker = join(directory, restoreMarker);
      if (requestId) Deno.renameSync(marker, join(directory, restoreReceipt));
      else Deno.removeSync(marker);
    } catch {
      /* The original marker still proves publication after a retry. */
    }
  } catch (error) {
    for (const path of installed.reverse()) {
      try {
        Deno.removeSync(path);
      } catch { /* Retain the original failure. */ }
    }
    if (reserved) {
      try {
        Deno.removeSync(directory);
      } catch { /* Retain the original failure. */ }
    }
    throw error;
  }
}

/** Read only retained revisions whose saved run identity matches the archive. */
export function sentinelArchiveLinkRevisions(
  assessment: string,
  runId: string,
  current: number,
) {
  const db = new DatabaseSync(assessment, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    if (
      !db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assessment_run_revisions'",
      ).get()
    ) {
      return [current];
    }
    const earlier = db.prepare(`
      SELECT revision FROM assessment_run_revisions
      JOIN assessment_history USING (revision)
      WHERE runId = ? AND revision < ? ORDER BY revision
    `).all(runId, current).map(({ revision }) => Number(revision));
    return [...earlier, current];
  } finally {
    db.close();
  }
}

/** Verify graph citations against the saved tool exchanges before publishing. */
function validateNativeWorkflowCitations(
  adaptive: string | undefined,
  assessment: string,
  revisions: readonly number[],
  runId: string,
  graph: ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>,
) {
  const snapshots = [
    graph,
    ...revisions.map((revision) =>
      readSentinelAssessmentRevision(assessment, revision)?.result.sharedGraph
        .snapshot
    ),
  ];
  const citations = snapshots.flatMap((snapshot) =>
    snapshot?.nodes.flatMap((node) =>
      node.kind === "evidence" && node.nativeWorkflowSource
        ? [{ node, source: node.nativeWorkflowSource, edges: snapshot.edges }]
        : []
    ) ?? []
  );
  if (!citations.length) return;
  const missing = () =>
    new Error("Archive is missing exact native workflow evidence");
  if (!adaptive) throw missing();
  const store = openSentinelAdaptiveStore(adaptive);
  try {
    const resolved = new Map<
      string,
      NonNullable<ReturnType<typeof readNativeWorkflowCitation>>
    >();
    for (const { node, source, edges } of citations) {
      if (source.runId !== runId || !revisions.includes(source.revision)) {
        throw missing();
      }
      const key = JSON.stringify(source);
      const receipt = resolved.get(key) ??
        readNativeWorkflowCitation(store, source);
      if (
        !receipt ||
        !edges.some(({ from, to, relation }) =>
          from === node.id && to === receipt.assetId &&
          relation === "observed_on"
        ) ||
        receipt.candidate.outcome !== node.controlVerification?.outcome ||
        receipt.saved.observedAt !== node.controlVerification.observedAt
      ) throw missing();
      resolved.set(key, receipt);
    }
  } finally {
    store.close();
  }
}

function parseArchivedLinkGroups(
  value: unknown,
  caseId: string,
  current: number,
  retained: ReadonlySet<number>,
): {
  ref: { kind: "sentinel"; id: string; revision: number };
  links: readonly ArchivedOperatorRunLink[];
}[] {
  const input = Array.isArray(value)
    ? [{ revision: current, links: value }]
    : object(value).version === 1
    ? object(value).revisions
    : undefined;
  if (!Array.isArray(input) || input.length > retained.size) {
    throw new Error("Invalid archived Sentinel link groups");
  }
  const seen = new Set<number>();
  return input.map((raw) => {
    const { revision, links } = object(raw);
    if (
      typeof revision !== "number" || !retained.has(revision) ||
      seen.has(revision) || !Array.isArray(links)
    ) throw new Error("Invalid archived Sentinel link revision");
    seen.add(revision);
    return { ref: { kind: "sentinel", id: caseId, revision }, links };
  });
}

/** Install only a complete staged named case, paused without runnable archived authority. */
export async function restoreVerifiedSentinelCaseArchive(
  baseDir: string,
  archive: VerifiedRunArchive,
  request?: { requestId: string; recovering: boolean },
) {
  const { kind, id: caseId, runId, revision } = archive.manifest.identity;
  if (
    archive.manifest.version !== 1 || kind !== "sentinel" ||
    !isSentinelCaseId(caseId) || caseId === "main" ||
    typeof runId !== "string" || !uuid.test(runId) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    archive.manifest.artifacts.some(({ name }) =>
      !permittedSentinelRestoreArtifacts.some((artifact) => artifact === name)
    )
  ) throw new Error("Invalid named Sentinel archive identity or artifacts");
  const destination = resolveSentinelCasePath(baseDir, caseId);
  const archiveDigest = createHash("sha256").update(
    JSON.stringify(archive.manifest),
  ).digest("hex");
  const snapshot = stagedPath(archive, snapshotFile);
  const assessment = stagedPath(archive, assessmentFile);
  const adaptive = stagedPath(archive, adaptiveFile);
  if (!snapshot || !assessment) {
    throw new Error("Sentinel archive is missing required artifacts");
  }
  const graph = loadSentinelGraph(await readSentinelChatSnapshot(snapshot))
    .snapshot();
  restoreAssessment(
    assessment,
    caseId,
    revision,
    runId,
    digestSentinelSnapshot(graph),
  );
  const revisions = sentinelArchiveLinkRevisions(assessment, runId, revision);
  if (adaptive) {
    restoreAdaptive(adaptive, assessment, caseId, revision, runId, revisions);
  }
  validateNativeWorkflowCitations(
    adaptive,
    assessment,
    revisions,
    runId,
    graph,
  );
  const auxiliary = auxiliaryArtifacts.flatMap((name) => {
    const source = stagedPath(archive, name);
    if (!source) return [];
    validateAuxiliary(source, name, caseId, runId, revision);
    return [{ name, source }];
  });
  const findings = auxiliary.find(({ name }) =>
    name === "sentinel-worker-findings.db"
  )?.source;
  validateArchivedRepositoryRechecks(
    findings,
    adaptive,
    assessment,
    caseId,
  );
  validateArchivedRepositoryVerdictCitations(findings, adaptive);
  validateArchivedTrafficFindingPublications(
    findings,
    auxiliary.find(({ name }) => name === "sentinel-finding-traffic-links.db")
      ?.source,
    adaptive,
    caseId,
  );
  const sourceBundles: { name: Artifact; source: string }[] = [];
  const toolDecisions = stagedPath(archive, sentinelArchivedToolDecisionsFile);
  if (toolDecisions) {
    if (Deno.lstatSync(toolDecisions).size > 1024 * 1024) {
      throw new Error("Archived tool decisions are too large.");
    }
    decodeSentinelToolDecisions(
      JSON.parse(Deno.readTextFileSync(toolDecisions)),
      caseId,
      runId,
    );
    sourceBundles.push({
      name: sentinelArchivedToolDecisionsFile,
      source: toolDecisions,
    });
  }
  const publications = stagedPath(
    archive,
    sentinelWorkerFindingPublicationFile,
  );
  if (publications) {
    const info = Deno.lstatSync(publications);
    if (info.size > 1024 * 1024) {
      throw new Error("Invalid archived Sentinel finding publications");
    }
    const entries = decodeSentinelWorkerFindingPublications(
      JSON.parse(Deno.readTextFileSync(publications)),
      caseId,
    );
    const receipts = readSentinelCaseFindingReceipts(
      snapshot,
      entries.map(({ finding }) => finding.id),
    );
    if (
      entries.some(({ finding, targetId }) => {
        const source = finding.workerFindingSource!;
        const receipt = receipts.get(source.receiptId);
        return source.runId !== runId || !revisions.includes(source.revision) ||
          receipt?.kind !== "finding" || receipt.caseId !== caseId ||
          receipt.runId !== runId ||
          receipt.evidenceRevision !== source.revision ||
          receipt.taskId !== source.taskId ||
          !isDeepStrictEqual(
            "analyst" in receipt ? receipt.analyst : undefined,
            source.analyst,
          ) ||
          receipt.evidenceId !== source.evidenceId ||
          receipt.snapshotDigest !== source.snapshotDigest ||
          receipt.targetId !== targetId;
      })
    ) {
      throw new Error(
        "Archived Sentinel finding publications lack exact source receipts",
      );
    }
    sourceBundles.push({
      name: sentinelWorkerFindingPublicationFile,
      source: publications,
    });
  }
  const digestCatalog = stagedPath(archive, sentinelArchivedDigestFile);
  if (digestCatalog) {
    readSentinelArchivedDigestCatalog(
      digestCatalog,
      { caseId, runId },
      revisions,
    );
    sourceBundles.push({
      name: sentinelArchivedDigestFile,
      source: digestCatalog,
    });
  }
  const discoveries = stagedPath(archive, sentinelArchivedDiscoveriesFile);
  validateArchivedDiscoveryApprovals(
    discoveries,
    adaptive,
    { caseId, runId },
    revisions,
  );
  if (discoveries) {
    sourceBundles.push({
      name: sentinelArchivedDiscoveriesFile,
      source: discoveries,
    });
  }
  const execution = stagedPath(archive, sentinelExecutionEvidenceFile);
  await validateCaseExecutionEvidence(execution, assessment, revisions, graph);
  if (execution) {
    sourceBundles.push({
      name: sentinelExecutionEvidenceFile,
      source: execution,
    });
  }
  for (
    const name of [
      sentinelArchivedTopologyFile,
      sentinelArchivedAssessmentSourcesFile,
    ] as const
  ) {
    const source = stagedPath(archive, name);
    await validateArchivedSourceSnapshots(source, {
      kind: name === sentinelArchivedTopologyFile
        ? "topology"
        : "assessment_reviews",
      path: snapshot,
      revisions,
    });
    if (source) sourceBundles.push({ name, source });
  }
  for (
    const name of [
      sentinelArchivedFindingSourcesFile,
      sentinelArchivedTraceSourcesFile,
      sentinelArchivedPlannerSourcesFile,
    ] as const
  ) {
    const source = stagedPath(archive, name);
    if (!adaptive) {
      if (source) {
        throw new Error(
          "Archived adaptive sources require retained assignments",
        );
      }
      continue;
    }
    await validateArchivedSourceSnapshots(source, {
      kind: "adaptive",
      path: adaptive,
      runId,
      revision,
      source: name === sentinelArchivedTraceSourcesFile
        ? "worker_traces"
        : name === sentinelArchivedPlannerSourcesFile
        ? "planner_reads"
        : "findings",
    });
    if (source) sourceBundles.push({ name, source });
  }
  const archivedLinks = stagedPath(archive, sentinelArchivedLinksFile);
  const links = archivedLinks === undefined
    ? undefined
    : parseArchivedLinkGroups(
      JSON.parse(await Deno.readTextFile(archivedLinks)),
      caseId,
      revision,
      new Set(revisions),
    );
  const files: { name: Artifact; source: string }[] = [
    { name: assessmentFile, source: assessment },
    ...(adaptive ? [{ name: adaptiveFile, source: adaptive }] as const : []),
    ...auxiliary,
    ...sourceBundles,
    { name: snapshotFile, source: snapshot },
  ];
  await withSentinelSourceSnapshotLock(baseDir, true, () => {
    try {
      Deno.lstatSync(dirname(destination));
      if (
        request?.recovering &&
        matchesPublishedRestore(
          destination,
          archiveDigest,
          request.requestId,
          fileDigest(snapshot),
          files,
        )
      ) return;
      if (!reclaimUnpublishedRestore(dirname(destination), archiveDigest)) {
        throw new Deno.errors.AlreadyExists("The Sentinel case already exists");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    rejectDuplicateRun(baseDir, caseId, runId);
    install(
      destination,
      files,
      archiveDigest,
      request?.requestId,
      (installFiles) => {
        if (links === undefined) return installFiles();
        const journal = openOperatorRunLinkStore(
          join(baseDir, "operator-run-links.db"),
        );
        try {
          journal.installWithArchive(links, installFiles);
        } finally {
          journal.close();
        }
      },
    );
  });
  return {
    caseId,
    runId,
    evidenceRevision: revision,
    snapshotPath: destination,
  };
}
