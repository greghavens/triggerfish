import {
  listSentinelInteractiveTurns,
  readSentinelInteractiveTurn,
  stopSentinelInteractiveTurn,
} from "./sentinel_interactive_turns.ts";
import { readSentinelWorkerEvidenceScope } from "./sentinel_worker_evidence_scope.ts";
import { teamAdmissionArchive } from "./startup/factory/team_admission_archive.ts";
import {
  INCONCLUSIVE_RECHECK_ID,
  INCONCLUSIVE_RECHECK_TOOL,
} from "../sentinel/recheck_inconclusive.ts";
import { normalizeSentinelRecheckNote } from "../sentinel/worker_finding_recovery.ts";
import { createSentinelFindingRemediationReader } from "../sentinel/finding_remediation.ts";
import { readLinkedFindingProof } from "./sentinel_linked_findings.ts";
import {
  listSentinelSelectedFindingCandidates,
  reopenSentinelPeerCoverage,
  reopenSentinelSelectedFinding,
} from "./sentinel_peer_coverage.ts";
import { discoverSentinelFindingNodeTraffic } from "./sentinel_finding_traffic_tool.ts";
import {
  isSentinelHintTrafficSelection,
  type SentinelHintTrafficReference,
  sentinelHintTrafficReferences,
} from "../sentinel/traffic_receipts.ts";
import {
  type CategorizedOperatorRun,
  type OperatorRunCategoryChange,
  parseOperatorRunCategorySelection,
} from "../core/operator_run_categories.ts";
import { executeCompletedSentinelGraphFollowup } from "../sentinel/completed_graph_followup.ts";
import {
  type AdaptiveGraphAssignment,
  type AdaptiveOperatorHintSelection,
  normalizeSentinelHintAssets,
} from "../sentinel/adaptive_store.ts";
import { applyOperatorRunBatch } from "./operator_run_batch_control.ts";
import {
  isSentinelModelRole,
  sentinelModelRoles,
  type SentinelModelRoute,
  sentinelModelRouteEditLimit,
} from "../sentinel/model_routes.ts";
import { emptyLinkedSentinelGraphDigest } from "../sentinel/linked_empty_case.ts";
import { withSentinelSourceSnapshotLock } from "../sentinel/source_snapshot_lock.ts";
import { parseSentinelLinkedSeedTask } from "../sentinel/linked_seed_task.ts";
import {
  parseSentinelLinkedCaseSources,
  type SentinelLinkedCaseSource,
} from "../sentinel/linked_case_sources.ts";
import {
  notifyCommittedEvidence,
  validPlannerHeartbeatSeconds,
} from "../core/evidence_task_progression.ts";
import {
  readSentinelArchivedToolDecisions,
  sentinelArchivedToolDecisionsFile,
} from "../sentinel/archive_tool_decisions.ts";
import {
  correctSentinelAssetDiscovery,
  listSentinelAssetDiscoveryProposals,
  proposeSentinelGraphFactDiscovery,
} from "./sentinel_asset_discoveries.ts";
import {
  delegatedSubagentIdentity,
  teamDeliveryExecutionId,
} from "./startup/factory/delegated_agent_recovery.ts";
import {
  executionTraceSourceVisible,
  isOwnerBoundExecutionTraceSource,
  parseTeamDeliveryTraceSource,
} from "../core/team_delivery_trace_source.ts";
import {
  readSentinelAdmissionSettings,
  replaceSentinelAdmissionLimit,
  validSentinelAdmissionLimit,
} from "./sentinel_admission_settings.ts";
import type { SessionId } from "../core/types/session.ts";
import { assignmentRecoveryKey } from "../core/durable_assignment.ts";
import {
  AgentRecoveryStore,
  lockAgentRecovery,
} from "../core/agent_recovery_store.ts";
import {
  type AdaptiveWorkflowObservation,
  MAX_SENTINEL_DEPENDENCY_CONFIRMATION_CHARS,
  taskUpstreamCitations,
  taskWorkerSources,
} from "../sentinel/adaptive_store.ts";
import {
  compareSentinelIncidentPriority,
  resolveSentinelIncidentAlerts,
} from "../sentinel/incident_correlation.ts";
import {
  readSavedSentinelIncidentAssetScopes,
  readSavedSentinelIncidentCandidate,
  readSavedSentinelIncidentCandidates,
} from "../sentinel/incident_archive.ts";
import { sentinelTelemetryAssetResolver } from "../sentinel/defense_coverage.ts";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { sentinelIncidentCandidates } from "../sentinel/adaptive_planner.ts";
import { readSentinelPlannerInventoryResult } from "../sentinel/inventory_queries.ts";
import { readSentinelPlannerDigestResult } from "../sentinel/evidence_digests.ts";
import {
  amendOperatorSentinelFindingReport,
  readSentinelFindingReportAttachmentReview,
  reopenSentinelPlannerFindings,
} from "./sentinel_worker_findings.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";
import { readSentinelPlannerGraphFacts } from "./sentinel_graph_fact_tool.ts";
import { parseSharedAssetLinkPage } from "../sentinel/shared_asset_link_page.ts";
import { executeOperatorFindingPublication } from "./operator_finding_publication.ts";
import { querySentinelWorkerObservations } from "../sentinel/adaptive_store.ts";
import {
  isSentinelArchivedInventoryRead,
  isSentinelInventoryFindingRead,
  isSentinelInventoryNeighborhoodRead,
  isSentinelPinnedSourceRead,
  normalizeSentinelGraphFactQuery,
  parseSentinelPinnedFindingRead,
  readSavedSentinelProvenanceNode,
  readSavedSentinelProvenanceSearch,
  readSentinelDiscoveryPageReference,
  readSentinelFindingPageReference,
  readSentinelGoalStateProjection,
  readSentinelGraphOverviewProjection,
  readSentinelObservationSearchReference,
  readSentinelProvenanceNodeReference,
  readSentinelProvenanceSearchReference,
  readSentinelTaskObservationPageReference,
  readSentinelWorkerTracePageReference,
  sentinelGoalReceiptReadArguments,
  sentinelIntermediateWorkflowPageReference,
  sentinelSharedAssetLinksArgs,
} from "../sentinel/worker_goal_recovery.ts";
import { reopenSentinelGoalReceiptRead } from "./sentinel_goal_receipt_read.ts";
import { readHistoricalDiscoveryEvidence } from "../sentinel/archive_asset_discoveries.ts";
import { verifiedSharedAssetDiscovery } from "../sentinel/provenance.ts";
import { isDeepStrictEqual } from "node:util";
import {
  projectNativeWorkflowEvidence,
  readNativeWorkflowGraphEvidence,
} from "../sentinel/native_workflow_evidence.ts";
import { openSentinelAssetDiscoveryStore } from "../sentinel/asset_discovery_store.ts";
import {
  matchSentinelAssetDiscoveryDestination,
  verifySentinelAssetDiscovery,
} from "../sentinel/asset_discovery_evidence.ts";
import {
  compareSentinelFindingRank,
  readSentinelFindingAssetTree,
  readSentinelFindingGroup,
} from "../sentinel/finding_groups.ts";
import { parseFindingExportFilter } from "../sentinel/assessment_export.ts";
import { readSentinelFindingLineage } from "../sentinel/finding_lineage.ts";
import { loadSentinelGraph } from "../sentinel/graph.ts";
import {
  isSentinelFindingMutation,
  lookupSentinelFindingMutation,
  lookupSentinelPendingTrafficFinding,
} from "../sentinel/worker_finding_recovery.ts";
import { executionFindingAsset } from "../sentinel/worker_finding_evidence.ts";
import {
  SENTINEL_TRAFFIC_ATTACH,
  SENTINEL_TRAFFIC_LINKS,
  SENTINEL_TRAFFIC_READ,
  SENTINEL_TRAFFIC_SEARCH,
  sentinelLinkedTrafficPayloadReference,
  sentinelTrafficLinkPageReference,
  sentinelTrafficLinksArgs,
  sentinelTrafficPageReference,
  sentinelTrafficReadArgs,
  sentinelTrafficSearchArgs,
} from "../sentinel/traffic_recovery.ts";
import type { createSentinelLiveWorkflowReader } from "./sentinel_live_workflow.ts";
import type { SentinelLiveWorkflowDestination } from "./sentinel_agent.ts";
import {
  exactExecutionRecheckCandidate,
  executionControlReceipt,
  executionReceiptSupportsCheck,
  receiptRecheckCandidate,
} from "./sentinel_execution_rechecks.ts";
import { createHash } from "node:crypto";
import type { EffectiveModelProfile } from "../agent/llm.ts";
import {
  isModelProfileName,
  parseModelFallbackProfiles,
  type SelectedModelProfile,
} from "../core/model_profile_selection.ts";
import type { RecoveryToolCall } from "../core/types/orchestrator.ts";
import type { liveProviderRouteSettings } from "../agent/providers/live_routes.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
  parseClassification,
} from "../core/types/classification.ts";
/** Owner-only root tool for exact Sentinel and admitted workflow runs. */
import { dirname, join } from "@std/path";
import {
  type ExecutionTraceApprovedPayload,
  executionTracePayloadCall,
  executionTracePayloadResponse,
  type ExecutionTraceRole,
  type ExecutionTraceRun,
  openExecutionTraces,
} from "../core/execution_traces.ts";
import {
  openOperatorRunLinkStore,
  type OperatorRunBatchTarget,
  OperatorRunController,
  type OperatorRunKind,
  type OperatorRunProvider,
  type OperatorRunRef,
  type OperatorRunSummary,
} from "../core/operator_runs.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  applySentinelFormalGoals,
  changeSentinelRunDisplay,
  MAX_SENTINEL_RUN_TIMEOUT_SECONDS,
  parseSentinelGoalSupersession,
  readSentinelAssessment,
  readSentinelAssessmentAlerts,
  readSentinelAssessmentRevision,
  readSentinelDecisionHistory,
  readSentinelFormalGoalApproval,
  readSentinelGitHubWorkflowReadReceipt,
  readSentinelGoalSupersessionSource,
  readSentinelIncidentReviews,
  readSentinelLinkedSourcesForRevision,
  readSentinelModelRoute,
  readSentinelOperatingConstraintHistory,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintVersion,
  readSentinelOperatorReviewRequest,
  readSentinelRunIdForRevision,
  readSentinelWorkerGoalProposals,
  readSentinelWorkerGoalProposalTraceReceipt,
  recordSentinelFindingReview,
  recordSentinelIncidentReview,
  recordSentinelOperatingConstraints,
  replaceSentinelModelRoute,
  reviewSentinelCompletedGraphFollowup,
  sentinelFindingDispositions,
  type SentinelFormalGoalApproval,
  sentinelIncidentDispositions,
  type SentinelReviewStep,
  validSentinelChildDescription,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../sentinel/case_membership.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  digestSentinelSnapshot,
  readArchivedSentinelFindingSource,
  readArchivedSentinelSnapshot,
  readCitedSentinelAliasSnapshot,
  readSharedSentinelTopologySource,
} from "../sentinel/shared_inventory.ts";
import {
  findingReportMetadata,
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingTraceReceipt,
} from "../sentinel/worker_finding_store.ts";
import {
  normalizeSentinelOperatingConstraints,
  validateSentinelOperatingConstraintAssets,
} from "../sentinel/operating_constraints.ts";
import {
  allowsRetainedSentinelProvenancePage,
  allowsRetainedSentinelSharedTopology,
  allowsSavedSentinelProvenancePath,
  inspectSentinelProvenance,
  inspectSentinelWorkerObservation,
  projectCaseHints,
  projectSentinelAssignedTarget,
  projectSentinelSharedFindingSource,
  projectSentinelSharedTopologySource,
  queryIncidentAlerts,
  readDefenseCoverage,
  readHistoricalSentinelGoalState,
  readScopedSentinelTopologySource,
  readSentinelCarriedEvidence,
  readSentinelGraphOverview,
  readSentinelGraphProjection,
  readSentinelPrerequisiteWorkflowReceipt,
  readSentinelSharedFindingLocalScope,
  reopenSentinelProvenanceNode,
  reopenSentinelProvenanceSearch,
  reopenSentinelWorkerTraceSearch,
  searchSentinelProvenance,
  searchSentinelWorkerTraces,
  type SentinelReadTrace,
} from "./sentinel_agent.ts";
import {
  isSentinelGraphFactCursor,
  parseSentinelGraphFactRequirement,
  readSentinelCaseGraphFactCursorPage,
  readSentinelCaseGraphFacts,
  readSentinelGraphFactPageReference,
  readSentinelWorkerGraphFact,
  type SentinelWorkerGraphFact,
} from "../sentinel/worker_graph_facts.ts";
import {
  advanceAdaptiveSentinel,
  canQueueSentinelPassingRecheck,
  controlSentinelTask,
  hasSentinelAssignmentIntent,
  previewSentinelQueueControl,
  readHistoricalAdaptiveSentinel,
  readSentinelAdaptiveEvidenceMapping,
  readSentinelFindingFollowup,
  readSentinelFindingRecheckAttempts,
  readSentinelIntermediateWorkflowObservations,
  readSentinelInvestigationFrontier,
  readSentinelModelSettings,
  readSentinelOperatorAssetHint,
  readSentinelProvenance,
  readSentinelRecheckBaseline,
  readSentinelTaskQueue,
  readSentinelWorkflowPublicationStep,
  reviewSentinelAssignmentBatch,
  reviewSentinelGraphRetries,
  reviewSentinelOperatorHintBatch,
  reviewSentinelQueuedCancellation,
  reviewSentinelStoppedGraphRetry,
  reviewSentinelWorkerHold,
  reviewSentinelWorkerStopRationale,
  sentinelHintAssetsInScope,
  submitSentinelAssignmentIntent,
  updateSentinelWorkerLimit,
} from "./sentinel_adaptive_runtime.ts";
import {
  allowsRetainedSentinelDigests,
  executeOperatorEvidenceDigest,
} from "./operator_evidence_digests.ts";
import {
  nativeWorkflowControlCandidate,
  readCaseExecutionEvidence,
} from "../sentinel/case_execution_evidence.ts";
import {
  attachOperatorExecutionEvidence,
  attachOperatorNativeWorkflowControl,
  projectExecutionRecheckSource,
} from "./operator_execution_evidence.ts";
import { executeOperatorInventoryAffiliation } from "./operator_inventory_affiliation.ts";
import { executeOperatorInventoryWithdrawal } from "./operator_inventory_withdrawal.ts";
import { executeOperatorAssetWithdrawal } from "./operator_asset_withdrawal.ts";
import { executeOperatorRunArchive } from "./operator_run_archive.ts";
import { executeOperatorRunArchiveBatch } from "./operator_run_archive_batch.ts";
import { executeOperatorArchiveCatalog } from "./operator_run_archive_catalog.ts";
import {
  executeAssessmentTemplates,
  parseAssessmentTemplateSelector,
  readAssessmentTemplate,
  withCurrentAssessmentTemplate,
} from "./sentinel_assessment_templates.ts";
import { readOperatorSentinelInventory } from "./operator_sentinel_inventory.ts";
import { createOperatorSentinelRuns } from "./operator_sentinel_runs.ts";
import {
  allowsSentinelGraphFindingTrafficPage,
  annotateOperatorSentinelFindingTraffic,
  attachOperatorSentinelFindingTraffic,
  attachOperatorSentinelFindingTrafficBatch,
  editOperatorSentinelFindingTrafficSet,
  executeSentinelFindingTrafficTool,
  reopenSentinelLinkedTrafficPayload,
  sentinelFindingTrafficAttachTool,
  sentinelFindingTrafficListTool,
} from "./sentinel_finding_traffic_tool.ts";
import {
  listSentinelFindingTrafficLinks,
  readSentinelTrafficCompositionHistory,
  readSentinelTrafficCompositionReceipt,
  readSentinelTrafficLinkAnnotations,
} from "../sentinel/finding_traffic_links.ts";
import { trafficCompositionOrderDigest } from "../sentinel/finding_traffic_composition.ts";
import { readSentinelTrafficReceipt } from "../sentinel/traffic_receipts.ts";
import {
  executeSentinelTrafficTool,
  projectSentinelTrafficBlob,
  projectSentinelTrafficReceipt,
  readProjectedSentinelTrafficPage,
  readProjectedSentinelTrafficReceipt,
  reopenProjectedSentinelTrafficPage,
  sentinelTrafficBlobTool,
  sentinelTrafficGetTool,
  sentinelTrafficSearchTool,
} from "./sentinel_traffic_tool.ts";
import type {
  OperatorWorkflowRun,
  OperatorWorkflowRuns,
} from "./operator_workflow_runs.ts";

import {
  digestSentinelGoalProposal,
  normalizeSentinelFormalGoals,
} from "../sentinel/formal_goals.ts";
import {
  completeSentinelRegisteredGoal,
  digestSentinelGoalProof,
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionAtRevision,
  readSentinelWorkerGoalProofTraceReceipt,
} from "./sentinel_goal_completion.ts";

function validSentinelCancellationReason(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    value.trim() === value && value.length <= 240 &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && redactCredentialText(value) === value;
}

const sentinelQueueActions = new Map(
  [
    ["retry_task", "retry"],
    ["retry_model_review", "retry_model_review"],
    ["prioritize_task", "prioritize"],
    ["withdraw_task_priority", "withdraw_priority"],
    ["cancel_task", "cancel"],
  ] as const,
);

function parseOperatorHintTraffic(args: Record<string, unknown>) {
  const { trafficReference, trafficReferences } = args;
  const raw = trafficReference ?? trafficReferences;
  if (trafficReference === undefined && trafficReferences === undefined) return;
  if (
    (trafficReference !== undefined && trafficReferences !== undefined) ||
    Array.isArray(raw) !== (trafficReferences !== undefined) ||
    !isSentinelHintTrafficSelection(raw)
  ) return null;
  const canonical = ({ evidenceId, digest }: SentinelHintTrafficReference) => ({
    evidenceId,
    digest,
  });
  return "evidenceId" in raw ? canonical(raw) : raw.map(canonical);
}

export const operatorRunTool: ToolDefinition = {
  name: "operator_runs",
  description:
    "List and inspect approved runs. With operator confirmation, control an exact run or narrow which defensive tasks and assets Sentinel may schedule. Constraints do not grant capabilities.",
  parameters: {
    action: {
      type: "string",
      description:
        "Run operation. finding_recheck_sources previews attachable checks for one worker finding using the exact case revision, source traceRole and traceRunId, and validUntil.",
      enum: [
        "list",
        "inspect",
        "set_display",
        "start",
        "spawn",
        "link",
        "pause",
        "cancel",
        "resume",
        "assign",
        "tasks",
        "worker_limit",
        "set_worker_limit",
        "assessment_concurrency",
        "live_model_route",
        "set_live_model_route",
        "reset_live_model_route",
        "set_assessment_concurrency",
        "reset_assessment_concurrency",
        "reset_worker_limit",
        ...sentinelQueueActions.keys(),
        "apply_task_dependencies",
        "dismiss_task_dependencies",
        "archive",
        "restore",
        "archive_history",
        "interactive_turns",
        "stop_interactive_turn",
        "archive_catalog",
        "assessment_templates",
        "set_assessment_template",
        "withdraw_assessment_template",
        "archive_runs",
        "restore_runs",
        "approval_history",
        "execution_traces",
        "execution_trace_payload",
        "attach_branch_evidence",
        "attach_repository_visibility_evidence",
        "attach_workflow_control_evidence",
        "attach_workflow_attempt_evidence",
        "attach_execution_evidence",
        "case_execution_evidence",
        "finding_recheck_candidates",
        "finding_recheck_attempts",
        "active_finding_rechecks",
        "finding_recheck_sources",
        "defense_coverage",
        "incident_alerts",
        "case_alert",
        "incidents",
        "review_incident",
        "review_finding",
        "decision_history",
        "steer",
        "pause_assignment",
        "resume_assignment",
        "stop",
        "hint",
        "profiles",
        "model_route",
        "set_model_route",
        "set_model_role",
        "graph",
        "graph_overview",
        "findings",
        "finding_receipt",
        "finding_receipts",
        "finding_report",
        "preview_finding_publication",
        "publish_finding",
        "withdraw_published_finding",
        "finding_report_history",
        "finding_lineage",
        "linked_finding",
        "linked_findings",
        "amend_finding_report",
        "traffic_search",
        "traffic_get",
        "traffic_blob",
        "finding_traffic",
        "finding_traffic_candidates",
        "topology_source",
        "attach_finding_traffic",
        "attach_finding_traffic_batch",
        "annotate_finding_traffic",
        "reorder_finding_traffic",
        "finding_traffic_set_receipt",
        "withdraw_finding_traffic",
        "facts",
        "save_digest",
        "list_digests",
        "expand_digest",
        "node",
        "inventory",
        "preview_membership",
        "preview_discovery_withdrawal",
        "withdraw_discoveries",
        "correct_discovery",
        "discovery_proposals",
        "propose_graph_fact_discovery",
        "preview_inventory_withdrawal",
        "preview_inventory_affiliation",
        "affiliate_inventory_asset",
        "withdraw_inventory_host",
        "pause_runs",
        "resume_runs",
        "assign_batch",
        "hint_batch",
        "retry_graph_tasks",
        "enroll_goal_workflow",
        "completed_graph_followup",
        "run_categories",
        "create_run_category",
        "rename_run_category",
        "delete_run_category",
        "categorize_runs",
        "clear_run_categories",
        "set_case_membership",
        "add_case_membership",
        "traces",
        "finding_groups",
        "finding_asset_tree",
        "search_case_traces",
        "list_trace_workers",
        "worker_trace_progress",
        "worker_trace_result",
        "attach_native_workflow_control",
        "planner_reads",
        "worker_observations",
        "intermediate_observations",
        "worker_trace_source",
        "assessment_review",
        "constraints",
        "goals",
        "append_goals",
        "withdraw_goal",
        "revise_goals",
        "goal_proposals",
        "approve_goal_proposal",
        "confirm_goal_completion",
        "narrow_constraints",
      ],
      required: true,
    },
    kind: {
      type: "string",
      description: "Run type",
      enum: [
        "sentinel",
        "workflow",
        "delegated",
        "scheduled",
        "owner_chat",
        "team_delivery",
      ],
    },
    id: {
      type: "string",
      description:
        "Exact run, published case, or configured plan ID. Team delivery archives use team UUID:recipient session UUID:delivery UUID.",
    },
    revision: {
      type: "integer",
      description: "Exact Sentinel evidence revision",
    },
    includeLifecycle: {
      type: "boolean",
      description:
        "Include exact retained assignment timing and reviewed guidance in finding_recheck_attempts.",
    },
    activeOnly: {
      type: "boolean",
      description:
        "List queued, running, or retry-pending attempts. Omit receiptId to discover active attempts in the exact current Sentinel case.",
    },
    receiptId: {
      type: "string",
      description:
        "Exact saved Sentinel worker finding or recheck ID. For assign or completed_graph_followup, pair a worker finding with note and taskKind trace for reviewed retained evidence analysis.",
    },
    observationId: {
      type: "string",
      description: "Exact committed intermediate observation ID",
    },
    behavior: { type: "string", description: "Exact defensive behavior ID" },
    upstreamCheck: {
      type: "string",
      description: "Exact defensive upstream check ID",
    },
    disposition: {
      type: "string",
      enum: [
        ...new Set([
          ...sentinelIncidentDispositions,
          ...sentinelFindingDispositions,
        ]),
      ],
      description: "Operator finding or incident review disposition",
    },
    findingId: {
      type: "string",
      description: "Exact saved Sentinel graph finding ID",
    },
    alertId: {
      type: "string",
      description:
        "Exact alert reference returned by Sentinel defense coverage",
    },
    incidentId: {
      type: "string",
      description: "Exact saved Sentinel incident candidate ID",
    },
    trafficRefs: {
      type: "array",
      description:
        "Two to four exact retained traffic references for one atomic finding attachment.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "digest"],
        properties: {
          evidenceId: { type: "string" },
          digest: { type: "string" },
          evidenceRole: { type: "string" },
          evidenceNote: { type: "string" },
        },
      },
    },
    trafficLinkIds: {
      type: "array",
      description:
        "Complete ordered list of active links for reorder_finding_traffic.",
      items: { type: "string" },
    },
    moveTrafficLinkId: {
      type: "string",
      description:
        "Move this exact active link instead of providing a full order.",
    },
    beforeTrafficLinkId: {
      type: "string",
      description: "Insert the moved link before this link. Omit to append.",
    },
    trafficSetReceiptId: {
      type: "string",
      description: "Exact saved traffic set amendment receipt to page.",
    },
    includeWithdrawn: {
      type: "boolean",
      description:
        "Open immutable attachment metadata by exact ID even if withdrawn.",
    },
    trafficLinkId: {
      type: "string",
      description: "Exact link ID from a finding_traffic page",
    },
    payloadPart: sentinelTrafficBlobTool.parameters.payloadPart,
    byteLength: sentinelTrafficBlobTool.parameters.byteLength,
    family: sentinelTrafficSearchTool.parameters.family,
    origin: sentinelTrafficSearchTool.parameters.origin,
    hostname: sentinelTrafficSearchTool.parameters.hostname,
    method: sentinelTrafficSearchTool.parameters.method,
    status: sentinelTrafficSearchTool.parameters.status,
    bodyContains: sentinelTrafficSearchTool.parameters.bodyContains,
    evidenceRole: sentinelFindingTrafficAttachTool.parameters.evidenceRole,
    evidenceNote: sentinelFindingTrafficAttachTool.parameters.evidenceNote,
    from: sentinelTrafficSearchTool.parameters.from,
    until: sentinelTrafficSearchTool.parameters.until,
    recheckId: {
      type: "string",
      description: "Exact saved finding recheck ID",
    },
    evidenceId: {
      type: "string",
      description:
        "Exact retained traffic, topology, or cited discovery evidence ID",
    },
    sourceCase: {
      type: "string",
      description: "Reporting case cited by the selected evidence",
    },
    snapshotDigest: {
      type: "string",
      description: "Exact source snapshot digest cited by a saved trace step",
    },
    digest: {
      type: "string",
      description: "SHA-256 of the retained traffic receipt",
    },
    includeReportEvidence: {
      type: "boolean",
      description:
        "Compare the saved report's reviewed attachment digest to the exact selected evidence revision.",
    },
    evidenceVersion: {
      type: "string",
      description: "Exact finding attachment-set digest from finding_traffic",
    },
    title: {
      type: "string",
      description:
        "New finding report title or Sentinel run list display title",
    },
    pinned: {
      type: "boolean",
      description:
        "Whether to pin this exact Sentinel run in the owner run list",
    },
    severity: {
      type: "string",
      description:
        "Reviewed severity correction on the exact current finding report.",
      enum: ["critical", "high", "medium", "low", "info"],
    },
    findingCategory: {
      type: "string",
      description:
        "Reviewed finding category label (up to 64 characters). Use an empty string to clear.",
    },
    summary: { type: "string", description: "New finding report summary" },
    reportVersion: {
      type: "integer",
      description:
        "Exact finding report version. Defaults to the latest version at the selected revision.",
    },
    host: {
      type: "string",
      description:
        "Exact DNS hostname or canonical IP for discovery withdrawal",
    },
    previewDigest: {
      type: "string",
      description: "Exact digest returned by the requested withdrawal preview",
    },
    archiveId: {
      type: "string",
      description: "Exact UUID of an existing workspace run archive",
    },
    archiveStatus: {
      type: "string",
      enum: ["pending", "succeeded", "failed"],
      description: "Optional archive catalog status filter.",
    },
    restoreStatus: {
      type: "string",
      enum: ["pending", "succeeded", "failed"],
      description:
        "Filter the archive catalog by its latest exact restore outcome.",
    },
    before: {
      type: "integer",
      description: "Continuation for archive action history",
    },
    runId: {
      type: "string",
      description: "Exact Sentinel assessment run UUID from inspection",
    },
    adaptiveRevision: {
      type: "string",
      description:
        "Exact Sentinel worker assignment revision from run inspection",
    },
    expectedVersion: {
      type: "integer",
      description:
        "Exact current operating constraint version, or zero before the first constraint",
    },
    version: {
      type: "integer",
      description: "Read one exact saved operating constraint version",
    },
    originalId: {
      type: "string",
      description: "Exact approved Sentinel discovery to replace",
    },
    originalVersion: {
      type: "integer",
      description: "Version of the approved Sentinel discovery",
    },
    replacementId: {
      type: "string",
      description: "Exact independently verified pending Sentinel discovery",
    },
    replacementVersion: {
      type: "integer",
      description: "Version of the pending Sentinel discovery",
    },
    proposalId: {
      type: "string",
      description:
        "Exact Sentinel worker goal proposal or task dependency approval ID",
    },
    goalProofDigest: {
      type: "string",
      description:
        "Exact saved proof digest returned by goals with includeProof",
    },
    includeProof: {
      type: "boolean",
      description:
        "Include verified proof for the selected page of goal criteria",
    },
    goalId: {
      type: "string",
      description: "Read criteria for an exact Sentinel formal goal",
    },
    goals: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "policy", "criteria"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          policy: { type: "string", enum: ["operator", "automatic"] },
          criteria: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "description", "source", "reference"],
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                source: {
                  type: "string",
                  enum: [
                    "graph_evidence",
                    "adaptive_task",
                    "graph_fact",
                    "finding_recheck",
                  ],
                },
                reference: {
                  type: "string",
                  description:
                    'Exact evidence ID for graph_evidence. For adaptive_task, use an exact task ID or the shape task:trace:1:ASSET, task:impact:1:ASSET, or task:verify_control_coverage:pass:ASSET. For graph_fact, use a worker-graph-fact receipt ID or a JSON string encoding ["from","relation","to"]. For finding_recheck, prefix the exact worker-finding ID with pass:.',
                },
              },
            },
          },
        },
      },
      description:
        "Formal goals with id, title, policy, and verifiable criteria. Requires operator confirmation.",
    },
    deniedKinds: {
      type: "array",
      items: { type: "string" },
      description: "Complete set of defensive task kinds to disable in the run",
    },
    allowedAssetIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional exact asset IDs to restrict future tasks within baseline authorization",
    },
    executionId: {
      type: "string",
      description:
        "Original durable subagent request UUID. Omit for team delivery resume, which uses the exact retained delivery identity.",
    },
    originalTask: {
      type: "string",
      description:
        "Original non-secret delegated task text for recovery binding",
    },
    targetKind: {
      type: "string",
      description: "Linked run type",
      enum: ["sentinel", "workflow", "delegated", "scheduled"],
    },
    targetId: { type: "string", description: "Exact linked run ID" },
    templateId: {
      type: "string",
      description: "Exact UUID of a workspace Sentinel assessment template.",
    },
    templateVersion: {
      type: "integer",
      description:
        "Exact template version to start, or expected version to edit (0 creates).",
    },
    childDescription: {
      type: "string",
      description: "Optional display title for a linked Sentinel assessment.",
    },
    initialGraph: {
      type: "string",
      description:
        "Create a linked Sentinel case with an empty local graph. Omit to use an existing published graph.",
      enum: ["empty"],
    },
    supersedes: {
      type: "object",
      description:
        "For appending a replacement goal, the completed goalId and exact evidenceRevision.",
    },
    goalProposal: {
      type: "object",
      description:
        "Reviewed initial goal draft for a linked Sentinel run, with goals and optional initialConstraints.",
    },
    childGoal: {
      type: "string",
      description: "Optional objective for a linked Sentinel assessment start.",
    },
    seedTask: {
      type: "object",
      description:
        "Optional first linked Sentinel investigation with kind (trace or impact) and nodeId (an exact asset ID from the published child graph).",
    },
    timeoutSeconds: {
      type: "integer",
      description: "Optional wall-clock limit for a new linked Sentinel run",
    },
    sourceCases: {
      type: "array",
      description:
        "Up to four distinct {caseId, revision} source cases for the linked Sentinel child. Sources select only already-approved shared discoveries.",
    },
    inventoryCoverageEnabled: {
      type: "boolean",
      description:
        "When spawning a Sentinel assessment, enable optional inventory coverage (default true)",
    },
    plannerHeartbeatSeconds: {
      type: "integer",
      description:
        "Optional idle planning interval for the linked Sentinel run, 600 to 86400 seconds",
    },
    fallbackModelProfiles: {
      type: "array",
      description:
        "Up to three distinct approved INTERNAL provider names in failover order.",
    },
    modelRole: {
      type: "string",
      enum: [...sentinelModelRoles],
      description:
        "Exact Sentinel model role for set_model_role. Omit modelProfile to remove its override.",
    },
    activeModelProfile: {
      type: "string",
      description:
        "Approved provider in the replacement chain to use for subsequent calls",
    },
    modelRouteClassification: {
      type: "string",
      enum: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
      description:
        "Exact classification route selected for model administration",
    },
    modelRouteModel: {
      type: "string",
      description:
        "Exact model name currently configured for the selected provider",
    },
    modelProfile: {
      type: "string",
      description:
        "Permitted provider name for a linked Sentinel run. Omit to inherit the parent run selection.",
    },
    targetRevision: {
      type: "integer",
      description: "Exact linked Sentinel evidence revision",
    },
    stopRequestId: {
      type: "string",
      description:
        "For an explicit graph-only retry_model_review, the exact durable worker stop request UUID.",
    },
    requestId: {
      type: "string",
      description:
        "Stable request UUID for linking, starting workflows, or giving guidance",
    },
    taskStatus: {
      type: "string",
      enum: [
        "queued",
        "running",
        "completed",
        "failed",
        "superseded",
        "cancelled",
      ],
      description: "Filter the Sentinel task queue by durable execution status",
    },
    hints: {
      type: "array",
      description:
        "Up to eight ordered case-wide or asset-scoped Sentinel planner hints for one review.",
      items: {
        type: "object",
        required: ["note"],
        additionalProperties: false,
        properties: {
          note: { type: "string" },
          assetIds: { type: "array", items: { type: "string" } },
          trafficReferences: {
            type: "array",
            items: { type: "object" },
            description:
              "Two to four exact retained references in order. Omit trafficReference.",
          },
          trafficReference: {
            type: "object",
            required: ["evidenceId", "digest"],
            additionalProperties: false,
            properties: {
              evidenceId: { type: "string" },
              digest: { type: "string" },
            },
          },
        },
      },
    },
    assignments: {
      type: "array",
      description:
        "Up to eight exact local graph tasks for an atomic approved Sentinel assignment.",
      items: {
        type: "object",
        required: ["taskKind", "node"],
        additionalProperties: false,
        properties: {
          taskKind: { type: "string", enum: ["trace", "impact"] },
          node: { type: "string" },
          prioritizeNext: { type: "boolean" },
          priorityRank: { type: "integer" },
        },
      },
    },
    priorityRank: {
      type: "integer",
      description:
        "Set a local graph assignment's reviewed rank from 1 to 10. Zero uses the default rank of 5.",
    },
    prioritizeNext: {
      type: "boolean",
      description:
        "Explicitly place a local trace or impact assignment ahead of ordinary eligible queued work.",
    },
    taskKind: {
      type: "string",
      description: "Supported defensive investigation kind for an exact node",
    },
    recheckFindingId: {
      type: "string",
      description:
        "Exact worker finding for an approved review_evidence assignment on a retained verification receipt.",
    },
    passingRecheckForFindingId: {
      type: "string",
      description:
        "Wait for a verified current passing recheck of this exact local worker finding without dispatching a worker",
    },
    graphRelationship: {
      type: "object",
      description:
        "For trace assignments, wait for the exact directed edge. For an asset-scoped verifies edge, requireCurrentPass true requires a currently valid pass from the latest observed check. A named from pins that exact source. Omit from to allow a newer valid pass for the same control and asset.",
    },
    traceRunId: {
      type: "string",
      description:
        "Exact source execution run ID for evidence discovery or attachment",
    },
    branch: {
      type: "string",
      description: "Exact approved branch name in the source receipt",
    },
    controlId: { type: "string", description: "Exact Sentinel control ID" },
    validUntil: {
      type: "string",
      description:
        "Requested UTC expiration time for discovered or attached control evidence",
    },
    traceRole: {
      type: "string",
      description: "Trusted execution trace role",
      enum: ["delegated", "scheduled", "owner_chat", "team_delivery"],
    },
    includeResult: {
      type: "boolean",
      description:
        "Reopen the exact approved result of a selected planner read",
    },
    ordinal: {
      type: "integer",
      description:
        "One-based tool step ordinal in a saved execution or planner trace",
    },
    plannerIdentity: {
      type: "string",
      description: "Exact saved Sentinel planning round identity",
    },
    attempt: {
      type: "integer",
      description: "Exact saved planning attempt number",
    },
    digestId: {
      type: "string",
      description: "Exact retained Sentinel evidence digest ID",
    },
    nodeKind: {
      type: "string",
      description: "Exact provenance node kind when saving an evidence digest",
    },
    factId: {
      type: "string",
      description: "Exact retained Sentinel graph fact ID",
    },
    trafficReferences: {
      type: "array",
      items: { type: "object" },
      description:
        "Two to four exact {evidenceId,digest} traffic references for the same asset. Omit trafficReference.",
    },
    trafficReference: {
      type: "object",
      description:
        "Exact retained traffic evidenceId and digest to anchor a planner hint. Requires one assetIds entry.",
    },
    assetText: {
      type: "string",
      description:
        "Literal case-insensitive label or alias text for an authorized asset inventory search.",
    },
    assetIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Exact local asset IDs: up to four for a planner hint or up to twenty for an asset inventory lookup.",
    },
    taskIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Exact failed graph task IDs to retry together, up to eight.",
    },
    turnId: {
      type: "string",
      description:
        "Exact live Sentinel main-agent turn ID from interactive_turns.",
    },
    cancellationReason: {
      type: "string",
      description:
        "Reviewed reason for cancelling queued Sentinel work or stopping one graph worker.",
    },
    taskId: {
      type: "string",
      description: "Exact active Sentinel assignment ID",
    },
    note: {
      type: "string",
      description: "Bounded assignment guidance or case-wide planner hint",
    },
    query: {
      type: "string",
      description: "Search text for graph records or worker history",
    },
    includeCoverageTotals: {
      type: "boolean",
      description:
        "Include exact in-scope counts by asset type for inventory coverage.",
    },
    includeProgress: {
      type: "boolean",
      description:
        "Include exact authorized Sentinel goal and running worker counts in run discovery.",
    },
    includeFrontier: {
      type: "boolean",
      description:
        "Include bounded investigation queue totals and exact task IDs in graph_overview.",
    },
    includeFindingTraffic: {
      type: "boolean",
      description:
        "Include active attachment IDs for an exact graph finding with node.",
    },
    trafficOffset: {
      type: "integer",
      description:
        "Next attachment metadata offset from the previous graph finding page.",
    },
    node: {
      type: "string",
      description:
        "Exact graph node for assignment or saved provenance ID for inspection",
    },
    latestResult: {
      type: "boolean",
      description:
        "Select the last committed returned step of an interrupted or stopped worker with worker_trace_result. Omit stepIndices.",
    },
    stepIndices: {
      type: "array",
      items: { type: "integer" },
      description:
        "Exact step indices. Worker results return up to five followed by omitted indices when needed.",
    },
    scope: {
      type: "string",
      description: "Published case inventory or approved case membership",
      enum: ["case", "membership"],
    },
    view: {
      type: "string",
      description: "Saved case inventory view",
      enum: ["assets", "organizations", "coverage"],
    },
    assetId: { type: "string", description: "Exact published case asset ID" },
    asOf: {
      type: "string",
      description:
        "UTC instant for verification coverage or task diagnostics, with milliseconds",
    },
    coverageGap: {
      type: "string",
      enum: [
        "unreviewed",
        "missing_evidence",
        "missing_current_verification",
        "either",
      ],
      description:
        "Return inventory coverage gaps for the selected case or approved membership",
    },
    organizationText: {
      type: "string",
      description:
        "Literal case-insensitive organization name for authorized inventory discovery.",
    },
    includeMembers: {
      type: "boolean",
      description:
        "Page the visible asset IDs declared for the exact organizationId.",
    },
    organizationId: {
      type: "string",
      description: "Exact organization ID declared in the selected case",
    },
    assetType: { type: "string", description: "Published asset type filter" },
    parentId: { type: "string", description: "Exact published parent ID" },
    alias: { type: "string", description: "Exact published asset alias" },
    cursor: {
      type: "string",
      description:
        "Continuation cursor returned by the previous page of the same operation",
    },
    workflowRunNumber: {
      type: "integer",
      description:
        "Select an exact completed GitHub run ID from a native workflow trace result for control verification.",
    },
    sequence: {
      type: "integer",
      description: "Exact workflow trace event sequence",
    },
    category: {
      type: "object",
      description:
        "Existing Sentinel run category as an object with exact id and version for a reviewed template or linked start.",
    },
    categoryId: {
      type: "string",
      description: "Exact workspace run category ID.",
    },
    runTargets: {
      type: "array",
      description:
        "Exact workflow runs or Sentinel case, revision, and run IDs. Restore batches also require each exact Sentinel archive ID.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["workflow", "sentinel"] },
          id: { type: "string" },
          revision: { type: "integer" },
          runId: { type: "string" },
          archiveId: { type: "string" },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
    },
    findingIds: {
      type: "array",
      description:
        "One to sixteen exact selected finding IDs for finding_asset_tree.",
      items: { type: "string" },
    },
    linkedFinding: {
      type: "object",
      description:
        "Exact selected finding selector: asset, sourceCase, sourceAsset, finding, snapshotDigest.",
    },
    findingOrder: {
      type: "string",
      enum: ["severity", "time"],
      description: "Optional finding_groups priority and page order.",
    },
    findingFilter: {
      type: "object",
      description:
        "Optional finding_groups filter: kind (imported or worker), assetId, query, severity, disposition, findingCategory.",
    },
    includeFacets: {
      type: "boolean",
      description:
        "Include severity, disposition, and paged category counts for authorized finding_groups scopes.",
    },
    scopes: {
      type: "array",
      description:
        "Explicit Sentinel revisions, configured workflow runs, or delegated and scheduled runs. Use offset for Sentinel and cursor for other run types. active_finding_rechecks uses a cursor for each Sentinel case.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string" },
          kind: {
            type: "string",
            enum: ["sentinel", "workflow", "delegated", "scheduled"],
          },
          revision: { type: "integer", minimum: 1 },
          offset: { type: "integer", minimum: 0 },
          categoryOffset: { type: "integer", minimum: 0 },
          assetSubtreeId: {
            type: "string",
            description: "Exact authorized hierarchy root for finding_groups.",
          },
          cursor: { type: "string" },
        },
      },
    },
    offset: { type: "integer", description: "Saved result offset" },
    limit: { type: "integer", description: "Bounded result page size" },
  },
};

export const sentinelScopedTelemetryReadActions = [
  "incidents",
  "incident_alerts",
  "case_alert",
  "defense_coverage",
] as const;

export const sentinelOperatorCaseReadActions = [
  "model_route",
  "graph_overview",
  "graph",
  "findings",
  "node",
  "inventory",
  "facts",
  "finding_receipts",
  "finding_receipt",
  ...sentinelScopedTelemetryReadActions,
  "list_digests",
  "expand_digest",
  "traces",
  "list_trace_workers",
  "worker_trace_progress",
  "worker_trace_result",
] as const;

export const sentinelOperatorCaseReadParameters = [
  "action",
  "runId",
  "kind",
  "id",
  "revision",
  "node",
  "includeFindingTraffic",
  "includeFrontier",
  "includeCoverageTotals",
  "trafficOffset",
  "query",
  "offset",
  "limit",
  "view",
  "scope",
  "assetId",
  "assetIds",
  "assetText",
  "organizationId",
  "organizationText",
  "includeMembers",
  "assetType",
  "parentId",
  "alias",
  "coverageGap",
  "asOf",
  "cursor",
  "factId",
  "receiptId",
  "incidentId",
  "alertId",
  "upstreamCheck",
  "behavior",
  "digestId",
  "taskId",
  "stepIndices",
  "latestResult",
  "workflowRunNumber",
] as const;

export const sentinelOperatorCaseControlActions = [
  "constraints",
  "narrow_constraints",
  "steer",
  "hint_batch",
  "assign_batch",
  "append_goals",
  "withdraw_goal",
  "add_case_membership",
] as const;

export const sentinelOperatorCaseControlParameters = [
  "adaptiveRevision",
  "allowedAssetIds",
  "assignments",
  "hints",
  "goals",
  "supersedes",
  "goalId",
  "version",
  "expectedVersion",
  "requestId",
  "deniedKinds",
  "note",
] as const;

function parseReviewedFindingFollowup(
  receiptId: unknown,
  note: unknown,
  context?: OperatorRunToolContext,
) {
  if (
    typeof receiptId !== "string" ||
    !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
    typeof note !== "string" || !note.trim() || note.length > 1000 ||
    /[\p{Cc}\p{Cf}]/u.test(note) || redactCredentialText(note) !== note ||
    !canFlowTo(context?.inputClassification ?? "INTERNAL", "INTERNAL") ||
    !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL")
  ) return;
  return { findingId: receiptId, note: note.trim() };
}

/** Runtime policy for reopening an approved original tool response. */
export interface OperatorRunToolContext {
  readonly authorizeSelectedSentinelCase?: () => boolean;
  readonly authorizeSentinelCaseRead?: (
    caseId: string,
    revision: number,
  ) => boolean;
  readonly authenticatedOwnerSessionId?: string;
  readonly authorizeOwnerRunCall?: (
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  readonly ownerRecoverySessionId?: string;
  readonly delegatedRecovery?: {
    readonly parent: SessionId;
    readonly resume: (executionId: string, task: string) => Promise<void>;
  };
  readonly resumeTeamDelivery?: (
    deliveryId: string,
    teamId: string,
    memberSessionId: string,
    task: string,
  ) => Promise<void>;
  readonly inputClassification?: ClassificationLevel;
  readonly ceiling?: ClassificationLevel;
  readonly authorizeSentinelTraceRead?: (
    scope:
      & { caseId: string; revision: number }
      & (
        | { taskId: string; plannerIdentity?: never; attempt?: never }
        | { taskId?: never; plannerIdentity: string; attempt: number }
      ),
    tool: string,
    call: Record<string, unknown>,
    result?: string,
  ) => Promise<boolean>;
  readonly authorizeWorkflowDestination?: (
    destination: SentinelLiveWorkflowDestination,
    revision: number,
    taskId: string,
  ) => Promise<boolean>;
  readonly authorizeSavedCall: (call: RecoveryToolCall) => Promise<boolean>;
  readonly authorizeSavedResponse: (
    name: string,
    text: string,
    classification: ClassificationLevel,
  ) => Promise<boolean>;
}

export type OperatorRunToolExecutor = (
  args: Record<string, unknown>,
  context?: OperatorRunToolContext,
) => Promise<string>;

function kind(value: unknown): OperatorRunKind | undefined {
  return value === "sentinel" || value === "workflow" ? value : undefined;
}

function backgroundReference(
  type: unknown,
  id: unknown,
  revision: unknown,
): OperatorRunRef | undefined {
  return (type === "delegated" || type === "scheduled") &&
      typeof id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(id) &&
      revision === undefined
    ? { kind: type, id }
    : undefined;
}

function backgroundRunSummary(
  { scope, status, classification, admittedAt, finishedAt, operatorCancelled }:
    ExecutionTraceRun,
  recovery?: ReturnType<AgentRecoveryStore["inspectStatus"]>,
): OperatorRunSummary {
  if (scope.role === "owner_chat") {
    throw new Error("Owner traces require the owner-session route.");
  }
  return {
    ref: { kind: scope.role, id: scope.runId },
    label: scope.runId,
    status: operatorCancelled
      ? "cancelled"
      : recovery?.status === "paused"
      ? "paused"
      : status,
    classification,
    startedAt: admittedAt,
    ...(finishedAt !== undefined && { completedAt: finishedAt }),
    ...(recovery && { details: { recovery } }),
  };
}

function projectBackgroundRun(run: OperatorRunSummary) {
  return {
    ref: run.ref,
    status: run.status,
    classification: run.classification,
    admittedAt: run.startedAt,
    ...(run.completedAt !== undefined && { finishedAt: run.completedAt }),
  };
}

function reference(
  type: unknown,
  id: unknown,
  revision: unknown,
): OperatorRunRef | undefined {
  const parsed = kind(type);
  if (
    !parsed || typeof id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) ||
    revision !== undefined &&
      (parsed !== "sentinel" || typeof revision !== "number" ||
        !Number.isSafeInteger(revision) || revision < 1)
  ) return;
  return { kind: parsed, id, ...(revision !== undefined && { revision }) };
}

function exactCategoryTargets(
  value: unknown,
  digestPattern: RegExp,
): CategorizedOperatorRun[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 8) return;
  const seen = new Set<string>();
  const targets: CategorizedOperatorRun[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const ref = reference(item.kind, item.id, item.revision);
    if (
      !ref || (ref.kind !== "sentinel" && ref.kind !== "workflow") ||
      seen.has(`${ref.kind}:${ref.id}`) ||
      (ref.kind === "sentinel"
        ? !isSentinelCaseId(ref.id) || ref.revision === undefined ||
          typeof item.runId !== "string" || !digestPattern.test(item.runId)
        : !digestPattern.test(ref.id) || item.runId !== undefined) ||
      Object.keys(item).some((key) =>
        !["kind", "id", "revision", "runId"].includes(key)
      )
    ) return;
    seen.add(`${ref.kind}:${ref.id}`);
    targets.push({
      ...ref,
      kind: ref.kind,
      runId: ref.kind === "sentinel" ? item.runId.toLowerCase() : ref.id,
    });
  }
  return targets;
}

function safeProjection(
  value: Record<string, unknown>,
  classification: ClassificationLevel = "INTERNAL",
) {
  const text = JSON.stringify({ ...value, _classification: classification });
  return text.length <= 8000
    ? text
    : "Error: Select a run type or exact run to narrow the response.";
}

function sentinelTraceSourceSelector(
  step: Pick<
    SentinelReviewStep,
    | "tool"
    | "target"
    | "goalReceiptRead"
    | "trafficRead"
    | "trafficSearch"
    | "trafficLinks"
    | "linkedTrafficPayload"
  >,
) {
  if (step.tool === SENTINEL_TRAFFIC_READ && step.trafficRead) {
    const { sha256: _digest, ...args } = step.trafficRead;
    return sentinelTrafficReadArgs(args);
  }
  if (step.tool === SENTINEL_TRAFFIC_SEARCH && step.trafficSearch) {
    return sentinelTrafficSearchArgs(step.trafficSearch.args);
  }
  if (step.tool === SENTINEL_TRAFFIC_LINKS) {
    return sentinelLinkedTrafficPayloadReference(step.linkedTrafficPayload)
      ?.args ??
      sentinelTrafficLinksArgs(step.trafficLinks?.args);
  }
  return step.goalReceiptRead
    ? sentinelGoalReceiptReadArguments(step.tool, step.goalReceiptRead.args)
    : step.tool === "sentinel_shared_asset" && step.target
    ? sentinelSharedAssetLinksArgs({ asset: step.target })
    : undefined;
}

function reopenSentinelObservationSearch(
  path: string,
  revision: number,
  runId: string,
  page: NonNullable<ReturnType<typeof readSentinelObservationSearchReference>>,
  assignmentId?: string,
) {
  const scope = readSentinelWorkerEvidenceScope(path, revision, assignmentId);
  if (!scope || scope.runId !== runId) return;
  if (
    typeof page.args.query !== "string" ||
    (page.args.revision !== undefined && page.args.revision !== revision)
  ) return;
  const offset = page.args.offset ?? 0;
  const database = join(dirname(path), "sentinel-adaptive.db");
  const query = {
    query: page.args.query,
    offset,
    allowedTaskIds: scope.allowedTaskIds,
  };
  const rows = querySentinelWorkerObservations(database, revision, {
    ...query,
    saved: { runId, ids: page.ids },
  });
  if (page.nextOffset !== null) {
    const current = querySentinelWorkerObservations(database, revision, query);
    if (typeof current !== "object" || current.nextOffset === null) return;
  }
  if (!rows || typeof rows !== "object") return;
  return JSON.stringify({
    revision,
    offset,
    observations: rows.observations,
    nextOffset: page.nextOffset,
  });
}

function reopenSentinelPlannerTraffic(
  path: string,
  caseId: string,
  revision: number,
  runId: string,
  read: Pick<
    SentinelReviewStep,
    | "tool"
    | "trafficRead"
    | "trafficSearch"
    | "trafficSearchPage"
    | "trafficLinks"
    | "linkedTrafficPayload"
  >,
  args: Record<string, unknown>,
) {
  if (args.revision !== revision) return;
  if (read.tool === SENTINEL_TRAFFIC_LINKS && read.linkedTrafficPayload) {
    const binding = sentinelLinkedTrafficPayloadReference(
      read.linkedTrafficPayload,
    );
    if (!binding || !isDeepStrictEqual(binding.args, args)) return;
    const text = reopenSentinelLinkedTrafficPayload(
      path,
      caseId,
      revision,
      undefined,
      args,
      (assetId) => {
        const constraints = readSentinelOperatingConstraints(path, runId)
          ?.constraints;
        return sentinelOperatingConstraintsAllow(
          constraints,
          { kind: "review_evidence", nodeId: assetId },
          readSentinelAssessmentRevision(path, revision)?.result.sharedGraph
            .snapshot,
        );
      },
    );
    return createHash("sha256").update(text).digest("hex") === binding.sha256
      ? text
      : undefined;
  }
  let result: unknown;
  let digest: string | undefined;
  if (read.tool === SENTINEL_TRAFFIC_READ) {
    const selector = sentinelTrafficReadArgs(args);
    if (!selector) return;
    result = readProjectedSentinelTrafficReceipt(
      path,
      caseId,
      revision,
      selector,
    );
    digest = read.trafficRead?.sha256;
  } else if (read.tool === SENTINEL_TRAFFIC_LINKS) {
    const page = sentinelTrafficLinkPageReference(read.trafficLinks);
    if (!page || !isDeepStrictEqual(page.args, args)) return;
    const links = page.linkIds.map((id) =>
      listSentinelFindingTrafficLinks(path, {
        id,
        evidenceRevision: revision,
        findingId: page.args.findingId,
        recheckId: page.args.recheckId,
      })[0]
    );
    if (links.some((link) => !link || link.caseId !== caseId)) return;
    if (
      !allowsSentinelGraphFindingTrafficPage(
        path,
        caseId,
        revision,
        page.args.graphFindingId,
        links,
        page.args.assetId,
      )
    ) return;
    result = {
      _classification: "INTERNAL",
      caseId,
      evidenceRevision: revision,
      links,
      evidenceVersion: page.evidenceVersion,
      nextOffset: page.nextOffset,
    };
    digest = page.sha256;
  } else {
    const page = sentinelTrafficPageReference(read.trafficSearchPage);
    if (
      !page || page.revision !== revision ||
      page.sha256 !== read.trafficSearch?.sha256
    ) return;
    const receipts = page.receipts.map((reference) =>
      readProjectedSentinelTrafficReceipt(path, caseId, revision, reference)
        ?.receipt
    );
    if (receipts.some((receipt) => !receipt)) return;
    result = {
      caseId,
      evidenceRevision: revision,
      _classification: "INTERNAL",
      receipts,
      nextCursor: page.nextCursor,
    };
    digest = page.sha256;
  }
  const text = result && JSON.stringify(result);
  if (
    typeof text === "string" &&
    createHash("sha256").update(text).digest("hex") === digest
  ) return text;
}

async function reopenSentinelSourceResult(
  baseDir: string,
  path: string,
  revision: number,
  step: Pick<
    SentinelReviewStep,
    | "tool"
    | "target"
    | "goalReceiptRead"
    | "sharedAssetLinksPage"
    | "plannerProvenancePath"
    | "provenanceSearchPage"
    | "provenanceSearchResult"
    | "provenanceNodePage"
    | "plannerProvenanceNodeResult"
    | "observationSearch"
    | "taskObservationPage"
    | "goalStateProjection"
    | "caseHintFirstId"
    | "graphFactPage"
    | "graphOverviewProjection"
    | "findingPage"
    | "sharedAssetDiscovery"
    | "discoveryPage"
    | "outcome"
    | "plannerDefenseContainment"
    | "workerTracePage"
  >,
  selector: Record<string, unknown>,
) {
  const receipt = step.goalReceiptRead;
  if (!receipt) return;
  let text: string | undefined;
  if (step.tool === "sentinel_shared_topology_source") {
    const { evidenceId, sourceCase } = selector;
    if (
      typeof evidenceId !== "string" || typeof sourceCase !== "string" ||
      step.target !== evidenceId
    ) return;
    const source = await readScopedSentinelTopologySource(
      baseDir,
      path,
      revision,
      evidenceId,
      sourceCase,
    );
    if (source) text = projectSentinelSharedTopologySource(source, revision);
  } else if (step.tool === "sentinel_shared_finding_source") {
    const finding = parseSentinelPinnedFindingRead(selector);
    if (!finding || step.target !== finding.finding) return;
    const scope = readSentinelSharedFindingLocalScope(
      path,
      revision,
      finding.asset,
    );
    if (!scope) return;
    const source = await readArchivedSentinelFindingSource(baseDir, {
      caseId: finding.sourceCase,
      assetId: finding.sourceAsset,
      findingId: finding.finding,
      snapshotDigest: finding.snapshotDigest,
    }, path);
    if (source && scope.isCurrent()) {
      text = projectSentinelSharedFindingSource(source, revision, finding);
    }
  } else if (step.tool === "sentinel_shared_asset_links") {
    const args = sentinelSharedAssetLinksArgs(selector);
    const page = step.sharedAssetLinksPage;
    const projection = args && page &&
      parseSharedAssetLinkPage(page, revision, args);
    if (
      args && args.asset === step.target && page && projection &&
      allowsRetainedSentinelSharedTopology(path, revision, projection)
    ) text = page;
  } else if (step.tool === "sentinel_path" && selector.graph === "provenance") {
    const args = sentinelGoalReceiptReadArguments(step.tool, selector);
    const saved = step.plannerProvenancePath;
    if (
      args && args.to === step.target && saved &&
      allowsSavedSentinelProvenancePath(path, revision, args, saved)
    ) text = saved;
  } else if (step.tool === "sentinel_provenance_search") {
    const page = readSentinelProvenanceSearchReference(
      step.provenanceSearchPage,
    );
    if (
      page && isDeepStrictEqual(page.args, selector) &&
      page.sha256 === receipt.sha256
    ) {
      text = step.provenanceSearchResult === undefined
        ? reopenSentinelProvenanceSearch(path, revision, page)
        : readSavedSentinelProvenanceSearch(
          step.provenanceSearchResult,
          page,
          revision,
        );
      if (
        text &&
        !allowsRetainedSentinelProvenancePage(path, revision, page.args, text)
      ) return;
    }
  } else if (step.tool === "sentinel_provenance_node") {
    const page = readSentinelProvenanceNodeReference(step.provenanceNodePage);
    if (
      page && step.target === page.args.node &&
      isDeepStrictEqual(page.args, selector) &&
      page.sha256 === receipt.sha256
    ) {
      text = step.plannerProvenanceNodeResult === undefined
        ? reopenSentinelProvenanceNode(path, revision, page)
        : readSavedSentinelProvenanceNode(
          step.plannerProvenanceNodeResult,
          page,
          revision,
        );
      if (
        text &&
        !allowsRetainedSentinelProvenancePage(path, revision, page.args, text)
      ) return;
    }
  } else if (step.tool === "sentinel_worker_trace_search") {
    const page = readSentinelWorkerTracePageReference(step.workerTracePage);
    if (
      page && isDeepStrictEqual(page.args, selector) &&
      page.sha256 === receipt.sha256
    ) {
      text = reopenSentinelWorkerTraceSearch(path, revision, undefined, page);
    }
  } else if (step.tool === "sentinel_worker_observation") {
    const page = readSentinelObservationSearchReference(step.observationSearch);
    const runId = readSentinelRunIdForRevision(path, revision);
    if (
      page && runId && isDeepStrictEqual(page.args, selector) &&
      page.sha256 === receipt.sha256
    ) {
      text = reopenSentinelObservationSearch(path, revision, runId, page);
    }
    const direct = readSentinelTaskObservationPageReference(
      step.taskObservationPage,
    );
    if (
      direct && direct.task === step.target && direct.task === selector.task &&
      direct.offset === (selector.offset ?? 0) &&
      direct.sha256 === receipt.sha256
    ) {
      text = inspectSentinelWorkerObservation(
        { snapshotPath: path, assessmentRevision: revision },
        selector,
        true,
      );
    }
  } else if (step.tool === "sentinel_goal_state") {
    const projection = readSentinelGoalStateProjection(
      step.goalStateProjection,
    );
    if (projection) {
      text = readHistoricalSentinelGoalState(
        path,
        revision,
        selector,
        projection,
      );
    }
  } else if (step.tool === "sentinel_case_hints") {
    const args = sentinelGoalReceiptReadArguments(step.tool, selector);
    if (args?.assignedTraffic && typeof step.target !== "string") return;
    const assetId = args?.assignedTraffic ? step.target : undefined;
    const first = step.caseHintFirstId;
    if (args && first === null) {
      text = JSON.stringify({ hints: [], nextBefore: null });
    }
    if (
      args && typeof first === "number" && Number.isSafeInteger(first + 1) &&
      first >= 1 &&
      (args.before === undefined || first < args.before)
    ) {
      text = projectCaseHints(
        path,
        args.limit ?? 3,
        first + 1,
        revision,
        assetId,
      );
    }
  } else if (step.tool === "sentinel_graph_overview") {
    const projection = readSentinelGraphOverviewProjection(
      step.graphOverviewProjection,
      revision,
    );
    if (
      projection &&
      (selector.revision === undefined || selector.revision === revision)
    ) {
      const graph = readSentinelProvenance(path, revision, null)?.graph
        .overview();
      const fits = (
        retained: Record<string, number>,
        current: Record<string, number>,
      ) =>
        Object.entries(retained).every(([key, count]) =>
          count <= (current[key] ?? 0)
        );
      if (
        graph &&
        projection.unresolvedReferenceCount <= graph.unresolvedReferenceCount &&
        fits(projection.nodesByKind, graph.nodesByKind) &&
        fits(projection.edgesByRelation, graph.edgesByRelation)
      ) text = JSON.stringify(projection);
    }
  } else if (step.tool === "sentinel_graph_facts") {
    const runId = readSentinelRunIdForRevision(path, revision);
    const location = locateSentinelCase(path);
    const snapshot = readSentinelAssessmentRevision(path, revision)?.result
      .sharedGraph.snapshot;
    const args = sentinelGoalReceiptReadArguments(step.tool, selector);
    const page = readSentinelGraphFactPageReference(step.graphFactPage);
    if (
      runId && location && args &&
      (args.id !== undefined
        ? args.id === step.target
        : page && page.offset === (args.offset ?? 0) &&
          page.sha256 === receipt.sha256)
    ) {
      const constraints = readSentinelOperatingConstraints(path, runId)
        ?.constraints;
      text = readSentinelPlannerGraphFacts(
        path,
        location.caseId,
        runId,
        revision,
        args,
        (nodeId) =>
          sentinelOperatingConstraintsAllow(constraints, {
            kind: "review_evidence",
            nodeId,
          }, snapshot),
        args.id === undefined ? page : undefined,
      );
    }
  } else if (
    step.tool === "sentinel_shared_asset_discoveries" &&
    selector.id === undefined
  ) {
    const page = readSentinelDiscoveryPageReference(step.discoveryPage);
    const caseId = locateSentinelCase(path)?.caseId;
    if (
      page && caseId && page.after === selector.after &&
      page.sha256 === receipt.sha256 &&
      page.result.discoveries.every(({ sourceCaseId }) =>
        sourceCaseId !== caseId
      )
    ) text = JSON.stringify(page.result);
  } else if (step.tool === "sentinel_shared_asset_discoveries") {
    const caseId = locateSentinelCase(path)?.caseId;
    const runId = readSentinelRunIdForRevision(path, revision);
    if (caseId && runId && selector.id === step.sharedAssetDiscovery?.id) {
      text = reopenCitedDiscovery(baseDir, path, caseId, revision, runId, step)
        ?.text;
    }
  } else if (step.tool === "sentinel_worker_findings") {
    const runId = readSentinelRunIdForRevision(path, revision);
    const location = locateSentinelCase(path);
    const args = sentinelGoalReceiptReadArguments(step.tool, selector);
    const page = readSentinelFindingPageReference(step.findingPage);
    if (
      runId && location && args &&
      (args.receiptId ? args.receiptId === step.target : page &&
        isDeepStrictEqual(page.args, args) && page.sha256 === receipt.sha256)
    ) {
      const snapshot = readSentinelAssessmentRevision(path, revision)?.result
        .sharedGraph.snapshot;
      const constraints = readSentinelOperatingConstraints(path, runId)
        ?.constraints;
      text = reopenSentinelPlannerFindings(
        path,
        { caseId: location.caseId, runId, evidenceRevision: revision },
        args,
        (nodeId) =>
          sentinelOperatingConstraintsAllow(constraints, {
            kind: "review_evidence",
            nodeId,
          }, snapshot),
        page,
      );
    }
  } else if (step.tool === "sentinel_incident_alerts") {
    if (selector.incidentId === step.target) {
      text = queryIncidentAlerts(
        {
          snapshotPath: path,
          assessmentRevision: revision,
        },
        selector,
        false,
        {},
      );
    }
  } else if (
    step.tool === "sentinel_defense" &&
    step.plannerDefenseContainment !== undefined
  ) {
    text = await readDefenseCoverage(
      {
        snapshotPath: path,
        assessmentRevision: revision,
        webContainmentConfigured: step.plannerDefenseContainment ?? undefined,
      },
      selector,
      {},
    );
  } else if (isSentinelArchivedInventoryRead(step.tool, selector)) {
    if ((selector.node ?? selector.to) !== step.target) return;
    text = await readSentinelGraphProjection(
      path,
      revision,
      step.tool,
      selector,
      true,
    );
  }
  if (
    text && !text.startsWith("Error:") &&
    createHash("sha256").update(text).digest("hex") === receipt.sha256
  ) return text;
}

/** Verify the exact projection behind a committed discovery read. */
function reopenCitedDiscovery(
  baseDir: string,
  path: string,
  caseId: string,
  revision: number,
  runId: string,
  step: SentinelReviewStep,
  taskAssetId?: string,
) {
  const citation = step.sharedAssetDiscovery;
  const receipt = step.goalReceiptRead;
  if (
    !citation || !receipt ||
    step.tool !== "sentinel_shared_asset_discoveries" ||
    step.outcome !== "returned" || step.target !== citation.id ||
    receipt.args.id !== citation.id
  ) return;
  const entry = readHistoricalDiscoveryEvidence(
    baseDir,
    path,
    citation.id,
    citation.version,
  );
  const record = entry && verifiedSharedAssetDiscovery(
    caseId,
    new Map([[citation.id, entry.record]]),
    step,
  );
  const destination = readSentinelAssessmentRevision(
    path,
    revision,
  )
    ?.result.sharedGraph.snapshot;
  const match = record && destination &&
    matchSentinelAssetDiscoveryDestination(
      loadSentinelGraph(entry.snapshot),
      loadSentinelGraph(destination),
      record.claim,
    );
  if (
    !record || !match ||
    (taskAssetId !== undefined && match.assetId !== taskAssetId)
  ) {
    return;
  }
  const allowsEndpoints = () => {
    const constraints = readSentinelOperatingConstraints(
      path,
      runId,
    )
      ?.constraints;
    return [match.assetId, match.to].every((nodeId) =>
      nodeId === undefined ||
      sentinelOperatingConstraintsAllow(
        constraints,
        { kind: "review_evidence", nodeId },
        destination,
      )
    );
  };
  if (!allowsEndpoints()) return;
  // Keep the worker response's original record field order for the digest check.
  const retained = {
    discovery: {
      sourceCaseId: record.sourceCaseId,
      taskId: record.taskId,
      evidenceRevision: record.evidenceRevision,
      sourceDigest: record.sourceDigest,
      claim: record.claim,
      ...(record.graphFactSource &&
        { graphFactSource: record.graphFactSource }),
      id: record.id,
      status: record.status,
      version: record.version,
      proposedAt: record.proposedAt,
      updatedAt: record.updatedAt,
      mappedAssetId: match.assetId,
      ...(match.to && { mappedTo: match.to }),
    },
  };
  const text = JSON.stringify(retained);
  if (createHash("sha256").update(text).digest("hex") !== receipt.sha256) {
    return;
  }
  const evidence = entry.snapshot.nodes.find((node) =>
    node.id === record.claim.evidenceId && node.kind === "evidence"
  );
  if (!evidence) return;
  return {
    retained,
    text,
    allowsEndpoints,
    source: {
      caseId: record.sourceCaseId,
      evidenceRevision: record.evidenceRevision,
      snapshotDigest: record.sourceDigest,
      sourceAssignmentId: record.taskId,
      discoveryId: record.id,
      approvalVersion: record.version,
      ...(record.graphFactSource &&
        { graphFactSource: record.graphFactSource }),
      evidence: { id: evidence.id, kind: evidence.kind, label: evidence.label },
    },
  };
}

function citedDiscoveryEvidence(
  discovery: ReturnType<typeof reopenCitedDiscovery>,
  args: Record<string, unknown>,
) {
  const { source } = discovery ?? {};
  return source && args.assetId === undefined &&
      args.sourceCase === source.caseId &&
      args.snapshotDigest === source.snapshotDigest &&
      args.evidenceId === source.evidence.id
    ? source
    : undefined;
}

async function resolveCitedTraceSource(
  baseDir: string,
  path: string,
  read: Pick<
    SentinelReviewStep,
    "outcome" | "sourceSnapshots" | "aliasMapping"
  >,
  args: Record<string, unknown>,
) {
  const { sourceCase, snapshotDigest, assetId } = args;
  if (
    typeof sourceCase !== "string" || typeof snapshotDigest !== "string" ||
    read.outcome !== "returned"
  ) return;
  if (assetId === undefined) {
    const alias = await readCitedSentinelAliasSnapshot(
      baseDir,
      path,
      read.aliasMapping,
      sourceCase,
      snapshotDigest,
    );
    return alias &&
      { caseId: sourceCase, snapshotDigest, aliasProof: alias.proof };
  }
  if (
    typeof assetId !== "string" ||
    !read.sourceSnapshots?.some((citation) =>
      citation.caseId === sourceCase &&
      citation.snapshotDigest === snapshotDigest &&
      citation.assetId === assetId
    )
  ) return;
  const snapshot = await readArchivedSentinelSnapshot(
    baseDir,
    sourceCase,
    snapshotDigest,
    path,
  );
  const asset = snapshot.nodes.find((node) =>
    node.kind === "asset" && node.id === assetId
  );
  return asset && { caseId: sourceCase, snapshotDigest, asset };
}

function asWorkflowSummary(
  run: OperatorWorkflowRun | undefined,
): OperatorRunSummary | undefined {
  return run && {
    ref: { kind: "workflow", id: run.runId },
    label: run.planId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    classification: run.classification,
    details: { currentStep: run.currentStep ?? null, steps: run.steps },
  };
}

function workflowProvider(
  workflows: OperatorWorkflowRuns,
): OperatorRunProvider {
  function project(run: OperatorWorkflowRun) {
    return asWorkflowSummary(run)!;
  }
  return {
    list: () => [
      ...workflows.list().map(project),
      ...workflows.listPlans().map(({ id, classification, stepCount }) => ({
        ref: { kind: "workflow" as const, id },
        label: id,
        status: "configured",
        classification,
        details: { stepCount },
      })),
    ],
    inspect(ref) {
      return asWorkflowSummary(workflows.inspect(ref.id));
    },
    mutations: {
      start: (ref, context) =>
        asWorkflowSummary(
          workflows.start(ref.id, "INTERNAL", context?.requestId),
        ),
      pause: (ref) => asWorkflowSummary(workflows.pause(ref.id)),
      resume: (ref) => asWorkflowSummary(workflows.resume(ref.id)),
    },
  };
}

async function authorizeTracePayload(
  context: OperatorRunToolContext,
  authorizeSource: NonNullable<
    Parameters<
      typeof createOperatorRunToolExecutor
    >[0]["authorizeExecutionTracePayload"]
  >,
  payload: ExecutionTraceApprovedPayload,
  classification: ClassificationLevel,
): Promise<boolean> {
  const call = executionTracePayloadCall(payload);
  return await context.authorizeSavedCall(call) &&
    await authorizeSource(payload, classification) &&
    await context.authorizeSavedResponse(
      call.name,
      executionTracePayloadResponse(payload),
      classification,
    );
}

function matchesTracePayload(
  payload: ExecutionTraceApprovedPayload,
  term: string,
) {
  const matches = (value: string | number | null | undefined) =>
    value != null && String(value).toLowerCase().includes(term);
  if (matches(payload.repo) || matches(payload.repositoryId)) return true;
  if (payload.kind === "github_repository_status") {
    return matches(payload.visibility);
  }
  if (payload.kind === "github_branch_protection") {
    return matches(payload.protectedCount) ||
      matches(payload.unprotectedCount) ||
      payload.approvedBranches?.some(({ name }) => matches(name)) === true;
  }
  if (payload.kind === "github_release_status") {
    return payload.releases.some(({ id, published_at }) =>
      matches(id) || matches(published_at)
    );
  }
  if (payload.kind === "github_pull_status") {
    return matches(payload.number) || matches(payload.state);
  }
  if (payload.kind === "github_actions_run_status") {
    return matches(payload.id) || matches(payload.attempt) ||
      matches(payload.status) || matches(payload.conclusion);
  }
  return matches(payload.workflow) ||
    payload.runs.some(({ id, status, conclusion }) =>
      matches(id) || matches(status) || matches(conclusion)
    );
}

export async function readAuthorizedSentinelCaseEvidence(
  options: Pick<
    Parameters<typeof createOperatorRunToolExecutor>[0],
    "baseDir" | "readLiveWorkflow" | "authorizeExecutionTracePayload"
  >,
  caseId: string,
  path: string,
  revision: number,
  node: string,
  context: OperatorRunToolContext,
  isCurrent: () => boolean,
  signal?: AbortSignal,
) {
  if (signal?.aborted || !isCurrent()) return;
  if (node.startsWith("native-workflow-evidence:")) {
    const reader = options.readLiveWorkflow;
    const authorize = context.authorizeWorkflowDestination;
    if (!reader || !authorize) return;
    const citation = readNativeWorkflowGraphEvidence(path, revision, node);
    if (!citation) return;
    const { source } = citation;
    const saved = await reader({
      caseId,
      assetId: citation.assetId,
      evidenceRevision: source.revision,
      signal: signal ?? new AbortController().signal,
      resumeOnly: true,
      isCurrent,
      loadSaved: () => citation.saved,
      authorize: (destination) =>
        isCurrent() &&
          destination.caseId === caseId
          ? authorize(destination, source.revision, source.taskId)
          : Promise.resolve(false),
    });
    const payload = citation.candidate.payload;
    if (
      !isDeepStrictEqual(saved, citation.saved) || !isCurrent() ||
      !await context.authorizeSavedResponse(
        "sentinel_live_workflow_status",
        executionTracePayloadResponse(payload),
        "INTERNAL",
      ) || !isCurrent()
    ) return;
    return projectNativeWorkflowEvidence(citation);
  }
  const authorizeSource = options.authorizeExecutionTracePayload;
  if (!authorizeSource) return;
  const evidence = await readCaseExecutionEvidence(
    options.baseDir,
    path,
    revision,
    node,
  );
  if (
    evidence && isCurrent() &&
    await authorizeTracePayload(
      context,
      authorizeSource,
      evidence.payload,
      evidence.classification,
    ) &&
    isCurrent()
  ) return evidence;
}

async function authorizeSentinelWorkflowObservation(
  reader: Parameters<
    typeof createOperatorRunToolExecutor
  >[0]["readLiveWorkflow"],
  context: OperatorRunToolContext | undefined,
  scope: { caseId: string; path: string; runId: string },
  observation: AdaptiveWorkflowObservation,
  isCurrent: () => boolean,
): Promise<boolean> {
  const authorizeDestination = context?.authorizeWorkflowDestination;
  if (!reader || !context || !authorizeDestination) return false;
  const { caseId, path, runId } = scope;
  const revision = observation.evidenceRevision;
  const allowed = () => {
    if (!isCurrent()) return false;
    const state = readSentinelAssessmentRevision(path, revision);
    const snapshot = state?.result.sharedGraph.snapshot;
    return !!snapshot && sentinelOperatingConstraintsAllow(
      readSentinelOperatingConstraints(path, runId)?.constraints,
      { kind: "review_evidence", nodeId: observation.targetId },
      snapshot,
    );
  };
  if (!allowed()) return false;
  const saved = await reader({
    caseId,
    assetId: observation.targetId,
    evidenceRevision: revision,
    signal: new AbortController().signal,
    resumeOnly: true,
    isCurrent: allowed,
    loadSaved: () => observation.receipt,
    authorize: (destination) =>
      destination.caseId === caseId && allowed()
        ? authorizeDestination(destination, revision, observation.taskId)
        : Promise.resolve(false),
  });
  return isDeepStrictEqual(saved, observation.receipt) && allowed() &&
    await context.authorizeSavedResponse(
      "sentinel_live_workflow_status",
      JSON.stringify({
        targetId: observation.targetId,
        ...observation.receipt,
      }),
      "INTERNAL",
    ) && allowed();
}

export function createOperatorRunToolExecutor(options: {
  readonly baseDir: string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly workflows?: OperatorWorkflowRuns;
  readonly resumeScheduledExecution?: (id: string) => Promise<boolean>;
  readonly readLiveWorkflow?: ReturnType<
    typeof createSentinelLiveWorkflowReader
  >;
  readonly authorizeExecutionTracePayload?: (
    payload: ExecutionTraceApprovedPayload,
    classification: ClassificationLevel,
  ) => Promise<boolean>;

  readonly webContainmentConfigured?: boolean;
  readonly sentinelModelAccess?: boolean;
  readonly sentinelGatewayWorkerLimit?: number;
  readonly sentinelAdmission?: {
    readonly configuredLimit: number;
    readonly onChanged?: () => void;
  };
  readonly liveModelRoutes?: ReturnType<typeof liveProviderRouteSettings>;
  readonly profiles?: (
    ceiling: ClassificationLevel,
  ) => readonly EffectiveModelProfile[];
  readonly sentinelProfiles?: () => readonly SelectedModelProfile[];
}): OperatorRunToolExecutor {
  const providers = {
    sentinel: createOperatorSentinelRuns(
      options.baseDir,
      options.webContainmentConfigured,
    ),
    ...(options.workflows && { workflow: workflowProvider(options.workflows) }),
  };
  const digestPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const unavailable = "Error: This operation or exact run is unavailable.";

  const recoveryPath = join(options.baseDir, "agent-recovery.db");
  const backgroundTracePath = join(options.baseDir, "execution-traces.db");
  const recoveryKey = ({ scope }: ExecutionTraceRun) =>
    assignmentRecoveryKey(scope.sessionId, scope.runId);
  function inspectBackgroundRecovery(run: ExecutionTraceRun) {
    if (run.status !== "running" || run.operatorCancelled) return;
    try {
      Deno.lstatSync(recoveryPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const store = new AgentRecoveryStore(recoveryPath);
    try {
      return store.inspectStatus(recoveryKey(run));
    } finally {
      store.close();
    }
  }

  function exactTeamTraceAdmission(
    run: ExecutionTraceRun,
    owner: string | null,
    [teamId, member, delivery]: readonly string[],
  ) {
    const team = parseTeamDeliveryTraceSource(run.scope.sourceId);
    return team && team.sender === owner && team.teamId === teamId &&
        team.delivery === delivery && run.scope.sessionId === member
      ? teamAdmissionArchive(options.baseDir, run.scope)
      : undefined;
  }

  const readAuthorizedCaseEvidence = readAuthorizedSentinelCaseEvidence.bind(
    null,
    options,
  );

  const execute: OperatorRunToolExecutor = async (args, context) => {
    const authorizeCaseRead = context?.authorizeSentinelCaseRead;
    if (authorizeCaseRead) {
      const { action, id, kind, revision } = args;
      const selectedControl =
        context.authorizeSelectedSentinelCase !== undefined &&
        sentinelOperatorCaseControlActions.some((allowed) =>
          allowed === action
        );
      if (
        kind !== "sentinel" ||
        !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
        Object.keys(args).some((key) =>
          !sentinelOperatorCaseReadParameters.some((allowed) =>
            allowed === key
          ) &&
          (!selectedControl ||
            !sentinelOperatorCaseControlParameters.some((allowed) =>
              allowed === key
            ))
        ) ||
        (!selectedControl &&
          !sentinelOperatorCaseReadActions.some((allowed) =>
            allowed === action
          )) ||
        typeof id !== "string" || typeof revision !== "number" ||
        !Number.isSafeInteger(revision) || revision < 1 ||
        !authorizeCaseRead(id, revision)
      ) return unavailable;
    }
    if (
      Object.keys(args).some((key) =>
        !Object.hasOwn(operatorRunTool.parameters, key)
      )
    ) {
      return "Error: Supply only defined operator run fields.";
    }
    const backgroundOwner = canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC")
      ? context?.authenticatedOwnerSessionId ?? null
      : null;
    function canReadBackgroundTrace(
      { scope, classification }: ExecutionTraceRun,
    ) {
      return executionTraceSourceVisible(
        scope.role,
        scope.sourceId,
        backgroundOwner,
      ) &&
        (!isOwnerBoundExecutionTraceSource(scope.role, scope.sourceId) ||
          canFlowTo(classification, context?.ceiling ?? "PUBLIC"));
    }
    const action = args.action;
    if (args.restoreStatus !== undefined && action !== "archive_catalog") {
      return unavailable;
    }
    if (
      (args.assetText !== undefined || args.organizationText !== undefined ||
        args.includeMembers !== undefined ||
        args.includeCoverageTotals !== undefined) &&
      action !== "inventory"
    ) {
      return unavailable;
    }
    if (
      args.assetIds !== undefined && action !== "inventory" && action !== "hint"
    ) {
      return unavailable;
    }
    if (
      (args.includeFindingTraffic !== undefined ||
        args.trafficOffset !== undefined) && action !== "node"
    ) return unavailable;
    if (
      args.includeProgress !== undefined &&
      (action !== "list" || args.includeProgress !== true ||
        Object.keys(args).some((field) =>
          !["action", "kind", "includeProgress"].includes(field)
        ) ||
        !context?.authenticatedOwnerSessionId ||
        !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC"))
    ) return unavailable;
    if (
      args.includeFrontier !== undefined &&
      (action !== "graph_overview" || args.includeFrontier !== true ||
        !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC"))
    ) return unavailable;
    if (
      args.latestResult !== undefined &&
      (action !== "worker_trace_result" || args.latestResult !== true ||
        args.stepIndices !== undefined || args.workflowRunNumber !== undefined)
    ) return unavailable;
    if (
      (args.trafficReference !== undefined ||
        args.trafficReferences !== undefined) && action !== "hint"
    ) {
      return unavailable;
    }
    const controllingTeam = args.kind === "team_delivery" &&
      (action === "pause" || action === "resume" || action === "cancel" ||
        action === "steer");
    const teamControl = controllingTeam && typeof args.id === "string"
      ? args.id.toLowerCase().split(":")
      : [];
    if (
      controllingTeam && (!backgroundOwner || teamControl.length !== 3 ||
        !teamControl.every((part) => digestPattern.test(part)))
    ) return unavailable;
    const [, controlMember, controlDelivery] = teamControl;
    const teamControlRef = controllingTeam && backgroundOwner
      ? {
        kind: "delegated" as const,
        id: await teamDeliveryExecutionId(
          backgroundOwner as SessionId,
          controlMember as SessionId,
          controlDelivery,
        ),
      }
      : undefined;
    const publicTeamControlRef = teamControlRef && {
      kind: "team_delivery",
      id: teamControl.join(":"),
    };
    const teamControlAdmission = (run: ExecutionTraceRun) =>
      teamControlRef &&
      exactTeamTraceAdmission(run, backgroundOwner, teamControl);
    const backgroundRole = teamControlRef?.kind ??
      (args.kind === "delegated" || args.kind === "scheduled"
        ? args.kind
        : undefined);
    const inspectTeamDelivery = action === "inspect" &&
      args.kind === "team_delivery";
    if (
      inspectTeamDelivery || (action === "approval_history" &&
        (args.kind === "owner_chat" || args.kind === "team_delivery" ||
          backgroundRole))
    ) {
      const { id, offset = 0, limit = 10 } = args;
      const ownerRun = args.kind === "owner_chat";
      const teamRun = args.kind === "team_delivery";
      const teamTuple = teamRun && typeof id === "string"
        ? id.toLowerCase().split(":")
        : [];
      const [teamId, member, delivery] = teamTuple;
      const session = context?.ownerRecoverySessionId;
      if (
        !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC") ||
        typeof id !== "string" ||
        (ownerRun
          ? !session || !digestPattern.test(id)
          : teamRun
          ? !backgroundOwner || teamTuple.length !== 3 ||
            !teamTuple.every((part) => digestPattern.test(part))
          : !backgroundReference(backgroundRole, id, undefined)) ||
        typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 10 ||
        Object.keys(args).some((key) =>
          ![
            "action",
            "kind",
            "id",
            ...(inspectTeamDelivery ? [] : ["offset", "limit"]),
          ].includes(key)
        )
      ) return unavailable;
      const publicId = ownerRun || teamRun ? id.toLowerCase() : id;
      const runId = ownerRun
        ? assignmentRecoveryKey(session!, publicId)
        : teamRun
        ? await teamDeliveryExecutionId(
          backgroundOwner! as SessionId,
          member as SessionId,
          delivery,
        )
        : publicId;
      const role = ownerRun
        ? "owner_chat"
        : teamRun
        ? "delegated"
        : backgroundRole!;
      if (inspectTeamDelivery) {
        try {
          Deno.lstatSync(backgroundTracePath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return unavailable;
          throw error;
        }
      }
      const journal = openExecutionTraces(backgroundTracePath);
      try {
        const run = journal.readRun(role, runId, "INTERNAL");
        const teamSource = teamRun &&
          parseTeamDeliveryTraceSource(run?.scope.sourceId);
        if (
          !run ||
          (teamRun &&
            (!teamSource || teamSource.sender !== backgroundOwner ||
              teamSource.teamId !== teamId ||
              teamSource.delivery !== delivery ||
              run.scope.sessionId !== member)) ||
          (ownerRun
            ? run.scope.sessionId !== session || run.scope.sourceId !== publicId
            : !canReadBackgroundTrace(run))
        ) return unavailable;
        if (inspectTeamDelivery) {
          const admission = teamAdmissionArchive(options.baseDir, run.scope);
          if (!await admission?.read()) return unavailable;
          const current = journal.readRun(role, runId, "INTERNAL");
          if (!current || !isDeepStrictEqual(current.scope, run.scope)) {
            return unavailable;
          }
          const recovery = inspectBackgroundRecovery(current);
          return safeProjection({
            run: {
              ...projectBackgroundRun(backgroundRunSummary(current, recovery)),
              ref: { kind: "team_delivery", id: publicId },
            },
            ...(recovery && { recovery }),
          });
        }
        const history = journal.readToolDecisions(run.scope, "INTERNAL");
        if (!history) return unavailable;
        const decisions = history.slice(offset, offset + limit).map((
          entry,
        ) => ({
          ...entry,
          runId: teamRun ? runId : publicId,
        }));
        return safeProjection({
          run: { kind: teamRun ? "team_delivery" : role, id: publicId },
          decisions,
          nextOffset: offset + decisions.length < history.length
            ? offset + decisions.length
            : null,
        });
      } finally {
        journal.close();
      }
    }
    if (action === "list" && args.kind === "owner_chat") {
      const { limit = 15, cursor } = args;
      const owner = context?.ownerRecoverySessionId;
      if (
        !owner || owner !== context?.authenticatedOwnerSessionId ||
        !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 15 ||
        (cursor !== undefined && typeof cursor !== "string") ||
        Object.keys(args).some((key) =>
          !["action", "kind", "limit", "cursor"].includes(key)
        )
      ) return unavailable;
      try {
        Deno.lstatSync(recoveryPath);
        Deno.lstatSync(backgroundTracePath);
        const recovery = new AgentRecoveryStore(recoveryPath);
        try {
          const traces = openExecutionTraces(backgroundTracePath);
          try {
            const page = traces.listRuns({
              role: "owner_chat",
              ceiling: "INTERNAL",
              ownerSessionId: owner,
              limit,
              cursor,
            });
            if (!page) return unavailable;
            const runs = page.runs.flatMap(({ scope }) => {
              const id = scope.sourceId;
              if (
                !id || !digestPattern.test(id) || scope.sessionId !== owner ||
                scope.runId !== assignmentRecoveryKey(owner, id)
              ) return [];
              const state = recovery.inspectStatus(scope.runId);
              return state ? [{ kind: "owner_chat", id, ...state }] : [];
            });
            return safeProjection({ runs, nextCursor: page.nextCursor });
          } finally {
            traces.close();
          }
        } finally {
          recovery.close();
        }
      } catch (error) {
        return error instanceof Deno.errors.NotFound && cursor === undefined
          ? safeProjection({ runs: [], nextCursor: null })
          : unavailable;
      }
    }
    const listingTeam = args.kind === "team_delivery" && action === "list";
    if ((backgroundRole || listingTeam) && action === "list") {
      const { limit = 15, cursor } = args;
      if (
        Object.keys(args).some((key) =>
          !["action", "kind", "limit", "cursor"].includes(key)
        ) ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 15 ||
        (cursor !== undefined && typeof cursor !== "string") ||
        (listingTeam && !backgroundOwner) ||
        !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL")
      ) return unavailable;
      try {
        const journal = openExecutionTraces(
          join(options.baseDir, "execution-traces.db"),
        );
        try {
          const page = journal.listRuns({
            role: listingTeam ? "delegated" : backgroundRole,
            ceiling: "INTERNAL",
            limit,
            cursor,
            backgroundOwner,
            teamDeliveries: listingTeam,
          });
          if (!page) return unavailable;
          const runs = [];
          for (const run of page.runs) {
            const summary = projectBackgroundRun(
              backgroundRunSummary(run, inspectBackgroundRecovery(run)),
            );
            if (!listingTeam) {
              runs.push(summary);
              continue;
            }
            const source = parseTeamDeliveryTraceSource(run.scope.sourceId);
            if (!source) continue;
            const selector = [
              source.teamId,
              run.scope.sessionId,
              source.delivery,
            ];
            if (
              !await exactTeamTraceAdmission(run, backgroundOwner, selector)
                ?.read()
            ) {
              continue;
            }
            runs.push({
              ...summary,
              ref: { kind: "team_delivery", id: selector.join(":") },
            });
          }
          return safeProjection({ runs, nextCursor: page.nextCursor });
        } finally {
          journal.close();
        }
      } catch {
        return unavailable;
      }
    }
    if (action === "execution_traces" || action === "execution_trace_payload") {
      const reopen = action === "execution_trace_payload";
      const { traceRole, id, ordinal, cursor, query } = args;
      const teamTrace = traceRole === "team_delivery";
      const role = teamTrace ? "delegated" : traceRole;
      const ownerTrace = role === "owner_chat";
      const teamTuple = teamTrace && typeof id === "string"
        ? id.toLowerCase().split(":")
        : [];
      const owner = context?.ownerRecoverySessionId;
      const searchPayload = reopen && query !== undefined;
      const limit = args.limit === undefined
        ? (searchPayload ? 5 : 10)
        : args.limit;
      if (
        Object.keys(args).some((key) =>
          !["action", "traceRole", "id", "ordinal", "cursor", "limit", "query"]
            .includes(
              key,
            )
        ) ||
        (reopen &&
          ((!searchPayload && (id === undefined || ordinal === undefined)) ||
            !context || !options.authorizeExecutionTracePayload)) ||
        (query !== undefined &&
          (ordinal !== undefined || typeof query !== "string")) ||
        (searchPayload && (typeof query !== "string" ||
          !/^[A-Za-z0-9_.:/-]{1,128}$/.test(query))) ||
        (role !== undefined && role !== "delegated" && role !== "scheduled" &&
          !ownerTrace) ||
        (teamTrace &&
          (!backgroundOwner || teamTuple.length !== 3 ||
            !teamTuple.every((part) => digestPattern.test(part)))) ||
        (ownerTrace &&
          (!owner ||
            (id !== undefined &&
              (typeof id !== "string" || !digestPattern.test(id))) ||
            !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC"))) ||
        (id !== undefined &&
          (typeof id !== "string" || role === undefined || id.length > 255)) ||
        (ordinal !== undefined && (id === undefined || cursor !== undefined ||
          args.limit !== undefined || typeof ordinal !== "number" ||
          !Number.isSafeInteger(ordinal) || ordinal < 1)) ||
        (cursor !== undefined && typeof cursor !== "string") ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > (searchPayload ? 5 : 15)
      ) return unavailable;
      try {
        const journal = openExecutionTraces(
          join(options.baseDir, "execution-traces.db"),
        );
        try {
          const requestedId = typeof id === "string"
            ? ownerTrace || teamTrace ? id.toLowerCase() : id
            : undefined;
          const runKey = teamTrace
            ? await teamDeliveryExecutionId(
              backgroundOwner! as SessionId,
              teamTuple[1] as SessionId,
              teamTuple[2],
            )
            : ownerTrace && requestedId !== undefined
            ? assignmentRecoveryKey(owner!, requestedId)
            : requestedId;
          const run = role && runKey
            ? journal.readRun(role, runKey, "INTERNAL")
            : undefined;
          if (
            (run && !canReadBackgroundTrace(run)) ||
            (ownerTrace && requestedId !== undefined &&
              (!run || run.scope.sessionId !== owner ||
                run.scope.sourceId !== requestedId))
          ) return unavailable;
          const admission = teamTrace && run &&
            exactTeamTraceAdmission(run, backgroundOwner, teamTuple);
          const reviewedAdmission = admission && await admission.read();
          if (teamTrace && !reviewedAdmission) return unavailable;
          const teamCurrent = async () => {
            if (!teamTrace) return true;
            if (
              !admission || !runKey ||
              !isDeepStrictEqual(await admission.read(), reviewedAdmission)
            ) return false;
            const current = journal.readRun("delegated", runKey, "INTERNAL");
            return !!current && canReadBackgroundTrace(current) &&
              isDeepStrictEqual(current.scope, run?.scope);
          };
          const projectMatch = <
            T extends { role: ExecutionTraceRole; runId: string },
          >(match: T): Array<
            Omit<T, "role"> & {
              role: ExecutionTraceRole | "team_delivery";
            }
          > => {
            const source = journal.readRun(match.role, match.runId, "INTERNAL");
            if (!source || !canReadBackgroundTrace(source)) return [];
            if (teamTrace) {
              return source.scope.runId === runKey
                ? [{ ...match, role: "team_delivery", runId: requestedId! }]
                : [];
            }
            if (!ownerTrace) return [match];
            if (source.scope.sessionId !== owner || !source.scope.sourceId) {
              return [];
            }
            return [{ ...match, runId: source.scope.sourceId }];
          };
          if (!reopen && typeof query === "string") {
            const page = journal.search({
              query,
              role,
              runId: runKey,
              cursor,
              limit,
              ceiling: "INTERNAL",
              ...(ownerTrace ? { ownerSessionId: owner } : { backgroundOwner }),
            });
            return page
              ? safeProjection({
                page: {
                  ...page,
                  matches: page.matches.flatMap(projectMatch),
                },
              })
              : unavailable;
          }
          if (
            searchPayload && typeof query === "string" && context &&
            options.authorizeExecutionTracePayload
          ) {
            // Page over visible metadata so continuation is independent of
            // whether an approved result exists or is currently authorized.
            const page = journal.search({
              query,
              approvedResults: true,
              role,
              runId: runKey,
              cursor,
              limit,
              ceiling: "INTERNAL",
              ...(ownerTrace ? { ownerSessionId: owner } : { backgroundOwner }),
            });
            if (!page) return unavailable;
            const matches = [];
            for (const candidate of page.matches) {
              const source = journal.readRun(
                candidate.role,
                candidate.runId,
                "INTERNAL",
              );
              if (!source || !canReadBackgroundTrace(source)) continue;
              const payload = journal.readApprovedPayload(
                source.scope,
                candidate.ordinal,
                "INTERNAL",
              );
              if (
                payload &&
                await authorizeTracePayload(
                  context,
                  options.authorizeExecutionTracePayload,
                  payload,
                  candidate.classification,
                ) &&
                matchesTracePayload(payload, query.toLowerCase())
              ) {
                matches.push(candidate);
              }
            }
            if (
              !await teamCurrent() ||
              (role && runKey && !journal.readRun(role, runKey, "INTERNAL"))
            ) {
              return unavailable;
            }
            return safeProjection({
              page: {
                matches: matches.flatMap(projectMatch),
                nextCursor: page.nextCursor,
              },
            });
          }
          if (id === undefined) {
            const page = journal.listRuns({
              role,
              ceiling: "INTERNAL",
              limit,
              cursor,
              ...(ownerTrace ? { ownerSessionId: owner } : { backgroundOwner }),
            });
            return page
              ? safeProjection({
                page: ownerTrace
                  ? {
                    ...page,
                    runs: page.runs.map((entry) => ({
                      ...entry,
                      scope: { ...entry.scope, runId: entry.scope.sourceId },
                    })),
                  }
                  : page,
              })
              : unavailable;
          }
          if (!role || !runKey || !run) return unavailable;
          const outputRun = teamTrace
            ? { ...run, scope: { role: "team_delivery", runId: requestedId } }
            : ownerTrace
            ? { ...run, scope: { ...run.scope, runId: requestedId } }
            : run;
          const outputStep = <T extends { scope: typeof run.scope }>(step: T) =>
            ownerTrace || teamTrace
              ? { ...step, scope: outputRun.scope }
              : step;
          if (ordinal !== undefined) {
            const step = journal.inspect(run.scope, ordinal, "INTERNAL");
            if (!step) return unavailable;
            if (!reopen) {
              return safeProjection({ run: outputRun, step: outputStep(step) });
            }
            const payload = journal.readApprovedPayload(
              run.scope,
              ordinal,
              "INTERNAL",
            );
            if (
              !payload || !context || !options.authorizeExecutionTracePayload
            ) return unavailable;
            if (
              !await authorizeTracePayload(
                context,
                options.authorizeExecutionTracePayload,
                payload,
                step.classification,
              ) || !await teamCurrent() ||
              !journal.readRun(role, runKey, "INTERNAL")
            ) return unavailable;
            return safeProjection({
              run: outputRun,
              step: outputStep(step),
              payload,
            });
          }
          const page = journal.list(run.scope, {
            ceiling: "INTERNAL",
            limit,
            cursor,
          });
          const controls = page &&
            journal.readControlHistory(
              role,
              runKey,
              context?.ceiling ?? "INTERNAL",
            );
          return page
            ? safeProjection({
              run: outputRun,
              ...(controls && { controls }),
              page: ownerTrace || teamTrace
                ? { ...page, steps: page.steps.map(outputStep) }
                : page,
            })
            : unavailable;
        } finally {
          journal.close();
        }
      } catch {
        return unavailable;
      }
    }
    if (
      action === "assessment_concurrency" ||
      action === "set_assessment_concurrency" ||
      action === "reset_assessment_concurrency"
    ) {
      const admission = options.sentinelAdmission;
      const reading = action === "assessment_concurrency";
      const setting = action === "set_assessment_concurrency";
      const { limit, requestId, expectedVersion } = args;
      if (
        !admission || !context?.authenticatedOwnerSessionId ||
        !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
        (setting ? !validSentinelAdmissionLimit(limit) : limit !== undefined) ||
        Object.keys(args).some((key) =>
          ![
            "action",
            ...(reading ? [] : ["requestId", "expectedVersion"]),
            ...(setting ? ["limit"] : []),
          ].includes(key)
        )
      ) return unavailable;
      try {
        const before = readSentinelAdmissionSettings(
          options.baseDir,
          admission.configuredLimit,
        );
        if (reading) return safeProjection(before);
        if (
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion > before.version
        ) return unavailable;
        const override = setting ? limit as number : null;
        const request = requestId.toLowerCase();
        const write = () =>
          replaceSentinelAdmissionLimit(options.baseDir, {
            requestId: request,
            expectedVersion,
            override,
          });
        if (expectedVersion < before.version) {
          const replay = write();
          return replay ? safeProjection({ edit: replay }) : unavailable;
        }
        if (before.override === override) return unavailable;
        if (
          !await options.confirm(
            `Approve the exact named Sentinel admission limit?
${
              JSON.stringify({
                requestId: request,
                expectedVersion,
                previous: before.effectiveLimit,
                next: override ?? admission.configuredLimit,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const edit = write();
        if (!edit) return unavailable;
        admission.onChanged?.();
        return safeProjection({ edit });
      } catch {
        return unavailable;
      }
    }
    if (
      action === "live_model_route" || action === "set_live_model_route" ||
      action === "reset_live_model_route"
    ) {
      const routes = options.liveModelRoutes;
      const {
        modelRouteClassification,
        modelProfile,
        modelRouteModel,
        expectedVersion,
        requestId,
      } = args;
      const classification = typeof modelRouteClassification === "string"
        ? parseClassification(modelRouteClassification)
        : undefined;
      const reading = action === "live_model_route";
      const setting = action === "set_live_model_route";
      if (
        !routes || !context?.authenticatedOwnerSessionId ||
        !classification?.ok ||
        !canFlowTo(
          maxClassification("INTERNAL", classification.value),
          context.ceiling ?? "PUBLIC",
        ) ||
        Object.keys(args).some((key) =>
          ![
            "action",
            "modelRouteClassification",
            ...(reading ? [] : ["requestId", "expectedVersion"]),
            ...(setting ? ["modelProfile", "modelRouteModel"] : []),
          ].includes(key)
        )
      ) return unavailable;
      const level = classification.value;
      const label = maxClassification(level, "INTERNAL");
      try {
        const current = routes.read(level);
        if (!current) return unavailable;
        if (reading) {
          return safeProjection({ ...current, classification: level }, label);
        }
        if (
          !context.authorizeOwnerRunCall ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
          expectedVersion > current.version ||
          (setting && (typeof modelProfile !== "string" ||
            (modelRouteModel !== undefined &&
              typeof modelRouteModel !== "string")))
        ) return unavailable;
        const override = setting
          ? {
            provider: modelProfile as string,
            ...(typeof modelRouteModel === "string" &&
              { model: modelRouteModel }),
          }
          : null;
        const effective = override ?? current.baseline;
        if (!routes.eligible(effective, level)) return unavailable;
        const edit = {
          classification: level,
          requestId: requestId.toLowerCase(),
          version: expectedVersion + 1,
          override,
          effective,
          previous: current.effective,
        };
        if (expectedVersion === current.version) {
          if (
            !await options.confirm(`Approve the exact live model route?
${
              JSON.stringify({
                classification: level,
                previous: current.effective,
                next: effective,
                reset: !override,
                expectedVersion,
                requestId: edit.requestId,
              })
            }`)
          ) return "Error: The operator declined the run action.";
        }
        if (!await context.authorizeOwnerRunCall(args)) {
          return unavailable;
        }
        const saved = routes.commit(edit);
        return saved ? safeProjection({ edit: saved }, label) : unavailable;
      } catch {
        return unavailable;
      }
    }
    if (action === "profiles") {
      if (Object.keys(args).some((key) => key !== "action")) return unavailable;
      const ceiling = context?.ceiling ?? "INTERNAL";
      const profiles =
        options.profiles?.(ceiling).filter(({ classification }) =>
          canFlowTo(classification, ceiling)
        ).slice(0, 10) ?? [];
      const classification = profiles.reduce<ClassificationLevel>(
        (highest, profile) =>
          maxClassification(highest, profile.classification),
        "INTERNAL",
      );
      const sentinelProfiles = canFlowTo("INTERNAL", ceiling)
        ? options.sentinelProfiles?.().slice(0, 10)
        : undefined;
      return safeProjection({
        profiles,
        ...(sentinelProfiles?.length && { sentinelProfiles }),
      }, classification);
    }
    const linkPath = join(options.baseDir, "operator-run-links.db");
    const linkScope = "workspace-operator";
    const operatorId = "owner";
    const links = openOperatorRunLinkStore(linkPath);
    try {
      const readBackgroundTrace = (role: ExecutionTraceRole, id: string) => {
        if (!canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL")) return;
        const journal = openExecutionTraces(backgroundTracePath);
        try {
          const run = journal.readRun(role, id, "INTERNAL");
          if (run && canReadBackgroundTrace(run)) return run;
        } finally {
          journal.close();
        }
      };
      const backgroundProvider = (role: ExecutionTraceRole) => ({
        list: () => [],
        inspect(ref: OperatorRunRef) {
          const run = readBackgroundTrace(role, ref.id);
          return run &&
            backgroundRunSummary(run, inspectBackgroundRecovery(run));
        },
      });
      const runProviders = {
        ...providers,
        delegated: backgroundProvider("delegated"),
        scheduled: backgroundProvider("scheduled"),
      };
      const controller = new OperatorRunController({
        scope: linkScope,
        operatorId,
        authorize: (_action, ref) => Object.hasOwn(runProviders, ref.kind),
        providers: runProviders,
        links,
        approveLink: async ({ left, right }) =>
          await options.confirm(
            `Link these exact operator runs?\n${
              JSON.stringify({ left, right })
            }`,
          ) && await context?.authorizeOwnerRunCall?.(args) === true,
      });
      if (action === "pause_runs" || action === "resume_runs") {
        const { requestId, runTargets } = args;
        const ceiling = context?.ceiling ?? "INTERNAL";
        const authorize = context?.authorizeOwnerRunCall;
        const controlAction = action === "pause_runs" ? "pause" : "resume";
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", ceiling) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          !Array.isArray(runTargets) || !runTargets.length ||
          runTargets.length > 8 ||
          Object.keys(args).some((key) =>
            !["action", "requestId", "runTargets"].includes(key)
          )
        ) return unavailable;
        const seen = new Set<string>();
        const targets: OperatorRunBatchTarget[] = [];
        for (const item of runTargets) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return unavailable;
          }
          const ref = reference(item.kind, item.id, item.revision);
          if (
            !ref || (ref.kind !== "sentinel" && ref.kind !== "workflow") ||
            seen.has(`${ref.kind}:${ref.id}`) ||
            (ref.kind === "sentinel"
              ? !isSentinelCaseId(ref.id) || ref.revision === undefined ||
                typeof item.runId !== "string" ||
                !digestPattern.test(item.runId)
              : item.runId !== undefined) ||
            Object.keys(item).some((key) =>
              !["kind", "id", "revision", "runId"].includes(key)
            )
          ) return unavailable;
          seen.add(`${ref.kind}:${ref.id}`);
          targets.push({
            ref,
            ...(typeof item.runId === "string" &&
              { runId: item.runId.toLowerCase() }),
          });
        }
        const controlled = await applyOperatorRunBatch({
          request: {
            scope: linkScope,
            operatorId,
            action: controlAction,
            requestId: requestId.toLowerCase(),
            targets,
          },
          controller,
          journal: links,
          ceiling,
          confirm: options.confirm,
          authorize: async (target) =>
            (!target ||
              await authorize({ action: controlAction, ...target.ref })) &&
            await authorize(args),
        });
        if (!controlled) return unavailable;
        if (controlled.declined) {
          return "Error: The operator declined the run action.";
        }
        return safeProjection(controlled);
      }
      const canReadRunCategories = !!context?.authenticatedOwnerSessionId &&
        canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC");
      if (action === "run_categories") {
        const { offset = 0, limit = 20 } = args;
        if (
          !canReadRunCategories ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 20 ||
          Object.keys(args).some((key) =>
            !["action", "offset", "limit"].includes(key)
          )
        ) return unavailable;
        const categories = links.categories.list(offset, limit + 1);
        return safeProjection({
          categories: categories.slice(0, limit),
          nextOffset: categories.length > limit ? offset + limit : null,
        });
      }
      if (
        action === "create_run_category" || action === "rename_run_category" ||
        action === "delete_run_category" || action === "categorize_runs" ||
        action === "clear_run_categories"
      ) {
        const { categoryId, title, requestId, expectedVersion, runTargets } =
          args;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !canReadRunCategories ||
          !authorize ||
          !canFlowTo(context?.inputClassification ?? "PUBLIC", "INTERNAL") ||
          typeof requestId !== "string" || !digestPattern.test(requestId)
        ) return unavailable;
        const edit = action === "create_run_category" ||
          action === "rename_run_category";
        const assignment = action === "categorize_runs" ||
          action === "clear_run_categories";
        const select = action !== "create_run_category" &&
          action !== "clear_run_categories";
        if (
          (edit
            ? typeof title !== "string" || !title.trim() ||
              Array.from(title.trim()).length > 80 ||
              /[\p{Cc}\p{Cf}]/u.test(title) ||
              redactCredentialText(title) !== title
            : title !== undefined) ||
          (select
            ? typeof categoryId !== "string" ||
              !digestPattern.test(categoryId) ||
              typeof expectedVersion !== "number" ||
              !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
            : categoryId !== undefined || expectedVersion !== undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "requestId",
              ...(edit ? ["title"] : []),
              ...(select ? ["categoryId", "expectedVersion"] : []),
              ...(assignment ? ["runTargets"] : []),
            ].includes(key)
          )
        ) return unavailable;
        const runsToCategorize = assignment
          ? exactCategoryTargets(runTargets, digestPattern)
          : undefined;
        if (assignment && !runsToCategorize) return unavailable;
        const category = typeof categoryId === "string"
          ? {
            categoryId: categoryId.toLowerCase(),
            version: expectedVersion as number,
          }
          : undefined;
        const name = typeof title === "string" ? title.trim() : "";
        const change: OperatorRunCategoryChange = runsToCategorize
          ? { kind: "assign", ...category, runs: runsToCategorize }
          : action === "create_run_category"
          ? { kind: "create", title: name }
          : action === "rename_run_category" && category
          ? { kind: "rename", ...category, title: name }
          : { kind: "delete", ...category! };
        const visibleTargets = async () => {
          for (const item of runsToCategorize ?? []) {
            const { runId, ...ref } = item;
            const run = await controller.inspect(ref);
            if (
              !run ||
              !canFlowTo(
                run.classification ?? "INTERNAL",
                context?.ceiling ?? "PUBLIC",
              ) ||
              (ref.kind === "sentinel" &&
                (run.status === "saved" || run.details?.runId !== runId))
            ) return false;
          }
          return true;
        };
        if (!await visibleTargets()) return unavailable;
        const id = requestId.toLowerCase();
        const before = links.categories.review(id, change);
        if (before?.receipt) return safeProjection({ receipt: before.receipt });
        if (!before?.preview) return unavailable;
        if (
          !await options.confirm(
            `Apply this exact run category change?\n${
              JSON.stringify({ requestId: id, ...before.preview })
            }`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await visibleTargets() || !await authorize(args)) {
          return unavailable;
        }
        const after = links.categories.review(id, change, before.preview);
        return after?.receipt
          ? safeProjection({ receipt: after.receipt })
          : unavailable;
      }
      if (action === "list") {
        const filter = kind(args.kind);
        if (args.kind !== undefined && !filter) return unavailable;
        const listed = (await controller.list(filter)).slice(0, 20);
        if (!canReadRunCategories) return safeProjection({ runs: listed });
        const origins = (await controller.listLinks()).filter(({ origin }) =>
          origin === "spawn"
        );
        const ceiling = context?.ceiling ?? "PUBLIC";
        const runs = await Promise.all(listed.map(async (run) => {
          if (!canFlowTo(run.classification ?? "PUBLIC", ceiling)) return run;
          const { kind, id, revision } = run.ref;
          const discovery = kind === "sentinel"
            ? providers.sentinel.discovery(
              run.ref,
              args.includeProgress === true,
            )
            : undefined;
          const runId = kind === "workflow" && digestPattern.test(id)
            ? id
            : discovery?.runId;
          if (!runId || (kind !== "sentinel" && kind !== "workflow")) {
            return run;
          }
          const category = links.categories.forRun({
            kind,
            id,
            runId,
            revision,
          });
          const parentRef = discovery?.spawnParent;
          const sameRef = (ref: OperatorRunRef) =>
            isDeepStrictEqual(ref, parentRef);
          const sameChild = (ref: OperatorRunRef) =>
            ref.kind === kind && ref.id === id && ref.revision !== undefined &&
            readSentinelRunIdForRevision(
                resolveSentinelCasePath(options.baseDir, id),
                ref.revision,
              ) === runId;
          // Link records are canonicalized, so only the child's admission
          // metadata supplies direction. The durable visible link supplies scope.
          const linked = parentRef &&
            origins.some(({ left, right }) =>
              (sameRef(left) && sameChild(right)) ||
              (sameRef(right) && sameChild(left))
            );
          const parent = linked && await controller.inspect(parentRef);
          const visibleParent = parent &&
              canFlowTo(
                parent.classification ?? "PUBLIC",
                ceiling,
              )
            ? parent.ref
            : undefined;
          const startedAt = discovery?.startedAt ?? run.startedAt;
          const completedAt = discovery?.completedAt ?? run.completedAt;
          const workflowSeconds = kind === "workflow" && startedAt &&
              (completedAt || run.status === "running")
            ? Math.floor(
              ((completedAt ? Date.parse(completedAt) : Date.now()) -
                Date.parse(startedAt)) / 1000,
            )
            : undefined;
          const elapsedSeconds = discovery?.elapsedSeconds ?? workflowSeconds;
          const profile = discovery?.modelProfile;
          return {
            ...run,
            ...(category && { category }),
            ...(discovery && { status: discovery.status }),
            ...(startedAt && { startedAt }),
            ...(completedAt && { completedAt }),
            details: {
              ...run.details,
              ...(discovery?.goal &&
                { goal: redactCredentialText(discovery.goal).slice(0, 300) }),
              ...(discovery && {
                modelProfile: profile
                  ? {
                    provider: profile.provider,
                    ...(profile.model &&
                      { model: redactCredentialText(profile.model) }),
                  }
                  : null,
              }),
              ...(visibleParent && { parent: visibleParent }),
              ...(discovery?.progress && { progress: discovery.progress }),
              ...(discovery?.elapsedThrough &&
                { elapsedThrough: discovery.elapsedThrough }),
              ...(typeof elapsedSeconds === "number" &&
                Number.isSafeInteger(elapsedSeconds) && elapsedSeconds >= 0 &&
                { elapsedSeconds }),
            },
          };
        }));
        return safeProjection({ runs });
      }
      if (action === "finding_asset_tree") {
        const { findingIds, id, revision } = args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          args.kind !== "sentinel" || !isSentinelCaseId(id) ||
          typeof revision !== "number" || !Number.isSafeInteger(revision) ||
          revision < 1 || !Array.isArray(findingIds) || !findingIds.length ||
          findingIds.length > 16 ||
          new Set(findingIds).size !== findingIds.length ||
          findingIds.some((value) =>
            typeof value !== "string" || !value || value.length > 4096 ||
            /[\p{Cc}\p{Cf}]/u.test(value)
          ) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "findingIds"].includes(key)
          ) ||
          !await controller.inspect({ kind: "sentinel", id, revision }) ||
          context.authorizeSentinelCaseRead?.(id, revision) === false
        ) return unavailable;
        const tree = readSentinelFindingAssetTree(
          resolveSentinelCasePath(options.baseDir, id),
          id,
          revision,
          findingIds,
        );
        return tree ? safeProjection({ tree }) : unavailable;
      }
      if (action === "active_finding_rechecks") {
        const { scopes, limit = 2 } = args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !Array.isArray(scopes) || scopes.length < 1 || scopes.length > 4 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 3 ||
          Object.keys(args).some((key) =>
            !["action", "scopes", "limit"].includes(key)
          )
        ) return unavailable;
        const selected = new Set<string>();
        const groups = [];
        const rechecks = [];
        for (const scope of scopes) {
          if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
            return unavailable;
          }
          const { id, kind = "sentinel", revision, cursor } = scope;
          if (
            kind !== "sentinel" || typeof id !== "string" ||
            !isSentinelCaseId(id) ||
            selected.has(id) || typeof revision !== "number" ||
            !Number.isSafeInteger(revision) || revision < 1 ||
            (cursor !== undefined &&
              (typeof cursor !== "string" || cursor.length > 100)) ||
            Object.keys(scope).some((key) =>
              !["kind", "id", "revision", "cursor"].includes(key)
            )
          ) return unavailable;
          selected.add(id);
          const exact = { kind: "sentinel", id, revision } as const;
          const sourceArgs = {
            ...exact,
            action: "finding_recheck_attempts",
            activeOnly: true,
            limit,
            ...(cursor !== undefined && { cursor }),
          };
          if (
            context.authorizeSentinelCaseRead?.(id, revision) === false ||
            !await controller.inspect(exact) ||
            !await context.authorizeOwnerRunCall(sourceArgs)
          ) return unavailable;
          const path = resolveSentinelCasePath(options.baseDir, id);
          const state = readSentinelAssessment(path);
          const runId = state?.plan.runId;
          if (
            !state?.active || state.revision !== revision ||
            !state.result?.sharedGraph.snapshot || !runId
          ) return unavailable;
          const policy = readSentinelOperatingConstraints(path, runId);
          const read = () => {
            const current = readSentinelAssessment(path);
            if (
              !current?.active || current.revision !== revision ||
              current.plan.runId !== runId ||
              context.authorizeSentinelCaseRead?.(id, revision) === false ||
              readSentinelOperatingConstraints(path, runId)?.digest !==
                policy?.digest
            ) return;
            if (
              !hasSentinelWorkerFindingJournal(path) && cursor === undefined
            ) {
              return {
                runId,
                evidenceRevision: revision,
                entries: [],
                nextCursor: null,
              };
            }
            return readSentinelFindingRecheckAttempts(
              path,
              { caseId: id, revision, activeOnly: true },
              limit,
              cursor,
            );
          };
          const page = read();
          if (!page) return unavailable;
          const group = { run: exact, ...page };
          if (
            !await context.authorizeSavedResponse(
              operatorRunTool.name,
              safeProjection(group),
              "INTERNAL",
            )
          ) return unavailable;
          groups.push(group);
          rechecks.push(() => isDeepStrictEqual(read(), page));
        }
        return rechecks.every((check) => check())
          ? safeProjection({ groups })
          : unavailable;
      }
      if (action === "finding_groups") {
        const {
          scopes,
          limit = 1,
          includeFacets = false,
          findingFilter,
          findingOrder,
        } = args;
        const filter = parseFindingExportFilter(findingFilter);
        if (
          !context?.authenticatedOwnerSessionId ||
          typeof includeFacets !== "boolean" ||
          (findingOrder !== undefined && findingOrder !== "severity" &&
            findingOrder !== "time") ||
          (findingFilter !== undefined && !filter) ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !Array.isArray(scopes) || scopes.length < 1 || scopes.length > 4 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 3 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "scopes",
              "limit",
              "includeFacets",
              "findingFilter",
              "findingOrder",
            ]
              .includes(key)
          )
        ) return unavailable;
        const selected = new Map<string, {
          revision: number;
          offset: number;
          categoryOffset?: number;
          assetSubtreeId?: string;
        }>();
        for (const scope of scopes) {
          if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
            return unavailable;
          }
          const {
            id,
            kind = "sentinel",
            revision,
            offset = 0,
            categoryOffset,
            assetSubtreeId,
          } = scope;
          if (
            !isSentinelCaseId(id) || kind !== "sentinel" || selected.has(id) ||
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 || typeof offset !== "number" ||
            !Number.isSafeInteger(offset) || offset < 0 ||
            categoryOffset !== undefined &&
              (!includeFacets || typeof categoryOffset !== "number" ||
                !Number.isSafeInteger(categoryOffset) || categoryOffset < 0) ||
            (assetSubtreeId !== undefined &&
              (typeof assetSubtreeId !== "string" || !assetSubtreeId.trim() ||
                assetSubtreeId.length > 4096 ||
                /[\p{Cc}\p{Cf}]/u.test(assetSubtreeId))) ||
            Object.keys(scope).some((key) =>
              ![
                "kind",
                "id",
                "revision",
                "offset",
                "categoryOffset",
                "assetSubtreeId",
              ].includes(key)
            ) ||
            !await controller.inspect({ kind, id, revision }) ||
            context.authorizeSentinelCaseRead?.(id, revision) === false
          ) return unavailable;
          selected.set(id, {
            revision,
            offset,
            ...(includeFacets && { categoryOffset: categoryOffset ?? 0 }),
            ...(assetSubtreeId !== undefined && { assetSubtreeId }),
          });
        }
        const groups = [];
        let findingTotal = 0;
        for (const [id, selection] of selected) {
          const { revision, offset, categoryOffset, assetSubtreeId } =
            selection;
          const group = readSentinelFindingGroup(
            resolveSentinelCasePath(options.baseDir, id),
            id,
            revision,
            offset,
            limit,
            categoryOffset,
            filter,
            findingOrder,
            assetSubtreeId,
          );
          if (!group) return unavailable;
          groups.push(group);
          findingTotal += group.total;
        }
        if (findingOrder) {
          groups.sort((left, right) =>
            compareSentinelFindingRank(
              findingOrder,
              {
                id: left.caseId,
                severity: left.highestSeverity,
                foundAt: left.latestFoundAt ?? "",
              },
              {
                id: right.caseId,
                severity: right.highestSeverity,
                foundAt: right.latestFoundAt ?? "",
              },
            )
          );
        }
        return safeProjection({ groups, findingTotal });
      }
      if (action === "search_case_traces") {
        const { scopes, query, limit = 1 } = args;
        if (
          !context || !Array.isArray(scopes) || scopes.length < 1 ||
          scopes.length > 4 || typeof query !== "string" ||
          query.length > 256 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 3 ||
          Object.keys(args).some((key) =>
            !["action", "scopes", "query", "limit"].includes(key)
          )
        ) return unavailable;
        const selected = [];
        const identities = new Set<string>();
        for (const item of scopes) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return unavailable;
          }
          const { id, revision, offset = 0, cursor } = item;
          const scopeKind = item.kind === undefined ? "sentinel" : item.kind;
          const run = scopeKind === "delegated" || scopeKind === "scheduled"
            ? typeof id === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(id)
              ? { kind: scopeKind, id, revision: undefined }
              : undefined
            : reference(scopeKind, id, revision);
          if (!run || identities.has(`${run.kind}:${run.id}`)) {
            return unavailable;
          }
          if (run.kind === "sentinel") {
            if (
              !isSentinelCaseId(id) || run.revision === undefined ||
              typeof offset !== "number" || !Number.isSafeInteger(offset) ||
              offset < 0 ||
              Object.keys(item).some((key) =>
                !["kind", "id", "revision", "offset"].includes(key)
              )
            ) return unavailable;
            selected.push({ run, offset });
          } else {
            if (
              (cursor !== undefined && typeof cursor !== "string") ||
              Object.keys(item).some((key) =>
                !["kind", "id", "cursor"].includes(key)
              )
            ) return unavailable;
            selected.push({ run, cursor });
          }
          identities.add(`${run.kind}:${run.id}`);
        }
        for (const { run } of selected) {
          if (
            (run.kind === "sentinel" || run.kind === "workflow") &&
            !await controller.inspect(run)
          ) return unavailable;
        }
        const pages = [];
        for (const { run, offset, cursor } of selected) {
          if (run.kind === "delegated" || run.kind === "scheduled") {
            const journal = openExecutionTraces(
              join(options.baseDir, "execution-traces.db"),
            );
            try {
              const saved = journal.readRun(run.kind, run.id, "INTERNAL");
              if (!saved || !canReadBackgroundTrace(saved)) return unavailable;
              const term = query.trim();
              const page = term
                ? journal.search({
                  role: run.kind,
                  runId: run.id,
                  query: term,
                  cursor,
                  limit,
                  ceiling: "INTERNAL",
                  backgroundOwner,
                })
                : journal.list(saved.scope, {
                  cursor,
                  limit,
                  ceiling: "INTERNAL",
                });
              if (!page) return unavailable;
              pages.push({ run, page });
            } finally {
              journal.close();
            }
            continue;
          }
          if (run.kind === "workflow") {
            const page = options.workflows?.traces(run.id, "INTERNAL", {
              cursor,
              ...(query.trim() && { query: query.trim() }),
              limit,
            });
            if (!page) return unavailable;
            pages.push({ run, page });
            continue;
          }
          const response = searchSentinelWorkerTraces({
            snapshotPath: resolveSentinelCasePath(options.baseDir, run.id),
            assessmentRevision: run.revision,
          }, { revision: run.revision, query, offset, limit });
          if (response.startsWith("Error:")) return unavailable;
          pages.push({ run, page: JSON.parse(response) });
        }
        return safeProjection({ pages });
      }
      if (
        (action === "inspect" || action === "pause" || action === "cancel") &&
        args.kind === "owner_chat"
      ) {
        const { ownerRecoverySessionId, ceiling, authorizeOwnerRunCall } =
          context ?? {};
        const id = args.id;
        if (
          !ownerRecoverySessionId ||
          !canFlowTo("INTERNAL", ceiling ?? "INTERNAL") ||
          typeof id !== "string" || !digestPattern.test(id) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id"].includes(key)
          )
        ) return unavailable;
        Deno.lstatSync(recoveryPath);
        const recovery = new AgentRecoveryStore(recoveryPath);
        try {
          const ref = { kind: "owner_chat", id: id.toLowerCase() };
          const key = assignmentRecoveryKey(ownerRecoverySessionId, ref.id);
          const state = recovery.inspectStatus(key);
          if (!state) return unavailable;
          const project = (status: typeof state) =>
            safeProjection({ run: { ...ref, ...status } });
          const stopping = action === "cancel";
          if (
            action === "inspect" ||
            (stopping ? state.status === "stopped" : state.status === "paused")
          ) return project(state);
          if (stopping) {
            if (
              !authorizeOwnerRunCall || state.status === "completed" ||
              !await options.confirm(
                `Stop this exact owner chat execution?${"\n"}${
                  JSON.stringify(ref)
                }`,
              )
            ) return unavailable;
            if (!await authorizeOwnerRunCall(args)) return unavailable;
            using lock = lockAgentRecovery(recoveryPath, key);
            if (
              !lock || !isDeepStrictEqual(recovery.inspectStatus(key), state)
            ) {
              return unavailable;
            }
            const traces = openExecutionTraces(backgroundTracePath);
            try {
              const trace = traces.readRun(
                "owner_chat",
                key,
                ceiling ?? "INTERNAL",
              );
              if (
                trace?.status !== "running" ||
                trace.scope.sessionId !== ownerRecoverySessionId ||
                trace.scope.sourceId !== ref.id ||
                !recovery.recordStop(key)
              ) return unavailable;
              traces.cancelRun("owner_chat", key, ceiling ?? "INTERNAL");
              const stopped = recovery.inspectStatus(key);
              return stopped?.status === "stopped"
                ? project(stopped)
                : unavailable;
            } finally {
              traces.close();
            }
          }
          if (
            !authorizeOwnerRunCall || state.committedBatch === 0 ||
            (state.status !== "ready" &&
              (state.status !== "pending" ||
                (state.nextAction !== "retry_read" &&
                  state.nextAction !== "authorize_dispatch")))
          ) return unavailable;
          if (
            !await options.confirm(
              `Pause this exact owner chat execution at its saved checkpoint?\n${
                JSON.stringify(ref)
              }`,
            )
          ) return "Error: The operator declined the run action.";
          if (!await authorizeOwnerRunCall(args)) return unavailable;
          using lock = lockAgentRecovery(recoveryPath, key);
          if (!lock) return "Error: The owner chat execution is active.";
          const current = recovery.inspectStatus(key);
          if (
            current?.status === "paused" &&
            current.committedBatch === state.committedBatch
          ) {
            return project(current);
          }
          if (
            !isDeepStrictEqual(current, state) ||
            !recovery.pauseAtCommittedCheckpoint(key)
          ) return unavailable;
          const paused = recovery.inspectStatus(key);
          return paused?.status === "paused" ? project(paused) : unavailable;
        } finally {
          recovery.close();
        }
      }
      const ref = teamControlRef ??
        reference(args.kind, args.id, args.revision) ??
        (action === "inspect" || action === "link" || action === "cancel" ||
            action === "pause" || action === "resume" || action === "steer" ||
            action === "spawn"
          ? backgroundReference(args.kind, args.id, args.revision)
          : undefined);
      if (action === "set_display") {
        const { title, pinned, runId, expectedVersion, requestId } = args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          ref?.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
          (title === undefined && pinned === undefined) ||
          (pinned !== undefined && typeof pinned !== "boolean") ||
          (title !== undefined &&
            (typeof title !== "string" || !title.trim() ||
              title.trim().length > 256 ||
              Array.from(title.trim()).length > 200 ||
              /[\p{Cc}\p{Cf}]/u.test(title) ||
              redactCredentialText(title) !== title)) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "expectedVersion",
              "requestId",
              "title",
              "pinned",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const change = {
          runId: runId.toLowerCase(),
          revision: ref.revision,
          expectedVersion,
          requestId: requestId.toLowerCase(),
          ...(typeof title === "string" && { title: title.trim() }),
          ...(typeof pinned === "boolean" && { pinned }),
        };
        const preview = changeSentinelRunDisplay(path, change, false);
        if (!preview) return unavailable;
        if (
          !preview.saved && !await options.confirm(
            `Change how this exact run appears in the list?\n${
              JSON.stringify({
                run: ref,
                ...change,
                previous: preview.previous,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !preview.saved &&
          (!await context.authorizeOwnerRunCall(args) ||
            !await controller.inspect(ref))
        ) return unavailable;
        const committed = preview.saved
          ? preview
          : changeSentinelRunDisplay(path, change, true);
        return committed
          ? safeProjection({
            run: ref,
            runId: change.runId,
            display: committed.display,
          })
          : unavailable;
      }
      if (
        action === "assessment_templates" ||
        action === "set_assessment_template" ||
        action === "withdraw_assessment_template"
      ) {
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
        ) return unavailable;
        const result = await executeAssessmentTemplates(
          options.baseDir,
          args,
          context.authorizeOwnerRunCall,
          options.confirm,
        );
        if (!result) return unavailable;
        if ("declined" in result) {
          return "Error: The operator declined the run action.";
        }
        return safeProjection(result);
      }
      if (
        action === "interactive_turns" || action === "stop_interactive_turn"
      ) {
        const stopping = action === "stop_interactive_turn";
        const { runId, turnId } = args;
        if (
          ref?.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          (stopping
            ? typeof turnId !== "string" || !digestPattern.test(turnId)
            : turnId !== undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              ...(stopping ? ["turnId"] : []),
            ].includes(key)
          ) ||
          !await context.authorizeOwnerRunCall(args)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const exactRunId = runId.toLowerCase();
        const current = () => {
          const state = readSentinelAssessment(path);
          return !!state && state.revision === ref.revision &&
            state.plan.runId === exactRunId;
        };
        if (!current()) return unavailable;
        if (!stopping) {
          return safeProjection({
            run: ref,
            runId: exactRunId,
            turns: listSentinelInteractiveTurns(path, exactRunId, ref.revision),
          });
        }
        const selected = readSentinelInteractiveTurn(
          path,
          exactRunId,
          ref.revision,
          (turnId as string).toLowerCase(),
        );
        if (!selected) return unavailable;
        if (
          !await options.confirm(
            `Stop this exact Sentinel interactive turn?
${JSON.stringify({ run: ref, runId: exactRunId, turn: selected })}`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await context.authorizeOwnerRunCall(args) || !current()) {
          return unavailable;
        }
        return stopSentinelInteractiveTurn(
            path,
            exactRunId,
            ref.revision,
            selected.id,
          )
          ? safeProjection({
            run: ref,
            runId: exactRunId,
            turn: selected,
            status: "stopping",
          })
          : unavailable;
      }
      if (action === "archive_catalog") {
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
        ) return unavailable;
        const result = await executeOperatorArchiveCatalog(
          options.baseDir,
          args,
          context.authorizeOwnerRunCall,
        );
        return result ? safeProjection(result) : unavailable;
      }
      if (action === "archive_runs" || action === "restore_runs") {
        const ceiling = context?.ceiling ?? "PUBLIC";
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall || !canFlowTo("INTERNAL", ceiling)
        ) return unavailable;
        const result = await executeOperatorRunArchiveBatch({
          baseDir: options.baseDir,
          args,
          ownerSessionId: context.authenticatedOwnerSessionId,
          ceiling,
          authorize: context.authorizeOwnerRunCall,
          confirm: options.confirm,
          parent: ({ kind, id, revision }) =>
            providers.sentinel.discovery({ kind, id, revision })?.spawnParent,
        });
        if (!result) return unavailable;
        if ("declined" in result) {
          return "Error: The operator declined the run action.";
        }
        return safeProjection(result);
      }
      if (
        action === "archive" || action === "restore" ||
        action === "archive_history"
      ) {
        const archiveRef = ref ?? (
          (args.kind === "delegated" || args.kind === "scheduled" ||
              args.kind === "owner_chat" || args.kind === "team_delivery") &&
            typeof args.id === "string" && args.revision === undefined
            ? { kind: args.kind, id: args.id }
            : undefined
        );
        if (!archiveRef) return unavailable;
        const archiveOwner = archiveRef.kind === "owner_chat"
          ? context?.ownerRecoverySessionId
          : context?.authenticatedOwnerSessionId;
        const result = await executeOperatorRunArchive(
          options.baseDir,
          archiveRef,
          args,
          options.confirm,
          options.workflows,
          archiveOwner
            ? {
              sessionId: archiveOwner,
              ceiling: context?.ceiling ?? "INTERNAL",
            }
            : undefined,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (!ref) return unavailable;
      if (action === "approval_history") {
        const { runId, offset = 0, limit = 10 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 || typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC") ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "runId", "offset", "limit"]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const exactRun = readSentinelRunIdForRevision(path, ref.revision);
        if (exactRun !== runId.toLowerCase()) return unavailable;
        const decisions = readSentinelArchivedToolDecisions(
          join(dirname(path), sentinelArchivedToolDecisionsFile),
          ref.id,
          exactRun,
        );
        const page = decisions.slice(offset, offset + limit);
        return safeProjection({
          run: ref,
          runId: exactRun,
          decisions: page,
          nextOffset: offset + page.length < decisions.length
            ? offset + page.length
            : null,
        });
      }
      if (action === "finding_recheck_attempts") {
        const {
          receiptId,
          activeOnly = false,
          includeLifecycle = false,
          limit = 5,
          cursor,
        } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (receiptId === undefined
            ? activeOnly !== true
            : typeof receiptId !== "string" ||
              !/^worker-finding:[a-f0-9]{64}$/.test(receiptId)) ||
          typeof activeOnly !== "boolean" ||
          typeof includeLifecycle !== "boolean" ||
          (includeLifecycle && (!context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
            context.authorizeSentinelCaseRead?.(ref.id, ref.revision) ===
              false)) ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          (cursor !== undefined &&
            (typeof cursor !== "string" || cursor.length > 100)) ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "activeOnly",
              "includeLifecycle",
              "limit",
              "cursor",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const page = readSentinelFindingRecheckAttempts(
          path,
          {
            caseId: ref.id,
            revision: ref.revision,
            findingId: receiptId as string | undefined,
            activeOnly,
            ...(includeLifecycle && { includeLifecycle: true }),
          },
          limit,
          cursor as string | undefined,
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (action === "finding_recheck_candidates") {
        const { receiptId, offset = 0 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 || Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "receiptId", "offset"]
              .includes(key)
          )
        ) {
          return unavailable;
        }
        const run = await controller.inspect(ref);
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const state = readSentinelAssessment(path);
        const snapshot = state?.result?.sharedGraph.snapshot;
        const adaptiveRevision = run?.details?.adaptiveRevision;
        if (
          !state?.active || !snapshot || state.revision !== ref.revision ||
          run?.details?.runId !== state.plan.runId || !adaptiveRevision ||
          !hasSentinelWorkerFindingJournal(path)
        ) {
          return unavailable;
        }
        const journal = openSentinelWorkerFindingStore(path);
        const { finding, checked } = (() => {
          try {
            return {
              finding: journal.readFinding(receiptId),
              checked: new Set(
                journal.list(state.revision).flatMap((row) =>
                  row.kind === "recheck" && row.caseId === ref.id &&
                    row.runId === state.plan.runId &&
                    row.findingId === receiptId
                    ? [row.evidenceId]
                    : []
                ),
              ),
            };
          } finally {
            journal.close();
          }
        })();
        if (
          !finding || finding.caseId !== ref.id ||
          finding.runId !== state.plan.runId ||
          finding.evidenceRevision > state.revision
        ) {
          return unavailable;
        }
        const assetEvidence = new Set(snapshot.edges.flatMap(
          ({ relation, from, to }) =>
            relation === "observed_on" && to === finding.targetId ? [from] : [],
        ));
        const nodes = snapshot.nodes.filter((node) =>
          node.kind === "evidence" &&
          (node.executionSource || node.nativeWorkflowSource) &&
          node.controlVerification?.observedAt &&
          node.controlVerification.observedAt > finding.observedAt &&
          !checked.has(node.id) &&
          assetEvidence.has(node.id)
        );
        const isCurrent = () => {
          const latest = readSentinelAssessment(path);
          return latest?.active === true &&
            latest.revision === state.revision &&
            latest.plan.runId === state.plan.runId;
        };
        const candidates = [];
        const end = Math.min(nodes.length, offset + 8);
        for (const node of nodes.slice(offset, end)) {
          const receipt = await readAuthorizedCaseEvidence(
            ref.id,
            path,
            ref.revision,
            node.id,
            context,
            isCurrent,
          );
          const controlReceipt = receipt &&
            executionControlReceipt(receipt.payload);
          if (
            !receipt || !controlReceipt ||
            !receiptRecheckCandidate(
              path,
              state,
              finding,
              node.id,
              controlReceipt,
            )
          ) {
            continue;
          }
          candidates.push({
            nodeId: node.id,
            resultSha256: receipt.resultSha256,
          });
        }
        const current = await controller.inspect(ref);
        if (
          readSentinelAssessment(path)?.revision !== state.revision ||
          current?.details?.runId !== state.plan.runId ||
          current.details.adaptiveRevision !== adaptiveRevision
        ) {
          return unavailable;
        }
        return safeProjection({
          run: ref,
          runId: state.plan.runId,
          adaptiveRevision,
          findingId: receiptId,
          candidates,
          ...(end < nodes.length && { nextOffset: end }),
        });
      }
      if (action === "finding_recheck_sources") {
        const {
          receiptId,
          traceRole,
          traceRunId,
          validUntil,
          limit = 5,
          cursor,
        } = args;
        const authorizeSource = options.authorizeExecutionTracePayload;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !context ||
          !authorizeSource ||
          !canFlowTo("INTERNAL", context.ceiling ?? "INTERNAL") ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          (traceRole !== "delegated" && traceRole !== "scheduled") ||
          !backgroundReference(traceRole, traceRunId, undefined) ||
          typeof traceRunId !== "string" || typeof validUntil !== "string" ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 8 ||
          (cursor !== undefined && typeof cursor !== "string") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "traceRole",
              "traceRunId",
              "validUntil",
              "limit",
              "cursor",
            ].includes(key)
          )
        ) return unavailable;
        const expiry = Date.parse(validUntil);
        if (
          !Number.isFinite(expiry) || expiry <= Date.now() ||
          new Date(expiry).toISOString() !== validUntil
        ) return unavailable;
        const run = await controller.inspect(ref);
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const state = readSentinelAssessment(path);
        const caseRunId = state?.plan.runId;
        const snapshot = state?.result?.sharedGraph.snapshot;
        const finding = readSentinelCaseFindingReceipts(path, [receiptId]).get(
          receiptId,
        );
        if (
          !state?.active || state.revision !== ref.revision || !caseRunId ||
          run?.details?.runId !== caseRunId || !snapshot ||
          finding?.kind !== "finding" || finding.caseId !== ref.id ||
          finding.runId !== caseRunId ||
          finding.evidenceRevision > state.revision ||
          !snapshot.edges.some(({ from, to, relation }) =>
            from === finding.graphFindingId && to === finding.targetId &&
            relation === "affects"
          ) ||
          !snapshot.edges.some(({ from, to, relation }) =>
            from === finding.controlId && to === finding.graphFindingId &&
            relation === "mitigates"
          )
        ) return unavailable;
        const constraints = readSentinelOperatingConstraints(path, caseRunId);
        if (
          !sentinelOperatingConstraintsAllow(
            constraints?.constraints,
            { kind: "review_evidence", nodeId: finding.targetId },
            snapshot,
          )
        ) return unavailable;
        const isCurrent = () => {
          const latest = readSentinelAssessment(path);
          return latest?.active === true && latest.revision === ref.revision &&
            latest.plan.runId === caseRunId &&
            readSentinelOperatingConstraints(path, caseRunId)?.digest ===
              constraints?.digest;
        };
        const original = await readAuthorizedCaseEvidence(
          ref.id,
          path,
          finding.evidenceRevision,
          finding.evidenceId,
          context,
          isCurrent,
        );
        if (!original || !executionControlReceipt(original.payload)) {
          return unavailable;
        }
        const cursorPrefix = createHash("sha256").update(JSON.stringify([
          ref,
          caseRunId,
          receiptId,
          traceRole,
          traceRunId,
          validUntil,
          constraints?.digest ?? null,
        ])).digest("hex") + ".";
        if (typeof cursor === "string" && !cursor.startsWith(cursorPrefix)) {
          return unavailable;
        }
        const trace = openExecutionTraces(backgroundTracePath);
        try {
          const source = trace.readRun(traceRole, traceRunId, "INTERNAL");
          const page = source && canReadBackgroundTrace(source) &&
            trace.list(source.scope, {
              ceiling: "INTERNAL",
              limit,
              ...(typeof cursor === "string" &&
                { cursor: cursor.slice(cursorPrefix.length) }),
            });
          if (!page || !source) return unavailable;
          const candidates = [];
          for (const step of page.steps) {
            const payload = trace.readApprovedPayload(
              source.scope,
              step.ordinal,
              "INTERNAL",
            );
            const projection = payload &&
              projectExecutionRecheckSource(
                path,
                snapshot,
                state.revision,
                finding,
                { step, payload },
                validUntil,
              );
            if (
              projection && payload && isCurrent() &&
              await authorizeTracePayload(
                context,
                authorizeSource,
                payload,
                step.classification,
              )
            ) {
              candidates.push({
                ...projection,
                attachment: { ...ref, ...projection.attachment },
              });
            }
          }
          const currentSource = trace.readRun(
            traceRole,
            traceRunId,
            "INTERNAL",
          );
          if (
            !isCurrent() || expiry <= Date.now() ||
            !currentSource || !canReadBackgroundTrace(currentSource)
          ) return unavailable;
          return safeProjection({
            run: ref,
            findingId: receiptId,
            candidates,
            nextCursor: page.nextCursor ? cursorPrefix + page.nextCursor : null,
          });
        } finally {
          trace.close();
        }
      }
      if (action === "case_execution_evidence") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context || typeof args.node !== "string" ||
          !/^(?:execution-evidence|native-workflow-evidence):[a-f0-9]{64}$/
            .test(args.node) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "node"].includes(key)
          )
        ) {
          return unavailable;
        }
        if (!await controller.inspect(ref)) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        if (!runId) return unavailable;
        const evidence = await readAuthorizedCaseEvidence(
          ref.id,
          path,
          ref.revision,
          args.node,
          context,
          () => readSentinelRunIdForRevision(path, ref.revision!) === runId,
        );
        if (!evidence) return unavailable;
        return safeProjection({ evidence });
      }
      if (
        action === "attach_branch_evidence" ||
        action === "attach_repository_visibility_evidence" ||
        action === "attach_workflow_control_evidence" ||
        action === "attach_workflow_attempt_evidence" ||
        action === "attach_execution_evidence"
      ) {
        const { traceRole, traceRunId, ordinal } = args;
        const authorizeSource = options.authorizeExecutionTracePayload;
        if (
          !context || !authorizeSource ||
          (traceRole !== "delegated" && traceRole !== "scheduled") ||
          typeof traceRunId !== "string" || typeof ordinal !== "number" ||
          !Number.isSafeInteger(ordinal) || ordinal < 1
        ) return unavailable;
        const reopen = async () => {
          const journal = openExecutionTraces(
            join(options.baseDir, "execution-traces.db"),
          );
          try {
            const run = journal.readRun(traceRole, traceRunId, "INTERNAL");
            if (!run || !canReadBackgroundTrace(run)) return;
            const step = journal.inspect(run.scope, ordinal, "INTERNAL");
            const payload = journal.readApprovedPayload(
              run.scope,
              ordinal,
              "INTERNAL",
            );
            if (
              !step || !payload || (action === "attach_branch_evidence" &&
                payload.kind !== "github_branch_protection") ||
              (action === "attach_repository_visibility_evidence" &&
                payload.kind !== "github_repository_status") ||
              (action === "attach_workflow_control_evidence" &&
                payload.kind !== "github_actions_status") ||
              (action === "attach_workflow_attempt_evidence" &&
                payload.kind !== "github_actions_run_status") ||
              !await authorizeTracePayload(
                context,
                authorizeSource,
                payload,
                step.classification,
              )
            ) return;
            const current = journal.readRun(traceRole, traceRunId, "INTERNAL");
            if (!current || !canReadBackgroundTrace(current)) return;
            return { step, payload };
          } finally {
            journal.close();
          }
        };
        const result = await attachOperatorExecutionEvidence(
          options.baseDir,
          ref,
          args,
          reopen,
          options.confirm,
          options.webContainmentConfigured,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }

      if (action === "propose_graph_fact_discovery") {
        const { factId, node, requestId } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof factId !== "string" ||
          !/^worker-graph-fact:[a-f0-9]{64}$/.test(factId) ||
          typeof node !== "string" || !node.trim() || node.length > 4096 ||
          node.includes("\x00") ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "factId", "node", "requestId"]
              .includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const proposed = proposeSentinelGraphFactDiscovery(
          options.baseDir,
          ref.id,
          ref.revision,
          factId,
          node,
          requestId,
        );
        return proposed ? safeProjection({ proposal: proposed }) : unavailable;
      }

      if (
        action === "model_route" || action === "set_model_route" ||
        action === "set_model_role"
      ) {
        const {
          runId,
          requestId,
          expectedVersion,
          modelProfile,
          fallbackModelProfiles,
          activeModelProfile,
          modelRole,
        } = args;
        const editing = action !== "model_route";
        const roleEdit = action === "set_model_role";
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              ...(editing
                ? [
                  "requestId",
                  "expectedVersion",
                  "modelProfile",
                  ...(roleEdit ? ["modelRole"] : [
                    "fallbackModelProfiles",
                    "activeModelProfile",
                  ]),
                ]
                : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = { runId: runId.toLowerCase(), revision: ref.revision };
        const saved = readSentinelModelRoute(path, scope);
        if (!saved) return unavailable;
        if (!editing) {
          const { route, history, version } = saved;
          const allowed = options.sentinelProfiles?.() ?? [];
          const standard = options.sentinelModelAccess === false
            ? undefined
            : options.profiles?.("INTERNAL").find((
              { classification },
            ) => classification === "INTERNAL");
          const activeRun = route.activeIndex
            ? route.alternates?.[route.activeIndex - 1]
            : route.primary;
          const roles = Object.fromEntries(sentinelModelRoles.map((role) => {
            const profile = route.roles?.[role] ?? activeRun;
            return [
              role,
              profile
                ? {
                  source: route.roles?.[role] ? "role" : "run",
                  profile,
                  available: allowed.some((record) =>
                    isDeepStrictEqual(record, profile)
                  ),
                }
                : {
                  source: "classification",
                  ...(standard && {
                    profile: {
                      provider: standard.provider,
                      ...(standard.model !== undefined &&
                        { model: standard.model }),
                    },
                  }),
                  available: standard !== undefined,
                },
            ];
          }));
          return safeProjection({ route, history, version, roles });
        }
        if (
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
          (roleEdit
            ? !isSentinelModelRole(modelRole) ||
              (modelProfile !== undefined && !isModelProfileName(modelProfile))
            : !isModelProfileName(modelProfile)) ||
          (activeModelProfile !== undefined &&
            !isModelProfileName(activeModelProfile)) ||
          (fallbackModelProfiles !== undefined &&
            (!Array.isArray(fallbackModelProfiles) ||
              fallbackModelProfiles.length < 1 ||
              fallbackModelProfiles.length > 3 ||
              !fallbackModelProfiles.every(isModelProfileName)))
        ) return unavailable;
        const request = requestId.toLowerCase();
        const earlier = saved.history.find((edit) =>
          edit.requestId === request
        );
        const before = earlier?.before ?? saved.route;
        const select = (): SentinelModelRoute | undefined => {
          const profiles = options.sentinelProfiles?.() ?? [];
          const primary = profiles.find(({ provider }) =>
            provider === modelProfile
          );
          if (roleEdit && isSentinelModelRole(modelRole)) {
            if (modelProfile !== undefined && !primary) return;
            const roles = { ...before.roles };
            if (primary) roles[modelRole] = primary;
            else delete roles[modelRole];
            const { roles: _previousRoles, ...route } = before;
            return { ...route, ...(Object.keys(roles).length && { roles }) };
          }
          if (!primary) return;
          const alternates = Array.isArray(fallbackModelProfiles) &&
            parseModelFallbackProfiles(
              fallbackModelProfiles.map((name) =>
                profiles.find(({ provider }) => provider === name)
              ),
              primary,
            );
          if (fallbackModelProfiles !== undefined && !alternates) return;
          const activeIndex = activeModelProfile === undefined
            ? 0
            : [primary, ...(alternates || [])].findIndex(({ provider }) =>
              provider === activeModelProfile
            );
          if (activeIndex < 0) return;
          return {
            primary,
            ...(alternates && { alternates }),
            ...(before.roles && { roles: before.roles }),
            activeIndex,
          };
        };
        const after = select();
        if (!after) return unavailable;
        if (earlier) {
          return earlier.version === expectedVersion + 1 &&
              isDeepStrictEqual(earlier.after, after)
            ? safeProjection({ edit: earlier })
            : unavailable;
        }
        if (
          saved.version !== expectedVersion ||
          saved.version >= sentinelModelRouteEditLimit ||
          isDeepStrictEqual(saved.route, after)
        ) return unavailable;
        if (
          !await options.confirm(
            `Replace the model route for this exact Sentinel assessment?
${
              JSON.stringify({
                caseId: ref.id,
                ...scope,
                requestId: request,
                expectedVersion,
                before: saved.route,
                after,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await controller.inspect(ref) || !isDeepStrictEqual(select(), after)
        ) return unavailable;
        const edit = replaceSentinelModelRoute(path, scope, {
          requestId: request,
          expectedVersion,
          before: saved.route,
          after,
        });
        return edit ? safeProjection({ edit }) : unavailable;
      }

      if (action === "discovery_proposals") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision"].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        if (readSentinelAssessment(path)?.revision !== ref.revision) {
          return unavailable;
        }
        const proposals = listSentinelAssetDiscoveryProposals(
          options.baseDir,
          ref.id,
        )
          .filter(({ status, evidenceRevision }) =>
            status === "pending"
              ? evidenceRevision === ref.revision
              : status === "approved" && evidenceRevision <= ref.revision!
          );
        return safeProjection({ run: ref, proposals });
      }

      if (action === "correct_discovery") {
        const {
          originalId,
          originalVersion,
          replacementId,
          replacementVersion,
          requestId,
        } = args;
        const discoveryId = /^asset-discovery:[a-f0-9]{64}$/;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof originalId !== "string" || !discoveryId.test(originalId) ||
          typeof replacementId !== "string" ||
          !discoveryId.test(replacementId) ||
          typeof originalVersion !== "number" ||
          !Number.isSafeInteger(originalVersion) ||
          originalVersion < 2 || replacementVersion !== 1 ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "originalId",
              "originalVersion",
              "replacementId",
              "replacementVersion",
              "requestId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const receipt = await correctSentinelAssetDiscovery(options.baseDir, {
          sourceCaseId: ref.id,
          originalId,
          originalVersion,
          replacementId,
          replacementVersion,
          requestId,
        }, { revision: ref.revision, confirm: options.confirm });
        return receipt
          ? safeProjection({ run: ref, correction: receipt })
          : unavailable;
      }

      if (
        action === "preview_discovery_withdrawal" ||
        action === "withdraw_discoveries"
      ) {
        if (ref.kind !== "sentinel" || !await controller.inspect(ref)) {
          return unavailable;
        }
        const result = await executeOperatorAssetWithdrawal(
          options.baseDir,
          ref,
          args,
          options.confirm,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (
        action === "preview_inventory_affiliation" ||
        action === "affiliate_inventory_asset"
      ) {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !context?.authenticatedOwnerSessionId || !authorize ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          ref.kind !== "sentinel" || !await controller.inspect(ref)
        ) return unavailable;
        const result = await executeOperatorInventoryAffiliation(
          options.baseDir,
          ref,
          args,
          options.confirm,
          () => authorize(args),
          options.webContainmentConfigured,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (
        action === "preview_inventory_withdrawal" ||
        action === "withdraw_inventory_host"
      ) {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || !await controller.inspect(ref)
        ) {
          return unavailable;
        }
        const result = await executeOperatorInventoryWithdrawal(
          options.baseDir,
          ref,
          args,
          options.confirm,
          () => authorize(args),
          options.webContainmentConfigured,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (
        action === "apply_task_dependencies" ||
        action === "dismiss_task_dependencies"
      ) {
        const { taskId, proposalId } = args;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof proposalId !== "string" || !digestPattern.test(proposalId) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "taskId", "proposalId"]
              .includes(key)
          )
        ) return unavailable;
        const run = await controller.inspect(ref);
        if (!run || (run.status !== "running" && run.status !== "paused")) {
          return unavailable;
        }
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const queue = readSentinelTaskQueue(path, ref.revision);
        const target = queue?.tasks.find(({ id }) => id === taskId);
        if (
          !queue || queue.goal.id !== run.details?.runId ||
          queue.revision !== run.details.adaptiveRevision ||
          target?.dependencyRecommendation?.id !== proposalId
        ) return unavailable;
        const group = queue.tasks.flatMap(({ id, dependencyRecommendation }) =>
          dependencyRecommendation?.id === proposalId
            ? [{ taskId: id, proposal: dependencyRecommendation }]
            : []
        );
        const confirmation = JSON.stringify({
          run: ref,
          action,
          taskId,
          proposalId,
          changes: group,
        });
        if (confirmation.length > MAX_SENTINEL_DEPENDENCY_CONFIRMATION_CHARS) {
          return unavailable;
        }
        if (
          !await options.confirm(
            `Confirm this exact Sentinel dependency decision?\n${confirmation}`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await authorize(args)) return unavailable;
        controlSentinelTask(
          path,
          queue.revision,
          taskId,
          action === "apply_task_dependencies"
            ? "apply_dependencies"
            : "dismiss_dependencies",
          proposalId,
        );
        return safeProjection({
          run: ref,
          taskId,
          proposalId,
          decision: action === "apply_task_dependencies"
            ? "applied"
            : "dismissed",
        });
      }
      if (action === "enroll_goal_workflow") {
        const { runId, requestId, goalId, targetId } = args;
        const workflows = options.workflows;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          !workflows || ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof goalId !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(goalId) ||
          typeof targetId !== "string" ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "targetId",
              "goalId",
              "requestId",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const selection = {
          caseId: ref.id,
          revision: ref.revision,
          runId: runId.toLowerCase(),
          goalId,
          planId: targetId,
        };
        const request = requestId.toLowerCase();
        const prior = workflows.goalEnrollment(request, selection);
        if (prior) return safeProjection({ enrollment: prior });
        const binding = workflows.goalEnrollmentBinding(selection);
        if (!binding) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const eligible = () => {
          const state = readSentinelAssessment(path);
          return state?.active && state.plan.runId === selection.runId &&
            state.revision === selection.revision &&
            state.plan.activeFormalGoalIds?.includes(selection.goalId) &&
            state.plan.formalGoals?.some((goal) =>
              goal.id === selection.goalId &&
              goal.criteria.every(({ source }) => source === "graph_evidence")
            );
        };
        if (!eligible()) return unavailable;
        if (
          !await options.confirm(
            `Enroll this exact local workflow for future goal completion?\n${
              JSON.stringify({ requestId: request, ...binding })
            }`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await authorize(args) || !eligible()) return unavailable;
        const enrollment = workflows.enrollGoal(
          request,
          selection,
          binding.fingerprint,
        );
        return enrollment ? safeProjection({ enrollment }) : unavailable;
      }
      if (action === "completed_graph_followup") {
        const { runId, requestId, taskKind, node, receiptId, note } = args;
        const finding = parseReviewedFindingFollowup(receiptId, note, context);
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          (taskKind !== "trace" && taskKind !== "impact") ||
          typeof node !== "string" || !node.trim() || node.length > 100 ||
          node.includes("\0") ||
          ((receiptId !== undefined || note !== undefined) &&
            (!finding || taskKind !== "trace")) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "requestId",
              "taskKind",
              "node",
              "receiptId",
              "note",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const request = {
          runId: runId.toLowerCase(),
          requestId: requestId.toLowerCase(),
          evidenceRevision: ref.revision,
          kind: taskKind,
          nodeId: node,
          ...(finding && { finding }),
        } as const;
        const readFinding = (
          state: NonNullable<ReturnType<typeof readSentinelAssessment>>,
          source: NonNullable<typeof finding>,
        ) =>
          readSentinelFindingFollowup(
            path,
            state,
            node,
            source.findingId,
            source.note,
          );
        const before = reviewSentinelCompletedGraphFollowup(
          path,
          request,
          undefined,
          readFinding,
        );
        if (before?.receipt) {
          return safeProjection({ run: ref, receipt: before.receipt });
        }
        if (!before?.binding) return unavailable;
        if (
          !await options.confirm(
            `Run this exact ${
              finding ? "retained finding review" : "graph investigation"
            } on the completed assessment?\n${
              JSON.stringify({ run: ref, depth: 1, ...before.binding })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await authorize(args)) return unavailable;
        const binding = before.binding;
        const result = reviewSentinelCompletedGraphFollowup(path, request, {
          binding,
          execute: (state, constraints) =>
            executeCompletedSentinelGraphFollowup(state, binding, constraints),
        }, readFinding);
        return result?.receipt
          ? safeProjection({ run: ref, receipt: result.receipt })
          : unavailable;
      }
      if (action === "retry_model_review" && args.stopRequestId !== undefined) {
        const { runId, adaptiveRevision, taskId, stopRequestId, requestId } =
          args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          options.sentinelModelAccess !== true || ref.kind !== "sentinel" ||
          ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof stopRequestId !== "string" ||
          !digestPattern.test(stopRequestId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "taskId",
              "stopRequestId",
              "requestId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = {
          runId: runId.toLowerCase(),
          revision: ref.revision,
          adaptiveRevision,
          taskId,
          stopRequestId: stopRequestId.toLowerCase(),
          requestId: requestId.toLowerCase(),
        };
        const before = reviewSentinelStoppedGraphRetry(path, scope);
        const response = (receipt: unknown) =>
          safeProjection({
            run: ref,
            receipt,
            sourceTaskId: taskId,
            stopRequestId: scope.stopRequestId,
          });
        if (before?.receipt) return response(before.receipt);
        if (!before?.eligible) return unavailable;
        if (
          !await options.confirm(
            `Retry this exact stopped Sentinel assignment as a fresh graph-only review?\n${
              JSON.stringify({ ref, ...scope })
            }`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await context.authorizeOwnerRunCall?.(args)) return unavailable;
        const admitted = reviewSentinelStoppedGraphRetry(path, scope, true);
        return admitted?.receipt ? response(admitted.receipt) : unavailable;
      }
      if (action === "retry_graph_tasks") {
        const { runId, adaptiveRevision, requestId, taskIds } = args;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          !Array.isArray(taskIds) || !taskIds.length || taskIds.length > 8 ||
          new Set(taskIds).size !== taskIds.length ||
          taskIds.some((id) =>
            typeof id !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(id)
          ) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "requestId",
              "taskIds",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = {
          runId: runId.toLowerCase(),
          requestId: requestId.toLowerCase(),
          adaptiveRevision,
          evidenceRevision: ref.revision,
          taskIds: [...taskIds].sort(),
        };
        const before = reviewSentinelGraphRetries(path, scope);
        if (before?.receipt) {
          return safeProjection({ run: ref, receipt: before.receipt });
        }
        if (!before?.selection) return unavailable;
        const preview = JSON.stringify({
          run: ref,
          ...scope,
          ...before.selection,
        });
        if (preview.length > 8000) return unavailable;
        if (
          !await options.confirm(
            `Retry these exact failed graph investigations?\n${preview}`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await authorize(args)) return unavailable;
        const committed = reviewSentinelGraphRetries(
          path,
          scope,
          before.selection,
        );
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      const queueAction = [...sentinelQueueActions].find(([name]) =>
        name === action
      )?.[1];
      if (queueAction === "cancel" && args.cancellationReason !== undefined) {
        const {
          taskId,
          requestId,
          runId,
          adaptiveRevision,
          cancellationReason,
        } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          !validSentinelCancellationReason(cancellationReason) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "taskId",
              "requestId",
              "runId",
              "adaptiveRevision",
              "cancellationReason",
            ].includes(key)
          ) ||
          !await context.authorizeOwnerRunCall(args)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = {
          taskId,
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          evidenceRevision: ref.revision,
          reason: cancellationReason,
        };
        const review = reviewSentinelQueuedCancellation(
          path,
          scope,
          adaptiveRevision,
        );
        if (review?.receipt) {
          return safeProjection({ run: ref, receipt: review.receipt });
        }
        if (!review?.selection) return unavailable;
        const request = JSON.stringify({
          run: ref,
          ...scope,
          selection: review.selection,
        });
        if (request.length > 8000) return unavailable;
        if (
          !await options.confirm(`Cancel this exact Sentinel investigation?
${request}`)
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await context.authorizeOwnerRunCall(args)) return unavailable;
        const committed = reviewSentinelQueuedCancellation(
          path,
          scope,
          adaptiveRevision,
          review.selection,
        );
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      if (queueAction) {
        const { taskId } = args;
        const modelRetry = queueAction === "retry_model_review";
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          (modelRetry && options.sentinelModelAccess !== true) ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "taskId"].includes(key)
          )
        ) return unavailable;
        const run = await controller.inspect(ref);
        if (!run || (run.status !== "running" && run.status !== "paused")) {
          return unavailable;
        }
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const queue = readSentinelTaskQueue(path, ref.revision, modelRetry);
        if (
          !queue || queue.goal.id !== run.details?.runId ||
          queue.revision !== run.details.adaptiveRevision
        ) return unavailable;
        const review = modelRetry &&
          queue.reviews.find((item) =>
            item.taskId === taskId && item.retryable
          );
        const preview = modelRetry
          ? undefined
          : previewSentinelQueueControl(queue.tasks, taskId, queueAction);
        if (!preview && !review) return unavailable;
        const confirmation = JSON.stringify({
          run: ref,
          taskId,
          action,
          ...(review ? { review } : preview),
        });
        if (confirmation.length > 8000) return unavailable;
        if (
          !await options.confirm(
            `Confirm this exact Sentinel task change?\n${confirmation}`,
          )
        ) {
          return "Error: The operator declined the run action.";
        }
        if (!await authorize(args)) return unavailable;
        controlSentinelTask(
          path,
          queue.revision,
          taskId,
          queueAction,
          undefined,
          preview,
        );
        return safeProjection({
          run: ref,
          taskId,
          action,
          affectedTaskIds: preview?.affected.map(({ id }) => id) ?? [taskId],
        });
      }
      if (
        action === "worker_limit" || action === "set_worker_limit" ||
        action === "reset_worker_limit"
      ) {
        const writable = action !== "worker_limit";
        const setting = action === "set_worker_limit";
        const authorize = context?.authorizeOwnerRunCall;
        const gatewayLimit = options.sentinelGatewayWorkerLimit ?? 2;
        const { limit } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          (writable && (!authorize || !context?.authenticatedOwnerSessionId ||
            options.sentinelModelAccess !== true)) ||
          (setting
            ? typeof limit !== "number" || !Number.isSafeInteger(limit) ||
              limit < 1 || limit > gatewayLimit
            : limit !== undefined) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", ...(setting ? ["limit"] : [])]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const runId = current?.plan.runId;
        if (
          !runId || current.revision !== ref.revision ||
          (writable && !current.active)
        ) return unavailable;
        const expected = readSentinelModelSettings(path)?.workerLimit ?? null;
        const requested = setting ? limit as number : null;
        let caseLimit = expected;
        if (writable && expected !== requested) {
          if (
            !await options.confirm(
              `Confirm this exact Sentinel worker limit?\n${
                JSON.stringify({
                  run: ref,
                  runId,
                  previous: expected,
                  requested,
                  gatewayLimit,
                })
              }`,
            )
          ) {
            return "Error: The operator declined the run action.";
          }
          if (
            !await authorize?.(args) ||
            !updateSentinelWorkerLimit(path, {
              runId,
              revision: ref.revision,
              expected,
            }, requested)
          ) return unavailable;
          caseLimit = requested;
        }
        return safeProjection({
          run: ref,
          runId,
          gatewayLimit,
          caseLimit,
          effectiveLimit: Math.min(gatewayLimit, caseLimit ?? gatewayLimit),
          modelAccess: options.sentinelModelAccess === true,
        });
      }
      if (action === "tasks") {
        const { taskId, proposalId, taskStatus, offset = 0, limit = 5, asOf } =
          args;
        const now = asOf === undefined
          ? Date.now()
          : typeof asOf === "string"
          ? Date.parse(asOf)
          : NaN;
        if (
          !Number.isFinite(now) ||
          (asOf !== undefined && new Date(now).toISOString() !== asOf) ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          (taskId !== undefined &&
            (typeof taskId !== "string" ||
              !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
              args.offset !== undefined || args.limit !== undefined)) ||
          (proposalId !== undefined &&
            (typeof proposalId !== "string" ||
              !digestPattern.test(proposalId) || taskId === undefined ||
              taskStatus !== undefined || asOf !== undefined)) ||
          (taskStatus !== undefined &&
            ![
              "queued",
              "running",
              "completed",
              "failed",
              "superseded",
              "cancelled",
            ].some((status) => status === taskStatus)) ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "taskId",
              "proposalId",
              "taskStatus",
              "asOf",
              "offset",
              "limit",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        const queue = readSentinelTaskQueue(
          path,
          ref.revision,
          true,
          now,
          taskId,
          proposalId,
        );
        if (!runId || (queue && queue.goal.id !== runId)) return unavailable;
        if (proposalId !== undefined) {
          const receipt = queue?.dependencyApproval;
          return receipt && receipt.runId === runId &&
              receipt.evidenceRevision === ref.revision
            ? safeProjection({ run: ref, taskId, dependencyApproval: receipt })
            : unavailable;
        }
        const all = queue?.tasks ?? [];
        const completed = new Set(
          all.filter(({ status }) => status === "completed").map(({ id }) =>
            id
          ),
        );
        const matched = all.filter(({ id, status }) =>
          (taskId === undefined || taskId === id) &&
          (taskStatus === undefined || taskStatus === status)
        );
        if (taskId !== undefined && !matched.length) return unavailable;
        const reviews = new Map(
          queue?.reviews.map(({ taskId, ...review }) => [taskId, review]),
        );
        const tasks = matched.slice(offset, offset + limit).map((task) => ({
          id: task.id,
          kind: task.kind,
          nodeId: task.nodeId,
          status: task.status,
          prerequisites: task.prerequisites,
          unfinishedPrerequisites: task.prerequisites.filter((id) =>
            !completed.has(id)
          ),
          factSatisfaction: task.factSatisfaction,
          modelReview: reviews.get(task.id),
          attempts: task.attempts,
          prioritized: task.prioritized ?? false,
          plannerPriority: task.plannerPriority,
          operatorPriority: task.operatorPriority,
          retirementReason: task.retirementReason,
          decisionHold: queue?.diagnostics?.decisionHolds.get(task.id),
          controlPrerequisiteHold:
            queue?.diagnostics?.controlHolds.blocked.has(task.id) ?? false,
          ...(taskId !== undefined && {
            controlHoldSources: queue?.diagnostics?.controlHolds.sources ?? [],
            controlHoldSourceCount:
              queue?.diagnostics?.controlHolds.totalSources ?? 0,
            workerSources: taskWorkerSources(task).map(({ taskId, kind }) => ({
              taskId,
              kind,
            })),
            upstreamCitations: taskUpstreamCitations(task),
          }),
          dependencyProposal: task.dependencyRecommendation && {
            id: task.dependencyRecommendation.id,
            prerequisites: task.dependencyRecommendation.prerequisites,
            reason: task.dependencyRecommendation.reason,
            ...(task.dependencyRecommendation.affectedOnly &&
              { affectedOnly: true }),
          },
        }));
        return safeProjection({
          run: ref,
          runId,
          adaptiveRevision: queue?.revision ?? null,
          controlEvaluatedAt: new Date(now).toISOString(),
          total: matched.length,
          offset,
          tasks,
          nextOffset: offset + tasks.length < matched.length
            ? offset + tasks.length
            : null,
        });
      }
      if (action === "hint_batch") {
        const { runId, requestId, hints } = args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          !Array.isArray(hints) || !hints.length || hints.length > 8 ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "runId", "requestId", "hints"]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const revision = ref.revision;
        const selected: AdaptiveOperatorHintSelection[] = [];
        for (const hint of hints) {
          if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
            return unavailable;
          }
          const { note, assetIds: rawAssets } = hint;
          const trafficReference = parseOperatorHintTraffic(hint);
          const assetIds = normalizeSentinelHintAssets(rawAssets);
          if (
            typeof note !== "string" || !note.trim() || note.length > 1000 ||
            note.includes("\0") || redactCredentialText(note) !== note ||
            (rawAssets !== undefined && !assetIds) ||
            trafficReference === null ||
            (trafficReference !== undefined && assetIds?.length !== 1) ||
            Object.keys(hint).some((key) =>
              !["note", "assetIds", "trafficReference", "trafficReferences"]
                .includes(key)
            )
          ) return unavailable;
          selected.push({
            note: note.trim(),
            ...(assetIds && { assetIds }),
            ...(trafficReference && { trafficReference }),
          });
        }
        const authorize = async () => {
          for (const { assetIds, trafficReference } of selected) {
            for (
              const source of sentinelHintTrafficReferences(trafficReference)
            ) {
              if (
                !readProjectedSentinelTrafficReceipt(
                  path,
                  ref.id,
                  revision,
                  source,
                  assetIds?.[0],
                ) ||
                !await context.authorizeOwnerRunCall?.({
                  action: "traffic_get",
                  kind: "sentinel",
                  id: ref.id,
                  revision,
                  ...source,
                }) ||
                !await context.authorizeSavedResponse(
                  operatorRunTool.name,
                  safeProjection({
                    caseId: ref.id,
                    revision,
                    ...source,
                  }),
                  "INTERNAL",
                )
              ) return false;
            }
          }
          return true;
        };
        if (!await authorize()) return unavailable;
        const batch = {
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          revision,
          hints: selected,
        };
        const before = reviewSentinelOperatorHintBatch(path, batch);
        if (before?.receipt) {
          return safeProjection({ run: ref, receipt: before.receipt });
        }
        if (!before?.eligible) return unavailable;
        if (
          !await options.confirm(
            `Approve these exact Sentinel planner hints?\n${
              JSON.stringify({ run: ref, ...batch })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await context.authorizeOwnerRunCall?.(args) || !await authorize()
        ) {
          return unavailable;
        }
        const committed = reviewSentinelOperatorHintBatch(path, batch, true);
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      if (action === "assign_batch") {
        const { runId, adaptiveRevision, requestId, assignments } = args;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId || !authorize ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          !Array.isArray(assignments) || !assignments.length ||
          assignments.length > 8 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "requestId",
              "assignments",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const selected: AdaptiveGraphAssignment[] = [];
        for (const item of assignments) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return unavailable;
          }
          const { taskKind, node, prioritizeNext, priorityRank } = item;
          if (
            (taskKind !== "trace" && taskKind !== "impact") ||
            typeof node !== "string" || !node.trim() || node.length > 100 ||
            node.includes("\0") ||
            (prioritizeNext !== undefined &&
              typeof prioritizeNext !== "boolean") ||
            (priorityRank !== undefined &&
              (typeof priorityRank !== "number" ||
                !Number.isSafeInteger(priorityRank) ||
                priorityRank < 0 || priorityRank > 10 ||
                prioritizeNext === true)) ||
            Object.keys(item).some((key) =>
              !["taskKind", "node", "prioritizeNext", "priorityRank"].includes(
                key,
              )
            )
          ) return unavailable;
          selected.push({
            kind: taskKind,
            nodeId: node,
            ...(prioritizeNext === true && { prioritizeNext: true }),
            ...(typeof priorityRank === "number" &&
              { priorityRank: priorityRank || 5 }),
          });
        }
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const batch = {
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          evidenceRevision: ref.revision,
          adaptiveRevision,
          assignments: selected,
        };
        const selectedCase = context.authorizeSelectedSentinelCase;
        if (selectedCase && !selectedCase()) return unavailable;
        const before = reviewSentinelAssignmentBatch(path, batch);
        if (before?.receipt) {
          return safeProjection({ run: ref, receipt: before.receipt });
        }
        if (!before?.eligible) return unavailable;
        if (
          !await options.confirm(
            `Approve these exact Sentinel graph assignments?\n${
              JSON.stringify({ run: ref, ...batch })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await authorize(args) || (selectedCase && !selectedCase())
        ) {
          return unavailable;
        }
        const committed = reviewSentinelAssignmentBatch(path, batch, true);
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      if (action === "assign") {
        const authorize = context?.authorizeOwnerRunCall;
        const {
          runId,
          receiptId,
          note,
          adaptiveRevision,
          requestId,
          taskKind,
          node,
          recheckFindingId,
          passingRecheckForFindingId,
          graphRelationship,
          prioritizeNext,
          priorityRank,
        } = args;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "receiptId",
              "note",
              "requestId",
              "taskKind",
              "node",
              "recheckFindingId",
              "passingRecheckForFindingId",
              "graphRelationship",
              "prioritizeNext",
              "priorityRank",
            ].includes(key)
          ) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof taskKind !== "string" || !/^[a-z_]{1,64}$/.test(taskKind) ||
          (prioritizeNext !== undefined &&
            typeof prioritizeNext !== "boolean") ||
          (priorityRank !== undefined &&
            (typeof priorityRank !== "number" ||
              !Number.isSafeInteger(priorityRank) ||
              priorityRank < 0 || priorityRank > 10 ||
              prioritizeNext === true)) ||
          ((prioritizeNext === true || priorityRank !== undefined) &&
            ((taskKind !== "trace" && taskKind !== "impact") ||
              recheckFindingId !== undefined ||
              passingRecheckForFindingId !== undefined ||
              graphRelationship !== undefined)) ||
          typeof node !== "string" || !node.trim() || node.length > 4096 ||
          node.includes("\0")
        ) return unavailable;
        const hasRecheckNote = recheckFindingId !== undefined &&
          note !== undefined;
        const recheckNote = hasRecheckNote
          ? normalizeSentinelRecheckNote(note)
          : undefined;
        if (
          hasRecheckNote && (!recheckNote || receiptId !== undefined ||
            !canFlowTo(
              context?.inputClassification ?? "INTERNAL",
              "INTERNAL",
            ) ||
            !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL"))
        ) return unavailable;
        const finding = parseReviewedFindingFollowup(receiptId, note, context);
        if (
          (receiptId !== undefined || note !== undefined && !hasRecheckNote) &&
          (!finding || taskKind !== "trace" || recheckFindingId !== undefined ||
            passingRecheckForFindingId !== undefined ||
            graphRelationship !== undefined)
        ) return unavailable;
        const relationship = graphRelationship === undefined
          ? undefined
          : parseSentinelGraphFactRequirement(graphRelationship, node);
        if (
          graphRelationship !== undefined &&
          (!relationship || taskKind !== "trace")
        ) {
          return unavailable;
        }
        if (
          recheckFindingId !== undefined &&
          (taskKind !== "review_evidence" || relationship ||
            typeof recheckFindingId !== "string" ||
            !/^worker-finding:[a-f0-9]{64}$/.test(recheckFindingId) ||
            !/^(?:execution-evidence|native-workflow-evidence):[a-f0-9]{64}$/
              .test(node))
        ) return unavailable;
        if (
          passingRecheckForFindingId !== undefined &&
          (taskKind !== "trace" || relationship ||
            recheckFindingId !== undefined ||
            typeof passingRecheckForFindingId !== "string" ||
            !/^worker-finding:[a-f0-9]{64}$/.test(passingRecheckForFindingId))
        ) return unavailable;
        const before = await controller.inspect(ref);
        if (
          !before || before.details?.runId !== runId.toLowerCase() ||
          before.details.adaptiveRevision !== adaptiveRevision ||
          (before.status !== "running" && before.status !== "paused")
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const evidenceRevision = ref.revision;
        if (typeof passingRecheckForFindingId === "string") {
          const state = readSentinelAssessment(path);
          if (
            !state?.active || state.plan.runId !== runId.toLowerCase() ||
            state.revision !== evidenceRevision ||
            !canQueueSentinelPassingRecheck(
              path,
              state,
              node,
              passingRecheckForFindingId,
            )
          ) return unavailable;
        }
        const reopen = async () => {
          if (typeof recheckFindingId !== "string" || !context) return;
          const receipt = await readAuthorizedCaseEvidence(
            ref.id,
            path,
            evidenceRevision,
            node,
            context,
            () => {
              const latest = readSentinelAssessment(path);
              return latest?.active === true &&
                latest.revision === evidenceRevision &&
                latest.plan.runId === runId.toLowerCase();
            },
          );
          const controlReceipt = receipt &&
            executionControlReceipt(receipt.payload);
          if (!receipt || !controlReceipt) return;
          return { digest: receipt.resultSha256, controlReceipt };
        };
        const original = recheckFindingId === undefined
          ? undefined
          : await reopen();
        if (recheckFindingId !== undefined && !original) return unavailable;
        const findingState = finding ? readSentinelAssessment(path) : undefined;
        const findingFollowup = findingState?.revision === ref.revision &&
            findingState.plan.runId === runId.toLowerCase() &&
            finding
          ? readSentinelFindingFollowup(
            path,
            findingState,
            node,
            finding.findingId,
            finding.note,
          )
          : undefined;
        if (finding && !findingFollowup) return unavailable;
        const intent = {
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          evidenceRevision: ref.revision,
          adaptiveRevision,
          kind: taskKind,
          ...(findingFollowup && { findingFollowup }),
          nodeId: node,
          ...(prioritizeNext === true && { prioritizeNext: true as const }),
          ...(typeof priorityRank === "number" &&
            { priorityRank: priorityRank || 5 }),
          ...(relationship && { graphRelationship: relationship }),
          ...(typeof recheckFindingId === "string" && { recheckFindingId }),
          ...(recheckNote && { recheckNote }),
          ...(typeof passingRecheckForFindingId === "string" &&
            { passingRecheckForFindingId }),
        };
        if (hasSentinelAssignmentIntent(path, intent.requestId)) {
          const prior = submitSentinelAssignmentIntent(
            path,
            intent,
            original?.controlReceipt,
            true,
          );
          return prior
            ? safeProjection({ run: ref, receipt: prior })
            : unavailable;
        }
        let recheckBaseline;
        if (original && typeof recheckFindingId === "string") {
          const state = readSentinelAssessment(path);
          if (
            state?.revision !== evidenceRevision ||
            state.plan.runId !== intent.runId ||
            !exactExecutionRecheckCandidate(
              path,
              state,
              node,
              recheckFindingId,
              original.controlReceipt,
            )
          ) return unavailable;
          recheckBaseline = readSentinelRecheckBaseline(
            path,
            state,
            recheckFindingId,
          );
          if (!recheckBaseline) return unavailable;
        }
        if (
          !await options.confirm(
            `Approve this exact Sentinel investigation?\n${
              JSON.stringify({
                ref,
                ...intent,
                ...(original && { executionReceiptSha256: original.digest }),
                ...(recheckBaseline && { recheckBaseline }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const authorized = original && await reopen();
        if (original && !isDeepStrictEqual(authorized, original)) {
          return unavailable;
        }
        if (
          !await authorize(args) ||
          context.authorizeSelectedSentinelCase?.() === false
        ) return unavailable;
        const receipt = submitSentinelAssignmentIntent(
          path,
          { ...intent, ...(recheckBaseline && { recheckBaseline }) },
          authorized?.controlReceipt,
        );
        return receipt ? safeProjection({ run: ref, receipt }) : unavailable;
      }
      if (backgroundRole && action === "steer") {
        const { requestId, note } = args;
        const authorize = context?.authorizeOwnerRunCall;
        const publicRef = publicTeamControlRef ?? ref;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "requestId", "note"].includes(key)
          ) || typeof requestId !== "string" ||
          !digestPattern.test(requestId) ||
          typeof note !== "string" || !note.trim() || note.length > 1_000 ||
          note.includes("\0") || redactCredentialText(note) !== note ||
          !canFlowTo(context?.inputClassification ?? "INTERNAL", "INTERNAL") ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL")
        ) return unavailable;
        const journal = openExecutionTraces(backgroundTracePath);
        try {
          const initial = journal.readRun(backgroundRole, ref.id, "INTERNAL");
          if (!initial || !canReadBackgroundTrace(initial)) return unavailable;
          const exactAdmission = teamControlAdmission(initial);
          const reviewedAdmission = await exactAdmission?.read();
          if (teamControlRef && !reviewedAdmission) return unavailable;
          const request = requestId.toLowerCase();
          const prior = journal.steerRun(
            backgroundRole,
            ref.id,
            "INTERNAL",
            request,
            note,
            false,
          );
          if (prior) return safeProjection({ run: publicRef, receipt: prior });
          if ((await controller.inspect(ref))?.status !== "running") {
            return unavailable;
          }
          if (
            !await options.confirm(
              `Steer this exact background assignment?\n${
                JSON.stringify({ ref: publicRef, note })
              }`,
            )
          ) return "Error: The operator declined the run action.";
          if (
            (exactAdmission && !isDeepStrictEqual(
              await exactAdmission.read(),
              reviewedAdmission,
            )) || !await authorize(args)
          ) return unavailable;
          const current = journal.readRun(backgroundRole, ref.id, "INTERNAL");
          if (
            current?.status !== "running" || current.operatorCancelled ||
            !canReadBackgroundTrace(current) ||
            !isDeepStrictEqual(current.scope, initial.scope)
          ) return unavailable;
          const receipt = journal.steerRun(
            backgroundRole,
            ref.id,
            "INTERNAL",
            request,
            note,
            true,
          );
          return receipt
            ? safeProjection({ run: publicRef, receipt })
            : unavailable;
        } finally {
          journal.close();
        }
      }
      if (action === "pause_assignment" || action === "resume_assignment") {
        const { runId, adaptiveRevision, taskId, requestId, attempt } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
          attempt < 1 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "taskId",
              "requestId",
              "attempt",
            ].includes(key)
          ) ||
          !await context.authorizeOwnerRunCall(args)
        ) return unavailable;
        const exactRunId = runId.toLowerCase();
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = {
          action,
          requestId: requestId.toLowerCase(),
          taskId,
          evidenceRevision: ref.revision,
          attempt,
        } as const;
        const review = reviewSentinelWorkerHold(
          path,
          exactRunId,
          adaptiveRevision,
          scope,
        );
        if (review?.receipt) {
          return safeProjection({ run: ref, receipt: review.receipt });
        }
        if (!review?.preview) return unavailable;
        if (
          !await options.confirm(
            `Approve ${
              action === "pause_assignment" ? "pausing" : "resuming"
            } this exact Sentinel assignment?
${JSON.stringify({ run: ref, runId: exactRunId, adaptiveRevision, ...scope })}`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await context.authorizeOwnerRunCall(args)) return unavailable;
        const committed = reviewSentinelWorkerHold(
          path,
          exactRunId,
          adaptiveRevision,
          scope,
          review.preview,
        );
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      if (action === "stop" && args.cancellationReason !== undefined) {
        const {
          runId,
          adaptiveRevision,
          taskId,
          requestId,
          attempt,
          cancellationReason,
        } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
          attempt < 1 ||
          !validSentinelCancellationReason(cancellationReason) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "taskId",
              "requestId",
              "attempt",
              "cancellationReason",
            ].includes(key)
          ) ||
          !await context.authorizeOwnerRunCall(args)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const scope = {
          runId: runId.toLowerCase(),
          taskId,
          requestId: requestId.toLowerCase(),
          evidenceRevision: ref.revision,
          stoppedAttempt: attempt,
          reason: cancellationReason,
        };
        const review = reviewSentinelWorkerStopRationale(
          path,
          adaptiveRevision,
          scope,
        );
        if (review?.receipt) {
          return safeProjection({ run: ref, receipt: review.receipt });
        }
        if (!review?.preview) return unavailable;
        if (
          !await options.confirm(
            `Stop this exact Sentinel graph worker?
${JSON.stringify({ run: ref, adaptiveRevision, ...scope })}`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await context.authorizeOwnerRunCall(args)) return unavailable;
        const committed = reviewSentinelWorkerStopRationale(
          path,
          adaptiveRevision,
          scope,
          review.preview,
        );
        return committed?.receipt
          ? safeProjection({ run: ref, receipt: committed.receipt })
          : unavailable;
      }
      if (action === "steer" || action === "stop") {
        const selectedCase = context?.authorizeSelectedSentinelCase;
        const { runId, adaptiveRevision, taskId, requestId, note } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "taskId",
              "requestId",
              "note",
            ].includes(key)
          ) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          (action === "steer"
            ? typeof note !== "string" || !note.trim() ||
              note.length > 1000 || note.includes("\x00")
            : note !== undefined)
        ) return unavailable;
        const before = await controller.inspect(ref);
        if (
          !before || before.details?.runId !== runId.toLowerCase() ||
          before.details.adaptiveRevision !== adaptiveRevision ||
          before.status !== "running"
        ) return unavailable;
        const target = {
          runId: runId.toLowerCase(),
          adaptiveRevision,
          taskId,
          requestId: requestId.toLowerCase(),
          ...(typeof note === "string" && { note: note.trim() }),
        };
        if (selectedCase) {
          if (
            action !== "steer" || !selectedCase() || typeof note !== "string" ||
            redactCredentialText(note) !== note
          ) return unavailable;
          const path = resolveSentinelCasePath(options.baseDir, ref.id);
          const worker = readHistoricalAdaptiveSentinel(path, ref.revision)
            ?.modelReviewStates.find((state) => state.taskId === taskId);
          if (worker?.status !== "running") return unavailable;
        }
        if (
          !await options.confirm(
            `Approve ${action} for this exact Sentinel assignment?\n${
              JSON.stringify({ ref, ...target })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          selectedCase &&
          (!await context.authorizeOwnerRunCall?.(args) || !selectedCase())
        ) {
          return unavailable;
        }
        const receipt = providers.sentinel.workerControl(ref, action, target);
        return receipt
          ? safeProjection({ run: ref, runId: target.runId, receipt })
          : unavailable;
      }
      if (action === "add_case_membership") {
        const {
          runId,
          allowedAssetIds,
          organizationId,
          expectedVersion,
          requestId,
          note,
        } = args;
        const selected = context?.authorizeSelectedSentinelCase;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 1 || expectedVersion >= 1024 ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof note !== "string" || !note.trim() || note.trim() !== note ||
          note.length > 512 || /[\p{Cc}\p{Cf}]/u.test(note) ||
          redactCredentialText(note) !== note ||
          (organizationId === undefined
            ? !Array.isArray(allowedAssetIds) || allowedAssetIds.length === 0 ||
              allowedAssetIds.some((id) => typeof id !== "string")
            : typeof organizationId !== "string" ||
              allowedAssetIds !== undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "allowedAssetIds",
              "organizationId",
              "expectedVersion",
              "requestId",
              "note",
            ].includes(key)
          ) ||
          (selected && !selected()) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const id = runId.toLowerCase();
        const revision = ref.revision;
        const current = readSentinelAssessment(path);
        if (
          !current?.active || current.revision !== revision ||
          current.plan.runId !== id ||
          (selected && !selected())
        ) return unavailable;
        const baseline = readSentinelOperatingConstraintVersion(
          path,
          id,
          expectedVersion,
        );
        const assetIds = baseline?.constraints.allowedAssetIds;
        if (!baseline?.membership || !assetIds) return unavailable;
        const membership = resolveSentinelCaseMembership(
          current.result?.sharedGraph.snapshot,
          {
            caseId: ref.id,
            evidenceRevision: revision,
            selector: {
              kind: "addition",
              baselineAssetIds: assetIds,
              addition: typeof organizationId === "string"
                ? { kind: "organization", organizationId }
                : { kind: "assets", assetIds: allowedAssetIds as string[] },
              reason: note,
            },
          },
        );
        if (!membership) return unavailable;
        const request = requestId.toLowerCase();
        const result = (record: { version: number; digest: string }) =>
          safeProjection({ run: ref, ...record, membership });
        const latest = readSentinelOperatingConstraints(path, id);
        if (latest?.version !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            id,
            expectedVersion + 1,
          );
          return replay?.requestId === request &&
              replay.evidenceRevision === revision &&
              isDeepStrictEqual(replay.membership, membership)
            ? result({ version: replay.version, digest: replay.digest })
            : unavailable;
        }
        if (
          !await options.confirm(
            `Approve adding these exact assets to Sentinel case membership?\n${
              JSON.stringify({
                run: ref,
                runId: id,
                expectedVersion,
                requestId: request,
                membership,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          (selected && !selected()) ||
          !await context.authorizeOwnerRunCall(args) ||
          (selected && !selected())
        ) return unavailable;
        const committed = recordSentinelOperatingConstraints(path, {
          runId: id,
          evidenceRevision: revision,
          expectedVersion,
          requestId: request,
          operatorScope: "workspace-operator",
          constraints: {
            ...baseline.constraints,
            allowedAssetIds: membership.assetIds,
          },
          membership,
        });
        return committed
          ? result({ version: committed.version, digest: committed.digest })
          : unavailable;
      }
      if (action === "preview_membership" || action === "set_case_membership") {
        const {
          runId,
          allowedAssetIds,
          organizationId,
          expectedVersion,
          requestId,
        } = args;
        const update = action === "set_case_membership";
        const authorize = context?.authorizeOwnerRunCall;
        if (
          (update && (!authorize || !context?.authenticatedOwnerSessionId)) ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          (organizationId === undefined
            ? !Array.isArray(allowedAssetIds) ||
              allowedAssetIds.some((id) => typeof id !== "string")
            : typeof organizationId !== "string" ||
              allowedAssetIds !== undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "allowedAssetIds",
              "organizationId",
              ...(update ? ["expectedVersion", "requestId"] : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const activeRunId = runId.toLowerCase();
        if (
          !current?.active || current.revision !== ref.revision ||
          current.plan.runId !== activeRunId ||
          !current.result?.sharedGraph.snapshot
        ) return unavailable;
        const membership = resolveSentinelCaseMembership(
          current.result.sharedGraph.snapshot,
          {
            caseId: ref.id,
            evidenceRevision: ref.revision,
            selector: typeof organizationId === "string"
              ? { kind: "organization", organizationId }
              : { kind: "assets", assetIds: allowedAssetIds as string[] },
          },
        );
        if (!membership) return unavailable;
        const prior = readSentinelOperatingConstraints(path, activeRunId);
        const version = prior?.version ?? 0;
        if (!update) {
          return safeProjection({
            run: ref,
            runId: activeRunId,
            version,
            membership,
          });
        }
        if (
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion >= 1024 ||
          typeof requestId !== "string" || !digestPattern.test(requestId)
        ) return unavailable;
        const constraints = normalizeSentinelOperatingConstraints({
          ...(prior?.constraints ?? { deniedKinds: [] }),
          allowedAssetIds: membership.assetIds,
        });
        const request = requestId.toLowerCase();
        if (version !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            activeRunId,
            expectedVersion + 1,
          );
          if (
            replay?.requestId !== request ||
            replay.evidenceRevision !== ref.revision ||
            JSON.stringify(replay.membership) !== JSON.stringify(membership)
          ) return unavailable;
          return safeProjection({
            run: ref,
            version: replay.version,
            digest: replay.digest,
            sourceDigest: membership.snapshotDigest,
          });
        }
        if (
          !await options.confirm(
            `Approve this exact Sentinel case membership?\n${
              JSON.stringify({
                run: ref,
                runId: activeRunId,
                expectedVersion,
                requestId: request,
                selector: membership.selector,
                snapshotDigest: membership.snapshotDigest,
                assetIds: membership.assetIds,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await authorize?.(args)) return unavailable;
        const committed = recordSentinelOperatingConstraints(path, {
          runId: activeRunId,
          evidenceRevision: ref.revision,
          expectedVersion,
          requestId: request,
          operatorScope: "workspace-operator",
          constraints,
          membership,
        });
        return committed
          ? safeProjection({
            run: ref,
            version: committed.version,
            digest: committed.digest,
            sourceDigest: membership.snapshotDigest,
          })
          : unavailable;
      }
      if (action === "constraints" || action === "narrow_constraints") {
        const selectedCaseOnly = context?.authorizeSelectedSentinelCase;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof args.runId !== "string" || !digestPattern.test(args.runId) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const runId = args.runId.toLowerCase();
        const revision = ref.revision;
        if (selectedCaseOnly && !selectedCaseOnly()) return unavailable;
        if (action === "constraints") {
          if (
            Object.keys(args).some((key) =>
              !["action", "kind", "id", "revision", "runId", "limit", "version"]
                .includes(
                  key,
                )
            )
          ) return unavailable;
          const limit = args.limit ?? 3;
          const version = args.version;
          if (
            typeof limit !== "number" || !Number.isSafeInteger(limit) ||
            limit < 1 || limit > 10 ||
            (version !== undefined && (typeof version !== "number" ||
              !Number.isSafeInteger(version) || version < 1))
          ) return unavailable;
          const history = readSentinelOperatingConstraintHistory(
            path,
            runId,
            30,
            revision,
          );
          const matchesRun = current?.plan.runId === runId &&
              current.revision === ref.revision ||
            readSentinelAssessmentRevision(path, ref.revision)?.plan?.runId ===
              runId ||
            history.some((record) => record.evidenceRevision === ref.revision);
          if (!matchesRun) return unavailable;
          const record = version === undefined
            ? undefined
            : readSentinelOperatingConstraintVersion(path, runId, version);
          if (
            version !== undefined &&
            (!record || record.evidenceRevision > revision)
          ) return unavailable;
          return safeProjection({
            run: ref,
            runId,
            version: history[0]?.version ?? 0,
            history: record ? [record] : history.slice(0, limit),
          });
        }
        const { expectedVersion, requestId } = args;
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "expectedVersion",
              "requestId",
              "deniedKinds",
              "allowedAssetIds",
              "note",
            ].includes(key)
          ) ||
          !current?.active || current.plan.runId !== runId ||
          current.revision !== ref.revision ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion >= 1024 ||
          typeof requestId !== "string" ||
          !digestPattern.test(requestId)
        ) return unavailable;
        const existing = readSentinelOperatingConstraints(path, runId);
        if (
          selectedCaseOnly && (args.allowedAssetIds !== undefined ||
            typeof args.note === "string" &&
              redactCredentialText(args.note) !== args.note)
        ) {
          return unavailable;
        }
        const allowedAssetIds = selectedCaseOnly
          ? existing?.constraints.allowedAssetIds
          : args.allowedAssetIds;
        const constraints = normalizeSentinelOperatingConstraints({
          deniedKinds: args.deniedKinds,
          ...(allowedAssetIds !== undefined && { allowedAssetIds }),
          ...(args.note !== undefined && { note: args.note }),
        });
        if (
          !validateSentinelOperatingConstraintAssets(
            constraints,
            current.result?.sharedGraph.snapshot,
          )
        ) return unavailable;
        const membership = selectedCaseOnly && existing?.membership
          ? existing.membership.evidenceRevision === revision
            ? existing.membership
            : resolveSentinelCaseMembership(
              current.result?.sharedGraph.snapshot,
              {
                caseId: ref.id,
                evidenceRevision: revision,
                selector: {
                  kind: "assets",
                  assetIds: existing.membership.assetIds,
                },
              },
            )
          : undefined;
        if (selectedCaseOnly && existing?.membership && !membership) {
          return unavailable;
        }
        const update = {
          runId,
          evidenceRevision: ref.revision,
          expectedVersion,
          requestId: requestId.toLowerCase(),
          operatorScope: selectedCaseOnly
            ? "sentinel-interactive-owner"
            : "workspace-operator",
          constraints,
          ...(membership && { membership }),
        };
        if ((existing?.version ?? 0) !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            runId,
            expectedVersion + 1,
          );
          if (
            replay?.requestId !== update.requestId ||
            replay.evidenceRevision !== revision ||
            replay.operatorScope !== update.operatorScope ||
            !isDeepStrictEqual(replay.constraints, constraints) ||
            !isDeepStrictEqual(replay.membership, membership)
          ) return unavailable;
          return safeProjection({ run: ref, record: replay });
        }
        if (
          selectedCaseOnly &&
          existing?.constraints.deniedKinds.some((kind) =>
            !constraints.deniedKinds.includes(kind)
          )
        ) return unavailable;
        if (
          !await options.confirm(
            `Approve these exact Sentinel task restrictions?\n${
              JSON.stringify({ caseId: ref.id, ...update })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await context.authorizeOwnerRunCall(args) ||
          !await controller.inspect(ref) ||
          (selectedCaseOnly && !selectedCaseOnly())
        ) {
          return unavailable;
        }
        const recorded = recordSentinelOperatingConstraints(path, update);
        return recorded
          ? safeProjection({ run: ref, record: recorded })
          : unavailable;
      }
      if (action === "decision_history") {
        const { incidentId, findingId, before, limit = 5 } = args;
        const kind = incidentId === undefined ? "finding" : "incident";
        const subjectId = incidentId ?? findingId;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          (incidentId !== undefined && findingId !== undefined) ||
          typeof subjectId !== "string" || !subjectId.trim() ||
          subjectId.length > 800 ||
          (kind === "incident" && !/^incident:[0-9a-f]{64}$/.test(subjectId)) ||
          (before !== undefined &&
            (typeof before !== "number" || !Number.isSafeInteger(before) ||
              before < 1)) ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "incidentId",
              "findingId",
              "before",
              "limit",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const page = readSentinelDecisionHistory(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          kind,
          subjectId,
          before,
          limit,
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (action === "review_incident" || action === "review_finding") {
        const authorize = context?.authorizeOwnerRunCall;
        const kind = action === "review_incident" ? "incident" : "finding";
        const selector = kind === "incident" ? "incidentId" : "findingId";
        const subjectId = args[selector];
        const { disposition, note, requestId } = args;
        const incidentDecision = kind === "incident" &&
          sentinelIncidentDispositions.find((value) => value === disposition);
        const findingDecision = kind === "finding" &&
          sentinelFindingDispositions.find((value) => value === disposition);
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof subjectId !== "string" || !subjectId.trim() ||
          subjectId.length > 800 ||
          (kind === "incident" && !/^incident:[0-9a-f]{64}$/.test(subjectId)) ||
          (!incidentDecision && !findingDecision) || typeof note !== "string" ||
          !note.trim() ||
          note.length > 1000 || redactCredentialText(note) !== note ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              selector,
              "disposition",
              "note",
              "requestId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const key = requestId.toLowerCase();
        const prior = readSentinelOperatorReviewRequest(path, kind, key);
        if (prior) {
          return prior.record.revision === ref.revision &&
              prior.subjectId === subjectId &&
              prior.record.disposition === disposition &&
              prior.record.note === note.trim()
            ? safeProjection({ run: ref, review: prior.record })
            : unavailable;
        }
        const state = readSentinelAssessment(path);
        if (!state || state.revision !== ref.revision) return unavailable;
        const present = kind === "incident"
          ? (state.active || state.paused) &&
            (sentinelIncidentCandidates(state).some(({ id }) =>
              id === subjectId
            ) ||
              !!readSavedSentinelIncidentCandidate(
                path,
                ref.revision,
                subjectId,
              ))
          : state.result?.sharedGraph.snapshot?.nodes.some(({ id, kind }) =>
            id === subjectId && kind === "finding"
          );
        if (!present) return unavailable;
        if (
          !await options.confirm(
            `Record this Sentinel ${kind} review?\n${
              JSON.stringify({
                ...ref,
                [selector]: subjectId,
                disposition,
                note: note.trim(),
                requestId: key,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await authorize(args)) return unavailable;
        const committed = incidentDecision
          ? recordSentinelIncidentReview(
            path,
            ref.revision,
            subjectId,
            incidentDecision,
            note,
            key,
          )
          : findingDecision &&
            recordSentinelFindingReview(
              path,
              ref.revision,
              subjectId,
              findingDecision,
              note,
              key,
            );
        if (!committed) return unavailable;
        const current = readSentinelAssessment(path);
        if (current?.revision === ref.revision) {
          advanceAdaptiveSentinel(path, current);
        }
        const review = readSentinelOperatorReviewRequest(path, kind, key);
        return review
          ? safeProjection({ run: ref, review: review.record })
          : unavailable;
      }
      if (action === "incidents") {
        const { assetId, limit = 5, offset = 0 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          (assetId !== undefined &&
            (typeof assetId !== "string" || !assetId.trim() ||
              assetId.length > 800)) ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "assetId", "limit", "offset"]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const saved = readSentinelAssessmentRevision(path, ref.revision);
        if (!saved) return unavailable;
        const byId = new Map<string, Record<string, unknown>>();
        for (
          const candidate of [
            ...readSavedSentinelIncidentCandidates(path, ref.revision),
            ...sentinelIncidentCandidates(saved),
          ]
        ) {
          if (typeof candidate.id === "string") {
            byId.set(candidate.id, candidate);
          }
        }
        const snapshot = saved.result.sharedGraph.snapshot;
        const runId = authorizeCaseRead &&
          readSentinelRunIdForRevision(path, ref.revision);
        if (authorizeCaseRead && (!runId || !snapshot)) return unavailable;
        const controls = runId
          ? readSentinelOperatingConstraints(path, runId)?.constraints
          : undefined;
        const incidentScopes = authorizeCaseRead
          ? readSavedSentinelIncidentAssetScopes(path, ref.revision)
          : undefined;
        const candidates = [...byId.values()].filter((candidate) => {
          if (authorizeCaseRead) {
            const assets = typeof candidate.id === "string"
              ? incidentScopes?.get(candidate.id)
              : undefined;
            if (
              !assets?.length ||
              !assets.every((nodeId) =>
                sentinelOperatingConstraintsAllow(
                  controls,
                  { kind: "review_evidence", nodeId },
                  snapshot,
                )
              )
            ) return false;
          }
          return assetId === undefined || candidate.asset === assetId ||
            (Array.isArray(candidate.relatedAssetIds) &&
              candidate.relatedAssetIds.includes(assetId));
        }).sort(compareSentinelIncidentPriority);
        const reviews = readSentinelIncidentReviews(path, ref.revision);
        const incidents = candidates.slice(offset, offset + limit).map(
          (
            {
              id,
              asset,
              severity,
              startedAt,
              endedAt,
              alertCount,
              correlationBasis,
            },
          ) => ({
            id,
            asset,
            severity,
            startedAt,
            endedAt,
            alertCount,
            correlationBasis,
            disposition: reviews.find(({ incidentId }) =>
              incidentId === id
            )?.disposition ?? null,
          }),
        );
        return safeProjection({
          run: ref,
          incidents,
          total: candidates.length,
          offset,
          nextOffset: offset + incidents.length < candidates.length
            ? offset + incidents.length
            : null,
        });
      }
      if (action === "case_alert") {
        const { alertId } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          typeof alertId !== "string" ||
          !/^case-alert:[a-f0-9]{64}$/.test(alertId) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "alertId"].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const alerts = readSentinelAssessmentAlerts(path, ref.revision);
        const alert = alerts &&
          resolveSentinelIncidentAlerts(alerts, [alertId])[0];
        if (authorizeCaseRead && alert) {
          const runId = readSentinelRunIdForRevision(path, ref.revision);
          const snapshot = readSentinelAssessmentRevision(path, ref.revision)
            ?.result.sharedGraph.snapshot;
          if (
            !runId || !snapshot || !sentinelTelemetryAssetResolver(
              snapshot,
              readSentinelOperatingConstraints(path, runId)?.constraints,
            )(alert)
          ) return unavailable;
        }
        return alert
          ? safeProjection({ run: ref, alertId, alert })
          : unavailable;
      }
      if (action === "defense_coverage" || action === "incident_alerts") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const {
          action: _action,
          kind: _kind,
          id: _id,
          revision: _revision,
          ...query
        } = args;
        const scope = {
          snapshotPath: resolveSentinelCasePath(options.baseDir, ref.id),
          assessmentRevision: ref.revision,
        };
        const result = action === "defense_coverage"
          ? await readDefenseCoverage(
            {
              ...scope,
              webContainmentConfigured: options.webContainmentConfigured,
            },
            query,
            authorizeCaseRead ? {} : undefined,
          )
          : queryIncidentAlerts(
            scope,
            query,
            true,
            authorizeCaseRead ? {} : undefined,
          );
        return result.startsWith("Error:")
          ? result
          : safeProjection({ run: ref, evidence: JSON.parse(result) });
      }
      if (action === "inventory") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const {
          action: _action,
          kind: _kind,
          id: _id,
          revision: _revision,
          ...query
        } = args;
        const page = readOperatorSentinelInventory(
          options.baseDir,
          ref,
          query,
          context?.ceiling ?? "INTERNAL",
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (
        action === "save_digest" || action === "list_digests" ||
        action === "expand_digest"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const result = await executeOperatorEvidenceDigest(
          options.baseDir,
          ref,
          args,
          options.confirm,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (action === "facts") {
        const { factId, limit = 3, offset = 0, query, cursor } = args;
        const phrase = normalizeSentinelGraphFactQuery(query);
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "factId",
              "limit",
              "offset",
              "query",
              "cursor",
            ]
              .includes(key)
          ) ||
          (factId !== undefined && (typeof factId !== "string" ||
            !/^worker-graph-fact:[a-f0-9]{64}$/.test(factId) ||
            args.offset !== undefined || args.limit !== undefined ||
            query !== undefined || cursor !== undefined)) ||
          (cursor !== undefined &&
            (!isSentinelGraphFactCursor(cursor) ||
              args.offset !== undefined)) ||
          (query !== undefined && phrase === undefined) ||
          (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
            limit < 1 || limit > 5) ||
          (typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0 || offset > 4096) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const adaptive = readSentinelAdaptiveEvidenceMapping(
          path,
          ref.revision,
        );
        const scope = {
          caseId: ref.id,
          evidenceRevision: ref.revision,
          runId: adaptive?.goal.id ?? "",
        };
        const page = cursor !== undefined
          ? adaptive
            ? readSentinelCaseGraphFactCursorPage(path, scope, {
              cursor,
              query: phrase,
              limit,
              audience: "owner",
              countMatches: true,
            }, readSentinelOperatingConstraints(path, scope.runId))
            : cursor === "start"
            ? { facts: [], nextOffset: null, nextCursor: null, total: 0 }
            : undefined
          : adaptive
          ? readSentinelCaseGraphFacts(path, scope, {
            id: factId,
            limit,
            offset,
            query: phrase,
            countMatches: true,
          })
          : factId === undefined
          ? { facts: [], nextOffset: null, total: 0 }
          : undefined;
        if (!page) return unavailable;
        const visible = (
          { requestId: _requestId, ...fact }: SentinelWorkerGraphFact,
        ) => fact;
        return safeProjection({
          run: ref,
          page: "fact" in page ? { fact: visible(page.fact) } : {
            facts: page.facts.map(visible),
            nextOffset: page.nextOffset,
            total: page.total,
            ...("nextCursor" in page && { nextCursor: page.nextCursor }),
          },
        });
      }
      if (action === "traces" && ref.kind === "workflow") {
        const { cursor, limit, sequence, query } = args;
        if (
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "cursor", "sequence", "limit", "query"]
              .includes(key)
          ) ||
          (cursor !== undefined && typeof cursor !== "string") ||
          (limit !== undefined && typeof limit !== "number") ||
          (sequence !== undefined && typeof sequence !== "number") ||
          (query !== undefined && typeof query !== "string") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const page = options.workflows?.traces(ref.id, "INTERNAL", {
          cursor,
          limit,
          sequence,
          query,
        });
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (action === "intermediate_observations") {
        const { observationId, offset = 0, limit = 5 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (observationId !== undefined &&
            (typeof observationId !== "string" ||
              !/^workflow-observation:[a-f0-9]{64}$/.test(observationId) ||
              args.offset !== undefined || args.limit !== undefined)) ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "observationId",
              "offset",
              "limit",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        if (!runId) return unavailable;
        const page = readSentinelIntermediateWorkflowObservations(
          path,
          ref.revision,
          runId,
          typeof observationId === "string"
            ? { id: observationId }
            : { offset, limit },
        );
        if (!page) return unavailable;
        if ("observation" in page && page.observation) {
          const observation = page.observation;
          const scope = { caseId: ref.id, path, runId };
          if (
            !await authorizeSentinelWorkflowObservation(
              options.readLiveWorkflow,
              context,
              scope,
              observation,
              () =>
                readSentinelRunIdForRevision(
                    path,
                    observation.evidenceRevision,
                  ) === runId &&
                isDeepStrictEqual(
                  readSentinelIntermediateWorkflowObservations(
                    path,
                    observation.evidenceRevision,
                    runId,
                    { id: observation.id },
                  )?.observation,
                  observation,
                ),
            )
          ) return unavailable;
        }
        return safeProjection({ run: ref, page });
      }
      if (
        action === "list_trace_workers" || action === "worker_trace_progress" ||
        action === "worker_trace_result" ||
        action === "attach_native_workflow_control"
      ) {
        const nativeAttach = action === "attach_native_workflow_control";
        const result = action === "worker_trace_result" || nativeAttach;
        const progress = action === "worker_trace_progress" || result;
        const {
          taskId,
          stepIndices,
          workflowRunNumber,
          controlId,
          validUntil,
        } = args;
        const { query = "", limit = 10, offset = 0 } = args;
        if (
          !context || !canFlowTo("INTERNAL", context.ceiling ?? "INTERNAL") ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (progress && (typeof taskId !== "string" ||
            !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
            args.query !== undefined)) ||
          (stepIndices !== undefined &&
            (!Array.isArray(stepIndices) || !stepIndices.length ||
              stepIndices.length > 10 || stepIndices.some((index) =>
                !Number.isSafeInteger(index) || index < 0
              ))) ||
          (nativeAttach &&
            (typeof controlId !== "string" || typeof validUntil !== "string" ||
              typeof workflowRunNumber !== "number")) ||
          (workflowRunNumber !== undefined &&
            (!result || typeof workflowRunNumber !== "number" ||
              !Number.isSafeInteger(workflowRunNumber) ||
              workflowRunNumber < 1)) ||
          typeof query !== "string" || query.length > 256 ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 || typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 10 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "limit",
              "offset",
              ...(nativeAttach ? ["controlId", "validUntil"] : []),
              ...(progress
                ? ["taskId", "stepIndices", "workflowRunNumber", "latestResult"]
                : ["query"]),
            ]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) {
          return unavailable;
        }
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        const history = readHistoricalAdaptiveSentinel(
          path,
          ref.revision,
          undefined,
          false,
          result,
        );
        if (!runId || (history && history.goal.id !== runId)) {
          return unavailable;
        }
        if (progress) {
          const worker = history?.modelReviewStates.find((item) =>
            item.taskId === taskId
          );
          if (
            action === "worker_trace_result" &&
            Array.isArray(stepIndices) && stepIndices.length > 1
          ) {
            if (
              args.offset !== undefined || args.limit !== undefined ||
              workflowRunNumber !== undefined
            ) {
              return unavailable;
            }
            const indices = [...new Set(stepIndices as number[])];
            if (indices.length === 1) {
              return await execute({ ...args, stepIndices: indices }, context);
            }

            const policy = () => {
              const current = readSentinelOperatingConstraints(path, runId);
              return JSON.stringify([current?.version, current?.digest]);
            };
            const initialPolicy = policy();
            const steps: { index: number; result: unknown }[] = [];
            const unavailableStepIndices: number[] = [];
            const omittedStepIndices = indices.slice(5);
            const project = () =>
              safeProjection({
                run: ref,
                runId,
                taskId,
                steps,
                ...(unavailableStepIndices.length &&
                  { unavailableStepIndices }),
                ...(omittedStepIndices.length && { omittedStepIndices }),
              });
            for (const index of indices.slice(0, 5)) {
              const single = await execute(
                { ...args, stepIndices: [index] },
                context,
              );
              if (!single.startsWith("{")) {
                unavailableStepIndices.push(index);
                continue;
              }
              const returned = JSON.parse(single);
              if (
                returned?._classification !== "INTERNAL" ||
                returned.runId !== runId || returned.taskId !== taskId ||
                returned.index !== index || !Object.hasOwn(returned, "result")
              ) {
                return unavailable;
              }
              steps.push({ index, result: returned.result });
              if (project().startsWith("Error:")) {
                steps.pop();
                omittedStepIndices.push(index);
              }
            }
            omittedStepIndices.sort((left, right) =>
              indices.indexOf(left) - indices.indexOf(right)
            );
            return steps.length && policy() === initialPolicy
              ? project()
              : unavailable;
          }
          if (result) {
            const workerStatus = worker?.archivedProgress &&
                worker.status !== "stopped"
              ? "interrupted"
              : worker?.status;
            const latest = args.latestResult === true;
            const index = latest
              ? (workerStatus === "stopped" || workerStatus === "interrupted")
                ? worker?.progressSteps?.findLastIndex(({ outcome }) =>
                  outcome === "returned"
                )
                : undefined
              : Array.isArray(stepIndices) && stepIndices.length === 1
              ? stepIndices[0]
              : undefined;
            if (
              typeof index !== "number" || index < 0 ||
              args.offset !== undefined || args.limit !== undefined
            ) {
              return unavailable;
            }
            const projectResult = (value: Record<string, unknown>) =>
              safeProjection({
                ...value,
                ...(latest && { status: workerStatus }),
                ...(latest && worker?.archivedProgress && { archived: true }),
              });
            const savedStep = (
              state: typeof history,
              stepIndex = index,
            ): SentinelReadTrace | undefined => {
              if (state?.goal.id !== runId) {
                return;
              }
              const review = state.modelReviews.find((item) =>
                item.taskId === taskId
              )
                ?.steps[stepIndex] ??
                state.modelReviewStates.find((item) =>
                  item.taskId === taskId
                )
                  ?.progressSteps?.[stepIndex];
              if (review || typeof taskId !== "string") return review;
              const publication = readSentinelWorkflowPublicationStep(
                path,
                ref.revision!,
                runId,
                taskId,
                stepIndex,
              );
              return publication && {
                tool: "sentinel_publish_workflow_observation",
                outcome: "returned",
                target: publication.id,
              };
            };
            const step = savedStep(history);
            if (
              workflowRunNumber !== undefined &&
              step?.tool !== "sentinel_live_workflow_status"
            ) {
              return unavailable;
            }
            if (
              step?.tool === "sentinel_shared_topology_source" ||
              step?.tool === "sentinel_shared_finding_source"
            ) {
              const authorize = context.authorizeSentinelTraceRead;
              const task = history?.tasks.find(({ id }) => id === taskId);
              const citation = step.goalReceiptRead;
              const args = citation &&
                sentinelGoalReceiptReadArguments(step.tool, citation.args);
              if (
                !task || !authorize || !citation || !args ||
                step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, step.tool, args)) return unavailable;
              const text = await reopenSentinelSourceResult(
                options.baseDir,
                path,
                ref.revision,
                step,
                args,
              );
              if (
                !text ||
                !await authorize(scope, step.tool, args, text) ||
                text !== await reopenSentinelSourceResult(
                    options.baseDir,
                    path,
                    ref.revision,
                    step,
                    args,
                  )
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (step?.tool === "sentinel_shared_asset_links") {
              const authorize = context.authorizeSentinelTraceRead;
              const task = history?.tasks.find(({ id }) => id === taskId);
              const receipt = step.goalReceiptRead;
              const args = receipt &&
                sentinelSharedAssetLinksArgs(receipt.args);
              const text = step.sharedAssetLinksPage;
              if (
                !task || !authorize || !receipt || !args || !text ||
                step.outcome !== "returned" ||
                createHash("sha256").update(text).digest("hex") !==
                  receipt.sha256
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, step.tool, args)) return unavailable;
              const result = parseSharedAssetLinkPage(
                text,
                ref.revision!,
                args,
              );
              if (
                !result ||
                !allowsRetainedSentinelSharedTopology(
                  path,
                  ref.revision,
                  result,
                ) ||
                !await authorize(scope, step.tool, args, text) ||
                !allowsRetainedSentinelSharedTopology(
                  path,
                  ref.revision,
                  result,
                )
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
                undefined,
                false,
                true,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({ run: ref, runId, taskId, index, result });
            }
            if (step?.tool === "sentinel_assigned_target") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const digest = step.resultSha256 ?? step.resultSnapshot?.sha256;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                !digest || step.target !== task.nodeId
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, step.tool, {})) return unavailable;
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )?.result.sharedGraph.snapshot;
              if (!snapshot) return unavailable;
              const allowed = readSentinelOperatingConstraints(path, runId)
                ?.constraints.allowedAssetIds;
              const text = projectSentinelAssignedTarget(
                loadSentinelGraph(snapshot),
                task,
                ref.revision,
                allowed,
              );
              if (
                text.startsWith("Error:") ||
                createHash("sha256").update(text).digest("hex") !==
                  digest ||
                !await authorize(scope, step.tool, {}, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_worker_trace_search" &&
              step.workerTracePage
            ) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const page = readSentinelWorkerTracePageReference(
                step.workerTracePage,
              );
              if (
                !task || !authorize || !page || step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (
                !await authorize(scope, step.tool, page.args)
              ) return unavailable;
              const text = reopenSentinelWorkerTraceSearch(
                path,
                ref.revision,
                task.id,
                page,
              );
              if (
                !text ||
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, page.args, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_provenance_node" &&
              step.provenanceNodePage
            ) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const page = readSentinelProvenanceNodeReference(
                step.provenanceNodePage,
              );
              if (
                !task || !authorize || !page || step.outcome !== "returned" ||
                step.target !== page.args.node
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (
                !await authorize(scope, step.tool, page.args)
              ) return unavailable;
              const text = step.workerProvenanceNodeResult === undefined
                ? reopenSentinelProvenanceNode(
                  path,
                  ref.revision,
                  page,
                  task.id,
                )
                : readSavedSentinelProvenanceNode(
                  step.workerProvenanceNodeResult,
                  page,
                  ref.revision,
                );
              const scoped = () =>
                text && allowsRetainedSentinelProvenancePage(
                  path,
                  ref.revision!,
                  page.args,
                  text,
                  task.id,
                );
              if (
                !text || !scoped() ||
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, page.args, text) || !scoped()
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
                undefined,
                false,
                true,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_provenance_search" &&
              step.provenanceSearchPage
            ) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const page = readSentinelProvenanceSearchReference(
                step.provenanceSearchPage,
              );
              if (
                !task || !authorize || !page || step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (
                !await authorize(scope, step.tool, page.args)
              ) return unavailable;
              const text = step.provenanceSearchResult === undefined
                ? reopenSentinelProvenanceSearch(
                  path,
                  ref.revision,
                  page,
                  task.id,
                )
                : readSavedSentinelProvenanceSearch(
                  step.provenanceSearchResult,
                  page,
                  ref.revision,
                );
              const scoped = () =>
                text && allowsRetainedSentinelProvenancePage(
                  path,
                  ref.revision!,
                  page.args,
                  text,
                  task.id,
                );
              if (
                !text || !scoped() ||
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, page.args, text) || !scoped()
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
                undefined,
                false,
                true,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (step?.tool === "sentinel_case_hints") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const citation = step.goalReceiptRead;
              const args = citation &&
                sentinelGoalReceiptReadArguments(step.tool, citation.args);
              const first = step.caseHintFirstId;
              if (
                !task || !authorize || !args || !citation ||
                step.outcome !== "returned" ||
                (args.assignedTraffic &&
                  (!task.nodeId || step.target !== task.nodeId)) ||
                (first !== null &&
                  (typeof first !== "number" ||
                    !Number.isSafeInteger(first + 1) ||
                    first < 1 ||
                    args.before !== undefined && first >= args.before))
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, step.tool, args)) return unavailable;
              const text = first === null
                ? JSON.stringify({ hints: [], nextBefore: null })
                : projectCaseHints(
                  path,
                  args.limit ?? 3,
                  first + 1,
                  ref.revision,
                  args.assignedTraffic ? task.nodeId ?? undefined : undefined,
                );
              if (
                createHash("sha256").update(text).digest("hex") !==
                  citation.sha256 ||
                !await authorize(scope, step.tool, args, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_incident_alerts" ||
              step?.tool === "sentinel_defense" ||
              step?.tool === "sentinel_goal_state" ||
              step?.tool === "sentinel_path" ||
              step?.tool === "sentinel_saved_workflow_receipt" ||
              step?.tool === "sentinel_prior_assigned_evidence" ||
              isSentinelInventoryFindingRead(step?.tool) ||
              isSentinelInventoryNeighborhoodRead(step?.tool)
            ) {
              if (!step) return unavailable;
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const citation = step.goalReceiptRead;
              const args = citation &&
                sentinelGoalReceiptReadArguments(step.tool, citation.args);
              if (
                !task || !authorize || !citation || !args ||
                step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, step.tool, args)) return unavailable;
              const readOptions = {
                snapshotPath: path,
                assessmentRevision: ref.revision,
                webContainmentConfigured: options.webContainmentConfigured,
              };
              const carriedSnapshot =
                step.tool === "sentinel_prior_assigned_evidence"
                  ? readSentinelAssessmentRevision(path, ref.revision)?.result
                    .sharedGraph.snapshot
                  : undefined;
              const goalState = step.tool === "sentinel_goal_state" &&
                readSentinelGoalStateProjection(step.goalStateProjection);
              const authorizeSavedWorkflow = async (text: string) => {
                const assetId = task.nodeId;
                const source = task.plannerRound?.githubWorkflowCitation;
                const evidenceRevision = ref.revision;
                const reader = options.readLiveWorkflow;
                const allowDestination = context.authorizeWorkflowDestination;
                if (
                  !assetId || !source || !evidenceRevision || !reader ||
                  !allowDestination
                ) return false;
                const receipt = readSentinelGitHubWorkflowReadReceipt(
                  JSON.parse(text).receipt,
                  evidenceRevision,
                );
                if (!receipt) return false;
                const isCurrent = () =>
                  readSentinelPrerequisiteWorkflowReceipt(
                    path,
                    evidenceRevision,
                    task,
                  ) === text;
                const reopened = await reader({
                  caseId: ref.id,
                  assetId,
                  evidenceRevision,
                  signal: new AbortController().signal,
                  isCurrent,
                  resumeOnly: true,
                  loadSaved: () => receipt,
                  authorize: (destination) =>
                    allowDestination(
                      destination,
                      evidenceRevision,
                      source.sourceTaskId,
                    ),
                });
                return isDeepStrictEqual(reopened, receipt) &&
                  await context.authorizeSavedResponse(
                    "sentinel_live_workflow_status",
                    JSON.stringify({ targetId: assetId, ...receipt }),
                    "INTERNAL",
                  ) && isCurrent();
              };
              const text = step.tool === "sentinel_incident_alerts"
                ? queryIncidentAlerts(
                  readOptions,
                  args,
                  task.kind === "review_incident" &&
                    task.nodeId === args.incidentId,
                  { assignment: task },
                )
                : step.tool === "sentinel_defense"
                ? await readDefenseCoverage(readOptions, args, {
                  assignment: task,
                })
                : step.tool === "sentinel_saved_workflow_receipt"
                ? readSentinelPrerequisiteWorkflowReceipt(
                  path,
                  ref.revision,
                  task,
                )
                : step.tool === "sentinel_prior_assigned_evidence"
                ? carriedSnapshot &&
                  readSentinelCarriedEvidence(
                    path,
                    ref.revision,
                    task,
                    carriedSnapshot,
                  )
                : step.tool === "sentinel_goal_state"
                ? goalState &&
                  readHistoricalSentinelGoalState(
                    path,
                    ref.revision,
                    args,
                    goalState,
                  )
                : step.tool === "sentinel_path" && step.plannerProvenancePath
                ? allowsSavedSentinelProvenancePath(
                    path,
                    ref.revision,
                    args,
                    step.plannerProvenancePath,
                    task.id,
                  )
                  ? step.plannerProvenancePath
                  : undefined
                : await readSentinelGraphProjection(
                  path,
                  ref.revision,
                  step.tool,
                  args,
                  true,
                );
              if (
                !text || text.startsWith("Error:") ||
                createHash("sha256").update(text).digest("hex") !==
                  citation.sha256 ||
                (step.tool === "sentinel_saved_workflow_receipt" &&
                  !await authorizeSavedWorkflow(text)) ||
                !await authorize(scope, step.tool, args, text) ||
                (step.tool === "sentinel_saved_workflow_receipt" &&
                  !await authorizeSavedWorkflow(text)) ||
                (step.tool === "sentinel_prior_assigned_evidence" &&
                  (!carriedSnapshot || readSentinelCarriedEvidence(
                        path,
                        ref.revision,
                        task,
                        carriedSnapshot,
                      ) !== text)) ||
                (step.tool === "sentinel_incident_alerts" &&
                  queryIncidentAlerts(
                      readOptions,
                      args,
                      task.kind === "review_incident",
                      {
                        assignment: task,
                      },
                    ) !== text) ||
                (step.tool === "sentinel_defense" &&
                  await readDefenseCoverage(readOptions, args, {
                      assignment: task,
                    }) !== text) ||
                (isSentinelArchivedInventoryRead(step.tool, args) &&
                  await readSentinelGraphProjection(
                      path,
                      ref.revision,
                      step.tool,
                      args,
                      true,
                    ) !== text) ||
                (step.tool === "sentinel_path" && args.graph === "provenance" &&
                  !allowsSavedSentinelProvenancePath(
                    path,
                    ref.revision,
                    args,
                    text,
                    task.id,
                  ))
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
                undefined,
                false,
                true,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (step?.tool === "sentinel_worker_findings") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const page = readSentinelFindingPageReference(step.findingPage);
              const citation = step.goalReceiptRead;
              const receiptId = citation?.args.receiptId;
              const revision = citation?.args.revision;
              if (
                !task?.nodeId || !authorize ||
                (!page && (!citation || !receiptId)) ||
                step.outcome !== "returned" ||
                (step.target !== undefined && step.target !== receiptId)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = page?.args ?? {
                receiptId,
                ...(revision !== undefined && { revision }),
              };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )?.result.sharedGraph.snapshot;
              const targetId = task.kind === "review_evidence"
                ? snapshot && executionFindingAsset(snapshot, task.nodeId)
                : task.nodeId;
              if (!targetId) return unavailable;
              const recordScope = {
                caseId: ref.id,
                runId,
                taskId: task.id,
                evidenceRevision: ref.revision,
                targetId,
              };
              const reopen = (id: string, revision?: number) =>
                reopenSentinelGoalReceiptRead(
                  path,
                  recordScope,
                  step.tool,
                  {
                    receiptId: id,
                    ...(revision !== undefined && { revision }),
                  },
                );
              let text: string | undefined;
              if (page) {
                if (
                  page.args.beforeReceiptId &&
                  !reopen(page.args.beforeReceiptId, page.args.revision)
                ) return unavailable;
                const records = [];
                for (const id of page.ids) {
                  const item = reopen(id, page.args.revision);
                  if (!item) return unavailable;
                  records.push(JSON.parse(item.result).record);
                }
                text = JSON.stringify({
                  _classification: "INTERNAL",
                  ...(!page.empty &&
                    {
                      caseId: ref.id,
                      evidenceRevision: page.args.revision ?? ref.revision,
                    }),
                  records,
                  nextBeforeReceiptId: page.nextBeforeReceiptId,
                });
              } else if (receiptId) {
                text = reopen(receiptId, revision)?.result;
              }
              if (
                !text ||
                createHash("sha256").update(text).digest("hex") !==
                  (page?.sha256 ?? citation?.sha256) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_worker_observation" &&
              step.observationSearch
            ) {
              const page = readSentinelObservationSearchReference(
                step.observationSearch,
              );
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !task || !authorize || !page || step.outcome !== "returned" ||
                typeof page.args.query !== "string" ||
                (page.args.revision !== undefined &&
                  page.args.revision !== ref.revision)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (
                !await authorize(scope, step.tool, page.args)
              ) return unavailable;
              const reopen = () =>
                reopenSentinelObservationSearch(
                  path,
                  ref.revision!,
                  runId,
                  page,
                  task.id,
                );
              const text = reopen();
              if (
                !text ||
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, page.args, text) ||
                reopen() !== text
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (
              step?.tool === "sentinel_worker_observation" &&
              step.taskObservationPage
            ) {
              const page = readSentinelTaskObservationPageReference(
                step.taskObservationPage,
              );
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !page || !task?.nodeId || !authorize ||
                step.outcome !== "returned" ||
                step.target !== page.task
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = {
                task: page.task,
                ...(page.offset && { offset: page.offset }),
              };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const reopen = () =>
                reopenSentinelGoalReceiptRead(
                  path,
                  {
                    caseId: ref.id,
                    runId,
                    taskId: task.id,
                    evidenceRevision: ref.revision!,
                    targetId: task.nodeId!,
                  },
                  step.tool,
                  call,
                );
              const retained = reopen();
              if (
                !retained ||
                createHash("sha256").update(retained.result).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, call, retained.result) ||
                reopen()?.result !== retained.result
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(retained.result),
              });
            }
            if (step?.tool === "sentinel_graph_facts" && step.graphFactPage) {
              const page = readSentinelGraphFactPageReference(
                step.graphFactPage,
              );
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !page || !task?.nodeId || !authorize ||
                step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = page.offset ? { offset: page.offset } : {};
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const factScope = {
                caseId: ref.id,
                runId,
                evidenceRevision: ref.revision,
                targetId: task.nodeId,
              };
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )?.result.sharedGraph.snapshot;
              if (!snapshot) return unavailable;
              const snapshotDigest = digestSentinelSnapshot(snapshot);
              const facts = page.ids.map((id) =>
                readSentinelWorkerGraphFact(path, factScope, id)
              );
              if (
                facts.some((fact) => fact?.snapshotDigest !== snapshotDigest)
              ) return unavailable;
              const result = {
                _classification: "INTERNAL",
                facts,
                nextOffset: page.nextOffset,
              };
              const text = JSON.stringify(result);
              if (
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({ run: ref, runId, taskId, index, result });
            }
            if (step?.tool === "sentinel_graph_facts") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const id = step.goalReceiptRead?.args.id ?? step.target;
              const digest = step.goalReceiptRead?.sha256 ?? step.resultSha256;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                !id || !/^worker-graph-fact:[a-f0-9]{64}$/.test(id) ||
                !digest ||
                (step.target !== undefined && step.target !== id)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { id };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const fact = readSentinelWorkerGraphFact(path, {
                caseId: ref.id,
                runId,
                evidenceRevision: ref.revision,
                targetId: task.nodeId,
              }, id);
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )
                ?.result.sharedGraph.snapshot;
              if (
                !fact || !snapshot ||
                fact.snapshotDigest !== digestSentinelSnapshot(snapshot)
              ) {
                return unavailable;
              }
              const retained = { _classification: "INTERNAL", ...fact };
              const text = JSON.stringify(retained);
              if (
                createHash("sha256").update(text).digest("hex") !== digest ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (
              step?.tool === "sentinel_intermediate_workflow_observation" &&
              step.intermediateWorkflowPage
            ) {
              const page = sentinelIntermediateWorkflowPageReference(
                step.intermediateWorkflowPage,
              );
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !page || !task?.nodeId || !authorize ||
                step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (
                !await authorize(scope, step.tool, page.args)
              ) return unavailable;
              const observations = [];
              for (const id of page.ids) {
                const row = readSentinelIntermediateWorkflowObservations(
                  path,
                  ref.revision,
                  runId,
                  { id },
                );
                const observation = row && "observation" in row
                  ? row.observation
                  : undefined;
                if (
                  !observation || observation.taskId === task.id ||
                  observation.targetId !== task.nodeId ||
                  observation.evidenceRevision !== ref.revision
                ) return unavailable;
                observations.push({
                  id,
                  sourceTaskId: observation.taskId,
                  observedAt: observation.receipt.observedAt,
                });
              }
              const result = {
                evidenceRevision: ref.revision,
                targetId: task.nodeId,
                observations,
                nextOffset: page.nextOffset,
              };
              const text = JSON.stringify(result);
              if (
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, page.args, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({ run: ref, runId, taskId, index, result });
            }
            if (step?.tool === "sentinel_intermediate_workflow_observation") {
              const authorize = context.authorizeSentinelTraceRead;
              const task = history?.tasks.find(({ id }) => id === taskId);
              const citation = step.intermediateWorkflowObservation;
              const digest = step.goalReceiptRead?.sha256;
              if (
                !authorize || !task?.nodeId || !citation || !digest ||
                step.outcome !== "returned" ||
                step.target !== citation.observationId ||
                step.goalReceiptRead?.args.id !== citation.observationId ||
                citation.targetId !== task.nodeId ||
                citation.evidenceRevision !== ref.revision
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { id: citation.observationId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const page = readSentinelIntermediateWorkflowObservations(
                path,
                ref.revision,
                runId,
                call,
              );
              const observation = page && "observation" in page
                ? page.observation
                : undefined;
              if (
                !observation || observation.taskId === task.id ||
                observation.taskId !== citation.sourceTaskId ||
                observation.targetId !== task.nodeId ||
                observation.stepIndex !== citation.sourceStepIndex ||
                observation.receipt.resultSha256 !== citation.resultSha256
              ) return unavailable;
              const isCurrent = () =>
                isDeepStrictEqual(
                  savedStep(
                    readHistoricalAdaptiveSentinel(path, ref.revision!),
                  ),
                  step,
                );
              if (
                !await authorizeSentinelWorkflowObservation(
                  options.readLiveWorkflow,
                  context,
                  { caseId: ref.id, path, runId },
                  observation,
                  isCurrent,
                )
              ) return unavailable;
              const result = JSON.stringify(observation);
              if (
                createHash("sha256").update(result).digest("hex") !== digest ||
                !await authorize(scope, step.tool, call, result) ||
                !await authorizeSentinelWorkflowObservation(
                  options.readLiveWorkflow,
                  context,
                  { caseId: ref.id, path, runId },
                  observation,
                  isCurrent,
                )
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: observation,
              });
            }
            if (
              step?.tool === "sentinel_shared_asset_discoveries" &&
              step.discoveryPage
            ) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const page = readSentinelDiscoveryPageReference(
                step.discoveryPage,
              );
              if (
                !task?.nodeId || !authorize || !page ||
                step.outcome !== "returned" ||
                page.result.discoveries.some(({ sourceCaseId }) =>
                  sourceCaseId === ref.id
                )
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = page.after ? { after: page.after } : {};
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const text = JSON.stringify(page.result);
              if (
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: page.result,
              });
            }
            if (step?.tool === "sentinel_shared_asset_discoveries") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const citation = step.sharedAssetDiscovery;
              const digest = step.goalReceiptRead?.sha256;
              if (
                !task?.nodeId || !authorize || !citation || !digest ||
                step.goalReceiptRead?.args.id !== citation.id ||
                step.outcome !== "returned" || step.target !== citation.id
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { id: citation.id };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const reopened = reopenCitedDiscovery(
                options.baseDir,
                path,
                ref.id,
                ref.revision,
                runId,
                step,
                task.nodeId,
              );
              if (
                !reopened ||
                !await authorize(scope, step.tool, call, reopened.text) ||
                !reopened.allowsEndpoints()
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: reopened.retained,
              });
            }
            if (step?.tool === "sentinel_submit_asset_discovery") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const requestId = step.assetDiscoveryRequestId;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                !step.target || !requestId
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, requestId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              await Deno.lstat(
                join(options.baseDir, "data", "sentinel-asset-discoveries.db"),
              );
              const store = openSentinelAssetDiscoveryStore(options.baseDir);
              let record;
              try {
                record = store.readProposalReceipt(requestId);
              } finally {
                store.close();
              }
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )
                ?.result.sharedGraph.snapshot;
              if (
                !record || !snapshot || record.id !== step.target ||
                record.sourceCaseId !== ref.id || record.taskId !== task.id ||
                record.evidenceRevision !== ref.revision ||
                record.claim.assetId !== task.nodeId ||
                record.sourceDigest !== digestSentinelSnapshot(snapshot) ||
                !verifySentinelAssetDiscovery(
                  loadSentinelGraph(snapshot),
                  record.claim,
                )
              ) return unavailable;
              const retained = {
                id: record.id,
                status: record.status,
                claim: record.claim,
              };
              const text = JSON.stringify(retained);
              if (
                (step.resultSha256 !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    step.resultSha256) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== record.id ||
                saved.assetDiscoveryRequestId !== requestId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === "sentinel_prove_goal") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const requestId = step.goalProofRequestId;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                (!step.target && !worker?.archivedProgress) || !requestId
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, requestId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const opened = readSentinelWorkerGoalProofTraceReceipt(
                path,
                ref.revision,
                runId,
                task.id,
                task.nodeId,
                requestId,
              );
              if (
                !opened ||
                (step.target !== undefined &&
                  opened.receipt.proof.reference !== step.target)
              ) return unavailable;
              const retained = {
                _classification: "INTERNAL",
                ...opened.receipt,
              };
              const text = JSON.stringify(retained);
              if (
                (step.resultSha256 !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    step.resultSha256) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== step.target ||
                saved.goalProofRequestId !== requestId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === "sentinel_propose_goal") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const proposalId = step.target;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                typeof proposalId !== "string" ||
                !/^goal-proposal:[a-f0-9]{64}$/.test(proposalId)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, proposalId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const proposal = readSentinelWorkerGoalProposalTraceReceipt(
                path,
                {
                  runId,
                  revision: ref.revision,
                  assignmentId: task.id,
                  targetId: task.nodeId,
                },
                proposalId,
              );
              if (!proposal) return unavailable;
              const retained = { _classification: "INTERNAL", proposal };
              const text = JSON.stringify(retained);
              if (
                (step.resultSha256 !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    step.resultSha256) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== proposalId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === "sentinel_publish_workflow_observation") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const observationId = step.target;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                typeof observationId !== "string" ||
                !/^workflow-observation:[a-f0-9]{64}$/.test(observationId)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, observationId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const page = readSentinelIntermediateWorkflowObservations(
                path,
                ref.revision,
                runId,
                { id: observationId },
              );
              const observation = page && "observation" in page
                ? page.observation
                : undefined;
              if (
                !observation || observation.taskId !== task.id ||
                observation.targetId !== task.nodeId ||
                observation.stepIndex >= index
              ) return unavailable;
              const retained = {
                id: observation.id,
                targetId: observation.targetId,
                evidenceRevision: observation.evidenceRevision,
              };
              const text = JSON.stringify(retained);
              const expected = (step as SentinelReadTrace).resultSha256;
              if (
                (expected !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    expected) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== observationId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === "sentinel_publish_graph_fact") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const factId = step.target;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                typeof factId !== "string" ||
                !/^worker-graph-fact:[a-f0-9]{64}$/.test(factId)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, factId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const fact = readSentinelWorkerGraphFact(path, {
                caseId: ref.id,
                runId,
                evidenceRevision: ref.revision,
                targetId: task.nodeId,
                taskId: task.id,
              }, factId);
              if (!fact) return unavailable;
              const retained = { _classification: "INTERNAL", ...fact };
              const text = JSON.stringify(retained);
              const expected = (step as SentinelReadTrace).resultSha256;
              if (
                (expected !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    expected) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== factId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step && isSentinelFindingMutation(step.tool)) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const receiptId = step.target;
              if (
                !task?.nodeId || !authorize || step.outcome !== "returned" ||
                !receiptId
              ) {
                return unavailable;
              }
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, receiptId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )
                ?.result.sharedGraph.snapshot;
              const targetId = task.kind === "review_evidence" &&
                  step.tool !== "sentinel_update_finding_report" && snapshot
                ? executionFindingAsset(snapshot, task.nodeId)
                : task.nodeId;
              let inconclusive;
              if (
                step.tool === INCONCLUSIVE_RECHECK_TOOL &&
                targetId && snapshot && hasSentinelWorkerFindingJournal(path)
              ) {
                const journal = openSentinelWorkerFindingStore(path);
                try {
                  const row = journal.readInconclusive(receiptId);
                  if (
                    row?.caseId === ref.id && row.runId === runId &&
                    row.evidenceRevision === ref.revision &&
                    row.taskId === task.id &&
                    row.evidenceId === task.nodeId &&
                    row.targetId === targetId &&
                    row.snapshotDigest === digestSentinelSnapshot(snapshot)
                  ) inconclusive = row;
                } finally {
                  journal.close();
                }
              }
              const receipt = inconclusive ?? (targetId &&
                readSentinelWorkerFindingTraceReceipt(path, {
                  caseId: ref.id,
                  runId,
                  evidenceRevision: ref.revision,
                  taskId: task.id,
                  targetId,
                }, receiptId));
              const kind = step.tool === "sentinel_report_finding"
                ? "finding"
                : step.tool === "sentinel_record_finding_recheck"
                ? "recheck"
                : step.tool === INCONCLUSIVE_RECHECK_TOOL
                ? "inconclusive_recheck"
                : "report_amendment";
              if (!receipt || receipt.kind !== kind) return unavailable;
              let retained: Record<string, unknown> =
                receipt.kind === "report_amendment"
                  ? { _classification: "INTERNAL", amendment: receipt }
                  : { _classification: "INTERNAL", record: receipt };
              if (receipt.kind === "finding" && targetId && snapshot) {
                const writeScope = {
                  ...scope,
                  runId,
                  targetId,
                  evidenceRevision: ref.revision,
                };
                const digest = digestSentinelSnapshot(snapshot);
                const staged = lookupSentinelPendingTrafficFinding(
                  path,
                  writeScope,
                  receipt.requestId,
                  digest,
                );
                if (staged) {
                  if (!staged.hintsValid) return unavailable;
                  for (const source of staged.trafficBatch) {
                    const sourceStep = savedStep(history, source.stepIndex);
                    if (
                      sourceStep?.tool !== SENTINEL_TRAFFIC_READ ||
                      sourceStep.outcome !== "returned" ||
                      sourceStep.trafficRead?.sha256 !== source.sha256 ||
                      !await authorize(
                        scope,
                        SENTINEL_TRAFFIC_READ,
                        source.args,
                      )
                    ) return unavailable;
                    const visible = readProjectedSentinelTrafficReceipt(
                      path,
                      ref.id,
                      ref.revision,
                      source.args,
                      targetId,
                    );
                    if (!visible) return unavailable;
                    const text = JSON.stringify(visible);
                    if (
                      createHash("sha256").update(text).digest("hex") !==
                        source.sha256 ||
                      !await authorize(
                        scope,
                        SENTINEL_TRAFFIC_READ,
                        source.args,
                        text,
                      )
                    ) return unavailable;
                  }
                  const compound = lookupSentinelFindingMutation(
                    path,
                    writeScope,
                    "sentinel_report_finding",
                    receipt.requestId,
                    digest,
                  );
                  if (
                    !compound || compound.id !== receipt.id
                  ) return unavailable;
                  retained = JSON.parse(compound.result);
                }
              }
              const text = JSON.stringify(retained);
              const expected = (step as SentinelReadTrace).resultSha256;
              if (
                (expected !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    expected) ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== receiptId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === SENTINEL_TRAFFIC_ATTACH) {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              const linkId = step.target;
              if (
                !task?.nodeId || step.outcome !== "returned" || !authorize ||
                typeof linkId !== "string" ||
                !/^finding-traffic-link:[a-f0-9]{64}$/.test(linkId)
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision, linkId };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const [link] = listSentinelFindingTrafficLinks(path, {
                id: linkId,
                assetId: task.nodeId,
                evidenceRevision: ref.revision,
              });
              if (
                !link || link.caseId !== ref.id ||
                link.authority.kind !== "assignment" ||
                link.authority.taskId !== task.id
              ) return unavailable;
              const receipt = readSentinelTrafficReceipt(
                path,
                ref.revision,
                { evidenceId: link.trafficId, digest: link.trafficDigest },
                task.nodeId,
              );
              const retained = { _classification: "INTERNAL", link };
              const text = JSON.stringify(retained);
              const expected = (step as SentinelReadTrace).resultSha256;
              if (
                receipt?.family !== link.trafficSource ||
                (expected !== undefined &&
                  createHash("sha256").update(text).digest("hex") !==
                    expected) ||
                !await authorize(
                  scope,
                  step.tool,
                  call,
                  text,
                )
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" || saved.target !== linkId
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (step?.tool === SENTINEL_TRAFFIC_SEARCH && !step.trafficSearch) {
              const page = sentinelTrafficPageReference(step.trafficSearchPage);
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !worker?.archivedProgress || !page ||
                page.revision !== ref.revision ||
                !task?.nodeId || !authorize || step.outcome !== "returned"
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              const call = { revision: ref.revision };
              if (!await authorize(scope, step.tool, call)) return unavailable;
              const receipts = [];
              for (const reference of page.receipts) {
                const args = { ...call, ...reference };
                if (
                  !await authorize(scope, SENTINEL_TRAFFIC_READ, args)
                ) return unavailable;
                const saved = readProjectedSentinelTrafficReceipt(
                  path,
                  ref.id,
                  ref.revision,
                  args,
                  task.nodeId,
                );
                if (
                  !saved ||
                  !await authorize(
                    scope,
                    SENTINEL_TRAFFIC_READ,
                    args,
                    JSON.stringify(saved),
                  )
                ) {
                  return unavailable;
                }
                receipts.push(saved.receipt);
              }
              const retained = {
                caseId: ref.id,
                evidenceRevision: ref.revision,
                _classification: "INTERNAL",
                receipts,
                nextCursor: page.nextCursor,
              };
              const text = JSON.stringify(retained);
              if (
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== step.tool ||
                saved.outcome !== "returned" ||
                JSON.stringify(
                    sentinelTrafficPageReference(saved.trafficSearchPage),
                  ) !== JSON.stringify(page)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
              });
            }
            if (
              step?.tool === SENTINEL_TRAFFIC_READ ||
              step?.tool === SENTINEL_TRAFFIC_SEARCH ||
              step?.tool === SENTINEL_TRAFFIC_LINKS
            ) {
              const tool = step.tool;
              const bindingFor = (item: SentinelReviewStep) =>
                tool === SENTINEL_TRAFFIC_READ
                  ? item.trafficRead
                  : tool === SENTINEL_TRAFFIC_SEARCH
                  ? item.trafficSearch
                  : item.linkedTrafficPayload ?? item.trafficLinks;
              const binding = bindingFor(step);
              const read = tool === SENTINEL_TRAFFIC_READ
                ? step.trafficRead
                : undefined;
              const search = tool === SENTINEL_TRAFFIC_SEARCH
                ? step.trafficSearch
                : undefined;
              const links = tool === SENTINEL_TRAFFIC_LINKS
                ? step.trafficLinks
                : undefined;
              const receipt = read && sentinelTrafficReadArgs({
                revision: read.revision,
                evidenceId: read.evidenceId,
                digest: read.digest,
              });
              const linkArgs = links && sentinelTrafficLinksArgs(links.args);
              const payload = tool === SENTINEL_TRAFFIC_LINKS &&
                sentinelLinkedTrafficPayloadReference(
                  step.linkedTrafficPayload,
                );
              const call = receipt ??
                (search && sentinelTrafficSearchArgs(search.args)) ??
                linkArgs ??
                (payload || undefined)?.args;
              const task = history?.tasks.find(({ id }) => id === taskId);
              const authorize = context.authorizeSentinelTraceRead;
              if (
                !binding || !call || call.revision !== ref.revision ||
                step.outcome !== "returned" || !task?.nodeId || !authorize
              ) return unavailable;
              const scope = {
                caseId: ref.id,
                revision: ref.revision,
                taskId: task.id,
              };
              if (!await authorize(scope, tool, call)) return unavailable;
              const retained = receipt && readProjectedSentinelTrafficReceipt(
                path,
                ref.id,
                ref.revision,
                receipt,
                task.nodeId,
              );
              let text: string | undefined;
              if (payload) {
                text = reopenSentinelLinkedTrafficPayload(
                  path,
                  ref.id,
                  ref.revision,
                  task.nodeId,
                  payload.args,
                );
              } else if (linkArgs && links) {
                const { linkIds, nextOffset } = links;
                if (
                  !Array.isArray(linkIds) ||
                  linkIds.length > (linkArgs.limit ?? 5) ||
                  new Set(linkIds).size !== linkIds.length ||
                  (nextOffset !== null && (linkIds.length === 0 ||
                    nextOffset !== (linkArgs.offset ?? 0) + linkIds.length))
                ) return unavailable;
                const records = [];
                for (const id of linkIds) {
                  if (typeof id !== "string") return unavailable;
                  const [saved] = listSentinelFindingTrafficLinks(path, {
                    id,
                    assetId: task.nodeId,
                    evidenceRevision: ref.revision,
                    findingId: linkArgs.findingId,
                    recheckId: linkArgs.recheckId,
                  });
                  if (!saved) return unavailable;
                  records.push(saved);
                }
                if (
                  !allowsSentinelGraphFindingTrafficPage(
                    path,
                    ref.id,
                    ref.revision,
                    linkArgs.graphFindingId,
                    records,
                    task.nodeId,
                  )
                ) return unavailable;
                text = JSON.stringify({
                  _classification: "INTERNAL",
                  caseId: ref.id,
                  evidenceRevision: ref.revision,
                  links: records,
                  evidenceVersion: links.evidenceVersion,
                  nextOffset,
                });
              } else if (retained) {
                text = JSON.stringify(retained);
              } else if (search) {
                text = reopenProjectedSentinelTrafficPage(
                  path,
                  ref.id,
                  ref.revision,
                  call,
                  task.nodeId,
                );
              }
              if (
                !text ||
                createHash("sha256").update(text).digest("hex") !==
                  binding.sha256 ||
                !await authorize(scope, tool, call, text)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              const saved = savedStep(current);
              if (
                current?.goal.id !== runId || saved?.tool !== tool ||
                saved.outcome !== "returned" ||
                JSON.stringify(bindingFor(saved)) !== JSON.stringify(binding)
              ) return unavailable;
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: JSON.parse(text),
              });
            }
            if (step?.tool === "sentinel_live_workflow_status") {
              const task = history?.tasks.find(({ id }) => id === taskId);
              const receipt = readSentinelGitHubWorkflowReadReceipt(
                step.githubWorkflowRead,
                ref.revision,
              );
              const reader = options.readLiveWorkflow;
              const authorize = context.authorizeWorkflowDestination;
              if (
                !receipt || !task?.nodeId || ref.revision === undefined ||
                !reader || !authorize ||
                step.outcome !== "returned" || step.target !== task.nodeId ||
                createHash("sha256").update(JSON.stringify(receipt.runs))
                    .digest("hex") !== receipt.resultSha256
              ) return unavailable;
              const assetId = task.nodeId;
              const evidenceRevision = ref.revision;
              const isCurrent = () => {
                const state = readHistoricalAdaptiveSentinel(
                  path,
                  evidenceRevision,
                );
                const saved = savedStep(state);
                return state?.goal.id === runId && saved?.tool === step.tool &&
                  saved.target === task.nodeId &&
                  saved.outcome === "returned" &&
                  JSON.stringify(saved.githubWorkflowRead) ===
                    JSON.stringify(step.githubWorkflowRead);
              };
              const selected = typeof workflowRunNumber === "number"
                ? nativeWorkflowControlCandidate(receipt, workflowRunNumber)
                : undefined;
              if (
                workflowRunNumber !== undefined && !selected
              ) return unavailable;
              const retained = { targetId: task.nodeId, ...receipt };
              const checkSource = async () => {
                const verified = await reader({
                  caseId: ref.id,
                  assetId,
                  evidenceRevision,
                  signal: new AbortController().signal,
                  isCurrent,
                  resumeOnly: true,
                  loadSaved: () => receipt,
                  authorize: (destination) =>
                    authorize(destination, evidenceRevision, task.id),
                });

                return !!verified &&
                  JSON.stringify(verified) === JSON.stringify(receipt) &&
                  await context.authorizeSavedResponse(
                    step.tool,
                    JSON.stringify(retained),
                    "INTERNAL",
                  ) &&
                  isCurrent();
              };
              if (!await checkSource()) return unavailable;
              if (
                nativeAttach && selected &&
                typeof workflowRunNumber === "number" &&
                typeof controlId === "string" && typeof validUntil === "string"
              ) {
                const attached = await attachOperatorNativeWorkflowControl({
                  baseDir: options.baseDir,
                  path,
                  source: {
                    runId,
                    revision: ref.revision,
                    taskId: task.id,
                    stepIndex: index,
                    workflowRunNumber,
                    resultSha256: receipt.resultSha256,
                  },
                  assetId: task.nodeId,
                  controlId,
                  validUntil,
                  observedAt: receipt.observedAt,
                  outcome: selected.outcome,
                  authorize: checkSource,
                  confirm: options.confirm,
                  webContainmentConfigured: options.webContainmentConfigured,
                });
                return typeof attached === "string"
                  ? attached
                  : attached
                  ? safeProjection(attached)
                  : unavailable;
              }
              return projectResult({
                run: ref,
                runId,
                taskId,
                index,
                result: selected
                  ? {
                    targetId: task.nodeId,
                    sourceResultSha256: receipt.resultSha256,
                    ...selected,
                  }
                  : retained,
              });
            }
            if (
              step?.tool !== "sentinel_assigned_execution_evidence" ||
              step.outcome !== "returned" || !step.target
            ) return unavailable;
            const node = step.target;
            const responseDigest = (trace: SentinelReadTrace | undefined) =>
              trace?.goalReceiptRead?.sha256 ??
                (trace as
                  | (SentinelReadTrace & { resultSha256?: string })
                  | undefined)
                  ?.resultSha256;
            const digest = responseDigest(step);
            if (!digest) return unavailable;
            const isCurrent = () => {
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision!,
              );
              const trace = savedStep(current);
              return current?.goal.id === runId && trace?.tool === step.tool &&
                trace.target === node && trace.outcome === "returned" &&
                responseDigest(trace) === digest;
            };
            const evidence = await readAuthorizedCaseEvidence(
              ref.id,
              path,
              ref.revision,
              node,
              context,
              isCurrent,
            );
            if (!evidence) return unavailable;
            const retained = {
              evidenceId: node,
              evidenceRevision: ref.revision,
              evidence,
            };
            const hash = createHash("sha256").update(JSON.stringify(retained))
              .digest("hex");
            if (hash !== digest || !isCurrent()) return unavailable;
            return projectResult({
              run: ref,
              runId,
              taskId,
              index,
              result: retained,
            });
          }
          if (!worker?.progressSteps?.length || worker.status === "completed") {
            return unavailable;
          }
          const requested = stepIndices && new Set(stepIndices);
          const steps = worker.progressSteps.flatMap((
            { tool, target, outcome },
            index,
          ) =>
            !requested || requested.has(index)
              ? [{ index, tool, target, outcome }]
              : []
          );
          if (requested && requested.size !== steps.length) {
            return unavailable;
          }
          return safeProjection({
            run: ref,
            runId,
            taskId,
            status: worker.archivedProgress && worker.status !== "stopped"
              ? "interrupted"
              : worker.status,
            ...(worker.archivedProgress && { archived: true }),
            page: {
              offset,
              totalSteps: steps.length,
              nextOffset: offset + limit < steps.length ? offset + limit : null,
              steps: steps.slice(offset, offset + limit),
            },
          });
        }
        const tasks = new Map(history?.tasks.map((task) => [task.id, task]));
        const term = query.trim().toLowerCase();
        const completed = history?.modelReviews ?? [];
        const finished = new Set(completed.map(({ taskId }) => taskId));
        const running = (history?.modelReviewStates ?? []).filter((worker) =>
          worker.status !== "completed" && worker.progressSteps?.length &&
          !finished.has(worker.taskId)
        );
        const workers = [
          ...completed.map((review) => ({
            taskId: review.taskId,
            status: "completed",
            completedAt: review.at,
            stepCount: review.steps.length,
          })),
          ...running.map((review) => ({
            taskId: review.taskId,
            status: review.archivedProgress && review.status !== "stopped"
              ? "interrupted"
              : review.status,
            ...(review.archivedProgress && { archived: true }),
            stepCount: review.progressSteps!.length,
          })),
        ].flatMap((review) => {
          const task = tasks.get(review.taskId);
          if (
            !task || ![task.id, task.kind, task.nodeId].some(
              (value) => value?.toLowerCase().includes(term),
            )
          ) return [];
          return [{
            kind: task.kind,
            nodeId: task.nodeId,
            ...review,
          }];
        });
        return safeProjection({
          run: ref,
          runId,
          page: {
            offset,
            totalWorkers: workers.length,
            nextOffset: offset + limit < workers.length ? offset + limit : null,
            workers: workers.slice(offset, offset + limit),
          },
        });
      }
      if (action === "worker_observations") {
        const { taskId, query, offset } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (taskId !== undefined && typeof taskId !== "string") ||
          (query !== undefined && typeof query !== "string") ||
          (taskId !== undefined && query !== undefined) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "taskId", "query", "offset"]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const response = inspectSentinelWorkerObservation({
          snapshotPath: resolveSentinelCasePath(options.baseDir, ref.id),
          assessmentRevision: ref.revision,
        }, {
          revision: ref.revision,
          ...(offset !== undefined && { offset }),
          ...(taskId === undefined ? { query: query ?? "" } : { task: taskId }),
        });
        return response.startsWith("Error:")
          ? response
          : safeProjection({ run: ref, page: JSON.parse(response) });
      }
      if (action === "planner_reads") {
        const {
          plannerIdentity,
          attempt,
          ordinal,
          includeResult,
          limit = 5,
          offset = 0,
          sourceCase,
          snapshotDigest,
          assetId,
          evidenceId,
        } = args;
        const exact = plannerIdentity !== undefined;
        const sourceRequested = sourceCase !== undefined ||
          snapshotDigest !== undefined || assetId !== undefined ||
          evidenceId !== undefined;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (includeResult !== undefined &&
            (typeof includeResult !== "boolean" || !exact ||
              sourceRequested)) ||
          (sourceRequested && (!exact || typeof sourceCase !== "string" ||
            !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
            (assetId !== undefined && (typeof assetId !== "string" ||
              !assetId.trim() || assetId.length > 4096)) ||
            (evidenceId !== undefined && (assetId !== undefined ||
              typeof evidenceId !== "string" || !evidenceId.trim() ||
              evidenceId.length > 4096)))) ||
          (exact
            ? typeof plannerIdentity !== "string" ||
              !/^[A-Za-z\d._:-]{1,224}$/.test(plannerIdentity) ||
              typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
              attempt < 1 ||
              typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) ||
              ordinal < 1 || ordinal > 32
            : typeof limit !== "number" || !Number.isSafeInteger(limit) ||
              limit < 1 || limit > 10 ||
              typeof offset !== "number" || !Number.isSafeInteger(offset) ||
              offset < 0) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              ...(exact
                ? ["plannerIdentity", "attempt", "ordinal", "includeResult"]
                : ["limit", "offset"]),
              ...(sourceRequested
                ? ["sourceCase", "snapshotDigest", "assetId", "evidenceId"]
                : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const history = readHistoricalAdaptiveSentinel(
          path,
          ref.revision,
          undefined,
          includeResult === true,
        );
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        if (!runId || (history && history.goal.id !== runId)) {
          return unavailable;
        }
        const rounds = (history?.modelPlannerHistory ?? []).filter((
          { reads },
        ) => reads?.length);
        if (exact) {
          const round = rounds.find((entry) =>
            entry.identity === plannerIdentity && entry.attempt === attempt
          );
          const read = round?.reads?.[(ordinal as number) - 1];
          if (!read) return unavailable;
          const selected = {
            run: ref,
            plannerIdentity,
            attempt,
            ordinal,
          };
          if (!sourceRequested && !includeResult) {
            return safeProjection({ ...selected, read });
          }
          const authorize = context?.authorizeSentinelTraceRead;
          const inventory = includeResult &&
            read.tool === "sentinel_case_inventory" &&
            read.plannerCoverageResult;
          const snapshot = inventory &&
            readSentinelAssessmentRevision(path, ref.revision)?.result
              .sharedGraph.snapshot;
          const scopedInventoryQuery = inventory &&
            (inventory.args.assetText !== undefined ||
              inventory.args.organizationText !== undefined ||
              inventory.args.includeMembers === true ||
              inventory.args.includeCoverageTotals === true);
          const inventoryScope = () =>
            snapshot && ({
              caseId: ref.id,
              evidenceRevision: ref.revision!,
              snapshotDigest: digestSentinelSnapshot(snapshot),
              snapshot,
              scopedQueryOptions: {
                allowedAssetIds: readSentinelOperatingConstraints(path, runId)
                  ?.constraints.allowedAssetIds,
                scopeBinding: JSON.stringify([path, ref.revision, null]),
              },
            });
          const inventoryPage = inventory && snapshot &&
            readSentinelPlannerInventoryResult(
              inventory.args,
              inventory.text,
              inventoryScope() || undefined,
            );
          const digest = read.plannerDigestResult;
          const digestArgs = includeResult && digest &&
            readSentinelPlannerDigestResult(
              read.tool,
              digest.args,
              digest.text,
              { caseId: ref.id, runId, evidenceRevision: ref.revision },
            );
          const selector = inventoryPage
            ? inventoryPage.args
            : digestArgs || sentinelTraceSourceSelector(read);
          const scope = {
            caseId: ref.id,
            revision: ref.revision,
            plannerIdentity: plannerIdentity as string,
            attempt: attempt as number,
          };
          if (
            read.outcome !== "returned" || !authorize || !selector ||
            !await authorize(scope, read.tool, selector)
          ) {
            return unavailable;
          }
          const isCurrent = () => {
            const current = readHistoricalAdaptiveSentinel(
              path,
              ref.revision!,
              undefined,
              includeResult === true,
            );
            const saved = current?.modelPlannerHistory.find((entry) =>
              entry.identity === plannerIdentity && entry.attempt === attempt
            )?.reads?.[(ordinal as number) - 1];
            return current?.goal.id === runId && isDeepStrictEqual(saved, read);
          };
          if (evidenceId !== undefined) {
            const discovery = reopenCitedDiscovery(
              options.baseDir,
              path,
              ref.id,
              ref.revision,
              runId,
              read,
            );
            const source = citedDiscoveryEvidence(discovery, args);
            if (
              !source || !discovery ||
              !await authorize(
                scope,
                read.tool,
                selector,
                JSON.stringify(source),
              ) ||
              !discovery.allowsEndpoints() || !isCurrent()
            ) return unavailable;
            return safeProjection({ ...selected, source });
          }
          if (inventory && inventoryPage) {
            const assetsAllowed = () => {
              const allowed = readSentinelOperatingConstraints(path, runId)
                ?.constraints.allowedAssetIds;
              return !allowed ||
                inventoryPage.requestedAssetIds.every((id) =>
                  allowed.includes(id)
                );
            };
            const queryAllowed = () =>
              !scopedInventoryQuery ||
              !!readSentinelPlannerInventoryResult(
                inventory.args,
                inventory.text,
                inventoryScope() || undefined,
              );
            const peerCoverage = inventoryPage.peerCoverage;
            const peerAllowed = async () =>
              !peerCoverage ||
              !!await reopenSentinelPeerCoverage(
                path,
                ref.revision!,
                peerCoverage.selector,
                peerCoverage,
                async (source, current) => {
                  if (!context) return false;
                  const evidence = await readAuthorizedCaseEvidence(
                    peerCoverage.selector.sourceCase,
                    source.path,
                    source.revision,
                    source.evidence.id,
                    context,
                    () =>
                      isCurrent() && current() &&
                      context.authorizeSentinelCaseRead?.(
                          peerCoverage.selector.sourceCase,
                          source.revision,
                        ) !== false,
                  );
                  return !!evidence && executionReceiptSupportsCheck(
                    source.evidence,
                    source.runId,
                    source.assetId,
                    source.controlId,
                    "fail",
                    executionControlReceipt(evidence.payload),
                  );
                },
              );
            if (
              !assetsAllowed() || !await peerAllowed() ||
              createHash("sha256").update(inventory.text).digest("hex") !==
                inventory.sha256 ||
              !await authorize(scope, read.tool, selector, inventory.text) ||
              !assetsAllowed() || !queryAllowed() || !await peerAllowed() ||
              !isCurrent()
            ) return unavailable;
            return safeProjection({
              ...selected,
              result: JSON.parse(inventory.text),
            });
          }
          if (digest && digestArgs) {
            const result = JSON.parse(digest.text);
            const catalog = digestArgs.digestId === undefined;
            const digestIds = catalog
              ? [
                ...result.page.digests.map(({ id }: { id: string }) => id),
                ...(typeof digestArgs.cursor === "string"
                  ? [digestArgs.cursor]
                  : []),
              ]
              : [String(digestArgs.digestId)];
            const allowsObservations = async () => {
              if (
                !allowsRetainedSentinelDigests(
                  options.baseDir,
                  path,
                  ref.id,
                  runId,
                  ref.revision!,
                  digestIds,
                )
              ) return false;
              if (!catalog || result.page.nextCursor === null) return true;
              const next = await executeOperatorEvidenceDigest(
                options.baseDir,
                ref,
                {
                  action: "list_digests",
                  limit: 1,
                  cursor: result.page.nextCursor,
                },
                () => Promise.resolve(false),
              );
              const page = typeof next !== "string" && "page" in next
                ? next.page
                : undefined;
              return !!page && typeof page === "object" && "digests" in page &&
                Array.isArray(page.digests) && page.digests.length > 0;
            };
            if (
              createHash("sha256").update(digest.text).digest("hex") !==
                digest.sha256 ||
              !await allowsObservations() ||
              !await authorize(scope, read.tool, digestArgs, digest.text) ||
              !await allowsObservations() || !isCurrent()
            ) return unavailable;
            return safeProjection({ ...selected, result });
          }
          if (
            includeResult &&
            read.tool === "sentinel_intermediate_workflow_observation"
          ) {
            if (read.goalReceiptRead?.args.id === undefined) {
              const page = sentinelIntermediateWorkflowPageReference(
                read.intermediateWorkflowPage,
              );
              const snapshot = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )?.result.sharedGraph.snapshot;
              const constraints = readSentinelOperatingConstraints(path, runId)
                ?.constraints;
              if (
                !page || !snapshot || !isDeepStrictEqual(page.args, selector) ||
                page.sha256 !== read.goalReceiptRead?.sha256
              ) return unavailable;
              const observations = [];
              for (const id of page.ids) {
                const retained = readSentinelIntermediateWorkflowObservations(
                  path,
                  ref.revision,
                  runId,
                  { id },
                );
                const observation = retained && "observation" in retained
                  ? retained.observation
                  : undefined;
                if (
                  !observation ||
                  !sentinelOperatingConstraintsAllow(constraints, {
                    kind: "review_evidence",
                    nodeId: observation.targetId,
                  }, snapshot)
                ) return unavailable;
                const { receipt, ...detail } = observation;
                observations.push({
                  ...detail,
                  observedAt: receipt.observedAt,
                });
              }
              const result = {
                evidenceRevision: ref.revision,
                observations,
                nextOffset: page.nextOffset,
              };
              const text = JSON.stringify(result);
              if (
                createHash("sha256").update(text).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, read.tool, selector, text) ||
                !isCurrent()
              ) return unavailable;
              return safeProjection({ ...selected, result });
            }
            const citation = read.intermediateWorkflowObservation;
            const receipt = read.goalReceiptRead;
            if (
              !context || !citation || !receipt ||
              citation.evidenceRevision !== ref.revision ||
              receipt.args.id !== citation.observationId ||
              read.target !== citation.observationId
            ) return unavailable;
            const retained = readSentinelIntermediateWorkflowObservations(
              path,
              ref.revision,
              runId,
              { id: citation.observationId },
            );
            const observation = retained && "observation" in retained
              ? retained.observation
              : undefined;
            if (
              !observation || observation.taskId !== citation.sourceTaskId ||
              observation.targetId !== citation.targetId ||
              observation.stepIndex !== citation.sourceStepIndex ||
              observation.receipt.resultSha256 !== citation.resultSha256
            ) return unavailable;
            const text = JSON.stringify(observation);
            if (
              !await authorizeSentinelWorkflowObservation(
                options.readLiveWorkflow,
                context,
                { caseId: ref.id, path, runId },
                observation,
                isCurrent,
              ) ||
              createHash("sha256").update(text).digest("hex") !==
                receipt.sha256 ||
              !await authorize(scope, read.tool, selector, text) || !isCurrent()
            ) return unavailable;
            return safeProjection({ ...selected, result: observation });
          }
          if (
            includeResult && read.tool === "sentinel_case_execution_evidence"
          ) {
            const node = read.goalReceiptRead?.args.node;
            if (
              !context || typeof node !== "string" || node !== read.target ||
              !read.goalReceiptRead
            ) return unavailable;
            const evidence = await readAuthorizedCaseEvidence(
              ref.id,
              path,
              ref.revision,
              node,
              context,
              isCurrent,
            );
            if (!evidence) return unavailable;
            const result = {
              evidenceId: node,
              evidenceRevision: ref.revision,
              evidence,
              ...(read.recheckFindingIds?.length &&
                { recheckFindingIds: read.recheckFindingIds }),
            };
            const text = JSON.stringify(result);
            if (
              createHash("sha256").update(text).digest("hex") !==
                read.goalReceiptRead.sha256 ||
              !await authorize(scope, read.tool, selector, text) || !isCurrent()
            ) return unavailable;
            return safeProjection(
              { ...selected, result },
              evidence.classification,
            );
          }
          const sourceStillAuthorized = async () =>
            includeResult || !isSentinelPinnedSourceRead(read.tool) ||
            !!await reopenSentinelSourceResult(
              options.baseDir,
              path,
              ref.revision!,
              read,
              selector,
            );
          if (!await sourceStillAuthorized()) return unavailable;
          const text = includeResult
            ? read.tool === SENTINEL_TRAFFIC_READ ||
                read.tool === SENTINEL_TRAFFIC_SEARCH ||
                read.tool === SENTINEL_TRAFFIC_LINKS
              ? reopenSentinelPlannerTraffic(
                path,
                ref.id,
                ref.revision,
                runId,
                read,
                selector,
              )
              : await reopenSentinelSourceResult(
                options.baseDir,
                path,
                ref.revision,
                read,
                selector,
              )
            : JSON.stringify(
              await resolveCitedTraceSource(options.baseDir, path, read, args),
            );
          if (
            !text || !await authorize(scope, read.tool, selector, text) ||
            !await sourceStillAuthorized()
          ) {
            return unavailable;
          }
          if (
            includeResult &&
            (isSentinelArchivedInventoryRead(
              read.tool,
              "graph" in selector ? selector : {},
            ) || [
              "sentinel_worker_observation",
              "sentinel_shared_asset_links",
              "sentinel_shared_topology_source",
              "sentinel_shared_finding_source",
              "sentinel_defense",
              "sentinel_incident_alerts",
              "sentinel_provenance_node",
              "sentinel_provenance_search",
              "sentinel_graph_overview",
              "sentinel_path",
            ].includes(read.tool)) &&
            text !== await reopenSentinelSourceResult(
                options.baseDir,
                path,
                ref.revision,
                read,
                selector,
              )
          ) return unavailable;
          return isCurrent()
            ? safeProjection(
              includeResult
                ? { ...selected, result: JSON.parse(text) }
                : { ...selected, read, source: JSON.parse(text) },
            )
            : unavailable;
        }
        const end = (offset as number) + (limit as number);
        const page = rounds.slice(offset as number, end).map((
          { identity, attempt, reads },
        ) => ({
          plannerIdentity: identity,
          attempt,
          readCount: reads?.length ?? 0,
        }));
        return safeProjection({
          run: ref,
          page,
          nextOffset: end < rounds.length ? end : null,
        });
      }
      if (action === "topology_source") {
        const { evidenceId, sourceCase } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof evidenceId !== "string" ||
          !/^shared-topology:[a-f0-9]{64}$/.test(evidenceId) ||
          typeof sourceCase !== "string" || !isSentinelCaseId(sourceCase) ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "evidenceId", "sourceCase"]
              .includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const snapshot = readSentinelAssessmentRevision(path, ref.revision)
          ?.result.sharedGraph.snapshot;
        const evidence = snapshot && await readSharedSentinelTopologySource(
          options.baseDir,
          snapshot,
          evidenceId,
          sourceCase,
          path,
        );
        return evidence ? safeProjection({ run: ref, evidence }) : unavailable;
      }
      if (
        action === "traffic_search" || action === "traffic_get" ||
        action === "traffic_blob"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const { action: _action, kind: _kind, id: _id, ...query } = args;
        return executeSentinelTrafficTool(
          {
            snapshotPath: resolveSentinelCasePath(options.baseDir, ref.id),
            assessmentRevision: ref.revision,
            includePayloadMetadata: true,
          },
          action === "traffic_search"
            ? sentinelTrafficSearchTool.name
            : action === "traffic_blob"
            ? sentinelTrafficBlobTool.name
            : sentinelTrafficGetTool.name,
          query,
        );
      }
      if (action === "finding_traffic_candidates") {
        const {
          action: _action,
          kind: _kind,
          id: _id,
          revision: _revision,
          receiptId,
          ...filters
        } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          Object.hasOwn(filters, "assetId") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        if (!runId || !hasSentinelWorkerFindingJournal(path)) {
          return unavailable;
        }
        const journal = openSentinelWorkerFindingStore(path);
        try {
          const finding = journal.readFinding(receiptId);
          if (
            finding?.caseId !== ref.id || finding.runId !== runId ||
            finding.evidenceRevision > ref.revision
          ) return unavailable;
          const page = readProjectedSentinelTrafficPage(
            path,
            ref.revision,
            filters,
            finding.targetId,
          );
          return page
            ? safeProjection({ run: ref, findingId: receiptId, page })
            : unavailable;
        } finally {
          journal.close();
        }
      }
      if (
        action === "preview_finding_publication" ||
        action === "publish_finding" ||
        action === "withdraw_published_finding"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const revision = ref.revision;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const result = await executeOperatorFindingPublication(
          options.baseDir,
          ref.id,
          revision,
          args,
          options.confirm,
          context && ((node, isCurrent) =>
            readAuthorizedCaseEvidence(
              ref.id,
              path,
              revision,
              node,
              context,
              isCurrent,
            )),
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (action === "amend_finding_report") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          ((args.severity !== undefined || args.findingCategory !== undefined ||
            args.disposition !== undefined) &&
            (!context?.authenticatedOwnerSessionId ||
              !canFlowTo(
                context.inputClassification ?? "PUBLIC",
                "INTERNAL",
              ))) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "reportVersion",
              "evidenceVersion",
              "title",
              "summary",
              "severity",
              "findingCategory",
              "disposition",
              "requestId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        return await amendOperatorSentinelFindingReport(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          args,
          options.confirm,
        );
      }
      if (action === "finding_traffic_set_receipt") {
        const { receiptId, trafficSetReceiptId, offset = 0, limit = 20 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          typeof trafficSetReceiptId !== "string" ||
          !/^finding-traffic-set:[a-f0-9]{64}$/.test(trafficSetReceiptId) ||
          typeof offset !== "number" || !Number.isSafeInteger(offset) ||
          offset < 0 ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 40 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "trafficSetReceiptId",
              "offset",
              "limit",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const receipt = readSentinelTrafficCompositionReceipt(
          path,
          ref.revision,
          receiptId,
          trafficSetReceiptId,
        );
        if (
          !receipt || receipt.caseId !== ref.id ||
          receipt.runId !== readSentinelRunIdForRevision(path, ref.revision)
        ) return unavailable;
        if (receipt.operation !== "reorder") return safeProjection({ receipt });
        const { linkIds, ...identity } = receipt;
        const page = linkIds.slice(offset, offset + limit);
        return safeProjection({
          receipt: {
            ...identity,
            linkCount: linkIds.length,
            orderDigest: trafficCompositionOrderDigest(linkIds),
          },
          page: {
            linkIds: page,
            nextOffset: offset + page.length < linkIds.length
              ? offset + page.length
              : null,
          },
        });
      }
      if (
        action === "reorder_finding_traffic" ||
        action === "withdraw_finding_traffic"
      ) {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !authorize ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "trafficLinkId",
              "trafficLinkIds",
              "moveTrafficLinkId",
              "beforeTrafficLinkId",
              "reportVersion",
              "evidenceVersion",
              "requestId",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        return await editOperatorSentinelFindingTrafficSet(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          args,
          options.confirm,
          () => authorize(args),
        );
      }
      if (action === "annotate_finding_traffic") {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !authorize ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "trafficLinkId",
              "reportVersion",
              "evidenceVersion",
              "evidenceRole",
              "evidenceNote",
              "requestId",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        return await annotateOperatorSentinelFindingTraffic(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          args,
          options.confirm,
          () => authorize(args),
        );
      }
      if (action === "attach_finding_traffic_batch") {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !authorize ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "recheckId",
              "reportVersion",
              "trafficRefs",
              "requestId",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        return await attachOperatorSentinelFindingTrafficBatch(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          args,
          options.confirm,
          () => authorize(args),
        );
      }
      if (action === "attach_finding_traffic") {
        const authorize = context?.authorizeOwnerRunCall;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !authorize ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "recheckId",
              "reportVersion",
              "evidenceId",
              "digest",
              "evidenceRole",
              "evidenceNote",
              "requestId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        return await attachOperatorSentinelFindingTraffic(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          args,
          options.confirm,
          () => authorize(args),
        );
      }
      if (action === "finding_traffic") {
        const {
          receiptId,
          recheckId,
          trafficLinkId,
          limit,
          offset,
          payloadPart,
          byteLength,
          includeWithdrawn,
          includeReportEvidence,
        } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
          (includeReportEvidence !== undefined && (
            includeReportEvidence !== true || trafficLinkId !== undefined ||
            recheckId !== undefined ||
            !context?.authenticatedOwnerSessionId ||
            context.authorizeSentinelCaseRead?.(ref.id, ref.revision) === false
          )) ||
          (payloadPart !== undefined && trafficLinkId === undefined) ||
          (byteLength !== undefined && payloadPart === undefined) ||
          (includeWithdrawn !== undefined &&
            (includeWithdrawn !== true || !trafficLinkId ||
              payloadPart !== undefined ||
              !context?.authenticatedOwnerSessionId)) ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          (recheckId !== undefined &&
            (typeof recheckId !== "string" ||
              !/^worker-recheck:[a-f0-9]{64}$/.test(recheckId))) ||
          (trafficLinkId !== undefined &&
            (typeof trafficLinkId !== "string" ||
              !/^finding-traffic-link:[a-f0-9]{64}$/.test(trafficLinkId) ||
              limit !== undefined ||
              (payloadPart === undefined && offset !== undefined))) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "recheckId",
              "trafficLinkId",
              "payloadPart",
              "byteLength",
              "includeWithdrawn",
              "includeReportEvidence",
              "limit",
              "offset",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const snapshotPath = resolveSentinelCasePath(options.baseDir, ref.id);
        if (typeof trafficLinkId === "string") {
          const [link] = listSentinelFindingTrafficLinks(snapshotPath, {
            id: trafficLinkId,
            evidenceRevision: ref.revision,
            findingId: receiptId,
            recheckId,
            ...(includeWithdrawn === true && { includeWithdrawn }),
            limit: 1,
          });
          if (link?.caseId !== ref.id) return unavailable;
          if (payloadPart !== undefined) {
            const runId = readSentinelRunIdForRevision(
              snapshotPath,
              ref.revision,
            );
            const selected = readSentinelAssessmentRevision(
              snapshotPath,
              ref.revision,
            );
            const current = readSentinelAssessment(snapshotPath);
            const snapshot = selected?.result.sharedGraph.snapshot;
            const target = {
              kind: "review_evidence",
              nodeId: link.assetId,
            } as const;
            if (
              !runId || !snapshot || !current?.plan.runId ||
              !sentinelOperatingConstraintsAllow(
                readSentinelOperatingConstraints(
                  snapshotPath,
                  runId,
                  ref.revision,
                )?.constraints,
                target,
                snapshot,
              ) ||
              !sentinelOperatingConstraintsAllow(
                readSentinelOperatingConstraints(
                  snapshotPath,
                  current.plan.runId,
                )?.constraints,
                target,
                snapshot,
              )
            ) return unavailable;
          }
          const receipt = readSentinelTrafficReceipt(
            snapshotPath,
            ref.revision,
            {
              evidenceId: link.trafficId,
              digest: link.trafficDigest,
            },
            link.assetId,
          );
          if (!receipt || receipt.family !== link.trafficSource) {
            return unavailable;
          }
          const payload = payloadPart === undefined
            ? undefined
            : projectSentinelTrafficBlob(
              receipt,
              payloadPart,
              offset,
              byteLength,
            );
          if (typeof payload === "string") return payload;
          const annotations = readSentinelTrafficLinkAnnotations(
            snapshotPath,
            [link.id],
          );
          return safeProjection({
            run: ref,
            link,
            ...(annotations.length && { annotations }),
            ...(includeWithdrawn === true && {
              withdrawal: readSentinelTrafficCompositionHistory(
                snapshotPath,
                ref.revision,
                receiptId,
              )
                .find((item) =>
                  item.operation === "withdraw" && item.linkId === link.id
                ) ?? null,
            }),
            receipt: projectSentinelTrafficReceipt(receipt, link.assetId),
            ...(payload && { payload }),
          });
        }
        const response = executeSentinelFindingTrafficTool(
          { snapshotPath, assessmentRevision: ref.revision },
          sentinelFindingTrafficListTool.name,
          {
            revision: ref.revision,
            findingId: receiptId,
            recheckId,
            limit,
            offset,
          },
          new Set(),
        );
        if (response.startsWith("Error:")) return response;
        const page = JSON.parse(response);
        const annotations = readSentinelTrafficLinkAnnotations(
          snapshotPath,
          page.links.map(({ id }: { id: string }) => id),
        );
        const reportEvidence = includeReportEvidence === true
          ? readSentinelFindingReportAttachmentReview(
            snapshotPath,
            ref.id,
            ref.revision,
            receiptId,
          )
          : undefined;
        if (
          includeReportEvidence && (!reportEvidence ||
            reportEvidence.current.digest !== page.evidenceVersion)
        ) return unavailable;
        return safeProjection({
          run: ref,
          page: {
            ...page,
            ...(annotations.length && { annotations }),
            ...(reportEvidence && { reportEvidence }),
          },
        });
      }
      if (
        action === "finding_receipt" || action === "finding_receipts" ||
        action === "finding_report" || action === "finding_report_history"
      ) {
        const {
          receiptId,
          cursor,
          limit = 5,
          reportVersion,
          includeReportEvidence,
        } = args;
        const listing = action === "finding_receipts";
        const readingReport = action === "finding_report";
        const listingReport = action === "finding_report_history";
        const receiptPattern = /^worker-(?:finding|recheck):[a-f0-9]{64}$/;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (listing
            ? typeof limit !== "number" || !Number.isSafeInteger(limit) ||
              limit < 1 || limit > 10 || (cursor !== undefined &&
                (typeof cursor !== "string" || !receiptPattern.test(cursor)))
            : typeof receiptId !== "string" ||
              (!receiptPattern.test(receiptId) &&
                !(action === "finding_receipt" &&
                  INCONCLUSIVE_RECHECK_ID.test(receiptId)))) ||
          (includeReportEvidence !== undefined && (
            includeReportEvidence !== true || !readingReport ||
            !context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
            context.authorizeSentinelCaseRead?.(ref.id, ref.revision) === false
          )) ||
          reportVersion !== undefined &&
            (typeof reportVersion !== "number" ||
              !Number.isSafeInteger(reportVersion) || reportVersion < 1) ||
          listingReport &&
            (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
              limit < 1 || limit > 10 ||
              (cursor !== undefined &&
                (typeof cursor !== "string" || cursor.length > 110))) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              ...(listing ? ["cursor", "limit"] : ["receiptId"]),
              ...(readingReport
                ? ["reportVersion", "includeReportEvidence"]
                : []),
              ...(listingReport ? ["cursor", "limit"] : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        if (!runId) return unavailable;
        if (!hasSentinelWorkerFindingJournal(path)) {
          return listing && cursor === undefined
            ? safeProjection({
              run: ref,
              page: { records: [], nextCursor: null },
            })
            : unavailable;
        }
        const journal = openSentinelWorkerFindingStore(path);
        try {
          if (listingReport) {
            if (
              !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL") ||
              !(receiptId as string).startsWith("worker-finding:")
            ) return unavailable;
            const page = journal.listFindingReportVersions(
              {
                caseId: ref.id,
                runId,
                revision: ref.revision,
                findingId: receiptId as string,
              },
              limit as number,
              cursor as string | undefined,
            );
            return page ? safeProjection({ run: ref, page }) : unavailable;
          }
          if (readingReport) {
            if (!(receiptId as string).startsWith("worker-finding:")) {
              return unavailable;
            }
            const report = journal.readFindingReport(
              receiptId as string,
              ref.revision,
            );
            if (
              !report || report.finding.caseId !== ref.id ||
              report.finding.runId !== runId
            ) return unavailable;
            const version = reportVersion ?? report.version;
            const selected = version === 1
              ? report.finding
              : report.amendments.find((amendment) =>
                amendment.version === version && amendment.caseId === ref.id &&
                amendment.runId === runId
              );
            if (!selected) return unavailable;
            const checked = createSentinelFindingRemediationReader(
              path,
              ref.id,
              ref.revision,
              runId,
            )(
              report.finding,
              journal.listFindingRechecks(report.finding.id, ref.revision),
            );
            let remediation = checked.value;
            if (checked.sources?.length) {
              const revalidateScope = () =>
                readSentinelRunIdForRevision(path, ref.revision!) === runId &&
                context?.authorizeSentinelCaseRead?.(ref.id, ref.revision!) !==
                  false;
              let approved = !!context;
              if (context) {
                for (const source of checked.sources) {
                  const evidence = await readAuthorizedCaseEvidence(
                    ref.id,
                    path,
                    source.revision,
                    source.evidenceId,
                    context,
                    revalidateScope,
                  );
                  if (
                    !evidence || !executionReceiptSupportsCheck(
                      source.node,
                      runId,
                      report.finding.targetId,
                      report.finding.controlId,
                      source.outcome,
                      executionControlReceipt(evidence.payload),
                    )
                  ) {
                    approved = false;
                    break;
                  }
                }
              }
              const latest = journal.readFindingReport(
                report.finding.id,
                ref.revision,
              );
              if (
                !latest || !revalidateScope() ||
                (reportVersion === undefined &&
                  latest.version !== report.version)
              ) return unavailable;
              const rechecked = createSentinelFindingRemediationReader(
                path,
                ref.id,
                ref.revision,
                runId,
              )(
                latest.finding,
                journal.listFindingRechecks(latest.finding.id, ref.revision),
              );
              if (
                !approved || !isDeepStrictEqual(rechecked.value, remediation)
              ) {
                remediation = { status: "unknown", asOfRevision: ref.revision };
              }
            }
            const reportEvidence = includeReportEvidence === true
              ? readSentinelFindingReportAttachmentReview(
                path,
                ref.id,
                ref.revision,
                report.finding.id,
                version,
              )
              : undefined;
            if (includeReportEvidence && !reportEvidence) return unavailable;
            return safeProjection({
              run: ref,
              report: {
                findingId: report.finding.id,
                version,
                latestVersion: report.version,
                sourceReceiptId: selected.id,
                evidenceRevision: selected.evidenceRevision,
                taskId: selected.taskId,
                ...("evidenceVersion" in selected && {
                  evidenceVersion: selected.evidenceVersion,
                }),
                ...findingReportMetadata(
                  report.amendments,
                  version,
                  report.finding,
                ),
                remediation,
                ...(reportEvidence && { reportEvidence }),
                title: selected.title,
                summary: selected.summary,
              },
            });
          }
          if (listing) {
            const matching = journal.list(ref.revision).filter(
              (record) => record.caseId === ref.id && record.runId === runId,
            );
            const cursorIndex = cursor === undefined
              ? -1
              : matching.findIndex(({ id }) => id === cursor);
            if (cursor !== undefined && cursorIndex === -1) return unavailable;
            const start = cursorIndex + 1;
            const records = matching.slice(start, start + (limit as number))
              .map(
                (record) => ({
                  id: record.id,
                  kind: record.kind,
                  recordedAt: record.recordedAt,
                  ...(record.kind === "recheck" && {
                    findingId: record.findingId,
                    outcome: record.outcome,
                  }),
                }),
              );
            return safeProjection({
              run: ref,
              page: {
                records,
                nextCursor: start + records.length < matching.length
                  ? records.at(-1)?.id ?? null
                  : null,
              },
            });
          }
          if (INCONCLUSIVE_RECHECK_ID.test(receiptId as string)) {
            const record = journal.readInconclusive(receiptId as string);
            const snapshot = readSentinelAssessmentRevision(path, ref.revision)
              ?.result.sharedGraph.snapshot;
            const constraints = readSentinelOperatingConstraints(
              path,
              runId,
              ref.revision,
            )?.constraints;
            return record?.caseId === ref.id && record.runId === runId &&
                record.evidenceRevision === ref.revision && snapshot &&
                digestSentinelSnapshot(snapshot) === record.snapshotDigest &&
                sentinelOperatingConstraintsAllow(constraints, {
                  kind: "review_evidence",
                  nodeId: record.targetId,
                }, snapshot)
              ? safeProjection({ run: ref, record })
              : unavailable;
          }
          const record = journal.read(receiptId as string);
          return record?.caseId === ref.id && record.runId === runId &&
              record.evidenceRevision === ref.revision
            ? safeProjection({ run: ref, record })
            : unavailable;
        } finally {
          journal.close();
        }
      }
      if (action === "assessment_review") {
        const { taskId, stepIndices, sourceCase, snapshotDigest, assetId } =
          args;
        const followSource = sourceCase !== undefined ||
          snapshotDigest !== undefined || assetId !== undefined;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (taskId !== undefined &&
            (typeof taskId !== "string" || !taskId.trim() ||
              taskId.length > 256)) ||
          (stepIndices !== undefined &&
            (typeof taskId !== "string" || !Array.isArray(stepIndices) ||
              stepIndices.length !== 1 ||
              !Number.isSafeInteger(stepIndices[0]) ||
              stepIndices[0] < 0 || stepIndices[0] >= 16)) ||
          (followSource && stepIndices === undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "taskId",
              "stepIndices",
              "sourceCase",
              "snapshotDigest",
              "assetId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const saved = readSentinelAssessmentRevision(path, ref.revision);
        if (!saved) return unavailable;
        if (taskId === undefined) {
          const reviews = saved.reviews.map(({ task, steps }) => ({
            taskId: task,
            stepCount: steps?.length ?? 0,
          }));
          return safeProjection({ run: ref, reviews });
        }
        const review = saved.reviews.find(({ task }) => task === taskId);
        if (!review) return unavailable;
        if (stepIndices === undefined) {
          return safeProjection({
            run: ref,
            taskId,
            analysis: review.analysis,
            stepCount: review.steps?.length ?? 0,
          });
        }
        const stepIndex = (stepIndices as number[])[0];
        const step = review.steps?.[stepIndex];
        if (!step) return unavailable;
        if (followSource) {
          const authorize = context?.authorizeSentinelTraceRead;
          const selector = sentinelTraceSourceSelector(step);
          const runId = readSentinelRunIdForRevision(path, ref.revision);
          const scope = { caseId: ref.id, revision: ref.revision, taskId };
          if (
            !authorize || !selector || !runId ||
            !await authorize(scope, step.tool, selector)
          ) {
            return unavailable;
          }
          const source = await resolveCitedTraceSource(
            options.baseDir,
            path,
            step,
            args,
          );
          if (
            !source ||
            !await authorize(scope, step.tool, selector, JSON.stringify(source))
          ) {
            return unavailable;
          }
          const latest = readSentinelAssessmentRevision(path, ref.revision)
            ?.reviews.find(({ task }) => task === taskId)?.steps?.[stepIndex];
          return readSentinelRunIdForRevision(path, ref.revision) === runId &&
              isDeepStrictEqual(latest, step)
            ? safeProjection({ run: ref, taskId, stepIndex, source })
            : unavailable;
        }
        const { tool, outcome, target, sourceSnapshots, aliasMapping } = step;
        return safeProjection({
          run: ref,
          taskId,
          stepIndex,
          step: { tool, outcome, target, sourceSnapshots, aliasMapping },
        });
      }
      if (action === "worker_trace_source") {
        const { taskId, stepIndices } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof taskId !== "string" || !Array.isArray(stepIndices) ||
          stepIndices.length !== 1 || !Number.isSafeInteger(stepIndices[0]) ||
          stepIndices[0] < 0 || stepIndices[0] >= 16 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "taskId",
              "stepIndices",
              "sourceCase",
              "snapshotDigest",
              "assetId",
              "evidenceId",
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const index = stepIndices[0];
        const runId = readSentinelRunIdForRevision(path, ref.revision);
        const select = (
          history: ReturnType<typeof readHistoricalAdaptiveSentinel>,
        ) =>
          history?.goal.id === runId
            ? history?.modelReviews.find((item) => item.taskId === taskId)
              ?.steps[index] ??
              history?.modelReviewStates.find((item) =>
                item.taskId === taskId && item.archivedProgress
              )?.progressSteps?.[index]
            : undefined;
        const history = readHistoricalAdaptiveSentinel(path, ref.revision);
        const step = select(history);
        const task = history?.tasks.find(({ id }) => id === taskId);
        const authorize = context?.authorizeSentinelTraceRead;
        if (!runId || !task || !authorize || step?.outcome !== "returned") {
          return unavailable;
        }
        const selector = sentinelTraceSourceSelector(step);
        const scope = { caseId: ref.id, revision: ref.revision, taskId };
        if (!selector || !await authorize(scope, step.tool, selector)) {
          return unavailable;
        }
        const pinnedSourceIsAuthorized = async () =>
          !isSentinelPinnedSourceRead(step.tool) ||
          !!await reopenSentinelSourceResult(
            options.baseDir,
            path,
            ref.revision!,
            step,
            selector,
          );
        if (!await pinnedSourceIsAuthorized()) return unavailable;
        const discovery = step.sharedAssetDiscovery && task.nodeId &&
            args.assetId === undefined
          ? reopenCitedDiscovery(
            options.baseDir,
            path,
            ref.id,
            ref.revision,
            runId,
            step,
            task.nodeId,
          )
          : undefined;
        const source = step.sharedAssetDiscovery
          ? citedDiscoveryEvidence(discovery, args)
          : args.evidenceId === undefined
          ? await resolveCitedTraceSource(options.baseDir, path, step, args)
          : undefined;
        if (
          !source ||
          !await authorize(
            scope,
            step.tool,
            selector,
            JSON.stringify(source),
          ) ||
          !await pinnedSourceIsAuthorized() ||
          (discovery && !discovery.allowsEndpoints()) ||
          !isDeepStrictEqual(
            select(readHistoricalAdaptiveSentinel(path, ref.revision)),
            step,
          )
        ) return unavailable;
        return safeProjection({ run: ref, taskId, stepIndex: index, source });
      }
      if (action === "linked_findings") {
        const { assetId, sourceCase, query = "", cursor, limit = 3 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof assetId !== "string" || !assetId.trim() ||
          assetId.length > 800 ||
          typeof sourceCase !== "string" || !isSentinelCaseId(sourceCase) ||
          sourceCase === ref.id ||
          typeof query !== "string" || query.length > 80 ||
          redactCredentialText(query) !== query ||
          (cursor !== undefined &&
            (typeof cursor !== "string" ||
              !/^[a-f0-9]{64}\.[1-9][0-9]?$/.test(cursor))) ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 5 ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "assetId",
              "sourceCase",
              "query",
              "cursor",
              "limit",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const revision = ref.revision;
        const catalog = listSentinelSelectedFindingCandidates(
          path,
          revision,
          sourceCase,
          assetId,
          query.trim().toLocaleLowerCase(),
        );
        if (!catalog) return unavailable;
        const { selected, candidates, current } = catalog;
        const allowed = () =>
          current() &&
          context.authorizeSentinelCaseRead?.(ref.id, revision) !== false &&
          context.authorizeSentinelCaseRead?.(sourceCase, selected.revision) !==
            false;
        if (!allowed()) return unavailable;
        const visible = [];
        for (const entry of candidates) {
          const finding = entry.finding.id;
          const sourceAsset = entry.targetId;
          if (
            !await context.authorizeOwnerRunCall({
              action: "finding_report",
              kind: "sentinel",
              id: sourceCase,
              revision: selected.revision,
              receiptId: finding,
            }) || !allowed()
          ) continue;
          const checked = () =>
            readLinkedFindingProof(
              options.baseDir,
              [selected],
              sourceCase,
              sourceAsset,
              entry.finding,
            );
          const proof = checked();
          const source = proof?.publication.finding.workerFindingSource;
          if (!proof || !source) continue;
          const scopeIsCurrent = () =>
            allowed() && isDeepStrictEqual(checked(), proof) &&
            sentinelOperatingConstraintsAllow(
              readSentinelOperatingConstraints(
                resolveSentinelCasePath(options.baseDir, sourceCase),
                selected.runId,
              )?.constraints,
              { kind: "review_evidence", nodeId: sourceAsset },
              readSentinelAssessmentRevision(
                resolveSentinelCasePath(options.baseDir, sourceCase),
                selected.revision,
              )?.result.sharedGraph.snapshot,
            );
          if (!scopeIsCurrent()) continue;
          const operation = proof.execution;
          if (operation) {
            const evidence = await readAuthorizedCaseEvidence(
              sourceCase,
              operation.path,
              operation.revision,
              operation.evidence.id,
              context,
              scopeIsCurrent,
            );
            if (
              !evidence ||
              !executionReceiptSupportsCheck(
                operation.evidence,
                operation.runId,
                operation.assetId,
                operation.controlId,
                "fail",
                executionControlReceipt(evidence.payload),
              )
            ) continue;
          }
          const item = {
            finding,
            sourceAsset,
            source,
            inherited: true,
            title: entry.finding.label,
          };
          if (
            await context.authorizeSavedResponse(
              operatorRunTool.name,
              safeProjection(item),
              "INTERNAL",
            ) && scopeIsCurrent()
          ) visible.push({ item, scopeIsCurrent });
        }
        const records = visible.filter(({ scopeIsCurrent }) =>
          scopeIsCurrent()
        );
        const binding = createHash("sha256").update(
          JSON.stringify([
            ref,
            selected,
            assetId,
            query,
            records.map(({ item }) => item),
          ]),
        ).digest("hex") + ".";
        if (cursor !== undefined && !cursor.startsWith(binding)) {
          return unavailable;
        }
        const offset = typeof cursor === "string"
          ? Number(cursor.slice(binding.length))
          : 0;
        if (offset && offset >= records.length) return unavailable;
        const page = records.slice(offset, offset + limit);
        const outputAllowed = () =>
          allowed() && records.every(({ scopeIsCurrent }) => scopeIsCurrent());
        const snapshotDigest = await catalog.retain(
          new Set(page.map(({ item }) => item.finding)),
          outputAllowed,
        );
        if (!snapshotDigest || !outputAllowed()) return unavailable;
        return safeProjection({
          run: ref,
          entries: page.map(({ item: { finding, sourceAsset, ...item } }) => ({
            ...item,
            selector: {
              asset: assetId,
              sourceCase,
              sourceAsset,
              finding,
              snapshotDigest,
            },
          })),
          nextCursor: offset + limit < records.length
            ? binding + (offset + limit)
            : null,
        });
      }
      if (action === "linked_finding") {
        const raw = args.linkedFinding;
        const selector = raw && typeof raw === "object" && !Array.isArray(raw)
          ? parseSentinelPinnedFindingRead(raw as Record<string, unknown>)
          : undefined;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined || !selector ||
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "linkedFinding"].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const revision = ref.revision;
        const exact = () =>
          reopenSentinelSelectedFinding(path, revision, selector);
        const allowed = (sourceRevision: number) =>
          context.authorizeSentinelCaseRead?.(ref.id, revision) !== false &&
          context.authorizeSentinelCaseRead?.(
              selector.sourceCase,
              sourceRevision,
            ) !== false;
        const selected = readSentinelLinkedSourcesForRevision(path, revision)
          ?.find(({ caseId }) => caseId === selector.sourceCase);
        if (!selected || !allowed(selected.revision)) return unavailable;
        const sourceArgs = {
          action: "finding_report",
          kind: "sentinel",
          id: selected.caseId,
          revision: selected.revision,
          receiptId: selector.finding,
        };
        if (!await context.authorizeOwnerRunCall(sourceArgs)) {
          return unavailable;
        }
        const finding = await exact();
        if (
          !finding || finding.source.revision !== selected.revision ||
          finding.source.runId !== selected.runId ||
          finding.source.receiptId !== selector.finding ||
          !allowed(selected.revision)
        ) return unavailable;
        const isCurrent = () =>
          allowed(selected.revision) && finding.isCurrent();
        if (finding.execution) {
          const source = finding.execution;
          const evidence = await readAuthorizedCaseEvidence(
            selected.caseId,
            source.path,
            source.revision,
            source.evidence.id,
            context,
            isCurrent,
          );
          if (
            !evidence || !executionReceiptSupportsCheck(
              source.evidence,
              source.runId,
              source.assetId,
              source.controlId,
              "fail",
              executionControlReceipt(evidence.payload),
            ) || !isCurrent()
          ) return unavailable;
        }
        const projection = projectSentinelSharedFindingSource(
          finding.graph,
          revision,
          selector,
        );
        if (
          projection.startsWith("Error:") ||
          !await context.authorizeSavedResponse(
            operatorRunTool.name,
            projection,
            "INTERNAL",
          ) ||
          !isCurrent()
        ) return unavailable;
        return safeProjection({
          run: ref,
          inherited: true,
          source: finding.source,
          detail: JSON.parse(projection),
        });
      }
      if (action === "finding_lineage") {
        const { node, cursor, limit = 4 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !context?.authenticatedOwnerSessionId ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          typeof node !== "string" || !node || node.length > 4096 ||
          (cursor !== undefined &&
            (typeof cursor !== "string" || cursor.length > 100)) ||
          typeof limit !== "number" || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 8 ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "node", "cursor", "limit"]
              .includes(key)
          ) || !await controller.inspect(ref) ||
          context.authorizeSentinelCaseRead?.(ref.id, ref.revision) === false
        ) return unavailable;
        const page = readSentinelFindingLineage(
          resolveSentinelCasePath(options.baseDir, ref.id),
          ref.revision,
          node,
          limit,
          cursor,
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (action === "graph_overview") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "includeFrontier"].includes(
              key,
            )
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const frontier = args.includeFrontier === true
          ? readSentinelInvestigationFrontier(
            path,
            ref.revision,
            !!authorizeCaseRead,
          )
          : undefined;
        if (args.includeFrontier === true && !frontier) return unavailable;
        const result = readSentinelGraphOverview({
          snapshotPath: path,
          assessmentRevision: ref.revision,
          scopeCaseGraph: !!authorizeCaseRead,
        }, {});
        return result.startsWith("Error:") ? unavailable : safeProjection({
          run: ref,
          overview: JSON.parse(result),
          ...(frontier && { frontier }),
        });
      }
      if (
        action === "graph" || action === "findings" || action === "node" ||
        action === "traces"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !await controller.inspect(ref)
        ) return unavailable;
        const scope = {
          snapshotPath: resolveSentinelCasePath(options.baseDir, ref.id),
          assessmentRevision: ref.revision,
          scopeCaseGraph: !!authorizeCaseRead,
        };
        const page = {
          revision: ref.revision,
          ...(args.offset !== undefined && { offset: args.offset }),
          ...(args.limit !== undefined && { limit: args.limit }),
        };
        const query = args.query !== undefined ? { query: args.query } : {};
        const { includeFindingTraffic, trafficOffset = 0 } = args;
        if (
          (includeFindingTraffic !== undefined &&
            includeFindingTraffic !== true) ||
          ((includeFindingTraffic !== undefined ||
            args.trafficOffset !== undefined) &&
            (action !== "node" ||
              !canFlowTo("INTERNAL", context?.ceiling ?? "PUBLIC"))) ||
          (args.trafficOffset !== undefined &&
            includeFindingTraffic !== true) ||
          typeof trafficOffset !== "number" ||
          !Number.isSafeInteger(trafficOffset) ||
          trafficOffset < 0 || trafficOffset > 4096
        ) return unavailable;
        const response = action === "node"
          ? inspectSentinelProvenance(scope, { ...page, node: args.node })
          : action === "traces"
          ? searchSentinelWorkerTraces(scope, {
            ...page,
            ...query,
            ...(args.taskId !== undefined && { task: args.taskId }),
            ...(args.stepIndices !== undefined &&
              { stepIndices: args.stepIndices }),
          })
          : searchSentinelProvenance(scope, {
            ...page,
            ...query,
            ...(action === "findings" && { kind: "finding" }),
          });
        if (response.startsWith("Error:")) return response;
        const graphPage = JSON.parse(response);
        if (!includeFindingTraffic) {
          return safeProjection({ run: ref, page: graphPage });
        }
        if (
          graphPage.node?.kind !== "finding" ||
          typeof graphPage.node.sourceId !== "string"
        ) return unavailable;
        const findingTraffic = discoverSentinelFindingNodeTraffic(
          scope.snapshotPath,
          ref.id,
          ref.revision,
          graphPage.node.sourceId,
          trafficOffset,
          5,
        );
        return findingTraffic
          ? safeProjection({ run: ref, page: graphPage, findingTraffic })
          : unavailable;
      }
      if (action === "inspect") {
        if (
          backgroundRole &&
          Object.keys(args).some((key) =>
            !["action", "kind", "id"].includes(key)
          )
        ) return unavailable;
        const run = await controller.inspect(ref);
        return run
          ? safeProjection({
            run: backgroundRole ? projectBackgroundRun(run) : run,
            ...(backgroundRole && run.details?.recovery !== undefined
              ? { recovery: run.details.recovery }
              : {}),
            links: await controller.listLinks(run.ref),
          })
          : unavailable;
      }
      if (action === "confirm_goal_completion") {
        const { runId, goalProofDigest } = args;
        const authorize = context?.authorizeOwnerRunCall;
        if (
          !authorize || !context?.authenticatedOwnerSessionId ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof goalProofDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(goalProofDigest) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "goalProofDigest",
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const state = readSentinelAssessment(path);
        if (
          state?.revision !== ref.revision ||
          state.plan.runId !== runId.toLowerCase()
        ) return unavailable;
        const proof = readSentinelGoalCompletionAtRevision(path, ref.revision);
        if (
          !proof || proof.policy !== "operator" ||
          digestSentinelGoalProof(proof) !== goalProofDigest
        ) return unavailable;
        const decision =
          `Operator confirmed exact Sentinel goal proof ${goalProofDigest}.`;
        const success = () =>
          safeProjection({
            run: ref,
            runId: state.plan.runId,
            proofDigest: goalProofDigest,
            status: "completed",
          });
        if (
          state.completion?.note === decision && proof.status === "completed"
        ) return success();
        if (
          !state.active ||
          !["awaiting_confirmation", "completed"].includes(proof.status)
        ) return unavailable;
        if (
          !await options.confirm(
            `Complete these exact Sentinel goal criteria?\n${
              JSON.stringify({
                ref,
                runId: state.plan.runId,
                goalProofDigest,
                criteria: proof.criteria,
                observations: proof.observations,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await authorize(args)) return unavailable;
        return completeSentinelRegisteredGoal(
            path,
            ref.revision,
            state.plan.goal ?? null,
            decision,
            options.webContainmentConfigured,
            { runId: state.plan.runId!, digest: goalProofDigest },
          )
          ? success()
          : unavailable;
      }
      if (
        action === "goals" || action === "append_goals" ||
        action === "revise_goals" || action === "withdraw_goal" ||
        action === "goal_proposals" ||
        action === "approve_goal_proposal"
      ) {
        const read = action === "goals" || action === "goal_proposals";
        const proposalAction = action === "approve_goal_proposal";
        const withdrawal = action === "withdraw_goal";
        const supersedes = parseSentinelGoalSupersession(args.supersedes);
        if (
          args.supersedes !== undefined && (
            !supersedes || action !== "append_goals" ||
            !context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
            !canFlowTo(context.inputClassification ?? "PUBLIC", "INTERNAL") ||
            !await context.authorizeOwnerRunCall?.(args)
          )
        ) return unavailable;
        if (
          (!read && (!context?.authenticatedOwnerSessionId ||
            !context.authorizeOwnerRunCall)) ||
          (withdrawal && (!context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC"))) ||
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              ...(read
                ? action === "goals"
                  ? ["goalId", "offset", "limit", "includeProof"]
                  : ["runId", "offset", "limit"]
                : [
                  "runId",
                  "requestId",
                  ...(supersedes ? ["supersedes"] : []),
                  proposalAction
                    ? "proposalId"
                    : withdrawal
                    ? "goalId"
                    : "goals",
                ]),
            ].includes(key)
          ) || !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        if (read) {
          const { goalId, includeProof, offset = 0, limit = 4 } = args;
          if (
            (goalId !== undefined && typeof goalId !== "string") ||
            (includeProof !== undefined &&
              (typeof includeProof !== "boolean" ||
                typeof goalId !== "string")) ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0 ||
            typeof limit !== "number" || !Number.isSafeInteger(limit) ||
            limit < 1 || limit > 5
          ) return unavailable;
          if (action === "goal_proposals") {
            if (
              typeof args.runId !== "string" ||
              readSentinelRunIdForRevision(path, ref.revision) !== args.runId
            ) return unavailable;
            const proposals = readSentinelWorkerGoalProposals(
              path,
              args.runId,
              ref.revision,
            );
            return safeProjection({
              run: ref,
              proposals: proposals.slice(offset, offset + Math.min(limit, 3)),
              nextOffset: offset + Math.min(limit, 3) < proposals.length
                ? offset + Math.min(limit, 3)
                : null,
            });
          }
          const current = readSentinelAssessment(path);
          const plan = current?.revision === ref.revision
            ? current.plan
            : readSentinelAssessmentRevision(path, ref.revision)?.plan;
          const {
            formalGoals = [],
            activeFormalGoalIds = [],
            completedFormalGoalIds = [],
            withdrawnFormalGoalIds = [],
            goalSupersessions = [],
          } = plan ?? {};
          const describe = (
            { id, title, policy, criteria }: typeof formalGoals[number],
          ) => {
            const supersedes = goalSupersessions.find(({ replacementGoalId }) =>
              replacementGoalId === id
            );
            return {
              id,
              title,
              policy,
              criteriaCount: criteria.length,
              ...(supersedes && { supersedes }),
              status: completedFormalGoalIds.includes(id)
                ? "completed"
                : withdrawnFormalGoalIds.includes(id)
                ? "withdrawn"
                : activeFormalGoalIds.includes(id)
                ? "active"
                : "inactive",
            };
          };
          const goal = goalId === undefined
            ? undefined
            : formalGoals.find(({ id }) => id === goalId);
          if (goalId !== undefined && !goal) return unavailable;
          const items = goal?.criteria ?? formalGoals.map(describe);
          const page = items.slice(offset, offset + limit);
          const proof = includeProof && goal
            ? readSentinelGoalCompletionAtRevision(path, ref.revision)
            : undefined;
          const visibleCriteria = new Set(
            page.map(({ id }) => `${goal?.id}/${id}`),
          );
          return safeProjection({
            run: ref,
            runId: plan?.runId ?? null,
            ...(goal
              ? { goal: describe(goal), criteria: page }
              : { goals: page }),
            ...(includeProof && {
              proof: proof
                ? {
                  status: proof.status,
                  policy: proof.policy,
                  digest: digestSentinelGoalProof(proof),
                  observations: proof.observations.filter(({ criterionId }) =>
                    visibleCriteria.has(criterionId)
                  ),
                }
                : null,
            }),
            nextOffset: offset + limit < items.length ? offset + limit : null,
          });
        }
        const { runId, requestId } = args;
        if (
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId)
        ) return unavailable;
        const proposal = proposalAction &&
          readSentinelWorkerGoalProposals(
            path,
            runId.toLowerCase(),
            ref.revision,
          )
            .find(({ id }) => id === args.proposalId);
        if (proposalAction && !proposal) return unavailable;
        const current = readSentinelAssessment(path);
        const exactPlan = current?.revision === ref.revision
          ? current.plan
          : readSentinelAssessmentRevision(path, ref.revision)?.plan;
        const withdrawn = withdrawal &&
          exactPlan?.formalGoals?.find(({ id }) => id === args.goalId);
        if (
          withdrawal && (!withdrawn || exactPlan?.runId !== runId.toLowerCase())
        ) return unavailable;
        const goals = normalizeSentinelFormalGoals(
          proposal ? [proposal.goal] : withdrawn ? [withdrawn] : args.goals,
        );
        const approval = {
          mode: withdrawal
            ? "withdraw" as const
            : action === "append_goals" || proposalAction
            ? "append" as const
            : "revise" as const,
          requestId: requestId.toLowerCase(),
          goals,
          proposalDigest: digestSentinelGoalProposal(goals),
          ...(proposal && { sourceProposalId: proposal.id }),
          ...(supersedes && { supersedes }),
          expectedRevision: ref.revision,
          expectedRunId: runId.toLowerCase(),
        };
        const selectedCase = context?.authorizeSelectedSentinelCase;
        if (
          selectedCase &&
          ((action !== "append_goals" && !withdrawal) || !selectedCase() ||
            redactCredentialText(JSON.stringify(goals)) !==
              JSON.stringify(goals))
        ) {
          return unavailable;
        }
        const prior = readSentinelFormalGoalApproval(path, approval);
        const withdrawnGoalId = withdrawn ? withdrawn.id : undefined;
        if (prior) {
          return safeProjection({
            run: ref,
            receipt: prior,
            ...(withdrawnGoalId && { withdrawnGoalId }),
          });
        }
        if (
          current?.revision !== ref.revision ||
          current.plan.runId !== approval.expectedRunId ||
          (withdrawn &&
            (!current.active ||
              !current.plan.activeFormalGoalIds?.includes(withdrawn.id) ||
              current.plan.completedFormalGoalIds?.includes(withdrawn.id)))
        ) return unavailable;
        const superseded = supersedes &&
          readSentinelGoalSupersessionSource(
            path,
            supersedes,
            approval.expectedRunId,
          );
        if (
          supersedes && (!superseded ||
            current.plan.goalSupersessions?.some(({ goalId }) =>
              goalId === supersedes.goalId
            ))
        ) return unavailable;
        if (
          !await options.confirm(
            `${
              withdrawal
                ? "Withdraw this exact Sentinel formal goal?"
                : supersedes
                ? "Approve this replacement for an exact completed Sentinel goal?"
                : "Approve these exact Sentinel formal goal definitions?"
            }\n${
              JSON.stringify({
                run: ref,
                ...approval,
                ...(superseded && { superseded }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await context?.authorizeOwnerRunCall?.(args) ||
          (selectedCase && !selectedCase()) || !await controller.inspect(ref)
        ) {
          return unavailable;
        }
        const { state, ...receipt } = applySentinelFormalGoals(
          path,
          approval,
          options.webContainmentConfigured,
        );
        if (!receipt.duplicate) {
          ensureSentinelFormalGoalContract(path, state);
          advanceAdaptiveSentinel(path, state);
          if (
            (withdrawn || supersedes) && state.active && !state.paused &&
            state.plan.runId
          ) {
            notifyCommittedEvidence({
              case: ref.id,
              run_id: state.plan.runId,
              revision: state.revision,
              observation_id: `formal-goal-${
                supersedes ? "supersession" : "withdrawal"
              }:${approval.requestId}`,
            });
          }
        }
        return safeProjection({
          run: ref,
          receipt,
          ...(withdrawnGoalId && { withdrawnGoalId }),
        });
      }
      if (backgroundRole && (action === "pause" || action === "resume")) {
        const authorize = context?.authorizeOwnerRunCall;
        if (!authorize || !context?.authenticatedOwnerSessionId) {
          return unavailable;
        }
        const pausing = action === "pause";
        const delegated = !pausing && backgroundRole === "delegated";
        const publicRef = publicTeamControlRef ?? ref;
        const { executionId, originalTask } = args;
        if (
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              ...(delegated ? ["originalTask"] : []),
              ...(delegated && !teamControlRef ? ["executionId"] : []),
            ].includes(key)
          ) ||
          (delegated && (typeof originalTask !== "string" ||
            !originalTask.trim() || originalTask.length > 8_000 ||
            originalTask.includes("\0") ||
            redactCredentialText(originalTask) !== originalTask))
        ) return unavailable;
        if (
          !pausing && !delegated &&
          (!/^scheduler-(?:cron|trigger|webhook)-[a-f0-9]{64}$/.test(ref.id) ||
            !options.resumeScheduledExecution)
        ) return unavailable;
        const before = await controller.inspect(ref);
        if (!before) return unavailable;
        const present = (pauseRequested = false) =>
          controller.inspect(ref).then((run) =>
            run
              ? safeProjection({
                run: { ...projectBackgroundRun(run), ref: publicRef },
                ...(pauseRequested && { pauseRequested }),
              })
              : unavailable
          );
        const journal = openExecutionTraces(backgroundTracePath);
        try {
          const initial = journal.readRun(backgroundRole, ref.id, "INTERNAL");
          if (
            initial?.status !== "running" || initial.operatorCancelled ||
            !canReadBackgroundTrace(initial)
          ) return unavailable;
          const team = parseTeamDeliveryTraceSource(initial.scope.sourceId);
          const exactAdmission = teamControlAdmission(initial);
          const reviewedAdmission = await exactAdmission?.read();
          if (teamControlRef && !reviewedAdmission) return unavailable;
          if (pausing && before.status === "paused") return await present();
          if (before.status !== (pausing ? "running" : "paused")) {
            return unavailable;
          }
          let resumeDelegated: (() => Promise<void>) | undefined;
          if (delegated && typeof originalTask === "string") {
            if (team) {
              const resume = context?.resumeTeamDelivery;
              if (
                executionId !== undefined || !resume ||
                team.sender !== context.authenticatedOwnerSessionId ||
                ref.id !== await teamDeliveryExecutionId(
                    team.sender,
                    initial.scope.sessionId as SessionId,
                    team.delivery,
                  )
              ) return unavailable;
              resumeDelegated = () =>
                resume(
                  team.delivery,
                  team.teamId,
                  initial.scope.sessionId,
                  originalTask,
                );
            } else {
              const recovery = context?.delegatedRecovery;
              if (
                !recovery || typeof executionId !== "string" ||
                !digestPattern.test(executionId)
              ) return unavailable;
              const request = executionId.toLowerCase();
              const identity = await delegatedSubagentIdentity(
                recovery.parent,
                request,
              );
              if (
                identity.executionId !== ref.id ||
                initial.scope.sessionId !== identity.sessionId ||
                initial.scope.sourceId !== recovery.parent
              ) return unavailable;
              resumeDelegated = () => recovery.resume(request, originalTask);
            }
          }
          if (
            !await options.confirm(
              `${pausing ? "Pause" : "Resume"} this exact background run?\n${
                JSON.stringify(publicRef)
              }`,
            )
          ) return "Error: The operator declined the run action.";
          if (
            (exactAdmission &&
              !isDeepStrictEqual(
                await exactAdmission.read(),
                reviewedAdmission,
              )) ||
            !await authorize(args)
          ) return unavailable;
          const current = journal.readRun(backgroundRole, ref.id, "INTERNAL");
          if (
            current?.status !== "running" || current.operatorCancelled ||
            !canReadBackgroundTrace(current) ||
            !isDeepStrictEqual(current.scope, initial.scope)
          ) return unavailable;
          if (!pausing) {
            if (inspectBackgroundRecovery(current)?.status !== "paused") {
              return unavailable;
            }
            if (resumeDelegated) {
              await resumeDelegated();
              if (
                journal.readRun(backgroundRole, ref.id, "INTERNAL")?.status !==
                  "completed"
              ) return unavailable;
            } else if (!await options.resumeScheduledExecution?.(ref.id)) {
              return unavailable;
            }
          } else {
            const key = recoveryKey(current);
            using lock = lockAgentRecovery(recoveryPath, key);
            const store = new AgentRecoveryStore(recoveryPath);
            try {
              if (!lock) {
                if (!store.requestPause(key, true)) {
                  return "Error: The background execution has no recovery admission available to pause.";
                }
                return await present(true);
              }
              if (!store.pauseAtCommittedCheckpoint(key, true)) {
                return "Error: The background execution has no eligible recovery state available to pause.";
              }
            } finally {
              store.close();
            }
          }
        } finally {
          journal.close();
        }
        return await present();
      }
      if (action === "cancel") {
        const { runId } = args;
        const sentinel = ref.kind === "sentinel";
        const authorize = context?.authorizeOwnerRunCall;
        if (!authorize || !context?.authenticatedOwnerSessionId) {
          return unavailable;
        }
        if (
          Object.keys(args).some((key) =>
            !(sentinel
              ? ["action", "kind", "id", "revision", "runId"]
              : ["action", "kind", "id"]).includes(key)
          ) || (sentinel && (ref.revision === undefined ||
            typeof runId !== "string" || !digestPattern.test(runId)))
        ) return unavailable;
        const before = await controller.inspect(ref);
        const exactRunId = typeof runId === "string"
          ? runId.toLowerCase()
          : undefined;
        if (!before || (sentinel && before.details?.runId !== exactRunId)) {
          return unavailable;
        }
        const publicRef = publicTeamControlRef ?? ref;
        const approvedTeamAdmission = teamControlRef &&
          await (async () => {
            const journal = openExecutionTraces(backgroundTracePath);
            try {
              const run = journal.readRun("delegated", ref.id, "INTERNAL");
              return run && await teamControlAdmission(run)?.read();
            } finally {
              journal.close();
            }
          })();
        if (teamControlRef && !approvedTeamAdmission) return unavailable;
        if (before.status === (sentinel ? "stopped" : "cancelled")) {
          return safeProjection({
            run: backgroundRole
              ? { ...projectBackgroundRun(before), ref: publicRef }
              : before,
          });
        }
        if (!["running", "paused", "interrupted"].includes(before.status)) {
          return unavailable;
        }
        if (
          !await options.confirm(
            `Cancel this exact operator run?\n${
              JSON.stringify({
                ref: publicRef,
                ...(sentinel && { runId: exactRunId }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!backgroundRole && !await authorize(args)) return unavailable;
        if (backgroundRole) {
          const journal = openExecutionTraces(backgroundTracePath);
          try {
            const current = journal.readRun(backgroundRole, ref.id, "INTERNAL");
            if (
              !current || !canReadBackgroundTrace(current) ||
              (teamControlRef && !isDeepStrictEqual(
                await teamControlAdmission(current)?.read(),
                approvedTeamAdmission,
              )) ||
              !await authorize?.(args)
            ) return unavailable;
            const latest = journal.readRun(backgroundRole, ref.id, "INTERNAL");
            if (
              !latest || !canReadBackgroundTrace(latest) ||
              !isDeepStrictEqual(current.scope, latest.scope)
            ) return unavailable;
            const cancelled = journal.cancelRun(
              backgroundRole,
              ref.id,
              "INTERNAL",
            );
            return cancelled
              ? safeProjection({
                run: {
                  ...projectBackgroundRun(backgroundRunSummary(cancelled)),
                  ref: publicRef,
                },
              })
              : unavailable;
          } finally {
            journal.close();
          }
        }
        const run = sentinel && exactRunId
          ? providers.sentinel.cancelExact(ref, exactRunId)
          : asWorkflowSummary(
            options.workflows?.cancel(ref.id, context?.ceiling ?? "INTERNAL"),
          );
        return run ? safeProjection({ run }) : unavailable;
      }
      if (action === "spawn") {
        const authorize = context?.authorizeOwnerRunCall;
        if (!authorize || !context?.authenticatedOwnerSessionId) {
          return unavailable;
        }
        const {
          targetKind,
          targetId,
          requestId,
          childGoal: rawChildGoal,
          childDescription: rawChildDescription,
          templateId,
          templateVersion,
          category: rawCategory,
          goalProposal,
          initialGraph,
          organizationId,
          seedTask: rawSeedTask,
          timeoutSeconds,
          modelProfile: namedProfile,
          fallbackModelProfiles: namedFallbacks,
          plannerHeartbeatSeconds,
          inventoryCoverageEnabled,
          sourceCases,
        } = args;
        const templated = templateId !== undefined ||
          templateVersion !== undefined;
        const selection = templated
          ? parseAssessmentTemplateSelector({
            id: templateId,
            version: templateVersion,
          })
          : undefined;
        const authorizeAdmission = async () =>
          (!selection || await authorize({ action: "assessment_templates" })) &&
          await authorize(args);
        if (
          templated && (
            !selection || targetKind !== "sentinel" ||
            rawChildGoal !== undefined ||
            rawChildDescription !== undefined ||
            !context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
            !await context.authorizeOwnerRunCall?.(args) ||
            !await context?.authorizeOwnerRunCall?.({
              action: "assessment_templates",
            })
          )
        ) return unavailable;
        const template = selection &&
          readAssessmentTemplate(options.baseDir, selection);
        if (selection && !template) return unavailable;
        const explicitCategory = parseOperatorRunCategorySelection(rawCategory);
        if (
          rawCategory !== undefined && (
            !explicitCategory || targetKind !== "sentinel" ||
            !context?.authenticatedOwnerSessionId ||
            !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
            !await context.authorizeOwnerRunCall?.(args)
          )
        ) return unavailable;
        const category = explicitCategory ?? (template?.category && {
          id: template.category.id,
          version: template.category.version,
        });
        const childGoal = template?.objective ?? rawChildGoal;
        const childDescription = template?.description ?? rawChildDescription;
        const templateKey = template
          ? createHash("sha256").update(JSON.stringify(template)).digest("hex")
          : undefined;
        const seedTask = parseSentinelLinkedSeedTask(rawSeedTask);
        const workflows = options.workflows;
        const ceiling = context?.ceiling ?? "INTERNAL";
        if (
          (targetKind !== "workflow" && targetKind !== "sentinel") ||
          typeof targetId !== "string" ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          (ref.kind === "sentinel" && ref.revision === undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "targetKind",
              "targetId",
              "requestId",
              "childGoal",
              "childDescription",
              "templateId",
              "templateVersion",
              "category",
              "goalProposal",
              "initialGraph",
              "organizationId",
              "seedTask",
              "timeoutSeconds",
              "modelProfile",
              "fallbackModelProfiles",
              "plannerHeartbeatSeconds",
              "inventoryCoverageEnabled",
              "sourceCases",
            ].includes(key)
          ) ||
          (sourceCases !== undefined &&
            (targetKind !== "sentinel" || !Array.isArray(sourceCases) ||
              !sourceCases.length || sourceCases.length > 4)) ||
          (initialGraph !== undefined &&
            (initialGraph !== "empty" || targetKind !== "sentinel" ||
              rawSeedTask !== undefined || organizationId !== undefined)) ||
          (organizationId !== undefined &&
            (targetKind !== "sentinel" || typeof organizationId !== "string" ||
              !organizationId.trim() || organizationId.length > 256 ||
              organizationId.includes("\0"))) ||
          (rawSeedTask !== undefined &&
            (targetKind !== "sentinel" || !seedTask)) ||
          (childDescription !== undefined &&
            (targetKind !== "sentinel" ||
              !validSentinelChildDescription(childDescription))) ||
          (childGoal !== undefined &&
            (targetKind !== "sentinel" || typeof childGoal !== "string" ||
              !childGoal.trim() || childGoal.length > 500)) ||
          (inventoryCoverageEnabled !== undefined &&
            (targetKind !== "sentinel" ||
              typeof inventoryCoverageEnabled !== "boolean")) ||
          (plannerHeartbeatSeconds !== undefined &&
            (targetKind !== "sentinel" ||
              !validPlannerHeartbeatSeconds(plannerHeartbeatSeconds))) ||
          (namedFallbacks !== undefined &&
            (targetKind !== "sentinel" || !Array.isArray(namedFallbacks) ||
              !namedFallbacks.length || namedFallbacks.length > 3 ||
              !namedFallbacks.every(isModelProfileName))) ||
          (namedProfile !== undefined &&
            (targetKind !== "sentinel" || !isModelProfileName(namedProfile))) ||
          (timeoutSeconds !== undefined &&
            (targetKind !== "sentinel" || typeof timeoutSeconds !== "number" ||
              !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 ||
              timeoutSeconds > MAX_SENTINEL_RUN_TIMEOUT_SECONDS)) ||
          (targetKind === "workflow" &&
            !workflows?.listPlans(ceiling).some(({ id }) => id === targetId)) ||
          (targetKind === "sentinel" &&
            (targetId === "main" || !canFlowTo("INTERNAL", ceiling)))
        ) return unavailable;
        const request = requestId.toLowerCase();
        let goalApproval: SentinelFormalGoalApproval | undefined;
        if (goalProposal !== undefined) {
          if (
            targetKind !== "sentinel" || !goalProposal ||
            typeof goalProposal !== "object" || Array.isArray(goalProposal) ||
            Object.keys(goalProposal).some((key) =>
              key !== "goals" && key !== "initialConstraints"
            )
          ) return unavailable;
          const { goals: definitions, initialConstraints: restrictions } =
            goalProposal as Record<string, unknown>;
          const goals = normalizeSentinelFormalGoals(definitions);
          const initialConstraints = restrictions === undefined
            ? undefined
            : normalizeSentinelOperatingConstraints(restrictions);
          goalApproval = {
            mode: "start" as const,
            requestId: request,
            expectedRevision: 0,
            goals,
            proposalDigest: digestSentinelGoalProposal(goals),
            ...(typeof childGoal === "string" && { plan: { goal: childGoal } }),
            ...(initialConstraints && { initialConstraints }),
          };
        }
        const parent = (await controller.inspect(ref))?.ref;
        if (!parent) return unavailable;
        const readSourceCases = async () => {
          if (!Array.isArray(sourceCases)) return;
          const sources: SentinelLinkedCaseSource[] = [];
          for (const selected of sourceCases) {
            if (
              !selected || typeof selected !== "object" ||
              Array.isArray(selected) || Object.keys(selected).length !== 2
            ) return;
            const source = reference(
              "sentinel",
              selected.caseId,
              selected.revision,
            );
            if (
              !source || source.revision === undefined ||
              source.id === targetId || !await controller.inspect(source)
            ) return;
            const sourcePath = resolveSentinelCasePath(
              options.baseDir,
              source.id,
            );
            const runId = readSentinelRunIdForRevision(
              sourcePath,
              source.revision,
            );
            if (!runId) return;
            sources.push({
              caseId: source.id,
              revision: source.revision,
              runId,
            });
          }
          return parseSentinelLinkedCaseSources(sources);
        };
        const linkedCaseSources = await readSourceCases();
        if (sourceCases !== undefined && !linkedCaseSources) return unavailable;
        const inheritedProfile =
          targetKind === "sentinel" && namedProfile === undefined &&
            parent.kind === "sentinel"
            ? providers.sentinel.modelProfile(parent)
            : undefined;
        const selectableProfile = () =>
          options.sentinelProfiles?.().find(
            (profile) =>
              namedProfile !== undefined
                ? profile.provider === namedProfile
                : isDeepStrictEqual(profile, inheritedProfile),
          );
        const modelProfile = selectableProfile();
        if (
          (namedProfile !== undefined || inheritedProfile !== undefined) &&
          !modelProfile
        ) {
          return unavailable;
        }
        const inheritedFallbacks =
          namedFallbacks === undefined && inheritedProfile
            ? providers.sentinel.fallbackModels(parent)
            : undefined;
        const selectFallbacks = () => {
          const profiles = options.sentinelProfiles?.() ?? [];
          const selected = Array.isArray(namedFallbacks)
            ? namedFallbacks.map((name) =>
              profiles.find(({ provider }) => provider === name)
            )
            : inheritedFallbacks?.map((fallback) =>
              profiles.find((candidate) =>
                isDeepStrictEqual(fallback, candidate)
              )
            );
          return parseModelFallbackProfiles(selected, modelProfile);
        };
        const modelFallbackProfiles = selectFallbacks();
        if (
          (namedFallbacks !== undefined || inheritedFallbacks !== undefined) &&
          !modelFallbackProfiles
        ) return unavailable;
        const parentScope = backgroundRole &&
          readBackgroundTrace(backgroundRole, parent.id)?.scope;
        if (backgroundRole && !parentScope) return unavailable;
        const childRequest = createHash("sha256").update(
          JSON.stringify(["operator-spawn", linkScope, operatorId, request]),
        ).digest("hex");
        const target: OperatorRunRef = { kind: targetKind, id: targetId };
        const emptyCreationDigest = initialGraph === "empty"
          ? createHash("sha256").update(JSON.stringify([
            "sentinel-linked-empty-v1",
            childRequest,
            parent,
            target,
            childGoal,
            childDescription,
            ...(templateKey === undefined ? [] : [templateKey]),
            ...(category === undefined ? [] : [category]),
            goalApproval,
            timeoutSeconds,
            modelProfile,
            modelFallbackProfiles,
            linkedCaseSources,
            plannerHeartbeatSeconds,
            ...(inventoryCoverageEnabled === undefined
              ? []
              : [inventoryCoverageEnabled]),
          ])).digest("hex")
          : undefined;
        const readLinkedChild = async () => {
          const link = links.readRequest(linkScope, operatorId, request);
          if (!link) return;
          const same = (left: OperatorRunRef, right: OperatorRunRef) =>
            left.kind === right.kind && left.id === right.id &&
            left.revision === right.revision;
          const other = same(link.left, parent)
            ? link.right
            : same(link.right, parent)
            ? link.left
            : undefined;
          if (!other || other.kind !== targetKind) return unavailable;
          if (targetKind === "sentinel") {
            const originalRoute = providers.sentinel.startModelRoute(other);
            if (
              link.origin !== "spawn" || link.requestId !== request ||
              other.id !== targetId || other.revision === undefined
            ) return unavailable;
            if (emptyCreationDigest) {
              const allowed = await withSentinelSourceSnapshotLock(
                options.baseDir,
                true,
                async () => {
                  if (!await authorizeAdmission()) return false;
                  providers.sentinel.finishEmptyStart(
                    other,
                    emptyCreationDigest,
                  );
                  return true;
                },
              );
              if (!allowed) return unavailable;
            }
            const admissionCategory = providers.sentinel.startCategory(other);
            if (
              (category === undefined) !== (admissionCategory === undefined) ||
              (category && (admissionCategory?.id !== category.id ||
                admissionCategory.version !== category.version))
            ) return unavailable;
            if (
              !providers.sentinel.matchesStartEmpty(
                other,
                emptyCreationDigest,
              ) ||
              !providers.sentinel.matchesStartTemplate(other, templateKey) ||
              !providers.sentinel.matchesStartGoal(other, childGoal) ||
              !providers.sentinel.matchesStartGoalApproval(
                other,
                goalApproval,
              ) ||
              providers.sentinel.childDescription(other) !== childDescription ||
              providers.sentinel.startOrganization(other) !== organizationId ||
              !isDeepStrictEqual(
                providers.sentinel.startSeed(other),
                seedTask,
              ) ||
              !providers.sentinel.matchesStartTimeout(other, timeoutSeconds) ||
              !isDeepStrictEqual(
                providers.sentinel.linkedCaseSources(other),
                linkedCaseSources,
              ) ||
              providers.sentinel.plannerHeartbeat(other) !==
                plannerHeartbeatSeconds ||
              providers.sentinel.inventoryCoverage(other) !==
                inventoryCoverageEnabled ||
              !isDeepStrictEqual(
                originalRoute?.primary,
                modelProfile,
              ) ||
              !isDeepStrictEqual(
                originalRoute?.alternates,
                modelFallbackProfiles,
              )
            ) return unavailable;
            const child = await controller.inspect(other);
            return child
              ? safeProjection({
                run: child,
                link,
                ...(selection && { template: selection }),
                ...(admissionCategory && { admissionCategory }),
              })
              : unavailable;
          }
          const child = workflows?.inspectRequest(childRequest, ceiling);
          if (child?.planId !== targetId || other.id !== child?.runId) {
            return unavailable;
          }
          return safeProjection({ run: asWorkflowSummary(child), link });
        };
        const prior = await readLinkedChild();
        if (prior !== undefined) return prior;
        if (
          selection &&
          !withCurrentAssessmentTemplate(options.baseDir, selection, () => true)
        ) return unavailable;
        const admissionCategory = category &&
          links.categories.atVersion(category);
        if (category && !admissionCategory) return unavailable;
        const graphDigest = emptyCreationDigest
          ? providers.sentinel.canStartEmpty(target)
            ? emptyLinkedSentinelGraphDigest
            : undefined
          : target.kind === "sentinel"
          ? providers.sentinel.publishedStartDigest(target)
          : undefined;
        if (
          target.kind === "sentinel" && (!graphDigest ||
            (parent.kind === "sentinel" && parent.id === target.id))
        ) return unavailable;
        const membership = organizationId === undefined
          ? undefined
          : providers.sentinel.previewStartOrganization(target, organizationId);
        if (organizationId !== undefined && !membership) return unavailable;
        if (
          !await options.confirm(
            `Start and link this ${
              emptyCreationDigest ? "empty Sentinel case" : "published run"
            }?\n${
              JSON.stringify({
                parent,
                target,
                requestId: request,
                ...(graphDigest && { graphDigest }),
                ...(emptyCreationDigest && { initialGraph }),
                ...(childGoal !== undefined && { childGoal }),
                ...(childDescription !== undefined && { childDescription }),
                ...(template && { template }),
                ...(admissionCategory && { admissionCategory }),
                ...(goalApproval && { goalApproval }),
                ...(membership && { membership }),
                ...(seedTask && { seedTask }),
                ...(timeoutSeconds !== undefined && { timeoutSeconds }),
                ...(modelProfile && { modelProfile }),
                ...(modelFallbackProfiles && { modelFallbackProfiles }),
                ...(linkedCaseSources && { linkedCaseSources }),
                ...(plannerHeartbeatSeconds !== undefined &&
                  { plannerHeartbeatSeconds }),
                ...(inventoryCoverageEnabled !== undefined &&
                  { inventoryCoverageEnabled }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (
          !await controller.inspect(parent) ||
          !isDeepStrictEqual(selectableProfile(), modelProfile) ||
          !isDeepStrictEqual(selectFallbacks(), modelFallbackProfiles) ||
          !isDeepStrictEqual(await readSourceCases(), linkedCaseSources) ||
          (backgroundRole &&
            !isDeepStrictEqual(
              readBackgroundTrace(backgroundRole, parent.id)?.scope,
              parentScope,
            ))
        ) return unavailable;
        const link = {
          path: linkPath,
          input: {
            scope: linkScope,
            operatorId,
            requestId: request,
            left: parent,
          },
        };
        try {
          if (target.kind === "sentinel" && graphDigest) {
            const admit = () =>
              providers.sentinel.startLinked(target, {
                ...link,
                graphDigest,
                emptyCreationDigest,
                childGoal,
                childDescription,
                templateKey,
                category,
                goalApproval,
                membership,
                seedTask,
                timeoutSeconds,
                modelProfile,
                modelFallbackProfiles,
                plannerHeartbeatSeconds,
                inventoryCoverageEnabled,
                linkedCaseSources,
              });
            const start = async () => {
              if (!await authorizeAdmission()) return;
              if (!selection) return admit();
              return withCurrentAssessmentTemplate(
                options.baseDir,
                selection,
                admit,
              );
            };
            if (emptyCreationDigest) {
              await withSentinelSourceSnapshotLock(
                options.baseDir,
                true,
                start,
              );
            } else await start();
          } else if (await authorizeAdmission()) {
            workflows?.start(target.id, ceiling, childRequest, link);
          }
        } catch {
          // A simultaneous retry may have committed the exact request.
        }
        return await readLinkedChild() ?? unavailable;
      }
      if (action === "link") {
        const other = reference(
          args.targetKind,
          args.targetId,
          args.targetRevision,
        ) ??
          backgroundReference(
            args.targetKind,
            args.targetId,
            args.targetRevision,
          );
        const requestId = args.requestId;
        if (
          !context?.authenticatedOwnerSessionId ||
          !context.authorizeOwnerRunCall ||
          !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC") ||
          !other || typeof requestId !== "string" ||
          !digestPattern.test(requestId) ||
          ref.kind === "sentinel" && ref.revision === undefined ||
          other.kind === "sentinel" && other.revision === undefined
        ) return unavailable;
        const link = await controller.link({
          requestId: requestId.toLowerCase(),
          left: ref,
          right: other,
        });
        return link ? safeProjection({ link }) : unavailable;
      }
      if (
        action !== "start" && action !== "pause" && action !== "resume" &&
        action !== "hint"
      ) {
        return unavailable;
      }
      if (
        !context?.authenticatedOwnerSessionId || !context.authorizeOwnerRunCall
      ) return unavailable;
      if (
        ref.kind === "sentinel" && action !== "start" &&
        ref.revision === undefined
      ) {
        return "Error: Use the exact Sentinel evidence revision from run inspection.";
      }
      let control;
      if (action === "start" && ref.kind === "workflow") {
        if (
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) {
          return "Error: Start a configured workflow with a stable request UUID.";
        }
        control = { requestId: args.requestId.toLowerCase() };
      }
      let authorizeTrafficHint: (() => Promise<boolean>) | undefined;
      if (action === "hint") {
        if (
          ref.kind !== "sentinel" ||
          args.taskId !== undefined ||
          typeof args.note !== "string" || !args.note.trim() ||
          args.note.length > 1000 ||
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) return unavailable;
        const assetIds = normalizeSentinelHintAssets(args.assetIds);
        const trafficReference = parseOperatorHintTraffic(args);
        if (
          trafficReference === null ||
          (trafficReference !== undefined &&
            (assetIds?.length !== 1 || !context?.authorizeOwnerRunCall))
        ) return unavailable;
        if (args.assetIds !== undefined) {
          if (
            !assetIds || ref.revision === undefined ||
            !canFlowTo("INTERNAL", context?.ceiling ?? "INTERNAL")
          ) return unavailable;
          const run = await controller.inspect(ref);
          if (!run) return unavailable;
          const path = resolveSentinelCasePath(options.baseDir, ref.id);
          const current = readSentinelAssessment(path);
          if (
            !current?.active || current.revision !== ref.revision ||
            !sentinelHintAssetsInScope(path, current, assetIds)
          ) return unavailable;
          if (trafficReference) {
            const authorizeCall = context?.authorizeOwnerRunCall;
            if (!context || !authorizeCall) return unavailable;
            const revision = ref.revision;
            authorizeTrafficHint = async () => {
              for (
                const source of sentinelHintTrafficReferences(trafficReference)
              ) {
                const receipt = readProjectedSentinelTrafficReceipt(
                  path,
                  ref.id,
                  revision,
                  source,
                  assetIds[0],
                );
                if (
                  !receipt || !await authorizeCall({
                    action: "traffic_get",
                    kind: "sentinel",
                    id: ref.id,
                    revision,
                    ...source,
                  })
                ) return false;
                if (
                  !await context.authorizeSavedResponse(
                    operatorRunTool.name,
                    safeProjection({
                      caseId: ref.id,
                      revision,
                      ...source,
                    }),
                    "INTERNAL",
                  )
                ) return false;
              }
              return await authorizeCall(args);
            };
            if (!await authorizeTrafficHint()) return unavailable;
          }
          const prior = readSentinelOperatorAssetHint(
            path,
            current,
            args.requestId.toLowerCase(),
            args.note.trim(),
            assetIds,
            trafficReference,
          );
          if (prior === null) return unavailable;
          if (prior) return safeProjection({ run });
        }
        control = {
          note: args.note.trim(),
          requestId: args.requestId.toLowerCase(),
          ...(assetIds && { assetIds }),
          ...(trafficReference && { trafficReference }),
        };
      }
      if (
        !await options.confirm(
          `Approve operator run action ${action}?\n${
            JSON.stringify({ ref, ...control })
          }`,
        )
      ) {
        return "Error: The operator declined the run action.";
      }
      const authorized = authorizeTrafficHint
        ? await authorizeTrafficHint()
        : await context.authorizeOwnerRunCall(args);
      if (!authorized) {
        return unavailable;
      }
      const run = await controller.mutate(action, ref, control);
      return run ? safeProjection({ run }) : unavailable;
    } catch {
      return unavailable;
    } finally {
      links.close();
    }
  };
  return execute;
}
