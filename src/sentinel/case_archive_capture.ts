import { matchesPortableSentinelProvenanceNode } from "./portable_provenance.ts";
import { SENTINEL_LIVE_REPOSITORY_VISIBILITY } from "./github_repository_visibility.ts";
import { readSentinelCaseFindingReceipts } from "./worker_finding_store.ts";
import { retainPortablePausedGraphCheckpoints } from "./adaptive_store.ts";
import { readPortableSentinelTrafficMetadata } from "./traffic_receipts.ts";
import { isDeepStrictEqual } from "node:util";
import {
  assetLinkProof,
  parseSharedAssetLinkPage,
} from "./shared_asset_link_page.ts";
import {
  parseSavedPlannerProvenancePath,
  readSavedSentinelProvenanceNode,
  readSavedSentinelProvenanceSearch,
  readSentinelProvenanceNodeReference,
} from "./worker_goal_recovery.ts";
import { readSentinelProvenanceSearchReference } from "./worker_goal_recovery.ts";
import { readSentinelWorkerTracePageReference } from "./worker_goal_recovery.ts";
import { readSentinelObservationSearchReference } from "./worker_goal_recovery.ts";
import { readSentinelGoalStateProjection } from "./worker_goal_recovery.ts";
import { readSentinelFindingPageReference } from "./worker_goal_recovery.ts";
import {
  isSentinelInventoryFindingRead,
  isSentinelInventoryNeighborhoodRead,
  parseSentinelPinnedFindingRead,
  sentinelGoalReceiptReadArguments,
  sentinelSharedAssetLinksArgs,
} from "./worker_goal_recovery.ts";
import { readSentinelTaskObservationPageReference } from "./worker_goal_recovery.ts";
import { readSentinelDiscoveryPageReference } from "./worker_goal_recovery.ts";
import { sentinelIntermediateWorkflowPageReference } from "./worker_goal_recovery.ts";
import { readSentinelGraphFactPageReference } from "./worker_graph_facts.ts";
import {
  SENTINEL_TRAFFIC_LINKS,
  SENTINEL_TRAFFIC_READ,
  SENTINEL_TRAFFIC_SEARCH,
  sentinelLinkedTrafficPayloadReference,
  sentinelTrafficLinkPageReference,
  sentinelTrafficPageReference,
  sentinelTrafficReadArgs,
} from "./traffic_recovery.ts";
/** Capture a stopped case as privately staged, sanitized archive artifacts. */
/// <reference path="../core/sqlite_types.d.ts" />
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  readSentinelGitHubWorkflowReadReceipt,
  SENTINEL_ASSESSMENT_TIMED_OUT,
  withSentinelAssessmentWriteLock,
} from "./assessment_store.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { loadSentinelGraph } from "./graph.ts";
import {
  readSentinelWorkerFindingPublications,
  sentinelWorkerFindingPublicationFile,
} from "./worker_finding_publications.ts";
import {
  digestSentinelSnapshot,
  MAX_SHARED_ASSET_MAPPING_SOURCES,
} from "./shared_inventory.ts";

