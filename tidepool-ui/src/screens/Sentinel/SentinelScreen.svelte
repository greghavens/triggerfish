<script module lang="ts">
  let requestSequence = 0;
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import Icon from "../../lib/components/Icon.svelte";
  import {
    getConnectionState,
    offTopic,
    onTopic,
    send,
  } from "../../lib/stores/websocket.svelte.js";
  import { isWorkspaceLanguage, sentinelWorkspaceText, workspaceLanguages, type WorkspaceLanguage } from "./workspace_language.js";
  import { comparisonText, workerTimelinesMarkdown } from "./comparison_markdown.js";
  import SavedAlerts from "./SavedAlerts.svelte";
  import AssessmentComparison from "./AssessmentComparison.svelte";
  import EvidenceComparison from "./EvidenceComparison.svelte";
  import TrafficEvidence from "./TrafficEvidence.svelte";
  import DecisionHistory from "./DecisionHistory.svelte";
  import FindingsTable from "./FindingsTable.svelte";
  import ProvenanceGraph from "./ProvenanceGraph.svelte";
  import InventoryImport from "./InventoryImport.svelte";
  import {
    humanize,
    type SentinelAdaptive,
    type SentinelModelUsage,
    type SentinelAssessment,
    type SentinelGraph,
    type SentinelImportPreview,
    type SentinelPathExport,
    type SentinelInventoryImport,
    type SentinelObservation,
    type SentinelNode,
    type SentinelPeerFindingCitation,
    type SentinelAlert,
    type SentinelTask,
    type FindingReview,
    planningInputs,
    type IncidentReview,
    type DecisionHistoryPage,
  } from "./types.js";

  type ExportFormat = "csv" | "markdown" | "provenance" | "inventory" | "alerts" | "decisions" | "incidents";
  const incidentDispositions = ["investigating", "resolved", "dismissed", "requires_review"];
  type DecisionDetail = {
    id: number; kind: "finding" | "incident"; subjectId: string; revision: number;
    disposition: string; note: string; at: string; retained: boolean;
  };
  type HintDetail = {
    id: number; kind: "hint"; revision: number | null;
    note: string; at: string; retained: boolean;
  };
  type AssetDiscoveryProposal = {
    readonly id: string;
    readonly version: number;
    readonly status: "pending" | "approved" | "withdrawn";
    readonly evidenceRevision: number;
    readonly sourceDigest: string;
    readonly claim: {
      readonly assetId: string;
      readonly evidenceId: string;
    } & (
      | { readonly kind: "asset" }
      | { readonly kind: "alias"; readonly alias: string }
      | { readonly kind: "relationship"; readonly to: string; readonly relation: string }
    );
  };
  type AliasTrace = { traceKind: "worker" | "assessment" | "planner"; traceId: string; stepIndex: number; attempt?: number };
  type RequestPayload =
    (AliasTrace & { revision: number; sourceCase: string; snapshotDigest: string }) |
    { readonly revision: number; readonly upstreamCheck: string } |
    { readonly revision: number; readonly expectedGoal: string | null; readonly note: string } |
    { readonly target: string; readonly reason: string; readonly ttlSeconds?: number; readonly expectedRevision?: string } |
    { readonly revision: number; readonly offset: number } |
    { readonly hintId: number } |
    { readonly kind: DecisionDetail["kind"]; readonly decisionId: number } |
    { readonly revision: number; readonly kind: "finding" | "incident"; readonly subjectId: string; readonly before?: number } |
    { readonly revision: number; readonly findingId: string; readonly disposition: string; readonly note: string } |
    { readonly revision: number; readonly incidentId: string; readonly disposition: string; readonly note: string } |
    { readonly revision: number; readonly incidentId: string; readonly offset: number } |
    { readonly sourceSnapshotId: string } |
    { readonly id: string; readonly version: number; readonly action: "approve" | "withdraw" } |
    { readonly revision: string; readonly taskId: string; readonly proposalId: string } |
    { readonly sourceCase: string; readonly snapshotDigest: string; readonly asset: string; readonly finding?: string; readonly citationCursor?: string } |
    { readonly enabled: boolean | null } | { readonly asset: string; readonly sourceCase: string; readonly offset: number } | { readonly query: string; readonly offset: number } | { readonly hint: string } | { readonly limit: number | null } | { readonly language: WorkspaceLanguage | null } |
    { readonly targetCase: string; readonly action: "pause" | "resume" | "stop" | "continue" } |
    { readonly format: ExportFormat; readonly revision?: number; readonly language?: "en" | "es" | "ko" | "zh" | "ja" } | SentinelInventoryImport |
    { readonly revision: string; readonly kind: string; readonly nodeId: string } |
    { readonly revision: string; readonly taskId: string } | { readonly revision: number; readonly baseline?: number; readonly before?: number; readonly priorTask?: string; readonly focusId?: string; readonly focusTarget?: boolean; readonly focusAlertKey?: string; readonly focusIncidentId?: string; readonly focusTaskAlert?: { readonly taskId: string; readonly alertId: string } };
  type Request =
    | "status"
    | "start"
    | "stop"
    | "complete_goal"
    | "incident_notifications"
    | "refresh"
    | "pause"
    | "resume"
    | "set_goal"
    | "preview_import"
    | "import"
    | "export"
    | "assign"
    | "apply_task_dependencies"
    | "dismiss_task_dependencies"
    | "retry_task"
    | "retry_model_review"
    | "prioritize_task"
    | "withdraw_task_priority"
    | "cancel_task"
    | "history"
    | "revision"
    | "worker_history"
    | "review_incident"
    | "review_finding"
    | "decision_history"
    | "decision_detail"
    | "hint_detail"
    | "incident_alerts"
    | "incident_page"
    | "revision_alerts"
    | "worker_limit"
    | "add_case_hint"
    | "model_output_language"
    | "shared_inventory"
    | "asset_discovery_proposals"
    | "asset_discovery_decision"
    | "quarantine_source_snapshot"
    | "restore_source_snapshot"
    | "source_snapshot_audit"
    | "alias_source_snapshot"
    | "source_snapshot"
    | "shared_finding_source"
    | "shared_asset_links"
    | "sync_shared_topology"
    | "set_topology_auto"
    | "case_overview"
    | "containment_overview"
    | "containment_block"
    | "containment_release"
    | "case_lifecycle";
  const taskNames: Readonly<Record<string, string>> = {
    coverage: "Graph coverage",
    defense_coverage: "Detection coverage",
    case: "Evidence review",
    incident_correlation: "Incident correlation",
    impact: "Dependency impact",
    trace: "Provenance trace",
    review_finding: "Finding review",
    review_evidence: "Evidence validation",
    review_incident: "Incident review",
    verify_control_coverage: "Control coverage verification",
  };
  const reasons: Readonly<Record<string, string>> = {
    graph_snapshot_required: "Waiting for a graph snapshot",
    alert_feed_required: "Waiting for an alert feed",
    supporting_evidence_missing: "Waiting for supporting evidence",
    prerequisite_pending: "Waiting for a prerequisite",
    selected_asset_missing: "Selected asset has not been published",
    selected_node_missing: "Selected node has not been published",
    no_impact_asset_selected: "No impact asset selected",
    no_trace_node_selected: "No trace node selected",
  };

  let workspaceLanguage = $state<WorkspaceLanguage>("en");
  const t = $derived(sentinelWorkspaceText(workspaceLanguage));
  let assessment = $state<SentinelAssessment | null>(null);
  type GoalProof = {
    runId: string;
    digest: string;
    policy: "operator" | "automatic";
    status: string;
    criteria: { id: string; description: string; evidence: { source: string; reference: string; detail: string }[] }[];
  };
  let goalProof = $state<GoalProof | null>(null);
  let completingGoal = $state<{ revision: number; expectedGoal: string | null; proof: GoalProof | null }>();
  let completionNote = $state("");
  let adaptive = $state<SentinelAdaptive | null>(null);
  let interactiveModelUsage = $state<SentinelModelUsage>();
  let notificationSettings = $state<{
    gatewayEnabled: boolean; enabled: boolean | null;
    latest: { revision: number; state: string; at: string } | null;
  }>();
  let historicalNotificationReceipt = $state<{ state: string; at: string }>();
  const notificationLabels: Record<string, string> = {
    pending: "Pending", attempted: "Delivery outcome unknown", delivered: "Delivered on first attempt",
    delivered_after_retry: "Delivered after retry",
    queued: "Queued after first attempt", failed: "Submission failed", submitted: "Submitted", disabled: "Disabled",
  };
  let modelOutputSettings = $state<{ gatewayLanguage: WorkspaceLanguage; caseLanguage: WorkspaceLanguage | null }>();
  type SharedInventory = {
    assets: readonly { id: string; sources: readonly { caseId: string; label: string; assetId?: string; aliases?: readonly string[] }[] }[];
    unavailable: readonly string[];
    offset: number;
    totalAssets: number;
    nextOffset: number | null;
  };
  type SharedAssetLinks = {
    asset: string;
    links: readonly { from: string; to: string; relation: string; caseIds: readonly string[]; remapped?: readonly { caseId: string; from: string; to: string }[] }[];
    findings?: readonly { caseId: string; assetId: string; snapshotDigest: string; finding: { id: string; label: string; severity?: string } }[];
    totalFindings?: number;
    unavailable: readonly string[];
    offset: number;
    nextOffset: number | null;
  };
  let sharedAssetLinks = $state<SharedAssetLinks>();
  let sharedInventory = $state<SharedInventory>();
  let assetDiscoveryProposals = $state<readonly AssetDiscoveryProposal[]>();
  let topologySynced = $state(false);
  let topologyAuto = $state(false);
  let inventoryQuery = $state("");
  let requestedInventoryQuery = $state("");
  let sourceSnapshotAudit = $state<{
    archivedCount: number;
    quarantined: string[];
    referencedCount: number;
    missing: string[];
    unreadableSnapshots: string[];
    candidates: string[];
    unavailableCases: string[];
  }>();
  type SnapshotCitation = { caseId: string; revision: number; focusId: string };
  let pendingSnapshotCitation: SnapshotCitation | undefined;
  let sourceSnapshot = $state<{ sourceCase: string; digest: string; asset: string; graph: SentinelGraph; published: boolean; aliasProof?: string; citations?: SnapshotCitation[]; nextCitationCursor?: string }>();
  let containment = $state<{
    total: number;
    active: { target: string; reason: string; blockedAt: string; expiresAt: string; revision: string | null }[];
    audit: { action: "block" | "release"; target: string; reason: string; at: string }[];
  } | null>();
  let releaseBlock = $state<{ target: string; revision: string | null }>();
  let sourceAsset = $state<string>();
  let pendingInventoryAsset: string | undefined;
  let caseHints = $state<readonly { id: number; at: string; text: string; revision: number | null }[]>([]);
  let caseHint = $state("");
  let workerSettings = $state<{ gatewayLimit: number; caseLimit: number | null }>();
  let revisions = $state<readonly { revision: number; updatedAt: string }[]>([]);
  let historyOpen = $state(false);
  let historical = $state<Pick<SentinelAssessment, "revision" | "updatedAt" | "reviews" | "result" | "completion"> | null>(null);
  let historicalAdaptive = $state<SentinelAdaptive | null>(null);
  let evidenceComparison = $state<{ markdown(text: (value: string) => string): string }>();
  let assessmentComparison = $state<{ markdown(text: (value: string) => string): string }>();
  let comparison = $state<{
    revision: number;
    graph: SentinelGraph | null;
    findingReviews?: readonly FindingReview[];
    observations: readonly SentinelObservation[];
    alertNodes?: readonly SentinelNode[];
    incidentNodes?: readonly SentinelNode[];
    incidentReviews?: readonly IncidentReview[];
    fullAlerts?: { earlier: readonly SentinelAlert[]; later: readonly SentinelAlert[] };
    adaptiveTasks: readonly SentinelTask[] | null;
    adaptiveGoal: string | null;
    modelPlanner: SentinelAdaptive["modelPlanner"];
    modelPlannerHistory: SentinelAdaptive["modelPlannerHistory"];
    workerHistory: SentinelAdaptive["history"] | null;
    historyCursor?: number | null;
  }>();
  type WorkerHistory = NonNullable<SentinelAdaptive["history"]>;
  type TimelineDownload = {
    revision: number;
    pages: WorkerHistory[] | null;
    cursor?: number | null;
  };
  let historyDownload = $state.raw<{
    timelines: TimelineDownload[];
    finish: (timelines: { revision: number; events: WorkerHistory | null }[]) => void;
  }>();
  let liveFindingReviews = $state.raw<FindingReview[]>([]);
  let historicalFindingReviews = $state.raw<FindingReview[]>([]);
  let liveAlertFeedAvailable = $state(false);
  let historicalAlertFeedAvailable = $state(false);
  let liveAlerts = $state.raw<{ revision: number; alerts: readonly SentinelAlert[] }>();
  let upstreamAlertFeed = $state.raw<{ revision: number; check: string; alerts: readonly SentinelAlert[] }>();
  let savedAlerts = $state.raw<{ revision: number; alerts: readonly SentinelAlert[] }>();
  let historicalGraph = $state<SentinelGraph | null>(null);
  let provenance = $state<SentinelGraph | null>(null);
  let selectedId = $state<string>();
  let goal = $state("");
  let editingGoal = $state(false);
  let exportOpen = $state(false);
  let reportLanguage = $state<WorkspaceLanguage>("en");
  let queueSearch = $state("");
  let queueFilter = $state("all");
  let modelReviewFilter = $state("all");
  let activitySearch = $state("");
  let revisionScope = $state("all");
  let activityLimit = $state(12);
  let pending = $state<Request>();
  let loaded = $state(false);
  let error = $state("");
  let caseId = $state("main");
  type CaseOverviewEntry = { id: string; status: string; revision?: number; coordinator?: string; pendingInputs?: boolean };
  let caseOverview = $state.raw<readonly CaseOverviewEntry[]>();
  let caseList = $state<readonly string[]>([]);
  let newCaseOpen = $state(false);
  let caseDraft = $state("");
  let caseError = $state("");
  let liveIncidentReviews = $state<IncidentReview[]>([]);
  let historicalIncidentReviews = $state<IncidentReview[]>([]);
  let decisionPanel: HTMLElement | undefined = $state();
  let decisionDetail = $state.raw<DecisionDetail | HintDetail>();
  let decisionPage = $state.raw<DecisionHistoryPage>();
  const displayedRevision = $derived(historical?.revision ?? assessment?.revision);
  let incidentPage = $state.raw<{
    revision: number; offset: number; total: number; nextOffset: number | null;
    incidents: readonly { sourceId: string; incident: NonNullable<SentinelNode["incident"]> }[];
  }>();
  const shownIncidentPage = $derived(incidentPage?.revision === displayedRevision ? incidentPage : undefined);
  let incidentAlerts = $state<{
    incidentId: string; revision: number; offset: number; total: number;
    nextOffset: number | null;
    alerts: readonly (SentinelAlert & { focusAlertKey: string })[];
  }>();
  let importPreview = $state<SentinelImportPreview>();
  let previewPayload: SentinelInventoryImport | undefined;
  let importCount = $state(0);
  let minimumReply = requestSequence + 1;
  let mostRecentReply = 0;
  let pendingId: number | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;

  const cases = $derived([...new Set(["main", ...caseList, caseId])]);
  const online = $derived(getConnectionState() === "connected");
  const active = $derived(assessment?.active === true);
  let pendingInputs = $state(false);
  const paused = $derived(active && assessment?.paused === true);
  const currentGoal = $derived(assessment?.plan?.goal ?? adaptive?.goal?.label);
  const graph = $derived(
    provenance ?? assessment?.result?.sharedGraph.snapshot ?? null,
  );
  const displayGraph = $derived(historical ? historicalGraph : graph);
  const incidentCandidates = $derived((displayGraph?.nodes ?? []).flatMap((node) =>
    node.incident ? [{ id: node.id, sourceId: node.sourceId, incident: node.incident }] : []));
  const shownIncidents = $derived(shownIncidentPage?.incidents.map((item) => ({
    ...item,
    id: incidentCandidates.find(({ sourceId }) => sourceId === item.sourceId)?.id,
  })) ?? incidentCandidates);
  const displayedEvidence = $derived(new Map(
    (displayGraph?.nodes ?? []).filter((node) => node.kind === "evidence")
      .map((node) => [node.sourceId ?? node.id, node]),
  ));
  const assignmentNode = $derived(graph?.nodes.find((node) => node.id === selectedId));
  const selectedAssignable = $derived(assignmentNode &&
    (["asset", "finding", "control", "evidence"].includes(assignmentNode.kind) || !!assignmentNode.incident));
  let assignmentKind = $state("trace");
  const assignmentKinds = $derived(assignmentNode?.incident ? ["review_incident"] : [
    "trace",
    ...(assignmentNode?.kind === "asset" ? ["impact"] : []),
    ...(assignmentNode?.kind === "finding" ? ["review_finding", "verify_control_coverage"] : []),
    ...(assignmentNode?.kind === "evidence" ? ["review_evidence"] : []),
  ]);
  const effectiveAssignmentKind = $derived(assignmentKinds.includes(assignmentKind) ? assignmentKind : assignmentKinds[0]);
  const observations = $derived(
    assessment?.result?.sharedGraph.observations ?? [],
  );
  type UpstreamCheck = {
    id: string; actions: readonly string[]; alertCount: number;
    sample: readonly { asset: string; observedAt: string; focusAlertKey: string }[];
  };
  const upstreamChecks = $derived(
    ((historical ? historical.result : assessment?.result)?.sharedGraph.observations.find(
      ({ task }) => task === "defense_coverage",
    )?.facts.upstreamChecks as readonly UpstreamCheck[] | undefined)?.filter(
      ({ alertCount }) => alertCount > 0,
    ) ?? [],
  );
  const reviews = $derived(assessment?.reviews ?? []);
  const deterministicTasks = $derived(assessment?.result?.tasks ?? []);
  const tasks = $derived(
    adaptive?.tasks?.length ? adaptive.tasks : deterministicTasks,
  );
  const atTaskLimit = $derived(adaptive?.taskLimit !== undefined &&
    (adaptive.tasks?.length ?? 0) >= adaptive.taskLimit);
  const workers = $derived(adaptive?.history ?? []);
  const workerNotes = $derived(adaptive?.notes ?? []);
  const tasksById = $derived(new Map(tasks.map((task) => [task.id, task])));
  const downstreamTasks = $derived.by(() => {
    const byPrerequisite = new Map<string, SentinelTask[]>();
    for (const task of tasks) {
      for (const prerequisite of task.prerequisites ?? []) {
        const dependents = byPrerequisite.get(prerequisite) ?? [];
        dependents.push(task);
        byPrerequisite.set(prerequisite, dependents);
      }
    }
    return byPrerequisite;
  });
  const failedPrerequisites = $derived.by(() => {
    const blocked = new Map<string, SentinelTask[]>();
    for (const blocker of tasks) {
      if (blocker.status !== "failed" && blocker.status !== "superseded") continue;
      const visited = new Set([blocker.id]);
      const pending = [blocker];
      for (const task of pending) {
        for (const dependent of downstreamTasks.get(task.id) ?? []) {
          if (dependent.status !== "queued" || visited.has(dependent.id)) continue;
          visited.add(dependent.id);
          const blockers = blocked.get(dependent.id) ?? [];
          blockers.push(blocker);
          blocked.set(dependent.id, blockers);
          pending.push(dependent);
        }
      }
    }
    return blocked;
  });
  function waitsForPrerequisites(task: SentinelTask): boolean {
    return task.status === "queued" &&
      (task.prerequisites ?? []).some((id) => tasksById.get(id)?.status !== "completed");
  }

  const visibleTasks = $derived.by(() => {
    const term = queueSearch.trim().toLowerCase();
    return tasks.filter((task) => {
      const review = liveModelReviewStates.get(task.id);
      if (modelReviewFilter !== "all" && review?.status !== modelReviewFilter) {
        return false;
      }
      const scope = queueFilter === "ready"
        ? task.status === "queued" && !task.heldForDecision && !task.retirementReason && !task.dependencyRecommendation && !waitsForPrerequisites(task)
        : queueFilter === "decision_hold"
        ? !!task.heldForDecision
        : queueFilter === "retirement"
        ? !!task.retirementReason
        : queueFilter === "blocked"
        ? waitsForPrerequisites(task)
        : queueFilter === "prioritized"
        ? task.prioritized === true
        : queueFilter === "retryable"
        ? task.retryable === true
        : queueFilter === "all" || task.status === queueFilter;
      return scope && (!term || [
        taskName(task), task.nodeId, task.id, task.worker, task.reason,
        t(humanize(task.status)),
        review && t(humanize(review.status)),
        task.reason && t(reasons[task.reason] ?? humanize(task.reason)),
      ].some((value) => value?.toLowerCase().includes(term)));
    });
  });
  const taskNodes = $derived(
    new Map(
      (provenance?.nodes ?? [])
        .filter((node) => node.kind === "task")
        .map((node) => [node.sourceId, node.id]),
    ),
  );
  const completed = $derived(
    tasks.filter((task) => task.status === "completed").length,
  );
  const liveModelReviewStates = $derived(
    new Map(adaptive?.modelReviewStates?.map((review) => [review.taskId, review])),
  );
  const savedModelReviewStates = $derived(
    new Map(historicalAdaptive?.modelReviewStates?.map((review) => [review.taskId, review])),
  );
  const liveReviewNotes = $derived(new Set(adaptive?.modelReviews?.map(({ taskId }) => taskId)));
  const savedReviewNotes = $derived(new Set(historicalAdaptive?.modelReviews?.map(({ taskId }) => taskId)));
  const ready = $derived(tasks.filter(
    (task) => task.status === "queued" && !task.heldForDecision && !task.retirementReason && !task.dependencyRecommendation && !waitsForPrerequisites(task),
  ).length);
  const blockedCount = $derived(tasks.filter(waitsForPrerequisites).length);
  const waitingCount = $derived(tasks.filter((task) => task.status === "waiting").length);
  const running = $derived(
    tasks.filter((task) => task.status === "running").length,
  );
  const matchingWorkers = $derived(
    workers.filter((item) =>
      matchesActivity(item.revision, [
        activityTaskName(item),
        item.event,
        t(humanize(item.event)),
        item.taskId,
        item.nodeId,
        item.note,
        item.at,
      ]),
    ),
  );
  const matchingNotes = $derived(
    workerNotes.filter((item) =>
      matchesActivity(item.revision, [
        activityTaskName(item),
        item.taskId,
        item.nodeId,
        item.note,
        ...(item.steps ?? []).flatMap(({ tool, target, outcome }) => [tool, target, outcome]),
        item.at,
      ]),
    ),
  );
  const matchingObservations = $derived(
    observations.filter((item) =>
      matchesActivity(undefined, [
        taskReference(item.task),
        item.worker,
        "Evidence processed",
        t("Evidence processed"),
      ]),
    ),
  );
  const matchingReviews = $derived(
    reviews.filter((item) =>
      matchesActivity(undefined, [
        taskReference(item.task),
        "Model review",
        t("Model review"),
        item.analysis,
        ...(item.steps ?? []).flatMap(({tool, target, outcome}) => [tool, target, outcome]),
      ]),
    ),
  );
  const matchingActivity = $derived(
    matchingWorkers.length +
      matchingNotes.length +
      matchingObservations.length +
      matchingReviews.length,
  );

  function taskName(task: Pick<SentinelTask, "id" | "kind" | "label">) {
    const kind = task.kind ?? task.id;
    return task.label ?? t(taskNames[kind] ?? humanize(kind));
  }

  function taskReference(id: string) {
    const task = tasksById.get(id);
    return task ? taskName(task) : t(taskNames[id] ?? "Assessment task");
  }

  function activityTaskName(item: { taskId: string | null; kind?: string }) {
    if (item.kind) return t(taskNames[item.kind] ?? humanize(item.kind));
    return item.taskId ? taskReference(item.taskId) : t("Coordinator note");
  }

  function isPrior(revision: string | undefined) {
    return (
      revision !== undefined &&
      adaptive?.revision !== undefined &&
      revision !== adaptive.revision
    );
  }

  function matchesActivity(
    revision: string | undefined,
    fields: readonly (string | null | undefined)[],
  ) {
    const prior = isPrior(revision);
    if (
      (revisionScope === "current" && prior) ||
      (revisionScope === "prior" && !prior)
    )
      return false;
    const term = activitySearch.trim().toLowerCase();
    return (
      !term ||
      [...fields, revision].some((value) => value?.toLowerCase().includes(term))
    );
  }

  function revisionLabel(revision: string) {
    return (revision.split(":").at(-1) ?? revision).slice(0, 10);
  }

  function carriedTask(event: string, note: string | null): string | undefined {
    return event === "carried_forward"
      ? /^Revalidated (?:operator )?assignment from task (adaptive:[a-f0-9]{64})\.$/.exec(note ?? "")?.[1]
      : event === "reopened"
      ? /^Updated evidence (?:changed the result of|prompted a review of) completed task (adaptive:[a-f0-9]{64})\.$/.exec(note ?? "")?.[1]
      : event === "result_reused"
      ? /^Reused the verified result of completed task (adaptive:[a-f0-9]{64})\.$/.exec(note ?? "")?.[1]
      : undefined;
  }

  async function focusTask(id: string) {
    if (!visibleTasks.some((task) => task.id === id)) {
      queueSearch = "";
      queueFilter = "all";
      modelReviewFilter = "all";
      await tick();
    }
    const row = document.getElementById(`sentinel-task-${id}`);
    row?.focus();
    row?.scrollIntoView({ block: "nearest" });
  }

  function focusNode(id: string) {
    historical = null;
    focusDisplayedNode(id);
  }

  function openRemovedTaskEvidence(revision: number, priorTask: string, id: string) {
    if (id.startsWith("case-alert:")) {
      request("revision", { revision, priorTask, focusTaskAlert: { taskId: priorTask, alertId: id } });
    } else {
      request("revision", { revision, priorTask, focusId: `evidence:${id}` });
    }
  }

  function focusDisplayedNode(id: string) {
    selectedId = id;
    document
      .getElementById("provenance-heading")
      ?.scrollIntoView({ block: "nearest" });
  }

  function completeRequest() {
    clearTimeout(requestTimeout);
    pending = undefined;
    pendingId = undefined;
  }

  function openPlanningInput(kind: "finding" | "incident" | "hint", id: number) {
    if (kind === "hint") request("hint_detail", { hintId: id });
    else request("decision_detail", { kind, decisionId: id });
  }

  function request(type: Request, payload?: RequestPayload) {
    if (getConnectionState() !== "connected" || pending) return;
    const requestId = ++requestSequence;
    if (type !== "status") {
      pending = type;
      pendingId = requestId;
      error = "";
      requestTimeout = setTimeout(() => {
        completeRequest();
        historyDownload = undefined;
        error =
          "The request timed out. Refresh to check the assessment status.";
      }, 15000);
    }
    if (type === "export") exportOpen = false;
    send({
      topic: "sentinel",
      type,
      requestId,
      caseId,
      ...(historyOpen && { includeRevisions: true }),
      ...(caseOverview && { includeCaseOverview: true }),
      ...((type === "start" || type === "set_goal") && goal.trim()
        ? { goal: goal.trim() }
        : {}),
      ...payload,
    });
  }

  function receive(message: Record<string, unknown>) {
    if (typeof message.caseId === "string" && message.caseId !== caseId) return;
    if (typeof message.requestId === "number") {
      const id = message.requestId;
      if (
        id < minimumReply ||
        id <= mostRecentReply ||
        (pendingId !== undefined && id < pendingId)
      )
        return;
      mostRecentReply = id;
    }
    if (message.type === "sentinel_state") {
      if (pending === "review_finding" || pending === "review_incident") decisionPage = undefined;
      if (Array.isArray(message.cases)) {
        caseList = message.cases.filter(
          (id): id is string => typeof id === "string",
        );
      }
      if (caseOverview && Array.isArray(message.caseOverview)) {
        const previous = new Map(caseOverview.map((entry) => [entry.id, entry]));
        caseOverview = (message.caseOverview as CaseOverviewEntry[]).map((entry) => {
          const prior = previous.get(entry.id);
          const pendingInputs = entry.id === caseId && entry.status === "paused"
            ? message.pendingInputs === true
            : entry.status === "paused" && prior?.status === "paused" && entry.revision === prior.revision
              ? prior.pendingInputs
              : undefined;
          return { ...entry, pendingInputs };
        });
      }
      if (historyOpen && Array.isArray(message.revisions)) revisions = message.revisions;
      pendingInputs = message.pendingInputs === true;
      liveAlertFeedAvailable = message.alertFeedAvailable === true;
      liveFindingReviews = (message.findingReviews as FindingReview[] | undefined) ?? [];
      liveIncidentReviews = (message.incidentReviews as IncidentReview[] | undefined) ?? [];
      assessment =
        (message.assessment as SentinelAssessment | null | undefined) ?? null;
      goalProof = (message.goalProof as GoalProof | null | undefined) ?? null;
      adaptive =
        (message.adaptive as SentinelAdaptive | null | undefined) ?? null;
      interactiveModelUsage = message.interactiveModelUsage as SentinelModelUsage | undefined;
      workerSettings = message.workerSettings as typeof workerSettings;
      caseHints = (message.caseHints as typeof caseHints | undefined) ?? [];
      if (pending === "add_case_hint") caseHint = "";
      modelOutputSettings = message.modelOutputSettings as typeof modelOutputSettings;
      notificationSettings = message.notificationSettings as typeof notificationSettings;
      provenance =
        (message.provenance as SentinelGraph | null | undefined) ?? null;
      if (pendingInventoryAsset) {
        const target = pendingInventoryAsset;
        const reportingCase = caseId;
        pendingInventoryAsset = undefined;
        void tick().then(() => {
          if (caseId === reportingCase) focusInventoryAsset(target);
        });
      }
      if (pending === "set_goal" || !assessment?.active) editingGoal = false;
      if (pending === "complete_goal" && assessment?.completion) {
        completingGoal = undefined;
        completionNote = "";
      }
      if (pending === "import") {
        importCount++;
        clearImportPreview();
      }
      topologyAuto = message.topologyAuto === true;
      if (pending === "sync_shared_topology") topologySynced = true;
      loaded = true;
      error = "";
      if (pending !== "export") completeRequest();
      if (pendingSnapshotCitation) {
        const { revision, focusId } = pendingSnapshotCitation;
        pendingSnapshotCitation = undefined;
        request("revision", { revision, focusId });
      }
    } else if (message.type === "sentinel_hint_detail" && pending === "hint_detail") {
      const hint = message.hint as Omit<HintDetail, "note" | "kind"> & { text: string };
      decisionDetail = { ...hint, note: hint.text, kind: "hint" };
      completeRequest();
      void tick().then(() => decisionPanel?.focus());
    } else if (message.type === "sentinel_decision_detail" && pending === "decision_detail") {
      decisionDetail = message.decision as DecisionDetail;
      completeRequest();
      void tick().then(() => decisionPanel?.focus());
    } else if (message.type === "sentinel_decision_history" && pending === "decision_history") {
      decisionPage = message as unknown as DecisionHistoryPage;
      completeRequest();
    } else if (message.type === "sentinel_incident_page" && pending === "incident_page") {
      incidentPage = message as unknown as typeof incidentPage;
      completeRequest();
    } else if (message.type === "sentinel_incident_alerts" && pending === "incident_alerts") {
      incidentAlerts = message as unknown as typeof incidentAlerts;
      completeRequest();
    } else if (message.type === "sentinel_import_preview" && pending === "preview_import") {
      importPreview = message.preview as SentinelImportPreview;
      completeRequest();
    } else if (message.type === "sentinel_containment_overview" &&
      (pending === "containment_overview" || pending === "containment_block" || pending === "containment_release")) {
      containment = message.policy as typeof containment;
      releaseBlock = undefined;
      completeRequest();
    } else if (message.type === "sentinel_asset_discovery_proposals" && pending === "asset_discovery_proposals") {
      assetDiscoveryProposals = Array.isArray(message.proposals)
        ? message.proposals as AssetDiscoveryProposal[]
        : [];
      completeRequest();
    } else if (message.type === "sentinel_asset_discovery_decision" && pending === "asset_discovery_decision") {
      const record = message.record as AssetDiscoveryProposal;
      assetDiscoveryProposals = assetDiscoveryProposals?.map((proposal) =>
        proposal.id === record.id ? record : proposal
      );
      completeRequest();
    } else if (message.type === "sentinel_source_snapshot_audit" &&
      (pending === "source_snapshot_audit" || pending === "quarantine_source_snapshot" || pending === "restore_source_snapshot")) {
      sourceSnapshotAudit = message.audit as typeof sourceSnapshotAudit;
      completeRequest();
    } else if (message.type === "sentinel_alias_source_snapshot" && pending === "alias_source_snapshot") {
      sourceSnapshot = {
        sourceCase: String(message.sourceCase),
        digest: String(message.snapshotDigest),
        asset: "",
        graph: message.graph as SentinelGraph,
        published: false,
        aliasProof: String(message.aliasProof),
      };
      sourceAsset = undefined;
      completeRequest();
      void tick().then(() => document.getElementById("sentinel-source-snapshot")?.scrollIntoView({ block: "nearest" }));
    } else if (message.type === "sentinel_source_snapshot" && (pending === "source_snapshot" || pending === "shared_finding_source")) {
      const citations = Array.isArray(message.citations) ? message.citations as SnapshotCitation[] : [];
      const previous = sourceSnapshot;
      const matching = typeof message.citationCursor === "string" && previous && previous.sourceCase === message.sourceCase && previous.digest === message.snapshotDigest && previous.asset === message.asset;
      sourceSnapshot = {
        sourceCase: String(message.sourceCase),
        digest: String(message.snapshotDigest),
        asset: String(message.asset),
        graph: message.graph as SentinelGraph,
        published: message.published === true,
        citations: [...new Map([...(matching ? previous.citations ?? [] : []), ...citations].map((citation) => [
          JSON.stringify([citation.caseId, citation.revision, citation.focusId]), citation,
        ])).values()],
        nextCitationCursor: typeof message.nextCitationCursor === "string" ? message.nextCitationCursor : undefined,
      };
      if (!matching) sourceAsset = String(message.asset);
      if (sourceSnapshot.published || pending === "shared_finding_source") void tick().then(() => {
        document.getElementById("sentinel-source-snapshot")?.scrollIntoView({ block: "nearest" });
      });
      completeRequest();
    } else if (message.type === "sentinel_shared_asset_links" && pending === "shared_asset_links") {
      sharedAssetLinks = message.relationships as SharedAssetLinks;
      completeRequest();
    } else if (message.type === "sentinel_shared_inventory" && pending === "shared_inventory") {
      sharedInventory = message.inventory as SharedInventory;
      completeRequest();
    } else if (message.type === "sentinel_case_overview" && pending === "case_overview") {
      caseOverview = Array.isArray(message.cases) ? message.cases : [];
      caseList = caseOverview.map(({ id }) => id);
      completeRequest();
    } else if (message.type === "sentinel_history" && pending === "history") {
      revisions = Array.isArray(message.revisions) ? message.revisions : [];
      historyOpen = true;
      completeRequest();
    } else if (message.type === "sentinel_revision" && pending === "revision") {
      historical = message.historical as typeof historical;
      historicalNotificationReceipt = message.notificationReceipt as typeof historicalNotificationReceipt;
      historicalAlertFeedAvailable = message.alertFeedAvailable === true;
      historicalFindingReviews = (message.findingReviews as FindingReview[] | undefined) ?? [];
      historicalIncidentReviews = (message.incidentReviews as IncidentReview[] | undefined) ?? [];
      comparison = message.comparison as typeof comparison;
      historicalAdaptive = (message.adaptive as SentinelAdaptive | undefined) ?? null;
      historicalGraph = (message.provenance as SentinelGraph | undefined) ?? null;
      selectedId = undefined;
      if (typeof message.focusId === "string") {
        const focusId = message.focusId;
        if (Array.isArray(message.revisions)) {
          revisions = message.revisions;
          historyOpen = true;
        }
        void tick().then(() => focusDisplayedNode(focusId));
      }
      if (typeof message.selectedAssessmentReview === "string") {
        const target = message.selectedAssessmentReview;
        void tick().then(() => {
          const review = document.getElementById(`sentinel-assessment-review-${target}`);
          if (review instanceof HTMLDetailsElement) {
            review.open = true;
            review.focus();
            review.scrollIntoView({ block: "nearest" });
          }
        });
      }
      if (typeof message.selectedTask === "string") {
        const target = message.selectedTask;
        if (Array.isArray(message.revisions)) revisions = message.revisions;
        historyOpen = true;
        void tick().then(() => {
          const row = document.getElementById(`sentinel-historical-task-${target}`);
          row?.focus();
          row?.scrollIntoView({ block: "nearest" });
        });
      }
      completeRequest();
    } else if (message.type === "sentinel_revision_alerts" && pending === "revision_alerts") {
      if (typeof message.revision === "number" && Array.isArray(message.alerts)) {
        const feed = { revision: message.revision, alerts: message.alerts };
        if (typeof message.upstreamCheck === "string") {
          upstreamAlertFeed = { ...feed, check: message.upstreamCheck };
        } else if (historical?.revision === message.revision) savedAlerts = feed;
        else if (!historical) liveAlerts = feed;
      }
      completeRequest();
    } else if (message.type === "sentinel_worker_history" && pending === "worker_history") {
      const events = (message.history as SentinelAdaptive["history"]) ?? [];
      const historyCursor = typeof message.historyCursor === "number" ? message.historyCursor : null;
      const downloading = historyDownload?.timelines.find((timeline) => timeline.cursor);
      if (downloading && downloading.revision === message.revision) {
        downloading.pages?.push(events);
        downloading.cursor = historyCursor;
        completeRequest();
        advanceHistoryDownload();
        return;
      }
      if (historicalAdaptive && historical?.revision === message.revision) {
        historicalAdaptive = { ...historicalAdaptive, history: [...(historicalAdaptive.history ?? []), ...events], historyCursor };
      } else if (comparison && comparison.revision === message.revision) {
        comparison = { ...comparison, workerHistory: [...(comparison.workerHistory ?? []), ...events], historyCursor };
      }
      completeRequest();
    } else if (message.type === "export" && pending === "export") {
      const { format, content } = message;
      if (
        (format === "csv" || format === "markdown" || format === "provenance" || format === "inventory" || format === "alerts" || format === "decisions" || format === "incidents") &&
        typeof content === "string"
      ) {
        downloadReport(format, content, typeof message.revision === "number" ? message.revision : undefined);
      } else {
        error = "The server returned an invalid export.";
      }
      completeRequest();
    } else if (message.type === "error" || message.type === "sentinel_error") {
      historyDownload = undefined;
      error =
        typeof message.message === "string"
          ? message.message
          : "The assessment request failed.";
      loaded = true;
      completeRequest();
    }
  }

  function connection(message: Record<string, unknown>) {
    if (message.type === "ws_connected") request("status");
    if (message.type === "ws_disconnected") {
      if (historyDownload) error = "The worker history download was interrupted.";
      historyDownload = undefined;
      completeRequest();
    }
  }

  function advanceHistoryDownload() {
    if (!historyDownload) return;
    const pendingTimeline = historyDownload.timelines.find((timeline) => timeline.cursor);
    if (pendingTimeline?.cursor) {
      request("worker_history", { revision: pendingTimeline.revision, before: pendingTimeline.cursor });
      return;
    }
    const { timelines, finish } = historyDownload;
    historyDownload = undefined;
    finish(timelines.map(({ revision, pages }) => ({ revision, events: pages?.flat() ?? null })));
  }

  function startHistoryDownload() {
    if (!historical || !historicalAdaptive || pending || !online) return;
    const language = reportLanguage;
    historyDownload = {
      timelines: [{
        revision: historical.revision,
        pages: [historicalAdaptive.history ?? []],
        cursor: historicalAdaptive.historyCursor,
      }],
      finish: ([{ revision, events }]) => downloadWorkerHistory(revision, events ?? [], language),
    };
    advanceHistoryDownload();
  }

  function startComparisonDownload() {
    if (!comparison || !historical || !evidenceComparison || !assessmentComparison || pending || !online) return;
    const baseline = comparison.revision;
    const revision = historical.revision;
    const reportText = sentinelWorkspaceText(reportLanguage);
    const sections = [
      `# ${reportText("Sentinel revision comparison")}`, "",
      reportText("Revisions {from} to {to}").replace("{from}", String(baseline)).replace("{to}", String(revision)), "",
      evidenceComparison.markdown(reportText),
      assessmentComparison.markdown(reportText),
    ];
    historyDownload = {
      timelines: [
        { revision: baseline, pages: comparison.workerHistory ? [comparison.workerHistory] : null, cursor: comparison.historyCursor },
        { revision, pages: historicalAdaptive?.history ? [historicalAdaptive.history] : null, cursor: historicalAdaptive?.historyCursor },
      ],
      finish: (timelines) => downloadReport("markdown", [
        ...sections, workerTimelinesMarkdown(timelines, reportText),
      ].join("\n"), revision, baseline),
    };
    advanceHistoryDownload();
  }

  function downloadWorkerHistory(revision: number, events: WorkerHistory, language: WorkspaceLanguage) {
    const reportText = sentinelWorkspaceText(language);
    const lines = [`# ${reportText("Sentinel worker history")}`, "", `${reportText("Evidence revision")} ${revision}`, ""];
    if (!events.length) lines.push(reportText("No recorded task transitions."));
    for (const event of events) {
      const fields = [
        event.at, event.taskId, event.kind, event.nodeId, language === "en" ? event.event : reportText(humanize(event.event)),
        event.attempt > 0 ? `${reportText("Attempt")} ${event.attempt}` : undefined,
      ];
      lines.push(`- ${fields.filter((field): field is string => !!field).map(comparisonText).join(" · ")}`);
      if (event.note) lines.push(`  - ${comparisonText(event.note)}`);
    }
    downloadReport("markdown", lines.join("\n") + "\n", revision, undefined, "worker-history");
  }

  function downloadReport(format: ExportFormat, content: string, revision?: number, baseline?: number, suffix?: string) {
    const mime =
      format === "csv"
        ? "text/csv;charset=utf-8"
        : format === "provenance" || format === "inventory" || format === "alerts" || format === "decisions" || format === "incidents"
        ? "application/json;charset=utf-8"
        : "text/markdown;charset=utf-8";
    const extension = format === "csv" ? "csv" : format === "markdown" ? "md" : "json";
    if (format === "inventory" || format === "alerts" || format === "decisions" || format === "incidents") suffix = format;
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement("a");
    link.href = url;
    const revisions = baseline === undefined
      ? `r${revision ?? assessment?.revision ?? ""}`
      : `r${baseline}-to-r${revision}`;
    link.download = `sentinel-${caseId}-${revisions}${suffix ? "-" + suffix : ""}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadGraphPath(path: SentinelPathExport) {
    const archive = sourceSnapshot;
    const revision = archive ? undefined : historical?.revision ?? assessment?.revision;
    const source = archive
      ? { caseId: archive.sourceCase, snapshotDigest: archive.digest }
      : { caseId, revision: revision ?? null };
    downloadReport("provenance", JSON.stringify({ source, path }, null, 2) + "\n",
      revision, undefined, "graph-path");
  }

  function dateLabel(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
  }

  function clearImportPreview() {
    importPreview = undefined;
    previewPayload = undefined;
  }

  function beginGoalEdit() {
    goal = currentGoal ?? "";
    editingGoal = true;
  }

  function focusInventoryAsset(asset: string) {
    const node = provenance?.nodes.find(({ id, sourceId, kind }) =>
      kind === "asset" && (sourceId ?? id) === asset
    );
    if (!node) {
      error = "The asset is unavailable in the reporting case.";
      return;
    }
    historical = null;
    focusDisplayedNode(node.id);
  }

  function openPeerFinding(citation: SentinelPeerFindingCitation) {
    request("shared_finding_source", {
      sourceCase: citation.sourceCaseId,
      asset: citation.sourceAssetId,
      finding: citation.sourceFindingId,
      snapshotDigest: citation.snapshotDigest,
    });
  }

  function openAliasSource(revision: number, trace: AliasTrace, sourceCase: string, snapshotDigest: string) {
    request("alias_source_snapshot", { revision, ...trace, sourceCase, snapshotDigest });
  }

  function openRelationshipSource(sourceCase: string, asset: string, snapshotDigest?: string) {
    if (snapshotDigest) request("source_snapshot", { sourceCase, asset, snapshotDigest });
    else {
      sourceSnapshot = undefined;
      openInventoryAsset(sourceCase, asset);
    }
  }

  function openInventoryAsset(id: string, asset: string) {
    if (!online || pending) return;
    error = "";
    if (id === caseId) focusInventoryAsset(asset);
    else {
      selectCase(id);
      pendingInventoryAsset = asset;
    }
  }

  function openSnapshotCitation(citation: SnapshotCitation) {
    if (!online || pending) return;
    sourceSnapshot = undefined;
    if (citation.caseId === caseId) {
      request("revision", { revision: citation.revision, focusId: citation.focusId });
    } else {
      selectCase(citation.caseId);
      pendingSnapshotCitation = citation;
    }
  }

  function selectCase(id: string) {
    if (id === caseId || pending) return;
    caseId = id;
    sourceSnapshot = undefined;
    assetDiscoveryProposals = undefined;
    topologySynced = false;
    topologyAuto = false;
    pendingInventoryAsset = undefined;
    pendingSnapshotCitation = undefined;
    minimumReply = requestSequence + 1;
    assessment = null;
    completingGoal = undefined;
    completionNote = "";
    adaptive = null;
    interactiveModelUsage = undefined;
    workerSettings = undefined;
    caseHints = [];
    caseHint = "";
    modelOutputSettings = undefined;
    notificationSettings = undefined;
    historicalNotificationReceipt = undefined;
    provenance = null;
    historical = null;
    historicalGraph = null;
    savedAlerts = undefined;
    upstreamAlertFeed = undefined;
    liveAlerts = undefined;
    liveAlertFeedAvailable = false;
    historicalAlertFeedAvailable = false;
    comparison = undefined;
    historicalAdaptive = null;
    revisions = [];
    historyOpen = false;
    selectedId = undefined;
    editingGoal = false;
    goal = "";
    incidentAlerts = undefined;
    incidentPage = undefined;
    decisionDetail = undefined;
    decisionPage = undefined;
    liveFindingReviews = [];
    historicalFindingReviews = [];
    liveIncidentReviews = [];
    historicalIncidentReviews = [];
    importCount = 0;
    clearImportPreview();
    error = "";
    exportOpen = false;
    loaded = false;
    queueSearch = "";
    queueFilter = "all";
    modelReviewFilter = "all";
    activitySearch = "";
    revisionScope = "all";
    activityLimit = 12;
    request("status");
  }

  function openCase(event: SubmitEvent) {
    event.preventDefault();
    const id = caseDraft.trim();
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)
    ) {
      caseError =
        "Use 1–48 lowercase letters or numbers. Hyphens are allowed between them.";
      return;
    }
    caseError = "";
    caseDraft = "";
    newCaseOpen = false;
    selectCase(id);
  }

  function submitGoal(event: SubmitEvent) {
    event.preventDefault();
    if (active) {
      if (editingGoal && goal.trim()) request("set_goal");
    } else {
      request("start");
    }
  }

  onMount(() => {
    const preference = localStorage.getItem("sentinel-workspace-language");
    if (isWorkspaceLanguage(preference)) workspaceLanguage = preference;
    onTopic("sentinel", receive);
    onTopic("shell", connection);
    request("status");
    const refreshVisibleCase = () => {
      if (!document.hidden) request("status");
    };
    const heartbeat = setInterval(refreshVisibleCase, 5000);
    document.addEventListener("visibilitychange", refreshVisibleCase);
    return () => {
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", refreshVisibleCase);
      clearTimeout(requestTimeout);
      offTopic("sentinel", receive);
      offTopic("shell", connection);
    };
  });
</script>

{#snippet modelUsage(usage: SentinelModelUsage, title = "Background model usage")}
  {@const numbers = new Intl.NumberFormat(workspaceLanguage)}
  <p>{t(title)} · {t("Calls")} {numbers.format(usage.calls)}
    · {t("Input tokens")} {numbers.format(usage.inputTokens)}
    · {t("Output tokens")} {numbers.format(usage.outputTokens)}</p>
{/snippet}

{#snippet aliasSourceLinks(mapping: { sources: readonly { caseId: string; snapshotDigest: string }[] } | undefined, revision: number, trace: AliasTrace)}
  {#each mapping?.sources ?? [] as source (source.caseId)}
    <button type="button" class="focus-link" disabled={!online || !!pending}
      onclick={() => openAliasSource(revision, trace, source.caseId, source.snapshotDigest)}>
      {t("Open alias source snapshot")} · {source.caseId}
    </button>
  {/each}
{/snippet}

{#snippet modelPlannerHistory(entries: NonNullable<SentinelAdaptive["modelPlannerHistory"]>, revision: number | undefined)}
  {#if entries.length}
    <details>
      <summary>{t("Model planning attempts")} ({entries.length})</summary>
      <ol>
        {#each entries as entry, index (`${entry.identity ?? index}:${entry.attempt}`)}
          <li>
            {t("Attempt")} {entry.attempt} · {t(humanize(entry.outcome))}
            · {t("Started")} {dateLabel(entry.started)}
            {#if entry.finished} · {t("Finished")} {dateLabel(entry.finished)}{/if}
            {#each planningInputs(entry) as input (input.kind)}
              {#each input.ids as id (id)}
                · <button type="button" class="focus-link" disabled={!online || !!pending}
                  onclick={() => openPlanningInput(input.kind, id)}>{t(input.label)} #{id}</button>
              {/each}
            {/each}
            {#if revision !== undefined && entry.identity}
              {#each entry.reads ?? [] as read, stepIndex}
                {@render aliasSourceLinks(read.aliasMapping, revision, { traceKind: "planner", traceId: entry.identity, stepIndex, attempt: entry.attempt })}
              {/each}
            {/if}
            {#if entry.incidentCandidateIds?.length}
              <details>
                <summary>{t("Incident inputs")} ({entry.incidentCandidateIds.length})</summary>
                <ol>
                  {#each entry.incidentCandidateIds as id (id)}
                    <li>
                      {#if revision !== undefined}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          aria-label={`${t("Inspect incident in graph")} ${id}`}
                          onclick={() => request("revision", { revision, focusIncidentId: id })}><code>{id}</code></button>
                      {:else}
                        <code>{id}</code>
                      {/if}
                    </li>
                  {/each}
                </ol>
              </details>
            {/if}
          </li>
        {/each}
      </ol>
    </details>
  {/if}
{/snippet}

{#snippet supportingAlertLinks(task: SentinelTask, revision: number)}
  {#each (task.evidenceIds ?? []).filter((id) => id.startsWith("case-alert:")) as alertId, index (alertId)}
    <button type="button" class="focus-link" disabled={!online || !!pending}
      onclick={() => request("revision", { revision, focusTaskAlert: { taskId: task.id, alertId } })}>
      {t("Inspect supporting alert")} {index + 1}
    </button>
  {/each}
{/snippet}

{#snippet modelReviewLink(taskId: string, revision: number)}
  <button type="button" class="focus-link" disabled={!online || !!pending}
    onclick={() => request("revision", { revision, focusId: `observation:adaptive:review:${taskId}` })}>
    {t("Inspect model review")}
  </button>
{/snippet}

{#snippet plannerObservationLink(task: SentinelTask, revision: number)}
  {@const checks = [...new Set(task.plannerRound?.upstreamCitations?.map(({ checkId }) => checkId) ?? (task.plannerRound?.upstreamCheckId ? [task.plannerRound.upstreamCheckId] : []))]}
  {#if checks.length}
    <span>{t("Upstream coverage matches")} · {checks.join(", ")}</span>
  {/if}
  {#if task.plannerRound && task.reviewedFrom}
    <button type="button" class="focus-link" disabled={!online || !!pending}
      onclick={() => request("revision", { revision, focusId: `observation:adaptive:${task.plannerRound?.sourceKind === "model_review" ? "review:" : ""}${task.reviewedFrom}` })}>
      {t(task.plannerRound.sourceKind === "model_review" ? "Inspect source model review" : "Inspect source observation")}
    </button>
  {/if}
  {#each task.plannerRound?.peerFindingCitations ?? [] as citation}
    <button type="button" class="focus-link" disabled={!online || !!pending}
      onclick={() => openPeerFinding(citation)}>
      {t("Inspect source finding")} · {citation.sourceCaseId} / {citation.sourceFindingId}
    </button>
  {/each}
{/snippet}

<div class="sentinel-screen">
  <div class="shell">
    <header class="title">
      <div>
        <h1><Icon name="sentinel" size={24} /> Sentinel</h1>
        <p>{t("Defensive assessment and evidence review")}</p>
      </div>
      <span
        class="status"
        data-status={online && paused
          ? "paused"
          : online && active
            ? "active"
            : "idle"}
      >
        <span class="dot" aria-hidden="true"></span>
        {!online
          ? t("Disconnected")
          : paused
            ? t("Assessment paused")
            : active
              ? t("Assessment active")
              : assessment?.completion
                ? t("Goal completed")
                : assessment
                  ? t("Assessment stopped")
                : t("Idle")}
      </span>
    </header>

    <section
      class="panel assessment-controls"
      aria-labelledby="assessment-heading"
    >
      <div class="assessment-heading-row">
        <div>
          <h2 id="assessment-heading">{t("Assessment")}</h2>
          {#if assessment}
            <p class="muted">
              {t("Revision")} {assessment.revision} · {t("Updated")} {dateLabel(
                assessment.updatedAt,
              )}
            </p>
          {:else if !loaded && online}
            <p class="muted">{t("Loading assessment…")}</p>
          {:else}
            <p class="muted">{t("No assessment has been started.")}</p>
          {/if}
        </div>
        <div class="case-controls">
          <label class="case-field">
            <span>{t("Workspace language")}</span>
            <select value={workspaceLanguage} onchange={(event) => {
              const selected = event.currentTarget.value;
              if (isWorkspaceLanguage(selected)) {
                workspaceLanguage = selected;
                localStorage.setItem("sentinel-workspace-language", selected);
              }
            }}>
              {#each workspaceLanguages as language (language.id)}
                <option value={language.id}>{language.label}</option>
              {/each}
            </select>
          </label>
          <label class="case-field">
            <span>{t("Assessment case")}</span>
            <select
              aria-label={t("Assessment case")}
              value={caseId}
              disabled={!!pending}
              onchange={(event) => selectCase(event.currentTarget.value)}
            >
              {#each cases as id (id)}
                <option value={id}>{id}</option>
              {/each}
            </select>
          </label>
          <button type="button" class="button" disabled={!online || !!pending}
            aria-expanded={caseOverview !== undefined}
            onclick={() => caseOverview ? caseOverview = undefined : request("case_overview")}>{t("Case overview")}</button>
          <button type="button" class="button" disabled={!online || !!pending}
            aria-expanded={containment !== undefined}
            onclick={() => containment !== undefined ? containment = undefined : request("containment_overview")}>{t("Web containment")}</button>
          <button type="button" class="button" disabled={!online || !!pending}
            aria-expanded={assetDiscoveryProposals !== undefined}
            onclick={() => assetDiscoveryProposals !== undefined ? assetDiscoveryProposals = undefined : request("asset_discovery_proposals")}>{t("Asset discovery proposals")}</button>
          <button type="button" class="button" disabled={!online || !!pending}
            aria-expanded={sharedInventory !== undefined}
            onclick={() => {
              if (sharedInventory) { sharedInventory = undefined; sharedAssetLinks = undefined; }
              else {
                requestedInventoryQuery = inventoryQuery;
                request("shared_inventory", { query: inventoryQuery, offset: 0 });
              }
            }}>{t("Shared asset inventory")}</button>
          <button
            type="button"
            class="button"
            aria-expanded={newCaseOpen}
            disabled={!online || !!pending}
            onclick={() => (newCaseOpen = !newCaseOpen)}
          >
            {t("New case")}
          </button>
        </div>
      </div>
      {#if containment !== undefined}
        <section class="panel" aria-label={t("Web containment")}>
          <h2>{t("Gateway web containment")}</h2>
          {#if containment}
            <form class="manual-assignment" onsubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              request("containment_block", {
                target: String(fields.get("target") ?? ""), reason: String(fields.get("reason") ?? ""),
                ttlSeconds: Number(fields.get("duration")),
              });
            }}>
              <label>{t("Hostname or IP address")} <input name="target" maxlength="253" required /></label>
              <label>{t("Operator reason")} <input name="reason" maxlength="512" required /></label>
              <label>{t("Duration in seconds")} <input name="duration" type="number" min="1" max="2592000" value="3600" required /></label>
              <button class="button" type="submit" disabled={!online || !!pending}>{t("Quarantine destination")}</button>
            </form>
            <p>{t("Active quarantines")} · {containment.total}</p>
            <ul>
              {#each containment.active as block (block.target)}
                <li>
                  <code>{block.target}</code> · {block.reason} · {t("Expires")} {dateLabel(block.expiresAt)}
                  <button type="button" class="focus-link" disabled={!online || !!pending}
                    onclick={() => releaseBlock = block}>{t("Release quarantine")}</button>
                </li>
              {/each}
            </ul>
            {#if releaseBlock}
              {@const target = releaseBlock}
              <form class="manual-assignment" onsubmit={(event) => {
                event.preventDefault();
                const fields = new FormData(event.currentTarget);
                request("containment_release", {
                  target: target.target, expectedRevision: target.revision ?? undefined,
                  reason: String(fields.get("reason") ?? ""),
                });
              }}>
                <p>{t("Release quarantine for {target}", { target: target.target })}</p>
                <label>{t("Release reason")} <input name="reason" maxlength="512" required /></label>
                <button class="button" type="submit" disabled={!online || !!pending}>{t("Confirm release")}</button>
                <button class="button" type="button" onclick={() => releaseBlock = undefined}>{t("Cancel")}</button>
              </form>
            {/if}
            <details>
              <summary>{t("Recent containment changes")}</summary>
              <ul>
                {#each containment.audit as entry}
                  <li>{t(entry.action === "block" ? "Blocked" : "Released")} · <code>{entry.target}</code> · {entry.reason} · {dateLabel(entry.at)}</li>
                {/each}
              </ul>
            </details>
          {:else}
            <p>{t("Web containment is disabled.")}</p>
          {/if}
        </section>
      {/if}
      {#if assetDiscoveryProposals !== undefined}
        <section class="panel shared-assets" aria-label={t("Asset discovery proposals")}>
          <header class="panel-header">
            <h2>{t("Asset discovery proposals")}</h2>
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => request("asset_discovery_proposals")}>{t("Refresh")}</button>
          </header>
          {#if assetDiscoveryProposals.length}
            <ul>
              {#each assetDiscoveryProposals as proposal (proposal.id)}
                {@const claim = proposal.claim}
                <li>
                  <p><strong>{t(humanize(proposal.status))}</strong> · <code>{claim.assetId}</code>
                    {#if claim.kind === "alias"}
                      · {t("Aliases")} <code>{claim.alias}</code>
                    {:else if claim.kind === "relationship"}
                      · {t(humanize(claim.relation))} → <code>{claim.to}</code>
                    {/if}
                  </p>
                  <p>{t("Evidence")} <code>{claim.evidenceId}</code> · {t("Revision")} {proposal.evidenceRevision} · {t("Snapshot digest")} <code>{proposal.sourceDigest}</code></p>
                  {#if proposal.status === "pending"}
                    <button type="button" class="button" disabled={!online || !!pending}
                      onclick={() => request("asset_discovery_decision", { id: proposal.id, version: proposal.version, action: "approve" })}>{t("Approve")}</button>
                  {/if}
                  {#if proposal.status !== "withdrawn"}
                    <button type="button" class="button" disabled={!online || !!pending}
                      onclick={() => request("asset_discovery_decision", { id: proposal.id, version: proposal.version, action: "withdraw" })}>{t("Withdraw")}</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p>{t("No asset discovery proposals.")}</p>
          {/if}
        </section>
      {/if}
      {#if sharedInventory}
        <section class="panel shared-assets" aria-label={t("Shared asset inventory")}>
          <form class="manual-assignment" onsubmit={(event) => {
            event.preventDefault();
            requestedInventoryQuery = inventoryQuery;
            request("shared_inventory", { query: requestedInventoryQuery, offset: 0 });
          }}>
            <label><span>{t("Find shared assets")}</span>
              <input bind:value={inventoryQuery} type="search" maxlength="256" disabled={!online || !!pending} />
            </label>
            <button type="submit" class="button" disabled={!online || !!pending}>{t("Search inventory")}</button>
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => request("sync_shared_topology")}>{t("Sync relationships into this case")}</button>
            <label class="topology-auto">
              <input type="checkbox" checked={topologyAuto} disabled={!online || !!pending}
                onchange={(event) => {
                  const enabled = event.currentTarget.checked;
                  event.currentTarget.checked = topologyAuto;
                  request("set_topology_auto", { enabled });
                }} />
              {t("Automatically refresh case relationships")}
            </label>
          </form>
            <button type="button" class="button" disabled={!online || !!pending}
                onclick={() => request("source_snapshot_audit")}>{t("Audit source archives")}</button>
              {#if sourceSnapshotAudit}
                <div aria-live="polite">
                  <p>{t("Archived snapshots")} {sourceSnapshotAudit.archivedCount} · {t("Referenced snapshots")} {sourceSnapshotAudit.referencedCount}</p>
                  {#if sourceSnapshotAudit.unavailableCases.length}
                    <p>{t("Cases unavailable for archive audit")} · {sourceSnapshotAudit.unavailableCases.join(", ")}</p>
                  {/if}
                  <p>{t("Missing snapshots")} · {sourceSnapshotAudit.missing.length}</p>
                  {#if sourceSnapshotAudit.missing.length}
                    <ul>{#each sourceSnapshotAudit.missing as id (id)}<li>{id}</li>{/each}</ul>
                  {/if}
                  {#if sourceSnapshotAudit.unreadableSnapshots.length}
                    <p>{t("Unreadable source snapshots")} · {sourceSnapshotAudit.unreadableSnapshots.length}</p>
                    <ul>{#each sourceSnapshotAudit.unreadableSnapshots as id (id)}<li>{id}</li>{/each}</ul>
                  {/if}
                  <p>{t("Unreferenced snapshots")} · {sourceSnapshotAudit.candidates.length}</p>
                  {#if sourceSnapshotAudit.candidates.length}
                    <ul>{#each sourceSnapshotAudit.candidates as id (id)}
                      <li>{id} <button type="button" class="focus-link" disabled={!online || !!pending}
                        onclick={() => request("quarantine_source_snapshot", { sourceSnapshotId: id })}>{t("Quarantine snapshot")}</button></li>
                    {/each}</ul>
                  {/if}
                  {#if sourceSnapshotAudit.quarantined.length}
                    <p>{t("Quarantined snapshots")} · {sourceSnapshotAudit.quarantined.length}</p>
                    <ul>{#each sourceSnapshotAudit.quarantined as id (id)}
                      <li>{id} <button type="button" class="focus-link" disabled={!online || !!pending}
                        onclick={() => request("restore_source_snapshot", { sourceSnapshotId: id })}>{t("Restore snapshot")}</button></li>
                    {/each}</ul>
                  {/if}
                </div>
              {/if}
          {#if topologySynced}<p role="status">{t("Shared relationships synchronized.")}</p>{/if}
          {#if sharedInventory.unavailable.length}
            <p>{t("Unavailable inventory sources")} · {sharedInventory.unavailable.join(", ")}</p>
          {/if}
          {#if sharedInventory.assets.length}
            <ul>
              {#each sharedInventory.assets as asset (asset.id)}
                <li>
                  <details>
                    <summary>{asset.id} · {asset.sources.length} {t("Case sources")}</summary>
                    <ul>
                      {#each asset.sources as source (source.caseId)}
                        <li><button type="button" class="focus-link" disabled={!!pending}
                          onclick={() => openInventoryAsset(source.caseId, source.assetId ?? asset.id)}>
                          {source.caseId}
                        </button> · {source.label}{#if source.assetId} · {source.assetId}{/if}
                          {#if source.aliases?.length} · {t("Aliases")} {source.aliases.join(", ")}{/if}
                        </li>
                      {/each}
                    </ul>
                    <button type="button" class="button" disabled={!online || !!pending}
                      onclick={() => request("shared_asset_links", { asset: asset.id, sourceCase: asset.sources[0].caseId, offset: 0 })}>
                      {t("Show shared relationships")}
                    </button>
                    {#if sharedAssetLinks?.asset === asset.id}
                      {@const relationshipPage = sharedAssetLinks}
                      {#if relationshipPage.links.length}
                        <ul aria-label={t("Shared relationships")}>
                          {#each relationshipPage.links as link (JSON.stringify([link.from, link.relation, link.to]))}
                            <li>
                              {link.from} → {t(humanize(link.relation))} → {link.to}
                              <ul>
                                {#each link.caseIds as source (source)}
                                  {@const original = link.remapped?.find(({ caseId }) => caseId === source)}
                                  {@const originalAsset = (link.from === asset.id ? original?.from : original?.to) ?? asset.id}
                                  <li><button type="button" class="focus-link" disabled={!!pending}
                                    onclick={() => openInventoryAsset(source, originalAsset)}>{source}</button></li>
                                {/each}
                              </ul>
                            </li>
                          {/each}
                        </ul>
                      {:else}
                        <p>{t("No shared asset relationships.")}</p>
                      {/if}
                      {#if relationshipPage.findings?.length}
                        <p>{t("Reported findings")} · {relationshipPage.totalFindings}</p>
                        <ul aria-label={t("Reported findings")}>
                          {#each relationshipPage.findings as { caseId, assetId, snapshotDigest, finding } (JSON.stringify([caseId, finding.id]))}
                            <li>
                              <button type="button" class="focus-link" disabled={!online || !!pending}
                                onclick={() => request("shared_finding_source", { sourceCase: caseId, asset: assetId, finding: finding.id, snapshotDigest })}>{finding.label}</button>{finding.severity ? ` · ${t(humanize(finding.severity))}` : ""}
                              <button type="button" class="focus-link" disabled={!!pending}
                                onclick={() => openInventoryAsset(caseId, assetId)}>{caseId}</button>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                      {#if relationshipPage.unavailable.length}
                        <p>{t("Unavailable inventory sources")} · {relationshipPage.unavailable.join(", ")}</p>
                      {/if}
                      {#if relationshipPage.offset > 0}
                        <button type="button" class="button" disabled={!online || !!pending}
                          onclick={() => request("shared_asset_links", { asset: asset.id, sourceCase: asset.sources[0].caseId, offset: Math.max(0, relationshipPage.offset - 20) })}>{t("Previous page")}</button>
                      {/if}
                      {#if relationshipPage.nextOffset !== null}
                        {@const offset = relationshipPage.nextOffset}
                        <button type="button" class="button" disabled={!online || !!pending}
                          onclick={() => request("shared_asset_links", { asset: asset.id, sourceCase: asset.sources[0].caseId, offset })}>{t("Next page")}</button>
                      {/if}
                    {/if}
                  </details>
                </li>
              {/each}
            </ul>
          {:else}
            <p>{t("No matching assets.")}</p>
          {/if}
          {#if sharedInventory.offset > 0}
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => request("shared_inventory", { query: requestedInventoryQuery, offset: Math.max(0, (sharedInventory?.offset ?? 0) - 20) })}>{t("Previous page")}</button>
          {/if}
          {#if sharedInventory.nextOffset !== null}
            {@const next = sharedInventory.nextOffset}
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => request("shared_inventory", { query: requestedInventoryQuery, offset: next })}>{t("Next page")}</button>
          {/if}
        </section>
      {/if}
      {#if caseOverview}
        <section class="panel" aria-label={t("Case overview")}>
          <button type="button" class="button" disabled={!online || !!pending}
            onclick={() => request("case_overview")}>{t("Refresh case overview")}</button>
          <ul>
            {#each caseOverview as candidate (candidate.id)}
              <li>
                <button type="button" class="focus-link"
                  disabled={candidate.id === caseId || !!pending || candidate.status === "unavailable"}
                  onclick={() => selectCase(candidate.id)}>{candidate.id}</button>
                · {t(candidate.status === "running" ? "Running" : candidate.status === "paused" ? "Paused" : candidate.status === "stopped" ? "Stopped" : candidate.status === "completed" ? "Goal completed" : candidate.status === "not_started" ? "Not started" : "Unavailable")}{candidate.coordinator === "waiting"
                  ? ` · ${t("Waiting for coordinator")}`
                  : candidate.coordinator === "pending" ? ` · ${t("Pending discovery")}`
                  : candidate.coordinator === "scheduled" ? ` · ${t("Coordinator assigned")}` : ""}{candidate.revision !== undefined ? ` · ${t("Revision")} ${candidate.revision}` : ""}
                {#if candidate.pendingInputs}
                  · {t("Changed inputs at last check")}
                {/if}
                {#if candidate.id !== caseId && (candidate.status === "running" || candidate.status === "paused")}
                  {@const action = candidate.status === "running" ? "pause" : "resume"}
                  <button type="button" class="focus-link" disabled={!online || !!pending}
                    aria-label={`${t(action === "pause" ? "Pause" : "Resume")} ${candidate.id}`}
                    onclick={() => request("case_lifecycle", { targetCase: candidate.id, action })}>
                    {t(action === "pause" ? "Pause" : "Resume")}
                  </button>
                  <button type="button" class="focus-link" disabled={!online || !!pending}
                    aria-label={`${t("Stop")} ${candidate.id}`}
                    onclick={() => request("case_lifecycle", { targetCase: candidate.id, action: "stop" })}>
                    {t("Stop")}
                  </button>
                {:else if candidate.status === "stopped"}
                  <button type="button" class="focus-link" disabled={!online || !!pending}
                    aria-label={`${t("Continue")} ${candidate.id}`}
                    onclick={() => request("case_lifecycle", { targetCase: candidate.id, action: "continue" })}>
                    {t("Continue")}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if newCaseOpen}
        <form class="case-form" onsubmit={openCase}>
          <label class="case-field">
            <span>{t("Case ID")}</span>
            <input
              bind:value={caseDraft}
              maxlength={48}
              placeholder="e.g. payroll-review"
              required
            />
          </label>
          <button type="submit" class="button" disabled={!online || !!pending}>
            {t("Open case")}
          </button>
          {#if caseError}<p class="error" role="alert">{t(caseError)}</p>{/if}
        </form>
      {/if}
      {#if notificationSettings?.gatewayEnabled || notificationSettings?.latest}
        <label>
          {t("Incident notifications")}
          <select
            disabled={!notificationSettings?.gatewayEnabled || !online || !!pending}
            value={notificationSettings?.enabled === null ? "inherit" : notificationSettings?.enabled ? "on" : "off"}
            onchange={(event) => {
              const value = event.currentTarget.value;
              request("incident_notifications", { enabled: value === "inherit" ? null : value === "on" });
            }}>
            <option value="inherit">{t("Use gateway default")}</option>
            <option value="on">{t("Enabled")}</option>
            <option value="off">{t("Disabled")}</option>
          </select>
        </label>
        {#if notificationSettings?.latest}
          {@const delivery = notificationSettings.latest}
          <p>{t("Latest incident notification")} · {t("Revision")} {delivery.revision} · {t(notificationLabels[delivery.state] ?? delivery.state)}</p>
        {/if}
      {/if}
      {#if assessment?.completion}
        <p>{t("Completion note")} · {assessment.completion.note}</p>
      {/if}
      {#if completingGoal && active}
        <form onsubmit={(event) => {
          event.preventDefault();
          if (completingGoal) {
            const { proof, revision, expectedGoal } = completingGoal;
            request("complete_goal", {
              revision, expectedGoal, note: completionNote,
              ...(proof && { runId: proof.runId, goalProofDigest: proof.digest }),
            });
          }
        }}>
          <p>{t("Complete the goal for revision {revision}", { revision: completingGoal.revision })}</p>
          {#if completingGoal.proof}
            <ul>
              {#each completingGoal.proof.criteria as criterion (criterion.id)}
                <li>{criterion.description}
                  <ul>
                    {#each criterion.evidence as evidence}
                      <li>{evidence.source} · {evidence.reference} · {evidence.detail}</li>
                    {/each}
                  </ul>
                </li>
              {/each}
            </ul>
          {/if}
          <label>
            {t("Completion note")}
            <textarea bind:value={completionNote} required maxlength={1000}></textarea>
          </label>
          <button type="submit" class="button" disabled={!online || !!pending || !completionNote.trim()}>{t("Confirm goal completion")}</button>
          <button type="button" class="button" onclick={() => completingGoal = undefined}>{t("Cancel")}</button>
        </form>
      {/if}
      <form onsubmit={submitGoal}>
        {#if !active || editingGoal}
          <label class="goal">
            <span>{t("Assessment goal")}</span>
            <input
              bind:value={goal}
              maxlength={500}
              placeholder="e.g. Review mitigation gaps for the payments service"
              disabled={!!pending}
            />
          </label>
        {:else if currentGoal}
          <div class="goal goal-display">
            <span>{t("Assessment goal")}</span>
            <p>{currentGoal}</p>
          </div>
        {/if}
        <div class="actions">
          {#if assessment && !active}
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => request("case_lifecycle", { targetCase: caseId, action: "continue" })}>
              <Icon name="play" size={14} /> {t("Continue assessment")}
            </button>
          {/if}
          <button
            type="button"
            class="button"
            disabled={!online || !!pending}
            onclick={() => request("refresh")}
          >
            <Icon name="refresh" size={14} />
            {pending === "refresh" ? t("Refreshing…") : t("Refresh")}
          </button>
          {#if active}
            {#if editingGoal}
              <button
                type="button"
                class="button"
                disabled={!!pending}
                onclick={() => (editingGoal = false)}
              >
                {t("Cancel edit")}
              </button>
              <button
                type="submit"
                class="button primary"
                disabled={!online || !!pending || !goal.trim()}
              >
                {pending === "set_goal" ? t("Saving…") : t("Save goal")}
              </button>
            {:else}
              <button
                type="button"
                class="button"
                disabled={!online || !!pending}
                onclick={beginGoalEdit}
              >
                {t("Edit goal")}
              </button>
            {/if}
            <button
              type="button"
              class="button"
              disabled={!online || !!pending}
              onclick={() => request(paused ? "resume" : "pause")}
            >
              <Icon name={paused ? "play" : "pause"} size={14} />
              {pending === "pause"
                ? t("Pausing…")
                : pending === "resume"
                  ? t("Resuming…")
                  : paused
                    ? t("Resume")
                    : t("Pause")}
            </button>
            {#if assessment?.result}
              <button type="button" class="button" disabled={!online || !!pending || (goalProof !== null && (goalProof.policy !== "operator" || goalProof.status !== "awaiting_confirmation"))}
                onclick={() => {
                  if (assessment) completingGoal = { revision: assessment.revision, expectedGoal: assessment.plan?.goal ?? null, proof: goalProof };
                }}>{t("Record goal completion")}</button>
            {/if}
            <button
              type="button"
              class="button stop"
              disabled={!online || !!pending}
              onclick={() => request("stop")}
            >
              <Icon name="stop" size={14} />
              {pending === "stop" ? t("Stopping…") : t("Stop assessment")}
            </button>
          {:else}
            <button
              type="submit"
              class="button primary"
              disabled={!online || !!pending}
            >
              <Icon name="play" size={14} />
              {pending === "start" ? t("Starting…") : t("Start assessment")}
            </button>
          {/if}
          {#if assessment?.result}
            <div class="export-menu">
              <button
                type="button"
                class="button"
                disabled={!online || !!pending}
                aria-expanded={exportOpen}
                onclick={() => (exportOpen = !exportOpen)}
              >
                {t(pending === "export" ? "Exporting…" : "Export")}
              </button>
              {#if exportOpen}
                <div class="export-options">
                  <label>
                    {t("Markdown report language")}
                    <select bind:value={reportLanguage}>
                      <option value="en">English</option>
                      <option value="es">Español</option>
                      <option value="ko">한국어</option>
                      <option value="zh">简体中文</option>
                      <option value="ja">日本語</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    class="button"
                    disabled={!online || !!pending}
                    onclick={() => request("export", { format: "csv", revision: historical?.revision })}
                  >
                    CSV
                  </button>
                  <button
                    type="button"
                    class="button"
                    disabled={!online || !!pending}
                    onclick={() => request("export", { format: "markdown", revision: historical?.revision, language: reportLanguage })}
                  >
                    Markdown
                  </button>
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => request("export", { format: "provenance", revision: historical?.revision })}>
                    {t("Provenance JSON")}
                  </button>
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => request("export", { format: "inventory", revision: historical?.revision })}>
                    {t("Inventory JSON")}
                  </button>
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => request("export", { format: "decisions", revision: historical?.revision })}>
                    {t("Decision history JSON")}
                  </button>
                  {#if historical ? historicalAlertFeedAvailable : liveAlertFeedAvailable}
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => request("export", { format: "alerts", revision: historical?.revision })}>
                    {t("Alerts JSON")}
                  </button>
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => request("export", { format: "incidents", revision: historical?.revision })}>
                    {t("Incidents JSON")}
                  </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </form>
      {#if assessment}
        <div class="manual-assignment">
          <button type="button" class="button" disabled={!online || !!pending}
            onclick={() => request("history")}>{t("Evidence revisions")}</button>
          {#if historyOpen}
            <label>
              <span>{t("Revision to inspect")}</span>
              <select value={historical?.revision ?? ""} disabled={!!pending} onchange={(event) => {
                const revision = event.currentTarget.value;
                if (revision) request("revision", { revision: Number(revision) });
                else { historical = null; selectedId = undefined; }
              }}>
                <option value="">{t("Live case")}</option>
                {#each revisions as item (item.revision)}
                  <option value={item.revision}>{t("Revision")} {item.revision} · {dateLabel(item.updatedAt)}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/if}
      {#key caseId}
        <InventoryImport
          language={workspaceLanguage}
          disabled={!online || !!pending}
          imported={importCount}
          {paused}
          onImport={(payload) => request("import", payload)}
          preview={importPreview}
          onPreview={(payload) => {
            clearImportPreview();
            previewPayload = payload;
            request("preview_import", payload);
          }}
          onApplyPreview={() => previewPayload && importPreview && request("import", {
            ...previewPayload, inventoryDigest: importPreview.inventoryDigest,
          })}
          onClearPreview={clearImportPreview}
        />
      {/key}
      {#if decisionDetail}
        {@const detail = decisionDetail}
        <section class="panel" aria-label={t(detail.kind === "hint" ? "Case hint" : "Analyst decision")} bind:this={decisionPanel} tabindex="-1">
          <header class="panel-header">
            <h2>{t(detail.kind === "hint" ? "Case hint" : detail.kind === "finding" ? "Finding decision" : "Incident decision")} #{detail.id}</h2>
            <button type="button" class="button" onclick={() => decisionDetail = undefined}>{t(detail.kind === "hint" ? "Close hint" : "Close decision")}</button>
          </header>
          <p>
            {#if detail.kind !== "hint"}<code>{detail.subjectId}</code> · {t(humanize(detail.disposition))} · {/if}
            {#if detail.revision !== null}{t("Revision")} {detail.revision} · {/if}
            <time datetime={detail.at}>{dateLabel(detail.at)}</time>
          </p>
          <p>{detail.note}</p>
          {#if detail.retained && detail.revision !== null}
            {@const revision = detail.revision}
            <button type="button" class="button" disabled={!online || !!pending}
              onclick={() => {
                if (detail.kind === "incident") {
                  request("revision", { revision, focusIncidentId: detail.subjectId });
                } else {
                  const focusId = detail.kind === "finding" ? `finding:${detail.subjectId}` : undefined;
                  request("revision", { revision, focusId });
                }
              }}>{t("Inspect original revision")}</button>
          {/if}
        </section>
      {/if}
      {#if error}<p class="error" role="alert">{t(error)}</p>{/if}
    </section>

    <div class="workspace">
      {#key caseId}
        <div class="operations">
          {#if historical}
            <section class="panel" aria-label={t("Historical evidence revision")}>
              <h2>{t("Evidence revision")} {historical.revision}</h2>
              <p>{t("Saved {date}. The task queue shows the live case.", { date: dateLabel(historical.updatedAt) })}</p>
              {#if savedAlerts && savedAlerts.revision === historical.revision}
                {#key historical.revision}
                  <SavedAlerts language={workspaceLanguage} alerts={savedAlerts.alerts} disabled={!online || !!pending}
                    onOpen={(focusAlertKey) => historical && request("revision", { revision: historical.revision, baseline: comparison?.revision, focusAlertKey })} />
                {/key}
              {:else if historicalAlertFeedAvailable}
                <button type="button" class="button" disabled={!online || !!pending}
                  onclick={() => historical && request("revision_alerts", { revision: historical.revision })}>{t("Browse saved alerts")}</button>
              {/if}
              <label>
                <span>{t("Compare with earlier revision")}</span>
                <select value={comparison?.revision ?? ""} disabled={!online || !!pending} onchange={(event) => {
                  const baseline = Number(event.currentTarget.value);
                  if (baseline && historical) request("revision", { revision: historical.revision, baseline });
                  else comparison = undefined;
                }}>
                  <option value="">{t("Choose revision")}</option>
                  {#each revisions.filter((item) => item.revision < (historical?.revision ?? 0)) as item (item.revision)}
                    <option value={item.revision}>{t("Revision")} {item.revision} · {dateLabel(item.updatedAt)}</option>
                  {/each}
                </select>
              </label>
              {#if comparison}
                <button type="button" class="button" disabled={!online || !!pending}
                  onclick={startComparisonDownload}>{t("Download comparison")}</button>
                <EvidenceComparison language={workspaceLanguage} bind:this={evidenceComparison} before={comparison.graph}
                  after={historical.result?.sharedGraph.snapshot ?? null}
                  beforeReviews={comparison.findingReviews ?? []} afterReviews={historicalFindingReviews}
                  baseline={comparison.revision} revision={historical.revision} />
                <AssessmentComparison language={workspaceLanguage} bind:this={assessmentComparison}
                  onPlanningInput={openPlanningInput}
                  earlierObservations={comparison.observations ?? []}
                  earlierAlerts={comparison.fullAlerts?.earlier ?? (comparison.alertNodes ?? []).flatMap((node) => node.alert ? [node.alert] : [])}
                  laterAlerts={comparison.fullAlerts?.later ?? (historicalGraph?.nodes ?? []).flatMap((node) => node.alert ? [node.alert] : [])}
                  fullAlertFeeds={comparison.fullAlerts !== undefined}
                  earlierIncidents={comparison.incidentNodes ?? []}
                  laterIncidents={historicalGraph?.nodes ?? []}
                  earlierIncidentReviews={comparison.incidentReviews ?? []}
                  laterIncidentReviews={historicalIncidentReviews}
                  earlierAlertNodes={comparison.alertNodes ?? []}
                  laterAlertNodes={historicalGraph?.nodes ?? []}
                  onEarlierAlert={(id) => comparison && request("revision", { revision: comparison.revision, focusId: id })}
                  onLaterAlert={focusDisplayedNode}
                  onEarlierSavedAlert={(key) => comparison && request("revision", { revision: comparison.revision, focusAlertKey: key })}
                  onLaterSavedAlert={(key) => historical && request("revision", { revision: historical.revision, baseline: comparison?.revision, focusAlertKey: key })}
                  laterObservations={historical.result?.sharedGraph.observations ?? []}
                  earlierTasks={comparison.adaptiveTasks ?? null}
                  earlierGoal={comparison.adaptiveGoal ?? null}
                  laterGoal={historicalAdaptive?.goal?.label ?? null}
                  earlierPlanner={comparison.modelPlanner ?? null}
                  laterPlanner={historicalAdaptive?.modelPlanner ?? null}
                  earlierPlannerHistory={comparison.modelPlannerHistory ?? []}
                  laterPlannerHistory={historicalAdaptive?.modelPlannerHistory ?? []}
                  laterTasks={historicalAdaptive?.tasks ?? null}
                  earlierHistory={comparison.workerHistory ?? null}
                  laterHistory={historicalAdaptive?.history ?? null}
                  baseline={comparison.revision} revision={historical.revision}
                  earlierCursor={comparison.historyCursor}
                  laterCursor={historicalAdaptive?.historyCursor}
                  pagingDisabled={!online || !!pending}
                  onOlder={(revision, before) => request("worker_history", { revision, before })} />
              {/if}
              {#if historicalAdaptive}
                <h3>{t("Saved adaptive plan")}</h3>
                {#if historicalAdaptive.modelUsage}{@render modelUsage(historicalAdaptive.modelUsage)}{/if}
                {@render modelPlannerHistory(historicalAdaptive.modelPlannerHistory ?? [], historical.revision)}
                {#if historicalAdaptive.modelPlanner}
                  <p>{t("Model planner")} · {t(humanize(historicalAdaptive.modelPlanner.status))} · {t("Attempt")} {historicalAdaptive.modelPlanner.attempt}</p>
                {/if}
                <button type="button" class="button" disabled={!online || !!pending}
                  onclick={startHistoryDownload}>
                  {t("Download worker history")}
                </button>
                <p>{historicalAdaptive.goal?.label}</p>
                <ul>
                  {#each (historicalAdaptive.tasks ?? []) as task (task.id)}
                    {@const review = savedModelReviewStates.get(task.id)}
                    <li id={`sentinel-historical-task-${task.id}`} tabindex="-1">
                      {task.kind ? t(taskNames[task.kind] ?? humanize(task.kind)) : task.id} · {task.nodeId} · {t(humanize(task.status))}
                      {#if review}
                        <p class="muted">{t("Model review")} · {t(humanize(review.status))}{review.attempts ? ` · ${t("Attempt")} ${review.attempts}` : ""}</p>
                        {#if savedReviewNotes.has(task.id)}
                          {@render modelReviewLink(task.id, historical.revision)}
                        {:else if review.status === "completed"}
                          <p class="muted">{t("Saved review text unavailable")}</p>
                        {/if}
                      {/if}
                      {@render supportingAlertLinks(task, historical.revision)}
                      {@render plannerObservationLink(task, historical.revision)}
                    </li>
                  {/each}
                </ul>
                {#if historicalAdaptive.history?.length}
                  <details>
                    <summary>{t("Task transitions")} ({historicalAdaptive.history.length})</summary>
                    <ol>
                      {#each historicalAdaptive.history as item}
                        {@const priorTask = carriedTask(item.event, item.note)}
                        {@const archivedTarget = item.event === "assignment_unavailable"
                          ? historicalGraph?.nodes.find((node) => node.origin === "imported" && node.sourceId === item.nodeId)
                          : undefined}
                        <li>
                          <time datetime={item.at}>{dateLabel(item.at)}</time>
                          · {item.kind ? t(taskNames[item.kind] ?? humanize(item.kind)) : item.taskId}
                          {item.nodeId ? ` · ${item.nodeId}` : ""}
                          · {t(humanize(item.event))}{item.attempt > 0 ? ` · ${t("Attempt")} ${item.attempt}` : ""}
                          {#if item.note}<p>{item.note}</p>{/if}
                          {#if archivedTarget}
                            <button type="button" class="focus-link" onclick={() => focusDisplayedNode(archivedTarget.id)}>
                              {t("Inspect prior target")} · {archivedTarget.label}
                            </button>
                          {/if}
                          {#if priorTask && historical}
                            {@const revision = historical.revision}
                            {#each item.removedEvidenceIds ?? [] as id (id)}
                              <button type="button" class="focus-link" disabled={!online || !!pending}
                                onclick={() => openRemovedTaskEvidence(revision, priorTask, id)}>
                                {t("Inspect removed evidence")} · {id}
                              </button>
                            {/each}
                          {/if}
                          {#if priorTask}
                            <button type="button" class="focus-link" disabled={!online || !!pending}
                              onclick={() => historical && request("revision", { revision: historical.revision, priorTask })}>
                              {t("Open prior investigation")}
                            </button>
                          {/if}
                        </li>
                      {/each}
                    </ol>
                    {#if historicalAdaptive.historyCursor}
                      <button type="button" class="button" disabled={!online || !!pending}
                        onclick={() => {
                          const before = historicalAdaptive?.historyCursor;
                          if (before && historical) request("worker_history", { revision: historical.revision, before });
                        }}>{t("Load older transitions")}</button>
                    {/if}
                  </details>
                {/if}
                {#each (historicalAdaptive.notes ?? []) as note}
                  <details>
                    <summary>{t("Worker activity")} · {dateLabel(note.at)}</summary>
                    <p>{note.note}</p>
                    {#if note.steps?.length}
                      <ul>
                        {#each note.steps as step}
                          <li>{step.tool}{step.target ? ` · ${step.target}` : ""} · {t(step.outcome === "returned" ? "Returned" : "Error").toLocaleLowerCase(workspaceLanguage)}</li>
                        {/each}
                      </ul>
                    {/if}
                  </details>
                {/each}
              {/if}
              {#if historicalNotificationReceipt}
                <p>{t("Incident notifications")} · {t(notificationLabels[historicalNotificationReceipt.state] ?? historicalNotificationReceipt.state)}</p>
              {/if}
              {#if historical.completion}
                <p>{t("Goal completed")} · {historical.completion.goal ?? ""}</p>
                <p>{t("Completion note")} · {historical.completion.note}</p>
              {/if}
              {#each historical.reviews as review (review.task)}
                <details id={`sentinel-assessment-review-${review.task}`} tabindex="-1">
                  <summary>{t(taskNames[review.task] ?? humanize(review.task))} · {t("Model review")}</summary>
                  <p>{review.analysis}</p>
                  {#if review.steps?.length}
                    <ul>
                      {#each review.steps as step, stepIndex}
                        <li>{step.tool}{step.target ? ` · ${step.target}` : ""} · {t(step.outcome === "returned" ? "Returned" : "Error").toLocaleLowerCase(workspaceLanguage)}
                          {@render aliasSourceLinks(step.aliasMapping, historical.revision, { traceKind: "assessment", traceId: review.task, stepIndex })}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </details>
              {/each}
            </section>
          {/if}
          {#if !historical && assessment && (liveAlertFeedAvailable || liveAlerts)}
            <section class="panel" aria-label={t("Live alert feed")}>
              {#if liveAlerts}
                <p>{t("Alert feed saved with revision {revision}.", { revision: liveAlerts.revision })}</p>
                {#key liveAlerts.revision}
                  <SavedAlerts language={workspaceLanguage} alerts={liveAlerts.alerts} disabled={!online || !!pending}
                    onOpen={(focusAlertKey) => liveAlerts && request("revision", { revision: liveAlerts.revision, focusAlertKey })} />
                {/key}
              {/if}
              {#if liveAlertFeedAvailable && (!liveAlerts || liveAlerts.revision !== assessment.revision)}
                <button type="button" class="button" disabled={!online || !!pending}
                  onclick={() => assessment && request("revision_alerts", { revision: assessment.revision })}>
                  {t(liveAlerts ? "Load latest alert feed" : "Browse live alerts")}
                </button>
              {/if}
            </section>
          {/if}
          {#if (incidentCandidates.length || shownIncidentPage) && !sourceSnapshot}
            <section class="panel" aria-label={t("Incident candidates")}>
              <header class="panel-header"><h2>{t("Incident candidates")}</h2></header>
              {#if displayedRevision !== undefined && (historical ? historicalAlertFeedAvailable : liveAlertFeedAvailable)}
                {@const revision = displayedRevision}
                {#if shownIncidentPage}
                  {@const page = shownIncidentPage}
                  <p>{page.incidents.length ? `${page.offset + 1}–${page.offset + page.incidents.length} / ${page.total}` : `0 / ${page.total}`}</p>
                  <button type="button" class="focus-link" onclick={() => incidentPage = undefined}>{t("Show graph sample")}</button>
                  {#if page.offset > 0}
                    <button type="button" class="focus-link" disabled={!online || !!pending}
                      onclick={() => request("incident_page", { revision, offset: Math.max(0, page.offset - 10) })}>{t("Previous page")}</button>
                  {/if}
                  {#if page.nextOffset !== null}
                    {@const offset = page.nextOffset}
                    <button type="button" class="focus-link" disabled={!online || !!pending}
                      onclick={() => request("incident_page", { revision, offset })}>{t("Next page")}</button>
                  {/if}
                {:else}
                  <button type="button" class="focus-link" disabled={!online || !!pending}
                    onclick={() => request("incident_page", { revision, offset: 0 })}>{t("Browse all saved incidents")}</button>
                {/if}
              {/if}
              {#each shownIncidents as { id, sourceId, incident } (sourceId ?? id)}
                {@const revision = historical?.revision ?? assessment?.revision}
                {@const decisions = (historical ? historicalIncidentReviews : liveIncidentReviews)
                  .filter(({ incidentId }) => incidentId === sourceId)}
                {@const investigation = !historical && tasks.find((task) => task.kind === "review_incident" && task.nodeId === sourceId)}
                {@const alertPage = incidentAlerts?.incidentId === sourceId && incidentAlerts?.revision === revision ? incidentAlerts : undefined}
                <details>
                  <summary>{incident.asset} · {t(decisions.length ? humanize(decisions[0].disposition) : "Requires review")} · {incident.signals.map((signal) => t(humanize(signal))).join(", ")}</summary>
                  <p><time datetime={incident.startedAt}>{dateLabel(incident.startedAt)}</time> → <time datetime={incident.endedAt}>{dateLabel(incident.endedAt)}</time></p>
                  {#if incident.reportedAssets.length}<p>{t("Reported asset IDs")} · {incident.reportedAssets.join(", ")}</p>{/if}
                  {#if incident.severity}<p>{t("Severity")} · {t(humanize(incident.severity))}</p>{/if}
                  {#if incident.alertCount !== undefined}<p>{t("Contributing alerts")} · {incident.alertCount}</p>{/if}
                  {#if incident.evidenceIds.length}<p>{t("Evidence IDs")} · {incident.evidenceIds.join(", ")}</p>{/if}
                  {#if decisions.length}
                    <ol aria-label={t("Recent incident reviews")}>
                      {#each decisions as decision (decision.id)}
                        <li>
                          <strong>{t(humanize(decision.disposition))}</strong> ·
                          {t("Revision")} {decision.revision} ·
                          <time datetime={decision.at}>{dateLabel(decision.at)}</time>
                          <p>{decision.note}</p>
                        </li>
                      {/each}
                    </ol>
                  {/if}
                  {#if decisions.length && revision && sourceId}
                    <DecisionHistory
                      page={decisionPage?.kind === "incident" && decisionPage.revision === revision && decisionPage.subjectId === sourceId ? decisionPage : undefined}
                      language={workspaceLanguage} disabled={!online || !!pending}
                      onPage={(before) => request("decision_history", { revision, kind: "incident", subjectId: sourceId, before })} />
                  {/if}
                  {#if !historical && active && revision && sourceId}
                    {#key decisions[0]?.id}
                      <form class="manual-assignment" onsubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        request("review_incident", {
                          revision, incidentId: sourceId,
                          disposition: String(form.get("disposition") ?? ""),
                          note: String(form.get("note") ?? ""),
                        });
                      }}>
                        <label>
                          <span>{t("Incident disposition")}</span>
                          <select name="disposition" value={decisions[0]?.disposition ?? "investigating"} disabled={!online || !!pending}>
                            {#each incidentDispositions as disposition (disposition)}
                              <option value={disposition}>{t(humanize(disposition))}</option>
                            {/each}
                          </select>
                        </label>
                        <label>
                          <span>{t("Review note")}</span>
                          <textarea name="note" maxlength="1000" required disabled={!online || !!pending}></textarea>
                        </label>
                        <button type="submit" class="button" disabled={!online || !!pending}>{t("Save incident review")}</button>
                      </form>
                    {/key}
                  {/if}
                  {#if id}
                    <button type="button" class="focus-link" onclick={() => focusDisplayedNode(id)}>{t("Inspect incident in graph")}</button>
                  {:else if revision !== undefined && sourceId}
                    <button type="button" class="focus-link" disabled={!online || !!pending}
                      onclick={() => request("revision", { revision, baseline: comparison?.revision, focusIncidentId: sourceId })}>{t("Inspect incident in graph")}</button>
                  {/if}
                  {#if investigation}
                    <button type="button" class="focus-link" onclick={() => focusTask(investigation.id)}>
                      {t("Open incident investigation")} · {t(humanize(investigation.status))}
                    </button>
                  {:else if !historical && active && adaptive?.revision && sourceId}
                    {@const taskRevision = adaptive.revision}
                    <button type="button" class="focus-link" disabled={!online || !!pending}
                      onclick={() => request("assign", { revision: taskRevision, kind: "review_incident", nodeId: sourceId })}>{t("Assign incident investigation")}</button>
                  {/if}
                  {#if revision && sourceId && (historical ? historicalAlertFeedAvailable : liveAlertFeedAvailable)}
                    <button type="button" class="focus-link" disabled={!online || !!pending}
                      onclick={() => request("incident_alerts", { revision, incidentId: sourceId, offset: 0 })}>{t("Browse contributing alerts")}</button>
                    {#if alertPage}
                      <ul aria-label={t("Contributing alerts")}>
                        {#each alertPage.alerts as alert (alert.focusAlertKey)}
                          <li>
                            <button type="button" class="focus-link" disabled={!online || !!pending}
                              onclick={() => request("revision", { revision, baseline: comparison?.revision, focusAlertKey: alert.focusAlertKey, focusIncidentId: sourceId })}>
                              {t(humanize(alert.type))} · {alert.subject} · {alert.asset}
                            </button>
                            <time datetime={alert.observedAt}>{dateLabel(alert.observedAt)}</time>
                          </li>
                        {/each}
                      </ul>
                      <p>{alertPage.offset + 1}–{alertPage.offset + alertPage.alerts.length} / {alertPage.total}</p>
                      {#if alertPage.offset > 0}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("incident_alerts", { revision, incidentId: sourceId, offset: Math.max(0, alertPage.offset - 10) })}>{t("Previous page")}</button>
                      {/if}
                      {#if alertPage.nextOffset !== null}
                        {@const offset = alertPage.nextOffset}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("incident_alerts", { revision, incidentId: sourceId, offset })}>{t("Next page")}</button>
                      {/if}
                    {/if}
                  {/if}
                </details>
              {/each}
            </section>
          {/if}
          {#if sourceSnapshot}
            <section id="sentinel-source-snapshot" class="panel" aria-label={t(sourceSnapshot.published ? "Published source snapshot" : "Archived source snapshot")}>
              <header class="panel-header">
                <h2>{t(sourceSnapshot.published ? "Published source snapshot" : "Archived source snapshot")} · {sourceSnapshot.sourceCase}</h2>
                <button type="button" class="button" onclick={() => sourceSnapshot = undefined}>
                  {t("Close source snapshot")}
                </button>
              </header>
              <p>{t("Snapshot digest")} <code>{sourceSnapshot.digest}</code></p>
              {#if sourceSnapshot.aliasProof}<p>{t("Alias proof")} <code>{sourceSnapshot.aliasProof}</code></p>{/if}
              {#if sourceSnapshot.citations?.length}
                <ul aria-label={t("Citing case revisions")}>
                  {#each sourceSnapshot.citations as citation (`${citation.caseId}/${citation.revision}/${citation.focusId}`)}
                    <li>
                      <button type="button" class="focus-link" disabled={!online || !!pending}
                        onclick={() => openSnapshotCitation(citation)}>
                        {citation.caseId} · {t("Revision")} {citation.revision}{#if citation.focusId.startsWith("review:assessment:")} · {t("Assessment review")}{/if}
                      </button>
                    </li>
                  {/each}
                </ul>
                {#if sourceSnapshot.nextCitationCursor}
                  <button type="button" class="button" disabled={!online || !!pending}
                    onclick={() => {
                      if (sourceSnapshot?.nextCitationCursor) {
                        request("source_snapshot", { sourceCase: sourceSnapshot.sourceCase, snapshotDigest: sourceSnapshot.digest, asset: sourceSnapshot.asset, citationCursor: sourceSnapshot.nextCitationCursor });
                      }
                    }}>{t("Load more citing revisions")}</button>
                {/if}
              {/if}

              <ProvenanceGraph graph={sourceSnapshot.graph} language={workspaceLanguage} bind:selectedId={sourceAsset}
                onOpenSource={openRelationshipSource} onDownloadPath={downloadGraphPath} sourceNavigationDisabled={!online || !!pending} />
            </section>
          {:else}
            {#key historical ? `archive-${historical.revision}` : assessment?.revision}
              <FindingsTable graph={displayGraph} language={workspaceLanguage} onFocus={focusDisplayedNode}
                reviews={historical ? historicalFindingReviews : liveFindingReviews}
                decisionPage={decisionPage?.kind === "finding" && decisionPage.revision === displayedRevision ? decisionPage : undefined}
                onHistory={displayedRevision === undefined ? undefined : (subjectId, before) => {
                  if (displayedRevision !== undefined) request("decision_history", { revision: displayedRevision, kind: "finding", subjectId, before });
                }}
                canReview={!historical && !!assessment?.result}
                disabled={!online || !!pending}
                onReview={(findingId, disposition, note) => {
                  if (assessment) request("review_finding", { revision: assessment.revision, findingId, disposition, note });
                }} />
            {/key}
            <ProvenanceGraph graph={displayGraph} language={workspaceLanguage} bind:selectedId onOpenDecision={openPlanningInput}
              onOpenPeerFinding={openPeerFinding}
              onOpenAliasSource={(traceId, stepIndex, sourceCase, snapshotDigest) => {
                if (displayedRevision !== undefined) openAliasSource(displayedRevision, { traceKind: "worker", traceId, stepIndex }, sourceCase, snapshotDigest);
              }}
              onOpenSource={openRelationshipSource} onDownloadPath={downloadGraphPath} sourceNavigationDisabled={!online || !!pending} />
            {#if upstreamChecks.length}
              <section class="panel" aria-label={t("Upstream coverage matches")}>
                <h2>{t("Upstream coverage matches")}</h2>
                {#each upstreamChecks as check (check.id)}
                  <details>
                    <summary>{check.actions.join(", ")} · {check.alertCount}</summary>
                    <ul>
                      {#each check.sample as alert}
                        <li>
                          <button type="button" class="focus-link" disabled={!online || !!pending}
                            onclick={() => {
                              const revision = historical?.revision ?? assessment?.revision;
                              if (revision !== undefined) request("revision", { revision, baseline: comparison?.revision, focusAlertKey: alert.focusAlertKey });
                            }}>{alert.asset} · {dateLabel(alert.observedAt)}</button>
                        </li>
                      {/each}
                    </ul>
                    {#if upstreamAlertFeed?.check === check.id && upstreamAlertFeed.revision === (historical?.revision ?? assessment?.revision)}
                      {@const revision = upstreamAlertFeed.revision}
                      <SavedAlerts language={workspaceLanguage} alerts={upstreamAlertFeed.alerts} disabled={!online || !!pending}
                        onOpen={(focusAlertKey) => request("revision", { revision, baseline: comparison?.revision, focusAlertKey })} />
                    {:else}
                      {@const revision = historical?.revision ?? assessment?.revision}
                      <button type="button" class="button" disabled={!online || !!pending || revision === undefined}
                        onclick={() => revision !== undefined && request("revision_alerts", { revision, upstreamCheck: check.id })}>
                        {t("Browse all matching alerts")}
                      </button>
                    {/if}
                  </details>
                {/each}
              </section>
            {/if}
            <TrafficEvidence graph={displayGraph} language={workspaceLanguage} onFocus={focusDisplayedNode} />
          {/if}
        </div>
      {/key}

      <div class="operations">
        <section class="panel queue" aria-labelledby="queue-heading">
          <header class="panel-header">
            <h2 id="queue-heading">{t("Task queue")}</h2>
            {#if tasks.length}<span>
                {t("{count} complete", { count: completed })} · {t("{count} running", { count: running })} · {t("{count} ready", { count: ready })} · {t("{count} blocked", { count: blockedCount })}
                {#if waitingCount} · {t("{count} waiting for input or review", { count: waitingCount })}{/if}
              </span>{/if}
          </header>
          {#if adaptive?.modelUsage}{@render modelUsage(adaptive.modelUsage)}{/if}
          {#if interactiveModelUsage}{@render modelUsage(interactiveModelUsage, "Interactive model usage")}{/if}
          {#if workerSettings}
            {@const gatewayLimit = workerSettings.gatewayLimit}
            <form class="manual-assignment" onsubmit={(event) => {
              event.preventDefault();
              request("worker_limit", { limit: Number(new FormData(event.currentTarget).get("workerLimit")) });
            }}>
              <label>
                <span>{t("Case model worker limit")}</span>
                <input type="number" name="workerLimit" min="1" max={gatewayLimit}
                  value={Math.min(workerSettings.caseLimit ?? gatewayLimit, gatewayLimit)} required
                  disabled={!online || !!pending} />
              </label>
              <button type="submit" class="button" disabled={!online || !!pending}>{t("Save worker limit")}</button>
              {#if workerSettings.caseLimit !== null}
                <button type="button" class="button" disabled={!online || !!pending}
                  onclick={() => request("worker_limit", { limit: null })}>{t("Use gateway default")}</button>
              {/if}
              <span>{t("Gateway worker limit")} · {gatewayLimit}</span>
            </form>
          {/if}
          {#if modelOutputSettings}
            {@const gatewayLanguage = workspaceLanguages.find(({ id }) => id === modelOutputSettings?.gatewayLanguage)?.label}
            <div class="manual-assignment">
              <label>
                <span>{t("Case model output language")}</span>
                <select value={modelOutputSettings.caseLanguage ?? ""}
                  disabled={!online || !!pending}
                  onchange={(event) => {
                    const language = event.currentTarget.value;
                    if (language === "" || isWorkspaceLanguage(language)) {
                      request("model_output_language", { language: language || null });
                    }
                  }}>
                  <option value="">{t("Use gateway default")} · {gatewayLanguage}</option>
                  {#each workspaceLanguages as language (language.id)}
                    <option value={language.id}>{language.label}</option>
                  {/each}
                </select>
              </label>
            </div>
          {/if}
          <details class="case-hints">
            <summary>{t("Case hints")}</summary>
            <form class="manual-assignment" onsubmit={(event) => {
              event.preventDefault();
              if (caseHint.trim()) request("add_case_hint", { hint: caseHint.trim() });
            }}>
              <label>
                <span>{t("Investigation hint")}</span>
                <textarea bind:value={caseHint} maxlength="1000" required disabled={!online || !!pending}></textarea>
              </label>
              <button type="submit" class="button" disabled={!online || !!pending || !caseHint.trim()}>
                {t("Save case hint")}
              </button>
            </form>
            {#if caseHints.length}
              <ol>
                {#each caseHints as hint (hint.id)}
                  <li>
                    <span>#{hint.id} · </span><time datetime={hint.at}>{dateLabel(hint.at)}</time>
                    {#if hint.revision} · {t("Revision")} {hint.revision}{/if}
                    <p>{hint.text}</p>
                  </li>
                {/each}
              </ol>
            {/if}
          </details>
          {@render modelPlannerHistory(adaptive?.modelPlannerHistory ?? [], assessment?.revision)}
          {#if adaptive?.modelPlanner}
            <p>{t("Model planner")} · {t(humanize(adaptive.modelPlanner.status))} · {t("Attempt")} {adaptive.modelPlanner.attempt}</p>
          {/if}
          {#if paused}
            <p>{t("Case paused. You can queue investigations now. Workers will take them when the case resumes.")}</p>
            {#if pendingInputs}
              <p role="status">{t("Published inputs have changed. Sentinel will reassess them on resume.")}</p>
            {/if}
          {:else if assessment && !active}
            <p>{t("Case stopped.")}</p>
          {:else if active && !running && !ready}
            {#if blockedCount}
              <p>{t("Queued investigations are waiting for prerequisites.")}</p>
            {:else if tasks.some((task) => task.retirementReason || task.dependencyRecommendation)}
              <p>{t("Investigations are held for plan review.")}</p>
            {:else if tasks.some((task) => task.heldForDecision)}
              <p>{t("Automatic reviews are held by analyst decisions.")}</p>
            {:else if !waitingCount}
              <p>{t("Workers are idle. New evidence can schedule more investigations.")}</p>
            {/if}
          {/if}
          {#if atTaskLimit}
            <p>{t("This evidence revision has reached its {limit}-investigation limit. Existing assignments can still run.", { limit: adaptive?.taskLimit ?? 0 })}</p>
          {/if}
          {#if !historical && active && adaptive?.revision && selectedAssignable && assignmentNode}
            {@const node = assignmentNode}
            {@const revision = adaptive.revision}
            <div class="manual-assignment">
              <label>
                <span>{t("Investigate {target}", { target: node.label })}</span>
                <select value={effectiveAssignmentKind} onchange={(event) => assignmentKind = event.currentTarget.value}>
                  {#each assignmentKinds as kind}
                    <option value={kind}>{t(taskNames[kind])}</option>
                  {/each}
                </select>
              </label>
              <button type="button" disabled={!online || !!pending || atTaskLimit}
                onclick={() => request("assign", { revision, kind: effectiveAssignmentKind, nodeId: node.sourceId ?? node.id })}>
                {t(paused ? "Queue for resume" : "Queue investigation")}
              </button>
            </div>
          {/if}
          {#if tasks.length}
            <div class="activity-filters">
              <label>
                <span>{t("Find tasks")}</span>
                <input type="search" bind:value={queueSearch} />
              </label>
              <label>
                <span>{t("Task state")}</span>
                <select bind:value={queueFilter}>
                  <option value="all">{t("All tasks")}</option>
                  <option value="ready">{t("Ready")}</option>
                  <option value="decision_hold">{t("Held by analyst decision")}</option>
                  <option value="retirement">{t("Retirement recommended")}</option>
                  <option value="prioritized">{t("Priority requested")}</option>
                  <option value="blocked">{t("Waiting for prerequisites")}</option>
                  <option value="running">{t("Running")}</option>
                  <option value="retryable">{t("Retry available")}</option>
                  <option value="failed">{t("Failed")}</option>
                  <option value="waiting">{t("Waiting for input or review")}</option>
                  <option value="superseded">{t("Superseded")}</option>
                  <option value="completed">{t("Completed")}</option>
                </select>
              </label>
              {#if liveModelReviewStates.size || modelReviewFilter !== "all"}
                <label>
                  <span>{t("Model review state")}</span>
                  <select bind:value={modelReviewFilter}>
                    <option value="all">{t("Any review state")}</option>
                    <option value="running">{t("Running")}</option>
                    <option value="retry_pending">{t("Retry pending")}</option>
                    <option value="held_by_analyst_decision">{t("Held by analyst decision")}</option>
                    <option value="exhausted">{t("Exhausted")}</option>
                    <option value="completed">{t("Completed")}</option>
                  </select>
                </label>
              {/if}
            </div>
            {#if !visibleTasks.length}<p class="empty">{t("No tasks match these filters.")}</p>{/if}
            <ul class="task-list">
              {#each visibleTasks as task (task.id)}
                {@const review = liveModelReviewStates.get(task.id)}
                {@const graphNode = taskNodes.get(task.id)}
                {@const dependents = downstreamTasks.get(task.id) ?? []}
                {@const blockers = failedPrerequisites.get(task.id) ?? []}
                {@const blocked = waitsForPrerequisites(task)}
                <li id={`sentinel-task-${task.id}`} tabindex="-1">
                  <div class="task-info">
                    <strong>{taskName(task)}</strong>
                    {#if review}
                      <span>{t("Model review")} · {t(humanize(review.status))}{review.attempts ? ` · ${t("Attempt")} ${review.attempts}` : ""}</span>
                      {#if liveReviewNotes.has(task.id) && assessment}
                        {@render modelReviewLink(task.id, assessment.revision)}
                      {:else if review.status === "completed"}
                        <span>{t("Saved review text unavailable")}</span>
                      {/if}
                      {#if review.retryable && workerSettings && active && adaptive?.revision}
                        {@const revision = adaptive.revision}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("retry_model_review", { revision, taskId: task.id })}>
                          {t("Retry model review")}
                        </button>
                      {/if}
                    {/if}
                    {#if task.worker}<span>
                        {t("{worker} worker", { worker: t(humanize(task.worker)) })}
                      </span>{/if}
                    {#if task.nodeId}<span>
                        {t("Target")} <code>{task.nodeId}</code>
                      </span>{/if}
                    {#if task.reason}<span>
                        {t(reasons[task.reason] ?? humanize(task.reason))}
                      </span>{/if}
                    {#if task.dependencyRecommendation}
                      {@const proposal = task.dependencyRecommendation}
                      {@const group = tasks.filter((item) => item.dependencyRecommendation?.id === proposal.id)}
                      {@const plan = group.find((item) => !item.dependencyRecommendation?.queueOnly)?.dependencyRecommendation ?? proposal}
                      <div class="task-handoffs">
                        <strong>{t("Proposed prerequisites")}{#if group.length > 1} · {group.length} {t("Investigations")}{/if}</strong>
                        {#if plan.additions?.length}
                          <strong>{t("Proposed assignments")}</strong>
                          {#each plan.additions as addition (addition.id)}
                            <span>{taskName(addition)}{#if addition.nodeId} · {addition.nodeId}{/if}
                              {#if addition.prerequisites.length}
                                · {t("Prerequisites")} {addition.prerequisites.map((id) =>
                                  plan.additions?.find((task) => task.id === id)?.nodeId ?? taskReference(id)).join(", ")}
                              {/if}
                            </span>
                          {/each}
                        {/if}
                        {#if plan.citations?.length}
                          <strong>{t("Upstream coverage matches")}</strong>
                          {#each plan.citations as citation}
                            <button type="button" class="focus-link" onclick={() => focusTask(citation.id)}>{taskReference(citation.id)}</button>
                            <span>{citation.plannerRound?.upstreamCheckId} · <code>{citation.evidenceIds.join(", ")}</code></span>
                          {/each}
                        {/if}
                        {#each group.filter((item) => !item.dependencyRecommendation?.queueOnly) as item (item.id)}
                          {@const change = item.dependencyRecommendation!}
                          {#if group.length > 1}
                            <button type="button" class="focus-link" onclick={() => focusTask(item.id)}>{taskReference(item.id)}</button>
                          {/if}
                          <span>{change.reason}</span>
                          {#each change.prerequisites as id (id)}
                            {@const addition = plan.additions?.find((task) => task.id === id)}
                            {#if addition}
                              <span>{taskName(addition)}{#if addition.nodeId} · {addition.nodeId}{/if}</span>
                            {:else}
                              <button type="button" class="focus-link" onclick={() => focusTask(id)}>{taskReference(id)}</button>
                            {/if}
                          {:else}
                            <span>{t("No prerequisites")}</span>
                          {/each}
                        {/each}
                        {#if plan.queueChanges?.priorities?.length}
                          <strong>{t("Proposed priority order")}</strong>
                          {#each plan.queueChanges.priorities as id, index (id)}
                            <button type="button" class="focus-link" onclick={() => focusTask(id)}>{index + 1}. {taskReference(id)}</button>
                          {/each}
                        {/if}
                        {#if plan.queueChanges?.retirements?.length}
                          <strong>{t("Proposed retirement reviews")}</strong>
                          {#each plan.queueChanges.retirements as change (change.id)}
                            <button type="button" class="focus-link" onclick={() => focusTask(change.id)}>{taskReference(change.id)}</button>
                            <span>{change.reason}</span>
                          {/each}
                        {/if}
                        {#if active && adaptive?.revision}
                          {@const revision = adaptive.revision}
                          <button type="button" class="focus-link" disabled={!online || !!pending}
                            onclick={() => request("apply_task_dependencies", { revision, taskId: task.id, proposalId: proposal.id })}>{t((plan.additions?.length || plan.citations?.length || plan.queueChanges?.priorities?.length || plan.queueChanges?.retirements?.length) ? "Apply plan changes" : "Apply prerequisites")}</button>
                          <button type="button" class="focus-link" disabled={!online || !!pending}
                            onclick={() => request("dismiss_task_dependencies", { revision, taskId: task.id, proposalId: proposal.id })}>{t("Keep current prerequisites")}</button>
                        {/if}
                      </div>
                    {/if}
                    {#if task.heldForDecision}
                      <span>{t("Held by analyst decision")}</span>
                      {#if task.decisionHold}
                        {@const hold = task.decisionHold}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => openPlanningInput(hold.kind, hold.id)}>
                          {t(hold.kind === "finding" ? "Finding decision" : "Incident decision")} #{hold.id} · {t(humanize(hold.disposition))}
                        </button>
                      {/if}
                      {#if active && task.nodeId && task.kind && adaptive?.revision}
                        {@const nodeId = task.nodeId}
                        {@const kind = task.kind}
                        {@const revision = adaptive.revision}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("assign", { revision, kind, nodeId })}>{t("Assign held review")}</button>
                      {/if}
                    {/if}
                    {#if task.retirementReason}
                      <span>{t("Retirement recommended")} · {task.retirementReason}</span>
                    {/if}
                    {#if task.plannerPriority}<span>{t("Planner priority")} {task.plannerPriority}</span>{/if}
                    {#if task.plannerRound}
                      <span>{t("Model planner")} · {t("Attempt")} {task.plannerRound.attempt}{#if task.plannerRound.hintId} · {t("Hint")} #{task.plannerRound.hintId}{/if}</span>
                    {/if}
                    {#if task.prerequisites?.length}
                      <div class="task-handoffs">
                        <span>{blockers.length ? t(blockers.length === 1 ? "Blocked by {count} prerequisite" : "Blocked by {count} prerequisites", { count: blockers.length }) : t(blocked ? "Waiting for prerequisites" : "Prerequisites")}</span>
                        {#each blockers as blocker (blocker.id)}
                          <button type="button" class="focus-link" onclick={() => focusTask(blocker.id)}>
                            {t("View blocker")} · {taskName(blocker)}{blocker.nodeId ? ` · ${blocker.nodeId}` : ""}
                            · {t(humanize(blocker.status))}{blocker.retryable ? ` · ${t("Retry available")}` : ""}
                          </button>
                        {/each}
                        {#each task.prerequisites as id (id)}
                          {@const dependency = tasksById.get(id)}
                          {#if dependency}
                            <button type="button" class="focus-link" onclick={() => focusTask(id)}>
                              {taskName(dependency)}{dependency.nodeId ? ` · ${dependency.nodeId}` : ""}
                              · {t(humanize(dependency.status))}
                            </button>
                          {:else}
                            <span>{t("Unavailable task")} · {id}</span>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                    {#if dependents.length}
                      <div class="task-handoffs">
                        <span>{t("Dependent tasks")}</span>
                        {#each dependents as dependent (dependent.id)}
                          <button type="button" class="focus-link" onclick={() => focusTask(dependent.id)}>
                            {taskName(dependent)}{dependent.nodeId ? ` · ${dependent.nodeId}` : ""}
                            · {t(humanize(dependent.status))}
                          </button>
                        {/each}
                      </div>
                    {/if}
                    {#if task.evidenceIds?.length}
                      <span>
                        {t(task.evidenceIds.length === 1 ? "{count} evidence reference" : "{count} evidence references", { count: task.evidenceIds.length })}
                      </span>
                      {#if assessment}
                        {@render supportingAlertLinks(task, assessment.revision)}
                      {/if}
                    {/if}
                    {#if assessment}{@render plannerObservationLink(task, assessment.revision)}{/if}
                    {#if task.prioritized}<span>{t("Priority requested")}</span>{/if}
                    {#if active && task.status === "queued" && !task.dependencyRecommendation && adaptive?.revision && task.id.startsWith("adaptive:")}
                      {@const revision = adaptive.revision}
                      <button type="button" class="focus-link" disabled={!online || !!pending || !!task.heldForDecision}
                        onclick={() => request("prioritize_task", { revision, taskId: task.id })}>
                        {task.retirementReason ? t("Keep and run next") : t(blocked ? "Prioritize when ready" : "Run next")}
                      </button>
                      {#if task.prioritized}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("withdraw_task_priority", { revision, taskId: task.id })}>
                          {t("Withdraw priority")}
                        </button>
                      {/if}
                      <button type="button" class="focus-link" disabled={!online || !!pending}
                        title={t("Cancel this investigation and its queued dependents")}
                        onclick={() => request("cancel_task", { revision, taskId: task.id })}>
                        {t("Cancel queued investigation")}
                      </button>
                    {/if}
                    {#if task.retryable && adaptive?.revision}
                      {@const revision = adaptive.revision}
                      <button type="button" class="focus-link" disabled={!online || !!pending}
                        onclick={() => request("retry_task", { revision, taskId: task.id })}>
                        {t("Retry investigation")}
                      </button>
                    {/if}
                    {#if graphNode}
                      <button
                        type="button"
                        class="focus-link"
                        onclick={() => focusNode(graphNode)}
                      >
                        {t("Show in graph")}
                      </button>
                    {/if}
                  </div>
                  <span class="task-status" data-status={task.status}>
                    {t(humanize(task.status))}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="empty">{t("Tasks appear when an assessment starts.")}</p>
          {/if}
        </section>

        <section class="panel activity" aria-labelledby="activity-heading">
          <header class="panel-header">
            <h2 id="activity-heading">{t("Worker activity")}</h2>
            {#if reviews.length}<span>
                {t(reviews.length === 1 ? "{count} model review" : "{count} model reviews", { count: reviews.length })}
              </span>{/if}
          </header>
          {#if workers.length || workerNotes.length || observations.length || reviews.length}
            <div class="activity-filters">
              <label>
                <span>{t("Search activity")}</span>
                <input
                  type="search"
                  bind:value={activitySearch}
                  oninput={() => (activityLimit = 12)}
                  placeholder={t("Task, event, or revision")}
                />
              </label>
              <label>
                <span>{t("Revisions")}</span>
                <select
                  bind:value={revisionScope}
                  onchange={() => (activityLimit = 12)}
                >
                  <option value="all">{t("All recent")}</option>
                  <option value="current">{t("Current")}</option>
                  <option value="prior">{t("Prior")}</option>
                </select>
              </label>
            </div>
            {#if matchingActivity}
              <div class="activity-items">
                {#each matchingWorkers.slice(0, activityLimit) as item}
                  {@const priorTask = item.revision === adaptive?.revision
                    ? carriedTask(item.event, item.note)
                    : undefined}
                  <div class="activity-item">
                    <span class="activity-icon">
                      <Icon name="agents" size={14} />
                    </span>
                    <div>
                      <strong>{activityTaskName(item)}</strong>
                      <p class="muted">
                        {t(humanize(item.event))}{item.attempt > 0
                          ? ` · ${t("Attempt")} ${item.attempt}`
                          : ""}
                      </p>
                      {#if isPrior(item.revision) && item.revision}<p
                          class="prior"
                          title={item.revision}
                        >
                          {t("Prior revision")} {revisionLabel(item.revision)}
                        </p>{/if}
                      {#if item.nodeId}<p class="muted">{item.nodeId}</p>{/if}
                      {#if item.note}<p class="muted">{item.note}</p>{/if}
                      {#if item.event === "reopened" && !historical && item.revision === adaptive?.revision}
                        {#each tasksById.get(item.taskId)?.evidenceIds ?? [] as id (id)}
                          {@const evidence = displayedEvidence.get(id)}
                          {#if evidence}
                            <button type="button" class="focus-link" onclick={() => focusDisplayedNode(evidence.id)}>
                              {t("Inspect supporting evidence")} · {evidence.label}
                            </button>
                          {/if}
                        {/each}
                      {/if}
                      {#if item.event === "assignment_unavailable" && item.nodeId && !historical && assessment && isPrior(item.revision)}
                        {@const revision = assessment.revision}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("revision", { revision, priorTask: item.taskId, focusTarget: true })}>
                          {t("Inspect prior target")} · {item.nodeId}
                        </button>
                      {/if}
                      {#if priorTask && !historical && assessment}
                        {@const revision = assessment.revision}
                        {#each item.removedEvidenceIds ?? [] as id (id)}
                          <button type="button" class="focus-link" disabled={!online || !!pending}
                            onclick={() => openRemovedTaskEvidence(revision, priorTask, id)}>
                            {t("Inspect removed evidence")} · {id}
                          </button>
                        {/each}
                      {/if}
                      {#if priorTask && assessment && assessment.revision > 1}
                        {@const revision = assessment.revision}
                        <button type="button" class="focus-link" disabled={!online || !!pending}
                          onclick={() => request("revision", { revision, priorTask })}>
                          {t("Open prior investigation")}
                        </button>
                      {/if}
                    </div>
                    {#if item.at}<time datetime={item.at}>
                        {dateLabel(item.at)}
                      </time>{/if}
                  </div>
                {/each}
                {#each matchingNotes.slice(0, activityLimit) as item}
                  <div class="activity-item">
                    <span class="activity-icon">
                      <Icon name="logs" size={14} />
                    </span>
                    <div>
                      <strong>{activityTaskName(item)}</strong>
                      {#if isPrior(item.revision) && item.revision}<p
                          class="prior"
                          title={item.revision}
                        >
                          {t("Prior revision")} {revisionLabel(item.revision)}
                        </p>{/if}
                      <p class="muted">{item.note}</p>
                      {#if item.steps?.length}
                        <details>
                          <summary>{t("Worker queries")} ({item.steps.length})</summary>
                          <ol>
                            {#each item.steps as step}
                              <li>{step.tool}{step.target ? ` · ${step.target}` : ""} · {t(step.outcome === "returned" ? "Returned" : "Error").toLocaleLowerCase(workspaceLanguage)}</li>
                            {/each}
                          </ol>
                        </details>
                      {/if}
                    </div>
                    <time datetime={item.at}>{dateLabel(item.at)}</time>
                  </div>
                {/each}
                {#each matchingObservations as item (item.id)}
                  <div class="activity-item">
                    <span class="activity-icon">
                      <Icon name="workflows" size={14} />
                    </span>
                    <div>
                      <strong>
                        {t(taskNames[item.task] ?? humanize(item.task))}
                      </strong>
                      <p class="muted">
                        {t(humanize(item.worker))} · {t("Evidence processed")}
                      </p>
                    </div>
                  </div>
                {/each}
                {#each matchingReviews as review (review.task)}
                  <div class="activity-item">
                    <span class="activity-icon">
                      <Icon name="agents" size={14} />
                    </span>
                    <div class="model-review">
                      <strong>
                        {t(taskNames[review.task] ?? humanize(review.task))} · {t("Model review")}
                      </strong>
                      <p>{review.analysis}</p>
                      {#if review.steps?.length}
                        <details>
                          <summary>{t("Worker queries")} ({review.steps.length})</summary>
                          <ol>
                            {#each review.steps as step}
                              <li>{step.tool}{step.target ? ` · ${step.target}` : ""} · {t(step.outcome === "returned" ? "Returned" : "Error").toLocaleLowerCase(workspaceLanguage)}</li>
                            {/each}
                          </ol>
                        </details>
                      {/if}
                    </div>
                  </div>
                {/each}
                {#if matchingWorkers.length > activityLimit || matchingNotes.length > activityLimit}
                  <button
                    type="button"
                    class="focus-link more-activity"
                    onclick={() => (activityLimit += 12)}
                  >
                    {t("Show more activity")}
                  </button>
                {/if}
              </div>
            {:else}
              <p class="empty">{t("No activity matches these filters.")}</p>
            {/if}
          {:else}
            <p class="empty">{t("No worker activity for this assessment.")}</p>
          {/if}
        </section>
      </div>
    </div>
  </div>
</div>

<style>
  .sentinel-screen {
    height: 100%;
    overflow-y: auto;
  }
  .shell {
    margin: 0 auto;
    max-width: 1450px;
    padding: clamp(16px, 3vw, 36px);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title h1 {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 25px;
    font-weight: 690;
    line-height: 1.15;
  }
  .title h1 :global(svg) {
    color: var(--accent);
  }
  .title p {
    margin-top: 6px;
    color: var(--fg2);
    font-size: 13px;
  }
  .status {
    color: var(--fg2);
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .status[data-status="active"] {
    color: var(--status-green);
  }
  .status[data-status="paused"] {
    color: var(--status-yellow);
  }
  .dot {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: currentColor;
  }
  .panel {
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--radius-lg);
    background: var(--bg2);
    min-width: 0;
    overflow: hidden;
  }
  .assessment-controls {
    padding: 16px;
    display: grid;
    gap: 12px;
  }
  .assessment-heading-row {
    display: flex;
    align-items: start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
  }
  .case-controls,
  .case-form {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    justify-content: start;
    gap: 8px;
  }
  .case-field {
    min-width: 0;
    color: var(--fg2);
    display: grid;
    gap: 4px;
    font-size: 11px;
  }
  .case-field input,
  .case-field select {
    min-width: 0;
    width: 100%;
    height: 34px;
    font: inherit;
    padding: 0 8px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .panel h2 {
    font-size: 15px;
    font-weight: 650;
  }
  .muted {
    color: var(--fg2);
    font-size: 12px;
  }
  form {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
  }
  .goal {
    display: grid;
    gap: 4px;
    min-width: 120px;
    width: min(100%, 650px);
    color: var(--fg2);
    font-size: 11px;
  }
  .goal input {
    background: var(--bg);
    font: inherit;
    font-size: 12px;
    min-height: 34px;
    border: 1px solid var(--border);
    color: var(--fg);
    padding: 0 9px;
    border-radius: var(--radius-sm);
  }
  .goal-display p {
    overflow-wrap: anywhere;
    font-size: 13px;
    color: var(--fg);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 10px;
    min-height: 34px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    white-space: nowrap;
    font-size: 12px;
    background: var(--bg3);
  }
  .button:hover:not(:disabled) {
    border-color: var(--accent-glow);
  }
  .button.primary {
    color: var(--bg);
    font-weight: 650;
    background: var(--accent);
    border-color: var(--accent);
  }
  .button.stop {
    color: var(--status-red);
  }
  .button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .export-menu {
    display: flex;
    gap: 4px;
  }
  .export-options {
    display: flex;
    gap: 4px;
  }
  .error {
    border: 1px solid var(--status-red);
    border-radius: var(--radius-sm);
    color: var(--status-red);
    padding: 7px 9px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1.9fr) minmax(255px, 1fr);
    gap: 16px;
    align-items: start;
  }
  .operations {
    min-width: 0;
    display: grid;
    gap: 16px;
  }
  .manual-assignment {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: .5rem;
    padding: .75rem 0;
  }
  .manual-assignment label { display: grid; gap: .25rem; }
  .panel-header {
    padding: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--border);
  }
  .panel-header span {
    color: var(--fg2);
    font-size: 12px;
  }
  .queue ul {
    list-style: none;
  }
  .queue .task-list {
    overflow-y: auto;
    max-height: 510px;
  }
  .queue li {
    display: flex;
    justify-content: space-between;
    align-items: start;
    gap: 8px;
    padding: 12px 16px;
  }
  .queue li + li {
    border-top: 1px solid var(--border);
  }
  .task-handoffs {
    display: grid;
    justify-items: start;
    gap: 0.25rem;
    overflow-wrap: anywhere;
  }
  .task-list > li:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .task-info {
    min-width: 0;
    display: grid;
    gap: 3px;
    overflow-wrap: anywhere;
  }
  .task-info strong,
  .activity-item strong {
    font-size: 12px;
    font-weight: 650;
  }
  .task-info span {
    font-size: 11px;
    color: var(--fg2);
  }
  .focus-link {
    color: var(--accent);
    font-size: 11px;
    text-align: left;
    width: fit-content;
  }
  .focus-link:hover {
    text-decoration: underline;
  }
  .task-status {
    color: var(--fg2);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg3);
    font-size: 10px;
  }
  .task-status[data-status="completed"] {
    color: var(--status-green);
  }
  .task-status[data-status="waiting"] {
    color: var(--status-yellow);
  }
  .task-status[data-status="running"] {
    color: #9ac8f5;
  }
  .task-status[data-status="failed"],
  .task-status[data-status="blocked"] {
    color: var(--status-red);
  }
  .empty {
    color: var(--fg2);
    padding: 16px;
    font-size: 12px;
  }
  .activity-items {
    max-height: 340px;
    overflow-y: auto;
  }
  .activity-filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    padding: 8px 16px 10px;
    border-bottom: 1px solid var(--border);
  }
  .activity-filters label {
    display: grid;
    gap: 3px;
    min-width: 0;
    font-size: 11px;
    color: var(--fg2);
  }
  .activity-filters input,
  .activity-filters select {
    width: 100%;
    min-width: 0;
    min-height: 30px;
    padding: 0 6px;
    font: inherit;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
  }
  .prior {
    color: var(--status-yellow);
    font-size: 11px;
  }
  .more-activity {
    padding: 8px 16px;
  }
  .activity-item {
    display: flex;
    align-items: start;
    gap: 10px;
    padding: 11px 16px;
  }
  .activity-item + .activity-item {
    border-top: 1px solid var(--border);
  }
  .activity-item > div {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .activity-icon {
    flex: 0 0 auto;
    color: var(--accent);
    display: inline-flex;
    margin-top: 2px;
  }
  .activity-item time {
    margin-left: auto;
    color: var(--fg2);
    font-size: 11px;
  }
  .model-review p {
    font-size: 12px;
    margin-top: 4px;
    white-space: pre-wrap;
    color: var(--fg2);
  }
  @media (max-width: 940px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 620px) {
    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .actions {
      margin-left: 0;
    }
    .title {
      align-items: start;
      flex-wrap: wrap;
    }
  }
  .case-hints p { overflow-wrap: anywhere; white-space: pre-wrap; }
  .case-hints textarea { min-width: min(14rem, 100%); resize: vertical; }
  .shared-assets { overflow-wrap: anywhere; }
  .shared-assets ul { padding-inline-start: 1.1rem; }
  .manual-assignment .topology-auto { display: flex; align-items: center; }
</style>
