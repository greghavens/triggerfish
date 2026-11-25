import { readSentinelFindingPageReference } from "./worker_goal_recovery.ts";
import { sentinelGoalReceiptReadArguments } from "./worker_goal_recovery.ts";
import { readSentinelTaskObservationPageReference } from "./worker_goal_recovery.ts";
import { readSentinelDiscoveryPageReference } from "./worker_goal_recovery.ts";
import { sentinelIntermediateWorkflowPageReference } from "./worker_goal_recovery.ts";
import { readSentinelGraphFactPageReference } from "./worker_graph_facts.ts";
import {
  SENTINEL_TRAFFIC_LINKS,
  SENTINEL_TRAFFIC_READ,
  SENTINEL_TRAFFIC_SEARCH,
  sentinelTrafficLinksArgs,
  sentinelTrafficPageReference,
  sentinelTrafficReadArgs,
} from "./traffic_recovery.ts";
/** Capture a stopped case as privately staged, sanitized archive artifacts. */
/// <reference path="./sqlite_types.d.ts" />
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  readSentinelGitHubWorkflowReadReceipt,
  withSentinelAssessmentWriteLock,
} from "./assessment_store.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";

export const sentinelCaseArchiveArtifactNames = [
  "sentinel.json",
  "sentinel-assessment.db",
  "sentinel-adaptive.db",
  "sentinel-goal-completion.db",
  "sentinel-worker-findings.db",
  "sentinel-worker-graph-facts.db",
  "sentinel-traffic-receipts.db",
  "sentinel-finding-traffic-links.db",
] as const;

export interface SentinelCaseArchiveScope {
  readonly caseId: string;
  readonly runId: string;
  readonly evidenceRevision: number;
}

export interface SentinelCaseArchiveArtifact {
  readonly name: typeof sentinelCaseArchiveArtifactNames[number];
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

const MAX_DB_BYTES = 32 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const assessmentTables = new Set([
  "assessment",
  "assessment_history",
  "assessment_reviews",
  "assessment_review_steps",
  "assessment_formal_goal_history",
  "assessment_run_revisions",
  "assessment_notification_settings",
  "assessment_incident_notification",
  "assessment_notification_retry_receipts",
  "assessment_alert_history",
  "assessment_formal_goal_requests",
  "assessment_worker_goal_proposals",
  "sentinel_operating_constraints",
  "assessment_goal_completion",
  "assessment_incident_reviews",
  "assessment_finding_reviews",
  "assessment_incident_review_carry",
  "assessment_finding_review_carry",
]);

const adaptiveTables = new Set([
  "adaptive_active",
  "adaptive_case_hints",
  "adaptive_dependencies",
  "adaptive_events",
  "adaptive_evidence_revisions",
  "adaptive_live_workflow_results",
  "adaptive_model_attempts",
  "adaptive_model_constraint_rounds",
  "adaptive_model_execution_receipt_rounds",
  "adaptive_model_decision_context",
  "adaptive_model_decision_inputs",
  "adaptive_model_formal_goal_rounds",
  "adaptive_model_hint_context",
  "adaptive_model_history",
  "adaptive_model_incident_inputs",
  "adaptive_model_input_manifests",
  "adaptive_model_language",
  "adaptive_model_leases",
  "adaptive_model_reads",
  "adaptive_model_review_constraint_proofs",
  "adaptive_model_reviews",
  "adaptive_model_usage",
  "adaptive_note_steps",
  "adaptive_notes",
  "adaptive_operator_assignment_intents",
  "adaptive_operator_case_hint_requests",
  "adaptive_peer_verifications",
  "adaptive_revisions",
  "adaptive_tasks",
  "adaptive_verification_sources",
  "adaptive_worker_checkpoints",
  "adaptive_assigned_target_batch_receipts",
  "adaptive_recheck_context_batch_receipts",
  "adaptive_traffic_links_batch_receipts",
  "adaptive_observation_search_batch_receipts",
  "adaptive_worker_controls",
  "adaptive_worker_progress",
  "adaptive_archived_worker_traces",
  "adaptive_worker_settings",
  "adaptive_workflow_observations",
]);

interface EvidenceStoreSchema {
  readonly applicationId?: number;
  readonly versions?: readonly number[];
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly optionalColumns?: readonly string[];
    readonly optionalTable?: boolean;
  }[];
}