export const sentinelCaseArchiveArtifactNames = [
  "sentinel.json",
  "sentinel-assessment.db",
  "sentinel-adaptive.db",
  "sentinel-goal-completion.db",
  "sentinel-worker-findings.db",
  "sentinel-worker-graph-facts.db",
  "sentinel-traffic-receipts.db",
  "sentinel-finding-traffic-links.db",
  sentinelWorkerFindingPublicationFile,
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
  "assessment_completed_graph_followups",
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
  "adaptive_model_evidence_rounds",
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
  "adaptive_operator_assignment_batches",
  "adaptive_graph_retry_requests",
  "adaptive_operator_case_hint_requests",
  "adaptive_operator_case_hint_batches",
  "adaptive_peer_verifications",
  "adaptive_planner_todos",
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
  "adaptive_worker_narratives",
  "adaptive_repository_visibility_results",
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
        name: "staged_traffic_findings",
        columns: ["requestId", "findingId", "input", "traffic"],
        optionalTable: true,
      },
      {
        name: "receipts",
        columns: ["id", "revision", "findingId", "input", "recordedAt"],
        optionalColumns: ["reportVersion"],
      },
      { name: "requests", columns: ["requestId", "receiptId"] },
      {
        name: "inconclusive_rechecks",
        columns: [
          "id",
          "requestId",
          "revision",
          "taskId",
          "findingId",
          "input",
          "recordedAt",
        ],
        optionalTable: true,
      },
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
        name: "staged_publication_links",
        columns: ["link_id"],
        optionalTable: true,
      },
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
      {
        name: "traffic_link_annotations",
        columns: ["id", "request_id", "link_id", "input", "recorded_at"],
        optionalTable: true,
      },
      {
        name: "traffic_link_composition",
        columns: [
          "sequence",
          "id",
          "request_id",
          "revision",
          "finding_id",
          "input",
          "recorded_at",
        ],
        optionalTable: true,
      },
      {
        name: "traffic_link_batches",
        columns: [
          "request_id",
          "run_id",
          "revision",
          "finding_id",
          "binding",
          "link_ids",
        ],
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
    !current || (current.active !== 0 &&
      current.active !== SENTINEL_ASSESSMENT_TIMED_OUT) ||
    current.revision !== scope.evidenceRevision ||
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

function retainedTraceReceiptFields(
  step: Record<string, unknown>,
  revision: number,
  caseId: string,
) {
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
    const receipt = step.goalReceiptRead as {
      args?: unknown;
      sha256?: unknown;
    } | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, receipt?.args);
    const citation = step.sharedAssetDiscovery as {
      id?: unknown;
      version?: unknown;
      sourceCaseId?: unknown;
      taskId?: unknown;
      evidenceRevision?: unknown;
      sourceDigest?: unknown;
      evidenceId?: unknown;
    } | undefined;
    if (
      citation && args?.id && args.id === step.target &&
      args.id === citation.id && digest(receipt?.sha256) &&
      typeof citation.version === "number" &&
      Number.isSafeInteger(citation.version) && citation.version >= 2 &&
      typeof citation.sourceCaseId === "string" &&
      isSentinelCaseId(citation.sourceCaseId) &&
      citation.sourceCaseId !== caseId &&
      typeof citation.taskId === "string" &&
      /^adaptive:[a-f0-9]{64}$/.test(citation.taskId) &&
      typeof citation.evidenceRevision === "number" &&
      Number.isSafeInteger(citation.evidenceRevision) &&
      citation.evidenceRevision > 0 && digest(citation.sourceDigest) &&
      typeof citation.evidenceId === "string" &&
      citation.evidenceId.length > 0 &&
      citation.evidenceId.length <= 4096
    ) {
      const {
        id,
        version,
        sourceCaseId,
        taskId,
        evidenceRevision,
        sourceDigest,
        evidenceId,
      } = citation;
      fields.sharedAssetDiscovery = {
        id,
        version,
        sourceCaseId,
        taskId,
        evidenceRevision,
        sourceDigest,
        evidenceId,
      };
      fields.goalReceiptRead = { args, sha256: receipt?.sha256 };
    }
  }
  if (step.tool === "sentinel_worker_observation") {
    const search = readSentinelObservationSearchReference(
      step.observationSearch,
    );
    if (search) fields.observationSearch = search;
    const page = readSentinelTaskObservationPageReference(
      step.taskObservationPage,
    );
    if (page) fields.taskObservationPage = page;
  }
  if (
    typeof step.tool === "string" &&
    (step.tool === "sentinel_incident_alerts" ||
      step.tool === "sentinel_defense" || step.tool === "sentinel_path" ||
      step.tool === "sentinel_saved_workflow_receipt" ||
      step.tool === "sentinel_prior_assigned_evidence" ||
      step.tool === "sentinel_shared_topology_source" ||
      step.tool === "sentinel_shared_finding_source" ||
      isSentinelInventoryFindingRead(step.tool) ||
      isSentinelInventoryNeighborhoodRead(step.tool))
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
  if (
    step.tool === "sentinel_path" &&
    typeof step.plannerProvenancePath === "string"
  ) {
    const citation = fields.goalReceiptRead as {
      args: Record<string, unknown>;
      sha256: string;
    } | undefined;
    const text = step.plannerProvenancePath;
    if (
      citation &&
      parseSavedPlannerProvenancePath(text, citation.args, revision) &&
      createHash("sha256").update(text).digest("hex") === citation.sha256
    ) fields.plannerProvenancePath = text;
  }
  if (step.tool === "sentinel_shared_finding_source") {
    const receipt = fields.goalReceiptRead as
      | { args: Record<string, unknown> }
      | undefined;
    const read = receipt && parseSentinelPinnedFindingRead(receipt.args);
    if (read && read.finding === step.target && read.sourceCase !== caseId) {
      fields.target = read.finding;
      fields.sourceSnapshots = [{
        caseId: read.sourceCase,
        assetId: read.sourceAsset,
        snapshotDigest: read.snapshotDigest,
      }];
    }
  }
  if (step.tool === "sentinel_shared_asset_links") {
    const receipt = step.goalReceiptRead as
      | { args?: unknown; sha256?: unknown }
      | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, receipt?.args);
    const selector = args && sentinelSharedAssetLinksArgs(args);
    const text = step.sharedAssetLinksPage;
    const page = selector && typeof text === "string" &&
      parseSharedAssetLinkPage(text, revision, selector);
    if (
      page && typeof text === "string" && digest(receipt?.sha256) &&
      createHash("sha256").update(text).digest("hex") === receipt.sha256
    ) {
      fields.goalReceiptRead = { args, sha256: receipt.sha256 };
      fields.sharedAssetLinksPage = text;
      const sources = page.sourceSnapshots?.filter((source) =>
        source && isSentinelCaseId(source.caseId) &&
        typeof source.assetId === "string" && digest(source.snapshotDigest) &&
        Object.keys(source).length === 3
      );
      if (sources?.length && isDeepStrictEqual(sources, page.sourceSnapshots)) {
        fields.sourceSnapshots = sources;
      }
      const { mappingProof, ...projection } = page;
      const mapping = step.aliasMapping as {
        proof?: unknown;
        sources?: unknown;
      } | undefined;
      if (
        mappingProof && mapping?.proof === mappingProof &&
        Array.isArray(mapping.sources) && mapping.sources.length > 0 &&
        mapping.sources.length <= MAX_SHARED_ASSET_MAPPING_SOURCES &&
        mapping.sources.every((source) =>
          source && isSentinelCaseId(source.caseId) &&
          source.caseId !== caseId &&
          digest(source.snapshotDigest) && Object.keys(source).length === 2
        ) &&
        assetLinkProof(caseId, projection, mapping.sources) === mappingProof
      ) fields.aliasMapping = { proof: mappingProof, sources: mapping.sources };
    }
  }
  if (step.tool === "sentinel_goal_state") {
    const projection = readSentinelGoalStateProjection(
      step.goalStateProjection,
    );
    const saved = step.goalReceiptRead as
      | { args?: unknown; sha256?: unknown }
      | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, saved?.args);
    if (projection && args && digest(saved?.sha256)) {
      fields.goalStateProjection = projection;
      fields.goalReceiptRead = { args, sha256: saved?.sha256 };
    }
  }
  if (step.tool === "sentinel_case_hints") {
    const first = step.caseHintFirstId;
    const saved = step.goalReceiptRead as
      | { args?: unknown; sha256?: unknown }
      | undefined;
    const args = sentinelGoalReceiptReadArguments(step.tool, saved?.args);
    if (
      args && digest(saved?.sha256) &&
      (first === null ||
        typeof first === "number" && Number.isSafeInteger(first) && first >= 1)
    ) {
      fields.caseHintFirstId = first;
      fields.goalReceiptRead = { args, sha256: saved?.sha256 };
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
  if (step.tool === "sentinel_worker_trace_search") {
    const page = readSentinelWorkerTracePageReference(step.workerTracePage);
    if (page) fields.workerTracePage = page;
  }
  if (step.tool === "sentinel_provenance_search") {
    const page = readSentinelProvenanceSearchReference(
      step.provenanceSearchPage,
    );
    if (page) {
      fields.provenanceSearchPage = page;
      const result = readSavedSentinelProvenanceSearch(
        step.provenanceSearchResult,
        page,
        revision,
      );
      if (result) fields.provenanceSearchResult = result;
    }
  }
  if (step.tool === "sentinel_provenance_node") {
    const page = readSentinelProvenanceNodeReference(step.provenanceNodePage);
    if (page && page.args.node === step.target) {
      fields.target = page.args.node;
      fields.provenanceNodePage = page;
      const text = readSavedSentinelProvenanceNode(
        step.workerProvenanceNodeResult,
        page,
        revision,
      );
      if (text) fields.workerProvenanceNodeResult = text;
    }
  }
  if (digest(step.resultSha256)) fields.resultSha256 = step.resultSha256;
  if (
    step.tool === SENTINEL_LIVE_REPOSITORY_VISIBILITY && !fields.resultSha256
  ) {
    const receipt = step.goalReceiptRead as {
      args?: Record<string, unknown>;
      sha256?: unknown;
    } | undefined;
    if (
      receipt?.args && Object.keys(receipt.args).length === 0 &&
      digest(receipt.sha256)
    ) fields.resultSha256 = receipt.sha256;
  }
  if (step.tool === "sentinel_assigned_target" && !fields.resultSha256) {
    const snapshot = step.resultSnapshot as { sha256?: unknown } | undefined;
    if (digest(snapshot?.sha256)) fields.resultSha256 = snapshot?.sha256;
  }

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
    const page = sentinelTrafficLinkPageReference(step.trafficLinks);
    if (page) fields.trafficLinks = page;
    const payload = sentinelLinkedTrafficPayloadReference(
      step.linkedTrafficPayload,
    );
    if (payload) fields.linkedTrafficPayload = payload;
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

export function retainArchivedWorkerTraceMetadata(
  db: DatabaseSync,
  caseId: string,
) {
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
  const evidenceNumber = tableExists(db, "adaptive_evidence_revisions")
    ? db.prepare(`
      SELECT evidenceNumber FROM adaptive_evidence_revisions
      WHERE revision = ? ORDER BY evidenceNumber DESC, rowid DESC LIMIT 1
    `)
    : undefined;
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
      const revision = Number(
        evidenceNumber?.get(row.revision)?.evidenceNumber,
      );
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
              /^(?:shared-topology|execution-evidence|native-workflow-evidence|worker-graph-fact|workflow-observation|worker-finding|worker-recheck|finding-traffic-link|goal-proposal|asset-discovery|har:evidence|dns:evidence):[a-f0-9]{64}$/
                .test(step.target))
          ? step.target
          : undefined;
        return {
          tool: step.tool,
          ...(target && { target }),
          outcome: step.outcome,
          ...retainedTraceReceiptFields(step, revision, caseId),
        };
      });
      if (steps.length) {
        write.run(row.revision, row.taskId, JSON.stringify(steps));
      }
    }
  }
}

