import {
  renderSentinelInvestigationMarkdown,
  renderSentinelProvenanceJson,
} from "../../src/sentinel/assessment_export.ts";
import {
  readSavedSentinelIncident,
  readSavedSentinelIncidentCandidate,
  readSavedSentinelIncidentPage,
  renderSavedSentinelIncidentJson,
} from "../../src/sentinel/incident_archive.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  digestSentinelSnapshot,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { sentinelAlertReference } from "../../src/sentinel/telemetry.ts";
import { runSentinelAssessment } from "../../src/sentinel/assessment.ts";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  assignSentinelTask,
  controlSentinelTask,
  createSentinelModelPlanner,
  createSentinelWorkerPool,
  findSentinelTaskEvidence,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
  readSentinelCaseHints,
  readSentinelWorkerObservation,
  setSentinelWorkerLimit,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  acceptSentinelPlanSuggestions,
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
  planSentinelTasks,
  sentinelIncidentCandidates,
  validateSentinelPlanSuggestions,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  pauseSentinelAssessment,
  readSentinelFindingReviews,
  readSentinelIncidentReviews,
  recordSentinelFindingReview,
  recordSentinelIncidentReview,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  MAX_ADAPTIVE_TASKS,
  openSentinelAdaptiveStore,
  sentinelAdaptiveTaskId,
} from "../../src/sentinel/adaptive_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

const snapshot = {
  version: 1,
  nodes: [
    { id: "app", label: "Application", kind: "asset" },
    {
      id: "finding",
      label: "Missing control",
      kind: "finding",
      severity: "high",
    },
    { id: "record", label: "Source record", kind: "evidence" },
  ],
  edges: [
    { from: "finding", relation: "affects", to: "app" },
    { from: "record", relation: "supports", to: "finding" },
  ],
};

Deno.test("Isolated alerts from one asset cannot crowd other assets out of impact review", () => {
  const nodes = [
    {
      id: "busy",
      label: "Busy asset",
      kind: "asset",
      aliases: ["busy.example"],
    },
    { id: "quiet", label: "Quiet asset", kind: "asset" },
  ];
  const alerts = Array.from({ length: 28 }, (_, index) => ({
    type: "security_sensor_alert",
    severity: index < 27 ? "critical" : "high",
    asset: index === 27 ? "quiet" : index % 2 ? "busy" : "busy.example",
    subject: "Runtime alert",
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    evidenceIds: [`sensor-${index}`],
  }));
  const result = runSentinelAssessment({
    snapshot: { version: 1, nodes, edges: [] },
    alerts,
  });
  const state = {
    plan: {},
    active: true,
    paused: false,
    revision: 1,
    result,
    updatedAt: "",
    reviews: [],
  };
  const impact = planSentinelTasks(state, []).filter(({ kind }) =>
    kind === "impact"
  );
  assertEquals(impact.map(({ nodeId }) => nodeId), ["busy", "quiet"]);
  assertEquals(impact[1].evidenceIds?.length, 1);
  assertEquals(
    planSentinelTasks({ ...state, plan: { goal: '"quiet"' } }, [])
      .filter(({ kind }) => kind === "impact").map(({ nodeId }) => nodeId),
    ["quiet"],
  );
});

