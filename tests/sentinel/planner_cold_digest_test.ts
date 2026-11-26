import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { sentinelAlertReference } from "../../src/sentinel/telemetry.ts";
import { addSentinelCaseHint } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { openSentinelWorkerFindingStore } from "../../src/sentinel/worker_finding_store.ts";
import {
  applySentinelWorkerFindingPublications,
  readSentinelWorkerFindingPublications,
} from "../../src/sentinel/worker_finding_publications.ts";
import {
  openSentinelWorkerGraphFacts,
  type SentinelWorkerGraphFact,
} from "../../src/sentinel/worker_graph_facts.ts";
import {
  applySharedSentinelTopology,
  collectSharedSentinelTopology,
  digestSentinelSnapshot,
  retainSentinelSourceSnapshot,
} from "../../src/sentinel/shared_inventory.ts";
import { sharedSentinelTopologyEvidenceId } from "../../src/sentinel/shared_topology_work.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import { createHash } from "node:crypto";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  readSentinelAssessment,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../src/sentinel/cases.ts";
import { openSentinelEvidenceDigests } from "../../src/sentinel/evidence_digests.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";

const allowHooks = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW" as const,
      duration: 0,
      ruleId: null,
    }),
};

function completion(content: string, name?: string, args?: object) {
  return {
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: name
      ? [{
        type: "function",
        id: name,
        function: { name, arguments: JSON.stringify(args) },
      }]
      : [],
  };
}

async function withArchivedPlannerRead(
  directory: string,
  check: (
    read: (
      args: Record<string, unknown>,
      denyResponse?: boolean,
    ) => Promise<string>,
  ) => Promise<void>,
  approval?: (prompt: string) => Promise<boolean>,
  publicationPolicy?: (hook: string, input: Record<string, unknown>) => boolean,
  onFrame?: (frame: string) => void,
  sentinelMode = false,
  beforeHook?: (hook: string, input: Record<string, unknown>) => Promise<void>,
) {
  let selection: Record<string, unknown> = {};
  let readout = "";
  let deny = false;
  const registry = createProviderRegistry();
  registry.register({
    name: "archived-digest-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") {
        readout = String(last.content);
        return Promise.resolve(completion("Checked archived history."));
      }
      return Promise.resolve(completion("", "operator_runs", selection));
    },
  });
  registry.setDefault("archived-digest-owner");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "cold-digest" as ChannelId,
      }),
      providerRegistry: registry,
      ...(sentinelMode && {
        sentinelSnapshotPath: resolveSentinelCasePath(directory),
        allowSentinelModelAccess: true,
        resolveSentinelChatCase: (id: string) =>
          listSentinelCaseIds(directory).includes(id)
            ? resolveSentinelCasePath(directory, id)
            : undefined,
      }),
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: directory,
        confirm: approval ?? (() => Promise.resolve(true)),
      }),
      hookRunner: {
        async evaluateHook(hook, { input }) {
          if (beforeHook) await beforeHook(hook, input);
          const blockedPublication = (selection.action === "publish_finding" ||
            selection.action === "linked_finding" ||
            selection.action === "linked_findings") &&
            publicationPolicy && !publicationPolicy(hook, input);
          const allowed = !blockedPublication &&
            !(deny && hook === "POST_TOOL_RESPONSE" &&
              [
                "sentinel_expand_evidence_digest",
                "sentinel_graph_facts",
                "sentinel_case_inventory",
                "sentinel_shared_asset_links",
                "sentinel_shared_finding_source",
                ...(sentinelMode ? ["operator_runs"] : []),
              ].includes(String(input.tool_name)));
          return {
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          };
        },
      },
    }),
  });
  const { port } = await gateway.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string) => {
      readout = "";
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("Owner digest read timed out")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        onFrame?.(String(data));
        const event = JSON.parse(data);
        if (event.type === "turn_end") done.resolve();
        if (event.type === "error") done.reject(new Error(event.message));
      };
      ws.addEventListener("message", receive);
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            content,
          }),
        );
        await done.promise;
      } finally {
        clearTimeout(timer);
        ws.removeEventListener("message", receive);
      }
    };
    if (sentinelMode) await turn("/sentinel on");
    await check(async (args, denyResponse = false) => {
      selection = args;
      deny = denyResponse;
      await turn("Open the exact archived planner result.");
      return readout;
    });
  } finally {
    ws.close();
    await gateway.stop();
  }
}

