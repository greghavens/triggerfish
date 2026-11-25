import {
  isSentinelInventoryFindingRead,
  isSentinelInventoryNeighborhoodRead,
  readSentinelDiscoveryPageReference,
  readSentinelFindingPageReference,
  readSentinelTaskObservationPageReference,
  sentinelGoalReceiptReadArguments,
  sentinelIntermediateWorkflowPageReference,
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
import { loadSentinelGraph } from "../sentinel/graph.ts";
import { isSentinelFindingMutation } from "../sentinel/worker_finding_recovery.ts";
import { executionFindingAsset } from "../sentinel/worker_finding_evidence.ts";
import {
  SENTINEL_TRAFFIC_ATTACH,
  SENTINEL_TRAFFIC_LINKS,
  SENTINEL_TRAFFIC_READ,
  SENTINEL_TRAFFIC_SEARCH,
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
  receiptRecheckCandidate,
} from "./sentinel_execution_rechecks.ts";
import { createHash } from "node:crypto";
import type { EffectiveModelProfile } from "../agent/llm.ts";
import type { RecoveryToolCall } from "../core/types/orchestrator.ts";
import {
  canFlowTo,
  type ClassificationLevel,
  maxClassification,
} from "../core/types/classification.ts";
/** Owner-only root tool for exact Sentinel and admitted workflow runs. */
import { join } from "@std/path";
import {
  type ExecutionTraceApprovedPayload,
  executionTracePayloadCall,
  executionTracePayloadResponse,
  openExecutionTraces,
} from "../core/execution_traces.ts";
import {
  openOperatorRunLinkStore,
  OperatorRunController,
  type OperatorRunKind,
  type OperatorRunProvider,
  type OperatorRunRef,
  type OperatorRunSummary,
} from "../core/operator_runs.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import {
  applySentinelFormalGoals,
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelFormalGoalApproval,
  readSentinelGitHubWorkflowReadReceipt,
  readSentinelOperatingConstraintHistory,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintVersion,
  readSentinelRunIdForRevision,
  readSentinelWorkerGoalProposals,
  readSentinelWorkerGoalProposalTraceReceipt,
  recordSentinelOperatingConstraints,
  type SentinelReviewStep,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../sentinel/case_membership.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
  readCitedSentinelAliasSnapshot,
  readSharedSentinelTopologySource,
} from "../sentinel/shared_inventory.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingTraceReceipt,
} from "../sentinel/worker_finding_store.ts";
import {
  normalizeSentinelOperatingConstraints,
  validateSentinelOperatingConstraintAssets,
} from "../sentinel/operating_constraints.ts";
import {
  inspectSentinelProvenance,
  inspectSentinelWorkerObservation,
  queryIncidentAlerts,
  readDefenseCoverage,
  readSentinelInventoryProjection,
  searchSentinelProvenance,
  searchSentinelWorkerTraces,
  type SentinelReadTrace,
} from "./sentinel_agent.ts";
import {
  parseSentinelGraphFactRequirement,
  readSentinelCaseGraphFacts,
  readSentinelGraphFactPageReference,
  readSentinelWorkerGraphFact,
  type SentinelWorkerGraphFact,
} from "../sentinel/worker_graph_facts.ts";
import {
  advanceAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  readSentinelAdaptiveEvidenceMapping,
  readSentinelIntermediateWorkflowObservations,
  readSentinelWorkflowPublicationStep,
  submitSentinelAssignmentIntent,
} from "./sentinel_adaptive_runtime.ts";
import { executeOperatorEvidenceDigest } from "./operator_evidence_digests.ts";
import {
  nativeWorkflowControlCandidate,
  readCaseExecutionEvidence,
} from "../sentinel/case_execution_evidence.ts";
import {
  attachOperatorExecutionEvidence,
  attachOperatorNativeWorkflowControl,
} from "./operator_execution_evidence.ts";
import { executeOperatorInventoryWithdrawal } from "./operator_inventory_withdrawal.ts";
import { executeOperatorAssetWithdrawal } from "./operator_asset_withdrawal.ts";
import { executeOperatorRunArchive } from "./operator_run_archive.ts";
import { readOperatorSentinelInventory } from "./operator_sentinel_inventory.ts";
import { createOperatorSentinelRuns } from "./operator_sentinel_runs.ts";
import {
  attachOperatorSentinelFindingTraffic,
  executeSentinelFindingTrafficTool,
  sentinelFindingTrafficListTool,
} from "./sentinel_finding_traffic_tool.ts";
import { listSentinelFindingTrafficLinks } from "../sentinel/finding_traffic_links.ts";
import { readSentinelTrafficReceipt } from "../sentinel/traffic_receipts.ts";
import {
  projectSentinelTrafficReceipt,
  readProjectedSentinelTrafficPage,
  readProjectedSentinelTrafficReceipt,
  reopenProjectedSentinelTrafficPage,
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

export const operatorRunTool: ToolDefinition = {
  name: "operator_runs",
  description:
    "List and inspect approved runs. With operator confirmation, control an exact run or narrow which defensive tasks and assets Sentinel may schedule. Constraints do not grant capabilities.",
  parameters: {
    action: {
      type: "string",
      description: "Run operation",
      enum: [
        "list",
        "inspect",
        "start",
        "spawn",
        "link",
        "pause",
        "cancel",
        "resume",
        "assign",
        "archive",
        "restore",
        "archive_history",
        "execution_traces",
        "execution_trace_payload",
        "attach_branch_evidence",
        "attach_repository_visibility_evidence",
        "attach_workflow_control_evidence",
        "attach_execution_evidence",
        "case_execution_evidence",
        "finding_recheck_candidates",
        "steer",
        "stop",
        "hint",
        "profiles",
        "graph",
        "findings",
        "finding_receipt",
        "finding_receipts",
        "finding_report",
        "finding_traffic",
        "finding_traffic_candidates",
        "topology_source",
        "attach_finding_traffic",
        "facts",
        "save_digest",
        "list_digests",
        "expand_digest",
        "node",
        "inventory",
        "preview_membership",
        "preview_discovery_withdrawal",
        "withdraw_discoveries",
        "preview_inventory_withdrawal",
        "withdraw_inventory_host",
        "set_case_membership",
        "traces",
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
      enum: ["sentinel", "workflow", "delegated", "scheduled"],
    },
    id: {
      type: "string",
      description: "Exact run, published case, or configured plan ID",
    },
    revision: {
      type: "integer",
      description: "Exact Sentinel evidence revision",
    },
    receiptId: {
      type: "string",
      description: "Exact saved Sentinel worker finding or recheck ID",
    },
    observationId: {
      type: "string",
      description: "Exact committed intermediate observation ID",
    },
    trafficLinkId: {
      type: "string",
      description: "Exact link ID from a finding_traffic page",
    },
    family: sentinelTrafficSearchTool.parameters.family,
    origin: sentinelTrafficSearchTool.parameters.origin,
    hostname: sentinelTrafficSearchTool.parameters.hostname,
    method: sentinelTrafficSearchTool.parameters.method,
    status: sentinelTrafficSearchTool.parameters.status,
    from: sentinelTrafficSearchTool.parameters.from,
    until: sentinelTrafficSearchTool.parameters.until,
    recheckId: {
      type: "string",
      description: "Exact saved finding recheck ID",
    },
    evidenceId: {
      type: "string",
      description: "Exact retained traffic or topology evidence ID",
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
    proposalId: {
      type: "string",
      description: "Exact Sentinel worker goal proposal ID",
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
    targetKind: {
      type: "string",
      description: "Linked run type",
      enum: ["sentinel", "workflow"],
    },
    targetId: { type: "string", description: "Exact linked run ID" },
    targetRevision: {
      type: "integer",
      description: "Exact linked Sentinel evidence revision",
    },
    requestId: {
      type: "string",
      description:
        "Stable request UUID for linking, starting workflows, or giving guidance",
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
    graphRelationship: {
      type: "object",
      description:
        "For trace assignments, wait for the exact directed edge. For an asset-scoped verifies edge, add requireCurrentPass true to require a currently valid passing receipt. Omit from to require the latest observed check for that control and asset.",
    },
    traceRunId: {
      type: "string",
      description: "Exact source execution run ID for an evidence attachment",
    },
    branch: {
      type: "string",
      description: "Exact approved branch name in the source receipt",
    },
    controlId: { type: "string", description: "Exact Sentinel control ID" },
    validUntil: {
      type: "string",
      description: "Approved UTC expiration time for attached control evidence",
    },
    traceRole: {
      type: "string",
      description: "Trusted execution trace role",
      enum: ["delegated", "scheduled"],
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
    node: {
      type: "string",
      description:
        "Exact graph node for assignment or saved provenance ID for inspection",
    },
    stepIndices: {
      type: "array",
      items: { type: "integer" },
      description: "Exact worker step indices for the selected assignment",
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
    scopes: {
      type: "array",
      description:
        "Explicit Sentinel revisions, configured workflow runs, or delegated and scheduled runs. Use offset for Sentinel and cursor for other run types.",
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
          cursor: { type: "string" },
        },
      },
    },
    offset: { type: "integer", description: "Saved result offset" },
    limit: { type: "integer", description: "Bounded result page size" },
  },
};

/** Runtime policy for reopening an approved original tool response. */
export interface OperatorRunToolContext {
  readonly ceiling?: ClassificationLevel;
  readonly authorizeSentinelTraceRead?: (
    scope: { caseId: string; revision: number; taskId: string },
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

function safeProjection(
  value: Record<string, unknown>,
  classification: ClassificationLevel = "INTERNAL",
) {
  const text = JSON.stringify({ ...value, _classification: classification });
  return text.length <= 8000
    ? text
    : "Error: Select a run type or exact run to narrow the response.";
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
  return matches(payload.workflow) ||
    payload.runs.some(({ id, status, conclusion }) =>
      matches(id) || matches(status) || matches(conclusion)
    );
}

export function createOperatorRunToolExecutor(options: {
  readonly baseDir: string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly workflows?: OperatorWorkflowRuns;
  readonly readLiveWorkflow?: ReturnType<
    typeof createSentinelLiveWorkflowReader
  >;
  readonly authorizeExecutionTracePayload?: (
    payload: ExecutionTraceApprovedPayload,
    classification: ClassificationLevel,
  ) => Promise<boolean>;

  readonly webContainmentConfigured?: boolean;
  readonly profiles?: (
    ceiling: ClassificationLevel,
  ) => readonly EffectiveModelProfile[];
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

  async function readAuthorizedCaseEvidence(
    caseId: string,
    path: string,
    revision: number,
    node: string,
    context: OperatorRunToolContext,
    isCurrent: () => boolean,
  ) {
    if (!isCurrent()) return;
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
        signal: new AbortController().signal,
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

  return async (args, context) => {
    if (
      Object.keys(args).some((key) =>
        !Object.hasOwn(operatorRunTool.parameters, key)
      )
    ) {
      return "Error: Supply only defined operator run fields.";
    }
    const action = args.action;
    if (action === "execution_traces" || action === "execution_trace_payload") {
      const reopen = action === "execution_trace_payload";
      const { traceRole: role, id, ordinal, cursor, query } = args;
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
        (role !== undefined && role !== "delegated" && role !== "scheduled") ||
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
          if (!reopen && typeof query === "string") {
            const page = journal.search({
              query,
              role,
              runId: id,
              cursor,
              limit,
              ceiling: "INTERNAL",
            });
            return page ? safeProjection({ page }) : unavailable;
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
              runId: id,
              cursor,
              limit,
              ceiling: "INTERNAL",
            });
            if (!page) return unavailable;
            const matches = [];
            for (const candidate of page.matches) {
              const source = journal.readRun(
                candidate.role,
                candidate.runId,
                "INTERNAL",
              );
              if (!source) continue;
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
            if (role && id && !journal.readRun(role, id, "INTERNAL")) {
              return unavailable;
            }
            return safeProjection({
              page: {
                matches: matches.filter(({ role, runId }) =>
                  journal.readRun(role, runId, "INTERNAL")
                ),
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
            });
            return page ? safeProjection({ page }) : unavailable;
          }
          if (!role) return unavailable;
          const run = journal.readRun(role, id, "INTERNAL");
          if (!run) return unavailable;
          if (ordinal !== undefined) {
            const step = journal.inspect(run.scope, ordinal, "INTERNAL");
            if (!step) return unavailable;
            if (!reopen) return safeProjection({ run, step });
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
              ) || !journal.readRun(role, id, "INTERNAL")
            ) return unavailable;
            return safeProjection({ run, step, payload });
          }
          const page = journal.list(run.scope, {
            ceiling: "INTERNAL",
            limit,
            cursor,
          });
          return page ? safeProjection({ run, page }) : unavailable;
        } finally {
          journal.close();
        }
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
      return safeProjection({ profiles }, classification);
    }
    const linkPath = join(options.baseDir, "operator-run-links.db");
    const linkScope = "workspace-operator";
    const operatorId = "owner";
    const links = openOperatorRunLinkStore(linkPath);
    try {
      const controller = new OperatorRunController({
        scope: linkScope,
        operatorId,
        authorize: (_action, ref) => Object.hasOwn(providers, ref.kind),
        providers,
        links,
        approveLink: ({ left, right }) =>
          options.confirm(
            `Link these exact operator runs?\n${
              JSON.stringify({ left, right })
            }`,
          ),
      });
      if (action === "list") {
        const filter = kind(args.kind);
        if (args.kind !== undefined && !filter) return unavailable;
        return safeProjection({
          runs: (await controller.list(filter)).slice(0, 20),
        });
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
              if (!saved) return unavailable;
              const term = query.trim();
              const page = term
                ? journal.search({
                  role: run.kind,
                  runId: run.id,
                  query: term,
                  cursor,
                  limit,
                  ceiling: "INTERNAL",
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
      const ref = reference(args.kind, args.id, args.revision);
      if (
        action === "archive" || action === "restore" ||
        action === "archive_history"
      ) {
        const archiveRef = ref ?? (
          (args.kind === "delegated" || args.kind === "scheduled") &&
            typeof args.id === "string" && args.revision === undefined
            ? { kind: args.kind, id: args.id }
            : undefined
        );
        if (!archiveRef) return unavailable;
        const result = await executeOperatorRunArchive(
          options.baseDir,
          archiveRef,
          args,
          options.confirm,
          options.workflows,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (!ref) return unavailable;
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
            if (!run) return;
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
              !await authorizeTracePayload(
                context,
                authorizeSource,
                payload,
                step.classification,
              ) ||
              !journal.readRun(traceRole, traceRunId, "INTERNAL")
            ) return;
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
        action === "preview_inventory_withdrawal" ||
        action === "withdraw_inventory_host"
      ) {
        if (ref.kind !== "sentinel" || !await controller.inspect(ref)) {
          return unavailable;
        }
        const result = await executeOperatorInventoryWithdrawal(
          options.baseDir,
          ref,
          args,
          options.confirm,
          options.webContainmentConfigured,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (action === "assign") {
        const {
          runId,
          adaptiveRevision,
          requestId,
          taskKind,
          node,
          recheckFindingId,
          graphRelationship,
        } = args;
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
              "requestId",
              "taskKind",
              "node",
              "recheckFindingId",
              "graphRelationship",
            ].includes(key)
          ) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof taskKind !== "string" || !/^[a-z_]{1,64}$/.test(taskKind) ||
          typeof node !== "string" || !node.trim() || node.length > 4096 ||
          node.includes("\0")
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
        const before = await controller.inspect(ref);
        if (
          !before || before.details?.runId !== runId.toLowerCase() ||
          before.details.adaptiveRevision !== adaptiveRevision ||
          (before.status !== "running" && before.status !== "paused")
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const evidenceRevision = ref.revision;
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
        const intent = {
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          evidenceRevision: ref.revision,
          adaptiveRevision,
          kind: taskKind,
          nodeId: node,
          ...(relationship && { graphRelationship: relationship }),
          ...(typeof recheckFindingId === "string" && { recheckFindingId }),
        };
        if (original && typeof recheckFindingId === "string") {
          const prior = submitSentinelAssignmentIntent(
            path,
            intent,
            original.controlReceipt,
            true,
          );
          if (prior) return safeProjection({ run: ref, receipt: prior });
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
        }
        if (
          !await options.confirm(
            `Approve this exact Sentinel investigation?\n${
              JSON.stringify({
                ref,
                ...intent,
                ...(original && { executionReceiptSha256: original.digest }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const authorized = original && await reopen();
        if (original && !isDeepStrictEqual(authorized, original)) {
          return unavailable;
        }
        const receipt = submitSentinelAssignmentIntent(
          path,
          intent,
          authorized?.controlReceipt,
        );
        return receipt ? safeProjection({ run: ref, receipt }) : unavailable;
      }
      if (action === "steer" || action === "stop") {
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
        if (
          !await options.confirm(
            `Approve ${action} for this exact Sentinel assignment?\n${
              JSON.stringify({ ref, ...target })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const receipt = providers.sentinel.workerControl(ref, action, target);
        return receipt
          ? safeProjection({ run: ref, runId: target.runId, receipt })
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
        if (
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
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof args.runId !== "string" || !digestPattern.test(args.runId) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const runId = args.runId.toLowerCase();
        const revision = ref.revision;
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
        const constraints = normalizeSentinelOperatingConstraints({
          deniedKinds: args.deniedKinds,
          ...(args.allowedAssetIds !== undefined &&
            { allowedAssetIds: args.allowedAssetIds }),
          ...(args.note !== undefined && { note: args.note }),
        });
        if (
          !validateSentinelOperatingConstraintAssets(
            constraints,
            current.result?.sharedGraph.snapshot,
          )
        ) return unavailable;
        const update = {
          runId,
          evidenceRevision: ref.revision,
          expectedVersion,
          requestId: requestId.toLowerCase(),
          operatorScope: "workspace-operator",
          constraints,
        };
        const existing = readSentinelOperatingConstraints(path, runId);
        if ((existing?.version ?? 0) !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            runId,
            expectedVersion + 1,
          );
          if (
            replay?.requestId !== update.requestId ||
            replay.evidenceRevision !== revision ||
            JSON.stringify(replay.constraints) !== JSON.stringify(constraints)
          ) return unavailable;
        }
        if (
          !await options.confirm(
            `Approve these exact Sentinel task restrictions?\n${
              JSON.stringify({ caseId: ref.id, ...update })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const recorded = recordSentinelOperatingConstraints(path, update);
        return recorded
          ? safeProjection({ run: ref, record: recorded })
          : unavailable;
      }
      if (action === "inventory") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
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
          "INTERNAL",
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (
        action === "save_digest" || action === "list_digests" ||
        action === "expand_digest"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
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
        const { factId, limit = 3, offset = 0 } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "revision", "factId", "limit", "offset"]
              .includes(key)
          ) ||
          (factId !== undefined && (typeof factId !== "string" ||
            !/^worker-graph-fact:[a-f0-9]{64}$/.test(factId) ||
            args.offset !== undefined || args.limit !== undefined)) ||
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
        const page = adaptive
          ? readSentinelCaseGraphFacts(path, scope, {
            id: factId,
            limit,
            offset,
          })
          : factId === undefined
          ? { facts: [], nextOffset: null }
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
        return page ? safeProjection({ run: ref, page }) : unavailable;
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
          !context || ref.kind !== "sentinel" || ref.revision === undefined ||
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
                ? ["taskId", "stepIndices", "workflowRunNumber"]
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
        const history = readHistoricalAdaptiveSentinel(path, ref.revision);
        if (!runId || (history && history.goal.id !== runId)) {
          return unavailable;
        }
        if (progress) {
          const worker = history?.modelReviewStates.find((item) =>
            item.taskId === taskId
          );
          if (result) {
            if (
              !Array.isArray(stepIndices) || stepIndices.length !== 1 ||
              args.offset !== undefined || args.limit !== undefined
            ) {
              return unavailable;
            }
            const [index] = stepIndices;
            const savedStep = (
              state: typeof history,
            ): SentinelReadTrace | undefined => {
              if (state?.goal.id !== runId) {
                return;
              }
              const review = state.modelReviews.find((item) =>
                item.taskId === taskId
              )
                ?.steps[index] ??
                state.modelReviewStates.find((item) =>
                  item.taskId === taskId
                )
                  ?.progressSteps?.[index];
              if (review || typeof taskId !== "string") return review;
              const publication = readSentinelWorkflowPublicationStep(
                path,
                ref.revision!,
                runId,
                taskId,
                index,
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
              step?.tool === "sentinel_incident_alerts" ||
              step?.tool === "sentinel_defense" ||
              step?.tool === "sentinel_path" ||
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
              const text = step.tool === "sentinel_incident_alerts"
                ? queryIncidentAlerts(readOptions, args)
                : step.tool === "sentinel_defense"
                ? await readDefenseCoverage(readOptions, args)
                : await readSentinelInventoryProjection(
                  path,
                  ref.revision,
                  step.tool,
                  args,
                );
              if (
                text.startsWith("Error:") ||
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
              return safeProjection({
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
              return safeProjection({
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
              const retained = reopenSentinelGoalReceiptRead(
                path,
                {
                  caseId: ref.id,
                  runId,
                  taskId: task.id,
                  evidenceRevision: ref.revision,
                  targetId: task.nodeId,
                },
                step.tool,
                call,
              );
              if (
                !retained ||
                createHash("sha256").update(retained.result).digest("hex") !==
                  page.sha256 ||
                !await authorize(scope, step.tool, call, retained.result)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return safeProjection({
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
              return safeProjection({ run: ref, runId, taskId, index, result });
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
              return safeProjection({
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
              return safeProjection({ run: ref, runId, taskId, index, result });
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
              const result = JSON.stringify(observation);
              if (
                createHash("sha256").update(result).digest("hex") !== digest ||
                !await authorize(scope, step.tool, call, result)
              ) return unavailable;
              const current = readHistoricalAdaptiveSentinel(
                path,
                ref.revision,
              );
              if (
                current?.goal.id !== runId ||
                !isDeepStrictEqual(savedStep(current), step)
              ) return unavailable;
              return safeProjection({
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
              return safeProjection({
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
              const entry = readHistoricalDiscoveryEvidence(
                options.baseDir,
                path,
                citation.id,
                citation.version,
              );
              const record = entry && verifiedSharedAssetDiscovery(
                ref.id,
                new Map([[citation.id, entry.record]]),
                step,
              );
              const destination = readSentinelAssessmentRevision(
                path,
                ref.revision,
              )
                ?.result.sharedGraph.snapshot;
              const match = record && destination &&
                matchSentinelAssetDiscoveryDestination(
                  loadSentinelGraph(entry.snapshot),
                  loadSentinelGraph(destination),
                  record.claim,
                );
              if (
                !record || !match || match.assetId !== task.nodeId
              ) return unavailable;
              // Keep the worker response's original record field order for the digest check.
              const retained = {
                discovery: {
                  sourceCaseId: record.sourceCaseId,
                  taskId: record.taskId,
                  evidenceRevision: record.evidenceRevision,
                  sourceDigest: record.sourceDigest,
                  claim: record.claim,
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
              return safeProjection({
                run: ref,
                runId,
                taskId,
                index,
                result: retained,
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
              return safeProjection({
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
              return safeProjection({
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
              return safeProjection({
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
              return safeProjection({
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
              return safeProjection({
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
              const receipt = targetId &&
                readSentinelWorkerFindingTraceReceipt(path, {
                  caseId: ref.id,
                  runId,
                  evidenceRevision: ref.revision,
                  taskId: task.id,
                  targetId,
                }, receiptId);
              const kind = step.tool === "sentinel_report_finding"
                ? "finding"
                : step.tool === "sentinel_record_finding_recheck"
                ? "recheck"
                : "report_amendment";
              if (!receipt || receipt.kind !== kind) return unavailable;
              const retained = receipt.kind === "report_amendment"
                ? { _classification: "INTERNAL", amendment: receipt }
                : { _classification: "INTERNAL", record: receipt };
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
              return safeProjection({
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
              return safeProjection({
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
              return safeProjection({
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
                  : item.trafficLinks;
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
              const call = receipt ??
                (search && sentinelTrafficSearchArgs(search.args)) ?? linkArgs;
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
              if (linkArgs && links) {
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
                  });
                  if (!saved) return unavailable;
                  records.push(saved);
                }
                text = JSON.stringify({
                  _classification: "INTERNAL",
                  caseId: ref.id,
                  evidenceRevision: ref.revision,
                  links: records,
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
              return safeProjection({
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
              return safeProjection({
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
            return safeProjection({
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
          limit = 5,
          offset = 0,
          sourceCase,
          snapshotDigest,
          assetId,
        } = args;
        const exact = plannerIdentity !== undefined;
        const sourceRequested = sourceCase !== undefined ||
          snapshotDigest !== undefined || assetId !== undefined;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (sourceRequested && (!exact || typeof sourceCase !== "string" ||
            !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
            (assetId !== undefined && (typeof assetId !== "string" ||
              !assetId.trim() || assetId.length > 4096)))) ||
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
                ? ["plannerIdentity", "attempt", "ordinal"]
                : ["limit", "offset"]),
              ...(sourceRequested
                ? ["sourceCase", "snapshotDigest", "assetId"]
                : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const history = readHistoricalAdaptiveSentinel(path, ref.revision);
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
            read,
          };
          if (!sourceRequested) return safeProjection(selected);
          const source = await resolveCitedTraceSource(
            options.baseDir,
            path,
            read,
            args,
          );
          return source ? safeProjection({ ...selected, source }) : unavailable;
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
      if (action === "attach_finding_traffic") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
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
        );
      }
      if (action === "finding_traffic") {
        const { receiptId, trafficLinkId, limit, offset } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof receiptId !== "string" ||
          !/^worker-finding:[a-f0-9]{64}$/.test(receiptId) ||
          (trafficLinkId !== undefined &&
            (typeof trafficLinkId !== "string" ||
              !/^finding-traffic-link:[a-f0-9]{64}$/.test(trafficLinkId) ||
              limit !== undefined || offset !== undefined)) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "receiptId",
              "trafficLinkId",
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
            limit: 1,
          });
          if (link?.caseId !== ref.id) return unavailable;
          const receipt = readSentinelTrafficReceipt(
            snapshotPath,
            ref.revision,
            {
              evidenceId: link.trafficId,
              digest: link.trafficDigest,
            },
            link.assetId,
          );
          return receipt && receipt.family === link.trafficSource
            ? safeProjection({
              run: ref,
              link,
              receipt: projectSentinelTrafficReceipt(receipt, link.assetId),
            })
            : unavailable;
        }
        const response = executeSentinelFindingTrafficTool(
          { snapshotPath, assessmentRevision: ref.revision },
          sentinelFindingTrafficListTool.name,
          { revision: ref.revision, findingId: receiptId, limit, offset },
          new Set(),
        );
        return response.startsWith("Error:") ? response : safeProjection({
          run: ref,
          page: JSON.parse(response),
        });
      }
      if (
        action === "finding_receipt" || action === "finding_receipts" ||
        action === "finding_report"
      ) {
        const { receiptId, cursor, limit = 5, reportVersion } = args;
        const listing = action === "finding_receipts";
        const readingReport = action === "finding_report";
        const receiptPattern = /^worker-(?:finding|recheck):[a-f0-9]{64}$/;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          (listing
            ? typeof limit !== "number" || !Number.isSafeInteger(limit) ||
              limit < 1 || limit > 10 || (cursor !== undefined &&
                (typeof cursor !== "string" || !receiptPattern.test(cursor)))
            : typeof receiptId !== "string" ||
              !receiptPattern.test(receiptId)) ||
          reportVersion !== undefined &&
            (typeof reportVersion !== "number" ||
              !Number.isSafeInteger(reportVersion) || reportVersion < 1) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              ...(listing ? ["cursor", "limit"] : ["receiptId"]),
              ...(readingReport ? ["reportVersion"] : []),
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
            return selected
              ? safeProjection({
                run: ref,
                report: {
                  findingId: report.finding.id,
                  version,
                  latestVersion: report.version,
                  sourceReceiptId: selected.id,
                  evidenceRevision: selected.evidenceRevision,
                  taskId: selected.taskId,
                  title: selected.title,
                  summary: selected.summary,
                },
              })
              : unavailable;
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
          const source = await resolveCitedTraceSource(
            options.baseDir,
            path,
            step,
            args,
          );
          return source
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
          stepIndices.length !== 1 ||
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
        const response = searchSentinelWorkerTraces({
          snapshotPath: path,
          assessmentRevision: ref.revision,
        }, { revision: ref.revision, task: taskId, stepIndices });
        if (response.startsWith("Error:")) return unavailable;
        const [step] = JSON.parse(response).steps;
        if (!step) return unavailable;
        const source = await resolveCitedTraceSource(
          options.baseDir,
          path,
          step,
          args,
        );
        return source
          ? safeProjection({ run: ref, taskId, stepIndex: step.index, source })
          : unavailable;
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
        };
        const page = {
          revision: ref.revision,
          ...(args.offset !== undefined && { offset: args.offset }),
          ...(args.limit !== undefined && { limit: args.limit }),
        };
        const query = args.query !== undefined ? { query: args.query } : {};
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
        return response.startsWith("Error:")
          ? response
          : safeProjection({ run: ref, page: JSON.parse(response) });
      }
      if (action === "inspect") {
        const run = await controller.inspect(ref);
        return run
          ? safeProjection({ run, links: await controller.listLinks(run.ref) })
          : unavailable;
      }
      if (action === "confirm_goal_completion") {
        const { runId, goalProofDigest } = args;
        if (
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
        action === "revise_goals" || action === "goal_proposals" ||
        action === "approve_goal_proposal"
      ) {
        const read = action === "goals" || action === "goal_proposals";
        const proposalAction = action === "approve_goal_proposal";
        if (
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
                  proposalAction ? "proposalId" : "goals",
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
          } = plan ?? {};
          const describe = (
            { id, title, policy, criteria }: typeof formalGoals[number],
          ) => ({
            id,
            title,
            policy,
            criteriaCount: criteria.length,
            status: completedFormalGoalIds.includes(id)
              ? "completed"
              : activeFormalGoalIds.includes(id)
              ? "active"
              : "inactive",
          });
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
        const goals = normalizeSentinelFormalGoals(
          proposal ? [proposal.goal] : args.goals,
        );
        const approval = {
          mode: action === "append_goals" || proposalAction
            ? "append" as const
            : "revise" as const,
          requestId: requestId.toLowerCase(),
          goals,
          proposalDigest: digestSentinelGoalProposal(goals),
          ...(proposal && { sourceProposalId: proposal.id }),
          expectedRevision: ref.revision,
          expectedRunId: runId.toLowerCase(),
        };
        const prior = readSentinelFormalGoalApproval(path, approval);
        if (prior) return safeProjection({ run: ref, receipt: prior });
        const current = readSentinelAssessment(path);
        if (
          current?.revision !== ref.revision ||
          current.plan.runId !== approval.expectedRunId
        ) return unavailable;
        if (
          !await options.confirm(
            `Approve these exact Sentinel formal goal definitions?\n${
              JSON.stringify({ run: ref, ...approval })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const { state, ...receipt } = applySentinelFormalGoals(
          path,
          approval,
          options.webContainmentConfigured,
        );
        if (!receipt.duplicate) {
          ensureSentinelFormalGoalContract(path, state);
          advanceAdaptiveSentinel(path, state);
        }
        return safeProjection({ run: ref, receipt });
      }
      if (action === "cancel") {
        const { runId } = args;
        const sentinel = ref.kind === "sentinel";
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
        if (before.status === (sentinel ? "stopped" : "cancelled")) {
          return safeProjection({ run: before });
        }
        if (!["running", "paused", "interrupted"].includes(before.status)) {
          return unavailable;
        }
        if (
          !await options.confirm(
            `Cancel this exact operator run?\n${
              JSON.stringify({ ref, ...(sentinel && { runId: exactRunId }) })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const run = sentinel && exactRunId
          ? providers.sentinel.cancelExact(ref, exactRunId)
          : asWorkflowSummary(
            options.workflows?.cancel(ref.id, context?.ceiling ?? "INTERNAL"),
          );
        return run ? safeProjection({ run }) : unavailable;
      }
      if (action === "spawn") {
        const { targetKind, targetId, requestId } = args;
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
            ].includes(key)
          ) ||
          (targetKind === "workflow" &&
            !workflows?.listPlans(ceiling).some(({ id }) => id === targetId)) ||
          (targetKind === "sentinel" &&
            (targetId === "main" || !canFlowTo("INTERNAL", ceiling)))
        ) return unavailable;
        const parent = (await controller.inspect(ref))?.ref;
        if (!parent) return unavailable;
        const request = requestId.toLowerCase();
        const childRequest = createHash("sha256").update(
          JSON.stringify(["operator-spawn", linkScope, operatorId, request]),
        ).digest("hex");
        const target: OperatorRunRef = { kind: targetKind, id: targetId };
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
            if (
              link.origin !== "spawn" || link.requestId !== request ||
              other.id !== targetId || other.revision === undefined
            ) return unavailable;
            const child = await controller.inspect(other);
            return child ? safeProjection({ run: child, link }) : unavailable;
          }
          const child = workflows?.inspectRequest(childRequest, ceiling);
          if (child?.planId !== targetId || other.id !== child?.runId) {
            return unavailable;
          }
          return safeProjection({ run: asWorkflowSummary(child), link });
        };
        const prior = await readLinkedChild();
        if (prior !== undefined) return prior;
        const graphDigest = target.kind === "sentinel"
          ? providers.sentinel.publishedStartDigest(target)
          : undefined;
        if (
          target.kind === "sentinel" && (!graphDigest ||
            (parent.kind === "sentinel" && parent.id === target.id))
        ) return unavailable;
        if (
          !await options.confirm(
            `Start and link this published run?\n${
              JSON.stringify({
                parent,
                target,
                requestId: request,
                ...(graphDigest && { graphDigest }),
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        if (!await controller.inspect(parent)) return unavailable;
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
            providers.sentinel.startLinked(target, { ...link, graphDigest });
          } else {
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
        );
        const requestId = args.requestId;
        if (
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
      if (action === "hint") {
        if (
          ref.kind !== "sentinel" ||
          args.taskId !== undefined ||
          typeof args.note !== "string" || !args.note.trim() ||
          args.note.length > 1000 ||
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) return unavailable;
        control = {
          note: args.note.trim(),
          requestId: args.requestId.toLowerCase(),
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
      const run = await controller.mutate(action, ref, control);
      return run ? safeProjection({ run }) : unavailable;
    } catch {
      return unavailable;
    } finally {
      links.close();
    }
  };
}
