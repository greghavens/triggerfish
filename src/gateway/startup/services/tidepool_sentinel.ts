import { workerNarrativeSources } from "../../../sentinel/worker_narratives.ts";
import { dirname, join } from "@std/path";
import { isDeepStrictEqual } from "node:util";
import { readSentinelGraphFindingReviewScope } from "../../sentinel_finding_review_scope.ts";
import { notifyCommittedEvidence } from "../../../core/evidence_task_progression.ts";
import { readSentinelWorkerEvidenceScope } from "../../sentinel_worker_evidence_scope.ts";
import { scopedSentinelInventoryGraph } from "../../sentinel_agent.ts";
import { sentinelOperatingConstraintsAllow } from "../../../sentinel/operating_constraints.ts";
import type { ChatSession } from "../../chat_session_interface.ts";
/** Authenticated Tidepool operations for the gateway-owned Sentinel assessment. */
import {
  readScopedSentinelWorkerActivity,
  taskUpstreamCitations,
} from "../../../sentinel/adaptive_store.ts";
import {
  correctSentinelAssetDiscovery,
  decideSentinelAssetDiscovery,
  listSentinelAssetDiscoveryProposals,
} from "../../sentinel_asset_discoveries.ts";
import {
  matchesSentinelUpstreamCheck,
  sentinelTelemetryAssetResolver,
  sentinelUpstreamChecks,
} from "../../../sentinel/defense_coverage.ts";
import { sentinelOutputLanguages } from "../../../core/config_types.ts";
import { isSentinelReportLanguage } from "../../../sentinel/report_language.ts";
import {
  openSentinelContainment,
  readSentinelContainmentOverview,
} from "../../../sentinel/containment.ts";
import { sentinelContainmentPath } from "../../../sentinel/paths.ts";
import {
  completeSentinelRegisteredGoal,
  digestSentinelGoalProof,
  readSentinelGoalCompletionForState,
} from "../../sentinel_goal_completion.ts";
import { executeSentinelInventoryTool } from "../../sentinel_inventory_tool.ts";
import { exportSentinelFindingTrafficLinks } from "../../../sentinel/finding_traffic_links.ts";
import {
  readScopedSentinelWorkerFindingReport,
  readSentinelFindingReceiptScope,
} from "../../sentinel_worker_findings.ts";
import {
  hasSentinelWorkerFindingJournal,
  openSentinelWorkerFindingStore,
  readSentinelCaseFindingReceipts,
  readSentinelWorkerFindingHistory,
} from "../../../sentinel/worker_finding_store.ts";
import {
  applySentinelWorkerControlRequest,
  readSentinelWorkerControlStatus,
} from "../../sentinel_worker_control.ts";
import {
  continueSentinelAssessment,
  hasPendingSentinelInputs,
  hasSavedSentinelAlerts,
  pauseSentinelAssessment,
  readAssessmentReviewSnapshotCitations,
  readSentinelAssessment,
  readSentinelAssessmentAlerts,
  readSentinelAssessmentHistory,
  readSentinelAssessmentRevision,
  readSentinelAssessmentRevisionIndex,
  readSentinelAssetSnapshotCitations,
  readSentinelCaseStatus,
  readSentinelDecision,
  readSentinelDecisionHistory,
  readSentinelFindingReviews,
  readSentinelIncidentReviews,
  readSentinelLinkedSourcesForRevision,
  readSentinelNotificationReceipt,
  readSentinelNotificationState,
  readSentinelOperatingConstraints,
  readSentinelRunIdForRevision,
  recordSentinelFindingReview,
  recordSentinelIncidentReview,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  sentinelFindingDispositions,
  sentinelIncidentDispositions,
  setSentinelIncidentNotifications,
  startSentinelAssessment,
  stopSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../../../sentinel/assessment_store.ts";
import {
  parseFindingExportFilter,
  renderScopedSentinelFindings,
  renderScopedSentinelFindingsPage,
  renderSentinelAlertsJson,
  renderSentinelDecisionHistoryJson,
  renderSentinelFindingsCsv,
  renderSentinelInvestigationMarkdown,
  renderSentinelProvenanceJson,
} from "../../../sentinel/assessment_export.ts";
import {
  MAX_SNAPSHOT_BYTES,
  readSentinelChatSnapshot,
} from "../../../sentinel/chat_mode.ts";
import { MAX_EDGES, MAX_NODES } from "../../../sentinel/assessment.ts";
import { mergeSentinelSnapshots } from "../../../sentinel/merge.ts";
import { withSentinelSourceSnapshotLock } from "../../../sentinel/source_snapshot_lock.ts";
import {
  readSavedSentinelIncident,
  readSavedSentinelIncidentAssetScopes,
  readSavedSentinelIncidentCandidate,
  readSavedSentinelIncidentPage,
  readSavedSentinelPlanningEvidence,
  readSentinelIncidentReviewScope,
  renderSavedSentinelIncidentJson,
} from "../../../sentinel/incident_archive.ts";
import {
  assetIdentityIndex,
  loadSentinelGraph,
  scopeSentinelInventoryReferences,
} from "../../../sentinel/graph.ts";
import { publishSentinelInput } from "../../../sentinel/published_input.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../../sentinel/cases.ts";
import { readSentinelSourceAssetLineage } from "../../../sentinel/source_asset_lineage.ts";
import {
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
  readCitedSentinelAliasSnapshot,
  readPinnedSentinelSharedFindingSource,
  readSharedSentinelAssetCatalog,
  readSharedSentinelAssetLinks,
  readSharedSentinelAssets,
  readSharedSentinelFindingSource,
  type SharedSentinelAssetCatalogOptions,
} from "../../../sentinel/shared_inventory.ts";
import { readSentinelWorkerFindingPublications } from "../../../sentinel/worker_finding_publications.ts";
import {
  auditSentinelSourceSnapshots,
  moveSentinelSourceSnapshot,
} from "../../../sentinel/source_snapshot_audit.ts";
import {
  sentinelAlertKey,
  sentinelAlertReference,
  type TelemetryAlert,
} from "../../../sentinel/telemetry.ts";
import {
  buildSentinelProvenance,
  projectSentinelProvenance,
  sentinelAlertProvenanceId,
  sentinelIncidentProvenanceId,
} from "../../../sentinel/provenance.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  assignSentinelTask,
  controlSentinelTask,
  findSentinelTaskEvidence,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  readSentinelCaseHints,
  readSentinelInteractiveModelUsage,
  readSentinelModelSettings,
  readSentinelProvenance,
  readSentinelWorkerSnapshotCitations,
  retainedWorkerNarrativeId,
  SentinelAssignmentError,
  setSentinelOutputLanguage,
  setSentinelWorkerLimit,
} from "../../sentinel_adaptive_runtime.ts";
import {
  sentinelTopologyAutoEnabled,
  setSentinelTopologyAuto,
  syncSentinelTopology,
} from "../../sentinel_topology_sync.ts";
import type { SentinelCoordinatorLookup } from "../../sentinel_case_manager.ts";
import type { BootstrapResult } from "../bootstrap.ts";

function retainedTelemetryScope(path: string, revision: number) {
  const runId = readSentinelRunIdForRevision(path, revision);
  const policy = runId
    ? readSentinelOperatingConstraints(path, runId)?.constraints
    : undefined;
  if (
    policy?.allowedAssetIds === undefined &&
    !policy?.deniedKinds.includes("review_evidence")
  ) return;
  const snapshot = readSentinelAssessmentRevision(path, revision)?.result
    .sharedGraph.snapshot;
  const resolve = snapshot && sentinelTelemetryAssetResolver(snapshot, policy);
  let incidents: ReturnType<typeof readSavedSentinelIncidentAssetScopes>;
  const allowsNode = (nodeId: string) =>
    sentinelOperatingConstraintsAllow(
      policy,
      { kind: "review_evidence", nodeId },
      snapshot,
    );
  return {
    allowAlert: (alert: TelemetryAlert) => !!resolve?.(alert),
    allowFinding: allowsNode,
    allowIncident(id: string) {
      incidents ??= readSavedSentinelIncidentAssetScopes(path, revision) ??
        new Map<string, readonly string[]>();
      const assets = incidents.get(id);
      return !!assets?.length && assets.every(allowsNode);
    },
  };
}

/** Reuse the same saved/current subject scope for a page and its origin rows. */
function projectTidepoolSourceSnapshot(
  recipientPath: string,
  sourcePath: string,
  assetId: string,
  graph: ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>,
  findingId?: string,
) {
  const recipient = sourcePath !== recipientPath &&
    readSentinelAssessment(recipientPath);
  if (recipient && retainedTelemetryScope(recipientPath, recipient.revision)) {
    throw new SentinelAssignmentError(
      "The source snapshot is unavailable in this case scope.",
    );
  }
  const source = readSentinelAssessment(sourcePath);
  const scope = source && retainedTelemetryScope(sourcePath, source.revision);
  if (!source || !scope) return { graph, scopeRestricted: false };
  const currentNodes = source.result?.sharedGraph.snapshot?.nodes;
  const currentFinding = findingId === undefined
    ? undefined
    : currentNodes?.find(({ id }) => id === findingId);
  if (
    !currentNodes?.some(({ id, kind }) => id === assetId && kind === "asset") ||
    !scope.allowFinding(assetId) ||
    (currentFinding && (currentFinding.kind !== "finding" ||
      !scope.allowFinding(currentFinding.id)))
  ) {
    throw new SentinelAssignmentError(
      "The requested evidence is unavailable in the source snapshot.",
    );
  }
  const visible = scopedSentinelInventoryGraph(
    sourcePath,
    source.revision,
    loadSentinelGraph(graph),
  ).snapshot();
  if (
    findingId !== undefined &&
    !visible.edges.some(({ from, to, relation }) =>
      relation === "affects" && from === findingId && to === assetId
    )
  ) {
    throw new SentinelAssignmentError(
      "The requested evidence is unavailable in the source snapshot.",
    );
  }
  return { graph: visible, scopeRestricted: true };
}

async function projectScopedTidepoolPeerFinding(
  baseDir: string,
  recipientPath: string,
  recipientCase: string,
  sourcePath: string,
  reference: Parameters<typeof readSharedSentinelFindingSource>[1],
) {
  const { caseId, assetId, findingId } = reference;
  const recipient = readSentinelAssessment(recipientPath);
  const local = recipient?.result?.sharedGraph.snapshot;
  if (!recipient || !local) return;
  const selected = readSentinelLinkedSourcesForRevision(
    recipientPath,
    recipient.revision,
  )?.find((source) => source.caseId === caseId);
  if (
    !selected || !retainedTelemetryScope(recipientPath, recipient.revision)
      ?.allowFinding(assetId)
  ) return;
  const archived = await readPinnedSentinelSharedFindingSource(
    baseDir,
    local,
    { ...reference, localAssetId: assetId },
    recipientCase,
    recipientPath,
  );
  if (!archived) return;
  const ownsIdentity = (snapshot: typeof archived) =>
    assetIdentityIndex(snapshot.nodes.filter(({ kind }) => kind === "asset"))
      .get(assetId) === assetId;
  const latest = readSentinelAssessment(recipientPath);
  if (
    latest?.revision !== recipient.revision ||
    latest.plan.runId !== recipient.plan.runId ||
    !retainedTelemetryScope(recipientPath, recipient.revision)
      ?.allowFinding(assetId) ||
    !ownsIdentity(local) || !ownsIdentity(archived) ||
    archived.edges.some(({ from, to, relation }) =>
      from === findingId && relation === "affects" && to !== assetId
    ) ||
    readSentinelRunIdForRevision(sourcePath, selected.revision) !==
      selected.runId ||
    retainedTelemetryScope(sourcePath, selected.revision)
        ?.allowFinding(assetId) === false
  ) return;
  const published = readSentinelWorkerFindingPublications(sourcePath, caseId)
    .find(({ finding, targetId }) =>
      finding.id === findingId && targetId === assetId &&
      finding.workerFindingSource?.revision === selected.revision &&
      finding.workerFindingSource.runId === selected.runId
    );
  if (!published) return;
  const { graph } = projectTidepoolSourceSnapshot(
    sourcePath,
    sourcePath,
    assetId,
    archived,
    findingId,
  );
  const nodes = graph.nodes.filter(({ id }) =>
    id === findingId || id === assetId
  );
  if (
    nodes.length !== 2 ||
    !nodes.some((node) => isDeepStrictEqual(node, published.finding))
  ) return;
  const edges = graph.edges.filter(({ from, to, relation }) =>
    from === findingId && to === assetId && relation === "affects"
  );
  if (edges.length !== 1) return;
  return {
    graph: {
      version: graph.version,
      nodes: nodes.map((node) =>
        scopeSentinelInventoryReferences(
          node,
          (id) => id === findingId || id === assetId,
          caseId,
        )
      ),
      edges,
    },
    scopeRestricted: true,
  };
}