async function archiveAndRestoreDigestFixture(
  directory: string,
  path: string,
  ref: { kind: "sentinel"; id: string; revision: number },
  runId: string,
) {
  assert(stopSentinelAssessment(path));
  const confirm = () => Promise.resolve(true);
  const archiveId = crypto.randomUUID();
  const archive = await executeOperatorRunArchive(directory, ref, {
    ...ref,
    action: "archive",
    requestId: archiveId,
    runId,
  }, confirm);
  assert(typeof archive !== "string");
  assert("receipt" in archive);
  assertEquals(archive.receipt.status, "succeeded");
  await Deno.rename(dirname(path), join(directory, `previous-case-${ref.id}`));
  try {
    await Deno.remove(join(directory, "data", "sentinel-evidence-digests.db"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const restored = await executeOperatorRunArchive(directory, ref, {
    ...ref,
    action: "restore",
    requestId: crypto.randomUUID(),
    archiveId,
    runId,
  }, confirm);
  assert(typeof restored !== "string");
  assert("receipt" in restored);
  assertEquals(restored.receipt.status, "succeeded");
}

interface PlannerInput {
  readonly inventory: readonly { id: string; kind: string }[];
  readonly coldDigests: readonly { id: string; memberCount: number }[];
}

Deno.test("A planner can cite an omitted worker result only after reopening it", async () => {
  const base = await Deno.makeTempDir();
  const caseId = "bounded-worker-proof";
  const path = resolveSentinelCasePath(base, caseId);
  const assets = Array.from({ length: 7 }, (_, index) => ({
    id: `asset-${index}`,
    kind: "asset",
    label: `Fixture asset ${index}`,
  }));
  let clock = Date.now();
  let sourceTaskId = "";
  let phase: "hidden" | "worker" | "fact" = "hidden";
  let sourceFact: SentinelWorkerGraphFact | undefined;
  let exactRead = false;
  const registry = createProviderRegistry();
  registry.register({
    name: "bounded-worker-proof",
    supportsStreaming: false,
    complete(messages) {
      const toolResult = messages.findLast(({ role }) => role === "tool");
      if (phase === "fact") {
        assert(sourceFact);
        if (toolResult) {
          assertEquals(
            JSON.parse(String(toolResult.content)).id,
            sourceFact.id,
          );
          return Promise.resolve(completion(JSON.stringify([{
            kind: "trace",
            depth: 2,
            nodeId: sourceFact.targetId,
            graphFactId: sourceFact.id,
          }])));
        }
        const input = JSON.parse(
          String(messages.at(-1)?.content).split("\n").at(-1)!,
        );
        assert(
          !input.graphFacts.some(({ id }: { id: string }) =>
            id === sourceFact?.id
          ),
        );
        return Promise.resolve(
          completion("", "sentinel_graph_facts", { id: sourceFact.id }),
        );
      }
      if (toolResult) {
        const page = JSON.parse(String(toolResult.content));
        assertEquals(page.task, sourceTaskId);
        assert(page.nextOffset > 0);
        assertStringIncludes(page.observationJson, "Old verified case result.");
        exactRead = true;
      } else {
        const user = String(messages.at(-1)?.content);
        const input = JSON.parse(user.split("\n").at(-1)!);
        const presentation = input.workerObservations.find(
          ({ taskId }: { taskId: string }) => taskId === sourceTaskId,
        );
        assertEquals(presentation?.observation, undefined);
        if (phase === "worker") {
          return Promise.resolve(
            completion("", "sentinel_worker_observation", {
              task: sourceTaskId,
            }),
          );
        }
      }
      return Promise.resolve(completion(JSON.stringify([{
        kind: "trace",
        depth: 1,
        nodeId: assets[0].id,
        sourceTaskId,
        sourceKind: "worker_result",
      }])));
    },
  });
  registry.setDefault("bounded-worker-proof");
  const planner = createSentinelModelPlanner(
    path,
    (state, taskId) =>
      taskId
        ? { execute: () => Promise.resolve(), clear() {} }
        : createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry: registry,
          hookRunner: allowHooks,
          allowModelAccess: true,
        }),
    undefined,
    () => clock,
  );
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: assets,
        edges: assets.slice(1).map(({ id }) => ({
          from: id,
          to: assets[0].id,
          relation: "depends_on",
        })),
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const facts = openSentinelWorkerGraphFacts(path);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "impact",
          nodeId: id,
          reason: "Retained fixture evidence.",
        })),
        null,
        {
          number: state.revision,
          goal: { id: state.plan.runId!, label: "Retained worker proof" },
        },
      );
      for (const asset of assets) {
        const claim = store.claim(revision);
        assert(claim);
        assertEquals(claim.task.nodeId, asset.id);
        if (!sourceTaskId) sourceTaskId = claim.task.id;
        if (asset !== assets[0]) {
          const fact = facts.record({
            caseId,
            runId: state.plan.runId!,
            evidenceRevision: state.revision,
            taskId: claim.task.id,
            targetId: asset.id,
            relationship: {
              from: asset.id,
              to: assets[0].id,
              relation: "depends_on",
            },
            snapshotDigest: digestSentinelSnapshot(snapshot),
            resultSha256: "a".repeat(64),
            sourceStepIndex: 0,
            requestId: crypto.randomUUID(),
          }, () => true);
          assert(fact);
          sourceFact ??= fact;
        }
        assert(store.complete({
          taskId: claim.task.id,
          leaseToken: claim.leaseToken,
          observation: {
            ...(asset === assets[0]
              ? {
                summary: "Old verified case result.",
                content: "x".repeat(5_000),
              }
              : { summary: "New result." }),
          },
        }));
      }
    } finally {
      facts.close();
      store.close();
    }
    const view = () => readAdaptiveSentinel(path, state)!;
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_500;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(predicate());
    };
    planner.advance(state);
    await until(() =>
      view().modelPlannerHistory.some(({ outcome }) =>
        outcome === "proposal_rejected"
      )
    );
    assert(
      !view().tasks.some(({ reviewedFrom }) => reviewedFrom === sourceTaskId),
    );
    phase = "worker";
    addSentinelCaseHint(
      path,
      "Read the retained worker result before proposing follow-up.",
    );
    clock += 61_000;
    planner.advance(state);
    await until(() =>
      view().tasks.some(({ reviewedFrom }) => reviewedFrom === sourceTaskId)
    );
    assert(exactRead);
    const followup = view().tasks.find(({ reviewedFrom }) =>
      reviewedFrom === sourceTaskId
    )!;
    assertEquals(followup.prerequisites, [sourceTaskId]);
    await withArchivedPlannerRead(base, async (turn) => {
      const result = JSON.parse(
        await turn({
          action: "node",
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
          node: `task:adaptive:${followup.id}`,
        }),
      );
      assertEquals(result.page.node.sourceId, followup.id);
      assertStringIncludes(
        JSON.stringify(result.page.connections),
        `task:adaptive:${sourceTaskId}`,
      );
    });
    assert(sourceFact);
    phase = "fact";
    addSentinelCaseHint(path, "Reopen the exact older relationship fact.");
    clock += 61_000;
    planner.advance(state);
    await until(() =>
      view().tasks.some(({ plannerRound }) =>
        plannerRound?.graphFactId === sourceFact?.id
      )
    );
  } finally {
    planner.stop();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("Gateway traces a follow-up to an exact retained incident-member alert", async () => {
  const base = await Deno.makeTempDir();
  const caseId = "incident-member";
  const path = resolveSentinelCasePath(base, caseId);
  const asset = { id: "delivery", kind: "asset", label: "Delivery" };
  const alert = {
    type: "integrity_change" as const,
    asset: asset.id,
    severity: "high",
    subject: "Pinned fixture subject",
    triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: ["retained-upstream-fixture"],
  };
  const alertId = sentinelAlertReference(alert);
  const blockedAlert = {
    ...alert,
    asset: "other-delivery",
    observedAt: "2026-01-01T00:20:00.000Z",
    evidenceIds: ["hook-denied-defensive-alert"],
  };
  const blockedAlertId = sentinelAlertReference(blockedAlert);
  let blockedExact = false;
  const alternate = {
    id: "other-delivery",
    kind: "asset",
    label: "Other delivery",
  };
  const alternateAlert = {
    ...alert,
    asset: alternate.id,
    subject: "Shared dependency subject",
    observedAt: "2026-01-01T00:10:00.000Z",
    evidenceIds: ["other-asset-fixture"],
  };
  const linkedLocal = {
    ...alternateAlert,
    asset: asset.id,
    type: "network_security_alert" as const,
    triggeringAction: undefined,
    evidenceIds: ["local-dependency-event"],
  };
  const linkedLocalId = sentinelAlertReference(linkedLocal);
  const alternateAlertId = sentinelAlertReference(alternateAlert);
  let incidentId = "";
  const checkId = "cloudtrail_logging_stopped";
  const registry = createProviderRegistry();
  registry.register({
    name: "incident-member-planner",
    supportsStreaming: false,
    complete(messages) {
      const prompt = String(
        messages.find(({ role }) => role === "user")?.content,
      );
      const isPlanner = prompt.startsWith("Plan a defensive investigation");
      if (!isPlanner && !prompt.includes(alertId)) {
        return Promise.resolve(
          completion('{"summary":"Reviewed other evidence.","followUps":[]}'),
        );
      }
      const reads = messages.filter(({ role }) => role === "tool");
      const read = reads.at(-1);
      if (!isPlanner && reads.length === 0) {
        return Promise.resolve(completion("", "sentinel_defense", {
          upstreamCheck: checkId,
          alertId: alternateAlertId,
        }));
      }
      if (!isPlanner && reads.length === 1) {
        assertStringIncludes(String(read?.content), "did not match");
        assert(!String(read?.content).includes(alternateAlertId));
        return Promise.resolve(completion("", "sentinel_defense", {
          upstreamCheck: checkId,
        }));
      }
      if (isPlanner && reads.length === 0) {
        return Promise.resolve(completion("", "sentinel_defense", {
          upstreamCheck: checkId,
          alertId: blockedAlertId,
        }));
      }
      if (isPlanner && reads.length === 1) {
        assert(blockedExact);
        assert(!String(read?.content).includes(blockedAlertId));
        return Promise.resolve(completion("", "sentinel_defense", {
          upstreamCheck: checkId,
          alertId,
        }));
      }
      assert(read);
      if (reads.length === 2) {
        assertEquals(
          JSON.parse(String(read.content)).matches.map((
            { alertId }: { alertId: string },
          ) => alertId),
          [alertId],
        );
        return Promise.resolve(completion("", "sentinel_incident_alerts", {
          incidentId,
          limit: 1,
        }));
      }
      const members = JSON.parse(String(read.content));
      assertEquals(members.total, isPlanner ? 2 : 1);
      assertEquals(members.alerts[0].asset, asset.id);
      if (!isPlanner) {
        return Promise.resolve(
          completion(
            '{"summary":"Reviewed the exact retained alert.","followUps":[]}',
          ),
        );
      }
      return Promise.resolve(completion(JSON.stringify([{
        kind: "trace",
        nodeId: asset.id,
        depth: 3,
        upstreamCheckId: checkId,
        sourceAlertId: alertId,
      }, {
        kind: "trace",
        nodeId: alternate.id,
        depth: 4,
        upstreamCheckId: checkId,
        sourceAlertId: blockedAlertId,
      }, {
        kind: "trace",
        nodeId: alternate.id,
        depth: 5,
        upstreamCheckId: checkId,
        sourceAlertId: alternateAlertId,
      }])));
    },
  });
  registry.setDefault("incident-member-planner");
  const planner = createSentinelModelPlanner(
    path,
    (state, taskId, token) =>
      createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: taskId ? undefined : state.plan.runId,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        providerRegistry: registry,
        hookRunner: {
          evaluateHook(hook, { input }) {
            const blocked = hook === "POST_TOOL_RESPONSE" &&
              input.tool_name === "sentinel_defense" &&
              String(input.tool_response).includes(blockedAlertId);
            if (blocked) blockedExact = true;
            return Promise.resolve({
              allowed: !blocked,
              action: blocked ? "BLOCK" : "ALLOW",
              duration: 0,
              ruleId: null,
            });
          },
        },
        allowModelAccess: true,
      }),
  );
  try {
    const peer = resolveSentinelCasePath(base, "peer");
    for (
      const [selected, subject] of [[path, alert.subject], [
        peer,
        "Peer-only subject",
      ]]
    ) {
      await Deno.mkdir(dirname(selected), { recursive: true });
      await Deno.writeTextFile(
        selected,
        JSON.stringify({
          version: 1,
          nodes: [asset, alternate],
          edges: [{ from: asset.id, to: alternate.id, relation: "depends_on" }],
        }),
      );
      await Deno.writeTextFile(
        sentinelAlertsPath(selected),
        JSON.stringify([
          { ...alert, subject },
          blockedAlert,
          linkedLocal,
          alternateAlert,
          ...Array.from({ length: 26 }, (_, index) => ({
            ...alert,
            subject,
            type: "network_security_alert",
            observedAt: "2026-01-01T00:00:01.000Z",
            triggeringAction: undefined,
            evidenceIds: [`paired-network-fixture-${index}`],
          })),
        ]),
      );
    }
    const state = startSentinelAssessment(path);
    const peerState = startSentinelAssessment(peer);
    const incident = state.result?.sharedGraph.observations.find(({ task }) =>
      task === "incident_correlation"
    )?.facts;
    assert(Array.isArray(incident?.candidates));
    const linked = incident.candidates.find(({ alertReferences }) =>
      alertReferences.includes(alternateAlertId) &&
      alertReferences.includes(linkedLocalId)
    );
    assert(linked);
    incidentId = linked.id;
    assert(
      !buildSentinelProvenance(state.result).snapshot().nodes.some((
        { sourceId },
      ) => sourceId === alertId),
    );
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    const deadline = Date.now() + 2_500;
    let followup;
    while (!followup && Date.now() < deadline) {
      followup = readAdaptiveSentinel(path, state)?.tasks.find((
        { plannerRound, evidenceIds },
      ) =>
        plannerRound?.upstreamCheckId === checkId &&
        evidenceIds.includes(alertId)
      );
      if (!followup) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(followup);
    assert(
      !readAdaptiveSentinel(path, state)?.tasks.some((
        { plannerRound, evidenceIds },
      ) =>
        plannerRound?.upstreamCheckId === checkId &&
        (evidenceIds.includes(blockedAlertId) ||
          evidenceIds.includes(alternateAlertId))
      ),
    );
    await Deno.writeTextFile(sentinelAlertsPath(path), "[]");
    const reviewDeadline = Date.now() + 2_500;
    const workerRead = () =>
      readAdaptiveSentinel(path, state)?.modelReviews.find(
        ({ taskId }) => taskId === followup.id,
      );
    while (!workerRead() && Date.now() < reviewDeadline) {
      planner.advance(state);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(workerRead()?.summary, "Reviewed the exact retained alert.");
    assert(
      workerRead()?.steps.some(({ goalReceiptRead, tool }) =>
        tool === "sentinel_defense" && goalReceiptRead &&
        "upstreamCheck" in goalReceiptRead.args &&
        goalReceiptRead.args.upstreamCheck === checkId &&
        !("alertId" in goalReceiptRead.args)
      ),
    );
    const report = readAdaptiveSentinel(path, state)?.modelPlannerHistory.find(
      ({ reads }) => reads?.some(({ tool }) => tool === "sentinel_defense"),
    );
    const workerStepIndex = workerRead()?.steps.findIndex(
      ({ goalReceiptRead }) =>
        goalReceiptRead &&
        "upstreamCheck" in goalReceiptRead.args &&
        goalReceiptRead.args.upstreamCheck === checkId &&
        !("alertId" in goalReceiptRead.args),
    );
    const incidentWorkerStep = workerRead()?.steps.findIndex(
      ({ tool }) => tool === "sentinel_incident_alerts",
    );
    assert(report && workerStepIndex !== undefined && workerStepIndex >= 0);
    assert(incidentWorkerStep !== undefined && incidentWorkerStep >= 0);
    const runId = state.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const plannerAlertIndex = report.reads?.findIndex(({ goalReceiptRead }) =>
      goalReceiptRead && "alertId" in goalReceiptRead.args &&
      goalReceiptRead.args.alertId === alertId
    );
    const plannerIncidentIndex = report.reads?.findIndex(({ tool }) =>
      tool === "sentinel_incident_alerts"
    );
    assert(plannerAlertIndex !== undefined && plannerAlertIndex >= 0);
    assert(plannerIncidentIndex !== undefined && plannerIncidentIndex >= 0);
    const plannerRead = {
      ...ref,
      action: "planner_reads",
      plannerIdentity: report.identity,
      attempt: report.attempt,
      ordinal: plannerAlertIndex + 1,
      includeResult: true,
    };
    const workerTrace = {
      ...ref,
      action: "worker_trace_result",
      taskId: followup.id,
      stepIndices: [workerStepIndex],
    };
    const plannerIncident = {
      ...plannerRead,
      ordinal: plannerIncidentIndex + 1,
    };
    const workerIncident = {
      ...workerTrace,
      stepIndices: [incidentWorkerStep],
    };
    let incidentHistory: string[] = [];
    await withArchivedPlannerRead(base, async (read) => {
      incidentHistory = [
        await read(plannerIncident),
        await read(workerIncident),
      ];
      assertEquals(
        incidentHistory.map((text) => JSON.parse(text).result.total),
        [2, 1],
      );
      for (const selected of [plannerRead, workerTrace]) {
        assertEquals(
          JSON.parse(await read(selected)).result.matches.map((
            { alertId }: { alertId: string },
          ) => alertId),
          [alertId],
        );
      }
    });
    const refreshed = refreshSentinelAssessment(path);
    assert(refreshed?.revision === state.revision + 1);
    const node = `observation:assessment:${alertId}`;
    const request = {
      action: "node",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      node,
    };
    await withArchivedPlannerRead(base, async (read) => {
      const selected = JSON.parse(await read(request));
      assertEquals(selected.page.node.alert.subject, alert.subject);
      assertStringIncludes(
        JSON.stringify(selected.page.connections),
        `task:adaptive:${followup.id}`,
      );
      assertStringIncludes(
        await read({ ...request, id: "peer", revision: peerState.revision }),
        "unavailable",
      );
      assertStringIncludes(
        await read({ ...request, revision: refreshed.revision }),
        "unavailable",
      );
    });
    await archiveAndRestoreDigestFixture(base, path, {
      ...ref,
      revision: refreshed.revision,
    }, runId);
    await withArchivedPlannerRead(base, async (read) => {
      assertEquals(
        [await read(plannerIncident), await read(workerIncident)],
        incidentHistory,
      );
      for (const selected of [plannerRead, workerTrace]) {
        assertEquals(
          JSON.parse(await read(selected)).result.matches.map((
            { alertId }: { alertId: string },
          ) => alertId),
          [alertId],
        );
      }
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: refreshed.revision,
        expectedVersion: 0,
        operatorScope: "defense-history-fixture",
        requestId: crypto.randomUUID(),
        constraints: { deniedKinds: [], allowedAssetIds: [alternate.id] },
      }));
      for (
        const selected of [
          plannerRead,
          workerTrace,
          plannerIncident,
          workerIncident,
        ]
      ) {
        assertStringIncludes(await read(selected), "unavailable");
      }
    });
  } finally {
    planner.stop();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("adaptive planner archives omitted inventory in exact evidence digests and records the presented IDs", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-inventory";
  const path = resolveSentinelCasePath(directory, caseId);
  const evidence = Array.from({ length: 44 }, (_, index) => ({
    id: `record-${String(index).padStart(2, "0")}`,
    kind: "evidence",
    label: `Committed evidence ${index}`,
  }));
  let calls = 0;
  const received = Promise.withResolvers<PlannerInput>();
  const makePlanner = () =>
    createSentinelModelPlanner(path, (_state, taskId) => ({
      execute(content, send) {
        assertEquals(taskId, undefined);
        calls++;
        const prompt = String(content);
        received.resolve(
          JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)),
        );
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }));
  const first = makePlanner();
  const reopened = makePlanner();
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "service", kind: "asset", label: "Assigned service" },
          ...evidence,
        ],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    advanceAdaptiveSentinel(path, state);
    first.advance(state);
    const timeout = setTimeout(
      () => received.reject(new Error("Planner did not dispatch")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timeout));
    assert(prompt.inventory.length <= 30);
    assert(prompt.coldDigests.length >= 1);
    const inline = new Set(prompt.inventory.map(({ id }) => id));
    const omitted = evidence.filter(({ id }) => !inline.has(id)).map(({ id }) =>
      "evidence:" + id
    ).sort();
    assert(omitted.length >= 14);
    const digests = openSentinelEvidenceDigests(directory);
    try {
      const refs: string[] = [];
      for (const digest of prompt.coldDigests) {
        const page = digests.expand(scope, digest.id, 30);
        assertExists(page);
        const members = [...page.members];
        let cursor = page.nextCursor;
        while (cursor) {
          const next = digests.expand(scope, digest.id, 30, cursor);
          assertExists(next);
          members.push(...next.members);
          cursor = next.nextCursor;
        }
        assertEquals(members.length, digest.memberCount);
        refs.push(
          ...members.filter(({ kind }) => kind === "evidence").map(({ id }) =>
            id
          ),
        );
      }
      assertEquals(refs.sort(), omitted);
      assertEquals(
        digests.list(scope)?.digests.map(({ id }) => id).sort(),
        prompt.coldDigests.map(({ id }) => id).sort(),
      );
    } finally {
      digests.close();
    }
    const deadline = Date.now() + 2000;
    while (
      readAdaptiveSentinel(path, state)?.modelPlanner?.status !==
        "no_new_assignments" && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = readAdaptiveSentinel(path, state);
    assertEquals(latest?.modelPlanner?.status, "no_new_assignments");
    assertEquals(
      latest?.modelPlannerHistory.at(-1)?.inputManifest?.coldDigestIds,
      prompt.coldDigests.map(({ id }) => id),
    );
    first.stop();
    reopened.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    const journal = openSentinelEvidenceDigests(directory);
    try {
      assertEquals(
        journal.list(scope)?.digests.length,
        prompt.coldDigests.length,
      );
    } finally {
      journal.close();
    }
  } finally {
    first.stop();
    reopened.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

interface HistoryPlannerInput extends PlannerInput {
  readonly coldHistoryDigests: readonly { id: string; memberCount: number }[];
  readonly currentInvestigations: readonly { id: string }[];
  readonly workerObservations: readonly {
    taskId: string;
    observation?: unknown;
    reviewSummary?: string;
  }[];
}

Deno.test("planner history digests retain omitted completed assignments and both observation kinds", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-committed-history";
  const path = resolveSentinelCasePath(directory, caseId);
  const count = 44;
  const assets = Array.from({ length: count }, (_, index) => ({
    id: `asset-${String(index).padStart(2, "0")}`,
    kind: "asset",
    label: `Committed application ${index}`,
  }));
  const received = Promise.withResolvers<HistoryPlannerInput>();
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    execute(content, send) {
      assertEquals(taskId, undefined);
      const prompt = String(content);
      received.resolve(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)));
      send({ type: "response", text: "[]", taint: "INTERNAL" });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: assets, edges: [] }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const completed = new Set<string>();
    const incomplete = new Set<string>();
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        null,
        {
          number: state.revision,
          goal: {
            id: state.plan.runId,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      for (let index = 0; index < count - 2; index++) {
        const next = store.claim(revision);
        assertExists(next);
        const { id, nodeId } = next.task;
        assert(store.complete({
          taskId: id,
          leaseToken: next.leaseToken,
          observation: {
            relatedNodeIds: [nodeId],
            summary: `Committed worker result ${index} ` +
              "details ".repeat(30),
          },
        }));
        const review = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.id === id,
        );
        assertExists(review);
        assert(store.finishModelReview(revision, id, review.token, {
          note: `Committed model review ${index} ` + "analysis ".repeat(40),
          steps: [],
        }));
        completed.add(id);
      }
      const running = store.claim(revision);
      assertExists(running);
      const pending = store.list(revision).filter(({ status }) =>
        status === "queued" || status === "running"
      );
      assertEquals(pending.map(({ status }) => status).sort(), [
        "queued",
        "running",
      ]);
      for (const { id } of pending) incomplete.add(id);
    } finally {
      store.close();
    }
    planner.advance(state);
    const timer = setTimeout(
      () => received.reject(new Error("Planner did not dispatch with history")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timer));
    assert(prompt.coldHistoryDigests.length > 0);
    const journal = openSentinelEvidenceDigests(directory);
    const cold = new Set<string>();
    try {
      for (const { id, memberCount } of prompt.coldHistoryDigests) {
        let seen = 0;
        let cursor: string | undefined;
        do {
          const page = journal.expand(scope, id, 12, cursor);
          assertExists(page);
          for (const item of page.members) {
            assert(!cold.has(item.id));
            cold.add(item.id);
            seen++;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assertEquals(seen, memberCount);
      }
    } finally {
      journal.close();
    }
    const taskIds = new Set(prompt.currentInvestigations.map(({ id }) => id));
    const inline = new Map(
      prompt.workerObservations.map((record) => [record.taskId, record]),
    );
    assert(
      [...completed].some((id) =>
        !taskIds.has(id) && cold.has(`task:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.observation && cold.has(`observation:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.reviewSummary &&
        cold.has(`observation:adaptive:review:${id}`)
      ),
    );
    for (const id of incomplete) {
      assert(!cold.has(`task:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:review:${id}`));
    }
    const deadline = Date.now() + 2000;
    const lastAttempt = () =>
      readAdaptiveSentinel(path, state)?.modelPlannerHistory.at(-1);
    while (!lastAttempt()?.finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = lastAttempt();
    assertEquals(latest?.outcome, "no_new_assignments");
    assertEquals(
      latest?.inputManifest?.coldDigestIds?.toSorted(),
      [...(prompt.coldDigests ?? []), ...prompt.coldHistoryDigests].map((
        { id },
      ) => id).sort(),
    );
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Sentinel owner can inspect a bounded queued and running graph frontier", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "frontier";
  const path = resolveSentinelCasePath(directory, caseId);
  try {
    const assets = Array.from({ length: 8 }, (_, index) => ({
      id: `host-${index}`,
      kind: "asset",
      label: `Host ${index}`,
    }));
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: assets,
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let runningId: string;
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
        })),
        null,
        { number: state.revision, goal: { id: runId, label: "Review hosts" } },
      );
      const done = store.claim(revision);
      assert(done);
      assert(store.complete({
        taskId: done.task.id,
        leaseToken: done.leaseToken,
        observation: {},
      }));
      const running = store.claim(revision);
      assert(running);
      runningId = running.task.id;
    } finally {
      store.close();
    }
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        const args = {
          action: "graph_overview",
          includeFrontier: true,
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
        };
        const { frontier } = JSON.parse(await read(args));
        assertEquals(frontier.totals, { queued: 6, running: 1, finished: 1 });
        assertEquals(frontier.queued.length, 5);
        assertEquals(frontier.running.map(({ id }: { id: string }) => id), [
          runningId,
        ]);
        assertEquals(frontier.recentFinished.length, 1);
        assert((await read(args, true)).includes("withheld"));
      },
      undefined,
      undefined,
      undefined,
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("planner expands older committed workflow observations and graph facts and gateway reopens the digest after restore", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-intermediate";
  const path = resolveSentinelCasePath(directory, caseId);
  const assets = Array.from({ length: 6 }, (_, index) => ({
    id: `application-${index}`,
    kind: "asset",
    label: `Application ${index}`,
  }));
  const opened = Promise.withResolvers<string>();
  let expanded: string | undefined;
  let reopenedFact: string | undefined;
  const filteredFactPages: string[] = [];
  let oldestFact: SentinelWorkerGraphFact | undefined;
  let newestFact: SentinelWorkerGraphFact | undefined;
  const dependency = {
    id: "dependency",
    kind: "asset",
    label: "Shared dependency",
  };
  const registry = createProviderRegistry();
  registry.register({
    name: "intermediate-digest-planner",
    supportsStreaming: false,
    complete(messages) {
      const reply = messages.findLast(({ role }) => role === "tool");
      if (reply && expanded === undefined) {
        expanded = String(reply.content);
        const member = JSON.parse(expanded).page.members.find((
          { id }: { id: string },
        ) => id === `observation:adaptive:${oldestFact?.id}`);
        assert(member, "Older graph fact should be discoverable in the digest");
        return Promise.resolve(completion("", "sentinel_graph_facts", {
          id: member.id.slice("observation:adaptive:".length),
        }));
      }
      if (reply && reopenedFact === undefined) {
        reopenedFact = String(reply.content);
        return Promise.resolve(completion("", "sentinel_graph_facts", {
          query: "  DEPENDS_ON  ",
          cursor: "start",
        }));
      }
      if (reply) {
        filteredFactPages.push(String(reply.content));
        if (filteredFactPages.length === 1) {
          const cursor = JSON.parse(String(reply.content)).nextCursor;
          assert(typeof cursor === "string");
          assert(oldestFact);
          const journal = openSentinelWorkerGraphFacts(path);
          try {
            newestFact = journal.record({
              ...oldestFact,
              requestId: crypto.randomUUID(),
            }, () => true);
            assert(newestFact);
          } finally {
            journal.close();
          }
          return Promise.resolve(completion("", "sentinel_graph_facts", {
            query: "depends_on",
            cursor,
          }));
        }
        opened.resolve(expanded!);
        return Promise.resolve(completion("[]"));
      }
      const user = String(
        messages.findLast(({ role }) => role === "user")?.content,
      );
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      assertEquals(input.investigationQueueTotals, {
        queued: 0,
        running: 0,
        finished: assets.length,
      });
      assert(
        input.committedObservations.length > 0 &&
          input.committedObservations.length <= 4,
      );
      const [digest] = input.coldHistoryDigests;
      return Promise.resolve(completion("", "sentinel_expand_evidence_digest", {
        revision: input.coldDigestRevision,
        digestId: digest.id,
        limit: 10,
      }));
    },
  });
  registry.setDefault("intermediate-digest-planner");
  const planner = createSentinelModelPlanner(path, (state, taskId) => {
    assertEquals(taskId, undefined);
    return createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      sharedInventoryBaseDir: directory,
      allowModelAccess: true,
      providerRegistry: registry,
      hookRunner: allowHooks,
    });
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [...assets, dependency],
        edges: assets.map(({ id }) => ({
          from: id,
          to: dependency.id,
          relation: "depends_on",
        })),
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let oldest: string | undefined;
    let oldestTaskId: string | undefined;
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    const facts = openSentinelWorkerGraphFacts(path);
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
          reason: "Retain intermediate evidence without a final review",
        })),
        null,
        {
          number: state.revision,
          goal: { id: runId, label: "Review committed defensive observations" },
        },
      );
      for (let index = 0; index < assets.length; index++) {
        const lease = store.claim(revision);
        assert(lease);
        const taskId = lease.task.id;
        assert(
          store.complete({
            taskId,
            leaseToken: lease.leaseToken,
            observation: {},
          }),
        );
        const review = store.claimModelReview(
          revision,
          "Retain intermediate evidence without a final review",
          ({ id }) => id === taskId,
        );
        assert(review);
        const runs = [{
          id: index + 1,
          status: "completed",
          conclusion: "success",
        }];
        assert(
          store.recordLeasedGitHubWorkflowResult(
            revision,
            taskId,
            review.token,
            state.revision,
            {
              repository: "owner/application",
              workflowId: 42,
              connectorId: "github-actions",
              observedAt: new Date(Date.now() + index).toISOString(),
              resultSha256: createHash("sha256").update(JSON.stringify(runs))
                .digest("hex"),
              evidenceRevision: state.revision,
              runs,
            },
          ),
        );
        const receipt = store.commitLeasedWorkflowObservation(
          revision,
          taskId,
          review.token,
          state.revision,
          0,
        );
        assert(receipt);
        oldest ??= receipt.id;
        oldestTaskId ??= taskId;
        const fact = facts.record({
          caseId,
          runId,
          evidenceRevision: state.revision,
          taskId,
          targetId: receipt.targetId,
          relationship: {
            from: receipt.targetId,
            to: dependency.id,
            relation: "depends_on",
          },
          snapshotDigest: digestSentinelSnapshot(snapshot),
          resultSha256: "a".repeat(64),
          sourceStepIndex: 0,
          requestId: crypto.randomUUID(),
        }, () => true);
        assert(fact);
        oldestFact ??= fact;
        assert(
          store.recordModelReviewProgress(revision, taskId, review.token, [{
            tool: "sentinel_publish_workflow_observation",
            target: receipt.id,
            outcome: "returned",
          }]),
        );
        assert(
          store.finishModelReview(
            revision,
            taskId,
            review.token,
            "interrupted",
          ),
        );
      }
      assertEquals(store.modelReviewNotes(revision), []);
      assert(
        store.modelReviewStates(revision).every(({ status }) =>
          status !== "completed"
        ),
      );
    } finally {
      facts.close();
      store.close();
    }
    const factSelection = {
      action: "facts",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      query: "depends_on",
      limit: 3,
    };
    let ownerCursor: string | undefined;
    await withArchivedPlannerRead(directory, async (read) => {
      const { page } = JSON.parse(
        await read({ ...factSelection, cursor: "start" }),
      );
      ownerCursor = page.nextCursor;
      assert(ownerCursor);
      assertEquals(page.facts.length, 3);
      assertEquals(page.total, 6);
      const noMatch = JSON.parse(
        await read({
          ...factSelection,
          cursor: "start",
          query: "other-relationship",
        }),
      ).page;
      assertEquals(noMatch.total, 0);
      assertEquals(noMatch.facts, []);
    });
    planner.advance(state);
    const timeout = setTimeout(
      () => opened.reject(new Error("Planner digest did not expand")),
      2500,
    );
    const liveText = await opened.promise.finally(() => clearTimeout(timeout));
    assert(oldestFact && reopenedFact);
    const { requestId: _privateRequest, ...exactFact } = oldestFact;
    assertEquals(JSON.parse(reopenedFact!), {
      _classification: "INTERNAL",
      ...exactFact,
    });
    assert(
      JSON.parse(liveText).page.members.some((
        { id, status }: { id: string; status: string },
      ) =>
        id === `observation:adaptive:${oldestFact?.id}` &&
        status === "committed"
      ),
    );
    assertEquals(
      filteredFactPages.map((text) => JSON.parse(text).facts.length),
      [3, 3],
    );
    assertEquals(
      JSON.parse(filteredFactPages[1]).facts.at(-1).id,
      oldestFact.id,
    );
    assert(newestFact && ownerCursor);
    assert(filteredFactPages.every((page) => !page.includes(newestFact!.id)));
    const memberId = `observation:adaptive:${oldest}`;
    const deadline = Date.now() + 2000;
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!planner.hasInFlightWork());
    const round = readAdaptiveSentinel(path, state)?.modelPlannerHistory.find((
      { reads },
    ) => reads?.some(({ tool }) => tool === "sentinel_expand_evidence_digest"));
    assert(round);
    const plannerIdentity = round.identity;
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const frontierQuery = {
      ...ref,
      action: "graph_overview",
      includeFrontier: true,
    };
    let beforeArchive: unknown;
    await withArchivedPlannerRead(directory, async (read) => {
      const graph = JSON.parse(await read(frontierQuery));
      assertEquals(graph.frontier.runId, runId);
      assertEquals(graph.frontier.evidenceRevision, state.revision);
      assertEquals(graph.frontier.totals, {
        queued: 0,
        running: 0,
        finished: assets.length,
      });
      assertEquals(graph.frontier.recentFinished.length, 5);
      assert(
        !(await read({ ...frontierQuery, includeFrontier: undefined }))
          .includes("frontier"),
      );
      assert(
        (await read({ ...frontierQuery, revision: state.revision + 1 }))
          .includes("unavailable"),
      );
      beforeArchive = graph.frontier;
    });
    await archiveAndRestoreDigestFixture(directory, path, ref, runId);
    const scope = readAdaptiveSentinel(path, state, "revision");
    assert(scope);
    assert(scope.workflowObservations.some(({ id }) => id === oldest));
    assert(!scope.modelReviews.some(({ taskId }) => taskId === oldestTaskId));

    const plannerPage = JSON.parse(liveText).page;
    const digestRequest = {
      ...ref,
      action: "expand_digest",
      digestId: plannerPage.digest.id,
    };
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        const catalog =
          JSON.parse(await read({ ...ref, action: "list_digests" })).page;
        assert(
          catalog.digests.some(({ id }: { id: string }) =>
            id === digestRequest.digestId
          ),
        );
        const expanded =
          JSON.parse(await read({ ...digestRequest, limit: 1 })).page;
        assertEquals(expanded.members, plannerPage.members.slice(0, 1));
        assert(expanded.nextCursor);
        const next = JSON.parse(
          await read({
            ...digestRequest,
            cursor: expanded.nextCursor,
            limit: plannerPage.members.length - 1,
          }),
        ).page;
        assertEquals(next.members, plannerPage.members.slice(1));
        assertStringIncludes(
          await read({
            ...digestRequest,
            cursor: expanded.nextCursor,
            revision: ref.revision + 1,
          }),
          "unavailable",
        );
        assertStringIncludes(
          await read({
            ...digestRequest,
            id: "different-case",
          }),
          "unavailable",
        );
        assertStringIncludes(
          await read({
            ...ref,
            action: "save_digest",
          }),
          "unavailable",
        );
        const allMembers = [...expanded.members, ...next.members];
        let cursor = next.nextCursor;
        while (cursor) {
          const following = JSON.parse(
            await read({ ...digestRequest, cursor, limit: 10 }),
          ).page;
          allMembers.push(...following.members);
          cursor = following.nextCursor;
        }
        assertEquals(allMembers.find(({ id }) => id === memberId), {
          id: memberId,
          kind: "observation",
          label: "Intermediate workflow observation",
          status: "committed",
        });
        assert(
          !allMembers.some(({ id }) =>
            id === `observation:adaptive:review:${oldestTaskId}`
          ),
        );
        assertStringIncludes(await read(digestRequest, true), "withheld");
      },
      undefined,
      undefined,
      undefined,
      true,
    );

    const selection = {
      action: "planner_reads",
      ...ref,
      plannerIdentity,
      attempt: round.attempt,
      ordinal: 1,
      includeResult: true,
    };
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(frontierQuery)).frontier,
        beforeArchive,
      );
      assertEquals(
        JSON.parse(await read(selection)).result,
        JSON.parse(liveText),
      );
      assertEquals(
        JSON.parse(await read({ ...selection, ordinal: 2 })).result,
        JSON.parse(reopenedFact!),
      );
      const continued =
        JSON.parse(await read({ ...factSelection, cursor: ownerCursor })).page;
      assertEquals(continued.facts, JSON.parse(filteredFactPages[1]).facts);
      assertEquals(continued.nextCursor, null);
      assertEquals(continued.total, 7);
      const fresh =
        JSON.parse(await read({ ...factSelection, cursor: "start" })).page;
      assertEquals(fresh.facts[0].id, newestFact!.id);
      assertEquals(fresh.total, 7);
      for (
        const different of [
          { ...factSelection, query: "dependency" },
          { ...factSelection, limit: 2 },
          { ...factSelection, revision: state.revision + 1 },
          { ...factSelection, id: "another-case" },
        ]
      ) {
        assert(
          (await read({ ...different, cursor: ownerCursor })).includes(
            "unavailable",
          ),
        );
      }
      for (const [index, page] of filteredFactPages.entries()) {
        const selected = { ...selection, ordinal: index + 3 };
        assertEquals(
          JSON.parse(await read(selected)).result,
          JSON.parse(page),
        );
        assert((await read(selected, true)).includes("unavailable"));
      }
      assert((await read(selection, true)).includes("unavailable"));
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "planner-digest-fixture",
        constraints: {
          allowedAssetIds: [assets[0].id],
          deniedKinds: [],
        },
      }));
      const restricted = JSON.parse(await read(frontierQuery)).frontier;
      assertEquals(restricted.totals.finished, 1);
      assertEquals(restricted.recentFinished[0].nodeId, assets[0].id);
      assert((await read(selection)).includes("unavailable"));
      assert(
        (await read({ ...selection, ordinal: 3 })).includes("unavailable"),
      );
      assert(
        (await read({ ...factSelection, cursor: ownerCursor })).includes(
          "unavailable",
        ),
      );
      assert(
        (await read({ ...selection, revision: state.revision + 1 })).includes(
          "unavailable",
        ),
      );
    });
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        assertStringIncludes(
          await read({ ...digestRequest, limit: 10 }),
          "unavailable",
        );
      },
      undefined,
      undefined,
      undefined,
      true,
    );
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("gateway reopens a cold remediation receipt separately from its original finding after restore", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-remediation";
  const path = resolveSentinelCasePath(directory, caseId);
  const now = Date.now();
  const failing = new Date(now - 120_000).toISOString();
  const passing = new Date(now - 60_000).toISOString();
  const expiry = new Date(now + 60_000).toISOString();
  const control = "verification-control";
  const affected = "app";
  const finding = "imported-finding";
  const observed = [
    { id: "failed-check", at: failing, outcome: "fail" },
    { id: "passing-check", at: passing, outcome: "pass" },
  ];
  const registry = createProviderRegistry();
  const expanded = Promise.withResolvers<readonly string[]>();
  let receiptId = "";
  registry.register({
    name: "recheck-digest-planner",
    supportsStreaming: false,
    complete(messages) {
      const outputs = messages.filter(({ role }) => role === "tool")
        .map(({ content }) => String(content));
      if (!outputs.length) {
        const prompt = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
        assert(
          input.findingRechecks?.every(({ id }: { id: string }) =>
            id !== receiptId
          ),
        );
        const [digest] = input.coldHistoryDigests;
        return Promise.resolve(
          completion("", "sentinel_expand_evidence_digest", {
            revision: input.coldDigestRevision,
            digestId: digest.id,
            limit: 10,
          }),
        );
      }
      const latest = JSON.parse(outputs.at(-1)!);
      if (latest.page) {
        const { digest, members, nextCursor } = latest.page;
        if (
          !members.some(({ id }: { id: string }) =>
            id === `observation:adaptive:${receiptId}`
          )
        ) {
          assert(
            nextCursor,
            "The retained digest must contain the exact recheck",
          );
          return Promise.resolve(
            completion("", "sentinel_expand_evidence_digest", {
              revision: digest.scope.evidenceRevision,
              digestId: digest.id,
              limit: 10,
              cursor: nextCursor,
            }),
          );
        }
        return Promise.resolve(
          completion("", "sentinel_worker_findings", { receiptId }),
        );
      }
      expanded.resolve(outputs);
      return Promise.resolve(completion("[]"));
    },
  });
  registry.setDefault("recheck-digest-planner");
  const planner = createSentinelModelPlanner(path, (state, taskId) => {
    assertEquals(taskId, undefined);
    return createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      sharedInventoryBaseDir: directory,
      allowModelAccess: true,
      providerRegistry: registry,
      hookRunner: allowHooks,
    });
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: affected, kind: "asset", label: "Application" },
          { id: "other", kind: "asset", label: "Other asset" },
          {
            id: finding,
            kind: "finding",
            severity: "high",
            label: "Initial issue",
          },
          { id: control, kind: "control", label: "Control" },
          ...observed.map(({ id, at, outcome }) => ({
            id,
            kind: "evidence",
            label: id,
            controlVerification: {
              outcome,
              observedAt: at,
              validUntil: expiry,
            },
          })),
        ],
        edges: [
          { from: finding, to: affected, relation: "affects" },
          { from: control, to: finding, relation: "mitigates" },
          ...observed.flatMap(({ id }) => [
            { from: id, to: control, relation: "verifies" },
            { from: id, to: affected, relation: "observed_on" },
          ]),
        ],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(runId && snapshot);
    const revision = adaptiveRevision(state);
    const adaptive = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const findings = openSentinelWorkerFindingStore(path);
    let taskId: string;
    let originalId: string;
    try {
      const tasks = adaptive.sync(
        revision,
        [{
          kind: "trace",
          nodeId: affected,
          reason: "fixture recheck review",
        }, {
          kind: "impact",
          nodeId: affected,
          reason: "fixture original review",
        }],
        null,
        {
          number: state.revision,
          goal: {
            id: runId,
            label: state.plan.goal ??
              "Investigate prioritized defensive findings",
          },
        },
      );
      const originalTask = tasks.find(({ kind }) => kind === "impact");
      assert(originalTask);
      const lease = adaptive.claim(revision, 60, new Set([originalTask.id]));
      assert(lease);
      taskId = lease.task.id;
      assert(
        adaptive.complete({
          taskId,
          leaseToken: lease.leaseToken,
          observation: {},
        }),
      );
      const review = adaptive.claimModelReview(
        revision,
        "fixture recheck review",
      );
      assert(review);
      const receiptScope = {
        caseId,
        runId,
        taskId,
        targetId: affected,
        graphFindingId: finding,
        controlId: control,
        evidenceRevision: state.revision,
        snapshotDigest: digestSentinelSnapshot(snapshot),
        evaluatedAt: new Date(now).toISOString(),
        validUntil: expiry,
      };
      const original = findings.recordFinding({
        ...receiptScope,
        taskId: originalTask.id,
        evidenceId: "failed-check",
        observedAt: failing,
        title: "Observed failure",
        summary: "Original finding.",
        requestId: crypto.randomUUID(),
      });
      originalId = original.id;
      let workerOutput: string | undefined;
      const workerRegistry = createProviderRegistry();
      workerRegistry.register({
        name: "interrupted-remediation-worker",
        supportsStreaming: false,
        complete(messages) {
          const results = messages.filter(({ role }) => role === "tool");
          if (results.length === 0) {
            return Promise.resolve(
              completion("", "sentinel_finding_recheck_context", {
                findingId: originalId,
              }),
            );
          }
          if (results.length === 1) {
            return Promise.resolve(
              completion("", "sentinel_assigned_target", {}),
            );
          }
          if (results.length === 2) {
            return Promise.resolve(
              completion("", "sentinel_record_finding_recheck", {
                findingId: originalId,
                evidenceId: "passing-check",
                requestId: crypto.randomUUID(),
                summary: "Verified the revised control.",
              }),
            );
          }
          workerOutput = String(results.at(-1)?.content);
          throw new Error(
            "Interrupt before the worker writes its final review",
          );
        },
      });
      workerRegistry.setDefault("interrupted-remediation-worker");
      const worker = createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: review.token,
        allowModelAccess: true,
        providerRegistry: workerRegistry,
        hookRunner: allowHooks,
      });
      await worker.execute("Check the assigned finding.", () => {});
      const { record: committed } = JSON.parse(workerOutput ?? "");
      assertEquals(committed.kind, "recheck");
      assertEquals(committed.findingId, originalId);
      assertEquals(committed.outcome, "pass");
      receiptId = committed.id;
      assert(
        adaptive.finishModelReview(
          revision,
          taskId,
          review.token,
          "interrupted",
        ),
      );
      assertEquals(adaptive.modelReviewNotes(revision), []);
      const recentReason = "fixture newer recheck review";
      const recentTasks = adaptive.sync(
        revision,
        Array.from({ length: 8 }, (_, index) => ({
          kind: "trace" as const,
          nodeId: affected,
          depth: index + 3,
          reason: recentReason,
        })),
        revision,
      ).filter(({ reason }) => reason === recentReason);
      assertEquals(recentTasks.length, 8);
      for (const [index, task] of recentTasks.entries()) {
        const excluded = new Set(
          adaptive.list(revision).filter(({ id }) => id !== task.id).map((
            { id },
          ) => id),
        );
        const queued = adaptive.claim(revision, 60, excluded);
        assert(queued);
        assert(adaptive.complete({
          taskId: task.id,
          leaseToken: queued.leaseToken,
          observation: {},
        }));
        const recentLease = adaptive.claimModelReview(
          revision,
          recentReason,
          ({ id }) => id === task.id,
        );
        assert(recentLease);
        findings.recordRecheck({
          ...receiptScope,
          taskId: recentLease.task.id,
          findingId: originalId,
          evidenceId: "passing-check",
          observedAt: passing,
          outcome: "pass",
          summary: `Recent retained remediation ${index}.`,
          requestId: crypto.randomUUID(),
        });
        assert(adaptive.finishModelReview(
          revision,
          recentLease.task.id,
          recentLease.token,
          "interrupted",
        ));
      }
    } finally {
      findings.close();
      adaptive.close();
    }
    planner.advance(state);
    const timeout = setTimeout(
      () =>
        expanded.reject(new Error("Planner did not reopen the cold recheck")),
      2500,
    );
    const reads = await expanded.promise.finally(() => clearTimeout(timeout));
    const page = reads[0];
    const exact = reads.at(-1)!;
    const exactOrdinal = reads.length;
    assertEquals(JSON.parse(exact).record.id, receiptId);
    assertEquals(JSON.parse(exact).record.findingId, originalId);
    const deadline = Date.now() + 2000;
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!planner.hasInFlightWork());
    const live = readAdaptiveSentinel(path, state, "revision");
    assert(live);
    const node = buildSentinelProvenance(state.result, live).snapshot().nodes
      .find(({ id }) => id === `observation:adaptive:${receiptId}`);
    assert(node && "remediationRecheck" in node);
    assertEquals(node.remediationRecheck?.findingId, originalId);
    assertEquals(node.remediationRecheck?.taskId, taskId);
    assertEquals(node.remediationRecheck?.evidenceId, "passing-check");
    assert(
      !live.tasks.some(({ factSatisfaction }) =>
        factSatisfaction?.findingRecheckId === receiptId
      ),
    );
    const round = live.modelPlannerHistory.find(({ reads }) =>
      reads?.some(({ tool }) => tool === "sentinel_expand_evidence_digest")
    );
    assert(round);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    await archiveAndRestoreDigestFixture(directory, path, ref, runId);
    const selection = {
      action: "planner_reads",
      ...ref,
      plannerIdentity: round.identity,
      attempt: round.attempt,
      ordinal: 1,
      includeResult: true,
    };
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(JSON.parse(await read(selection)).result, JSON.parse(page));
      assertEquals(
        JSON.parse(await read({ ...selection, ordinal: exactOrdinal })).result,
        JSON.parse(exact),
      );
      assert((await read(selection, true)).includes("unavailable"));
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "remediation-digest-fixture",
        constraints: { allowedAssetIds: ["other"], deniedKinds: [] },
      }));
      assert((await read(selection)).includes("unavailable"));
      assert(
        (await read({ ...selection, ordinal: exactOrdinal })).includes(
          "unavailable",
        ),
      );
    });
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Sentinel plans from an exact published case finding and keeps its evidence after withdrawal and restore", async () => {
  const directory = await Deno.makeTempDir();
  const destination = "finding-investigation";
  const source = "reported-source";
  const privateCase = "linked-only";
  const path = resolveSentinelCasePath(directory, destination);
  const sourcePath = resolveSentinelCasePath(directory, source);
  const privatePath = resolveSentinelCasePath(directory, privateCase);
  const graph = {
    version: 1,
    nodes: [{
      id: "app",
      kind: "asset",
      label: "Application",
      aliases: ["reviewed.example"],
    }],
    edges: [],
  };
  const findingGraph = (id: string) => ({
    ...graph,
    nodes: [
      ...graph.nodes,
      { id, kind: "finding", label: "Verified control gap", severity: "low" },
      { id: "original-evidence", kind: "evidence", label: "Reviewed baseline" },
    ],
    edges: [
      { from: id, to: "app", relation: "affects" },
      { from: "original-evidence", to: id, relation: "supports" },
    ],
  });
  const baseReport = findingGraph("original-finding");
  const reported = {
    ...baseReport,
    nodes: baseReport.nodes.map((node) =>
      node.id === "original-evidence"
        ? {
          ...node,
          controlVerification: {
            outcome: "fail",
            observedAt: new Date(Date.now() - 60_000).toISOString(),
            validUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
          },
        }
        : node
    ).concat([{
      id: "current-control",
      kind: "control",
      label: "Current control",
    }]),
    edges: [
      ...baseReport.edges,
      {
        from: "current-control",
        to: "original-finding",
        relation: "mitigates",
      },
      {
        from: "original-evidence",
        to: "current-control",
        relation: "verifies",
      },
      { from: "original-evidence", to: "app", relation: "observed_on" },
    ],
  };
  const unpublished = loadSentinelGraph(findingGraph("unpublished-finding"))
    .snapshot();
  const unpublishedDigest = digestSentinelSnapshot(unpublished);
  const discovery = "sentinel_shared_asset_links";
  const sourceRead = "sentinel_shared_finding_source";
  const find = (sourceCase: string) => ({
    asset: "app",
    sourceCase,
    includeFindings: true,
    limit: 5,
  });
  const result = (
    sourceCase: string,
    finding: string,
    snapshotDigest: string,
  ) => ({
    asset: "app",
    sourceCase,
    sourceAsset: "app",
    finding,
    snapshotDigest,
  });

  const neverPublished = result(
    privateCase,
    "unpublished-finding",
    unpublishedDigest,
  );
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let selectedPlanner:
    | ReturnType<typeof createSentinelModelPlanner>
    | undefined;
  try {
    for (
      const [file, snapshot] of [
        [path, graph],
        [sourcePath, reported],
        [privatePath, graph],
        [
          resolveSentinelCasePath(directory, "other-publication"),
          findingGraph("other-finding"),
        ],
      ] as const
    ) {
      await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(file, JSON.stringify(snapshot), { mode: 0o600 });
    }
    const state = startSentinelAssessment(path);
    const sourceState = startSentinelAssessment(sourcePath);
    const privateState = startSentinelAssessment(privatePath);
    const sourceRevision = adaptiveRevision(sourceState);
    const sourceRunId = sourceState.plan.runId;
    assert(sourceRunId);
    advanceAdaptiveSentinel(sourcePath, sourceState);
    const store = openSentinelAdaptiveStore(
      join(dirname(sourcePath), "sentinel-adaptive.db"),
    );
    const reason = MODEL_ASSIGNMENT_REASON;
    let lease;
    try {
      store.sync(
        sourceRevision,
        [{ kind: "impact", nodeId: "app", reason }],
        sourceRevision,
      );
      advanceAdaptiveSentinel(sourcePath, sourceState);
      lease = store.claimModelReview(
        sourceRevision,
        reason,
        (task) => task.kind === "impact",
      );
    } finally {
      store.close();
    }
    assert(lease);
    const workerRegistry = createProviderRegistry();
    let savedFinding: string | undefined;
    let workerFindingTitle = "Verified worker report";
    workerRegistry.register({
      name: "publication-worker",
      supportsStreaming: false,
      complete(messages) {
        const reply = messages.findLast(({ role }) => role === "tool");
        if (!reply) {
          return Promise.resolve(
            completion("", "sentinel_assigned_target", {}),
          );
        }
        if (String(reply.content).includes("worker-finding:")) {
          savedFinding = JSON.parse(String(reply.content)).record.id;
          return Promise.resolve(
            completion("The verified check was recorded."),
          );
        }
        return Promise.resolve(completion("", "sentinel_report_finding", {
          graphFindingId: "original-finding",
          controlId: "current-control",
          evidenceId: "original-evidence",
          title: workerFindingTitle,
          summary: "Recorded failure from an exact retained check.",
          requestId: crypto.randomUUID(),
        }));
      },
    });
    workerRegistry.setDefault("publication-worker");
    const reportFinding = async () => {
      const worker = createSentinelSubagent({
        snapshotPath: sourcePath,
        assessmentRevision: sourceState.revision,
        snapshotOverride: sourceState.result?.sharedGraph.snapshot,
        assignedTaskId: lease.task.id,
        assignedTaskLeaseToken: lease.token,
        providerRegistry: workerRegistry,
        hookRunner: allowHooks,
        allowModelAccess: true,
      });
      try {
        await worker.execute("Report the verified finding.", () => {});
      } finally {
        worker.clear();
      }
    };
    await reportFinding();
    assert(savedFinding);
    const sourceRef = {
      kind: "sentinel",
      id: source,
      revision: sourceState.revision,
    } as const;
    const selection = { ...sourceRef, receiptId: savedFinding };
    let approved = false;
    let allowed = false;
    let confirmationCount = 0;
    let request: Record<string, unknown> = {};
    await withArchivedPlannerRead(directory, async (read) => {
      const { preview } = JSON.parse(
        await read({ ...selection, action: "preview_finding_publication" }),
      );
      assertEquals(preview.finding.workerFindingSource.taskId, lease!.task.id);
      assertEquals(
        preview.finding.workerFindingSource.evidenceId,
        "original-evidence",
      );
      request = {
        ...selection,
        action: "publish_finding",
        requestId: crypto.randomUUID(),
        reportVersion: preview.finding.workerFindingSource.reportVersion,
        evidenceVersion: preview.evidenceVersion,
      };
      assert((await read(request)).includes("blocked"));
      assertEquals(confirmationCount, 0);
      assertEquals(
        readSentinelWorkerFindingPublications(sourcePath, source),
        [],
      );
      allowed = true;
      assert(
        (await read({ ...request, reportVersion: 2 })).includes("unavailable"),
      );
      assertEquals(confirmationCount, 0);
      assert((await read(request)).includes("declined"));
      assertEquals(
        readSentinelWorkerFindingPublications(sourcePath, source),
        [],
      );
      approved = true;
      const result = JSON.parse(await read(request));
      assertEquals(result.publication.finding.id, savedFinding);
    }, () => {
      confirmationCount++;
      return Promise.resolve(approved);
    }, (hook) => hook !== "PRE_TOOL_CALL" || allowed);
    assertEquals(confirmationCount, 2);
    let denyPublication: "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
    const publicationFrames: string[] = [];
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        assertEquals(
          JSON.parse(await read(request)).publication.finding.id,
          savedFinding,
        );
        denyPublication = "POST_TOOL_RESPONSE";
        assertEquals(await read(request), "Tool response withheld by policy.");
        denyPublication = "PRE_OUTPUT";
        publicationFrames.length = 0;
        assertEquals(
          JSON.parse(await read(request)).publication.finding.id,
          savedFinding,
        );
        assert(
          !publicationFrames.some((frame) => frame.includes(savedFinding!)),
        );
        assert(
          publicationFrames.some((frame) =>
            frame.includes("Tool result withheld by the output policy.")
          ),
        );
      },
      () => {
        throw new Error(
          "A duplicate publication cannot request a new approval",
        );
      },
      (hook, input) =>
        hook !== denyPublication || (hook === "PRE_OUTPUT" &&
          !String(input.content).includes(savedFinding!)),
      (frame) => publicationFrames.push(frame),
    );
    const [publication] = readSentinelWorkerFindingPublications(
      sourcePath,
      source,
    );
    assert(publication);
    const sourceGraph = applySentinelWorkerFindingPublications(
      loadSentinelGraph(reported).snapshot(),
      [publication],
    );
    const publishedDigest = digestSentinelSnapshot(sourceGraph);
    const exact = result(source, savedFinding, publishedDigest);
    await retainSentinelSourceSnapshot(
      directory,
      privateCase,
      unpublishedDigest,
      unpublished,
    );
    const ref = {
      kind: "sentinel",
      id: destination,
      revision: state.revision,
    } as const;
    await withArchivedPlannerRead(directory, async (read) => {
      for (
        const [targetId, targetRevision] of [
          [source, sourceState.revision],
          [privateCase, privateState.revision],
        ] as const
      ) {
        const linked = JSON.parse(
          await read({
            ...ref,
            action: "link",
            targetKind: "sentinel",
            targetId,
            targetRevision,
            requestId: crypto.randomUUID(),
          }),
        );
        assert(linked.link);
      }
    });

    const observations: string[] = [];
    let freshSource = false;
    const finished = Promise.withResolvers<void>();
    const registry = createProviderRegistry();
    registry.register({
      name: "published-finding-planner",
      supportsStreaming: false,
      complete(messages) {
        const toolResponse = messages.findLast(({ role }) => role === "tool");
        if (freshSource) {
          if (!toolResponse) {
            return Promise.resolve(completion("", discovery, find(source)));
          }
          observations.push(String(toolResponse.content));
          return Promise.resolve(completion("[]"));
        }
        if (toolResponse) observations.push(String(toolResponse.content));
        const proposal = {
          assignments: [{
            kind: "trace",
            nodeId: "app",
            depth: 1,
            peerFinding: {
              localAssetId: "app",
              sourceCaseId: source,
              sourceAssetId: "app",
              sourceFindingId: exact.finding,
              snapshotDigest: exact.snapshotDigest,
            },
          }],
          prioritize: [],
        };
        switch (observations.length) {
          case 0:
            return Promise.resolve(
              completion("", discovery, find(privateCase)),
            );
          case 1:
            return Promise.resolve(completion("", sourceRead, neverPublished));
          case 2:
            return Promise.resolve(completion("", discovery, find(source)));
          case 3:
            return Promise.resolve(completion("", sourceRead, exact));
          default:
            finished.resolve();
            return Promise.resolve(completion(JSON.stringify(proposal)));
        }
      },
    });
    registry.setDefault("published-finding-planner");
    const makeAgent = () =>
      createSentinelSubagent({
        snapshotPath: path,
        snapshotOverride: state.result?.sharedGraph.snapshot,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: state.plan.runId,
        sharedInventoryBaseDir: directory,
        allowModelAccess: true,
        providerRegistry: registry,
        hookRunner: allowHooks,
      });
    planner = createSentinelModelPlanner(path, makeAgent);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    const timeout = setTimeout(
      () => finished.reject(new Error("Finding planner did not finish")),
      3000,
    );
    await finished.promise.finally(() => clearTimeout(timeout));
    const deadline = Date.now() + 2500;
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!planner.hasInFlightWork());
    const [privatePage, privateRead, found, opened] = observations;
    assertEquals(JSON.parse(privatePage).findings, []);
    assert(privateRead.includes("not returned"));
    assertEquals(
      JSON.parse(found).findings.map(
        (
          { caseId, finding }: { caseId: string; finding: { id: string } },
        ) => [caseId, finding.id],
      ),
      [[source, "original-finding"], [source, exact.finding]],
    );
    assertEquals(
      JSON.parse(found).findings.find((
        { finding }: { finding: { id: string } },
      ) => finding.id === exact.finding)?.snapshotDigest,
      exact.snapshotDigest,
    );
    assert(opened.startsWith("{"), opened);
    assertEquals(JSON.parse(opened).evidence, [{
      id: publication.evidence.id,
      label: "Reviewed baseline",
    }]);
    assertEquals(
      JSON.parse(opened).finding.workerFindingSource,
      publication.finding.workerFindingSource,
    );
    assertEquals(JSON.parse(opened).sourceSnapshots, [{
      caseId: source,
      assetId: "app",
      snapshotDigest: exact.snapshotDigest,
    }]);
    const adaptive = readAdaptiveSentinel(path, state);
    const task = adaptive?.tasks.find(({ plannerRound }) =>
      plannerRound?.peerFindingCitations?.some(({ sourceCaseId }) =>
        sourceCaseId === source
      )
    );
    assert(
      task,
      "The proposed follow-up must retain the exact published finding",
    );
    assertEquals(
      task.plannerRound?.peerFindingCitations?.[0].snapshotDigest,
      publishedDigest,
    );
    const round = adaptive?.modelPlannerHistory.find(({ reads }) =>
      reads?.some(({ tool }) => tool === sourceRead)
    );
    assert(round);

    const selectedCase = "selected-finding-source";
    const selectedPath = resolveSentinelCasePath(directory, selectedCase);
    await Deno.mkdir(dirname(selectedPath), { recursive: true, mode: 0o700 });
    const selectedAsset = "local-app";
    const selectedGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === "app" ? { ...node, id: selectedAsset } : node
      ),
    };
    await Deno.writeTextFile(selectedPath, JSON.stringify(selectedGraph), {
      mode: 0o600,
    });
    await withArchivedPlannerRead(directory, async (read) => {
      const linked = JSON.parse(
        await read({
          ...ref,
          action: "spawn",
          targetKind: "sentinel",
          targetId: selectedCase,
          sourceCases: [{ caseId: source, revision: sourceState.revision }],
          requestId: crypto.randomUUID(),
        }),
      );
      assertEquals(linked.run.ref.id, selectedCase);
    });
    const selected = readSentinelAssessment(selectedPath);
    assert(selected?.plan.runId);
    const selectedRef = {
      kind: "sentinel",
      id: selectedCase,
      revision: selected.revision,
    } as const;
    const selectedMember = resolveSentinelCaseMembership(
      selected.result?.sharedGraph.snapshot,
      {
        caseId: selectedCase,
        evidenceRevision: selected.revision,
        selector: { kind: "assets", assetIds: [selectedAsset] },
      },
    );
    assert(selectedMember);
    const selectedPolicy = recordSentinelOperatingConstraints(selectedPath, {
      runId: selected.plan.runId,
      evidenceRevision: selected.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "peer-coverage-fixture-owner",
      constraints: {
        allowedAssetIds: selectedMember.assetIds,
        deniedKinds: [],
      },
      membership: selectedMember,
    });
    assert(selectedPolicy);
    const findSelected = (caseId: string) => ({
      ...find(caseId),
      asset: selectedAsset,
    });
    const exactSelected = { ...exact, asset: selectedAsset };
    const localCoverage = {
      view: "coverage",
      assetId: selectedAsset,
      coverageGap: "missing_evidence",
    };
    const linkedCoverage = { ...localCoverage, linkedFinding: exactSelected };
    const inventoryRead = "sentinel_case_inventory";
    const selectedReads: string[] = [];
    const selectedDone = Promise.withResolvers<void>();
    let readSelectedAgain = false;
    const catalogReads: Array<
      Array<{
        localAssetId: string;
        sourceCaseId: string;
        sourceRunId: string;
        sourceEvidenceRevision: number;
        sourceAssetId: string;
        findingId: string;
      }>
    > = [];
    let selectedNow = Date.now();

    const selectedProviders = createProviderRegistry();
    selectedProviders.register({
      name: "selected-source-model",
      supportsStreaming: false,
      complete(messages) {
        const prior = messages.findLast(({ role }) => role === "tool");
        if (!prior) {
          const prompt = messages.findLast(({ role }) => role === "user")
            ?.content;
          if (
            typeof prompt === "string" &&
            prompt.includes('"approvedDiscoverySources"')
          ) {
            const input = JSON.parse(
              prompt.slice(prompt.lastIndexOf("\n") + 1),
            );
            catalogReads.push(input.linkedFindingCandidates ?? []);
          }
        }
        if (readSelectedAgain) {
          if (!prior) {
            return Promise.resolve(
              completion("", discovery, findSelected(source)),
            );
          }
          selectedReads.push(String(prior.content));
          return Promise.resolve(completion("[]"));
        }
        selectedReads.splice(
          0,
          selectedReads.length,
          ...messages
            .filter(({ role }) => role === "tool")
            .map(({ content }) => String(content)),
        );
        switch (selectedReads.length) {
          case 0:
            return Promise.resolve(
              completion("", discovery, findSelected("other-publication")),
            );
          case 1: {
            const [candidate] = catalogReads[0];
            assert(candidate);
            return Promise.resolve(completion("", discovery, {
              ...findSelected(candidate.sourceCaseId),
              asset: candidate.localAssetId,
            }));
          }
          case 2:
            return Promise.resolve(completion("", sourceRead, exactSelected));
          case 3:
            return Promise.resolve({
              ...completion(""),
              toolCalls: [
                localCoverage,
                linkedCoverage,
                {
                  view: "coverage",
                  assetId: selectedAsset,
                  linkedFinding: exactSelected,
                },
                {
                  ...linkedCoverage,
                  linkedFinding: { ...exactSelected, sourceCase: privateCase },
                },
              ].map((args, index) => ({
                type: "function",
                id: "coverage-" + index,
                function: {
                  name: inventoryRead,
                  arguments: JSON.stringify(args),
                },
              })),
            });
          default:
            selectedDone.resolve();
            return Promise.resolve(completion(JSON.stringify({
              assignments: [{
                kind: "trace",
                nodeId: selectedAsset,
                depth: 1,
                peerFinding: {
                  localAssetId: selectedAsset,
                  sourceCaseId: source,
                  sourceAssetId: "app",
                  sourceFindingId: exact.finding,
                  snapshotDigest: exact.snapshotDigest,
                },
              }],
              prioritize: [],
            })));
        }
      },
    });
    selectedProviders.setDefault("selected-source-model");
    const createSelectedAgent = () =>
      createSentinelSubagent({
        snapshotPath: selectedPath,
        assessmentRevision: selected.revision,
        plannerExecutionEvidenceRunId: selected.plan.runId,
        sharedInventoryBaseDir: directory,
        allowModelAccess: true,
        providerRegistry: selectedProviders,
        hookRunner: allowHooks,
      });
    selectedPlanner = createSentinelModelPlanner(
      selectedPath,
      createSelectedAgent,
      undefined,
      () => selectedNow,
    );
    selectedPlanner.advance(selected);
    const selectedTimeout = setTimeout(
      () =>
        selectedDone.reject(
          new Error("Selected source planner did not finish"),
        ),
      3000,
    );
    await selectedDone.promise.finally(() => clearTimeout(selectedTimeout));
    const selectedDeadline = Date.now() + 2500;
    while (selectedPlanner.hasInFlightWork() && Date.now() < selectedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!selectedPlanner.hasInFlightWork());
    assertEquals(catalogReads, [[{
      localAssetId: selectedAsset,
      sourceCaseId: source,
      sourceRunId,
      sourceEvidenceRevision: sourceState.revision,
      sourceAssetId: exact.sourceAsset,
      findingId: exact.finding,
    }]]);

    assertStringIncludes(selectedReads[0], "unavailable");
    assertEquals(
      JSON.parse(selectedReads[1]).findings.map(
        ({ finding }: { finding: { id: string } }) => finding.id,
      ),
      [exact.finding],
    );
    assertEquals(
      JSON.parse(selectedReads[2]).finding.workerFindingSource,
      publication.finding.workerFindingSource,
    );
    assertEquals(
      JSON.parse(selectedReads[3]).assets[0].asset.id,
      selectedAsset,
    );
    const exactCoveragePage = JSON.parse(selectedReads[4]);
    assertEquals(exactCoveragePage.assets, []);
    assertEquals(
      exactCoveragePage.peerCoverage.source,
      publication.finding.workerFindingSource,
    );
    const completeCoverage = JSON.parse(selectedReads[5]);
    assertEquals(completeCoverage.assets[0].reviewed, false);
    assertEquals(completeCoverage.assets[0].evidence, []);
    const selectedHistory = readAdaptiveSentinel(selectedPath, selected);
    const selectedTask = selectedHistory?.tasks.find(({ plannerRound }) =>
      plannerRound?.peerFindingCitations?.some(({ sourceFindingId }) =>
        sourceFindingId === exact.finding
      )
    );
    assert(selectedTask, "The linked source should lead to a cited follow-up");
    const selectedRound = selectedHistory?.modelPlannerHistory.find((
      { reads },
    ) => reads?.some(({ tool }) => tool === sourceRead));
    assert(selectedRound);
    const selectedOriginal = JSON.parse(selectedReads[2]);
    assertStringIncludes(selectedReads[6], "unavailable");
    const peerCoverageOrdinal = selectedRound.reads
      ?.flatMap(({ tool }, index) => tool === inventoryRead ? [index + 1] : [])
      .at(1) ?? 0;
    assert(peerCoverageOrdinal > 0);
    const peerCoverageRead = {
      ...selectedRef,
      action: "planner_reads",
      plannerIdentity: selectedRound.identity,
      attempt: selectedRound.attempt,
      ordinal: peerCoverageOrdinal,
      includeResult: true,
    };
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(peerCoverageRead)).result,
        exactCoveragePage,
      );
    });
    const ownerLinkedFinding = {
      ...selectedRef,
      action: "linked_finding",
      linkedFinding: exactSelected,
    };
    const catalog = {
      ...selectedRef,
      action: "linked_findings",
      assetId: selectedAsset,
      sourceCase: source,
    };
    let ownerFinding: unknown;
    let savedCatalog: unknown;
    let denySource = false;
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        ownerFinding = JSON.parse(await read(ownerLinkedFinding));
        assertEquals(ownerFinding, {
          run: selectedRef,
          inherited: true,
          source: publication.finding.workerFindingSource,
          detail: selectedOriginal,
          _classification: "INTERNAL",
        });
        assertStringIncludes(
          await read({ ...ownerLinkedFinding, ...ref }),
          "unavailable",
        );
        assertStringIncludes(
          await read({
            ...ownerLinkedFinding,
            linkedFinding: { ...exactSelected, asset: "app" },
          }),
          "unavailable",
        );
        savedCatalog = JSON.parse(await read(catalog));
        const [item] = JSON.parse(JSON.stringify(savedCatalog)).entries;
        assertEquals(item.source, publication.finding.workerFindingSource);
        assertEquals(item.inherited, true);
        const catalogFind = JSON.parse(
          await read({ ...ownerLinkedFinding, linkedFinding: item.selector }),
        );
        assertEquals(catalogFind.source, item.source);
        assertStringIncludes(
          await read({ ...catalog, assetId: "app" }),
          "unavailable",
        );
        assertStringIncludes(
          await read({ ...catalog, sourceCase: privateCase }),
          "unavailable",
        );
        denySource = true;
        assertEquals(JSON.parse(await read(catalog)).entries, []);
        assertStringIncludes(await read(ownerLinkedFinding), "unavailable");
      },
      undefined,
      (hook, input) =>
        !(denySource && hook === "PRE_TOOL_CALL" &&
          JSON.stringify(input).includes('"finding_report"')),
    );
    const firstReceipt = savedFinding;
    workerFindingTitle = "Second verified worker report";
    await reportFinding();
    const secondReceipt = savedFinding;
    assert(secondReceipt && secondReceipt !== firstReceipt);
    savedFinding = firstReceipt;
    await withArchivedPlannerRead(directory, async (read) => {
      const selection = { ...sourceRef, receiptId: secondReceipt };
      const { preview } = JSON.parse(
        await read({ ...selection, action: "preview_finding_publication" }),
      );
      assert(
        JSON.parse(
          await read({
            ...selection,
            action: "publish_finding",
            requestId: crypto.randomUUID(),
            reportVersion: preview.finding.workerFindingSource.reportVersion,
            evidenceVersion: preview.evidenceVersion,
          }),
        ).publication,
      );
      const first = JSON.parse(await read({ ...catalog, limit: 1 }));
      assert(first.nextCursor);
      const next = JSON.parse(
        await read({ ...catalog, limit: 1, cursor: first.nextCursor }),
      );
      assertEquals(next.nextCursor, null);
      assertEquals(
        [first.entries[0].selector.finding, next.entries[0].selector.finding]
          .sort(),
        [firstReceipt, secondReceipt].sort(),
      );
      assert(
        JSON.parse(
          await read({
            ...selection,
            action: "withdraw_published_finding",
            requestId: crypto.randomUUID(),
          }),
        ).publication.withdrawal,
      );
      assertStringIncludes(
        await read({ ...catalog, limit: 1, cursor: first.nextCursor }),
        "unavailable",
      );
    });
    readSelectedAgain = true;
    const readSelected = async () => {
      const agent = createSelectedAgent();
      try {
        await agent.execute(
          "Read current approvals for the selected source.",
          () => {},
          undefined,
          undefined,
          undefined,
          {
            operatingConstraints: {
              version: selectedPolicy.version,
              digest: selectedPolicy.digest,
            },
          },
        );
        return JSON.parse(selectedReads.at(-1)!).findings;
      } finally {
        agent.clear();
      }
    };

    assert(state.plan.runId);
    const changePolicy = (
      expectedVersion: number,
      deniedKinds: readonly ("review_evidence")[],
    ) => {
      const policy = recordSentinelOperatingConstraints(path, {
        runId: state.plan.runId!,
        evidenceRevision: state.revision,
        expectedVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "shared-finding-fixture",
        constraints: { deniedKinds },
      });
      assert(policy);
      return policy;
    };
    const readCurrent = async (
      operatingConstraints: { version: number; digest: string },
    ) => {
      freshSource = true;
      const agent = makeAgent();
      try {
        await agent.execute(
          "Find currently published source records.",
          () => {},
          undefined,
          undefined,
          undefined,
          { operatingConstraints },
        );
        return observations.at(-1)!;
      } finally {
        agent.clear();
      }
    };
    const restricted = changePolicy(0, ["review_evidence"]);
    assert(
      (await readCurrent(restricted)).includes("unavailable to this planner"),
    );
    const restoredPolicy = changePolicy(1, []);

    const sourcePolicy = (expectedVersion: number, denied: boolean) =>
      recordSentinelOperatingConstraints(sourcePath, {
        runId: sourceRunId,
        evidenceRevision: sourceState.revision,
        expectedVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "shared-finding-source-fixture",
        constraints: { deniedKinds: denied ? ["review_evidence"] : [] },
      });
    assert(sourcePolicy(0, true));
    assertEquals(await readSelected(), []);
    await withArchivedPlannerRead(directory, async (read) => {
      assertStringIncludes(await read(ownerLinkedFinding), "unavailable");
    });
    await withArchivedPlannerRead(directory, async (read) => {
      const response = await read({
        ...selectedRef,
        action: "hint",
        note: "Check current reviewed sources.",
        requestId: crypto.randomUUID(),
      });
      assert(!response.startsWith("Error:"), response);
    });
    selectedNow += 60_001;
    selectedPlanner.advance(selected);
    const catalogDeadline = Date.now() + 2500;
    while (
      (catalogReads.length < 2 || selectedPlanner.hasInFlightWork()) &&
      Date.now() < catalogDeadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(catalogReads.length, 2);
    assertEquals(catalogReads[1], []);

    assert(sourcePolicy(1, false));
    assertEquals(
      (await readSelected()).map(
        ({ finding }: { finding: { id: string } }) => finding.id,
      ),
      [exact.finding],
    );

    await archiveAndRestoreDigestFixture(
      directory,
      selectedPath,
      selectedRef,
      selected.plan.runId,
    );
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(peerCoverageRead)).result,
        exactCoveragePage,
      );
      assertStringIncludes(await read(peerCoverageRead, true), "unavailable");
      assertEquals(JSON.parse(await read(ownerLinkedFinding)), ownerFinding);
      assertEquals(JSON.parse(await read(catalog)), savedCatalog);
    });
    const resumed = resumeSentinelAssessment(
      selectedPath,
      undefined,
      selected.revision,
      selected.plan.runId,
    );
    assertEquals(resumed?.revision, selected.revision);

    // Withdrawal hides the promoted finding and leaves the operator's base graph intact.
    await withArchivedPlannerRead(directory, async (read) => {
      const withdraw = {
        ...selection,
        action: "withdraw_published_finding",
        requestId: crypto.randomUUID(),
      };
      const withdrawn = JSON.parse(await read(withdraw)).publication;
      assertEquals(withdrawn.withdrawal.requestId, withdraw.requestId);
      assertEquals(JSON.parse(await read(withdraw)).publication, withdrawn);
    });
    assertEquals(
      JSON.parse(await readCurrent(restoredPolicy)).findings.map(
        ({ finding }: { finding: { id: string } }) => finding.id,
      ),
      ["original-finding"],
    );
    assertEquals(await readSelected(), []);
    await withArchivedPlannerRead(directory, async (read) => {
      const ordinal = (selectedRound.reads?.findLastIndex(({ tool }) =>
        tool === sourceRead
      ) ?? -1) + 1;
      assert(ordinal > 0);
      const reopened = JSON.parse(
        await read({
          ...selectedRef,
          action: "planner_reads",
          plannerIdentity: selectedRound.identity,
          attempt: selectedRound.attempt,
          ordinal,
          includeResult: true,
        }),
      );
      assertEquals(reopened.result, selectedOriginal);
      assertStringIncludes(await read(peerCoverageRead), "unavailable");
      assertStringIncludes(await read(ownerLinkedFinding), "unavailable");
    });
    await archiveAndRestoreDigestFixture(
      directory,
      sourcePath,
      sourceRef,
      sourceRunId,
    );
    assert(
      readSentinelWorkerFindingPublications(sourcePath, source)[0].withdrawal,
    );

    await archiveAndRestoreDigestFixture(
      directory,
      path,
      ref,
      state.plan.runId,
    );
    await withArchivedPlannerRead(directory, async (read) => {
      for (
        const [tool, original] of [[discovery, found], [
          sourceRead,
          opened,
        ]] as const
      ) {
        const ordinal = (round.reads?.findLastIndex((row) =>
          row.tool === tool
        ) ?? -1) + 1;
        assert(ordinal > 0);
        const selection = {
          ...ref,
          action: "planner_reads",
          plannerIdentity: round.identity,
          attempt: round.attempt,
          ordinal,
          includeResult: true,
        };
        assertEquals(
          JSON.parse(await read(selection)).result,
          JSON.parse(original),
        );
        assert((await read(selection, true)).includes("unavailable"));
      }
    });
  } finally {
    selectedPlanner?.stop();
    planner?.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner input and commit honor mid-flight source asset revocation", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "scope-planner-evidence";
  const path = resolveSentinelCasePath(directory, caseId);
  const assets = [
    "allowed",
    ...Array.from({ length: 4 }, (_, i) => `denied-${i}`),
  ];
  const extraAssets = Array.from(
    { length: 34 },
    (_, i) => `extra-approved-${i}`,
  );
  const permittedAssets = ["allowed", ...extraAssets].sort();
  const allowedMarker = "Approved evidence from the allowed asset.";
  const privateMarker = "Evidence outside the later approved asset scope.";
  const firstInput = Promise.withResolvers<string>();
  const scopedInput = Promise.withResolvers<string>();
  const held = Promise.withResolvers<void>();
  let narrower = false;
  let allowedTaskId = "";
  let deniedTaskId = "";
  const deniedTaskIds: string[] = [];
  let clock = Date.now();
  const providers = createProviderRegistry();
  providers.register({
    name: "planner-scope",
    supportsStreaming: false,
    async complete(messages) {
      const lastTool = messages.findLast(({ role }) => role === "tool");
      const prompt = String(
        messages.find(({ role }) => role === "user")?.content,
      );
      if (!narrower) {
        if (!lastTool) {
          return completion("", "sentinel_worker_observation", {
            task: deniedTaskId,
          });
        }
        assertStringIncludes(String(lastTool.content), privateMarker);
        firstInput.resolve(prompt);
        await held.promise;
        return completion(JSON.stringify([{
          kind: "trace",
          nodeId: "allowed",
          depth: 1,
          sourceTaskId: deniedTaskId,
          sourceKind: "worker_result",
        }]));
      }
      if (lastTool) {
        assertStringIncludes(String(lastTool.content), allowedMarker);
        return completion(JSON.stringify([{
          kind: "trace",
          nodeId: "allowed",
          depth: 2,
          sourceTaskId: allowedTaskId,
          sourceKind: "worker_result",
        }]));
      }
      scopedInput.resolve(prompt);
      return completion("", "sentinel_worker_observation", {
        task: allowedTaskId,
      });
    },
  });
  providers.setDefault("planner-scope");
  const planner = createSentinelModelPlanner(
    path,
    (state, taskId) =>
      taskId
        ? { execute: () => Promise.resolve(), clear() {} }
        : createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry: providers,
          hookRunner: allowHooks,
          allowModelAccess: true,
        }),
    undefined,
    () => clock,
  );
  const wait = async (condition: () => boolean) => {
    const end = Date.now() + 3000;
    while (!condition() && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(condition());
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [...assets, ...extraAssets].map((id) => ({
          id,
          kind: "asset",
          label: id,
        })),
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(
        revision,
        assets.map((nodeId) => ({
          kind: "impact",
          nodeId,
          reason: "Existing defensive result.",
        })),
        null,
        {
          number: state.revision,
          goal: { id: runId, label: "Review saved results" },
        },
      );
      for (const asset of assets) {
        const claimed = store.claim(revision);
        assert(claimed);
        assertEquals(claimed.task.nodeId, asset);
        if (asset === "allowed") allowedTaskId = claimed.task.id;
        else {
          deniedTaskId = claimed.task.id;
          deniedTaskIds.push(claimed.task.id);
        }
        assert(store.complete({
          taskId: claimed.task.id,
          leaseToken: claimed.leaseToken,
          observation: {
            relatedNodeIds: [asset, "allowed"],
            summary: asset === "allowed" ? allowedMarker : privateMarker,
          },
        }));
      }
    } finally {
      store.close();
    }
    planner.advance(state);
    const initial = await Promise.race([
      firstInput.promise,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 2000)),
    ]);
    assertStringIncludes(initial, deniedTaskId);
    await withArchivedPlannerRead(directory, async (read) => {
      const narrowed = JSON.parse(
        await read({
          action: "narrow_constraints",
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
          runId,
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          deniedKinds: [],
          allowedAssetIds: permittedAssets,
        }),
      );
      assertEquals(
        narrowed.record.constraints.allowedAssetIds,
        permittedAssets,
      );
    });
    narrower = true;
    held.resolve();
    await wait(() => !planner.hasInFlightWork());
    assert(
      !readAdaptiveSentinel(path, state)?.tasks.some((
        { kind, depth, nodeId, prerequisites },
      ) =>
        kind === "trace" && depth === 1 && nodeId === "allowed" &&
        prerequisites.includes(deniedTaskId)
      ),
    );

    clock += 61_000;
    planner.advance(readSentinelAssessment(path)!);
    const prompt = await Promise.race([
      scopedInput.promise,
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 2000)),
    ]);
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert(!prompt.includes(privateMarker));
    assert(input.inventory.length > 0);
    assert(
      input.inventory.every(({ id }: { id: string }) =>
        permittedAssets.includes(id)
      ),
    );
    assert(input.coldDigests?.length);
    assertEquals(
      input.workerObservations.map(({ taskId }: { taskId: string }) => taskId),
      [allowedTaskId],
    );
    const digests = openSentinelEvidenceDigests(directory);
    try {
      for (const { id } of input.coldHistoryDigests ?? []) {
        const page = digests.expand(
          { caseId, runId, evidenceRevision: state.revision },
          id,
          20,
        );
        assert(page);
        assert(
          !page.members.some(({ id }) =>
            deniedTaskIds.some((excluded) => id.includes(excluded))
          ),
        );
      }
    } finally {
      digests.close();
    }

    await withArchivedPlannerRead(directory, async (read) => {
      const retained = JSON.parse(
        await read({
          action: "expand_digest",
          kind: "sentinel",
          id: caseId,
          revision: state.revision,
          digestId: input.coldDigests[0].id,
          limit: 10,
        }),
      ).page;
      assert(retained.members.length > 0);
      assert(
        retained.members.every(({ id }: { id: string }) =>
          permittedAssets.includes(id.slice("asset:".length))
        ),
      );
    });

    const followup = () =>
      readAdaptiveSentinel(path, state)?.tasks.find(({ kind, depth, nodeId }) =>
        kind === "trace" && depth === 2 && nodeId === "allowed"
      );
    await wait(() => !!followup());
    assertEquals(followup()?.prerequisites, [allowedTaskId]);
  } finally {
    held.resolve();
    planner.stop();
    await wait(() => !planner.hasInFlightWork());
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Retained digest pages reauthorize every assignment before and after archive", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "retained-digest-revocation";
  const path = resolveSentinelCasePath(directory, caseId);
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: ["allowed", "restricted", "also-allowed"].map((id) => ({
          id,
          kind: "asset",
          label: id,
        })),
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const revision = adaptiveRevision(state);
    const adaptive = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let taskId: string;
    try {
      adaptive.sync(
        revision,
        [{
          kind: "impact",
          nodeId: "restricted",
          reason: "Retained defensive evidence",
        }],
        null,
        { number: state.revision, goal: { id: runId, label: "Review scope" } },
      );
      const lease = adaptive.claim(revision);
      assert(lease);
      taskId = lease.task.id;
      assert(adaptive.complete({
        taskId,
        leaseToken: lease.leaseToken,
        observation: { summary: "Retained result for the restricted asset." },
      }));
    } finally {
      adaptive.close();
    }
    const publicMember = {
      id: "asset:allowed",
      kind: "asset" as const,
      label: "Allowed asset",
    };
    let catalogClock = Date.now() + 1000;
    const digests = openSentinelEvidenceDigests(
      directory,
      () => ++catalogClock,
    );
    let ids: string[];
    let alsoAllowed: string;
    try {
      const scope = { caseId, runId, evidenceRevision: state.revision };
      ids = [
        [publicMember],
        [publicMember, {
          id: "asset:restricted",
          kind: "asset" as const,
          label: "Restricted inventory asset",
        }],
        ...[
          ["task:adaptive:", "task"],
          ["observation:adaptive:", "observation"],
          ["observation:adaptive:review:", "observation"],
        ].map(([prefix, kind]) => [
          publicMember,
          {
            id: prefix + taskId,
            kind: kind as "task" | "observation",
            label: "Restricted assignment",
          },
        ]),
      ].map((members) => {
        const retained = digests.record(scope, { members });
        assert(retained);
        return retained.id;
      });
      const authorized = digests.record(scope, {
        members: [{
          id: "asset:also-allowed",
          kind: "asset",
          label: "Another authorized asset",
        }],
      });
      assert(authorized);
      alsoAllowed = authorized.id;
    } finally {
      digests.close();
    }
    const request = (digestId: string) => ({
      ...ref,
      action: "expand_digest",
      digestId,
      limit: 1,
    });
    const providers = createProviderRegistry();
    providers.register({
      name: "digest-revocation-planner",
      supportsStreaming: false,
      complete(messages) {
        const reads = messages.filter(({ role }) => role === "tool");
        if (reads.length < 2) {
          return Promise.resolve(
            completion("", "sentinel_list_evidence_digests", {
              revision: state.revision,
              limit: reads.length + 1,
            }),
          );
        }
        if (reads.length === 2) {
          return Promise.resolve(
            completion("", "sentinel_expand_evidence_digest", {
              revision: state.revision,
              digestId: ids[1],
              limit: 1,
            }),
          );
        }
        return Promise.resolve(completion("[]"));
      },
    });
    providers.setDefault("digest-revocation-planner");
    const planner = createSentinelModelPlanner(
      path,
      (assessment, assignment) =>
        assignment
          ? { execute: () => Promise.resolve(), clear() {} }
          : createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: assessment.revision,
            plannerExecutionEvidenceRunId: runId,
            providerRegistry: providers,
            hookRunner: allowHooks,
            allowModelAccess: true,
          }),
    );
    try {
      planner.advance(state);
      const end = Date.now() + 4000;
      while (planner.hasInFlightWork() && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert(!planner.hasInFlightWork());
    } finally {
      planner.stop();
    }
    const round = readAdaptiveSentinel(path, state)?.modelPlannerHistory.find(
      ({ reads }) =>
        reads?.some(({ tool }) => tool === "sentinel_expand_evidence_digest"),
    );
    assert(round);
    const retainedRead = {
      ...ref,
      action: "planner_reads",
      plannerIdentity: round.identity,
      attempt: round.attempt,
      ordinal: 3,
      includeResult: true,
    };
    const permittedCatalogRead = { ...retainedRead, ordinal: 1 };
    const mixedCatalogRead = { ...retainedRead, ordinal: 2 };
    const catalogRequest = { ...ref, action: "list_digests", limit: 1 };
    const cursors: string[] = [];
    const unavailable = "Error: This operation or exact run is unavailable.";
    const digestUnavailable =
      "Error: The requested evidence digest or revision is unavailable.";
    let allowedPage = "";
    let retainedCatalog = "";
    await withArchivedPlannerRead(directory, async (read) => {
      for (const id of ids.slice(1)) {
        const { page } = JSON.parse(await read(request(id)));
        assertEquals(page.members, [publicMember]);
        assert(page.nextCursor);
        cursors.push(page.nextCursor);
      }
      assertEquals(JSON.parse(await read(retainedRead)).result.page.members, [
        publicMember,
      ]);
      allowedPage = await read(request(ids[0]));
      assertEquals(JSON.parse(allowedPage).page.members, [publicMember]);
      retainedCatalog = await read(permittedCatalogRead);
      assertEquals(
        JSON.parse(retainedCatalog).result.page.digests[0].id,
        alsoAllowed,
      );
      assertEquals(
        JSON.parse(await read(mixedCatalogRead)).result.page.digests.map(
          ({ id }: { id: string }) => id,
        ),
        [alsoAllowed, ids.at(-1)],
      );
    });

    let changedDuringSourceResponse = false;
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        assertEquals(await read(retainedRead), unavailable);
        assert(changedDuringSourceResponse);
      },
      undefined,
      undefined,
      undefined,
      false,
      async (hook, input) => {
        if (
          hook !== "POST_TOOL_RESPONSE" ||
          input.tool_name !== "sentinel_expand_evidence_digest" ||
          changedDuringSourceResponse
        ) return;
        await Promise.resolve();
        assert(recordSentinelOperatingConstraints(path, {
          runId,
          evidenceRevision: state.revision,
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          operatorScope: "digest-source-hook-fixture",
          constraints: {
            deniedKinds: [],
            allowedAssetIds: ["allowed", "also-allowed"],
          },
        }));
        changedDuringSourceResponse = true;
      },
    );
    for (const archived of [false, true]) {
      if (archived) {
        await archiveAndRestoreDigestFixture(directory, path, ref, runId);
      }
      await withArchivedPlannerRead(directory, async (read) => {
        assertEquals(await read(retainedRead), unavailable);
        assertEquals(await read(request(ids[0])), allowedPage);
        assertEquals(await read(permittedCatalogRead), retainedCatalog);
        assertEquals(await read(mixedCatalogRead), unavailable);
        const page = JSON.parse(await read(catalogRequest)).page;
        assertEquals(page.digests.map(({ id }: { id: string }) => id), [
          alsoAllowed,
        ]);
        assertEquals(page.nextCursor, alsoAllowed);
        const next =
          JSON.parse(await read({ ...catalogRequest, cursor: page.nextCursor }))
            .page;
        assertEquals(next.digests.map(({ id }: { id: string }) => id), [
          ids[0],
        ]);
        assertEquals(next.nextCursor, null);
        assertEquals(
          await read({ ...catalogRequest, cursor: ids.at(-1) }),
          digestUnavailable,
        );
        for (const [index, id] of ids.slice(1).entries()) {
          assertEquals(await read(request(id)), digestUnavailable);
          assertEquals(
            await read({
              ...request(id),
              cursor: cursors[index],
            }),
            digestUnavailable,
          );
        }
      });
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Scoped incident discovery and assignment require every retained member asset", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "scoped-incident-membership";
  const path = resolveSentinelCasePath(directory, caseId);
  const names = ["approved", "excluded", "spare"];
  const observedAt = "2026-01-01T00:00:00.000Z";
  const alert = (
    asset: string,
    type: string,
    subject: string,
    minute: string,
  ) => ({
    asset,
    subject,
    type,
    severity: "high",
    observedAt: observedAt.replace("00:00:00", `00:${minute}:00`),
    evidenceIds: [`${asset}-${type}-${minute}`],
  });
  const availableAlert = {
    ...alert("approved", "integrity_change", "Allowed cohort", "00"),
    severity: "high" as const,
    type: "integrity_change" as const,
    triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
  };
  const availableAlertId = sentinelAlertReference(availableAlert);
  const plannerInput = Promise.withResolvers<string>();
  const held = Promise.withResolvers<void>();
  let allowedIncident = "";
  let mixedIncident = "";
  let approvedReview = "";
  let reading = true;
  let clock = Date.now();
  const observationRead = Promise.withResolvers<string>();
  const providers = createProviderRegistry();
  providers.register({
    name: "scoped-incident-membership",
    supportsStreaming: false,
    async complete(messages) {
      const prompt = String(
        messages.find(({ role }) => role === "user")?.content,
      );
      if (prompt.startsWith("Plan a defensive investigation")) {
        if (reading) {
          const reads = messages.filter(({ role }) => role === "tool");
          if (!reads.length) {
            return completion("", "sentinel_incident_alerts", {
              incidentId: mixedIncident,
            });
          }
          assertStringIncludes(String(reads[0].content), "unavailable");
          if (reads.length === 1) {
            return completion("", "sentinel_incident_alerts", {
              incidentId: allowedIncident,
            });
          }
          assertEquals(JSON.parse(String(reads[1].content)).total, 2);
          if (reads.length === 2) {
            return completion("", "sentinel_worker_observation", {
              task: approvedReview,
            });
          }
          const text = String(reads[2].content);
          assertEquals(JSON.parse(text).task, approvedReview);
          observationRead.resolve(text);
          return completion("[]");
        }
        const checked = messages.findLast(({ role }) => role === "tool");
        if (!checked) {
          return completion("", "sentinel_defense", {
            upstreamCheck: "cloudtrail_logging_stopped",
            alertId: availableAlertId,
          });
        }
        assertEquals(
          JSON.parse(String(checked.content)).matches[0].alertId,
          availableAlertId,
        );
        plannerInput.resolve(prompt);
        await held.promise;
        return completion(JSON.stringify([{
          kind: "trace",
          nodeId: "approved",
          depth: 8,
          upstreamCheckId: "cloudtrail_logging_stopped",
          sourceAlertId: availableAlertId,
        }]));
      }
      const saved = messages.findLast(({ role }) => role === "tool");
      const binding = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      assertEquals(binding.target, allowedIncident);
      approvedReview = binding.assignment;
      assert(!prompt.includes(mixedIncident));
      if (!saved) {
        return completion("", "sentinel_incident_alerts", {
          incidentId: allowedIncident,
        });
      }
      assertEquals(JSON.parse(String(saved.content)).total, 2);
      return completion(
        '{"summary":"Reviewed both allowed incident members.","followUps":[]}',
      );
    },
  });
  providers.setDefault("scoped-incident-membership");
  const planner = createSentinelModelPlanner(
    path,
    (state, assignment, token) =>
      createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: assignment
          ? undefined
          : state.plan.runId,
        assignedTaskId: assignment,
        assignedTaskLeaseToken: token,
        providerRegistry: providers,
        hookRunner: allowHooks,
        allowModelAccess: true,
      }),
    undefined,
    () => clock,
  );
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: names.map((id) => ({ id, kind: "asset", label: id })),
        edges: [{ from: names[0], to: names[1], relation: "depends_on" }],
      }),
      { mode: 0o600 },
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        availableAlert,
        alert("approved", "network_security_alert", "Allowed cohort", "00"),
        alert("approved", "integrity_change", "Mixed cohort", "10"),
        alert("excluded", "network_security_alert", "Mixed cohort", "10"),
        {
          ...alert("excluded", "integrity_change", "Excluded same check", "20"),
          triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
        },
        {
          ...alert("excluded", "integrity_change", "Excluded only check", "30"),
          triggeringAction: "cloudtrail.amazonaws.com:DeleteTrail",
        },
        {
          ...alert("unmapped", "integrity_change", "Unmapped source", "40"),
          triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
        },
      ]),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const candidates = state.result?.sharedGraph.observations.find(({ task }) =>
      task === "incident_correlation"
    )?.facts.candidates;
    assert(Array.isArray(candidates));
    allowedIncident = candidates.find((value) => !value.relatedAssetIds)?.id;
    mixedIncident = candidates.find((value) =>
      value.relatedAssetIds?.length === 2
    )?.id;
    assert(allowedIncident && mixedIncident);
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      runId,
    };
    const narrow = (expectedVersion: number, allowedAssetIds: string[]) => ({
      ...ref,
      action: "narrow_constraints",
      requestId: crypto.randomUUID(),
      expectedVersion,
      deniedKinds: [],
      allowedAssetIds,
    });
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(narrow(0, ["approved", "spare"])))
          .record.constraints.allowedAssetIds,
        ["approved", "spare"],
      );
      advanceAdaptiveSentinel(path, readSentinelAssessment(path)!);
      assertStringIncludes(
        await read({
          ...ref,
          action: "assign",
          requestId: crypto.randomUUID(),
          adaptiveRevision: readAdaptiveSentinel(path, state)?.revision,
          taskKind: "review_incident",
          node: mixedIncident,
        }),
        "unavailable",
      );
    });
    const incidentRead = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      action: "incident_alerts",
    };
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        const mixed = await read({
          ...incidentRead,
          incidentId: mixedIncident,
        });
        assertStringIncludes(mixed, "unavailable");
        assert(!mixed.includes("Mixed cohort"));
        assertEquals(
          JSON.parse(
            await read({
              ...incidentRead,
              incidentId: allowedIncident,
            }),
          ).evidence.total,
          2,
        );
      },
      undefined,
      undefined,
      undefined,
      true,
    );
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(
          await read({
            ...incidentRead,
            incidentId: mixedIncident,
          }),
        ).evidence.total,
        2,
      );
    });
    const deadline = Date.now() + 4000;
    while (
      !approvedReview || !readAdaptiveSentinel(path, state)
        ?.modelReviews.some(({ taskId }) => taskId === approvedReview)
    ) {
      assert(Date.now() < deadline);
      planner.advance(readSentinelAssessment(path)!);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(
      readAdaptiveSentinel(path, state)?.modelReviews.some((
        { taskId, summary },
      ) =>
        taskId === approvedReview &&
        summary === "Reviewed both allowed incident members."
      ),
    );
    planner.advance(readSentinelAssessment(path)!);
    const observationTimeout = setTimeout(
      () =>
        observationRead.reject(
          new Error("Scoped incident observation did not reopen"),
        ),
      4000,
    );
    const observed = await observationRead.promise.finally(() =>
      clearTimeout(observationTimeout)
    );
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const observationRound = readAdaptiveSentinel(path, state)
      ?.modelPlannerHistory.find(
        ({ reads }) =>
          reads?.some(({ tool }) => tool === "sentinel_worker_observation"),
      );
    assert(observationRound);
    const observation = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
      action: "planner_reads",
      plannerIdentity: observationRound.identity,
      attempt: observationRound.attempt,
      ordinal: observationRound.reads!.findIndex(({ tool }) =>
        tool === "sentinel_worker_observation"
      ) + 1,
      includeResult: true,
    };
    const allowedReceipt = {
      ...observation,
      ordinal: observationRound.reads!.findIndex(({ tool, target }) =>
        tool === "sentinel_incident_alerts" && target === allowedIncident
      ) + 1,
    };
    assert(allowedReceipt.ordinal > 0);
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(JSON.parse(await read(allowedReceipt)).result.total, 2);
      assertEquals(
        JSON.parse(await read(observation)).result,
        JSON.parse(observed),
      );
    });
    reading = false;
    addSentinelCaseHint(path, "Review currently eligible incident evidence.");
    clock += 61_000;
    planner.advance(readSentinelAssessment(path)!);
    const timeout = setTimeout(
      () =>
        plannerInput.reject(new Error("Scoped planner did not run")),
      4000,
    );
    const prompt = await plannerInput.promise.finally(() =>
      clearTimeout(timeout)
    );
    assertStringIncludes(prompt, allowedIncident);
    assert(!prompt.includes(mixedIncident));
    assert(!prompt.includes("Mixed cohort"));
    const visible = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assertEquals(visible.upstreamChecks, [
      { id: "cloudtrail_logging_stopped", count: 1 },
    ]);
    assert(!prompt.includes("cloudtrail_audit_configuration_changed"));
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(narrow(1, ["spare"])))
          .record.constraints.allowedAssetIds,
        ["spare"],
      );
      assertStringIncludes(await read(observation), "unavailable");
      assertStringIncludes(await read(allowedReceipt), "unavailable");
    });
    held.resolve();
    const settlement = Date.now() + 3000;
    while (planner.hasInFlightWork() && Date.now() < settlement) {
      await new Promise((resolve) =>
        setTimeout(resolve, 5)
      );
    }
    assert(!planner.hasInFlightWork());
    assert(
      !readAdaptiveSentinel(path, state)?.tasks.some((
        { plannerRound, evidenceIds },
      ) =>
        plannerRound?.upstreamCheckId === "cloudtrail_logging_stopped" &&
        evidenceIds.includes(availableAlertId)
      ),
    );
  } finally {
    held.resolve();
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Leased execution evidence review sees telemetry only for its uniquely proven asset", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "execution-evidence-telemetry";
  const path = resolveSentinelCasePath(directory, caseId);
  const unique = "evidence-app";
  const ambiguous = "evidence-ambiguous";
  const now = Date.now();
  const observedAt = new Date(now - 1000).toISOString();
  const validUntil = new Date(now + 3_600_000).toISOString();
  const check = "cloudtrail_logging_stopped";
  const exactResults = new Map<string, string>();
  const providers = createProviderRegistry();
  providers.register({
    name: "execution-evidence-telemetry",
    supportsStreaming: false,
    complete(messages) {
      const prompt = String(
        messages.find(({ role }) => role === "user")?.content,
      );
      if (prompt.startsWith("Plan a defensive investigation")) {
        return Promise.resolve(completion("[]"));
      }
      const { target } = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      const saved = messages.findLast(({ role }) => role === "tool");
      if (!saved) {
        return Promise.resolve(
          completion("", "sentinel_defense", { upstreamCheck: check }),
        );
      }
      assert(target === unique || target === ambiguous);
      const text = String(saved.content);
      const page = JSON.parse(text);
      assertEquals(page.matchCount, target === unique ? 1 : 0);
      assertEquals(
        page.matches.map(({ asset }: { asset: string }) => asset),
        target === unique ? ["app"] : [],
      );
      exactResults.set(target, text);
      return Promise.resolve(
        completion(
          '{"summary":"Reviewed the scoped defensive source.","followUps":[]}',
        ),
      );
    },
  });
  providers.setDefault("execution-evidence-telemetry");
  const planner = createSentinelModelPlanner(
    path,
    (state, task, token) =>
      createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: task ? undefined : state.plan.runId,
        assignedTaskId: task,
        assignedTaskLeaseToken: token,
        providerRegistry: providers,
        hookRunner: allowHooks,
        allowModelAccess: true,
      }),
  );
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          ...["app", "peer"].map((id) => ({ id, kind: "asset", label: id })),
          ...[unique, ambiguous].map((id) => ({
            id,
            kind: "evidence",
            label: id,
            executionSource: {
              role: "delegated",
              runId: "approved-execution",
              ordinal: 1,
              receiptId: `execution-trace:${"b".repeat(64)}`,
              resultSha256: "c".repeat(64),
            },
            controlVerification: { outcome: "fail", observedAt, validUntil },
          })),
        ],
        edges: [
          { from: unique, to: "app", relation: "observed_on" },
          { from: ambiguous, to: "app", relation: "observed_on" },
          { from: ambiguous, to: "peer", relation: "observed_on" },
        ],
      }),
      { mode: 0o600 },
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify(
        ["app", "peer"].map((asset) => ({
          asset,
          observedAt,
          type: "integrity_change",
          severity: "high",
          triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
          subject: `Detection on ${asset}`,
          evidenceIds: [`${asset}-source`],
        })),
      ),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(
        revision,
        [unique, ambiguous].map((nodeId) => ({
          kind: "review_evidence",
          nodeId,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        store.activeRevision(),
      );
    } finally {
      store.close();
    }
    const deadline = Date.now() + 4000;
    let sourceTask: string | undefined;
    while (Date.now() < deadline) {
      advanceAdaptiveSentinel(path, state);
      planner.advance(state);
      const saved = readAdaptiveSentinel(path, state);
      sourceTask = saved?.tasks.find(({ nodeId }) => nodeId === unique)?.id;
      if (
        exactResults.size === 2 &&
        saved?.modelReviews.some(({ taskId }) => taskId === sourceTask)
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(sourceTask && exactResults.size === 2);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const reopen = {
      ...ref,
      action: "worker_trace_result",
      taskId: sourceTask,
      stepIndices: [0],
    };
    await withArchivedPlannerRead(
      directory,
      async (read) =>
        assertEquals(
          JSON.parse(await read(reopen)).result,
          JSON.parse(exactResults.get(unique)!),
        ),
    );
    planner.stop();
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(reopen)).result,
        JSON.parse(exactResults.get(unique)!),
      );
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: state.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "execution-telemetry-fixture",
        constraints: { deniedKinds: [], allowedAssetIds: ["peer"] },
      }));
      assertStringIncludes(await read(reopen), "unavailable");
    });
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Scoped planner provenance hides forbidden graph records and retained paths", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "scoped-base-provenance";
  const path = resolveSentinelCasePath(directory, caseId);
  const graphNodes = [
    {
      id: "approved",
      kind: "asset",
      label: "Approved asset",
      assetType: "subdomain",
      parentId: "restricted",
    },
    { id: "alternate", kind: "asset", label: "Allowed alternate asset" },
    {
      id: "restricted",
      kind: "asset",
      label: "Out-of-scope bridge",
      assetType: "root_domain",
    },
    {
      id: "allowed-finding",
      kind: "finding",
      label: "Allowed finding",
      severity: "medium",
    },
    {
      id: "restricted-finding",
      kind: "finding",
      label: "Out-of-scope finding",
      severity: "high",
    },
  ];
  const checks = [
    {
      tool: "sentinel_provenance_search",
      args: { origin: "imported", query: "Allowed alternate", limit: 2 },
    },
    {
      tool: "sentinel_provenance_search",
      args: { origin: "imported", limit: 5 },
    },
    { tool: "sentinel_provenance_node", args: { node: "asset:approved" } },
    {
      tool: "sentinel_path",
      args: {
        graph: "provenance",
        from: "asset:approved",
        to: "asset:alternate",
        relation: "depends_on",
      },
    },
    { tool: "sentinel_graph_overview", args: {} },
    { tool: "sentinel_trace", args: { node: "approved" } },
    { tool: "sentinel_trace", args: { node: "alternate", depth: 0 } },
    { tool: "sentinel_impact", args: { node: "alternate" } },
    { tool: "sentinel_report", args: { limit: 1 } },
    { tool: "sentinel_coverage", args: { limit: 1 } },
    {
      tool: "sentinel_path",
      args: { graph: "inventory", from: "approved", to: "alternate" },
    },
  ];
  let phase = 0;
  let clock = Date.now();
  const responses: string[][] = [[], []];
  const providers = createProviderRegistry();
  providers.register({
    name: "scoped-base-provenance",
    supportsStreaming: false,
    complete(messages) {
      const reads = messages.filter(({ role }) => role === "tool");
      if (!reads.length) {
        return Promise.resolve({
          ...completion(""),
          toolCalls: checks.map(({ tool, args }, index) => ({
            id: `scoped-provenance-${index}`,
            type: "function" as const,
            function: { name: tool, arguments: JSON.stringify(args) },
          })),
        });
      }
      responses[phase] = reads.slice(0, checks.length).map(({ content }) =>
        String(content)
      );
      return Promise.resolve(completion("[]"));
    },
  });
  providers.setDefault("scoped-base-provenance");
  const planner = createSentinelModelPlanner(
    path,
    (state, task) =>
      task
        ? { execute: () => Promise.resolve(), clear() {} }
        : createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry: providers,
          hookRunner: allowHooks,
          allowModelAccess: true,
        }),
    undefined,
    () => clock,
  );
  const settle = async () => {
    const deadline = Date.now() + 4000;
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!planner.hasInFlightWork());
    assertEquals(responses[phase].length, checks.length);
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: graphNodes,
        edges: [
          { from: "approved", to: "restricted", relation: "depends_on" },
          { from: "restricted", to: "alternate", relation: "depends_on" },
          { from: "allowed-finding", to: "approved", relation: "affects" },
          { from: "restricted-finding", to: "restricted", relation: "affects" },
        ],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    planner.advance(state);
    await settle();
    assertEquals(JSON.parse(responses[0][1]).totalNodes, 5);
    assertStringIncludes(responses[0][2], "asset:restricted");
    assertStringIncludes(responses[0][3], "Out-of-scope bridge");
    assertEquals(JSON.parse(responses[0][4]).nodesByKind.asset, 3);
    assertStringIncludes(responses[0][5], '"parentId":"restricted"');
    assertStringIncludes(responses[0][7], "Out-of-scope bridge");
    assertEquals(JSON.parse(responses[0][8]).totalFindings, 2);
    assertEquals(JSON.parse(responses[0][9]).summary.totalFindings, 2);
    assertStringIncludes(responses[0][10], "Out-of-scope bridge");
    const saved = readAdaptiveSentinel(path, state)?.modelPlannerHistory.find(
      ({ reads }) =>
        reads?.some(({ tool }) => tool === "sentinel_provenance_search"),
    );
    assert(saved);
    const retained = {
      ...ref,
      action: "planner_reads",
      plannerIdentity: saved.identity,
      attempt: saved.attempt,
      ordinal: 1,
      includeResult: true,
    };
    let allowedRead = "";
    let allowedInventoryRead = "";
    await withArchivedPlannerRead(directory, async (read) => {
      allowedRead = await read(retained);
      allowedInventoryRead = await read({ ...retained, ordinal: 7 });
      assertEquals(
        JSON.parse(allowedInventoryRead).result,
        JSON.parse(responses[0][6]),
      );
      assertEquals(
        JSON.parse(await read({ ...retained, ordinal: 11 })).result,
        JSON.parse(responses[0][10]),
      );
      assertEquals(JSON.parse(allowedRead).result, JSON.parse(responses[0][0]));
      assertEquals(
        JSON.parse(await read({ ...retained, ordinal: 4 })).result,
        JSON.parse(responses[0][3]),
      );
      const narrowed = JSON.parse(
        await read({
          ...ref,
          action: "narrow_constraints",
          runId,
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          deniedKinds: [],
          allowedAssetIds: ["approved", "alternate"],
        }),
      );
      assertEquals(narrowed.record.constraints.allowedAssetIds, [
        "alternate",
        "approved",
      ]);
    });
    phase = 1;
    clock += 61_000;
    planner.advance(readSentinelAssessment(path)!);
    await settle();
    assertEquals(responses[1][0], responses[0][0]);
    assertEquals(JSON.parse(responses[1][1]).totalNodes, 3);
    assertStringIncludes(responses[1][2], "finding:allowed-finding");
    assertEquals(JSON.parse(responses[1][3]).path, null);
    assertEquals(JSON.parse(responses[1][4]).nodesByKind.asset, 2);
    assertEquals(
      JSON.parse(responses[1][5]).nodes.map(({ id }: { id: string }) => id),
      [
        "approved",
        "allowed-finding",
      ],
    );
    assertEquals(responses[1][6], responses[0][6]);
    assertEquals(JSON.parse(responses[1][7]).assets.length, 1);
    assertEquals(JSON.parse(responses[1][8]).totalFindings, 1);
    assertEquals(JSON.parse(responses[1][8]).nextOffset, null);
    assertEquals(JSON.parse(responses[1][9]).summary.totalFindings, 1);
    assertEquals(JSON.parse(responses[1][10]).path, null);
    assert(
      responses[1].every((text) =>
        !text.includes("asset:restricted") &&
        !text.includes("Out-of-scope") &&
        !text.includes('"parentId":"restricted"')
      ),
    );
    for (const restored of [false, true]) {
      if (restored) {
        await archiveAndRestoreDigestFixture(directory, path, ref, runId);
      }
      await withArchivedPlannerRead(directory, async (read) => {
        assertEquals(await read(retained), allowedRead);
        assertEquals(
          await read({ ...retained, ordinal: 7 }),
          allowedInventoryRead,
        );
        for (const ordinal of [2, 3, 4, 5, 6, 8, 9, 10, 11]) {
          assertStringIncludes(
            await read({ ...retained, ordinal }),
            "unavailable",
          );
        }
        const forensic = JSON.parse(
          await read({ ...ref, action: "node", node: "asset:restricted" }),
        );
        assertEquals(forensic.page.node.label, "Out-of-scope bridge");
      });
    }
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Planner and leased worker reauthorize paginated shared topology through the archive", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "scoped-shared-topology";
  const sourceCase = "topology-source";
  const path = resolveSentinelCasePath(directory, caseId);
  const sourcePath = resolveSentinelCasePath(directory, sourceCase);
  const asset = "case-anchor";
  const excluded = "restricted-endpoint";
  const query = { asset, sourceCase, limit: 1 };
  const tool = "sentinel_shared_asset_links";
  const sourceTool = "sentinel_shared_topology_source";
  const allowedEndpoint = "allowed-remote-b";
  const sourceRequests = [excluded, allowedEndpoint].map((to) => ({
    evidenceId: sharedSentinelTopologyEvidenceId(asset, "depends_on", to),
    sourceCase,
  }));
  let now = Date.now();
  const leasedReads = new Map<string, string[]>();
  const plannerReads: string[][] = [];
  const providers = createProviderRegistry();
  providers.register({
    name: "scoped-retained-topology",
    supportsStreaming: false,
    complete(messages) {
      const prompt = String(
        messages.find(({ role }) => role === "user")?.content,
      );
      const planner = prompt.startsWith("Plan a defensive investigation");
      const binding = planner
        ? {}
        : JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      const workerId =
        binding.target === asset && typeof binding.assignment === "string"
          ? binding.assignment
          : "";
      if (!planner && !workerId) {
        return Promise.resolve(
          completion(
            '{"summary":"Other local defensive review.","followUps":[]}',
          ),
        );
      }
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) return Promise.resolve(completion("", tool, query));
      const source = sourceRequests[results.length - 1];
      if (source) return Promise.resolve(completion("", sourceTool, source));
      const reads = results.map(({ content }) => String(content));
      if (planner) plannerReads.push(reads);
      else leasedReads.set(workerId, reads);
      return Promise.resolve(
        completion(
          planner
            ? "[]"
            : '{"summary":"Reviewed exact retained published topology.","followUps":[]}',
        ),
      );
    },
  });
  providers.setDefault("scoped-retained-topology");
  const planner = createSentinelModelPlanner(
    path,
    (state, task, token) =>
      createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: task ? undefined : state.plan.runId,
        assignedTaskId: task,
        assignedTaskLeaseToken: token,
        sharedInventoryBaseDir: directory,
        providerRegistry: providers,
        hookRunner: allowHooks,
        allowModelAccess: true,
      }),
    undefined,
    () => now,
  );
  const assets = (ids: string[]) =>
    ids.map((id) => ({ id, kind: "asset", label: id }));
  try {
    for (const file of [path, sourcePath]) {
      await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
    }
    const local = {
      version: 1,
      nodes: assets([asset, excluded, allowedEndpoint]),
      edges: [],
    };
    await Deno.writeTextFile(path, JSON.stringify(local), { mode: 0o600 });
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        nodes: assets([
          asset,
          excluded,
          "allowed-remote-a",
          allowedEndpoint,
        ]),
        edges: [excluded, "allowed-remote-a", allowedEndpoint].map((to) => ({
          from: asset,
          to,
          relation: "depends_on",
        })),
      }),
      { mode: 0o600 },
    );
    const shared = await collectSharedSentinelTopology(
      directory,
      caseId,
      path,
      undefined,
      true,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify(applySharedSentinelTopology(local, shared)),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const view = () =>
      readAdaptiveSentinel(path, readSentinelAssessment(path)!);
    const assertEventually = async (condition: () => boolean) => {
      const deadline = Date.now() + 3500;
      while (!condition() && Date.now() < deadline) {
        planner.advance(readSentinelAssessment(path)!);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(condition());
    };
    advanceAdaptiveSentinel(path, state);
    const planSelector = (index: number, which = 0) => {
      const sha256 = createHash("sha256").update(plannerReads[index][which])
        .digest("hex");
      const matches = (
        step: { tool: string; goalReceiptRead?: { sha256: string } },
      ) =>
        step.tool === (which ? sourceTool : tool) &&
        step.goalReceiptRead?.sha256 === sha256;
      const settled = view()?.modelPlannerHistory.find(({ reads }) =>
        reads?.some(matches)
      );
      assert(
        settled,
        "The exact planner topology result must have a durable receipt",
      );
      return {
        ...ref,
        action: "planner_reads",
        plannerIdentity: settled.identity,
        attempt: settled.attempt,
        ordinal: settled.reads!.findIndex(matches) + 1,
        includeResult: true,
      };
    };
    const assign = async (depth: number) => {
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      let id: string;
      try {
        const revision = view()!.revision;
        const task = store.sync(revision, [{
          kind: "trace",
          nodeId: asset,
          depth,
          reason: MODEL_ASSIGNMENT_REASON,
        }]).find((task) => task.kind === "trace" && task.depth === depth);
        assert(task);
        id = task.id;
      } finally {
        store.close();
      }
      advanceAdaptiveSentinel(path, readSentinelAssessment(path)!);
      await assertEventually(() =>
        view()?.modelReviews.some(({ taskId, steps }) =>
          taskId === id && steps.some((step) => step.tool === tool)
        ) === true
      );
      const review = view()!.modelReviews.find(({ taskId }) => taskId === id)!;
      return (which = 0) => ({
        ...ref,
        action: "worker_trace_result",
        taskId: id,
        stepIndices: [
          review.steps.findIndex((step) =>
            which
              ? step.tool === sourceTool &&
                step.target === sourceRequests[which - 1].evidenceId
              : step.tool === tool
          ),
        ],
      });
    };
    await assertEventually(() =>
      !!plannerReads[0] && !planner.hasInFlightWork() &&
      view()?.modelPlannerHistory.some(({ reads }) =>
          reads?.some((step) => step.tool === tool)
        ) === true
    );
    const originalPlanner = planSelector(0);
    const originalWorker = await assign(9);
    const initial = [
      plannerReads[0],
      leasedReads.get(originalWorker().taskId)!,
    ];
    const withdrawnPlannerSource = planSelector(0, 1);
    const withdrawnWorkerSource = originalWorker(1);
    const allowedPlannerSource = planSelector(0, 2);
    const allowedWorkerSource = originalWorker(2);
    const archivedEndpoint = {
      sourceCase,
      assetId: excluded,
      snapshotDigest: JSON.parse(initial[0][1]).archivedSource.snapshotDigest,
    };
    for (const response of initial) {
      const page = JSON.parse(response[0]);
      assertEquals(page.totalLinks, 3);
      assertEquals(page.links[0].to, "allowed-remote-a");
      assert(!response[0].includes(excluded));
      assertEquals(JSON.parse(response[1]).localRelationship.to, excluded);
      assertEquals(
        JSON.parse(response[2]).localRelationship.to,
        allowedEndpoint,
      );
    }
    await withArchivedPlannerRead(directory, async (read) => {
      assertEquals(
        JSON.parse(await read(originalPlanner)).result,
        JSON.parse(initial[0][0]),
      );
      assertEquals(
        JSON.parse(await read(originalWorker())).result,
        JSON.parse(initial[1][0]),
      );
      assertEquals(
        JSON.parse(await read(withdrawnPlannerSource)).result,
        JSON.parse(initial[0][1]),
      );
      assertEquals(
        JSON.parse(await read(withdrawnWorkerSource)).result,
        JSON.parse(initial[1][1]),
      );
      assertEquals(
        JSON.parse(
          await read({
            ...withdrawnPlannerSource,
            includeResult: undefined,
            ...archivedEndpoint,
          }),
        ).source.asset.id,
        excluded,
      );
      assertEquals(
        JSON.parse(
          await read({
            ...withdrawnWorkerSource,
            action: "worker_trace_source",
            ...archivedEndpoint,
          }),
        ).source.asset.id,
        excluded,
      );
      const scoped = JSON.parse(
        await read({
          ...ref,
          runId,
          action: "narrow_constraints",
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          deniedKinds: [],
          allowedAssetIds: [asset, allowedEndpoint],
        }),
      );
      assertEquals(
        scoped.record.constraints.allowedAssetIds,
        [asset, allowedEndpoint].sort(),
      );
    });
    now += 61_000;
    await assertEventually(() =>
      !!plannerReads[1] && !planner.hasInFlightWork() &&
      (view()?.modelPlannerHistory.filter(({ reads }) =>
          reads?.some((step) => step.tool === tool)
        ).length ?? 0) > 1
    );
    const restrictedPlanner = planSelector(1);
    const restrictedWorker = await assign(10);
    const limited = [
      plannerReads[1],
      leasedReads.get(restrictedWorker().taskId)!,
    ];
    for (const response of limited) {
      const page = JSON.parse(response[0]);
      assertEquals(page.totalLinks, 2);
      assertEquals(page.nextOffset, 1);
      assertEquals(page.links[0].to, "allowed-remote-a");
      assertMatch(page.operatingConstraintsDigest, /^[a-f0-9]{64}$/);
      assertStringIncludes(response[1], "Error:");
      assert(!response[1].includes(excluded));
      assertEquals(
        JSON.parse(response[2]).localRelationship.to,
        allowedEndpoint,
      );
    }
    for (const archived of [false, true]) {
      if (archived) {
        await archiveAndRestoreDigestFixture(directory, path, ref, runId);
      }
      await withArchivedPlannerRead(directory, async (read) => {
        assertStringIncludes(await read(originalPlanner), "unavailable");
        assertStringIncludes(await read(originalWorker()), "unavailable");
        assertStringIncludes(await read(withdrawnPlannerSource), "unavailable");
        assertStringIncludes(await read(withdrawnWorkerSource), "unavailable");
        assertStringIncludes(
          await read({
            ...withdrawnPlannerSource,
            includeResult: undefined,
            ...archivedEndpoint,
          }),
          "unavailable",
        );
        assertStringIncludes(
          await read({
            ...withdrawnWorkerSource,
            action: "worker_trace_source",
            ...archivedEndpoint,
          }),
          "unavailable",
        );
        assertEquals(
          JSON.parse(await read(allowedPlannerSource)).result,
          JSON.parse(initial[0][2]),
        );
        assertEquals(
          JSON.parse(await read(allowedWorkerSource)).result,
          JSON.parse(initial[1][2]),
        );
        assertEquals(
          JSON.parse(await read(restrictedPlanner)).result,
          JSON.parse(limited[0][0]),
        );
        assertEquals(
          JSON.parse(await read(restrictedWorker())).result,
          JSON.parse(limited[1][0]),
        );
        assertEquals(
          JSON.parse(
            await read({
              ...ref,
              action: "topology_source",
              ...sourceRequests[0],
            }),
          ).evidence.localRelationship.to,
          excluded,
        );
      });
    }
    let revokedDuringSource = false;
    await withArchivedPlannerRead(
      directory,
      async (read) => {
        assertStringIncludes(await read(allowedPlannerSource), "unavailable");
        assert(revokedDuringSource);
        assertStringIncludes(await read(allowedWorkerSource), "unavailable");
      },
      undefined,
      undefined,
      undefined,
      false,
      async (hook, input) => {
        if (
          !revokedDuringSource && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === sourceTool &&
          String(input.tool_response).includes(allowedEndpoint)
        ) {
          await Promise.resolve();
          assert(recordSentinelOperatingConstraints(path, {
            runId,
            evidenceRevision: ref.revision,
            expectedVersion: 1,
            requestId: crypto.randomUUID(),
            operatorScope: "retained-topology-policy-fixture",
            constraints: { deniedKinds: [], allowedAssetIds: [asset] },
          }));
          revokedDuringSource = true;
        }
      },
    );
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