Deno.test("Isolated alert reviews refill bounded queue slots as workers finish", async () => {
  const nodes = Array.from({ length: 28 }, (_, i) => ({
    id: `asset-${i}`,
    label: `Asset ${i}`,
    kind: "asset",
  }));
  const alerts = nodes.map(({ id }, index) => ({
    type: "security_sensor_alert",
    severity: "high",
    asset: id,
    subject: "Runtime alert",
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 8 - index)).toISOString(),
    evidenceIds: [`sensor-${index}`],
  }));
  alerts.push({ ...alerts[27], evidenceIds: ["second-source-for-asset-27"] });
  const snapshot = { version: 1, nodes, edges: [] };
  const state = {
    plan: {},
    active: true,
    paused: false,
    revision: 1,
    result: runSentinelAssessment({
      snapshot,
      alerts,
    }),
    updatedAt: "",
    reviews: [],
  };
  const revision = adaptiveRevision(state);
  const initial = planSentinelTasks(state, []);
  assertEquals(
    initial.map(({ nodeId }) => nodeId),
    nodes.slice(0, 6).map(({ id }) => id),
  );
  const tasks = initial.map((request) => ({
    ...request,
    id: sentinelAdaptiveTaskId(revision, request),
    revision,
    attempts: 0,
    status: "queued" as const,
    prerequisites: [],
    evidenceIds: request.evidenceIds ?? [],
  }));
  assertEquals(planSentinelTasks(state, tasks), []);
  const afterWorker = tasks.map((task, index) => ({
    ...task,
    status: index === 0
      ? "completed" as const
      : index === 1
      ? "failed" as const
      : task.status,
  }));
  assertEquals(
    planSentinelTasks(state, afterWorker).map(({ nodeId }) => nodeId),
    ["asset-6", "asset-7"],
  );
  const dir = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(dir, "main");
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    await Deno.writeTextFile(sentinelAlertsPath(path), JSON.stringify(alerts));
    const live = startSentinelAssessment(path);
    for (let pass = 0; pass < 5; pass++) advanceAdaptiveSentinel(path, live);
    const settled = readAdaptiveSentinel(path, live);
    assert(settled);
    const completed = settled.tasks
      .filter(({ kind, status }) =>
        kind === "impact" && status === "completed"
      );
    assertEquals(
      completed?.map(({ nodeId }) => nodeId).sort(),
      nodes.map(({ id }) => id).sort(),
    );
    const priorImpact = completed?.find(({ nodeId }) => nodeId === "asset-27");
    assert(priorImpact);
    const provenance = buildSentinelProvenance(live.result, settled).snapshot();
    assert(
      provenance.edges.some(({ from, to, relation }) =>
        from === `observation:assessment:${priorImpact.evidenceIds[0]}` &&
        to === `task:adaptive:${priorImpact.id}` && relation === "prompted"
      ),
    );
    const handler = createTidepoolSentinelHandler({
      baseDir: dir,
      config: {},
    } as BootstrapResult);
    const focusTaskAlert = async (
      taskId: string,
      alertId: string,
      revision = live.revision,
      priorTask?: string,
    ) => {
      let reply = "";
      await handler({
        type: "revision",
        revision,
        priorTask,
        focusTaskAlert: { taskId, alertId },
      }, {
        readyState: WebSocket.OPEN,
        send: (value: string) => {
          reply = value;
        },
      } as unknown as WebSocket);
      return JSON.parse(reply);
    };
    const focused = await focusTaskAlert(
      priorImpact.id,
      priorImpact.evidenceIds[0],
    );
    assertEquals(
      focused.focusId,
      `observation:assessment:${priorImpact.evidenceIds[0]}`,
    );
    assertEquals(
      (await focusTaskAlert(completed[0].id, priorImpact.evidenceIds[0])).type,
      "error",
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(
        alerts.map((alert) =>
          alert.asset === "asset-27"
            ? { ...alert, subject: "Updated runtime alert" }
            : alert
        ),
      ),
    );
    const revised = refreshSentinelAssessment(path)!;
    for (let pass = 0; pass < 7; pass++) advanceAdaptiveSentinel(path, revised);
    const replanned = readAdaptiveSentinel(path, revised)!;
    const reopened = replanned.tasks.find(({ nodeId }) =>
      nodeId === "asset-27"
    );
    assert(reopened);
    assertEquals(reopened.evidenceIds, priorImpact.evidenceIds);
    assert(
      replanned.history.some(({ taskId, event, note }) =>
        taskId === reopened.id && event === "reopened" &&
        note?.includes(priorImpact.id)
      ),
    );
    const removedAlert = sentinelAlertReference({
      type: "security_sensor_alert",
      asset: "asset-27",
      evidenceIds: ["sensor-27"],
    });
    assert(reopened.evidenceIds.includes(removedAlert));
    const remaining = alerts.filter((alert) =>
      alert.evidenceIds[0] !== "sensor-27"
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(remaining),
    );
    const removed = refreshSentinelAssessment(path)!;
    for (let pass = 0; pass < 7; pass++) advanceAdaptiveSentinel(path, removed);
    const history = readAdaptiveSentinel(path, removed)!.history;
    assert(
      history.some(({ event, removedEvidenceIds }) =>
        event === "reopened" && removedEvidenceIds?.includes(removedAlert)
      ),
    );
    const priorFocus = await focusTaskAlert(
      reopened.id,
      removedAlert,
      removed.revision,
      reopened.id,
    );
    assertEquals(priorFocus.historical.revision, revised.revision);
    assertEquals(priorFocus.focusId, `observation:assessment:${removedAlert}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Critical incident evidence stays in the bounded assessment sample and leads review planning", async () => {
  const nodes = Array.from({ length: 26 }, (_, i) => ({
    id: `node-${i}`,
    label: `Node ${i}`,
    kind: "asset",
  }));
  const alerts = nodes.flatMap(({ id }, index) => {
    const observedAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    return [
      {
        type: "security_sensor_alert",
        severity: index === 25 ? "critical" : "medium",
        asset: id,
        subject: "Runtime alert",
        observedAt,
        evidenceIds: [`sensor-${index}`],
      },
      {
        type: "authorization_denial_burst",
        severity: "medium",
        asset: id,
        subject: "Denied access",
        observedAt,
        evidenceIds: [`denial-${index}`],
      },
    ];
  });
  const result = runSentinelAssessment({
    snapshot: { version: 1, nodes, edges: [] },
    alerts,
  });
  const state = {
    plan: {},
    active: true,
    paused: false,
    revision: 1,
    result,
    updatedAt: "",
    reviews: [],
  };
  const candidates = sentinelIncidentCandidates(state);
  assertEquals(candidates.length, 25);
  assertEquals(candidates[0].asset, "node-25");
  const initial = planSentinelTasks(state, []);
  assertEquals(initial.length, 12);
  const [first] = initial;
  assertEquals(first.nodeId, candidates[0].id);
  const narrower = planSentinelTasks(
    { ...state, plan: { goal: '"node-10"' } },
    [],
  );
  assert(
    narrower.some(({ kind, nodeId }) =>
      kind === "review_incident" &&
      nodeId === candidates.find(({ asset }) => asset === "node-10")?.id
    ),
  );
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes, edges: [] }),
    );
    await Deno.writeTextFile(sentinelAlertsPath(path), JSON.stringify(alerts));
    const saved = startSentinelAssessment(path);
    const page = readSavedSentinelIncidentPage(path, saved.revision, 20)!;
    assertEquals(page.total, 26);
    assertEquals(page.incidents.length, 6);
    const outside = page.incidents.find(({ incident }) =>
      incident.asset === "node-0"
    )!;
    assert(outside);
    assert(
      !sentinelIncidentCandidates(saved).some(({ id }) =>
        id === outside.sourceId
      ),
    );
    assert(
      "error" in
        readSavedSentinelIncident(path, saved.revision, outside.sourceId),
    );
    const inspected = readSavedSentinelIncident(
      path,
      saved.revision,
      outside.sourceId,
      true,
    );
    assert(inspected.members);
    assertEquals(inspected.members.length, 2);
    const focused = readSavedSentinelIncidentCandidate(
      path,
      saved.revision,
      outside.sourceId,
    );
    assert(focused);
    const focusedGraph = buildSentinelProvenance(
      saved.result,
      undefined,
      undefined,
      [],
      [],
      focused,
    ).snapshot();
    assert(
      focusedGraph.nodes.some((node) =>
        node.sourceId === outside.sourceId && "incident" in node
      ),
    );

    advanceAdaptiveSentinel(path, saved);
    const revision = readAdaptiveSentinel(path, saved)!.revision;
    assertEquals(
      acceptSentinelPlanSuggestions(
        saved,
        JSON.stringify([
          { kind: "review_incident", nodeId: outside.sourceId },
        ]),
      ),
      [],
    );
    assertThrows(() =>
      assignSentinelTask(
        path,
        revision,
        "review_incident",
        "incident:" + "0".repeat(64),
      )
    );
    for (let pass = 0; pass < 7; pass++) advanceAdaptiveSentinel(path, saved);
    const assigned = readAdaptiveSentinel(path, saved)!.tasks.find((
      { nodeId },
    ) => nodeId === outside.sourceId);
    assertEquals(assigned?.status, "completed");
    assertEquals((assigned?.observation as { asset: string }).asset, "node-0");
    assert(assigned);
    const adaptive = readAdaptiveSentinel(path, saved)!;
    assertEquals(
      adaptive.tasks.filter(({ kind, status }) =>
        kind === "review_incident" && status === "completed"
      ).map(({ nodeId }) => nodeId).sort(),
      [...candidates.map(({ id }) => id), outside.sourceId].sort(),
    );
    const graph = buildSentinelProvenance(saved.result, adaptive).snapshot();
    const candidateId = `observation:assessment:${outside.sourceId}`;
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === candidateId && to === `task:adaptive:${assigned.id}` &&
        relation === "prompted"
      ),
    );
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === candidateId && to === "asset:node-0" &&
        relation === "references"
      ),
    );

    assert(
      recordSentinelIncidentReview(
        path,
        saved.revision,
        outside.sourceId,
        "resolved",
        "Verified.",
      ),
    );
    const firstReviews = readSentinelIncidentReviews(path, saved.revision);
    assertEquals(firstReviews[0].incidentId, outside.sourceId);
    const prompts: string[] = [];
    const makePlanner = () =>
      createSentinelModelPlanner(path, () => ({
        execute(message, send) {
          if (String(message).startsWith("Plan a defensive investigation")) {
            prompts.push(String(message));
          }
          send({
            type: "response",
            text: JSON.stringify([{
              kind: "review_incident",
              nodeId: outside.sourceId,
            }]),
            taint: "INTERNAL",
          });
          return Promise.resolve();
        },
        clear() {},
      }));
    const planner = makePlanner();
    try {
      planner.advance(saved);
      await new Promise((resolve) => setTimeout(resolve, 0));
      planner.advance(saved);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(prompts.length, 1);
      const context = JSON.parse(prompts[0].split("\n").at(-1)!);
      assertEquals(context.incidents.length, 12);
      assertEquals(context.incidents[0].id, outside.sourceId);
      const planned = readAdaptiveSentinel(path, saved);
      assert(planned);
      assertEquals(planned.modelPlanner?.status, "proposal_rejected");
      const incidentIds = context.incidents.map(({ id }: { id: string }) => id);
      assertEquals(
        planned.modelPlannerHistory.at(-1)?.incidentCandidateIds,
        incidentIds,
      );
      const historical = readHistoricalAdaptiveSentinel(path, saved.revision);
      assert(historical);
      const exportedPlan = JSON.parse(
        renderSentinelProvenanceJson("main", saved, historical, path),
      );
      assertEquals(
        exportedPlan.planningAttempts.at(-1).incidentCandidateIds,
        incidentIds,
      );
    } finally {
      planner.stop();
    }
    const exported = JSON.parse(
      renderSavedSentinelIncidentJson(path, "main", saved.revision)!,
    );
    assertEquals(exported.incidents.length, 26);
    assertEquals(exported.incidents[0].severity, "critical");
    assertEquals(exported.incidents.at(-1).latestReview, firstReviews[0]);

    const unrelated = alerts.map((alert) =>
      alert.asset === "node-1" ? { ...alert, subject: "Other change" } : alert
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(unrelated),
    );
    const carried = refreshSentinelAssessment(path)!;
    assertEquals(
      readSentinelIncidentReviews(path, carried.revision),
      firstReviews,
    );
    const changed = unrelated.map((alert) =>
      alert.asset === "node-0"
        ? { ...alert, subject: "Revised evidence" }
        : alert
    );
    await Deno.writeTextFile(sentinelAlertsPath(path), JSON.stringify(changed));
    const updated = refreshSentinelAssessment(path)!;
    assertEquals(readSentinelIncidentReviews(path, updated.revision), []);
    for (let pass = 0; pass < 7; pass++) advanceAdaptiveSentinel(path, updated);
    const replanned = readAdaptiveSentinel(path, updated)!;
    const reviewedAgain = replanned.tasks.find(
      ({ nodeId }) => nodeId === outside.sourceId,
    );
    assert(reviewedAgain);
    assertEquals(reviewedAgain.status, "completed");
    assertEquals(reviewedAgain.evidenceIds.toSorted(), [
      "denial-0",
      "sensor-0",
    ]);
    assert(reviewedAgain.id !== assigned.id);
    assert(
      replanned.history.some(({ event, taskId, note }) =>
        event === "reopened" && taskId === reviewedAgain.id &&
        note?.includes(assigned.id)
      ),
    );
    const closedIds = new Set<string>();
    for (const { id } of candidates.slice(0, 12)) {
      assert(typeof id === "string");
      assert(recordSentinelIncidentReview(
        path,
        updated.revision,
        id,
        "resolved",
        "Resolved in test.",
      ));
      closedIds.add(id);
    }
    const clock = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      clock.exec(
        "UPDATE adaptive_model_attempts SET started = started - 60000",
      );
    } finally {
      clock.close();
    }
    prompts.length = 0;
    const crowdedPlanner = makePlanner();
    try {
      crowdedPlanner.advance(updated);
      await new Promise((resolve) => setTimeout(resolve, 0));
      crowdedPlanner.advance(updated);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(prompts.length, 1);
      const context = JSON.parse(prompts[0].split("\n").at(-1)!);
      assertEquals(context.incidents.length, 12);
      assertEquals(
        context.incidents.filter(({ id }: { id: string }) => closedIds.has(id))
          .length,
        6,
      );
    } finally {
      crowdedPlanner.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A saved decision invalidates a pending planner proposal before approval", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const [target, source] = store.sync(revision, [
        {
          kind: "trace",
          nodeId: "record",
          plannerRound: { identity: revision, attempt: 1 },
        },
        { kind: "impact", nodeId: "app" },
      ]);
      assert(store.recommendDependencyChanges(
        revision,
        [{
          id: target.id,
          prerequisites: [source.id],
          reason: "Review the asset first.",
        }],
        [],
        {},
        null,
        revision,
      ));
      const proposal = store.list().find(({ id }) => id === target.id)!
        .dependencyRecommendation!;
      store.supersedeStaleDependencyChanges(revision, revision, false);
      assertEquals(
        store.list().find(({ id }) => id === target.id)!
          .dependencyRecommendation?.id,
        proposal.id,
      );
      assert(
        recordSentinelFindingReview(
          path,
          state.revision,
          "finding",
          "confirmed",
          "Reviewed.",
        ),
      );
      assertThrows(() =>
        controlSentinelTask(
          path,
          revision,
          target.id,
          "apply_dependencies",
          proposal.id,
        )
      );
      assertEquals(
        store.list().find(({ id }) => id === target.id)!
          .dependencyRecommendation,
        undefined,
      );
      assertEquals(
        store.list().find(({ id }) => id === target.id)!.prerequisites,
        [],
      );
      assert(
        store.history().some(({ event }) =>
          event === "plan_proposal_superseded"
        ),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("An analyst disposition starts a new persisted model planning round within the same revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  const prompts: string[] = [];
  const makePlanner = () =>
    createSentinelModelPlanner(path, () => ({
      execute(message, send) {
        prompts.push(String(message));
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }));
  const first = makePlanner();
  const second = makePlanner();
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [...snapshot.nodes, {
          id: "second-finding",
          kind: "finding",
          severity: "low",
          label: "Second finding",
        }],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    first.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelPlanner?.status,
      "no_new_assignments",
    );
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "finding",
        "confirmed",
        "Reviewed.",
      ),
    );
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "second-finding",
        "dismissed",
        "Duplicate.",
      ),
    );
    assertEquals(readAdaptiveSentinel(path, state)?.modelPlanner, null);
    const clock = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      clock.exec(
        "UPDATE adaptive_model_attempts SET started = started - 60000",
      );
    } finally {
      clock.close();
    }
    second.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(prompts.length, 2);
    assert(
      prompts[1].includes(
        '"findings":[["second-finding","dismissed"],["finding","confirmed"]]',
      ),
    );
    const adaptive = readAdaptiveSentinel(path, state)!;
    assertEquals(adaptive.modelPlannerHistory.length, 2);
    assertEquals(
      adaptive.modelPlannerHistory.map(({ findingReviewId }) =>
        findingReviewId
      ),
      [undefined, 2],
    );
    assert(
      adaptive.modelPlannerHistory[0].identity !==
        adaptive.modelPlannerHistory[1].identity,
    );
    assert(
      renderSentinelInvestigationMarkdown(state, adaptive).includes(
        "Finding decision #2 · Finding decision #1",
      ),
    );
    const earlierRound = "earlier-evidence:hint:2";
    const store = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
      () => Date.now() + 60_001,
    );
    try {
      store.addCaseHint("Earlier hint.", state.revision);
      const capturedHint = store.addCaseHint(
        "Check the source logs.",
        state.revision,
      );
      assertEquals(Number(capturedHint.lastInsertRowid), 2);
      store.addCaseHint("Unrelated later hint.", state.revision);
      assertEquals(
        store.claimModelPlan(earlierRound, {
          incidentReviewId: 42,
          hintIds: [2, 1],
        }),
        1,
      );
      store.completeModelPlan(earlierRound, 1, true);
      store.sync(adaptive.revision, [{
        kind: "trace",
        nodeId: "record",
        plannerRound: { identity: earlierRound, attempt: 1, hintId: 2 },
      }], adaptive.revision);
    } finally {
      store.close();
    }
    for (let index = 0; index < 6; index++) {
      assert(
        recordSentinelFindingReview(
          path,
          state.revision,
          "finding",
          "confirmed",
          `Later decision ${index}`,
        ),
      );
    }
    for (
      const view of [
        readAdaptiveSentinel(path, state, "revision"),
        readHistoricalAdaptiveSentinel(path, state.revision),
      ]
    ) {
      assert(view);
      const exported = JSON.parse(
        renderSentinelProvenanceJson(
          "main",
          {
            ...state,
            findingReviews: readSentinelFindingReviews(path, state.revision),
          },
          view,
          path,
        ),
      );
      const task = exported.provenance.nodes.find((
        node: { plannerRound?: { identity: string } },
      ) => node.plannerRound?.identity === earlierRound);
      assert(task);
      const attempt = exported.planningAttempts.find((
        item: { identity: string; attempt: number },
      ) =>
        item.identity === task.plannerRound.identity &&
        item.attempt === task.plannerRound.attempt
      );
      assertEquals(attempt.hintId, 2);
      assertEquals(attempt.hintIds, [2, 1]);
      assertEquals(
        exported.planningHints.map((
          { id, text }: { id: number; text: string },
        ) => [id, text]),
        [[1, "Earlier hint."], [2, "Check the source logs."]],
      );
      assertEquals(attempt.incidentReviewId, 42);
      assertEquals(
        exported.planningAttempts.find((
          { findingReviewId }: { findingReviewId?: number },
        ) => findingReviewId === 2).findingReviewIds,
        [2, 1],
      );
      assert(
        !exported.findingReviews.some(({ id }: { id: number }) => id === 1),
      );
      assertEquals(
        exported.planningDecisions.map((
          { id, kind, note }: { id: number; kind: string; note: string },
        ) => [id, kind, note]),
        [[1, "finding", "Reviewed."], [2, "finding", "Duplicate."]],
      );
      assertEquals(view.modelPlannerHistory.length, 2);
    }
  } finally {
    first.stop();
    second.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("An explicit assignment reuses a held review without changing its disposition", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const [queued] = store.sync(revision, [
        {
          kind: "review_finding",
          nodeId: "finding",
          reason: "Existing automatic review.",
          plannerRound: { identity: revision, attempt: 1 },
        },
      ]);
      assert(
        recordSentinelFindingReview(
          path,
          state.revision,
          "finding",
          "resolved",
          "Reviewed.",
        ),
      );
      advanceAdaptiveSentinel(path, state);
      assertEquals(
        readAdaptiveSentinel(path, state)!.tasks.find(({ id }) =>
          id === queued.id
        )?.heldForDecision,
        true,
      );
      assignSentinelTask(path, revision, "review_finding", "finding");
      const work = readAdaptiveSentinel(path, state)!;
      const assigned = work.tasks.filter(({ kind, nodeId }) =>
        kind === "review_finding" && nodeId === "finding"
      );
      assertEquals(assigned.length, 1);
      assertEquals(assigned[0].id, queued.id);
      assertEquals(assigned[0].status, "completed");
      assertEquals(assigned[0].plannerRound, queued.plannerRound);
      assertEquals(
        readSentinelFindingReviews(path, state.revision)[0].disposition,
        "resolved",
      );
      assert(
        work.notes.some(({ taskId, note }) =>
          taskId === queued.id && note.includes("Previous assignment reason")
        ),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Queued automatic reviews stay held until the analyst reopens the finding", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(
        revision,
        [
          {
            kind: "review_finding",
            nodeId: "finding",
            reason: "Automatic review.",
          },
          { kind: "impact", nodeId: "app", reason: "Unrelated review." },
        ],
        null,
        {
          number: state.revision,
          goal: { id: "goal", label: "Review evidence" },
        },
      );
    } finally {
      store.close();
    }
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "finding",
        "dismissed",
        "Reviewed.",
      ),
    );
    advanceAdaptiveSentinel(path, state);
    const view = readAdaptiveSentinel(path, state)!;
    const held = view.tasks;
    const review = held.find(({ kind }) => kind === "review_finding")!;
    assertEquals([review.status, review.attempts, review.heldForDecision], [
      "queued",
      0,
      true,
    ]);
    assertEquals(review.decisionHold, {
      kind: "finding",
      id: 1,
      revision: state.revision,
      disposition: "dismissed",
    });
    const provenance = buildSentinelProvenance(state.result, view).snapshot();
    const taskNode = provenance.nodes.find(({ sourceId, kind }) =>
      kind === "task" && sourceId === review.id
    );
    assert(taskNode && "decisionHold" in taskNode);
    assertEquals(taskNode.decisionHold, review.decisionHold);
    assertEquals(
      held.find(({ kind }) => kind === "impact")?.status,
      "completed",
    );
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "finding",
        "open",
        "Recheck evidence.",
      ),
    );
    advanceAdaptiveSentinel(path, state);
    const resumed = readAdaptiveSentinel(path, state)!.tasks.find(({ id }) =>
      id === review.id
    )!;
    assertEquals([resumed.status, resumed.attempts, resumed.heldForDecision], [
      "completed",
      1,
      false,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Adaptive planning respects closed finding decisions and explicit operator assignments", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "graph.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "finding",
        "resolved",
        "Control verified.",
      ),
    );
    advanceAdaptiveSentinel(path, state);
    const closed = readAdaptiveSentinel(path, state)!;
    assert(!closed.tasks.some(({ nodeId }) => nodeId === "finding"));
    const planner = createSentinelModelPlanner(path, () => ({
      execute(_message, send) {
        send({
          type: "response",
          text: '[{"kind":"review_finding","nodeId":"finding"}]',
          taint: "INTERNAL",
        });
        return Promise.resolve();
      },
      clear() {},
    }));
    try {
      planner.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const checked = readAdaptiveSentinel(path, state)!;
      assertEquals(checked.modelPlanner?.status, "proposal_rejected");
      assert(!checked.tasks.some(({ nodeId }) => nodeId === "finding"));
    } finally {
      planner.stop();
    }
    assignSentinelTask(path, closed.revision, "review_finding", "finding");
    advanceAdaptiveSentinel(path, state);
    const assigned = readAdaptiveSentinel(path, state)!;
    assert(
      assigned.tasks.some(({ kind, nodeId }) =>
        kind === "review_finding" && nodeId === "finding"
      ),
    );
    assert(
      !assigned.tasks.some(({ kind }) => kind === "verify_control_coverage"),
    );
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        "finding",
        "open",
        "Review again.",
      ),
    );
    advanceAdaptiveSentinel(path, state);
    assert(
      readAdaptiveSentinel(path, state)!.tasks.some(({ kind }) =>
        kind === "verify_control_coverage"
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Adaptive Sentinel generates worker follow-ups from discoveries and keeps explicit provenance", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    const empty = startSentinelAssessment(path, {
      goal: '"app" defensive coverage',
    });
    advanceAdaptiveSentinel(path, empty);
    assertEquals(readAdaptiveSentinel(path, empty), null);

    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, first);
    const result = readAdaptiveSentinel(path, first)!;
    assertEquals(result.tasks.map(({ kind }) => kind), [
      "review_finding",
      "verify_control_coverage",
      "review_evidence",
      "trace",
    ]);
    assert(result.tasks.every(({ status }) => status === "completed"));
    const [review, controlCheck] = result.tasks;
    assertEquals(controlCheck.prerequisites, [review.id]);
    const provenance = buildSentinelProvenance(first.result, result).snapshot();
    assert(provenance.edges.some(({ relation }) => relation === "produces"));
    assert(
      provenance.edges.some(({ relation, from }) =>
        relation === "prompted" && from === "evidence:record"
      ),
    );

    advanceAdaptiveSentinel(path, first);
    assertEquals(readAdaptiveSentinel(path, first)?.tasks.length, 4);
    stopSentinelAssessment(path);
    const stopped = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, stopped);
    assertEquals(readAdaptiveSentinel(path, stopped)?.tasks.length, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Model planner suggestions are restricted to graph records and approved analysis", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const current = startSentinelAssessment(path);
    assertEquals(validateSentinelPlanSuggestions(current, "[]"), []);
    assertEquals(
      validateSentinelPlanSuggestions(current, "{broken"),
      undefined,
    );
    assertEquals(
      validateSentinelPlanSuggestions(
        current,
        '[{"kind":"impact","nodeId":"unknown"}]',
      ),
      undefined,
    );
    const suggestions = acceptSentinelPlanSuggestions(
      current,
      JSON.stringify([
        { kind: "review_evidence", nodeId: "record" },
        { kind: "review_finding", nodeId: "missing" },
        { kind: "impact", nodeId: "finding" },
        { kind: "shell", nodeId: "app" },
      ]),
    );
    assertEquals(suggestions.map(({ kind }) => kind), ["review_evidence"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Planner cites only evidence delivered by a saved target review", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  let delivered: unknown;
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    execute(message, send) {
      if (!taskId) {
        const input = JSON.parse(String(message).split("\n").at(-1)!);
        const source = input.workerObservations.find(
          (entry: { nodeId: string }) => entry.nodeId === "app",
        );
        delivered = source.modelReviewRelatedNodeIds;
        send({
          type: "response",
          taint: "INTERNAL",
          text: JSON.stringify([
            { kind: "trace", nodeId: "observed", sourceTaskId: source.taskId },
            {
              kind: "review_evidence",
              nodeId: "omitted",
              sourceTaskId: source.taskId,
              sourceKind: "model_review",
            },
            {
              kind: "review_evidence",
              nodeId: "observed",
              sourceTaskId: source.taskId,
              sourceKind: "model_review",
            },
          ]),
        });
      }
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Application", kind: "asset" },
          { id: "observed", label: "Returned record", kind: "evidence" },
          { id: "omitted", label: "Omitted record", kind: "evidence" },
        ],
        edges: ["observed", "omitted"].map((from) => ({
          from,
          relation: "observed_on",
          to: "app",
        })),
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    let sourceTaskId: string;
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON)!;
      sourceTaskId = claim.task.id;
      assert(store.finishModelReview(revision, sourceTaskId, claim.token, {
        note: "The target returned a linked record.",
        steps: [{
          tool: "sentinel_assigned_target",
          target: "app",
          outcome: "returned",
          assignedTarget: { targetId: "app", linkedNodeIds: ["observed"] },
        }],
      }));
    } finally {
      store.close();
    }
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(delivered, ["observed"]);
    const adaptive = readAdaptiveSentinel(path, state)!;
    const tasks = adaptive.tasks;
    const followUp = tasks.find(({ nodeId }) => nodeId === "observed");
    assertEquals(followUp?.kind, "review_evidence");
    assertEquals(followUp?.prerequisites, [sourceTaskId]);
    assertEquals(followUp?.evidenceIds, ["observed"]);
    assertEquals(followUp?.plannerRound?.sourceKind, "model_review");
    assertEquals(
      adaptive.modelPlannerHistory.flatMap(({ inputManifest }) =>
        inputManifest?.workerObservations.find(({ taskId }) =>
          taskId === sourceTaskId
        )?.modelReviewRelatedNodeIds ?? []
      ),
      ["observed"],
    );
    assert(!tasks.some(({ nodeId }) => nodeId === "omitted"));
    planner.stop();
    const inventory = JSON.parse(await Deno.readTextFile(path));
    inventory.nodes.push({
      id: "new",
      label: "Unrelated asset",
      kind: "asset",
    });
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const next = refreshSentinelAssessment(path)!;
    assert(next.revision > state.revision);
    advanceAdaptiveSentinel(path, next);
    const nextAdaptive = readAdaptiveSentinel(path, next)!;
    const carried = nextAdaptive.tasks.find(({ nodeId }) =>
      nodeId === "observed"
    );
    assertEquals(carried?.plannerRound?.priorAssignedTargetCitations, [{
      sourceTaskId,
      evidenceRevision: state.revision,
      targetId: "observed",
      stepIndex: 0,
    }]);
    assertEquals(carried?.plannerRound?.workerSources, undefined);
    assertEquals(carried?.evidenceIds, ["observed"]);
    const graph = buildSentinelProvenance(next.result, nextAdaptive).snapshot();
    const historicEvidence = graph.nodes.find((node) =>
      "priorAssignedTarget" in node &&
      node.priorAssignedTarget?.sourceTaskId === sourceTaskId
    );
    assert(historicEvidence);
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === historicEvidence.id && to.endsWith(carried!.id) &&
        relation === "prompted"
      ),
    );
    const cooldown = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      cooldown.exec("UPDATE adaptive_model_attempts SET started = 0");
    } finally {
      cooldown.close();
    }
    const secondSourceStore = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
    );
    try {
      secondSourceStore.sync(adaptiveRevision(next), [{
        kind: "trace",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], adaptiveRevision(next));
    } finally {
      secondSourceStore.close();
    }
    advanceAdaptiveSentinel(path, next);
    const companion = readAdaptiveSentinel(path, next)!.tasks.find(
      ({ kind, nodeId }) => kind === "trace" && nodeId === "app",
    );
    assert(companion?.status === "completed");
    let planned = false;
    const nextPlanner = createSentinelModelPlanner(path, (_state, taskId) => ({
      execute(message, send) {
        if (taskId) {
          send({
            type: "response",
            text:
              '{"summary":"The carrier retained the historical evidence.","followUps":[]}',
            taint: "INTERNAL",
          });
          return Promise.resolve();
        }
        const input = JSON.parse(String(message).split("\n").at(-1)!);
        const carrier = input.workerObservations.find(
          (entry: { taskId: string }) => entry.taskId === carried!.id,
        );
        const [citation] = carrier.priorAssignedTargetCitations;
        planned = true;
        send({
          type: "response",
          text: JSON.stringify([
            {
              kind: "trace",
              nodeId: "omitted",
              workerSources: [{
                taskId: carried!.id,
                kind: "worker_result",
                priorAssignedTargetCitation: {
                  ...citation,
                  targetId: "omitted",
                },
              }, { taskId: companion.id, kind: "worker_result" }],
            },
            {
              kind: "trace",
              nodeId: "observed",
              workerSources: [{
                taskId: carried!.id,
                kind: "worker_result",
                priorAssignedTargetCitation: citation,
              }, { taskId: companion.id, kind: "worker_result" }],
            },
          ]),
          taint: "INTERNAL",
        });
        return Promise.resolve();
      },
      clear() {},
    }));
    try {
      nextPlanner.advance(next);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(planned);
      const replanned = readAdaptiveSentinel(path, next)!;
      const followUp = replanned.tasks.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "observed"
      );
      assertEquals(followUp?.prerequisites, [carried!.id, companion.id].sort());
      assertEquals(followUp?.evidenceIds, ["observed"]);
      assertEquals(
        followUp?.plannerRound?.priorAssignedTargetCitations,
        carried!.plannerRound!.priorAssignedTargetCitations,
      );
      assert(!replanned.tasks.some(({ nodeId }) => nodeId === "omitted"));
      assertEquals(
        replanned.modelPlannerHistory.flatMap(({ inputManifest }) =>
          inputManifest?.workerObservations.find(({ taskId }) =>
            taskId === carried!.id
          )?.priorAssignedTargetCitations ?? []
        ),
        carried!.plannerRound!.priorAssignedTargetCitations,
      );
    } finally {
      nextPlanner.stop();
    }

    inventory.nodes.push({
      id: "another-asset",
      label: "Another unrelated asset",
      kind: "asset",
    });
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const later = refreshSentinelAssessment(path)!;
    assert(later.revision > next.revision);
    advanceAdaptiveSentinel(path, later);
    const successor = readAdaptiveSentinel(path, later)!.tasks.find(
      ({ kind, nodeId }) => kind === "trace" && nodeId === "observed",
    );
    assertEquals(
      successor?.plannerRound?.priorAssignedTargetCitations,
      carried!.plannerRound!.priorAssignedTargetCitations,
    );

    inventory.nodes.find(({ id }: { id: string }) => id === "observed").label =
      "Changed record";
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const changed = refreshSentinelAssessment(path)!;
    assert(changed.revision > later.revision);
    advanceAdaptiveSentinel(path, changed);
    assert(
      !readAdaptiveSentinel(path, changed)!.tasks.some(({ plannerRound }) =>
        plannerRound?.priorAssignedTargetCitations?.length
      ),
    );
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("An exact assigned-target read can drive a scoped worker follow-up", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    execute(_message, send, _signal, trace) {
      if (taskId) {
        trace?.({
          tool: "sentinel_assigned_target",
          target: "app",
          outcome: "returned",
          assignedTarget: {
            targetId: "app",
            linkedNodeIds: ["observed", "unrelated"],
          },
        });
      }
      send({
        type: "response",
        taint: "INTERNAL",
        text: taskId
          ? JSON.stringify({
            summary: "The assigned target returned a linked record.",
            followUps: [
              { kind: "review_evidence", nodeId: "observed" },
              { kind: "review_evidence", nodeId: "unrelated" },
            ],
          })
          : '[{"kind":"impact","nodeId":"app"}]',
      });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", label: "Application", kind: "asset" },
          { id: "observed", label: "Saved sensor record", kind: "evidence" },
          { id: "unrelated", label: "Unrelated record", kind: "evidence" },
        ],
        edges: [{ from: "observed", relation: "observed_on", to: "app" }],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = readAdaptiveSentinel(path, state)!;
    const assignment = result.tasks.find(({ kind }) => kind === "impact")!;
    const followUp = result.tasks.find(({ nodeId }) => nodeId === "observed");
    assert(followUp);
    assertEquals(followUp.evidenceIds, ["observed"]);
    assertEquals(followUp.prerequisites, [assignment.id]);
    assertEquals(followUp.reviewedFrom, assignment.id);
    assert(!result.tasks.some(({ nodeId }) => nodeId === "unrelated"));
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Model planner inserts a new assignment and attaches an isolated worker review", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  let workerSessions = 0;
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const planner = createSentinelModelPlanner(path, () => {
      workerSessions++;
      return {
        execute(message, send, _signal, trace) {
          trace?.({
            tool: "sentinel_impact",
            target: "app",
            outcome: "returned",
          });
          const text = String(message).includes("Output a JSON array")
            ? JSON.stringify([
              { kind: "impact", nodeId: "app" },
              { kind: "trace", nodeId: "record", dependsOn: [0] },
            ])
            : String(message).includes('"target":"record"')
            ? JSON.stringify({
              summary: "The evidence connects to a reported finding.",
              followUps: [
                { kind: "trace", nodeId: "finding" },
                { kind: "shell", nodeId: "record" },
              ],
            })
            : "The selected application has no known dependents in the supplied graph.";
          send({ type: "response", text, taint: "INTERNAL" });
          return Promise.resolve();
        },
        clear() {},
      };
    });
    try {
      planner.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = readAdaptiveSentinel(path, state)!;
      const assignment = result.tasks.find(({ kind }) => kind === "impact")!;
      assertEquals(assignment.status, "completed");
      assert(
        result.notes.some(({ taskId, note }) =>
          taskId === assignment.id && note.includes("no known dependents")
        ),
      );
      assertEquals(
        result.notes.find(({ taskId }) => taskId === assignment.id)?.steps,
        [
          { tool: "sentinel_impact", target: "app", outcome: "returned" },
        ],
      );
      const trace = result.tasks.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      )!;
      assert(
        result.notes.some(({ taskId, note }) =>
          taskId === trace.id && note.includes("connects to a reported finding")
        ),
      );
      const followUp = result.tasks.find(({ reviewedFrom }) =>
        reviewedFrom === trace.id
      )!;
      assertEquals([followUp.kind, followUp.nodeId, followUp.status], [
        "trace",
        "finding",
        "completed",
      ]);
      assertEquals(followUp.prerequisites, [trace.id]);
      const provenance = buildSentinelProvenance(state.result, result)
        .snapshot();
      const modelReview = provenance.nodes.find(({ label, sourceId }) =>
        label === "Model review" && sourceId === trace.id
      )!;
      assert(
        provenance.edges.some(({ from, relation, to }) =>
          from === modelReview.id && relation === "prompted" &&
          to.endsWith(followUp.id)
        ),
      );
      assert("modelReview" in modelReview);
      assertEquals(
        modelReview.modelReview?.summary,
        "The evidence connects to a reported finding.",
      );
      assertEquals(modelReview.modelReview?.steps[0]?.tool, "sentinel_impact");
      assert(
        provenance.edges.some(({ from, relation, to }) =>
          from === modelReview.id && relation === "references" &&
          to === "asset:app"
        ),
      );
      assert(
        provenance.nodes.some((node) =>
          "modelReview" in node && node.modelReview?.taskId === assignment.id
        ),
      );
      assertEquals(workerSessions, 4);
      let repeatedCalls = 0;
      const rotated = createSentinelModelPlanner(path, () => ({
        execute() {
          repeatedCalls++;
          return Promise.resolve();
        },
        clear() {},
      }));
      try {
        rotated.advance(state);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(repeatedCalls, 0);
        const expanded = {
          ...snapshot,
          nodes: [...snapshot.nodes, {
            id: "dependent",
            kind: "asset",
            label: "Dependent service",
          }],
        };
        await Deno.writeTextFile(path, JSON.stringify(expanded));
        const unrelated = refreshSentinelAssessment(path)!;
        advanceAdaptiveSentinel(path, unrelated);
        assert(
          !readAdaptiveSentinel(path, unrelated)!.tasks.some(
            ({ kind }) => kind === "impact",
          ),
        );
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            ...expanded,
            edges: [...expanded.edges, {
              from: "dependent",
              to: "app",
              relation: "depends_on",
            }],
          }),
        );
        const changed = refreshSentinelAssessment(path)!;
        advanceAdaptiveSentinel(path, changed);
        const previousChild = readAdaptiveSentinel(path, changed)!.tasks.find(
          ({ kind, nodeId }) => kind === "trace" && nodeId === "record",
        );
        const originalChild = result.tasks.find(({ kind, nodeId }) =>
          kind === "trace" && nodeId === "record"
        )!;
        assertEquals(originalChild.prerequisites, [assignment.id]);
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            ...expanded,
            edges: [...expanded.edges, {
              from: "dependent",
              to: "app",
              relation: "depends_on",
            }],
            nodes: expanded.nodes.map((node) =>
              node.id === "record"
                ? { ...node, label: "Revised evidence" }
                : node
            ),
          }),
        );
        const revisedChildEvidence = refreshSentinelAssessment(path)!;
        advanceAdaptiveSentinel(path, revisedChildEvidence);
        const chain = readAdaptiveSentinel(path, revisedChildEvidence)!;
        const parent = chain.tasks.find(({ kind }) => kind === "impact")!;
        const child = chain.tasks.find(({ kind, nodeId }) =>
          kind === "trace" && nodeId === "record"
        )!;
        assertEquals(child.status, "completed");
        assertEquals(child.prerequisites, [parent.id]);
        assertEquals(parent.attempts, 0);
        const archivedParent = readAdaptiveSentinel(path, changed)!.tasks.find(
          ({ kind }) => kind === "impact",
        )!;
        const archivedObservation = readSentinelWorkerObservation(
          path,
          changed.revision,
          { task: archivedParent.id },
        );
        assertEquals(typeof archivedObservation, "string");
        assertEquals(
          readSentinelWorkerObservation(
            path,
            revisedChildEvidence.revision,
            { task: parent.id },
          ),
          archivedObservation,
        );
        assertEquals(
          readSentinelWorkerObservation(
            path,
            revisedChildEvidence.revision,
            { task: archivedParent.id },
          ),
          undefined,
        );
        assertEquals(
          readSentinelWorkerObservation(
            path,
            changed.revision,
            { task: parent.id },
          ),
          undefined,
        );
        const parentCompletion = chain.history.findIndex(({ event, taskId }) =>
          event === "result_reused" && taskId === parent.id
        );
        assert(
          !chain.history.some(({ event, taskId }) =>
            event === "claimed" && taskId === parent.id
          ),
        );
        const childClaim = chain.history.findIndex(({ event, taskId }) =>
          event === "claimed" && taskId === child.id
        );
        assert(childClaim >= 0 && parentCompletion > childClaim);
        assert(
          chain.history.some(({ event, taskId, note }) =>
            event === "reopened" && taskId === child.id &&
            !!note?.includes(previousChild?.id ?? originalChild.id)
          ),
        );
        const revised = readAdaptiveSentinel(path, changed)!;
        const impact = revised.tasks.find(({ kind }) => kind === "impact")!;
        assertEquals(impact.status, "completed");
        assert(
          revised.history.some(({ event, taskId, note }) =>
            event === "reopened" && taskId === impact.id &&
            !!note?.includes(assignment.id)
          ),
        );
      } finally {
        rotated.stop();
      }
    } finally {
      planner.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("New case hints schedule a fresh model round without replacing the evidence plan", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const prior = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
      () => Date.now() - 61_000,
    );
    let pendingId = "";
    let obsoleteId = "";
    try {
      const identity = adaptiveRevision(state);
      assertEquals(prior.claimModelPlan(identity), 1);
      prior.completeModelPlan(identity, 1, "no_new_assignments");
      const plannerRound = { identity, attempt: 1 };
      const queue = prior.sync(identity, [
        { kind: "trace", nodeId: "finding", plannerRound },
        { kind: "trace", nodeId: "record", plannerRound },
      ], identity);
      pendingId = queue.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "finding"
      )!.id;
      obsoleteId = queue.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      )!.id;
    } finally {
      prior.close();
    }

    addSentinelCaseHint(path, "Check the application dependency records.");
    addSentinelCaseHint(path, "Focus on the application service.");
    let prompts = 0;
    const planner = createSentinelModelPlanner(path, () => ({
      execute(message, send) {
        if (String(message).includes("Output a JSON array")) {
          prompts++;
          assert(String(message).includes("Focus on the application service."));
          assert(String(message).includes(pendingId));
          send({
            type: "response",
            text: JSON.stringify({
              assignments: [{ kind: "impact", nodeId: "app" }],
              prioritize: [pendingId],
              retire: [{
                id: obsoleteId,
                reason: "The evidence was already reviewed.",
              }],
            }),
            taint: "INTERNAL",
          });
        } else {
          send({
            type: "response",
            text: "The existing graph contains the service.",
            taint: "INTERNAL",
          });
        }
        return Promise.resolve();
      },
      clear() {},
    }));
    try {
      planner.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = readAdaptiveSentinel(path, state)!;
      assertEquals(result.revision, adaptiveRevision(state));
      assertEquals(
        result.tasks.find(({ id }) => id === obsoleteId)?.retirementReason,
        "The evidence was already reviewed.",
      );
      assertEquals(result.modelPlannerHistory.at(-1)?.outcome, "completed");
      assert(
        result.history.some(({ taskId, event }) =>
          taskId === pendingId && event === "planner_prioritized"
        ),
      );
      assertEquals(
        result.modelPlannerHistory.map((
          { outcome, hintId },
        ) => [outcome, hintId]),
        [
          ["no_new_assignments", undefined],
          ["completed", 2],
        ],
      );
      assertEquals(
        result.tasks.find(({ kind }) => kind === "impact")?.plannerRound,
        {
          identity: result.modelPlannerHistory.at(-1)!.identity,
          attempt: 1,
          hintId: 2,
        },
      );
      planner.advance(state);
      assertEquals(prompts, 1);
    } finally {
      planner.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A new case hint supersedes an in-flight plan before it can enqueue assignments", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const entered = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const planner = createSentinelModelPlanner(path, () => ({
      async execute(_message, send) {
        entered.resolve();
        await complete.promise;
        send({
          type: "response",
          text: '[{"kind":"impact","nodeId":"app"}]',
          taint: "INTERNAL",
        });
      },
      clear() {},
    }), () => () => released.resolve());
    try {
      planner.advance(state);
      await entered.promise;
      addSentinelCaseHint(path, "Review the control evidence instead.");
      complete.resolve();
      await released.promise;
      const result = readAdaptiveSentinel(path, state)!;
      assertEquals(result.modelPlannerHistory[0].outcome, "superseded");
      assert(!result.tasks.some(({ kind }) => kind === "impact"));
    } finally {
      planner.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A hint saved before model dispatch supersedes the claimed round without a provider call", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const released = Promise.withResolvers<void>();
  let calls = 0;
  const planner = createSentinelModelPlanner(path, () => ({
    execute() {
      calls++;
      return Promise.resolve();
    },
    clear() {},
  }), () => () => released.resolve());
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    assert(planner.hasInFlightWork());
    addSentinelCaseHint(path, "Review the updated operator guidance.");
    await released.promise;
    assertEquals(calls, 0);
    const attempt = readAdaptiveSentinel(path, state)?.modelPlannerHistory[0];
    assertEquals(attempt?.inputManifest, undefined);
    assertEquals(
      attempt?.outcome,
      "superseded",
    );
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Captured traffic creates a scoped evidence review and dependent asset trace", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const evidence = ["older", "latest", "other"];
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "web", kind: "asset", label: "Web service" },
          { id: "other", kind: "asset", label: "Other service" },
          ...evidence.map((name, index) => ({
            id: `har:evidence:${name}`,
            kind: "evidence",
            label: `HAR at 2026-01-01T00:00:0${index}.000Z`,
          })),
        ],
        edges: evidence.map((name) => ({
          from: `har:evidence:${name}`,
          to: name === "other" ? "other" : "web",
          relation: "observed_on",
        })),
      }),
    );
    const state = startSentinelAssessment(path, { traceNode: "web" });
    advanceAdaptiveSentinel(path, state);
    const tasks = readAdaptiveSentinel(path, state)?.tasks;
    assert(tasks);
    assertEquals(tasks.map(({ kind, nodeId }) => [kind, nodeId]), [
      ["review_evidence", "har:evidence:latest"],
      ["trace", "web"],
    ]);
    assertEquals(tasks[1].prerequisites, [tasks[0].id]);
    assertEquals(tasks[1].evidenceIds, ["har:evidence:latest"]);
    assert(tasks.every(({ status }) => status === "completed"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Completed operator investigations reopen only after their results change", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, first);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      const revision = store.activeRevision()!;
      store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        depth: 3,
        reason: "Assigned by the operator in Tidepool.",
      }], revision);
    } finally {
      store.close();
    }
    advanceAdaptiveSentinel(path, first);
    const original = readAdaptiveSentinel(path, first)!.tasks.find(
      ({ kind, depth }) => kind === "trace" && depth === 3,
    )!;
    assertEquals(original.status, "completed");

    const unrelated = {
      ...snapshot,
      nodes: [...snapshot.nodes, {
        id: "other",
        label: "Other",
        kind: "asset",
      }],
    };
    await Deno.writeTextFile(path, JSON.stringify(unrelated));
    const second = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, second);
    assert(
      !readAdaptiveSentinel(path, second)!.tasks.some(
        ({ kind, depth }) => kind === "trace" && depth === 3,
      ),
    );

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...unrelated,
        nodes: unrelated.nodes.map((node) =>
          node.id === "record"
            ? { ...node, label: "Updated source record" }
            : node
        ),
      }),
    );
    const third = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, third);
    advanceAdaptiveSentinel(path, third);
    const current = readAdaptiveSentinel(path, third)!;
    const reopened = current.tasks.filter(
      ({ kind, depth }) => kind === "trace" && depth === 3,
    );
    assertEquals(reopened.length, 1);
    assertEquals(reopened[0].status, "completed");
    assertEquals(reopened[0].evidenceIds, ["record"]);
    assert(
      buildSentinelProvenance(third.result, current).snapshot().edges.some(
        ({ from, relation }) =>
          from === "evidence:record" && relation === "prompted",
      ),
    );
    const events = current.history.filter(({ event, taskId }) =>
      event === "reopened" && taskId === reopened[0].id
    );
    const plannerEvents = current.history.filter(({ event, taskId }) =>
      event === "reopened" && taskId !== reopened[0].id
    );
    assert(plannerEvents.length > 0);
    assertEquals(events.length, 1);
    assert(events[0].note?.includes(original.id));
    assertEquals(
      findSentinelTaskEvidence(path, original.id, third.revision),
      first.revision,
    );
    const targetStore = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
    );
    try {
      const revision = targetStore.activeRevision()!;
      targetStore.sync(revision, [{
        kind: "trace",
        nodeId: "record",
        depth: 3,
        reason: "Assigned by the operator in Tidepool.",
      }], revision);
    } finally {
      targetStore.close();
    }
    advanceAdaptiveSentinel(path, third);
    const targetTask = readAdaptiveSentinel(path, third)!.tasks.find(
      ({ nodeId, kind, depth }) =>
        nodeId === "record" && kind === "trace" && depth === 3,
    )!;
    assertEquals(targetTask.status, "completed");
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...unrelated,
        nodes: unrelated.nodes.filter(({ id }) => id !== "record"),
        edges: unrelated.edges.filter(({ from }) => from !== "record"),
      }),
    );
    const fourth = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, fourth);
    const afterRemoval = readAdaptiveSentinel(path, fourth)!;
    const reopenedTrace = afterRemoval.tasks.find(({ kind, depth }) =>
      kind === "trace" && depth === 3
    )!;
    const removal = afterRemoval.history.find(({ event, taskId }) =>
      event === "reopened" && taskId === reopenedTrace.id
    )!;
    assertEquals(removal.removedEvidenceIds, ["record"]);
    assertEquals(reopenedTrace.evidenceIds, []);
    assert(removal.note?.includes(reopened[0].id));
    const unavailable = afterRemoval.history.filter(({ event, taskId }) =>
      event === "assignment_unavailable" && taskId === targetTask.id
    );
    assertEquals(unavailable.length, 1);
    assertEquals(unavailable[0].nodeId, "record");
    assertEquals(
      findSentinelTaskEvidence(path, targetTask.id, fourth.revision),
      third.revision,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A replan restarts claimed operator work on current evidence and rejects stale results", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    const graph = {
      ...snapshot,
      nodes: [...snapshot.nodes, {
        id: "removed",
        kind: "asset",
        label: "Removed asset",
      }],
    };
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const first = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, first);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    const stale = (() => {
      try {
        const revision = store.activeRevision()!;
        store.sync(
          revision,
          ["app", "removed"].map((nodeId) => ({
            kind: "impact" as const,
            nodeId,
            depth: 2,
            reason: "Assigned by the operator in Tidepool.",
          })),
          revision,
        );
        const claim = store.claim(revision);
        assert(claim);
        assertEquals(claim.task.nodeId, "app");
        return claim;
      } finally {
        store.close();
      }
    })();
    assert(pauseSentinelAssessment(path));
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "app" ? { ...node, label: "Intermediate label" } : node
        ),
      }),
    );
    const paused = refreshSentinelAssessment(path)!;
    assertEquals(paused.revision, first.revision);
    advanceAdaptiveSentinel(path, paused);
    const intermediate = resumeSentinelAssessment(path)!;
    assertEquals(intermediate.revision, first.revision + 1);

    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const next = refreshSentinelAssessment(path)!;
    assertEquals(next.revision, first.revision + 2);
    advanceAdaptiveSentinel(path, next);
    const reopened = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
    );
    try {
      assertThrows(() =>
        reopened.complete({
          taskId: stale.task.id,
          leaseToken: stale.leaseToken,
          observation: { stale: true },
        })
      );
    } finally {
      reopened.close();
    }
    const prior = readAdaptiveSentinel(path, first)!.tasks.find(
      (task) => task.kind === "impact" && task.nodeId === "app",
    );
    const current = readAdaptiveSentinel(path, next)!;
    assert(prior);
    assertEquals(
      findSentinelTaskEvidence(path, prior.id, next.revision),
      first.revision,
    );
    assertEquals(
      findSentinelTaskEvidence(path, prior.id, first.revision),
      undefined,
    );
    const carried = current.history.filter(({ event }) =>
      event === "carried_forward"
    );
    assertEquals(carried.length, 1);
    assert(carried[0].note?.includes(prior.id));
    const tasks = current.tasks;
    assert(
      tasks.some((task) =>
        task.kind === "impact" && task.nodeId === "app" &&
        task.status === "completed"
      ),
    );
    assert(!tasks.some((task) => task.nodeId === "removed"));
    const old = readAdaptiveSentinel(path, first, "revision")!;
    const unavailable = old.history.filter(({ event }) =>
      event === "assignment_unavailable"
    );
    assertEquals(unavailable.length, 1);
    assertEquals(unavailable[0].nodeId, "removed");
    assert(unavailable[0].note?.includes(`evidence revision ${next.revision}`));
    advanceAdaptiveSentinel(path, next);
    assertEquals(
      readAdaptiveSentinel(path, first, "revision")!.history.filter(
        ({ event }) => event === "assignment_unavailable",
      ).length,
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Recurring evidence gets its own adaptive history while existing mapped plans remain readable", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = startSentinelAssessment(path);
    const legacy = adaptiveRevision(first, true);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(legacy, [], null, {
        number: first.revision,
        goal: {
          id: first.plan.runId!,
          label: "Investigate prioritized defensive findings",
        },
      });
      store.addNote(legacy, "Original plan marker.");
    } finally {
      store.close();
    }
    advanceAdaptiveSentinel(path, first);
    assertEquals(readAdaptiveSentinel(path, first)?.revision, legacy);

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === "app" ? { ...node, label: "Changed label" } : node
        ),
      }),
    );
    advanceAdaptiveSentinel(path, refreshSentinelAssessment(path)!);
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const again = refreshSentinelAssessment(path)!;
    assertEquals(adaptiveRevision(again, true), legacy);
    advanceAdaptiveSentinel(path, again);
    const current = readAdaptiveSentinel(path, again, "revision")!;
    assertEquals(current.revision, adaptiveRevision(again));
    assert(current.tasks.length > 0);
    assert(!current.notes.some(({ note }) => note === "Original plan marker."));
    assertEquals(
      readAdaptiveSentinel(path, first, "revision")?.notes[0].note,
      "Original plan marker.",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("New evidence aborts obsolete model planning and releases its worker slot", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  let released = 0;
  let workerSignal: AbortSignal | undefined;
  const planner = createSentinelModelPlanner(path, () => ({
    execute(_message, _send, signal) {
      workerSignal = signal;
      return new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    clear() {},
  }), () => () => {
    released++;
  });
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, first);
    planner.advance(first);
    await Promise.resolve();
    assert(workerSignal);
    assert(planner.hasInFlightWork());

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === "app" ? { ...node, label: "New evidence" } : node
        ),
      }),
    );
    const next = refreshSentinelAssessment(path)!;
    planner.advance(next);
    assert(workerSignal.aborted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(planner.hasInFlightWork(), false);
    assertEquals(released, 1);
    assertEquals(
      readAdaptiveSentinel(path, first)?.modelPlanner?.status,
      "superseded",
    );
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

for (
  const [modelResponse, expected, historyOutcome] of [
    ["[]", "no_new_assignments", "no_new_assignments"],
    ["{broken", "proposal_rejected", "proposal_rejected"],
    [null, "retry_pending", "failed"],
  ] as const
) {
  Deno.test(`Model planning records ${expected} for the provider result`, async () => {
    const dir = await Deno.makeTempDir();
    const path = join(dir, "sentinel.json");
    let calls = 0;
    const createPlanner = () =>
      createSentinelModelPlanner(path, () => ({
        execute(_message, send) {
          calls++;
          if (modelResponse === null && calls === 1) {
            send({
              type: "error",
              message: "Provider temporarily unavailable",
            });
          } else {
            send({
              type: "response",
              text: modelResponse ?? "[]",
              taint: "INTERNAL",
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
    const planner = createPlanner();
    const replacement = createPlanner();
    try {
      await Deno.writeTextFile(path, JSON.stringify(snapshot));
      const state = startSentinelAssessment(path);
      advanceAdaptiveSentinel(path, state);
      planner.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const adaptive = readAdaptiveSentinel(path, state)!;
      assertEquals(adaptive.modelPlanner?.status, expected);
      assertEquals(
        adaptive.modelPlannerHistory[0]?.outcome,
        historyOutcome,
      );
      replacement.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(calls, 1);
      if (modelResponse === null) {
        const db = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
        try {
          db.exec("UPDATE adaptive_model_attempts SET started = 0");
        } finally {
          db.close();
        }
        replacement.advance(state);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(calls, 2);
        const recovered = readAdaptiveSentinel(path, state);
        assertEquals(recovered?.modelPlanner, {
          attempt: 2,
          status: "no_new_assignments",
        });
        assertEquals(
          recovered?.modelPlannerHistory.map(({ outcome }) => outcome),
          ["failed", "no_new_assignments"],
        );
      }
    } finally {
      planner.stop();
      replacement.stop();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("A full plan still drains existing work when new suggestions exceed capacity", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(
        revision,
        Array.from({ length: MAX_ADAPTIVE_TASKS }, (_, index) => ({
          kind: "trace" as const,
          nodeId: `imported-${index}`,
        })),
        null,
      );
    } finally {
      store.close();
    }
    advanceAdaptiveSentinel(path, state);
    const plan = readAdaptiveSentinel(path, state)!;
    assertEquals(plan.tasks.length, MAX_ADAPTIVE_TASKS);
    assert(plan.tasks.some(({ attempts }) => attempts > 0));
    assertEquals(plan.taskLimit, MAX_ADAPTIVE_TASKS);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === "app" ? { ...node, label: "Updated evidence" } : node
        ),
      }),
    );
    const next = refreshSentinelAssessment(path)!;
    advanceAdaptiveSentinel(path, next);
    const replanned = readAdaptiveSentinel(path, next)!;
    assert(next.revision > state.revision);
    assert(
      replanned.tasks.some((task) =>
        task.kind === "review_finding" && task.status === "completed"
      ),
    );
    assert(replanned.tasks.length < MAX_ADAPTIVE_TASKS);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

for (const newerObservation of [false, true]) {
  Deno.test(`Gateway approval ${newerObservation ? "rejects" : "applies"} a model-generated prerequisite proposal`, async () => {
    const dir = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(dir, "main");
    const database = join(dirname(path), "sentinel-adaptive.db");
    try {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...snapshot,
          nodes: [...snapshot.nodes, {
            id: "other",
            kind: "asset",
            label: "Other",
          }],
        }),
      );
      const alert = {
        type: "integrity_change" as const,
        asset: "other",
        evidenceIds: ["approval-fixture"],
        severity: "high" as const,
        subject: "Test audit change",
        observedAt: "2026-01-01T00:00:00.000Z",
        triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
      };
      const alertId = sentinelAlertReference(alert);
      await Deno.writeTextFile(
        sentinelAlertsPath(path),
        JSON.stringify([alert]),
      );
      const state = startSentinelAssessment(path);
      advanceAdaptiveSentinel(path, state);
      const revision = adaptiveRevision(state);
      const store = openSentinelAdaptiveStore(database);
      const citationPrerequisite =
        store.list(revision).find(({ kind, status }) =>
          kind === "review_finding" && status === "completed"
        )!.id;
      const citationTarget = store.sync(revision, [{
        kind: "impact",
        nodeId: "other",
        depth: 2,
        prerequisites: [citationPrerequisite],
        reviewedFrom: citationPrerequisite,
        plannerRound: {
          identity: revision,
          attempt: 1,
          sourceKind: "worker_result",
        },
      }], revision).find(({ kind, nodeId, depth }) =>
        kind === "impact" && nodeId === "other" && depth === 2
      )!.id;
      advanceAdaptiveSentinel(path, state);
      const task = {
        kind: "trace" as const,
        nodeId: "finding",
        plannerRound: { identity: revision, attempt: 1 },
      };
      const id =
        store.sync(revision, [task], revision).find(({ kind, nodeId }) =>
          kind === "trace" && nodeId === "finding"
        )!.id;
      store.close();
      const finished = Promise.withResolvers<void>();
      const planner = createSentinelModelPlanner(path, () => ({
        execute(_message, send) {
          send({
            type: "response",
            taint: "INTERNAL",
            text: JSON.stringify({
              assignments: [
                {
                  kind: "impact",
                  nodeId: "other",
                  upstreamCheckId: "cloudtrail_logging_stopped",
                  sourceAlertId: alertId,
                },
                { kind: "impact", nodeId: "app" },
              ],
              prioritize: [],
              dependencies: [{
                id,
                prerequisites: ["new:1"],
                reason: "Check application impact first.",
              }],
            }),
          });
          return Promise.resolve();
        },
        clear() {},
      }), () => () => finished.resolve());
      try {
        planner.advance(state);
        await finished.promise;
        const result = readAdaptiveSentinel(path, state)!;
        const proposal = result.tasks.find((task) => task.id === id)
          ?.dependencyRecommendation;
        assert(proposal);
        assertEquals(proposal.prerequisites, [proposal.additions![0].id]);
        assertEquals(proposal.citations?.[0].evidenceIds, [alertId]);
        assertEquals(
          result.tasks.find(({ id }) => id === citationTarget)?.evidenceIds,
          [],
        );
        assert(
          !result.tasks.some(({ kind, nodeId }) =>
            kind === "impact" && nodeId === "app"
          ),
        );
        if (newerObservation) {
          const writer = openSentinelAdaptiveStore(database);
          try {
            writer.sync(
              revision,
              [{ kind: "trace", nodeId: "record" }],
              revision,
            );
            const lease = writer.claim(revision)!;
            assertEquals(lease.task.nodeId, "record");
            writer.complete({
              taskId: lease.task.id,
              leaseToken: lease.leaseToken,
              observation: { summary: "New independent worker evidence" },
            });
          } finally {
            writer.close();
          }
        }
        const frames: Record<string, unknown>[] = [];
        const handler = createTidepoolSentinelHandler(
          { baseDir: dir, config: {} } as BootstrapResult,
        );
        await handler({
          type: "apply_task_dependencies",
          revision,
          taskId: id,
          proposalId: proposal.id,
        }, {
          readyState: WebSocket.OPEN,
          send(frame: string) {
            frames.push(JSON.parse(frame));
          },
        } as WebSocket);
        const applied = readAdaptiveSentinel(path, state)!;
        const target = applied.tasks.find((task) => task.id === id)!;
        assertEquals(target.dependencyRecommendation, undefined);
        const cited = applied.tasks.find(({ id }) => id === citationTarget)!;
        assertEquals(cited.reviewedFrom, citationPrerequisite);
        assertEquals(cited.plannerRound?.sourceKind, "worker_result");
        assertEquals(cited.prerequisites, [citationPrerequisite]);
        assertEquals(cited.evidenceIds, newerObservation ? [] : [alertId]);
        assertEquals(
          cited.plannerRound?.upstreamCheckId,
          newerObservation ? undefined : "cloudtrail_logging_stopped",
        );
        if (newerObservation) {
          assertEquals(frames[0].type, "error");
          assertEquals(target.prerequisites, []);
          assert(
            !applied.tasks.some(({ kind, nodeId }) =>
              kind === "impact" && nodeId === "app"
            ),
          );
          assert(
            applied.history.some(({ event, taskId }) =>
              event === "plan_proposal_superseded" && taskId === id
            ),
          );
        } else {
          assertEquals(frames[0].type, "sentinel_state");
          const graph = buildSentinelProvenance(state.result, applied, alert)
            .snapshot();
          const sources = graph.edges.filter(({ relation, to }) =>
            relation === "prompted" && to === `task:adaptive:${citationTarget}`
          ).map(({ from }) => from);
          assert(
            sources.includes(`observation:adaptive:${citationPrerequisite}`),
          );
          assert(sources.some((source) => source.endsWith(alertId)));
          assertEquals(target.prerequisites, proposal.prerequisites);
          assert(
            applied.tasks.some(({ id, kind }) =>
              kind === "impact" && id === proposal.prerequisites[0]
            ),
          );
        }
      } finally {
        planner.stop();
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("A scoped assessment can assign incident reviews linked to its asset", () => {
  const result = runSentinelAssessment({
    snapshot,
    alerts: [
      {
        type: "network_security_alert",
        severity: "high",
        asset: "app",
        subject: "network",
        observedAt: "2026-01-01T00:00:00.000Z",
        evidenceIds: ["network"],
      },
      {
        type: "authentication_failure_burst",
        severity: "medium",
        asset: "app",
        subject: "account",
        observedAt: "2026-01-01T00:00:01.000Z",
        evidenceIds: ["auth"],
      },
    ],
  });
  const state = {
    revision: 1,
    active: true,
    paused: false,
    updatedAt: "",
    reviews: [],
    plan: { impactAsset: "app" },
    result,
  };
  const id = sentinelIncidentCandidates(state)[0].id;
  const proposal = JSON.stringify([{ kind: "review_incident", nodeId: id }]);
  const accepted = validateSentinelPlanSuggestions(state, proposal)!;
  assertEquals(accepted[0].nodeId, id);
  assertEquals(accepted[0].evidenceIds, ["auth", "network"]);
  assertEquals(
    validateSentinelPlanSuggestions({
      ...state,
      plan: { impactAsset: "outside" },
    }, proposal),
    undefined,
  );
});

Deno.test("Closing an incident interrupts its automatic model review and suppresses subsequent claims", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const started = Promise.withResolvers<AbortSignal>();
  const released = Promise.withResolvers<void>();
  let reviews = 0;
  const planner = createSentinelModelPlanner(path, () => ({
    async execute(message, send, signal) {
      if (
        !String(message).startsWith(
          "Review this assigned defensive Sentinel task",
        )
      ) {
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return;
      }
      assert(signal);
      reviews++;
      started.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
      send({
        type: "response",
        text: '{"summary":"Late review","followUps":[]}',
        taint: "INTERNAL",
      });
    },
    clear() {},
  }), () => () => released.resolve());
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        ["network_security_alert", "high"],
        ["authentication_failure_burst", "medium"],
      ].map(([type, severity]) => ({
        type,
        severity,
        asset: "app",
        subject: type,
        observedAt: "2026-01-01T00:00:00.000Z",
        evidenceIds: [type],
      }))),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const incident = sentinelIncidentCandidates(state)[0];
    assert(incident && typeof incident.id === "string");
    planner.advance(state);
    const signal = await started.promise;
    assert(
      recordSentinelIncidentReview(
        path,
        state.revision,
        incident.id,
        "resolved",
        "Confirmed by operator.",
      ),
    );
    planner.advance(state);
    assert(signal.aborted);
    await released.promise;
    const held = readAdaptiveSentinel(path, state);
    assertEquals(held?.modelReviews, []);
    assertEquals(
      held?.modelReviewStates.map(({ status, retryable }) => ({
        status,
        retryable,
      })),
      [{ status: "held_by_analyst_decision", retryable: false }],
    );
    assertThrows(
      () =>
        controlSentinelTask(
          path,
          held?.revision,
          held?.modelReviewStates[0].taskId,
          "retry_model_review",
        ),
      Error,
      "no longer eligible",
    );
    planner.advance(state);
    await Promise.resolve();
    assertEquals(reviews, 1);
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A hint saved during a model review reaches planning before the remaining reviews", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const calls: string[] = [];
  const reviewStarted = Promise.withResolvers<void>();
  const releaseFirstReview = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let planningPrompt = "";
  const planner = createSentinelModelPlanner(path, () => ({
    async execute(message, send) {
      const planning = String(message).startsWith(
        "Plan a defensive investigation",
      );
      calls.push(planning ? "plan" : "review");
      if (calls.length === 1) {
        reviewStarted.resolve();
        await releaseFirstReview.promise;
      }
      if (planning) planningPrompt = String(message);
      send({
        type: "response",
        text: planning ? "[]" : '{"summary":"Fixture review","followUps":[]}',
        taint: "INTERNAL",
      });
    },
    clear() {},
  }), () => () => {
    if (calls.length === 3) completed.resolve();
  });
  try {
    const nodes = ["first", "second"].map((id) => ({
      id,
      label: id,
      kind: "asset",
    }));
    const alerts = nodes.flatMap(({ id }) =>
      [["network_security_alert", "high"], [
        "authentication_failure_burst",
        "medium",
      ]]
        .map(([type, severity]) => ({
          type,
          severity,
          asset: id,
          subject: type,
          observedAt: "2026-01-01T00:00:00.000Z",
          evidenceIds: [id + type],
        }))
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes, edges: [] }),
    );
    await Deno.writeTextFile(sentinelAlertsPath(path), JSON.stringify(alerts));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await reviewStarted.promise;
    addSentinelCaseHint(
      path,
      "Prioritize the saved incident evidence.",
    );
    const [hint] = readSentinelCaseHints(path, 1);
    assert(hint);
    releaseFirstReview.resolve();
    await completed.promise;
    assertEquals(calls, ["review", "plan", "review"]);
    assert(planningPrompt.includes(hint.text));
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelPlannerHistory[0].hintIds,
      [hint.id],
    );
  } finally {
    releaseFirstReview.resolve();
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Saved worker observations change the planner round and link cited follow-up tasks", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const database = join(dir, "sentinel-adaptive.db");
  const relatedRecords = Array.from({ length: 21 }, (_, i) => `related-${i}`);
  const deepRecord = relatedRecords.at(-1)!;
  const peerFinding = {
    localAssetId: "app",
    sourceCaseId: "peer",
    sourceAssetId: "peer-app",
    sourceFindingId: "peer-finding",
    snapshotDigest: "a".repeat(64),
  };
  const verifiedPeerFinding = {
    ...peerFinding,
    mappingSources: [
      { caseId: "bridge", snapshotDigest: "c".repeat(64) },
      { caseId: "peer", snapshotDigest: peerFinding.snapshotDigest },
    ],
  };
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          { id: "large-record", kind: "evidence", label: "Large record" },
          ...relatedRecords.map((id) => ({ id, kind: "evidence", label: id })),
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const digest = adaptiveRevision(state);
    const baseline = openSentinelAdaptiveStore(
      database,
      () => Date.now() - 61_000,
    );
    baseline.claimModelPlan(digest);
    baseline.completeModelPlan(digest, 1, "no_new_assignments");
    const saved = baseline.plannerObservations(digest)[0];
    assert(saved);
    baseline.sync(digest, [{ kind: "trace", nodeId: "large-record" }], digest);
    const oversized = baseline.claim(digest)!;
    assertEquals(oversized.task.nodeId, "large-record");
    assert(
      baseline.complete({
        taskId: oversized.task.id,
        leaseToken: oversized.leaseToken,
        observation: {
          summary: "Large worker result",
          content: "x".repeat(7500),
          relatedNodeIds: relatedRecords,
        },
      }),
    );
    const savedResultDigest = createHash("sha256").update(
      JSON.stringify(
        baseline.plannerObservations(digest).find(({ taskId }) =>
          taskId === oversized.task.id
        )?.observation,
      ),
    ).digest("hex");
    baseline.close();
    let calls = 0;
    let plannerPrompt = "";
    const create = () =>
      createSentinelModelPlanner(path, () => ({
        execute(message, send, _signal, trace, traceResultDigests) {
          if (String(message).includes("Output a JSON array")) {
            calls++;
            assert(traceResultDigests);
            trace?.({
              tool: "sentinel_worker_observation",
              target: oversized.task.id,
              outcome: "returned",
              resultSha256: savedResultDigest,
            });
            trace?.({
              tool: "sentinel_shared_finding_source",
              target: peerFinding.sourceFindingId,
              outcome: "returned",
              peerFinding: verifiedPeerFinding,
            });
            plannerPrompt = String(message);
            const input = JSON.parse(plannerPrompt.split("\n").at(-1)!);
            const {
              evidenceIds: _evidenceIds,
              relatedNodeIds: _relatedNodeIds,
              ...promptObservation
            } = saved;
            assertEquals(
              input.workerObservations.find(
                ({ taskId }: { taskId: string }) => taskId === saved.taskId,
              ),
              promptObservation,
            );
            send({
              type: "response",
              text: JSON.stringify([
                {
                  kind: "impact",
                  nodeId: "app",
                  sourceTaskId: saved.taskId,
                  peerFinding: {
                    ...peerFinding,
                    mappingSources: [{ caseId: "untrusted" }],
                  },
                },
                {
                  kind: "trace",
                  nodeId: "record",
                  dependsOn: [0],
                  sourceTaskId: saved.taskId,
                },
                {
                  kind: "trace",
                  nodeId: deepRecord,
                  sourceTaskId: oversized.task.id,
                },
                {
                  kind: "trace",
                  nodeId: "app",
                  peerFinding: {
                    ...peerFinding,
                    snapshotDigest: "b".repeat(64),
                  },
                },
              ]),
              taint: "INTERNAL",
            });
          }
          return Promise.resolve();
        },
        clear() {},
      }));
    const planner = create();
    planner.advance(state);
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    const result = readAdaptiveSentinel(path, state)!;
    const recordedAttempt = result.modelPlannerHistory.find(
      ({ inputManifest }) => inputManifest !== undefined,
    );
    const manifest = recordedAttempt?.inputManifest;
    assert(manifest);
    assertEquals(recordedAttempt?.reads?.[0], {
      tool: "sentinel_worker_observation",
      target: oversized.task.id,
      outcome: "returned",
      resultSha256: savedResultDigest,
    });
    assertEquals(
      manifest.promptSha256,
      createHash("sha256").update(plannerPrompt).digest("hex"),
    );
    const exported = JSON.parse(
      renderSentinelProvenanceJson("main", state, result, path),
    );
    const exportedAttempt = exported.planningAttempts.find(
      ({ inputManifest }: { inputManifest?: unknown }) => inputManifest,
    );
    assertEquals(exportedAttempt?.inputManifest, manifest);
    assertEquals(exportedAttempt?.reads, recordedAttempt?.reads);
    const promptInputs = JSON.parse(plannerPrompt.split("\n").at(-1)!);
    assertEquals(
      manifest.workerObservations,
      promptInputs.workerObservations.map(
        (
          entry: {
            taskId: string;
            observation?: unknown;
            reviewSummary?: unknown;
          },
        ) => ({
          taskId: entry.taskId,
          workerResult: entry.observation !== undefined,
          modelReviewSummary: entry.reviewSummary !== undefined,
        }),
      ),
    );
    assertEquals(
      manifest.workerObservations.find(({ taskId }) =>
        taskId === oversized.task.id
      ),
      {
        taskId: oversized.task.id,
        workerResult: false,
        modelReviewSummary: false,
      },
    );
    const impact = result.tasks.find(({ kind }) => kind === "impact")!;
    const trace = result.tasks.find(({ kind, nodeId }) =>
      kind === "trace" && nodeId === "record"
    )!;
    assertEquals(impact.reviewedFrom, saved.taskId);
    assertEquals(impact.plannerRound?.peerFindingCitations, [
      verifiedPeerFinding,
    ]);
    assertEquals(
      result.tasks.filter((task) =>
        task.plannerRound?.peerFindingCitations?.length
      ).map(({ id }) => id),
      [impact.id],
    );
    assertEquals(impact.prerequisites, [saved.taskId]);
    assertEquals(trace.prerequisites, [saved.taskId, impact.id].sort());
    assertEquals(trace.status, "completed");
    const deepTrace = result.tasks.find(({ kind, nodeId }) =>
      kind === "trace" && nodeId === deepRecord
    );
    assert(deepTrace);
    assertEquals(deepTrace.reviewedFrom, oversized.task.id);
    assertEquals(deepTrace.prerequisites, [oversized.task.id]);
    const graph = buildSentinelProvenance(state.result, result).snapshot();
    const peerNode = graph.nodes.find((node) =>
      "peerFinding" in node &&
      node.peerFinding?.sourceFindingId === peerFinding.sourceFindingId
    );
    assert(peerNode);
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === peerNode.id && to.endsWith(impact.id) &&
        relation === "prompted"
      ),
    );
    const source = graph.nodes.find(({ sourceId, label }) =>
      sourceId === saved.taskId && label === "Adaptive worker observation"
    )!;
    assert(
      graph.edges.some(({ from, relation, to }) =>
        from === source.id && relation === "prompted" && to.endsWith(trace.id)
      ),
    );
    const replacement = create();
    replacement.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    planner.stop();
    replacement.stop();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A new evidence revision retains only peer findings that still match", async () => {
  const dir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(dir);
  const inventory = (aliases: string[]) => ({
    version: 1,
    nodes: [{ id: "app", label: "Local application", kind: "asset", aliases }],
    edges: [],
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify(inventory([
        "stable.example",
        "moved.example",
      ])),
    );
    const sourceCitations = await Promise.all(
      ["stable", "moved"].map(async (peer) => {
        const sourceAssetId = `${peer}-asset`;
        const sourceFindingId = `${peer}-finding`;
        const reporting = loadSentinelGraph({
          version: 1,
          nodes: [
            {
              id: sourceAssetId,
              kind: "asset",
              label: peer,
              ...(peer === "moved" && { aliases: ["moved.example"] }),
            },
            {
              id: sourceFindingId,
              kind: "finding",
              label: `Finding from ${peer}`,
              severity: "high",
            },
          ],
          edges: [{
            from: sourceFindingId,
            to: sourceAssetId,
            relation: "affects",
          }],
        }).snapshot();
        const snapshotDigest = digestSentinelSnapshot(reporting);
        const archive = sentinelSourceSnapshotPath(dir, peer, snapshotDigest);
        await Deno.mkdir(dirname(archive), { recursive: true });
        await Deno.writeTextFile(archive, JSON.stringify(reporting), {
          mode: 0o600,
        });
        const citation = {
          localAssetId: "app",
          sourceCaseId: peer,
          sourceAssetId,
          sourceFindingId,
          snapshotDigest,
        };
        if (peer !== "stable") return citation;
        const bridge = loadSentinelGraph({
          version: 1,
          nodes: [{
            id: "app",
            kind: "asset",
            label: "Published cross-case alias",
            aliases: [sourceAssetId],
          }],
          edges: [],
        }).snapshot();
        const bridgeDigest = digestSentinelSnapshot(bridge);
        const bridgeArchive = sentinelSourceSnapshotPath(
          dir,
          "bridge",
          bridgeDigest,
        );
        await Deno.mkdir(dirname(bridgeArchive), { recursive: true });
        await Deno.writeTextFile(bridgeArchive, JSON.stringify(bridge), {
          mode: 0o600,
        });
        return {
          ...citation,
          mappingSources: [
            { caseId: "bridge", snapshotDigest: bridgeDigest },
            { caseId: peer, snapshotDigest },
          ],
        };
      }),
    );
    const first = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, first);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const revision = store.activeRevision()!;
      assertEquals(
        store.applyModelPlan(revision, null, [{
          kind: "impact",
          depth: 2,
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
          plannerRound: {
            identity: revision,
            attempt: 1,
            peerFindingCitations: sourceCitations,
          },
        }], {}),
        1,
      );
    } finally {
      store.close();
    }
    advanceAdaptiveSentinel(path, first);
    const original = readAdaptiveSentinel(path, first)!.tasks.find(({ kind }) =>
      kind === "impact"
    )!;
    assertEquals(original.status, "completed");

    await Deno.writeTextFile(
      path,
      JSON.stringify(inventory(["stable.example"])),
    );
    const second = refreshSentinelAssessment(path)!;
    assert(second.revision > first.revision);
    advanceAdaptiveSentinel(path, second);
    advanceAdaptiveSentinel(path, second);
    const active = readAdaptiveSentinel(path, second)!.tasks.find(({ kind }) =>
      kind === "impact"
    )!;
    assertEquals(active.plannerRound?.peerFindingCitations, [
      sourceCitations[0],
    ]);
    assertEquals(
      readHistoricalAdaptiveSentinel(path, first.revision)!.tasks.find((
        { id },
      ) => id === original.id)
        ?.plannerRound?.peerFindingCitations?.map(({ sourceCaseId }) =>
          sourceCaseId
        ).sort(),
      ["moved", "stable"],
    );
    const pendingStore = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const revision = pendingStore.activeRevision()!;
      assertEquals(
        pendingStore.applyModelPlan(revision, null, [{
          kind: "trace",
          depth: 3,
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
          plannerRound: {
            identity: revision,
            attempt: 1,
            peerFindingCitations: [sourceCitations[0]],
          },
        }], {}),
        1,
      );
      const queued = pendingStore.list(revision).find(({ kind, depth }) =>
        kind === "trace" && depth === 3
      )!;
      assert(pendingStore.assignQueuedTask(
        revision,
        queued.id,
        "Assigned by the operator in Tidepool.",
      ));
    } finally {
      pendingStore.close();
    }
    const unrelated = inventory(["stable.example"]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...unrelated,
        nodes: [
          ...unrelated.nodes,
          { id: "unrelated-app", label: "Unrelated asset", kind: "asset" },
        ],
      }),
    );
    const third = refreshSentinelAssessment(path)!;
    assert(third.revision > second.revision);
    advanceAdaptiveSentinel(path, third);
    const reused = readAdaptiveSentinel(path, third)!.tasks.find(({ kind }) =>
      kind === "impact"
    )!;
    assertEquals(reused.plannerRound?.peerFindingCitations, [
      sourceCitations[0],
    ]);
    assertEquals(reused.observation, active.observation);
    assertEquals(reused.attempts, 0);
    const operatorTask = readAdaptiveSentinel(path, third)!.tasks.find((
      { kind, depth },
    ) => kind === "trace" && depth === 3);
    assertEquals(operatorTask?.plannerRound?.peerFindingCitations, [
      sourceCitations[0],
    ]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...unrelated,
        nodes: [
          ...unrelated.nodes,
          {
            id: sourceCitations[0].sourceAssetId,
            label: "Distinct asset with exact reporting identity",
            kind: "asset",
          },
        ],
      }),
    );
    const fourth = refreshSentinelAssessment(path)!;
    assert(fourth.revision > third.revision);
    advanceAdaptiveSentinel(path, fourth);
    assertEquals(
      readAdaptiveSentinel(path, fourth)?.tasks.flatMap(
        (task) => task.plannerRound?.peerFindingCitations ?? [],
      ),
      [],
    );
    assertEquals(
      readHistoricalAdaptiveSentinel(path, third.revision)?.tasks.find(
        ({ id }) => id === reused.id,
      )?.plannerRound?.peerFindingCitations,
      [sourceCitations[0]],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Peer archive carry resumes across batches before publishing a new plan", async () => {
  const dir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(dir);
  const database = join(dirname(path), "sentinel-adaptive.db");
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    const assets = Array.from({ length: 33 }, (_, index) => ({
      id: `asset-${index}`,
      kind: "asset",
      label: `Local asset ${index}`,
    }));
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: assets, edges: [] }),
    );
    const original = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, original);
    const citations = [];
    for (const [index, asset] of assets.entries()) {
      const sourceCaseId = `peer-${index}`;
      const sourceFindingId = `finding-${index}`;
      const report = loadSentinelGraph({
        version: 1,
        nodes: [asset, {
          id: sourceFindingId,
          kind: "finding",
          label: sourceFindingId,
          severity: "high",
        }],
        edges: [{ from: sourceFindingId, to: asset.id, relation: "affects" }],
      }).snapshot();
      const snapshotDigest = digestSentinelSnapshot(report);
      const archive = sentinelSourceSnapshotPath(
        dir,
        sourceCaseId,
        snapshotDigest,
      );
      await Deno.mkdir(dirname(archive), { recursive: true });
      await Deno.writeTextFile(archive, JSON.stringify(report), {
        mode: 0o600,
      });
      citations.push({
        localAssetId: asset.id,
        sourceCaseId,
        sourceAssetId: asset.id,
        sourceFindingId,
        snapshotDigest,
      });
    }
    const store = openSentinelAdaptiveStore(database);
    try {
      const revision = store.activeRevision()!;
      for (const citation of citations) {
        assertEquals(
          store.applyModelPlan(revision, null, [{
            kind: "impact",
            depth: 2,
            nodeId: citation.localAssetId,
            reason: MODEL_ASSIGNMENT_REASON,
            plannerRound: {
              identity: revision,
              attempt: 1,
              peerFindingCitations: [citation],
            },
          }], {}),
          1,
        );
      }
    } finally {
      store.close();
    }
    for (let batch = 0; batch < 6; batch++) {
      advanceAdaptiveSentinel(path, original);
    }
    assertEquals(
      readAdaptiveSentinel(path, original)!.tasks.filter((
        { status, plannerRound },
      ) => status === "completed" && plannerRound?.peerFindingCitations?.length)
        .length,
      33,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [...assets, { id: "fresh", kind: "asset", label: "New asset" }],
        edges: [],
      }),
    );
    const next = refreshSentinelAssessment(path)!;
    assert(next.revision > original.revision);
    advanceAdaptiveSentinel(path, next);
    const destination = adaptiveRevision(next);
    const staging = openSentinelAdaptiveStore(database);
    try {
      assertEquals(staging.activeRevision(), adaptiveRevision(original));
      assertEquals(staging.peerFindingVerifications(destination).length, 32);
      assertEquals(staging.list(destination), []);
    } finally {
      staging.close();
    }
    assertThrows(
      () => assignSentinelTask(path, destination, "trace", "fresh"),
      Error,
      "still verifying carried peer evidence",
    );
    let calls = 0;
    const planner = createSentinelModelPlanner(path, () => ({
      execute() {
        calls++;
        return Promise.resolve();
      },
      clear() {},
    }));
    try {
      planner.advance(next);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(calls, 0);
    } finally {
      planner.stop();
    }
    advanceAdaptiveSentinel(path, next);
    const reopened = openSentinelAdaptiveStore(database);
    try {
      assertEquals(reopened.activeRevision(), destination);
      assertEquals(reopened.peerFindingVerifications(destination), []);
      assertEquals(
        reopened.list(destination).flatMap(({ plannerRound }) =>
          plannerRound?.peerFindingCitations ?? []
        ).map(({ sourceCaseId }) => sourceCaseId).sort(),
        citations.map(({ sourceCaseId }) => sourceCaseId).sort(),
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A committed observation supersedes an in-flight plan on the same evidence revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const planner = createSentinelModelPlanner(path, () => ({
    async execute(_message, send, signal) {
      assert(signal);
      entered.resolve(signal);
      await release.promise;
      send({
        type: "response",
        taint: "INTERNAL",
        text: '[{"kind":"impact","nodeId":"app"}]',
      });
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    planner.advance(state);
    const signal = await entered.promise;
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    try {
      store.sync(revision, [{ kind: "trace", nodeId: "record" }], revision);
      const lease = store.claim(revision)!;
      assertEquals(lease.task.nodeId, "record");
      store.complete({
        taskId: lease.task.id,
        leaseToken: lease.leaseToken,
        observation: { summary: "A newly committed relationship observation" },
      });
    } finally {
      store.close();
    }
    planner.advance(state);
    assert(signal.aborted);
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const adaptive = readAdaptiveSentinel(path, state)!;
    assertEquals(adaptive.modelPlannerHistory.at(-1)?.outcome, "superseded");
    assert(!adaptive.tasks.some(({ kind }) => kind === "impact"));
  } finally {
    release.resolve();
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Planner budgets large observations and preserves access by exact assignment ID", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const received = Promise.withResolvers<string>();
  const planner = createSentinelModelPlanner(path, () => ({
    execute(message, send) {
      if (String(message).startsWith("Plan a defensive investigation")) {
        received.resolve(String(message));
      }
      send({ type: "response", text: "[]", taint: "INTERNAL" });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    let assignment: string;
    try {
      store.sync(revision, [{ kind: "trace", nodeId: "record" }], revision);
      const lease = store.claim(revision)!;
      assignment = lease.task.id;
      store.complete({
        taskId: assignment,
        leaseToken: lease.leaseToken,
        observation: { summary: "x".repeat(11_000) },
      });
    } finally {
      store.close();
    }
    planner.advance(state);
    const prompt = await received.promise;
    assert(prompt.length <= 8_000);
    const input = JSON.parse(prompt.split("\n").at(-1)!);
    assertEquals(input.workerObservations[0].taskId, assignment);
    assertEquals(input.workerObservations[0].observation, undefined);
    assert(prompt.includes("sentinel_worker_observation"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Planner rejects an alias that would drop a referenced prerequisite", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const planner = createSentinelModelPlanner(path, () => ({
    execute(_message, send) {
      send({
        type: "response",
        text: JSON.stringify([
          { kind: "impact", nodeId: "app" },
          { kind: "review_finding", nodeId: "finding", dependsOn: [0] },
          { kind: "trace", nodeId: "record", dependsOn: [1] },
        ]),
        taint: "INTERNAL",
      });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = readAdaptiveSentinel(path, state)!;
    assertEquals(result.modelPlanner?.status, "proposal_rejected");
    assert(!result.tasks.some(({ kind }) => kind === "impact"));
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A committed review summary becomes planning evidence even when the worker result is unchanged", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const entered = Promise.withResolvers<string>();
  const planner = createSentinelModelPlanner(path, () => ({
    execute(message, send) {
      let text = "[]";
      if (String(message).startsWith("Plan a defensive investigation")) {
        entered.resolve(String(message));
        const inputs = JSON.parse(String(message).split("\n").at(-1)!);
        text = JSON.stringify([
          {
            kind: "trace",
            nodeId: "finding",
            workerSources: [
              {
                taskId: inputs.workerObservations[0].taskId,
                kind: "model_review",
              },
              {
                taskId:
                  inputs.workerObservations.find((item: { nodeId: string }) =>
                    item.nodeId === "record"
                  ).taskId,
                kind: "worker_result",
              },
            ],
          },
          {
            kind: "trace",
            nodeId: "record",
            sourceTaskId:
              inputs.workerObservations.find((item: { nodeId: string }) =>
                item.nodeId === "record"
              ).taskId,
            sourceKind: "model_review",
          },
        ]);
      }
      send({ type: "response", text, taint: "INTERNAL" });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(join(dir, "sentinel-adaptive.db"));
    let assignment: string;
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON)!;
      assignment = claim.task.id;
      const before = store.plannerObservations(revision);
      assert(store.finishModelReview(revision, assignment, claim.token, {
        note: "The review identified an unmet monitoring prerequisite.",
        steps: [],
      }));
      const updated = store.plannerObservations(revision);
      assertEquals(updated[0].observation, before[0].observation);
      assertEquals(
        updated[0].reviewSummary,
        "The review identified an unmet monitoring prerequisite.",
      );
    } finally {
      store.close();
    }
    planner.advance(state);
    const prompt = await entered.promise;
    const inputs = JSON.parse(prompt.split("\n").at(-1)!);
    assertEquals(inputs.workerObservations[0].taskId, assignment);
    assertEquals(
      inputs.workerObservations[0].reviewSummary,
      "The review identified an unmet monitoring prerequisite.",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = readAdaptiveSentinel(path, state)!;
    const followUp = saved.tasks.find(({ kind, nodeId }) =>
      kind === "trace" && nodeId === "finding"
    )!;
    const rawSource = saved.tasks.find(({ kind, nodeId }) =>
      kind === "review_evidence" && nodeId === "record"
    )!.id;
    const citations = [
      { taskId: assignment, kind: "model_review" },
      { taskId: rawSource, kind: "worker_result" },
    ] as const;
    assertEquals(followUp.plannerRound?.workerSources, citations);
    assertEquals(followUp.prerequisites, [assignment, rawSource].sort());
    assert(
      !saved.tasks.some(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      ),
    );
    const graph = buildSentinelProvenance(state.result, saved).snapshot();
    const target = `task:adaptive:${followUp.id}`;
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === `observation:adaptive:review:${assignment}` && to === target &&
        relation === "prompted"
      ),
    );
    assert(
      !graph.edges.some(({ from, to, relation }) =>
        from === `observation:adaptive:${assignment}` && to === target &&
        relation === "prompted"
      ),
    );
    assert(graph.edges.some(({ from, to, relation }) =>
      from === `observation:adaptive:${rawSource}` && to === target &&
      relation === "prompted"
    ));
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: snapshot.nodes.map((node) =>
          node.id === "finding" ? { ...node, label: "Updated finding" } : node
        ),
      }),
    );
    const next = refreshSentinelAssessment(path)!;
    for (let pass = 0; pass < 4; pass++) {
      advanceAdaptiveSentinel(path, next);
    }
    const current = readAdaptiveSentinel(path, next)!;
    const reopened = current.tasks.find(({ kind, nodeId }) =>
      kind === "trace" && nodeId === "finding"
    )!;
    const carriedSource = current.tasks.find(({ kind }) =>
      kind === "impact"
    )!;
    assertEquals(reopened.status, "completed");
    const currentRaw = current.tasks.find(({ kind, nodeId }) =>
      kind === "review_evidence" && nodeId === "record"
    )!.id;
    assertEquals(reopened.prerequisites, [carriedSource.id, currentRaw].sort());
    assertEquals(reopened.plannerRound?.workerSources, undefined);
    assertEquals(carriedSource.attempts, 0);
    assertEquals(reopened.reviewedFrom, undefined);
    assertEquals(reopened.plannerRound?.sourceKind, undefined);
    assertEquals(
      reopened.plannerRound?.identity,
      followUp.plannerRound?.identity,
    );
    assert(
      current.history.some(({ taskId, event, note }) =>
        taskId === reopened.id && event === "reopened" &&
        note?.includes(followUp.id)
      ),
    );
    const rerun = current.tasks.find(({ id }) =>
      id === currentRaw
    )!;
    assertEquals(rerun.attempts, 1);
    assert(
      !current.history.some(({ taskId, event }) =>
        taskId === currentRaw && event === "result_reused"
      ),
    );
    const preflight = openSentinelAdaptiveStore(
      join(dir, "sentinel-adaptive.db"),
    );
    try {
      const revision = preflight.activeRevision()!;
      const invalid = {
        kind: "trace" as const,
        nodeId: "finding",
        depth: 2,
        prerequisites: reopened.prerequisites,
        plannerRound: {
          identity: revision,
          attempt: 1,
          workerSources: [{
            taskId: currentRaw,
            kind: "model_review" as const,
          }],
        },
      };
      const dependent = {
        kind: "trace" as const,
        nodeId: "record",
        depth: 2,
        prerequisites: [reopened.id],
      };
      assertEquals(
        preflight.applyModelPlan(revision, null, [invalid, dependent], {}),
        null,
      );
      const outside = current.tasks.find(({ kind }) =>
        kind === "review_finding"
      )!;
      assertEquals(
        preflight.applyModelPlan(revision, null, [{
          ...invalid,
          plannerRound: {
            ...invalid.plannerRound,
            workerSources: [{ taskId: outside.id, kind: "worker_result" }],
          },
        }, dependent], {}),
        null,
      );
      assertEquals(
        preflight.list(revision).find(({ id }) => id === reopened.id)
          ?.plannerRound?.workerSources,
        undefined,
      );
      assert(
        !preflight.list(revision).some(({ id }) =>
          id === sentinelAdaptiveTaskId(revision, dependent)
        ),
      );
    } finally {
      preflight.close();
    }
    const db = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      db.exec("UPDATE adaptive_model_attempts SET started = 0");
    } finally {
      db.close();
    }
    const captures: Record<string, unknown>[] = [];
    const cite = (taskId: string) => ({
      kind: "trace",
      nodeId: "finding",
      workerSources: [{ taskId, kind: "worker_result" }],
    });
    const followUpRound = createSentinelModelPlanner(path, () => ({
      execute(message, send) {
        const prompt = String(message);
        let text = '{"summary":"Fixture review","followUps":[]}';
        if (prompt.startsWith("Plan a defensive investigation")) {
          const input = JSON.parse(prompt.split("\n").at(-1)!);
          captures.push(input);
          text = JSON.stringify([
            cite(currentRaw),
            cite(currentRaw),
            { kind: "trace", nodeId: "record", dependsOn: [0] },
          ]);
        }
        send({ type: "response", text, taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }));
    try {
      for (let pass = 0; pass < 8 && !captures.length; pass++) {
        followUpRound.advance(next);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert(captures.length);
      const observations = captures[0].workerObservations as {
        taskId: string;
        observation: unknown;
      }[];
      assertEquals(
        observations.find(({ taskId }) => taskId === currentRaw)?.observation,
        rerun.observation,
      );
      const updated = readAdaptiveSentinel(path, next)!;
      const annotated = updated.tasks.find(({ id }) => id === reopened.id)!;
      assertEquals(annotated.prerequisites, reopened.prerequisites);
      assertEquals(annotated.plannerRound?.workerSources, [{
        taskId: currentRaw,
        kind: "worker_result",
      }]);
      const dependent = updated.tasks.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      )!;
      assertEquals(dependent.prerequisites, [reopened.id]);
      const history = updated.history.toReversed();
      const attached = history.findIndex(({ taskId, event }) =>
        taskId === reopened.id && event === "evidence_attached"
      );
      const claimed = history.findIndex(({ taskId, event }) =>
        taskId === dependent.id && event === "claimed"
      );
      assert(attached >= 0 && claimed > attached);
      assertEquals(annotated.attempts, reopened.attempts);
      assertEquals(
        updated.history.filter(({ taskId, event }) =>
          taskId === reopened.id && event === "evidence_attached"
        ).length,
        1,
      );
      assert(
        buildSentinelProvenance(next.result, updated).snapshot().edges.some((
          { from, to, relation },
        ) =>
          from === `observation:adaptive:${currentRaw}` &&
          to === `task:adaptive:${reopened.id}` && relation === "prompted"
        ),
      );
    } finally {
      followUpRound.stop();
    }
    const archived = readAdaptiveSentinel(path, state)!;
    assertEquals(
      archived.tasks.find(({ id }) => id === followUp.id)?.plannerRound
        ?.workerSources,
      citations,
    );
    const archivedGraph = buildSentinelProvenance(state.result, archived)
      .snapshot();
    assert(
      archivedGraph.edges.some(({ from, to, relation }) =>
        from === `observation:adaptive:review:${assignment}` && to === target &&
        relation === "prompted"
      ),
    );
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("The planner receives upstream match counts from its saved evidence revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(dir, "main");
  const sourceAlertId = sentinelAlertReference({
    type: "integrity_change",
    asset: "app.example",
    evidenceIds: ["private-fixture-id"],
  });
  const secondAlertId = sentinelAlertReference({
    type: "integrity_change",
    asset: "app.example",
    evidenceIds: ["second-fixture-id"],
  });
  const alertIds = [sourceAlertId, secondAlertId].sort();
  const secondCitation = {
    kind: "impact",
    nodeId: "app",
    upstreamCheckId: "cloudtrail_audit_configuration_changed",
    sourceAlertId: secondAlertId,
  };
  const completed = Promise.withResolvers<string>();
  let workerSource: string;
  let otherWorkerSource: string;
  let reusableSource: string;
  const planner = createSentinelModelPlanner(path, () => ({
    execute(message, send) {
      if (String(message).startsWith("Plan a defensive investigation")) {
        const input = JSON.parse(String(message).split("\n").at(-1)!);
        assert(
          input.workerObservations.some(({ taskId }: { taskId: string }) =>
            taskId === workerSource
          ),
        );
        completed.resolve(String(message));
        send({
          type: "response",
          taint: "INTERNAL",
          text: JSON.stringify([
            {
              kind: "impact",
              nodeId: "app",
              upstreamCheckId: "cloudtrail_logging_stopped",
              sourceAlertId,
              workerSources: [
                { taskId: workerSource, kind: "worker_result" },
                { taskId: otherWorkerSource, kind: "worker_result" },
                { taskId: reusableSource, kind: "worker_result" },
              ],
            },
            secondCitation,
            secondCitation,
            {
              kind: "trace",
              nodeId: "other",
              upstreamCheckId: "cloudtrail_logging_stopped",
              sourceAlertId,
            },
            {
              kind: "trace",
              nodeId: "app",
              upstreamCheckId: "cloudtrail_audit_configuration_changed",
              sourceAlertId,
            },
          ]),
        });
      }
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [
          ...snapshot.nodes.map((node) =>
            node.id === "app" ? { ...node, aliases: ["app.example"] } : node
          ),
          {
            id: "other",
            kind: "asset",
            label: "Other",
          },
        ],
      }),
    );
    const alert = {
      type: "integrity_change",
      asset: "app.example",
      severity: "high",
      subject: "Fixture change",
      observedAt: "2026-01-01T00:00:00.000Z",
      triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
      evidenceIds: ["private-fixture-id"],
    };
    const secondAlert = {
      ...alert,
      triggeringAction: "cloudtrail.amazonaws.com:UpdateTrail",
      evidenceIds: ["second-fixture-id"],
    };
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([alert, secondAlert]),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    workerSource =
      readAdaptiveSentinel(path, state)!.tasks.find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "app"
      )!.id;
    otherWorkerSource =
      readAdaptiveSentinel(path, state)!.tasks.find(({ kind, nodeId }) =>
        kind === "review_finding" && nodeId === "finding"
      )!.id;
    const revision = adaptiveRevision(state);
    const reusableTask = {
      kind: "impact" as const,
      nodeId: "app",
      depth: 3,
      reason: MODEL_ASSIGNMENT_REASON,
    };
    const writer = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      writer.sync(revision, [reusableTask], revision);
      reusableSource = sentinelAdaptiveTaskId(revision, reusableTask);
    } finally {
      writer.close();
    }
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    const prompt = await completed.promise;
    const inputs = JSON.parse(prompt.split("\n").at(-1)!);
    assertEquals(inputs.upstreamChecks, [
      { id: "cloudtrail_logging_stopped", count: 1 },
      { id: "cloudtrail_audit_configuration_changed", count: 1 },
    ]);
    assert(prompt.includes("sentinel_defense with upstreamCheck"));
    assert(!prompt.includes("private-fixture-id"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saved = readAdaptiveSentinel(path, state)!;
    const task = saved.tasks.find(({ kind, nodeId, depth }) =>
      kind === "impact" && nodeId === "app" && depth === 2
    )!;
    assertEquals(task.plannerRound?.workerSources, [
      { taskId: workerSource!, kind: "worker_result" },
      { taskId: otherWorkerSource!, kind: "worker_result" },
      { taskId: reusableSource!, kind: "worker_result" },
    ]);
    assertEquals(
      task.prerequisites,
      [workerSource!, otherWorkerSource!, reusableSource!].sort(),
    );
    const citations = [
      { alertId: sourceAlertId, checkId: "cloudtrail_logging_stopped" },
      {
        alertId: secondAlertId,
        checkId: "cloudtrail_audit_configuration_changed",
      },
    ];
    assertEquals(task.plannerRound?.upstreamCitations, citations);
    assertEquals(task.evidenceIds, alertIds);
    assertEquals(
      saved.history.filter(({ event, taskId }) =>
        event === "evidence_attached" && taskId === task.id
      ).length,
      1,
    );
    assert(
      !saved.tasks.some(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "other"
      ),
    );
    assertEquals(
      saved.tasks.filter(({ plannerRound }) => plannerRound?.upstreamCitations)
        .map(({ id }) => id),
      [task.id],
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        { ...alert, subject: "Updated fixture change" },
        secondAlert,
      ]),
    );
    const changed = refreshSentinelAssessment(path)!;
    assert(changed.revision > state.revision);
    assertEquals(
      changed.result?.sharedGraph.snapshot,
      state.result?.sharedGraph.snapshot,
    );
    advanceAdaptiveSentinel(path, changed);
    advanceAdaptiveSentinel(path, changed);
    const updated = readAdaptiveSentinel(path, changed)!;
    const updatedTask = updated.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 2
    )!;
    assertEquals(updatedTask.status, "completed");
    const currentSource = updated.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 3
    )!;
    assertEquals(currentSource.attempts, 0);
    const remappedWorkers = updatedTask.plannerRound?.workerSources ?? [];
    assertEquals(
      remappedWorkers.map(({ taskId }) => taskId).sort(),
      updatedTask.prerequisites,
    );
    assert(remappedWorkers.some(({ taskId }) => taskId === currentSource.id));
    assert(
      updated.tasks.filter(({ id }) =>
        remappedWorkers.some(({ taskId }) => taskId === id)
      )
        .every(({ attempts }) => attempts === 0),
    );
    assertEquals(
      readSentinelWorkerObservation(path, changed.revision, {
        task: currentSource.id,
      }),
      readSentinelWorkerObservation(path, state.revision, {
        task: reusableSource!,
      }),
    );
    assertEquals(
      readSentinelWorkerObservation(path, changed.revision, {
        task: reusableSource!,
      }),
      undefined,
    );
    assert(
      buildSentinelProvenance(changed.result, updated).snapshot().edges.some((
        { from, to, relation },
      ) =>
        from === `observation:adaptive:${currentSource.id}` &&
        to === `task:adaptive:${updatedTask.id}` && relation === "prompted"
      ),
    );

    assertEquals(updatedTask.evidenceIds, alertIds);
    assertEquals(
      updatedTask.plannerRound?.upstreamCitations,
      citations,
    );
    assert(
      updated.history.some(({ taskId, event }) =>
        taskId === updatedTask.id && event === "reopened"
      ),
    );

    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([secondAlert]),
    );
    const next = refreshSentinelAssessment(path)!;
    assert(next.revision > changed.revision);
    advanceAdaptiveSentinel(path, next);
    advanceAdaptiveSentinel(path, next);
    const reconciled = readAdaptiveSentinel(path, next)!;
    const reopened = reconciled.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 2
    )!;
    assertEquals(reopened.status, "completed");
    assertEquals(reopened.evidenceIds, [secondAlertId]);
    assertEquals(reopened.plannerRound?.upstreamCitations, [citations[1]]);
    assertEquals(
      reconciled.history.find(({ taskId, event }) =>
        taskId === reopened.id && event === "reopened"
      )?.removedEvidenceIds,
      [sourceAlertId],
    );
    const handle = createTidepoolSentinelHandler(
      { baseDir: dir, config: {} } as BootstrapResult,
    );
    let wire: string | undefined;
    for (const alertId of alertIds) {
      await handle({
        type: "revision",
        revision: state.revision,
        focusTaskAlert: { taskId: task.id, alertId },
      }, {
        readyState: WebSocket.OPEN,
        send(value: string) {
          wire = value;
        },
      } as WebSocket);
      assert(wire);
      const frame = JSON.parse(wire);
      assertEquals(frame.type, "sentinel_revision");
      assert(
        frame.provenance.edges.some((
          edge: { from: string; to: string; relation: string },
        ) =>
          edge.from === `observation:adaptive:${otherWorkerSource}` &&
          edge.to === `task:adaptive:${task.id}` && edge.relation === "prompted"
        ),
      );
      assert(
        frame.provenance.edges.some((
          edge: { from: string; to: string; relation: string },
        ) =>
          edge.from === `observation:adaptive:${workerSource}` &&
          edge.to === `task:adaptive:${task.id}` && edge.relation === "prompted"
        ),
      );
      assert(
        frame.provenance.edges.some((
          edge: { from: string; to: string; relation: string },
        ) =>
          edge.from === frame.focusId &&
          edge.to === `task:adaptive:${task.id}` &&
          edge.relation === "prompted"
        ),
      );
    }
    const conflictedInventory = JSON.parse(await Deno.readTextFile(path));
    conflictedInventory.nodes.find(({ id }: { id: string }) => id === "other")
      .aliases = ["app.example"];
    await Deno.writeTextFile(path, JSON.stringify(conflictedInventory));
    const conflicted = refreshSentinelAssessment(path)!;
    for (let pass = 0; pass < 4; pass++) {
      advanceAdaptiveSentinel(path, conflicted);
    }
    const provenance = readAdaptiveSentinel(path, conflicted)!;
    const invalidated = provenance.tasks.find(({ kind, depth }) =>
      kind === "impact" && depth === 2
    )!;
    assertEquals(invalidated.evidenceIds, []);
    assertEquals(invalidated.plannerRound?.upstreamCitations, undefined);
    assertEquals(
      provenance.history.find(({ taskId, event }) =>
        taskId === invalidated.id && event === "reopened"
      )?.removedEvidenceIds,
      [secondAlertId],
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...conflictedInventory,
        edges: snapshot.edges.filter((edge) => edge.relation !== "affects"),
      }),
    );
    const detached = refreshSentinelAssessment(path)!;
    for (let pass = 0; pass < 4; pass++) {
      advanceAdaptiveSentinel(path, detached);
    }
    const detachedTasks = readAdaptiveSentinel(path, detached)!.tasks;
    assert(
      !detachedTasks.some(({ kind, nodeId, depth }) =>
        nodeId === "app" &&
        (kind === "trace" || (kind === "impact" && depth === 2))
      ),
    );
  } finally {
    planner.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Independent model reviews fill case capacity, drain for planning, and reject obsolete results", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const assets = ["service-a", "service-b", "service-c", "service-d"];
  const inventory = {
    version: 1,
    nodes: assets.map((id) => ({ id, kind: "asset", label: id })),
    edges: [],
  };
  const pool = createSentinelWorkerPool(3);
  const otherSlot = pool(join(dir, "other.json"))!;
  const reviews: { taskId: string; signal: AbortSignal; finish: () => void }[] =
    [];
  let planCalls = 0;
  let now = Date.now();
  let secondPrompt = "";
  const planner = createSentinelModelPlanner(
    path,
    (_state, taskId) => ({
      execute(message, send, signal) {
        if (!taskId) {
          planCalls++;
          if (planCalls === 2) secondPrompt = String(message);
          const text = planCalls === 1
            ? JSON.stringify(
              assets.map((nodeId) => ({ kind: "impact", nodeId })),
            )
            : "[]";
          send({ type: "response", text, taint: "INTERNAL" });
          return Promise.resolve();
        }
        assert(signal);
        const gate = Promise.withResolvers<void>();
        reviews.push({ taskId, signal, finish: gate.resolve });
        return gate.promise.then(() => {
          send({
            type: "response",
            text: JSON.stringify({
              summary: "Completed " + taskId,
              followUps: [],
            }),
            taint: "INTERNAL",
          });
        });
      },
      clear() {},
    }),
    () => pool(path),
    () => now,
  );
  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 40 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert(condition());
  }
  try {
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const state = startSentinelAssessment(path);
    setSentinelWorkerLimit(path, 2);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await waitFor(() => reviews.length === 2);
    assertEquals(planCalls, 1);
    assertEquals(pool(path), undefined);
    assertEquals(new Set(reviews.map(({ taskId }) => taskId)).size, 2);

    now += 60_001;
    const db = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      db.exec("UPDATE adaptive_model_attempts SET started = 0");
    } finally {
      db.close();
    }
    addSentinelCaseHint(path, "Reconsider the finished observations.");
    planner.advance(state);
    reviews[0].finish();
    await waitFor(() =>
      readAdaptiveSentinel(path, state)!.modelReviews.length === 1
    );
    assertEquals(planCalls, 1);
    assertEquals(reviews.length, 2);
    reviews[1].finish();
    await waitFor(() => planCalls === 2 && reviews.length === 4);
    assert(secondPrompt.includes("Reconsider the finished observations."));
    for (const { taskId } of reviews.slice(0, 2)) {
      assert(secondPrompt.includes("Completed " + taskId));
    }

    const expiredReview = new DatabaseSync(join(dir, "sentinel-adaptive.db"));
    try {
      expiredReview.prepare(
        "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE taskId = ?",
      ).run(reviews[2].taskId);
    } finally {
      expiredReview.close();
    }
    otherSlot();
    setSentinelWorkerLimit(path, 3);
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(reviews.length, 4);

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...inventory,
        nodes: inventory.nodes.map((node) => ({
          ...node,
          label: "Revised " + node.id,
        })),
      }),
    );
    const newer = refreshSentinelAssessment(path)!;
    assert(newer.revision > state.revision);
    planner.advance(newer);
    assert(reviews.slice(2).every(({ signal }) => signal.aborted));
    for (const { finish } of reviews.slice(2)) finish();
    await waitFor(() => !planner.hasInFlightWork());
    assertEquals(
      readHistoricalAdaptiveSentinel(path, state.revision)!.modelReviews.map((
        { taskId },
      ) => taskId).sort(),
      reviews.slice(0, 2).map(({ taskId }) => taskId).sort(),
    );
    const released = pool(path);
    assert(released);
    released();
  } finally {
    planner.stop();
    for (const { finish } of reviews) finish();
    otherSlot();
    await waitFor(() => !planner.hasInFlightWork());
    await Deno.remove(dir, { recursive: true });
  }
});