function scrubAdaptive(
  db: DatabaseSync,
  caseId: string,
  runId: string,
  evidenceRevision: number,
  snapshotPath: string,
) {
  clearRows(db, [
    "adaptive_active",
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
  retainArchivedWorkerTraceMetadata(db, caseId);
  retainPortablePausedGraphCheckpoints(
    db,
    evidenceRevision,
    false,
    {
      traffic: (args, targetId) =>
        readPortableSentinelTrafficMetadata(
          snapshotPath,
          caseId,
          runId,
          evidenceRevision,
          targetId,
          args,
        ),
      provenanceNode: (page, text) =>
        matchesPortableSentinelProvenanceNode(
          snapshotPath,
          runId,
          evidenceRevision,
          page,
          text,
        ),
    },
  );
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
      const publications = readSentinelWorkerFindingPublications(
        source,
        caseId,
      ).filter(
        ({ finding }) =>
          finding.workerFindingSource?.runId === runId &&
          finding.workerFindingSource.revision <= evidenceRevision,
      );
      if (publications.length) {
        Deno.writeTextFileSync(
          join(directory, sentinelWorkerFindingPublicationFile),
          JSON.stringify(publications),
          { createNew: true, mode: 0o600 },
        );
        files.push(artifact(directory, sentinelWorkerFindingPublicationFile));
      }
      for (const name of sentinelCaseArchiveArtifactNames) {
        if (name === sentinelWorkerFindingPublicationFile) continue;
        const schema = evidenceStoreSchemas[name];
        if (!schema) continue;
        const source = join(caseDir, name);
        if (!privateFile(source, true)) continue;
        copyDatabase(
          source,
          join(directory, name),
          new Set(schema.tables.map(({ name }) => name)),
          (db) => {
            validateEvidenceSchema(db, schema);
            if (
              name === "sentinel-worker-findings.db" &&
              tableExists(db, "staged_traffic_findings")
            ) {
              db.exec(`DELETE FROM staged_traffic_findings
                WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE id = staged_traffic_findings.findingId
                  AND input = staged_traffic_findings.input)`);
            }
            if (
              name === "sentinel-finding-traffic-links.db" &&
              tableExists(db, "staged_publication_links")
            ) {
              const staged = db.prepare(`SELECT p.link_id, links.finding_id
                FROM staged_publication_links p JOIN traffic_links links ON links.id = p.link_id
                LIMIT 4097`).all();
              if (staged.length > 4096) {
                throw new Error("Too many staged Sentinel traffic links.");
              }
              const findings = readSentinelCaseFindingReceipts(
                resolveSentinelCasePath(baseDir, caseId),
                staged.map(({ finding_id }) => String(finding_id)),
              );
              for (const { link_id, finding_id } of staged) {
                if (findings.has(String(finding_id))) continue;
                const id = String(link_id);
                if (tableExists(db, "traffic_link_batches")) {
                  db.prepare(`DELETE FROM traffic_link_batches WHERE EXISTS (
                    SELECT 1 FROM json_each(link_ids) WHERE value = ?
                  )`).run(id);
                }
                db.prepare(
                  "DELETE FROM staged_publication_links WHERE link_id = ?",
                ).run(id);
                db.prepare("DELETE FROM traffic_links WHERE id = ?").run(id);
              }
            }
          },
        );
        files.push(artifact(directory, name));
      }
      // Seal a checkpoint only against the evidence actually staged with it.
      const adaptive = join(caseDir, "sentinel-adaptive.db");
      if (privateFile(adaptive, true)) {
        copyDatabase(
          adaptive,
          join(directory, "sentinel-adaptive.db"),
          adaptiveTables,
          (db) =>
            scrubAdaptive(
              db,
              scope.caseId,
              scope.runId,
              scope.evidenceRevision,
              join(directory, "sentinel.json"),
            ),
        );
        files.push(artifact(directory, "sentinel-adaptive.db"));
      }
      return files;
    });
    return { caseId, runId, evidenceRevision, directory, artifacts };
  } catch (error) {
    Deno.removeSync(directory, { recursive: true });
    throw error;
  }
}