function tidepoolDecisionScope(path: string) {
  const scopes = new Map<
    number,
    ReturnType<typeof readSentinelFindingReceiptScope>
  >();
  const incidentAssets = new Map<
    number,
    ReturnType<typeof readSavedSentinelIncidentAssetScopes>
  >();
  return (kind: "finding" | "incident", subject: string, revision: number) => {
    if (kind === "finding") {
      return !!readSentinelGraphFindingReviewScope(path, revision, subject);
    }
    if (!scopes.has(revision)) {
      scopes.set(revision, readSentinelFindingReceiptScope(path, revision));
    }
    const scope = scopes.get(revision);
    if (!scope) return false;
    if (!incidentAssets.has(revision)) {
      incidentAssets.set(
        revision,
        readSavedSentinelIncidentAssetScopes(path, revision),
      );
    }
    const assets = incidentAssets.get(revision)?.get(subject);
    return !!assets?.length &&
      assets.every((asset) =>
        scope.allows(asset) && scope.allows(asset, "review_incident")
      );
  };
}

/** Aggregate notification receipts have no subject binding for a partial view. */
function canReadTidepoolNotificationReceipt(path: string, revision: number) {
  const runId = readSentinelRunIdForRevision(path, revision);
  if (!runId) return false;
  return ![
    readSentinelOperatingConstraints(path, runId, revision),
    readSentinelOperatingConstraints(path, runId),
  ].some((policy) =>
    policy && (
      policy.constraints.allowedAssetIds !== undefined ||
      policy.constraints.deniedKinds.includes("review_evidence") ||
      policy.constraints.deniedKinds.includes("review_incident")
    )
  );
}

function scopedRetainedAssessment(
  path: string,
  saved: NonNullable<ReturnType<typeof readSentinelAssessmentRevision>>,
) {
  const { revision, updatedAt, result } = saved;
  const original = result.sharedGraph.snapshot;
  const snapshot = original
    ? scopedSentinelInventoryGraph(path, revision, loadSentinelGraph(original))
      .snapshot()
    : null;
  return {
    revision,
    updatedAt,
    reviews: [],
    result: {
      version: result.version,
      revision: result.revision,
      previousRevision: result.previousRevision,
      summary: { completed: 0, waiting: 0, skipped: 0 },
      tasks: [],
      transitions: [],
      sharedGraph: { snapshot, observations: [], observationLinks: [] },
    },
  };
}

function scopedWorkerHistory(path: string, revision: number, before?: number) {
  const scope = readSentinelWorkerEvidenceScope(path, revision);
  return scope
    ? readScopedSentinelWorkerActivity(
      join(dirname(path), "sentinel-adaptive.db"),
      revision,
      scope.runId,
      scope.allowedTaskIds,
      before,
    )
    : { history: [], historyCursor: null };
}