const evidenceStoreSchemas: Partial<
  Record<
    SentinelCaseArchiveArtifact["name"],
    EvidenceStoreSchema
  >
> = {
  "sentinel-goal-completion.db": {
    tables: [
      { name: "goal_completion", columns: ["scope", "record"] },
      {
        name: "goal_evidence_submissions",
        columns: ["scope", "requestId", "binding", "receipt"],
        optionalTable: true,
      },
    ],
  },
  "sentinel-worker-findings.db": {
    applicationId: 0x53574644,
    versions: [1, 2],
    tables: [
      {
        name: "receipts",
        columns: ["id", "revision", "findingId", "input", "recordedAt"],
        optionalColumns: ["reportVersion"],
      },
      { name: "requests", columns: ["requestId", "receiptId"] },
    ],
  },
  "sentinel-worker-graph-facts.db": {
    applicationId: 0x53574746,
    versions: [1],
    tables: [{
      name: "worker_graph_facts",
      columns: [
        "id",
        "request_id",
        "run_id",
        "revision",
        "target_id",
        "task_id",
        "receipt",
        "recorded_at",
      ],
    }],
  },
  "sentinel-traffic-receipts.db": {
    tables: [{
      name: "traffic_receipts_v1",
      columns: ["evidenceId", "family", "record", "proof", "retainedAt"],
    }],
  },
  "sentinel-finding-traffic-links.db": {
    applicationId: 0x5346544c,
    versions: [1, 2],
    tables: [
      {
        name: "traffic_links",
        columns: [
          "id",
          "request_id",
          "revision",
          "finding_id",
          "input",
          "recorded_at",
        ],
      },
      {
        name: "traffic_link_request_aliases",
        columns: ["request_id", "link_id"],
        optionalTable: true,
      },
    ],
  },
};

