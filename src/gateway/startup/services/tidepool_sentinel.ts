/** Authenticated Tidepool operations for the gateway-owned Sentinel assessment. */
import { taskUpstreamCitations } from "../../../sentinel/adaptive_store.ts";
import {
  decideSentinelAssetDiscovery,
  listSentinelAssetDiscoveryProposals,
} from "../../sentinel_asset_discoveries.ts";
import {
  matchesSentinelUpstreamCheck,
  sentinelUpstreamChecks,
} from "../../../sentinel/defense_coverage.ts";
import { sentinelOutputLanguages } from "../../../core/config_types.ts";
import { isSentinelReportLanguage } from "../../../sentinel/report_language.ts";
import {
  openSentinelContainment,
  readSentinelContainmentOverview,
} from "../../../sentinel/containment.ts";
import { sentinelContainmentPath } from "../../../sentinel/paths.ts";
import { completeSentinelRegisteredGoal } from "../../sentinel_goal_completion.ts";
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
  readSentinelNotificationReceipt,
  readSentinelNotificationState,
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
  readSavedSentinelIncidentCandidate,
  readSavedSentinelIncidentPage,
  readSavedSentinelPlanningEvidence,
  renderSavedSentinelIncidentJson,
} from "../../../sentinel/incident_archive.ts";
import { loadSentinelGraph } from "../../../sentinel/graph.ts";
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
  readSharedSentinelAssetLinks,
  readSharedSentinelAssets,
  readSharedSentinelFindingSource,
} from "../../../sentinel/shared_inventory.ts";
import {
  auditSentinelSourceSnapshots,
  moveSentinelSourceSnapshot,
} from "../../../sentinel/source_snapshot_audit.ts";
import {
  sentinelAlertKey,
  sentinelAlertReference,
} from "../../../sentinel/telemetry.ts";
import {
  buildSentinelProvenance,
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
  readSentinelWorkerSnapshotCitations,
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

export function createTidepoolSentinelHandler(
  bootstrap: BootstrapResult,
  coordinatorState?: SentinelCoordinatorLookup,
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
          const goal = message.goal;
          if (goal !== undefined && typeof goal !== "string") {
            throw new Error("Enter a defensive assessment goal.");
          }
          const state = startSentinelAssessment(path, {
            goal: goal?.trim() || undefined,
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
          const { revision, expectedGoal, note } = message;
          if (
            typeof revision !== "number" ||
            (expectedGoal !== null && typeof expectedGoal !== "string") ||
            typeof note !== "string" ||
            !completeSentinelRegisteredGoal(
              path,
              revision,
              expectedGoal,
              note,
              webContainment,
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
          if (
            typeof revision !== "number" || typeof findingId !== "string" ||
            typeof note !== "string" || !decision ||
            !recordSentinelFindingReview(
              path,
              revision,
              findingId,
              decision,
              note,
            )
          ) {
            throw new SentinelAssignmentError(
              "Choose a finding in the current revision and enter a review note.",
            );
          }
          const state = readSentinelAssessment(path);
          if (state) advanceAdaptiveSentinel(path, state);
          break;
        }
        case "review_incident": {
          const { revision, incidentId, disposition, note } = message;
          const decision = sentinelIncidentDispositions.find((value) =>
            value === disposition
          );
          if (
            typeof revision !== "number" || typeof incidentId !== "string" ||
            typeof note !== "string" || !decision ||
            !recordSentinelIncidentReview(
              path,
              revision,
              incidentId,
              decision,
              note,
            )
          ) {
            throw new SentinelAssignmentError(
              "Choose an incident in the current revision and enter a review note.",
            );
          }
          const state = readSentinelAssessment(path);
          if (state) advanceAdaptiveSentinel(path, state);
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
          if (!decision) {
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
          const page = readSentinelDecisionHistory(
            path,
            revision,
            kind,
            subjectId,
            before,
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
          const page = readSavedSentinelIncidentPage(path, revision, offset);
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
          if ("error" in incident) {
            throw new SentinelAssignmentError(incident.error);
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
          const alerts = readSentinelAssessmentAlerts(path, revision);
          if (!alerts) {
            throw new SentinelAssignmentError(
              "No full alert feed was saved for this evidence revision.",
            );
          }
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
          const page = readHistoricalAdaptiveSentinel(path, revision, before);
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
          const adaptive = readHistoricalAdaptiveSentinel(path, revision);
          const earlierPlan = previous
            ? readHistoricalAdaptiveSentinel(path, previous.revision)
            : null;
          const baselineAlerts = previous
            ? readSentinelAssessmentAlerts(path, previous.revision)
            : undefined;
          const selectedAlerts = baselineAlerts
            ? readSentinelAssessmentAlerts(path, revision)
            : undefined;
          const { focusIncidentId } = message;
          let focusedIncident: Record<string, unknown> | undefined;
          if (focusIncidentId !== undefined) {
            if (
              typeof focusIncidentId === "string" &&
              /^incident:[a-f0-9]{64}$/.test(focusIncidentId)
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
          const incidentReviews = readSentinelIncidentReviews(path, revision);
          const baselineNodes = previous
            ? buildSentinelProvenance(previous.result).snapshot().nodes
            : [];
          const findingReviews = readSentinelFindingReviews(path, revision);
          const focusedIncidentAlerts =
            focusedIncident && typeof focusIncidentId === "string"
              ? readSavedSentinelIncident(path, revision, focusIncidentId, true)
                .members
              : undefined;
          const focusAlertKey = message.focusAlertKey;
          let revisionAlerts = selectedAlerts;
          const fullAlertFeed = () =>
            revisionAlerts ??= readSentinelAssessmentAlerts(path, revision);
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
            historical.result,
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
          const taskTarget = message.focusTarget === true && priorTask
            ? adaptive?.tasks.find(({ id }) => id === priorTask)?.nodeId
            : undefined;
          const archivedTarget = taskTarget
            ? provenance.nodes.find((node) =>
              node.origin === "imported" && node.sourceId === taskTarget
            )
            : undefined;
          const focusedReview = historical.reviews.find(({ task }) =>
            message.focusId === `review:assessment:${task}`
          );
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
          send({
            topic: "sentinel",
            type: "sentinel_revision",
            caseId,
            historical,
            incidentReviews,
            findingReviews,
            alertFeedAvailable: hasSavedSentinelAlerts(path, revision),
            adaptive,
            focusId,
            selectedAssessmentReview: focusedReview?.task,
            notificationReceipt: readSentinelNotificationReceipt(
              path,
              revision,
            ),
            ...((focusedAlert || focusedIncident) &&
              { revisions: readSentinelAssessmentRevisionIndex(path) }),
            ...(priorTask &&
              {
                ...(!focusId && { selectedTask: priorTask }),
                revisions: readSentinelAssessmentRevisionIndex(path),
              }),
            comparison: previous && {
              revision: previous.revision,
              graph: previous.result?.sharedGraph.snapshot ?? null,
              findingReviews: readSentinelFindingReviews(
                path,
                previous.revision,
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
              ),
              ...(baselineAlerts && selectedAlerts && {
                fullAlerts: { earlier: baselineAlerts, later: selectedAlerts },
              }),
              observations: previous.result?.sharedGraph.observations ?? [],
              adaptiveTasks: earlierPlan?.tasks ?? null,
              adaptiveGoal: earlierPlan?.goal.label ?? null,
              modelPlanner: earlierPlan?.modelPlanner ?? null,
              modelPlannerHistory: earlierPlan?.modelPlannerHistory ?? [],
              workerHistory: earlierPlan?.history ?? null,
              historyCursor: earlierPlan?.historyCursor ?? null,
            },
            provenance,
          });
          return;
        }
        case "export": {
          if (
            message.format !== "csv" && message.format !== "markdown" &&
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
          if (format === "incidents") {
            const content = renderSavedSentinelIncidentJson(
              path,
              caseId,
              state.revision,
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
          const inventory = state.result?.sharedGraph.snapshot ?? null;
          if (format === "inventory" && !inventory) {
            throw new SentinelAssignmentError(
              "This revision has no evidence inventory to export.",
            );
          }
          const alerts = format === "alerts"
            ? readSentinelAssessmentAlerts(path, state.revision)
            : undefined;
          if (format === "alerts" && !alerts) {
            throw new SentinelAssignmentError(
              "No full alert feed was saved for this evidence revision.",
            );
          }
          const adaptive =
            format === "csv" || format === "inventory" || format === "alerts"
              ? undefined
              : current
              ? readAdaptiveSentinel(path, current, "revision") ?? undefined
              : readHistoricalAdaptiveSentinel(path, state.revision) ??
                undefined;
          const exportState = {
            ...state,
            findingReviews: format === "inventory" || format === "alerts"
              ? undefined
              : readSentinelFindingReviews(path, state.revision),
            incidentReviews: format === "markdown" || format === "provenance"
              ? readSentinelIncidentReviews(path, state.revision)
              : undefined,
          };
          const content = format === "csv"
            ? renderSentinelFindingsCsv(exportState)
            : format === "markdown"
            ? renderSentinelInvestigationMarkdown(
              exportState,
              adaptive,
              language,
            )
            : format === "inventory"
            ? JSON.stringify(inventory) + "\n"
            : format === "alerts" && alerts
            ? renderSentinelAlertsJson(caseId, state.revision, alerts)
            : renderSentinelProvenanceJson(caseId, exportState, adaptive, path);
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
        case "source_snapshot": {
          const { sourceCase, snapshotDigest, asset } = message;
          if (
            typeof sourceCase !== "string" ||
            typeof snapshotDigest !== "string" ||
            typeof asset !== "string" || !asset.trim()
          ) {
            throw new SentinelAssignmentError(
              "Choose a valid source snapshot.",
            );
          }
          let graph;
          let published = false;
          try {
            graph = await readArchivedSentinelSnapshot(
              bootstrap.baseDir,
              sourceCase,
              snapshotDigest,
            );
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            const current = await readSentinelChatSnapshot(
              resolveSentinelCasePath(bootstrap.baseDir, sourceCase),
            ).catch((error) => {
              if (error instanceof Deno.errors.NotFound) return undefined;
              throw error;
            });
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
          if (
            !graph.nodes.some(({ id, kind }) =>
              id === asset && kind === "asset"
            )
          ) {
            throw new SentinelAssignmentError(
              "The asset is unavailable in the source snapshot.",
            );
          }
          const cases = [
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
            typeof sourceCase !== "string" ||
            typeof snapshotDigest !== "string" ||
            typeof asset !== "string" || typeof finding !== "string"
          ) {
            throw new SentinelAssignmentError("Choose a valid shared finding.");
          }
          const source = await readSharedSentinelFindingSource(
            bootstrap.baseDir,
            {
              caseId: sourceCase,
              snapshotDigest,
              assetId: asset,
              findingId: finding,
            },
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
          send({
            topic: "sentinel",
            type: "sentinel_source_snapshot",
            caseId,
            sourceCase,
            snapshotDigest,
            asset: finding,
            graph: source.graph,
            published: source.published,
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
      const assessment = readSentinelAssessment(path) ?? null;
      const adaptive = assessment
        ? readAdaptiveSentinel(path, assessment)
        : null;
      const incidentReviews = assessment
        ? readSentinelIncidentReviews(path, assessment.revision)
        : [];
      const findingReviews = assessment
        ? readSentinelFindingReviews(path, assessment.revision)
        : [];
      let provenance;
      if (assessment?.result) {
        provenance = buildSentinelProvenance(
          assessment.result,
          adaptive ?? undefined,
          undefined,
          incidentReviews,
          findingReviews,
        ).snapshot();
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
      send({
        topic: "sentinel",
        type: "sentinel_state",
        caseId,
        cases,
        ...((message.includeCaseOverview === true ||
          message.type === "case_lifecycle") && {
          caseOverview: readCaseOverview(cases),
        }),
        ...(message.includeRevisions === true && {
          revisions: readSentinelAssessmentRevisionIndex(path),
        }),
        assessment,
        ...(assessment?.paused && {
          pendingInputs: hasPendingSentinelInputs(path, webContainment),
        }),
        incidentReviews,
        findingReviews,
        alertFeedAvailable: assessment
          ? hasSavedSentinelAlerts(path, assessment.revision)
          : false,
        adaptive,
        interactiveModelUsage: readSentinelInteractiveModelUsage(path),
        caseHints: readSentinelCaseHints(path, 10),
        topologyAuto: await sentinelTopologyAutoEnabled(path),
        notificationSettings: {
          gatewayEnabled: sentinelConfig?.notify_incident_increases === true,
          ...readSentinelNotificationState(path),
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