export function createTidepoolSentinelHandler(
  bootstrap: BootstrapResult,
  coordinatorState?: SentinelCoordinatorLookup,
  readDiscoverySource?: ChatSession["readSentinelDiscoverySource"],
  readTrafficDownloadPage?: ChatSession["readSentinelTrafficDownloadPage"],
  readWorkerNarrative?: ChatSession["readSentinelWorkerNarrative"],
) {
  function readCaseOverview(ids: readonly string[], checkPending = false) {
    return ["main", ...ids].map((id) => {
      try {
        const path = resolveSentinelCasePath(bootstrap.baseDir, id);
        const status = readSentinelCaseStatus(path);
        return {
          id,
          ...(status ?? { status: "not_started" }),
          ...(checkPending && status?.status === "paused" && {
            pendingInputs: hasPendingSentinelInputs(path, webContainment),
          }),
          ...(status?.status === "running" && id !== "main" &&
            coordinatorState && {
            coordinator: coordinatorState(id) ?? "pending",
          }),
        };
      } catch {
        return { id, status: "unavailable" };
      }
    });
  }

  const webContainment =
    bootstrap.config.web?.domains?.sentinel_containment === true;
  return async (
    message: Record<string, unknown>,
    socket: WebSocket,
  ): Promise<void> => {
    const requestId = typeof message.requestId === "number" &&
        Number.isSafeInteger(message.requestId)
      ? message.requestId
      : undefined;
    const send = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ requestId, ...event }));
      }
    };
    try {
      const caseId = message.caseId ?? "main";
      if (typeof caseId !== "string") {
        throw new Error("Invalid Sentinel case ID");
      }
      const path = resolveSentinelCasePath(bootstrap.baseDir, caseId);
      switch (message.type) {
        case "worker_recheck_lineage": {
          const { revision, taskId } = message;
          const unavailable = () =>
            new SentinelAssignmentError(
              "The recheck assignment is unavailable in this evidence revision.",
            );
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof taskId !== "string" ||
            !/^adaptive:[a-f0-9]{64}$/.test(taskId)
          ) throw unavailable();
          const scope = readSentinelFindingReceiptScope(path, revision);
          const runId = scope?.runId;
          const adaptive = runId &&
            readHistoricalAdaptiveSentinel(path, revision);
          const task = adaptive && adaptive.goal.id === runId
            ? adaptive.tasks.find(({ id }) => id === taskId)
            : undefined;
          const findingId = task?.plannerRound?.recheckFindingId;
          if (
            !task?.nodeId || !findingId || !scope?.allows(task.nodeId) ||
            !hasSentinelWorkerFindingJournal(path)
          ) throw unavailable();
          const store = openSentinelWorkerFindingStore(path);
          try {
            const finding = store.readFinding(findingId);
            if (
              !finding || finding.caseId !== caseId ||
              finding.runId !== runId ||
              finding.evidenceRevision > revision ||
              !scope.allows(finding.targetId)
            ) throw unavailable();
            const rechecks = store.list(revision).filter((record) =>
              record.kind === "recheck" && record.caseId === caseId &&
              record.runId === runId && record.taskId === taskId &&
              record.findingId === finding.id &&
              record.evidenceId === task.nodeId &&
              record.targetId === finding.targetId &&
              record.controlId === finding.controlId &&
              record.graphFindingId === finding.graphFindingId
            );
            send({
              topic: "sentinel",
              type: "sentinel_worker_recheck_lineage",
              caseId,
              evidenceRevision: revision,
              taskId,
              evidenceId: task.nodeId,
              finding,
              rechecks: rechecks.slice(0, 10),
            });
          } finally {
            store.close();
          }
          return;
        }
        case "worker_findings": {
          const { revision, offset = 0 } = message;
          if (
            revision !== undefined && (typeof revision !== "number" ||
                !Number.isSafeInteger(revision) || revision < 1) ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0
          ) {
            throw new SentinelAssignmentError(
              "Use a valid finding evidence revision and page.",
            );
          }
          const scopes = new Map<
            number,
            ReturnType<typeof readSentinelFindingReceiptScope>
          >();
          const results = readSentinelWorkerFindingHistory(path, revision)
            .filter((record) => {
              if (
                record.caseId !== caseId ||
                (record.kind === "recheck" && record.nativeRepositoryVisibility)
              ) return false;
              const exactRevision = revision ?? record.evidenceRevision;
              if (!scopes.has(exactRevision)) {
                scopes.set(
                  exactRevision,
                  readSentinelFindingReceiptScope(path, exactRevision),
                );
              }
              const scope = scopes.get(exactRevision);
              return scope?.runId === record.runId &&
                scope.allowsRecord(record);
            });
          const records = results.slice(offset, offset + 10);
          send({
            topic: "sentinel",
            type: "sentinel_worker_findings",
            caseId,
            evidenceRevision: revision ?? null,
            records,
            nextOffset: offset + records.length < results.length
              ? offset + records.length
              : null,
          });
          return;
        }
        case "case_inventory_query": {
          const { filters, revision } = message;
          if (
            !filters || typeof filters !== "object" ||
            Array.isArray(filters) ||
            revision !== undefined &&
              (typeof revision !== "number" || !Number.isSafeInteger(revision))
          ) {
            throw new SentinelAssignmentError(
              "Supply a valid case inventory query.",
            );
          }
          const result = await executeSentinelInventoryTool(
            { snapshotPath: path, assessmentRevision: revision },
            filters as Record<string, unknown>,
          );
          if (result.startsWith("Error: ")) {
            throw new SentinelAssignmentError(result.slice(7));
          }
          send({
            topic: "sentinel",
            type: "sentinel_case_inventory",
            caseId,
            inventory: JSON.parse(result),
          });
          return;
        }
        case "shared_inventory_catalog": {
          const filters = message.filters ?? {};
          if (
            !filters || typeof filters !== "object" || Array.isArray(filters)
          ) {
            throw new SentinelAssignmentError(
              "Supply valid shared inventory filters.",
            );
          }
          const inventory = await readSharedSentinelAssetCatalog(
            bootstrap.baseDir,
            filters as SharedSentinelAssetCatalogOptions,
          );
          send({
            topic: "sentinel",
            type: "sentinel_shared_inventory_catalog",
            caseId,
            inventory,
          });
          return;
        }
        case "worker_status":
          send({
            topic: "sentinel",
            type: "sentinel_worker_status",
            caseId,
            ...readSentinelWorkerControlStatus(path),
          });
          return;
        case "worker_steer":
        case "worker_stop":
          send({
            topic: "sentinel",
            type: "sentinel_worker_control",
            caseId,
            receipt: applySentinelWorkerControlRequest(
              path,
              message.type === "worker_steer" ? "steer" : "stop",
              message,
            ),
          });
          return;
        case "containment_block":
        case "containment_release":
        case "containment_overview": {
          const policyPath = sentinelContainmentPath(bootstrap.baseDir);
          if (message.type !== "containment_overview") {
            if (!webContainment) {
              throw new SentinelAssignmentError("Web containment is disabled.");
            }
            const { target, reason, ttlSeconds, expectedRevision } = message;
            if (
              typeof target !== "string" || typeof reason !== "string" ||
              (message.type === "containment_block" &&
                typeof ttlSeconds !== "number") ||
              (message.type === "containment_release" &&
                typeof expectedRevision !== "string")
            ) {
              throw new SentinelAssignmentError(
                "Enter a valid quarantine target, reason, and duration.",
              );
            }
            let store;
            try {
              store = openSentinelContainment(policyPath, Date.now, false);
            } catch {
              throw new SentinelAssignmentError(
                "The web containment policy is unavailable.",
              );
            }
            try {
              if (
                message.type === "containment_block" &&
                typeof ttlSeconds === "number"
              ) {
                store.block({ target, reason, ttlSeconds });
              } else if (
                typeof expectedRevision === "string" &&
                !store.release({ target, reason, expectedRevision }).released
              ) {
                throw new SentinelAssignmentError(
                  "The quarantine changed. Reopen web containment before retrying.",
                );
              }
            } catch (error) {
              if (error instanceof SentinelAssignmentError) throw error;
              throw new SentinelAssignmentError(
                "The containment change could not be saved. Check the target, reason, and duration.",
              );
            } finally {
              store.close();
            }
          }
          let policy;
          try {
            if (webContainment) {
              policy = readSentinelContainmentOverview(policyPath);
            }
          } catch {
            throw new SentinelAssignmentError(
              "The web containment policy is unavailable.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_containment_overview",
            caseId,
            policy: policy ?? null,
          });
          return;
        }
        case "start": {
          const { goal, inventoryCoverageEnabled } = message;
          if (
            inventoryCoverageEnabled !== undefined &&
            typeof inventoryCoverageEnabled !== "boolean"
          ) {
            throw new Error(
              "Choose whether optional inventory coverage is enabled.",
            );
          }
          if (goal !== undefined && typeof goal !== "string") {
            throw new Error("Enter a defensive assessment goal.");
          }
          const state = startSentinelAssessment(path, {
            goal: goal?.trim() || undefined,
            inventoryCoverageEnabled,
          }, webContainment);
          advanceAdaptiveSentinel(path, state);
          break;
        }
        case "assign":
          assignSentinelTask(
            path,
            message.revision,
            message.kind,
            message.nodeId,
          );
          break;
        case "apply_task_dependencies":
        case "dismiss_task_dependencies":
          controlSentinelTask(
            path,
            message.revision,
            message.taskId,
            message.type === "apply_task_dependencies"
              ? "apply_dependencies"
              : "dismiss_dependencies",
            message.proposalId,
          );
          break;
        case "retry_model_review":
          if (bootstrap.config.sentinel?.allow_model_access !== true) {
            throw new SentinelAssignmentError(
              "This investigation is no longer eligible for that action.",
            );
          }
          controlSentinelTask(
            path,
            message.revision,
            message.taskId,
            "retry_model_review",
          );
          break;
        case "retry_task":
        case "prioritize_task":
        case "withdraw_task_priority":
        case "cancel_task":
          controlSentinelTask(
            path,
            message.revision,
            message.taskId,
            message.type === "retry_task"
              ? "retry"
              : message.type === "prioritize_task"
              ? "prioritize"
              : message.type === "withdraw_task_priority"
              ? "withdraw_priority"
              : "cancel",
          );
          break;
        case "pause":
          pauseSentinelAssessment(path);
          break;
        case "resume": {
          const state = resumeSentinelAssessment(path, webContainment);
          if (state) advanceAdaptiveSentinel(path, state);
          break;
        }
        case "set_goal":
          if (typeof message.goal !== "string") {
            throw new Error("Enter an assessment goal");
          }
          updateSentinelAssessmentGoal(path, message.goal);
          break;
        case "add_case_hint": {
          const hint = typeof message.hint === "string"
            ? message.hint.trim()
            : "";
          if (!hint || hint.length > 1000 || hint.includes("\x00")) {
            throw new SentinelAssignmentError(
              "Enter a case hint of up to 1,000 characters.",
            );
          }
          addSentinelCaseHint(path, hint);
          break;
        }
        case "model_output_language": {
          const language = message.language === null
            ? null
            : sentinelOutputLanguages.find((id) => id === message.language);
          if (
            bootstrap.config.sentinel?.allow_model_access !== true ||
            language === undefined
          ) {
            throw new SentinelAssignmentError(
              "Select a supported model output language or use the gateway default.",
            );
          }
          setSentinelOutputLanguage(path, language);
          break;
        }
        case "incident_notifications": {
          const { enabled } = message;
          if (
            bootstrap.config.sentinel?.notify_incident_increases !== true ||
            (enabled !== null && typeof enabled !== "boolean")
          ) {
            throw new SentinelAssignmentError(
              "Incident notifications are unavailable for this case.",
            );
          }
          setSentinelIncidentNotifications(path, enabled);
          break;
        }
        case "worker_limit": {
          const limit = message.limit;
          const globalLimit = bootstrap.config.sentinel?.model_worker_limit ??
            2;
          if (
            bootstrap.config.sentinel?.allow_model_access !== true ||
            (limit !== null && (typeof limit !== "number" ||
              !Number.isSafeInteger(limit) || limit < 1 || limit > globalLimit))
          ) {
            throw new SentinelAssignmentError(
              "Choose a worker limit between 1 and the gateway limit, or use the gateway default.",
            );
          }
          setSentinelWorkerLimit(path, limit);
          break;
        }
        case "complete_goal": {
          const { revision, expectedGoal, note, runId, goalProofDigest } =
            message;
          const suppliedProof = runId !== undefined ||
            goalProofDigest !== undefined;
          if (
            typeof revision !== "number" ||
            (expectedGoal !== null && typeof expectedGoal !== "string") ||
            typeof note !== "string" ||
            (suppliedProof && (
              typeof runId !== "string" ||
              typeof goalProofDigest !== "string" ||
              !/^[a-f0-9]{64}$/.test(goalProofDigest)
            )) ||
            !completeSentinelRegisteredGoal(
              path,
              revision,
              expectedGoal,
              note,
              webContainment,
              suppliedProof
                ? { runId: runId as string, digest: goalProofDigest as string }
                : null,
            )
          ) {
            throw new SentinelAssignmentError(
              "Goal completion could not be saved. Refresh the case and verify the current goal and evidence.",
            );
          }
          break;
        }
        case "stop":
          stopSentinelAssessment(path);
          break;
        case "refresh": {
          const state = refreshSentinelAssessment(path, webContainment);
          if (state) advanceAdaptiveSentinel(path, state);
          break;
        }
        case "preview_import":
        case "import": {
          if (
            typeof message.content !== "string" ||
            message.content.length > MAX_SNAPSHOT_BYTES ||
            new TextEncoder().encode(message.content).length >
              MAX_SNAPSHOT_BYTES
          ) {
            throw new Error("Sentinel import must be a JSON file up to 1 MiB");
          }
          const raw: unknown = JSON.parse(message.content);
          const source = message.source;
          let snapshot: unknown;
          if (message.format === "graph") snapshot = raw;
          else {
            if (typeof source !== "string" || !source.trim()) {
              throw new Error("Missing source ID");
            }
            if (message.format === "sarif") {
              const { importSentinelSarif } = await import(
                "../../../sentinel/sarif.ts"
              );
              snapshot = await importSentinelSarif(raw, source);
            } else if (message.format === "cyclonedx") {
              const { importSentinelCycloneDx } = await import(
                "../../../sentinel/cyclonedx.ts"
              );
              snapshot = importSentinelCycloneDx(raw, source);
            } else if (message.format === "osv") {
              const { importSentinelOsvScanner } = await import(
                "../../../sentinel/osv_scanner.ts"
              );
              snapshot = importSentinelOsvScanner(raw, source);
            } else if (message.format === "spdx") {
              const { importSentinelSpdx } = await import(
                "../../../sentinel/spdx.ts"
              );
              snapshot = importSentinelSpdx(raw, source);
            } else if (message.format === "har") {
              const { importSentinelHar } = await import(
                "../../../sentinel/har.ts"
              );
              snapshot = importSentinelHar(raw, source).snapshot;
            } else return;
          }
          const mode = message.mode ?? "replace";
          if (mode !== "merge" && mode !== "replace") {
            throw new SentinelAssignmentError(
              "Choose how to import the inventory.",
            );
          }
          const incoming = loadSentinelGraph(snapshot).snapshot();
          const previewOnly = message.type === "preview_import";
          const reviewed = message.inventoryDigest !== undefined;
          const preview = await withSentinelSourceSnapshotLock(
            bootstrap.baseDir,
            !previewOnly,
            async () => {
              const existing = mode === "merge" || previewOnly || reviewed
                ? await readSentinelChatSnapshot(path).catch((error) => {
                  if (error instanceof Deno.errors.NotFound) return undefined;
                  throw error;
                })
                : undefined;
              const current = existing === undefined
                ? undefined
                : loadSentinelGraph(existing).snapshot();
              const inventoryDigest = current
                ? digestSentinelSnapshot(current)
                : null;
              if (reviewed && inventoryDigest !== message.inventoryDigest) {
                throw new SentinelAssignmentError(
                  "The inventory changed after the preview. Preview it again before importing.",
                );
              }
              let inventory = incoming;
              if (mode === "merge" && current) {
                try {
                  inventory = mergeSentinelSnapshots([current, incoming]);
                } catch {
                  throw new SentinelAssignmentError(
                    "The import conflicts with the current inventory.",
                  );
                }
              }
              if (
                (mode === "merge" || previewOnly || reviewed) &&
                (inventory.nodes.length > MAX_NODES ||
                  inventory.edges.length > MAX_EDGES)
              ) {
                throw new SentinelAssignmentError(
                  "The imported inventory exceeds the Sentinel graph limits.",
                );
              }
              if (previewOnly) {
                if (
                  new TextEncoder().encode(JSON.stringify(inventory)).length >
                    MAX_SNAPSHOT_BYTES
                ) {
                  throw new SentinelAssignmentError(
                    "The imported inventory exceeds the Sentinel file limit.",
                  );
                }
                const currentNodes = new Map(
                  current?.nodes.map((node) => [node.id, node]),
                );
                const resultingIds = new Set(
                  inventory.nodes.map(({ id }) => id),
                );
                const edgeKey = (
                  { from, to, relation }: typeof inventory.edges[number],
                ) => JSON.stringify([from, relation, to]);
                const currentEdges = new Set(current?.edges.map(edgeKey));
                const resultingEdges = new Set(inventory.edges.map(edgeKey));
                const added = inventory.nodes.filter(({ id }) =>
                  !currentNodes.has(id)
                );
                const removed = (current?.nodes ?? []).filter(({ id }) =>
                  !resultingIds.has(id)
                );
                const changed = inventory.nodes.flatMap((node) => {
                  const before = currentNodes.get(node.id);
                  return before &&
                      JSON.stringify(before) !== JSON.stringify(node)
                    ? [{ before, node }]
                    : [];
                });
                const linksAdded = inventory.edges.filter((edge) =>
                  !currentEdges.has(edgeKey(edge))
                );
                const linksRemoved = (current?.edges ?? []).filter((edge) =>
                  !resultingEdges.has(edgeKey(edge))
                );
                const limit = 20;
                const describe = (node: typeof inventory.nodes[number]) => ({
                  id: node.id.slice(0, 160),
                  label: node.label.slice(0, 160),
                  kind: node.kind,
                  ...(node.kind === "finding" && { severity: node.severity }),
                });
                const describeEdge = (
                  { from, to, relation }: typeof inventory.edges[number],
                ) => ({
                  from: from.slice(0, 160),
                  to: to.slice(0, 160),
                  relation,
                });
                return {
                  inventoryDigest,
                  currentNodes: current?.nodes.length ?? 0,
                  currentEdges: current?.edges.length ?? 0,
                  resultingNodes: inventory.nodes.length,
                  resultingEdges: inventory.edges.length,
                  changedNodes: changed.length,
                  addedEdges: linksAdded.length,
                  removedEdges: linksRemoved.length,
                  addedNodes: added.length,
                  removedNodes: removed.length,
                  records: {
                    added: added.slice(0, limit).map(describe),
                    removed: removed.slice(0, limit).map(describe),
                    changed: changed.slice(0, limit).map((
                      { before, node },
                    ) => ({
                      before: describe(before),
                      after: describe(node),
                      fields: [
                        ...new Set([
                          ...Object.keys(before),
                          ...Object.keys(node),
                        ]),
                      ]
                        .filter((key) =>
                          JSON.stringify(before[key as keyof typeof before]) !==
                            JSON.stringify(node[key as keyof typeof node])
                        ),
                    })),
                  },
                  relationships: {
                    added: linksAdded.slice(0, limit).map(describeEdge),
                    removed: linksRemoved.slice(0, limit).map(describeEdge),
                  },
                };
              }
              await publishSentinelInput(path, inventory);
            },
          );
          if (previewOnly) {
            send({
              topic: "sentinel",
              type: "sentinel_import_preview",
              caseId,
              preview,
            });
            return;
          }
          const state = refreshSentinelAssessment(path, webContainment);
          if (state) advanceAdaptiveSentinel(path, state);
          break;
        }
        case "history":
          send({
            topic: "sentinel",
            type: "sentinel_history",
            caseId,
            revisions: readSentinelAssessmentHistory(path),
          });
          return;
        case "review_finding": {
          const { revision, findingId, disposition, note } = message;
          const decision = sentinelFindingDispositions.find((value) =>
            value === disposition
          );
          const scope = () =>
            typeof revision === "number" &&
              typeof findingId === "string"
              ? readSentinelGraphFindingReviewScope(path, revision, findingId)
              : undefined;
          const admitted = scope();
          if (
            typeof revision !== "number" || typeof findingId !== "string" ||
            typeof note !== "string" || !decision || !admitted ||
            !recordSentinelFindingReview(
              path,
              revision,
              findingId,
              decision,
              note,
              undefined,
              () => isDeepStrictEqual(scope(), admitted),
            )
          ) {
            throw new SentinelAssignmentError(
              "Choose a finding in the current revision and enter a review note.",
            );
          }
          const state = readSentinelAssessment(path);
          if (state) advanceAdaptiveSentinel(path, state);
          const review = readSentinelFindingReviews(path, revision).find(
            (record) => record.findingId === findingId,
          );
          if (review && isDeepStrictEqual(scope(), admitted)) {
            notifyCommittedEvidence({
              case: caseId,
              run_id: admitted.runId,
              revision,
              observation_id: `finding-review:${review.id}`,
            });
          }
          break;
        }
        case "review_incident": {
          const { revision, incidentId, disposition, note } = message;
          const decision = sentinelIncidentDispositions.find((value) =>
            value === disposition
          );
          const scope = () =>
            typeof revision === "number" &&
              typeof incidentId === "string"
              ? readSentinelIncidentReviewScope(path, revision, incidentId)
              : undefined;
          const admitted = scope();
          if (
            typeof revision !== "number" || typeof incidentId !== "string" ||
            typeof note !== "string" || !decision || !admitted ||
            !recordSentinelIncidentReview(
              path,
              revision,
              incidentId,
              decision,
              note,
              undefined,
              () => isDeepStrictEqual(scope(), admitted),
            )
          ) {
            throw new SentinelAssignmentError(
              "Choose an incident in the current revision and enter a review note.",
            );
          }
          const state = readSentinelAssessment(path);
          if (state) advanceAdaptiveSentinel(path, state);
          const review = readSentinelIncidentReviews(path, revision).find(
            (record) => record.incidentId === incidentId,
          );
          if (review && isDeepStrictEqual(scope(), admitted)) {
            notifyCommittedEvidence({
              case: caseId,
              run_id: admitted.runId,
              revision,
              observation_id: `incident-review:${review.id}`,
            });
          }
          break;
        }
        case "hint_detail": {
          const { hintId } = message;
          if (
            typeof hintId !== "number" || !Number.isSafeInteger(hintId) ||
            hintId < 1 || hintId === Number.MAX_SAFE_INTEGER
          ) {
            throw new SentinelAssignmentError(
              "Select a saved Sentinel case hint.",
            );
          }
          const [hint] = readSentinelCaseHints(path, 1, hintId + 1);
          if (hint?.id !== hintId) {
            throw new SentinelAssignmentError(
              "That Sentinel case hint is unavailable.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_hint_detail",
            caseId,
            hint: {
              ...hint,
              retained: hint.revision !== null &&
                !!readSentinelAssessmentRevision(path, hint.revision),
            },
          });
          return;
        }
        case "decision_detail": {
          const { kind, decisionId } = message;
          if (
            (kind !== "finding" && kind !== "incident") ||
            typeof decisionId !== "number" ||
            !Number.isSafeInteger(decisionId) || decisionId < 1
          ) {
            throw new SentinelAssignmentError(
              "Select a saved Sentinel decision.",
            );
          }
          const decision = readSentinelDecision(path, kind, decisionId);
          if (
            !decision ||
            !tidepoolDecisionScope(path)(
              kind,
              decision.subjectId,
              decision.revision,
            )
          ) {
            throw new SentinelAssignmentError(
              "That Sentinel decision is unavailable.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_decision_detail",
            caseId,
            decision,
          });
          return;
        }
        case "decision_history": {
          const { revision, kind, subjectId, before } = message;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            (kind !== "finding" && kind !== "incident") ||
            typeof subjectId !== "string" || !subjectId ||
            subjectId.length > 1000 ||
            (before !== undefined &&
              (typeof before !== "number" || !Number.isSafeInteger(before) ||
                before < 1))
          ) {
            throw new SentinelAssignmentError(
              "Select a finding or incident in a retained evidence revision.",
            );
          }
          const allowed = tidepoolDecisionScope(path);
          if (!allowed(kind, subjectId, revision)) {
            throw new SentinelAssignmentError(
              "That Sentinel decision history is unavailable.",
            );
          }
          const page = readSentinelDecisionHistory(
            path,
            revision,
            kind,
            subjectId,
            before,
            10,
            (origin) => allowed(kind, subjectId, origin),
          );
          if (!page) {
            throw new SentinelAssignmentError(
              "That evidence revision is unavailable.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_decision_history",
            caseId,
            revision,
            kind,
            subjectId,
            before,
            ...page,
          });
          return;
        }
        case "incident_page": {
          const { revision, offset = 0 } = message;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0
          ) {
            throw new SentinelAssignmentError(
              "Select a retained evidence revision and history page.",
            );
          }
          const page = readSavedSentinelIncidentPage(
            path,
            revision,
            offset,
            retainedTelemetryScope(path, revision),
          );
          if (!page) {
            throw new SentinelAssignmentError(
              "No full alert feed was saved for this evidence revision.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_incident_page",
            caseId,
            revision,
            ...page,
          });
          return;
        }
        case "incident_alerts": {
          const { revision, incidentId, offset = 0 } = message;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof incidentId !== "string" ||
            !/^incident:[0-9a-f]{64}$/.test(incidentId) ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0
          ) {
            throw new SentinelAssignmentError(
              "Select an incident in a retained evidence revision.",
            );
          }
          const incident = readSavedSentinelIncident(
            path,
            revision,
            incidentId,
            true,
          );
          const scope = retainedTelemetryScope(path, revision);
          const unavailable = "The retained incident evidence is unavailable.";
          if ("error" in incident) {
            throw new SentinelAssignmentError(
              scope ? unavailable : incident.error,
            );
          }
          if (scope && !incident.members.every(scope.allowAlert)) {
            throw new SentinelAssignmentError(unavailable);
          }
          const { members } = incident;
          const page = members.slice(offset, offset + 10).map((alert) => ({
            ...alert,
            focusAlertKey: sentinelAlertKey(alert),
          }));
          send({
            topic: "sentinel",
            type: "sentinel_incident_alerts",
            caseId,
            incidentId,
            revision,
            offset,
            alerts: page,
            total: members.length,
            nextOffset: offset + page.length < members.length
              ? offset + page.length
              : null,
          });
          return;
        }
        case "revision_alerts": {
          const revision = message.revision;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1
          ) {
            throw new SentinelAssignmentError(
              "Select a retained evidence revision.",
            );
          }
          const retained = readSentinelAssessmentAlerts(path, revision);
          if (!retained) {
            throw new SentinelAssignmentError(
              "No full alert feed was saved for this evidence revision.",
            );
          }
          const scope = retainedTelemetryScope(path, revision);
          const alerts = scope ? retained.filter(scope.allowAlert) : retained;
          const upstreamCheck = message.upstreamCheck;
          const check = sentinelUpstreamChecks.find(({ id }) =>
            id === upstreamCheck
          );
          if (upstreamCheck !== undefined && !check) {
            throw new SentinelAssignmentError(
              "Select a known upstream coverage check.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_revision_alerts",
            caseId,
            revision,
            upstreamCheck,
            alerts: check
              ? alerts.filter((alert) =>
                matchesSentinelUpstreamCheck(check, alert)
              )
              : alerts,
          });
          return;
        }
        case "worker_history": {
          const { revision, before } = message;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof before !== "number" || !Number.isSafeInteger(before) ||
            before < 1 ||
            !readSentinelAssessmentRevision(path, revision)
          ) {
            throw new SentinelAssignmentError(
              "Select a retained evidence revision and history page.",
            );
          }
          const scope = retainedTelemetryScope(path, revision);
          const page = scope
            ? scopedWorkerHistory(path, revision, before)
            : readHistoricalAdaptiveSentinel(path, revision, before);
          send({
            topic: "sentinel",
            type: "sentinel_worker_history",
            caseId,
            revision,
            history: page?.history ?? [],
            historyCursor: page?.historyCursor ?? null,
          });
          return;
        }
        case "revision": {
          const priorTask = message.priorTask;
          let revision = message.revision;
          if (priorTask !== undefined) {
            if (
              typeof priorTask !== "string" ||
              !/^adaptive:[a-f0-9]{64}$/.test(priorTask) ||
              typeof revision !== "number" || !Number.isSafeInteger(revision) ||
              revision < 2
            ) {
              throw new SentinelAssignmentError(
                "Select a valid prior investigation.",
              );
            }
            revision = findSentinelTaskEvidence(path, priorTask, revision);
            if (revision === undefined) {
              throw new SentinelAssignmentError(
                "The prior investigation is no longer available in revision history.",
              );
            }
          }
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1
          ) {
            throw new SentinelAssignmentError(
              "Select a retained evidence revision.",
            );
          }
          const historical = readSentinelAssessmentRevision(path, revision);
          if (!historical) {
            throw new SentinelAssignmentError(
              "That evidence revision is no longer retained.",
            );
          }
          const baseline = message.baseline;
          if (
            baseline !== undefined &&
            (typeof baseline !== "number" || !Number.isSafeInteger(baseline) ||
              baseline < 1 || baseline >= revision)
          ) {
            throw new SentinelAssignmentError(
              "Select an earlier retained evidence revision for comparison.",
            );
          }
          const previous = baseline === undefined
            ? undefined
            : readSentinelAssessmentRevision(path, baseline);
          if (baseline !== undefined && !previous) {
            throw new SentinelAssignmentError(
              "The comparison revision is no longer retained.",
            );
          }
          const scope = retainedTelemetryScope(path, revision);
          if (scope && priorTask) {
            throw new SentinelAssignmentError(
              "The prior investigation is unavailable in this evidence revision.",
            );
          }
          const previousScope = previous &&
            retainedTelemetryScope(path, previous.revision);
          const scopedHistory = scope
            ? scopedWorkerHistory(path, revision)
            : undefined;
          const earlierHistory = previousScope && previous
            ? scopedWorkerHistory(path, previous.revision)
            : undefined;
          const selected = scope
            ? scopedRetainedAssessment(path, historical)
            : undefined;
          const earlier = previousScope && previous
            ? scopedRetainedAssessment(path, previous)
            : undefined;
          const adaptive = scope
            ? null
            : readHistoricalAdaptiveSentinel(path, revision);
          const earlierPlan = previous && !previousScope
            ? readHistoricalAdaptiveSentinel(path, previous.revision)
            : null;
          const revisionFeed = (
            number: number,
            scope?: ReturnType<typeof retainedTelemetryScope>,
          ) => {
            const alerts = readSentinelAssessmentAlerts(path, number);
            return scope ? alerts?.filter(scope.allowAlert) : alerts;
          };
          const baselineAlerts = previous
            ? revisionFeed(previous.revision, previousScope)
            : undefined;
          const selectedAlerts = baselineAlerts
            ? revisionFeed(revision, scope)
            : undefined;
          const { focusIncidentId } = message;
          let focusedIncident: Record<string, unknown> | undefined;
          if (focusIncidentId !== undefined) {
            if (
              typeof focusIncidentId === "string" &&
              /^incident:[a-f0-9]{64}$/.test(focusIncidentId) &&
              (!scope || scope.allowIncident(focusIncidentId))
            ) {
              const candidates = historical.result.sharedGraph.observations
                .find(
                  ({ task }) => task === "incident_correlation",
                )?.facts.candidates;
              focusedIncident = (Array.isArray(candidates)
                ? candidates.find(({ id }) =>
                  id === focusIncidentId
                )
                : undefined) ??
                readSavedSentinelIncidentCandidate(
                  path,
                  revision,
                  focusIncidentId,
                );
            }
            if (!focusedIncident) {
              throw new SentinelAssignmentError(
                "The incident is unavailable in this evidence revision.",
              );
            }
          }
          const savedIncidentReviews = readSentinelIncidentReviews(
            path,
            revision,
          );
          const incidentReviews = scope
            ? savedIncidentReviews.filter(({ incidentId }) =>
              scope.allowIncident(incidentId)
            )
            : savedIncidentReviews;
          const baselineGraph = previous &&
            buildSentinelProvenance(previous.result);
          const baselineNodes = (previousScope && baselineGraph
            ? projectSentinelProvenance(
              baselineGraph,
              (node) =>
                "alert" in node && node.alert
                  ? previousScope.allowAlert(node.alert)
                  : "incident" in node && !!node.incident &&
                    previousScope.allowIncident(node.sourceId),
              () =>
                false,
              (node) =>
                "incident" in node && node.incident
                  ? {
                    ...node,
                    incident: {
                      ...node.incident,
                      findingIds: node.incident.findingIds.filter(
                        previousScope.allowFinding,
                      ),
                    },
                  }
                  : node,
            )
            : baselineGraph)?.snapshot().nodes ?? [];
          const savedFindingReviews = readSentinelFindingReviews(
            path,
            revision,
          );
          const findingReviews = scope
            ? savedFindingReviews.filter(({ findingId }) =>
              scope.allowFinding(findingId)
            )
            : savedFindingReviews;
          if (
            scope && focusedIncident &&
            Array.isArray(focusedIncident.findingIds)
          ) {
            focusedIncident = {
              ...focusedIncident,
              findingIds: focusedIncident.findingIds.filter((id) =>
                typeof id === "string" && scope.allowFinding(id)
              ),
            };
          }
          const focusedIncidentAlerts =
            focusedIncident && typeof focusIncidentId === "string"
              ? readSavedSentinelIncident(path, revision, focusIncidentId, true)
                .members
              : undefined;
          if (
            scope && focusedIncident &&
            (!focusedIncidentAlerts?.length ||
              !focusedIncidentAlerts.every(scope.allowAlert))
          ) {
            throw new SentinelAssignmentError(
              "The incident is unavailable in this evidence revision.",
            );
          }
          const focusAlertKey = message.focusAlertKey;
          let revisionAlerts = selectedAlerts;
          const fullAlertFeed = () =>
            revisionAlerts ??= revisionFeed(revision, scope);
          let focusedAlert = typeof focusAlertKey === "string" &&
              focusAlertKey.length <= 13_000
            ? (focusedIncident ? focusedIncidentAlerts : fullAlertFeed())
              ?.filter((alert) => sentinelAlertKey(alert) === focusAlertKey)
              .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]
            : undefined;
          if (focusAlertKey !== undefined && !focusedAlert) {
            throw new SentinelAssignmentError(
              focusedIncident
                ? "That alert is not a contributing alert for the selected incident."
                : "That alert is unavailable in the selected revision.",
            );
          }
          const taskAlert = message.focusTaskAlert;
          if (taskAlert !== undefined) {
            if (
              !taskAlert || typeof taskAlert !== "object" ||
              !("taskId" in taskAlert) ||
              typeof taskAlert.taskId !== "string" ||
              !/^adaptive:[a-f0-9]{64}$/.test(taskAlert.taskId) ||
              !("alertId" in taskAlert) ||
              typeof taskAlert.alertId !== "string" ||
              !/^case-alert:[a-f0-9]{64}$/.test(taskAlert.alertId) ||
              focusAlertKey !== undefined || focusIncidentId !== undefined
            ) {
              throw new SentinelAssignmentError(
                "Select a valid investigation alert.",
              );
            }
            const { taskId, alertId } = taskAlert;
            const task = adaptive?.tasks.find(({ id }) => id === taskId);
            if (!task?.evidenceIds.includes(alertId)) {
              throw new SentinelAssignmentError(
                "That alert is not evidence for the selected investigation.",
              );
            }
            const citations = taskUpstreamCitations(task).filter(
              (citation) => citation.alertId === alertId,
            );
            const inventory = historical.result?.sharedGraph.snapshot;
            const graph = citations.length && inventory
              ? loadSentinelGraph(inventory)
              : undefined;
            focusedAlert = citations.length
              ? fullAlertFeed()?.find((alert) =>
                sentinelAlertReference(alert) === alertId &&
                graph && task.nodeId &&
                graph.resolveAssetId(alert.asset) === task.nodeId &&
                sentinelUpstreamChecks.some((check) =>
                  citations.some(({ checkId }) => checkId === check.id) &&
                  matchesSentinelUpstreamCheck(check, alert)
                )
              )
              : readSavedSentinelPlanningEvidence(path, revision)?.isolated
                .find(
                  (alert) => sentinelAlertReference(alert) === alertId,
                );
            if (!focusedAlert) {
              throw new SentinelAssignmentError(
                "That investigation alert is unavailable in this evidence revision.",
              );
            }
          }
          const provenance = buildSentinelProvenance(
            selected?.result ?? historical.result,
            adaptive ?? undefined,
            focusedAlert,
            incidentReviews,
            findingReviews,
            focusedIncident,
            focusedIncidentAlerts,
            focusedAlert?.type === "authentication_success_after_fanout" ||
              focusedAlert?.type === "authentication_failure_fanout"
              ? fullAlertFeed()
              : undefined,
          ).snapshot();
          if (
            typeof message.focusId === "string" &&
            retainedWorkerNarrativeId(message.focusId)
          ) {
            const exact = readSentinelProvenance(
              path,
              revision,
              null,
              message.focusId,
            );
            const focused = exact?.graph.inspect(message.focusId);
            if (
              !focused || !("workerNarrative" in focused.node) ||
              !focused.node.workerNarrative || !exact
            ) {
              throw new SentinelAssignmentError(
                "That worker observation is unavailable in this evidence revision.",
              );
            }
            const narrative = focused.node.workerNarrative;
            if (
              (narrative.receipt.factSources ||
                workerNarrativeSources(narrative.receipt, narrative.stepIndex)
                  .some(
                    ({ trafficDigest, upstreamCheck }) =>
                      trafficDigest || upstreamCheck,
                  )) &&
              !isDeepStrictEqual(
                narrative,
                await readWorkerNarrative?.(
                  caseId,
                  revision,
                  readSentinelAssessment(path)?.revision ?? revision,
                  message.focusId,
                ),
              )
            ) {
              throw new SentinelAssignmentError(
                "That worker observation is unavailable in this evidence revision.",
              );
            }
            const visible = new Set(provenance.nodes.map(({ id }) => id));
            provenance.nodes.push(focused.node);
            visible.add(focused.node.id);
            for (const relation of focused.connections) {
              if (relation.kind !== "edge") continue;
              const endpoint = relation.from === focused.node.id
                ? relation.to
                : relation.from;
              if (!visible.has(endpoint)) {
                const retained = exact.graph.inspect(endpoint)?.node;
                if (!retained || retained.origin !== "adaptive") continue;
                const { id, sourceId, kind, origin, label, status } = retained;
                provenance.nodes.push({
                  id,
                  sourceId,
                  kind,
                  origin,
                  label,
                  status,
                });
                visible.add(endpoint);
              }
              const { from, to, relation: edgeType } = relation;
              provenance.edges.push({ from, to, relation: edgeType });
            }
          }
          const taskTarget = message.focusTarget === true && priorTask
            ? adaptive?.tasks.find(({ id }) => id === priorTask)?.nodeId
            : undefined;
          const archivedTarget = taskTarget
            ? provenance.nodes.find((node) =>
              node.origin === "imported" && node.sourceId === taskTarget
            )
            : undefined;
          const focusedReview = (selected?.reviews ?? historical.reviews).find((
            { task },
          ) => message.focusId === `review:assessment:${task}`);
          const focusId = focusedAlert
            ? sentinelAlertProvenanceId(focusedAlert)
            : focusedIncident && typeof focusIncidentId === "string"
            ? sentinelIncidentProvenanceId(focusIncidentId)
            : archivedTarget
            ? archivedTarget.id
            : typeof message.focusId === "string" &&
                provenance.nodes.some((node) => node.id === message.focusId)
            ? message.focusId
            : undefined;
          const { admissionAt: _admissionAt, ...historicalPlan } =
            historical.plan ?? {};
          send({
            topic: "sentinel",
            type: "sentinel_revision",
            caseId,
            historical: selected ?? {
              ...historical,
              ...(historical.plan && { plan: historicalPlan }),
            },
            ...(scope && { scopeRestricted: true }),
            incidentReviews,
            findingReviews,
            alertFeedAvailable: scope
              ? !!fullAlertFeed()?.length
              : hasSavedSentinelAlerts(path, revision),
            adaptive: scopedHistory ?? adaptive,
            focusId,
            selectedAssessmentReview: focusedReview?.task,
            ...(canReadTidepoolNotificationReceipt(path, revision) && {
              notificationReceipt: readSentinelNotificationReceipt(
                path,
                revision,
              ),
            }),
            ...(!scope && (focusedAlert || focusedIncident) &&
              { revisions: readSentinelAssessmentRevisionIndex(path) }),
            ...(priorTask &&
              {
                ...(!focusId && { selectedTask: priorTask }),
                revisions: readSentinelAssessmentRevisionIndex(path),
              }),
            comparison: previous && {
              revision: previous.revision,
              graph: earlier
                ? earlier.result.sharedGraph.snapshot
                : previous.result?.sharedGraph.snapshot ?? null,
              ...(previousScope && { scopeRestricted: true }),
              findingReviews: readSentinelFindingReviews(
                path,
                previous.revision,
              ).filter(({ findingId }) =>
                !previousScope || previousScope.allowFinding(findingId)
              ),
              alertNodes: baselineNodes.filter((node) =>
                "alert" in node && node.alert
              ),
              incidentNodes: baselineNodes.filter((node) =>
                "incident" in node && node.incident
              ),
              incidentReviews: readSentinelIncidentReviews(
                path,
                previous.revision,
              ).filter(({ incidentId }) =>
                !previousScope || previousScope.allowIncident(incidentId)
              ),
              ...(baselineAlerts && selectedAlerts && {
                fullAlerts: { earlier: baselineAlerts, later: selectedAlerts },
              }),
              observations: previousScope
                ? []
                : previous.result?.sharedGraph.observations ?? [],
              adaptiveTasks: earlierPlan?.tasks ?? null,
              adaptiveGoal: earlierPlan?.goal.label ?? null,
              modelPlanner: earlierPlan?.modelPlanner ?? null,
              modelPlannerHistory: earlierPlan?.modelPlannerHistory ?? [],
              workerHistory: earlierHistory?.history ?? earlierPlan?.history ??
                null,
              historyCursor: earlierHistory?.historyCursor ??
                earlierPlan?.historyCursor ?? null,
            },
            provenance,
          });
          return;
        }
        case "export": {
          if (
            message.format !== "csv" && message.format !== "markdown" &&
            message.format !== "findings-json" && message.format !== "md-zip" &&
            message.format !== "provenance" && message.format !== "inventory" &&
            message.format !== "alerts" && message.format !== "decisions" &&
            message.format !== "incidents"
          ) return;
          const revision = message.revision;
          const current = revision === undefined
            ? readSentinelAssessment(path)
            : undefined;
          if (
            revision !== undefined && (typeof revision !== "number" ||
              !Number.isSafeInteger(revision) || revision < 1)
          ) {
            throw new SentinelAssignmentError(
              "Select a retained evidence revision.",
            );
          }
          const state = current ??
            (typeof revision === "number"
              ? readSentinelAssessmentRevision(path, revision)
              : undefined);
          if (!state) {
            throw new SentinelAssignmentError(
              "No retained assessment to export.",
            );
          }
          const format = message.format;
          const zipEntries = message.findingZipEntries === true;
          const paged = message.findingPageSize !== undefined ||
            message.findingCursor !== undefined;
          if (
            message.findingZipEntries !== undefined || paged ||
            message.findingIds !== undefined ||
            message.findingFilter !== undefined || format === "findings-json" ||
            format === "md-zip"
          ) {
            const language = message.language ?? "en";
            const selection = message.findingFilter !== undefined
              ? message.findingIds === undefined
                ? parseFindingExportFilter(message.findingFilter)
                : undefined
              : Array.isArray(message.findingIds)
              ? message.findingIds
              : undefined;
            if (
              typeof revision !== "number" ||
              !selection ||
              (message.findingZipEntries !== undefined &&
                (!zipEntries || !paged || format !== "md-zip")) ||
              (format !== "csv" && format !== "markdown" &&
                format !== "findings-json" && format !== "md-zip") ||
              !isSentinelReportLanguage(language)
            ) {
              throw new SentinelAssignmentError(
                "Select findings or a finding filter and an exact evidence revision to export.",
              );
            }
            let exceedsByteLimit = false;
            const markByteLimit = () => {
              exceedsByteLimit = true;
            };
            const page = paged
              ? renderScopedSentinelFindingsPage(
                path,
                caseId,
                state,
                selection,
                format,
                language,
                message.findingPageSize ?? 16,
                message.findingCursor,
                markByteLimit,
                zipEntries,
              )
              : undefined;
            const content = paged
              ? page?.content
              : renderScopedSentinelFindings(
                path,
                caseId,
                state,
                selection,
                format,
                language,
                markByteLimit,
              );
            if (content === undefined && exceedsByteLimit) {
              send({
                topic: "sentinel",
                type: "error",
                code: "finding_export_byte_limit",
                caseId,
                revision: state.revision,
                format,
                message: paged
                  ? "The finding report page exceeds the byte limit. Request a smaller page."
                  : "The finding report exceeds the byte limit. Request paged results.",
              });
              return;
            }
            if (content === undefined) {
              throw new SentinelAssignmentError(
                paged
                  ? "The finding report page is unavailable. Use the current selection or request a smaller page."
                  : "The finding report is unavailable. Narrow the filter or select exact findings.",
              );
            }
            send({
              topic: "sentinel",
              type: "export",
              caseId,
              revision: state.revision,
              format,
              content,
              ...(page?.findingPage && { findingPage: page.findingPage }),
              ...(zipEntries && { encoding: "finding-zip-entries-v2" }),
              ...(format === "md-zip" && !zipEntries && {
                encoding: "base64",
                contentType: "application/zip",
                filename: `sentinel-findings-r${state.revision}${
                  page?.findingPage ? `-offset-${page.findingPage.offset}` : ""
                }.zip`,
              }),
            });
            return;
          }
          const telemetryScope = retainedTelemetryScope(path, state.revision);
          if (format === "incidents") {
            const allowed = tidepoolDecisionScope(path);
            const content = renderSavedSentinelIncidentJson(
              path,
              caseId,
              state.revision,
              telemetryScope && {
                ...telemetryScope,
                allowReview: ({ incidentId, revision }) =>
                  allowed("incident", incidentId, revision),
              },
            );
            if (content === undefined) {
              throw new SentinelAssignmentError(
                "No full alert feed was saved for this evidence revision.",
              );
            }
            send({
              topic: "sentinel",
              type: "export",
              caseId,
              revision: state.revision,
              format,
              content,
            });
            return;
          }
          if (format === "decisions") {
            const allowed = tidepoolDecisionScope(path);
            send({
              topic: "sentinel",
              type: "export",
              caseId,
              revision: state.revision,
              format,
              content: renderSentinelDecisionHistoryJson(
                path,
                caseId,
                state.revision,
                (kind, subject, origin) =>
                  allowed(kind, subject, state.revision) &&
                  allowed(kind, subject, origin),
              ),
            });
            return;
          }
          const language = message.language ?? "en";
          if (!isSentinelReportLanguage(language)) {
            throw new SentinelAssignmentError(
              "Select a supported Markdown report language.",
            );
          }
          const savedInventory = state.result?.sharedGraph.snapshot ?? null;
          const inventory =
            format === "inventory" && savedInventory && telemetryScope
              ? scopedSentinelInventoryGraph(
                path,
                state.revision,
                loadSentinelGraph(savedInventory),
              ).snapshot()
              : savedInventory;
          if (format === "inventory" && !inventory) {
            throw new SentinelAssignmentError(
              "This revision has no evidence inventory to export.",
            );
          }
          const savedAlerts = format === "alerts"
            ? readSentinelAssessmentAlerts(path, state.revision)
            : undefined;
          const alerts = telemetryScope
            ? savedAlerts?.filter(telemetryScope.allowAlert)
            : savedAlerts;
          if (format === "alerts" && !alerts) {
            throw new SentinelAssignmentError(
              "No full alert feed was saved for this evidence revision.",
            );
          }
          const reportScope = format === "inventory" || format === "alerts"
            ? undefined
            : telemetryScope;
          const saved = reportScope &&
            readSentinelAssessmentRevision(path, state.revision);
          if (reportScope && !saved) {
            throw new SentinelAssignmentError(
              "The scoped evidence revision is unavailable.",
            );
          }
          const scopedState = saved
            ? {
              ...scopedRetainedAssessment(path, saved),
              active: current?.active,
              paused: current?.paused,
              scopeRestricted: true as const,
            }
            : undefined;
          const allowsDecision = tidepoolDecisionScope(path);
          const adaptive =
            reportScope || format === "csv" || format === "inventory" ||
              format === "alerts"
              ? undefined
              : current
              ? readAdaptiveSentinel(path, current, "revision") ?? undefined
              : readHistoricalAdaptiveSentinel(path, state.revision) ??
                undefined;
          const receiptScope = format === "markdown" || format === "provenance"
            ? readSentinelFindingReceiptScope(path, state.revision)
            : undefined;
          const scopedAdaptive = adaptive && {
            ...adaptive,
            remediationRechecks: adaptive.remediationRechecks.filter((item) =>
              !!receiptScope && item.caseId === caseId &&
              item.runId === receiptScope.runId &&
              item.evidenceRevision === state.revision &&
              receiptScope.allows(item.targetId) &&
              receiptScope.allows(item.evidenceId)
            ),
          };
          const findingTrafficLinks = format === "provenance"
            ? exportSentinelFindingTrafficLinks(path, state.revision)
            : [];
          const linkedFindings = readSentinelCaseFindingReceipts(
            path,
            [...new Set(findingTrafficLinks.map(({ findingId }) => findingId))],
          );
          const exportState = {
            ...(scopedState ?? state),
            workerFindings: format === "markdown" || format === "provenance"
              ? readScopedSentinelWorkerFindingReport(
                path,
                caseId,
                state.revision,
              )
              : undefined,
            findingTrafficLinks: findingTrafficLinks.filter((link) => {
              const original = linkedFindings.get(link.findingId);
              return !!receiptScope && link.caseId === caseId &&
                original?.kind === "finding" &&
                original.caseId === caseId &&
                original.runId === receiptScope.runId &&
                original.targetId === link.assetId &&
                original.evidenceRevision <= state.revision &&
                receiptScope.allows(link.assetId);
            }),
            findingReviews: format === "inventory" || format === "alerts"
              ? undefined
              : readSentinelFindingReviews(path, state.revision).filter(
                ({ findingId, revision }) =>
                  !reportScope ||
                  (reportScope.allowFinding(findingId) &&
                    allowsDecision("finding", findingId, revision)),
              ),
            incidentReviews: format === "markdown" || format === "provenance"
              ? readSentinelIncidentReviews(path, state.revision).filter(
                ({ incidentId, revision }) =>
                  !reportScope ||
                  (reportScope.allowIncident(incidentId) &&
                    allowsDecision("incident", incidentId, revision)),
              )
              : undefined,
          };
          const content = format === "csv"
            ? renderSentinelFindingsCsv(exportState)
            : format === "markdown"
            ? renderSentinelInvestigationMarkdown(
              exportState,
              scopedAdaptive,
              language,
            )
            : format === "inventory"
            ? JSON.stringify(inventory) + "\n"
            : format === "alerts" && alerts
            ? renderSentinelAlertsJson(caseId, state.revision, alerts)
            : renderSentinelProvenanceJson(
              caseId,
              exportState,
              scopedAdaptive,
              path,
            );
          send({
            topic: "sentinel",
            type: "export",
            caseId,
            revision: state.revision,
            format,
            content,
          });
          return;
        }
        case "asset_discovery_proposals": {
          send({
            topic: "sentinel",
            type: "sentinel_asset_discovery_proposals",
            caseId,
            proposals: listSentinelAssetDiscoveryProposals(
              bootstrap.baseDir,
              caseId,
            ),
          });
          return;
        }
        case "asset_discovery_decision": {
          const { id, version, action } = message;
          if (action === "correct") {
            const { replacementId, replacementVersion, correctionId } = message;
            const exactDiscovery = /^asset-discovery:[a-f0-9]{64}$/;
            if (
              typeof id !== "string" || !exactDiscovery.test(id) ||
              typeof version !== "number" || !Number.isSafeInteger(version) ||
              version < 2 || typeof replacementId !== "string" ||
              !exactDiscovery.test(replacementId) || replacementVersion !== 1 ||
              typeof correctionId !== "string" ||
              !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
                correctionId,
              )
            ) {
              throw new SentinelAssignmentError(
                "Select the exact approved discovery and its pending replacement.",
              );
            }
            const correction = await correctSentinelAssetDiscovery(
              bootstrap.baseDir,
              {
                sourceCaseId: caseId,
                requestId: correctionId,
                originalId: id,
                originalVersion: version,
                replacementId,
                replacementVersion,
              },
            );
            if (!correction) {
              throw new SentinelAssignmentError(
                "The discoveries or their exact evidence changed.",
              );
            }
            send({
              topic: "sentinel",
              type: "sentinel_asset_discovery_decision",
              caseId,
              record: correction.replacement,
              correction,
            });
            return;
          }
          if (
            typeof id !== "string" ||
            !/^asset-discovery:[a-f0-9]{64}$/.test(id) ||
            typeof version !== "number" || !Number.isSafeInteger(version) ||
            version < 1 ||
            (action !== "approve" && action !== "withdraw")
          ) {
            throw new SentinelAssignmentError(
              "Select a retained asset discovery and its current version.",
            );
          }
          const record = await decideSentinelAssetDiscovery(
            bootstrap.baseDir,
            caseId,
            id,
            version,
            action,
          );
          if (!record) {
            throw new SentinelAssignmentError(
              "The discovery or its exact evidence changed.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_asset_discovery_decision",
            caseId,
            record,
          });
          return;
        }
        case "case_lifecycle": {
          const { targetCase, action } = message;
          if (
            typeof targetCase !== "string" ||
            (action !== "pause" && action !== "resume" && action !== "stop" &&
              action !== "continue") ||
            (targetCase !== "main" &&
              !listSentinelCaseIds(bootstrap.baseDir).includes(targetCase))
          ) {
            throw new SentinelAssignmentError(
              "Select an existing case to pause, resume, stop, or continue.",
            );
          }
          const targetPath = resolveSentinelCasePath(
            bootstrap.baseDir,
            targetCase,
          );
          const activated = action === "continue"
            ? continueSentinelAssessment(targetPath, webContainment)
            : action === "resume"
            ? resumeSentinelAssessment(targetPath, webContainment)
            : undefined;
          const changed = action === "continue" || action === "resume"
            ? activated !== undefined
            : action === "stop"
            ? stopSentinelAssessment(targetPath)
            : pauseSentinelAssessment(targetPath);
          if (!changed) {
            throw new SentinelAssignmentError(
              "That case has already changed state. Refresh the overview.",
            );
          }
          if (activated) advanceAdaptiveSentinel(targetPath, activated);
          // Return the open case's normal state and a fresh overview below.
          break;
        }
        case "set_topology_auto":
        case "sync_shared_topology": {
          const automatic = message.type === "set_topology_auto";
          if (automatic && typeof message.enabled !== "boolean") {
            throw new SentinelAssignmentError(
              "Choose whether to refresh shared topology automatically.",
            );
          }
          try {
            if (automatic) {
              await setSentinelTopologyAuto(
                bootstrap.baseDir,
                caseId,
                path,
                message.enabled === true,
              );
            } else await syncSentinelTopology(bootstrap.baseDir, caseId, path);
          } catch {
            throw new SentinelAssignmentError(
              "Could not synchronize shared relationships. Check the published inventories.",
            );
          }
          const state = refreshSentinelAssessment(path, webContainment);
          if (state) advanceAdaptiveSentinel(path, state);
          break;
        }
        case "quarantine_source_snapshot":
        case "restore_source_snapshot": {
          if (typeof message.sourceSnapshotId !== "string") {
            throw new SentinelAssignmentError("Choose a source snapshot.");
          }
          const audit = await moveSentinelSourceSnapshot(
            bootstrap.baseDir,
            message.sourceSnapshotId,
            message.type === "restore_source_snapshot",
          );
          send({
            topic: "sentinel",
            type: "sentinel_source_snapshot_audit",
            caseId,
            audit,
          });
          return;
        }
        case "source_snapshot_audit":
          send({
            topic: "sentinel",
            type: "sentinel_source_snapshot_audit",
            caseId,
            audit: await auditSentinelSourceSnapshots(bootstrap.baseDir),
          });
          return;
        case "source_asset_lineage": {
          const { sourceCase, asset, after, limit } = message;
          if (
            !isSentinelCaseId(sourceCase) || typeof asset !== "string" ||
            !asset.trim() || asset.length > 4096 ||
            (after !== undefined &&
              (typeof after !== "string" || !/^[a-f0-9]{64}$/.test(after))) ||
            (limit !== undefined &&
              (typeof limit !== "number" || !Number.isSafeInteger(limit) ||
                limit < 1 || limit > 20))
          ) {
            throw new SentinelAssignmentError(
              "Choose a valid source asset and lineage page.",
            );
          }
          const lineage = await readSentinelSourceAssetLineage(
            bootstrap.baseDir,
            sourceCase,
            asset,
            {
              ...(after !== undefined && { after }),
              ...(limit !== undefined && { limit }),
            },
          );
          send({
            topic: "sentinel",
            type: "sentinel_source_asset_lineage",
            caseId,
            lineage,
          });
          return;
        }
        case "finding_traffic_download_page": {
          const {
            revision,
            currentRevision,
            findingId,
            trafficLinkId,
            payloadPart,
            offset,
          } = message;
          const unavailable = () =>
            new SentinelAssignmentError(
              "The exact retained traffic download page is unavailable.",
            );
          if (
            !readTrafficDownloadPage ||
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof currentRevision !== "number" ||
            !Number.isSafeInteger(currentRevision) ||
            currentRevision < revision ||
            typeof findingId !== "string" ||
            !/^worker-finding:[a-f0-9]{64}$/.test(findingId) ||
            typeof trafficLinkId !== "string" ||
            !/^finding-traffic-link:[a-f0-9]{64}$/.test(trafficLinkId) ||
            (payloadPart !== "request" && payloadPart !== "response" &&
              payloadPart !== "headers") ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0 || offset > 64 * 1024
          ) {
            throw unavailable();
          }
          const page = await readTrafficDownloadPage({
            caseId,
            revision,
            currentRevision,
            findingId,
            trafficLinkId,
            payloadPart,
            offset,
          });
          if (!page) throw unavailable();
          send({
            topic: "sentinel",
            type: "finding_traffic_download_page",
            caseId,
            revision,
            payloadPart,
            page,
          });
          return;
        }
        case "discovery_source": {
          const {
            revision,
            sourceCase,
            snapshotDigest,
            evidenceId,
            traceKind,
            traceId,
            stepIndex,
            attempt,
          } = message;
          const unavailable = () =>
            new SentinelAssignmentError(
              "The cited discovery evidence is unavailable.",
            );
          if (
            !readDiscoverySource ||
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof sourceCase !== "string" || !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
            typeof evidenceId !== "string" || !evidenceId.trim() ||
            evidenceId.length > 4096 ||
            typeof traceId !== "string" || !traceId.trim() ||
            traceId.length > 224 ||
            typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) ||
            stepIndex < 0 ||
            (traceKind === "planner"
              ? stepIndex >= 32 || typeof attempt !== "number" ||
                !Number.isSafeInteger(attempt) || attempt < 1
              : traceKind !== "worker" || stepIndex >= 16 ||
                attempt !== undefined)
          ) throw unavailable();
          const source = await readDiscoverySource({
            caseId,
            revision,
            sourceCase,
            snapshotDigest,
            evidenceId,
            traceKind: traceKind === "planner" ? "planner" : "worker",
            traceId,
            stepIndex,
            ...(typeof attempt === "number" && { attempt }),
          });
          if (!source) throw unavailable();
          send({
            topic: "sentinel",
            type: "sentinel_discovery_source",
            caseId,
            revision,
            source,
          });
          return;
        }
        case "alias_source_snapshot": {
          const {
            revision,
            sourceCase,
            snapshotDigest,
            traceKind,
            traceId,
            stepIndex,
            attempt,
          } = message;
          if (
            typeof revision !== "number" || !Number.isSafeInteger(revision) ||
            revision < 1 ||
            typeof sourceCase !== "string" || !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
            typeof traceId !== "string" || !traceId.trim() ||
            traceId.length > 256 ||
            typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) ||
            stepIndex < 0 || stepIndex >= 32 ||
            (traceKind === "planner"
              ? typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
                attempt < 1
              : attempt !== undefined ||
                (traceKind !== "worker" && traceKind !== "assessment"))
          ) {
            throw new SentinelAssignmentError(
              "Choose a retained alias proof source.",
            );
          }
          const historical = readSentinelAssessmentRevision(path, revision);
          if (!historical) {
            throw new SentinelAssignmentError(
              "The alias proof source is unavailable.",
            );
          }
          const adaptive = traceKind === "assessment"
            ? undefined
            : readHistoricalAdaptiveSentinel(path, revision);
          const step = traceKind === "assessment"
            ? historical.reviews.find(({ task }) => task === traceId)?.steps
              ?.[stepIndex]
            : traceKind === "worker"
            ? adaptive?.modelReviews.find(({ taskId }) => taskId === traceId)
              ?.steps[stepIndex]
            : adaptive?.modelPlannerHistory.find((
              { identity, attempt: savedAttempt },
            ) => identity === traceId && savedAttempt === attempt)?.reads
              ?.[stepIndex];
          const alias = step?.outcome === "returned" &&
            await readCitedSentinelAliasSnapshot(
              bootstrap.baseDir,
              path,
              step.aliasMapping,
              sourceCase,
              snapshotDigest,
            );
          if (!alias) {
            throw new SentinelAssignmentError(
              "The alias proof source is unavailable.",
            );
          }
          send({
            topic: "sentinel",
            type: "sentinel_alias_source_snapshot",
            caseId,
            sourceCase,
            snapshotDigest,
            aliasProof: alias.proof,
            graph: alias.graph,
          });
          return;
        }
        case "source_snapshot": {
          const { sourceCase, snapshotDigest, asset } = message;
          if (
            !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            typeof asset !== "string" || !asset.trim()
          ) {
            throw new SentinelAssignmentError(
              "Choose a valid source snapshot.",
            );
          }
          const sourcePath = resolveSentinelCasePath(
            bootstrap.baseDir,
            sourceCase,
          );
          let graph;
          let published = false;
          try {
            graph = await readArchivedSentinelSnapshot(
              bootstrap.baseDir,
              sourceCase,
              snapshotDigest,
              path,
            );
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            const current = await readSentinelChatSnapshot(sourcePath).catch(
              (error) => {
                if (error instanceof Deno.errors.NotFound) return undefined;
                throw error;
              },
            );
            if (current === undefined) {
              throw new SentinelAssignmentError(
                "The source snapshot is unavailable.",
              );
            }
            graph = loadSentinelGraph(current).snapshot();
            if (digestSentinelSnapshot(graph) !== snapshotDigest) {
              throw new SentinelAssignmentError(
                "The source snapshot is unavailable.",
              );
            }
            published = true;
          }
          const projection = projectTidepoolSourceSnapshot(
            path,
            sourcePath,
            asset,
            graph,
          );
          graph = projection.graph;
          if (
            !graph.nodes.some(({ id, kind }) =>
              id === asset && kind === "asset"
            )
          ) {
            throw new SentinelAssignmentError(
              "The asset is unavailable in the source snapshot.",
            );
          }
          const cases = projection.scopeRestricted ? [] : [
            ...new Set([
              caseId,
              "main",
              ...listSentinelCaseIds(bootstrap.baseDir),
            ]),
          ];
          const { citationCursor } = message;
          const readers = [
            (
              path: string,
              source: { caseId: string; digest: string; asset: string },
              limit: number,
              offset: number,
            ) =>
              readSentinelAssetSnapshotCitations(path, source, limit, offset)
                .map(({ revision, evidenceId }) => ({
                  revision,
                  focusId: `evidence:${evidenceId}`,
                })),
            readSentinelWorkerSnapshotCitations,
            readAssessmentReviewSnapshotCitations,
          ];
          let startCase = 0;
          let startKind = 0;
          let startOffset = 0;
          if (citationCursor !== undefined) {
            const match = typeof citationCursor === "string" &&
              /^([a-z0-9-]{1,48}):([0-2]):(\d{1,10})$/.exec(citationCursor);
            if (!match || !cases.includes(match[1])) {
              throw new SentinelAssignmentError(
                "Choose a valid citation page.",
              );
            }
            startCase = cases.indexOf(match[1]);
            startKind = Number(match[2]);
            startOffset = Number(match[3]);
          }
          const citations: {
            caseId: string;
            revision: number;
            focusId: string;
          }[] = [];
          const unavailableCitationCases = [];
          const limit = 20;
          let nextCitationCursor: string | undefined;
          const source = { caseId: sourceCase, digest: snapshotDigest, asset };
          for (
            let index = startCase;
            index < cases.length && !nextCitationCursor;
            index++
          ) {
            const consumerCase = cases[index];
            try {
              const citationPath = resolveSentinelCasePath(
                bootstrap.baseDir,
                consumerCase,
              );
              const consumerState = readSentinelAssessment(citationPath);
              if (
                consumerState &&
                retainedTelemetryScope(citationPath, consumerState.revision)
              ) continue;
              for (
                let kind = index === startCase ? startKind : 0;
                kind < readers.length;
                kind++
              ) {
                const offset = index === startCase && kind === startKind
                  ? startOffset
                  : 0;
                const remaining = limit - citations.length;
                const page = readers[kind](
                  citationPath,
                  source,
                  remaining + 1,
                  offset,
                );
                citations.push(
                  ...page.slice(0, remaining).map((citation) => ({
                    caseId: consumerCase,
                    ...citation,
                  })),
                );
                if (page.length > remaining) {
                  nextCitationCursor = `${consumerCase}:${kind}:${
                    offset + remaining
                  }`;
                  break;
                }
              }
            } catch {
              unavailableCitationCases.push(consumerCase);
            }
          }
          send({
            topic: "sentinel",
            type: "sentinel_source_snapshot",
            caseId,
            sourceCase,
            snapshotDigest,
            asset,
            graph,
            ...(projection.scopeRestricted && { scopeRestricted: true }),
            published,
            citations,
            moreCitations: nextCitationCursor !== undefined,
            nextCitationCursor,
            citationCursor,
            unavailableCitationCases,
          });
          return;
        }
        case "shared_finding_source": {
          const { sourceCase, snapshotDigest, asset, finding } = message;
          if (
            !isSentinelCaseId(sourceCase) ||
            typeof snapshotDigest !== "string" ||
            typeof asset !== "string" || typeof finding !== "string"
          ) {
            throw new SentinelAssignmentError("Choose a valid shared finding.");
          }
          const reference = {
            caseId: sourceCase,
            snapshotDigest,
            assetId: asset,
            findingId: finding,
          };
          const sourcePath = resolveSentinelCasePath(
            bootstrap.baseDir,
            sourceCase,
          );
          const recipient = sourcePath !== path && readSentinelAssessment(path);
          let projection: ReturnType<typeof projectTidepoolSourceSnapshot>;
          let published = false;
          if (recipient && retainedTelemetryScope(path, recipient.revision)) {
            const scoped = await projectScopedTidepoolPeerFinding(
              bootstrap.baseDir,
              path,
              caseId,
              sourcePath,
              reference,
            );
            if (!scoped) {
              throw new SentinelAssignmentError(
                "The requested evidence is unavailable in the source snapshot.",
              );
            }
            projection = scoped;
          } else {
            const source = await readSharedSentinelFindingSource(
              bootstrap.baseDir,
              reference,
            );
            if (source.status === "source_unavailable") {
              throw new SentinelAssignmentError(
                "The source snapshot is unavailable.",
              );
            }
            if (source.status === "source_changed") {
              throw new SentinelAssignmentError(
                "The reporting inventory changed. Reload the shared relationships.",
              );
            }
            if (source.status === "finding_unavailable") {
              throw new SentinelAssignmentError(
                "The finding is unavailable for this asset in the source snapshot.",
              );
            }
            projection = projectTidepoolSourceSnapshot(
              path,
              sourcePath,
              asset,
              source.graph,
              finding,
            );
            published = source.published;
          }
          send({
            topic: "sentinel",
            type: "sentinel_source_snapshot",
            caseId,
            sourceCase,
            snapshotDigest,
            asset: finding,
            graph: projection.graph,
            ...(projection.scopeRestricted && { scopeRestricted: true }),
            published,
          });
          return;
        }
        case "shared_asset_links": {
          const { asset, offset = 0, sourceCase } = message;
          if (
            typeof asset !== "string" || !asset.trim() ||
            asset.length > MAX_SNAPSHOT_BYTES ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0
          ) {
            throw new SentinelAssignmentError(
              "Choose a shared asset and a valid relationship page.",
            );
          }
          if (sourceCase !== undefined && typeof sourceCase !== "string") {
            throw new SentinelAssignmentError("Choose a valid reporting case.");
          }
          const reference = sourceCase === undefined
            ? undefined
            : loadSentinelGraph(
              await readSentinelChatSnapshot(
                resolveSentinelCasePath(bootstrap.baseDir, sourceCase),
              ),
            ).snapshot();
          if (
            reference &&
            !reference.nodes.some(({ id, kind }) =>
              id === asset && kind === "asset"
            )
          ) {
            throw new SentinelAssignmentError(
              "The asset is unavailable in the reporting case.",
            );
          }
          const relationships = await readSharedSentinelAssetLinks(
            bootstrap.baseDir,
            asset,
            offset,
            20,
            undefined,
            reference,
            true,
            { retainSourceSnapshots: true },
          );
          send({
            topic: "sentinel",
            type: "sentinel_shared_asset_links",
            caseId,
            relationships,
          });
          return;
        }
        case "shared_inventory": {
          const { query = "", offset = 0 } = message;
          if (
            typeof query !== "string" || query.length > 256 ||
            typeof offset !== "number" || !Number.isSafeInteger(offset) ||
            offset < 0
          ) {
            throw new SentinelAssignmentError(
              "Enter a valid inventory search and page.",
            );
          }
          const inventory = await readSharedSentinelAssets(
            bootstrap.baseDir,
            query,
            offset,
            20,
          );
          send({
            topic: "sentinel",
            type: "sentinel_shared_inventory",
            caseId,
            inventory,
          });
          return;
        }
        case "case_overview":
          send({
            topic: "sentinel",
            type: "sentinel_case_overview",
            caseId,
            cases: readCaseOverview(
              listSentinelCaseIds(bootstrap.baseDir),
              true,
            ),
          });
          return;
        case "status":
          break;
        default:
          return;
      }
      const topologyAuto = await sentinelTopologyAutoEnabled(path);
      const assessment = readSentinelAssessment(path) ?? null;
      const scope = assessment &&
        retainedTelemetryScope(path, assessment.revision);
      const retained = scope && assessment
        ? readSentinelAssessmentRevision(path, assessment.revision)
        : undefined;
      const projected = retained
        ? scopedRetainedAssessment(path, retained)
        : undefined;
      const adaptive = assessment
        ? readAdaptiveSentinel(path, assessment, scope ? "revision" : "case")
        : null;
      const visibleAdaptive = scope && adaptive && assessment
        ? (() => {
          const allowed = readSentinelWorkerEvidenceScope(
            path,
            assessment.revision,
          );
          const ids = new Set(
            allowed?.runId === adaptive.goal.id ? allowed.allowedTaskIds : [],
          );
          return {
            revision: adaptive.revision,
            evidenceRevision: assessment.revision,
            taskLimit: adaptive.taskLimit,
            tasks: adaptive.tasks.filter(({ id }) => ids.has(id)).map(({
              id,
              kind,
              nodeId,
              status,
              attempts,
              depth,
              prerequisites,
              retryable,
              prioritized,
              plannerPriority,
            }) => ({
              id,
              kind,
              nodeId,
              status,
              attempts,
              depth,
              prerequisites: prerequisites.filter((dependency) =>
                ids.has(dependency)
              ),
              retryable,
              prioritized,
              plannerPriority,
            })),
            modelReviewStates: adaptive.modelReviewStates.filter(({ taskId }) =>
              ids.has(taskId)
            ).map(({
              taskId,
              attempts,
              status,
              retryable,
            }) => ({ taskId, attempts, status, retryable })),
          };
        })()
        : adaptive;
      const incidentReviews = assessment
        ? readSentinelIncidentReviews(path, assessment.revision).filter(
          ({ incidentId }) => !scope || scope.allowIncident(incidentId),
        )
        : [];
      const findingReviews = assessment
        ? readSentinelFindingReviews(path, assessment.revision).filter(
          ({ findingId }) => !scope || scope.allowFinding(findingId),
        )
        : [];
      let provenance;
      if (assessment?.result) {
        provenance = scope && !projected ? null : buildSentinelProvenance(
          projected?.result ?? assessment.result,
          scope ? undefined : adaptive ?? undefined,
          undefined,
          incidentReviews,
          findingReviews,
        ).snapshot();
      } else if (scope) {
        provenance = null;
      } else {
        try {
          provenance = loadSentinelGraph(await readSentinelChatSnapshot(path))
            .snapshot();
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          provenance = null;
        }
      }
      const sentinelConfig = bootstrap.config.sentinel;
      const modelSettings = sentinelConfig?.allow_model_access === true
        ? readSentinelModelSettings(path)
        : undefined;
      const cases = listSentinelCaseIds(bootstrap.baseDir);
      const goalProof = !scope && assessment &&
        readSentinelGoalCompletionForState(path, assessment);
      const { admissionAt: _admissionAt, ...publicPlan } = assessment?.plan ??
        {};
      const notificationSettings = readSentinelNotificationState(path);
      send({
        topic: "sentinel",
        type: "sentinel_state",
        caseId,
        cases,
        ...((message.includeCaseOverview === true ||
          message.type === "case_lifecycle") && {
          caseOverview: readCaseOverview(cases),
        }),
        ...(!scope && message.includeRevisions === true && {
          revisions: readSentinelAssessmentRevisionIndex(path),
        }),
        ...(scope && { scopeRestricted: true }),
        assessment: assessment && (scope
          ? {
            revision: assessment.revision,
            updatedAt: assessment.updatedAt,
            active: assessment.active,
            paused: assessment.paused,
            deadlineReviewPending: assessment.deadlineReviewPending,
            plan: { runId: assessment.plan.runId },
            reviews: [],
            result: projected?.result ?? null,
          }
          : { ...assessment, plan: publicPlan }),
        goalProof: goalProof && assessment?.plan.runId
          ? {
            runId: assessment.plan.runId,
            digest: digestSentinelGoalProof(goalProof),
            policy: goalProof.policy,
            status: goalProof.status,
            criteria: goalProof.criteria.map(({ id, description }) => ({
              id,
              description,
              evidence: goalProof.observations.find(({ criterionId }) =>
                criterionId === id
              )?.evidence ?? [],
            })),
          }
          : null,
        ...(assessment?.paused && {
          pendingInputs: hasPendingSentinelInputs(path, webContainment),
        }),
        incidentReviews,
        findingReviews,
        alertFeedAvailable: assessment
          ? scope
            ? readSentinelAssessmentAlerts(path, assessment.revision)?.some(
              scope.allowAlert,
            ) === true
            : hasSavedSentinelAlerts(path, assessment.revision)
          : false,
        adaptive: visibleAdaptive,
        interactiveModelUsage: readSentinelInteractiveModelUsage(path),
        caseHints: scope ? [] : readSentinelCaseHints(path, 10),
        topologyAuto,
        notificationSettings: {
          gatewayEnabled: sentinelConfig?.notify_incident_increases === true,
          enabled: notificationSettings.enabled,
          latest: notificationSettings.latest && !scope &&
              canReadTidepoolNotificationReceipt(
                path,
                notificationSettings.latest.revision,
              )
            ? notificationSettings.latest
            : null,
        },
        ...(sentinelConfig?.allow_model_access === true && {
          workerSettings: {
            gatewayLimit: sentinelConfig.model_worker_limit ?? 2,
            caseLimit: modelSettings?.workerLimit ?? null,
          },
          modelOutputSettings: {
            gatewayLanguage: sentinelConfig.output_language ?? "en",
            caseLanguage: modelSettings?.outputLanguage ?? null,
          },
        }),
        provenance,
      });
    } catch (error) {
      send({
        topic: "sentinel",
        type: "error",
        message: error instanceof SentinelAssignmentError
          ? error.message
          : error instanceof Error &&
              error.message === "A Sentinel assessment is already active"
          ? error.message
          : "Sentinel could not process that request. Check the published assessment inputs.",
      });
    }
  };
}