function privateFile(path: string, optional = false): boolean {
  try {
    const info = Deno.lstatSync(path);
    if (
      !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
      (info.mode !== null && (info.mode & 0o077) !== 0) ||
      info.size > MAX_DB_BYTES
    ) throw new Error("Invalid Sentinel case archive database source.");
    return true;
  } catch (error) {
    if (optional && error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function quote(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function vacuumInto(db: DatabaseSync, path: string) {
  db.prepare("VACUUM INTO ?").run(path);
  Deno.chmodSync(path, 0o600);
  privateFile(path);
}

function removeUnrecognizedSchema(
  db: DatabaseSync,
  allowed: ReadonlySet<string>,
) {
  const schema = db.prepare(
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table','trigger','view') ORDER BY type DESC",
  ).all();
  for (const { name, type } of schema) {
    const id = String(name);
    if (id.startsWith("sqlite_")) continue;
    if (type === "trigger" || type === "view") {
      db.exec(`DROP ${type.toUpperCase()} ${quote(id)}`);
    }
  }
  for (const { name, type } of schema) {
    const id = String(name);
    if (type === "table" && !id.startsWith("sqlite_") && !allowed.has(id)) {
      db.exec(`DROP TABLE ${quote(id)}`);
    }
  }
}

function tableExists(db: DatabaseSync, name: string) {
  return db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
}

function validateEvidenceSchema(db: DatabaseSync, schema: EvidenceStoreSchema) {
  if (
    schema.applicationId !== undefined &&
      db.prepare("PRAGMA application_id").get()?.application_id !==
        schema.applicationId ||
    schema.versions !== undefined &&
      !schema.versions.includes(
        Number(db.prepare("PRAGMA user_version").get()?.user_version),
      )
  ) throw new Error("Unexpected Sentinel archive evidence-store identity.");
  for (const table of schema.tables) {
    if (table.optionalTable && !tableExists(db, table.name)) continue;
    const found = new Set(
      db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all().map((
        { name },
      ) => String(name)),
    );
    const permitted = new Set([
      ...table.columns,
      ...table.optionalColumns ?? [],
    ]);
    if (
      table.columns.some((column) => !found.has(column)) ||
      [...found].some((column) => !permitted.has(column))
    ) {
      throw new Error("Unexpected Sentinel archive evidence-store fields.");
    }
  }
}

function clearRows(db: DatabaseSync, tables: readonly string[]) {
  for (const table of tables) {
    if (tableExists(db, table)) db.exec(`DELETE FROM ${quote(table)}`);
  }
}

function discardStepExcerpts(db: DatabaseSync, table: string) {
  if (!tableExists(db, table)) return;
  db.exec(`
    UPDATE ${quote(table)}
    SET steps = (
      SELECT json_group_array(json(json_remove(value,'$.resultSnapshot')))
      FROM json_each(${quote(table)}.steps)
    )
  `);
}

function scrubAssessment(
  db: DatabaseSync,
  scope: SentinelCaseArchiveScope,
  snapshotDigest: string,
) {
  const current = db.prepare(
    "SELECT plan, active, revision FROM assessment WHERE id = 1",
  ).get();
  if (
    current?.active !== 0 || current.revision !== scope.evidenceRevision ||
    (JSON.parse(String(current.plan)) as { runId?: unknown }).runId !==
      scope.runId
  ) {
    throw new Error(
      "The named Sentinel case is not stopped at the requested run and revision.",
    );
  }
  if (tableExists(db, "assessment_reviews")) {
    db.exec("DELETE FROM assessment_reviews WHERE analysis IS NULL");
    db.exec("UPDATE assessment_reviews SET claim = 'archived'");
  }
  discardStepExcerpts(db, "assessment_review_steps");
  clearRows(db, [
    "assessment_incident_notification",
    "assessment_notification_retry_receipts",
  ]);
  db.exec(`
    CREATE TABLE assessment_archive_identity (
      caseId TEXT NOT NULL,
      runId TEXT NOT NULL,
      evidenceRevision INTEGER NOT NULL,
      snapshotDigest TEXT NOT NULL
    ) STRICT
  `);
  db.prepare("INSERT INTO assessment_archive_identity VALUES (?, ?, ?, ?)")
    .run(scope.caseId, scope.runId, scope.evidenceRevision, snapshotDigest);
}

function retainedTraceReceiptFields(step: Record<string, unknown>) {
  if (step.outcome !== "returned") return {};
  const uuid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const digest = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const fields: Record<string, unknown> = {};
  if (step.tool === "sentinel_graph_facts") {
    const page = readSentinelGraphFactPageReference(step.graphFactPage);
    if (page) fields.graphFactPage = page;
  }
  if (step.tool === "sentinel_intermediate_workflow_observation") {
    const page = sentinelIntermediateWorkflowPageReference(
      step.intermediateWorkflowPage,
    );
    if (page) fields.intermediateWorkflowPage = page;
  }
  if (step.tool === "sentinel_shared_asset_discoveries") {
    const page = readSentinelDiscoveryPageReference(step.discoveryPage);
    if (page) fields.discoveryPage = page;
  }
  if (step.tool === "sentinel_worker_observation") {
    const page = readSentinelTaskObservationPageReference(
      step.taskObservationPage,
    );
    if (page) fields.taskObservationPage = page;
  }
  if (
    step.tool === "sentinel_incident_alerts" || step.tool === "sentinel_defense"
  ) {
    const citation = step.goalReceiptRead as {
      args?: unknown;
      sha256?: unknown;
    } | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, citation?.args);
    if (args && digest(citation?.sha256)) {
      fields.goalReceiptRead = { args, sha256: citation?.sha256 };
    }
  }
  if (step.tool === "sentinel_worker_findings") {
    const page = readSentinelFindingPageReference(step.findingPage);
    if (page) fields.findingPage = page;
    const citation = step.goalReceiptRead as {
      args?: unknown;
      sha256?: unknown;
    } | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, citation?.args);
    if (args?.receiptId && digest(citation?.sha256)) {
      fields.goalReceiptRead = { args, sha256: citation?.sha256 };
    }
  }
  if (digest(step.resultSha256)) fields.resultSha256 = step.resultSha256;
  if (
    (step.tool === "sentinel_assigned_execution_evidence" ||
      step.tool === "sentinel_graph_facts" && typeof step.target === "string" &&
        /^worker-graph-fact:[a-f0-9]{64}$/.test(step.target)) &&
    !fields.resultSha256
  ) {
    const saved = step.goalReceiptRead as { sha256?: unknown } | undefined;
    if (digest(saved?.sha256)) fields.resultSha256 = saved.sha256;
  }
  if (step.tool === "sentinel_prove_goal" && uuid(step.goalProofRequestId)) {
    fields.goalProofRequestId = step.goalProofRequestId;
  }
  if (
    step.tool === "sentinel_submit_asset_discovery" &&
    uuid(step.assetDiscoveryRequestId)
  ) {
    fields.assetDiscoveryRequestId = step.assetDiscoveryRequestId;
  }
  if (step.tool === SENTINEL_TRAFFIC_READ) {
    const saved = step.trafficRead as Record<string, unknown> | undefined;
    const args = saved && sentinelTrafficReadArgs({
      revision: saved.revision,
      evidenceId: saved.evidenceId,
      digest: saved.digest,
    });
    if (
      args && /^(?:har|dns):evidence:[a-f0-9]{64}$/.test(args.evidenceId) &&
      digest(saved?.sha256)
    ) fields.trafficRead = { ...args, sha256: saved.sha256 };
  }
  if (step.tool === SENTINEL_TRAFFIC_LINKS) {
    const saved = step.trafficLinks as Record<string, unknown> | undefined;
    const args = sentinelTrafficLinksArgs(saved?.args);
    const linkIds = saved?.linkIds;
    const nextOffset = saved?.nextOffset;
    if (
      args && digest(saved?.sha256) && Array.isArray(linkIds) &&
      linkIds.length <= (args.limit ?? 5) &&
      new Set(linkIds).size === linkIds.length &&
      linkIds.every((id) =>
        typeof id === "string" && /^finding-traffic-link:[a-f0-9]{64}$/.test(id)
      ) &&
      (nextOffset === null || (linkIds.length > 0 &&
        nextOffset === (args.offset ?? 0) + linkIds.length))
    ) fields.trafficLinks = { args, linkIds, nextOffset, sha256: saved.sha256 };
  }
  if (step.tool === SENTINEL_TRAFFIC_SEARCH) {
    const page = sentinelTrafficPageReference(step.trafficSearchPage);
    if (page) fields.trafficSearchPage = page;
  }
  if (step.tool === "sentinel_live_workflow_status") {
    const revision =
      (step.githubWorkflowRead as { evidenceRevision?: unknown } | undefined)
        ?.evidenceRevision;
    const receipt = typeof revision === "number"
      ? readSentinelGitHubWorkflowReadReceipt(step.githubWorkflowRead, revision)
      : undefined;
    if (
      receipt?.connectorId === "github-actions" &&
      createHash("sha256").update(JSON.stringify(receipt.runs)).digest(
          "hex",
        ) === receipt.resultSha256
    ) fields.githubWorkflowRead = receipt;
  }
  return fields;
}

export function retainArchivedWorkerTraceMetadata(db: DatabaseSync) {
  const archivedTable = "adaptive_archived_worker_traces";
  const progressTable = "adaptive_worker_progress";
  if (!tableExists(db, archivedTable) && !tableExists(db, progressTable)) {
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS adaptive_archived_worker_traces (
    revision TEXT NOT NULL,
    taskId TEXT NOT NULL REFERENCES adaptive_tasks(id),
    steps TEXT NOT NULL,
    PRIMARY KEY (revision, taskId)
  ) STRICT`);
  const write = db.prepare(`
    INSERT OR REPLACE INTO adaptive_archived_worker_traces VALUES (?, ?, ?)
  `);
  for (const table of [archivedTable, progressTable]) {
    if (!tableExists(db, table)) continue;
    const rows = db.prepare(`
      SELECT trace.revision, trace.taskId, trace.steps, task.nodeId
      FROM ${table} AS trace JOIN adaptive_tasks AS task
        ON task.id = trace.taskId AND task.revision = trace.revision
    `).all();
    if (table === archivedTable) {
      db.exec("DELETE FROM adaptive_archived_worker_traces");
    }
    for (const row of rows) {
      const trace = JSON.parse(String(row.steps));
      if (!Array.isArray(trace) || trace.length > 16) {
        throw new Error("Invalid archived Sentinel worker trace");
      }
      const steps = trace.map((step) => {
        if (
          !step || typeof step.tool !== "string" ||
          !/^sentinel_[a-z0-9_]{1,72}$/.test(step.tool) ||
          !["returned", "error"].includes(step.outcome)
        ) throw new Error("Invalid archived Sentinel worker trace step");
        const target = typeof step.target === "string" &&
            (step.target === row.nodeId ||
              /^(?:execution-evidence|native-workflow-evidence|worker-graph-fact|workflow-observation|worker-finding|worker-recheck|finding-traffic-link|goal-proposal|asset-discovery|har:evidence|dns:evidence):[a-f0-9]{64}$/
                .test(step.target))
          ? step.target
          : undefined;
        return {
          tool: step.tool,
          ...(target && { target }),
          outcome: step.outcome,
          ...retainedTraceReceiptFields(step),
        };
      });
      if (steps.length) {
        write.run(row.revision, row.taskId, JSON.stringify(steps));
      }
    }
  }
}

function scrubAdaptive(db: DatabaseSync) {
  clearRows(db, [
    "adaptive_active",
    "adaptive_worker_checkpoints",
    "adaptive_assigned_target_batch_receipts",
    "adaptive_recheck_context_batch_receipts",
    "adaptive_traffic_links_batch_receipts",
    "adaptive_observation_search_batch_receipts",
    "adaptive_live_workflow_results",
    "adaptive_peer_verifications",
    "adaptive_model_leases",
  ]);
  if (tableExists(db, "adaptive_tasks")) {
    db.exec(`
      UPDATE adaptive_tasks SET leaseToken = NULL, leaseExpiresAt = NULL;
      UPDATE adaptive_tasks SET status = 'superseded' WHERE status = 'running';
    `);
    if (
      db.prepare("PRAGMA table_info(adaptive_tasks)").all().some(({ name }) =>
        name === "dependencyRecommendation"
      )
    ) {
      db.exec("UPDATE adaptive_tasks SET dependencyRecommendation = NULL");
    }
  }
  if (tableExists(db, "adaptive_model_reviews")) {
    db.exec("UPDATE adaptive_model_reviews SET token = NULL, availableAt = 0");
  }
  if (tableExists(db, "adaptive_model_history")) {
    db.exec(
      "UPDATE adaptive_model_history SET outcome = -1, finished = started WHERE outcome = 0",
    );
  }
  discardStepExcerpts(db, "adaptive_note_steps");
  retainArchivedWorkerTraceMetadata(db);
  clearRows(db, ["adaptive_worker_progress"]);
}

function copyDatabase(
  source: string,
  destination: string,
  allowed: ReadonlySet<string>,
  scrub: (db: DatabaseSync) => void,
) {
  const working = destination + ".working";
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    live.exec("PRAGMA busy_timeout = 1500; PRAGMA trusted_schema = OFF");
    vacuumInto(live, working);
  } finally {
    live.close();
  }
  const staged = new DatabaseSync(working);
  try {
    staged.exec("PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON");
    staged.exec("BEGIN IMMEDIATE");
    try {
      removeUnrecognizedSchema(staged, allowed);
      scrub(staged);
      staged.exec("COMMIT");
    } catch (error) {
      staged.exec("ROLLBACK");
      throw error;
    }
    vacuumInto(staged, destination);
  } finally {
    staged.close();
    Deno.removeSync(working);
  }
}

function artifact(
  directory: string,
  name: SentinelCaseArchiveArtifact["name"],
): SentinelCaseArchiveArtifact {
  const path = join(directory, name);
  const data = Deno.readFileSync(path);
  return {
    name,
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/**
 * Stage an exact stopped run under the caller's private staging directory.
 * The returned directory is caller-owned after success. Live case files are read only.
 */
export function captureStoppedSentinelCaseArtifacts(
  baseDir: string,
  scope: SentinelCaseArchiveScope,
  stagingDir: string,
) {
  const { caseId, runId, evidenceRevision } = scope;
  if (
    !isSentinelCaseId(caseId) || caseId === "main" || !uuid.test(runId) ||
    !Number.isSafeInteger(evidenceRevision) || evidenceRevision < 1 ||
    !listSentinelCaseIds(baseDir).includes(caseId)
  ) {
    throw new Error("Select an exact stopped named Sentinel case.");
  }
  const source = resolveSentinelCasePath(baseDir, caseId);
  const caseDir = dirname(source);
  const stagingRoot = resolve(stagingDir);
  const stagedInfo = Deno.lstatSync(stagingRoot);
  const delta = relative(
    Deno.realPathSync(caseDir),
    Deno.realPathSync(stagingRoot),
  );
  if (
    (!isAbsolute(delta) && !/^\.\.(?:[\\/]|$)/.test(delta)) ||
    !stagedInfo.isDirectory ||
    stagedInfo.isSymlink ||
    (stagedInfo.mode !== null && (stagedInfo.mode & 0o077) !== 0)
  ) {
    throw new Error(
      "Sentinel case archive requires a private staging directory outside the live case.",
    );
  }
  const directory = Deno.makeTempDirSync({
    dir: stagingRoot,
    prefix: "sentinel-case-",
  });
  try {
    const artifacts = withSentinelAssessmentWriteLock(source, (state) => {
      const snapshot = state?.result?.sharedGraph.snapshot;
      if (
        !state || state.active || state.paused || !snapshot ||
        state.plan.runId !== runId || state.revision !== evidenceRevision
      ) {
        throw new Error(
          "The named Sentinel case is not stopped at the requested run and revision.",
        );
      }
      const assessment = join(caseDir, "sentinel-assessment.db");
      const savedGraph = loadSentinelGraph(snapshot).snapshot();
      privateFile(assessment);
      copyDatabase(
        assessment,
        join(directory, "sentinel-assessment.db"),
        assessmentTables,
        (db) => scrubAssessment(db, scope, digestSentinelSnapshot(savedGraph)),
      );
      Deno.writeTextFileSync(
        join(directory, "sentinel.json"),
        JSON.stringify(savedGraph),
        { createNew: true, mode: 0o600 },
      );
      const files = [
        artifact(directory, "sentinel.json"),
        artifact(directory, "sentinel-assessment.db"),
      ];
      const adaptive = join(caseDir, "sentinel-adaptive.db");
      if (privateFile(adaptive, true)) {
        copyDatabase(
          adaptive,
          join(directory, "sentinel-adaptive.db"),
          adaptiveTables,
          scrubAdaptive,
        );
        files.push(artifact(directory, "sentinel-adaptive.db"));
      }
      for (const name of sentinelCaseArchiveArtifactNames) {
        const schema = evidenceStoreSchemas[name];
        if (!schema) continue;
        const source = join(caseDir, name);
        if (!privateFile(source, true)) continue;
        copyDatabase(
          source,
          join(directory, name),
          new Set(schema.tables.map(({ name }) => name)),
          (db) => validateEvidenceSchema(db, schema),
        );
        files.push(artifact(directory, name));
      }
      return files;
    });
    return { caseId, runId, evidenceRevision, directory, artifacts };
  } catch (error) {
    Deno.removeSync(directory, { recursive: true });
    throw error;
  }
}
