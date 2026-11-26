import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { buildWorkflowRecoveryExecutor } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import {
  branchExecutionEvidenceId,
  executionEvidenceDigest,
  repositoryVisibilityEvidenceId,
  sentinelExecutionEvidenceFile,
  workflowAttemptEvidenceId,
  workflowControlEvidenceId,
} from "../../src/sentinel/case_execution_evidence.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  ensureSentinelFormalGoalContract,
  readSentinelGoalCompletionAtRevision,
  reportSentinelGoalCompletion,
} from "../../src/gateway/sentinel_goal_completion.ts";
import {
  createSentinelSubagent,
  type SentinelAgentOptions,
} from "../../src/gateway/sentinel_agent.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  applySentinelFormalGoals,
  readSentinelAssessment,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { importSentinelHar } from "../../src/sentinel/har.ts";
import {
  sentinelFindingTrafficEvidenceVersion,
  type SentinelFindingTrafficLink,
} from "../../src/sentinel/finding_traffic_links.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";
import { readSentinelWorkerFindingPublications } from "../../src/sentinel/worker_finding_publications.ts";
import {
  readSentinelWorkerFindingReport,
  type SentinelWorkerFindingJournalRecord,
  type SentinelWorkerFindingRecord,
  type SentinelWorkerFindingReportAmendment,
} from "../../src/sentinel/worker_finding_store.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/mod.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_config.ts";
import { createSavedSourceAuthorization } from "../../src/agent/dispatch/saved_source_authorization.ts";
import { buildExecutionTracePayloadAuthorizer } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import {
  createScheduledObservationRead,
  scheduledObservationTool,
  selectAgentObservationRead,
} from "../../src/gateway/scheduled_observation_tool.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";

const report = "sentinel_report_finding";
const context = "sentinel_finding_recheck_context";
const findings = "sentinel_worker_findings";
const recheck = "sentinel_record_finding_recheck";
const amend = "sentinel_update_finding_report";
const assigned = "sentinel_assigned_target";
const tool = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});
type State = ReturnType<typeof startSentinelAssessment>;

function assignedLease(
  path: string,
  state: State,
  kind: "impact" | "trace" | "review_evidence",
  nodeId = "app",
) {
  const revision = adaptiveRevision(state);
  if (kind !== "review_evidence") advanceAdaptiveSentinel(path, state);
  const store = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  try {
    store.sync(revision, [{
      kind,
      nodeId,
      ...(kind === "trace" && { depth: 1 }),
      reason: MODEL_ASSIGNMENT_REASON,
    }], kind === "review_evidence" ? store.activeRevision() : revision);
    advanceAdaptiveSentinel(path, state);
    const lease = store.claimModelReview(
      revision,
      MODEL_ASSIGNMENT_REASON,
      (task) => task.kind === kind && task.nodeId === nodeId,
    );
    assert(lease);
    return {
      assessmentRevision: state.revision,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
    };
  } finally {
    store.close();
  }
}

function nativeWorkflowReader(
  allowed: () => boolean = () => true,
) {
  return createSentinelLiveWorkflowReader({
    scopes: [{
      case: "main",
      asset: "app",
      owner: "owner",
      repo: "repo",
      workflow_id: 22,
    }],
    resolveToken: () => Promise.resolve("fixture-token"),
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    verifyAccess: () => Promise.resolve(allowed()),
    readRuns: () => {
      throw new Error("Historical workflow runs must be reused");
    },
  });
}

async function workerTurn(
  path: string,
  lease: {
    assessmentRevision: number;
    assignedTaskId: string;
    assignedTaskLeaseToken: string;
  },
  batches: readonly (readonly ReturnType<typeof tool>[])[],
  deny?: "report" | "output" | "receipt-pre" | "receipt-post",
  executionSourceScope?: string,
  readRetainedWorkflow?: ReturnType<typeof nativeWorkflowReader>,
  execution?: {
    prompt: Parameters<ReturnType<typeof createSentinelSubagent>["execute"]>[0];
    options:
      Parameters<ReturnType<typeof createSentinelSubagent>["execute"]> extends
        [unknown, unknown, ...infer Rest] ? Rest : never;
    authorizeExecutionTracePayload?:
      SentinelAgentOptions["authorizeExecutionTracePayload"];
    blockedSource?: {
      name: string;
      hook: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE";
    };
  },
) {
  const receiptHooks: string[] = [];
  let reportPre = 0;
  let reportPost = 0;
  const outputChecks: string[] = [];
  const hooks: HookRunner = {
    evaluateHook(hook, { session, input, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      const writing = [report, recheck, amend].includes(name);
      if (name === findings) receiptHooks.push(hook);
      if (writing && hook === "PRE_TOOL_CALL") {
        reportPre++;
        assertEquals(session.taint, "INTERNAL");
      }
      if ((writing || name === findings) && hook === "POST_TOOL_RESPONSE") {
        if (writing) reportPost++;
        assertEquals(session.taint, "INTERNAL");
        assert(typeof input.tool_response === "string");
        assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
        if (!input.tool_response.startsWith("Error:")) {
          assertEquals(
            JSON.parse(input.tool_response)._classification,
            "INTERNAL",
          );
        }
      }
      if (hook === "PRE_OUTPUT") {
        outputChecks.push(String(input.content));
        assertEquals(input.target_classification, "INTERNAL");
      }
      const allowed =
        !(writing && hook === "PRE_TOOL_CALL" && deny === "report") &&
        !(name === findings && hook === "PRE_TOOL_CALL" &&
          deny === "receipt-pre") &&
        !(name === findings && hook === "POST_TOOL_RESPONSE" &&
          deny === "receipt-post") &&
        !(hook === "PRE_OUTPUT" && deny === "output") &&
        !(name === execution?.blockedSource?.name &&
          hook === execution.blockedSource.hook);
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        duration: 0,
        ruleId: null,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  const results: string[][] = [];
  let iteration = 0;
  providerRegistry.register({
    name: "finding-fixture",
    supportsStreaming: false,
    complete(messages) {
      if (iteration > 0) {
        const start = batches.slice(0, iteration - 1).reduce(
          (sum, batch) => sum + batch.length,
          0,
        );
        const frames = messages.filter(({ role }) => role === "tool")
          .slice(start).map(({ content }) => String(content));
        assertEquals(frames.length, batches[iteration - 1].length);
        results.push(frames);
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        content: batch
          ? ""
          : '{"summary":"Reviewed the saved control evidence.","followUps":[]}',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `finding-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("finding-fixture");
  const worker = createSentinelSubagent({
    snapshotPath: path,
    providerRegistry,
    hookRunner: hooks,
    allowModelAccess: true,
    ...lease,
    sharedInventoryBaseDir: executionSourceScope,
    readRetainedWorkflow,
    authorizeExecutionTracePayload: execution?.authorizeExecutionTracePayload ??
      (executionSourceScope
        ? (payload) => Promise.resolve([42, 43].includes(payload.repositoryId))
        : undefined),
  });
  const events: ChatEvent[] = [];
  try {
    await worker.execute(
      execution?.prompt ?? "Review the exact assigned control evidence.",
      (event) => events.push(event),
      ...execution?.options ?? [],
    );
    assertEquals(results.length, batches.length);
    return {
      results,
      receiptHooks,
      reportPre,
      reportPost,
      outputChecks,
      events,
    };
  } finally {
    worker.clear();
  }
}

async function withTidepool(
  baseDir: string,
  test: (
    list: (
      revision?: number,
      caseId?: string,
    ) => Promise<SentinelWorkerFindingJournalRecord[]>,
    provenance: (
      revision: number,
    ) => Promise<
      {
        workerFindings: NonNullable<
          ReturnType<typeof readSentinelWorkerFindingReport>
        >;
        provenance: ReturnType<
          ReturnType<
            typeof import("../../src/sentinel/provenance.ts").buildSentinelProvenance
          >["snapshot"]
        >;
        planningAttempts: readonly {
          inputManifest?: { findingRecheckIds?: readonly string[] };
        }[];
        findingTrafficLinks?: readonly SentinelFindingTrafficLink[];
      }
    >,
    request: (
      type: string,
      fields: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const key = crypto.randomUUID();
  const handler = createTidepoolSentinelHandler({
    baseDir,
    config: { sentinel: { allow_model_access: true } },
  } as BootstrapResult);
  const state: A2UIHostState = {
    clients: new Set(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: key,
    lastMcpConnected: -1,
    lastMcpConfigured: -1,
    topicHandlers: {
      sentinel: (message, socket) => void handler(message, socket),
    },
    socketCleanupCallbacks: [],
    canvasRenders: [],
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => routeHostRequest(request, state, undefined),
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.addr.port}/?key=${key}`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let sequence = 0;
    const request = async (type: string, fields: Record<string, unknown>) => {
      const requestId = ++sequence;
      const result = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(
        () => result.reject(new Error("No worker finding reply")),
        3_000,
      );
      function receive(event: MessageEvent) {
        const message = JSON.parse(event.data);
        if (message.requestId === requestId && message.topic === "sentinel") {
          result.resolve(message);
        }
      }
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          topic: "sentinel",
          type,
          ...fields,
          requestId,
        }),
      );
      try {
        return await result.promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    await test(async (revision, caseId = "main") => {
      const response = await request("worker_findings", { revision, caseId });
      assertEquals(response.type, "sentinel_worker_findings");
      assertEquals(response.caseId, caseId);
      assertEquals(response.evidenceRevision, revision ?? null);
      assert(Array.isArray(response.records));
      return response.records;
    }, async (revision) => {
      const response = await request("export", {
        format: "provenance",
        revision,
      });
      assertEquals(response.type, "export");
      assertEquals(response.caseId, "main");
      assertEquals(response.revision, revision);
      assert(typeof response.content === "string");
      const result = JSON.parse(response.content);
      assert(result.workerFindings);
      assert(Array.isArray(result.planningAttempts));
      return {
        workerFindings: result.workerFindings,
        provenance: result.provenance,
        planningAttempts: result.planningAttempts,
        findingTrafficLinks: result.findingTrafficLinks,
      };
    }, request);
  } finally {
    socket.close();
    await server.shutdown();
  }
}

async function waitForCondition(
  condition: () => boolean,
  advance: () => void,
): Promise<void> {
  const end = Date.now() + 2_000;
  while (!condition() && Date.now() < end) {
    advance();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(condition(), "Sentinel planning round did not settle");
}

async function withFindingAssignmentGateway(
  baseDir: string,
  confirm: () => Promise<boolean>,
  test: (
    turn: (args: Record<string, unknown>) => Promise<string>,
  ) => Promise<void>,
  outputPolicy?: (hook: string, input: Record<string, unknown>) => boolean,
  onFrame?: (frame: string) => void,
) {
  const registry = createProviderRegistry();
  let input: Record<string, unknown> = {};
  let output = "";
  registry.register({
    name: "finding-assignment-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      output = last?.role === "tool" ? String(last.content) : "";
      return Promise.resolve({
        content: output ? "Reviewed Sentinel assignment." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: output ? [] : [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name: "operator_runs", arguments: JSON.stringify(input) },
        }],
      });
    },
  });
  registry.setDefault("finding-assignment-owner");
  const token = crypto.randomUUID();
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "internal-fixture" as ChannelId,
    }),
    providerRegistry: registry,
    enableStreaming: false,
    operatorRunExecutor: createOperatorRunToolExecutor({ baseDir, confirm }),
    hookRunner: {
      evaluateHook(hook, { input }) {
        const allowed = outputPolicy?.(hook, input) ?? true;
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    },
  });
  const gateway = createGatewayServer({ token, port: 0, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await test(async (args) => {
      input = args;
      output = "";
      const completed = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => completed.reject(new Error("No assignment result")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        onFrame?.(String(data));
        const frame = JSON.parse(data);
        if (frame.type === "response") completed.resolve();
        if (frame.type === "error") completed.reject(new Error(frame.message));
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Review the exact remediation requirement.",
          }),
        );
        await completed.promise;
        return output;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    });
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

Deno.test("Leased Sentinel workers report, recheck, and amend findings visible in authenticated Tidepool", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let modelPlanner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  const now = Date.now();
  function snapshot(remediated: boolean) {
    const verify = (id: string, outcome: "fail" | "pass", ago: number) => ({
      id,
      kind: "evidence",
      label: id,
      controlVerification: {
        outcome,
        observedAt: new Date(now - ago).toISOString(),
        validUntil: new Date(now + 3_600_000).toISOString(),
      },
    });
    const nodeIds = ["failed-check", ...(remediated ? ["passing-check"] : [])];
    return {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Assigned application" },
        { id: "dependent-asset", kind: "asset", label: "Dependent asset" },
        { id: "waiting-dependent", kind: "asset", label: "Waiting dependent" },
        {
          id: "review-gap",
          kind: "finding",
          label: "Control gap",
          severity: "high",
        },
        { id: "check-control", kind: "control", label: "Control under review" },
        verify("failed-check", "fail", 120_000),
        ...(remediated ? [verify("passing-check", "pass", 60_000)] : []),
      ],
      edges: [
        { from: "review-gap", to: "app", relation: "affects" },
        { from: "check-control", to: "review-gap", relation: "mitigates" },
        ...nodeIds.flatMap((id) => [
          { from: id, to: "check-control", relation: "verifies" },
          { from: id, to: "app", relation: "observed_on" },
        ]),
      ],
    };
  }
  try {
    const otherPath = resolveSentinelCasePath(baseDir, "other");
    await Deno.mkdir(dirname(otherPath), { recursive: true });
    const otherSnapshot = snapshot(false);
    otherSnapshot.nodes.push(...Array.from({ length: 16 }, (_, index) => ({
      id: `other-finding-${index}`,
      kind: "finding",
      label: "Separate case finding",
      severity: "low",
    })));
    await Deno.writeTextFile(otherPath, JSON.stringify(otherSnapshot));
    const other = startSentinelAssessment(otherPath, {
      goal: "Review other case",
    });
    await Deno.writeTextFile(path, JSON.stringify(snapshot(false)));
    const first = startSentinelAssessment(path, { goal: "Verify remediation" });
    const source = assignedLease(path, first, "impact");
    const submission = {
      graphFindingId: "review-gap",
      controlId: "check-control",
      evidenceId: "failed-check",
      requestId: crypto.randomUUID(),
      title: "Recorded control gap",
      summary: "Retained check observed the control failing.",
    };
    let finding: SentinelWorkerFindingJournalRecord | undefined;
    let check: SentinelWorkerFindingJournalRecord | undefined;
    let secondRevision: number | undefined;
    let satisfiedGateId: string | undefined;
    let waitingGateId: string | undefined;
    let amendment: SentinelWorkerFindingReportAmendment | undefined;

    await withTidepool(baseDir, async (list, provenance) => {
      const denied = await workerTurn(path, source, [[tool(assigned)], [
        tool(report, submission),
      ]], "report");
      assertEquals(denied.reportPre, 1);
      assertEquals(denied.reportPost, 0);
      assertEquals(await list(), []);
      await assertRejects(
        () => Deno.lstat(join(dirname(path), "sentinel-worker-findings.db")),
        Deno.errors.NotFound,
      );

      const firstReport = await workerTurn(path, source, [
        [tool(report, submission)],
        [tool(assigned)],
        [
          tool(report, { ...submission, evidenceId: "wrong-record" }),
          tool(report, submission),
          tool(report, submission),
          tool(report, { ...submission, summary: "Changed replay input." }),
        ],
      ]);
      assertStringIncludes(
        firstReport.results[0][0],
        "Read the exact linked evidence",
      );
      assertStringIncludes(firstReport.results[1][0], "failed-check");
      const [wrong, accepted, duplicate, conflict] = firstReport.results[2];
      assertStringIncludes(wrong, "Read the exact linked evidence");
      assertStringIncludes(conflict, "unavailable");
      const original = JSON.parse(accepted).record;
      assertEquals(JSON.parse(duplicate).record, original);
      assertEquals(original.kind, "finding");
      assertEquals(original.evidenceRevision, first.revision);
      assertEquals(original.taskId, source.assignedTaskId);
      assertEquals(original.evidenceId, "failed-check");
      assertEquals(firstReport.reportPre, 5);
      assertEquals(firstReport.reportPost, 5);
      assertEquals(await list(first.revision), [original]);
      assertEquals(await list(undefined, "other"), []);
      finding = original;
      assert(finding);

      const ownerAssignment = {
        action: "assign",
        kind: "sentinel",
        id: "main",
        revision: first.revision,
        runId: first.plan.runId,
        adaptiveRevision: adaptiveRevision(first),
        requestId: crypto.randomUUID(),
        taskKind: "trace",
        node: "app",
        passingRecheckForFindingId: original.id,
      };
      let confirmationCount = 0;
      let allowGate = false;
      let preDenied = true;
      let approvedGateId: string | undefined;
      await withFindingAssignmentGateway(baseDir, () => {
        confirmationCount++;
        return Promise.resolve(allowGate);
      }, async (turn) => {
        assertStringIncludes(await turn(ownerAssignment), "blocked");
        assertEquals(confirmationCount, 0);
        preDenied = false;
        assertStringIncludes(
          await turn({ ...ownerAssignment, node: "dependent-asset" }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({
            ...ownerAssignment,
            passingRecheckForFindingId: `worker-finding:${"a".repeat(64)}`,
          }),
          "unavailable",
        );
        assertEquals(confirmationCount, 0);
        assertStringIncludes(await turn(ownerAssignment), "declined");
        assert(
          !readAdaptiveSentinel(path, first)?.tasks.some(({ plannerRound }) =>
            plannerRound?.passingRecheckForFindingId === original.id
          ),
        );
        allowGate = true;
        const receipt = JSON.parse(await turn(ownerAssignment)).receipt;
        assertEquals(receipt.passingRecheckForFindingId, original.id);
        assertEquals(receipt.depth, 1);
        approvedGateId = receipt.taskId;
      }, (hook) => hook !== "PRE_TOOL_CALL" || !preDenied);
      assertEquals(confirmationCount, 2);
      const replayFrames: string[] = [];
      let denyReplay: "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
      await withFindingAssignmentGateway(
        baseDir,
        () => {
          throw new Error("A duplicate gate may not request new approval");
        },
        async (turn) => {
          assertEquals(
            JSON.parse(await turn(ownerAssignment)).receipt.taskId,
            approvedGateId,
          );
          const { passingRecheckForFindingId: _gate, ...conflicting } =
            ownerAssignment;
          assertStringIncludes(await turn(conflicting), "unavailable");
          denyReplay = "POST_TOOL_RESPONSE";
          assertEquals(
            await turn(ownerAssignment),
            "Tool response withheld by policy.",
          );
          denyReplay = "PRE_OUTPUT";
          replayFrames.length = 0;
          assertEquals(
            JSON.parse(await turn(ownerAssignment)).receipt.taskId,
            approvedGateId,
          );
          assert(!replayFrames.some((frame) => frame.includes(original.id)));
          assert(
            replayFrames.some((frame) =>
              frame.includes("Tool result withheld by the output policy.")
            ),
          );
        },
        (hook, input) =>
          hook !== denyReplay ||
          (hook === "PRE_OUTPUT" &&
            !String(input.content).includes(original.id)),
        (frame) => replayFrames.push(frame),
      );

      const waitingAssignments = (
        candidate: { id: string; targetId: string },
      ) => [
        {
          kind: "trace",
          nodeId: candidate.targetId,
          depth: 1,
          passingRecheckForFindingId: candidate.id,
        },
        { kind: "impact", nodeId: "waiting-dependent", dependsOn: [0] },
      ];
      const firstPlanner = createSentinelModelPlanner(
        path,
        (_state, assignment) => ({
          execute(prompt, send) {
            if (!assignment) {
              const inputs = JSON.parse(String(prompt).split("\n").at(-1)!);
              const candidate = inputs.pendingRecheckFindings?.find(
                ({ id }: { id: string }) => id === original.id,
              );
              if (candidate) {
                send({
                  type: "response",
                  taint: "INTERNAL",
                  text: JSON.stringify(waitingAssignments(candidate)),
                });
              }
            }
            return Promise.resolve();
          },
          clear() {},
        }),
      );
      modelPlanner = firstPlanner;
      const firstQueue = () => readAdaptiveSentinel(path, first)?.tasks ?? [];
      await waitForCondition(
        () => firstQueue().some(({ nodeId }) => nodeId === "waiting-dependent"),
        () => firstPlanner.advance(first),
      );
      assertEquals(
        firstQueue().find(({ nodeId }) => nodeId === "waiting-dependent")
          ?.status,
        "queued",
      );
      const firstGate = firstQueue().find(({ plannerRound }) =>
        plannerRound?.passingRecheckForFindingId === original.id
      );
      assert(firstGate);
      assertEquals(firstGate.id, approvedGateId);
      assertEquals(firstGate.status, "queued");
      assertEquals(firstGate.attempts, 0);
      firstPlanner.stop();

      await Deno.writeTextFile(path, JSON.stringify(snapshot(true)));
      const goals: SentinelFormalGoal[] = [{
        id: "controls",
        title: "Verify remediation",
        policy: "operator",
        criteria: [{
          id: "remediated",
          description:
            "The original control failure has a verified passing recheck",
          source: "finding_recheck",
          reference: `pass:${original.id}`,
        }],
      }];
      const { state: second } = applySentinelFormalGoals(path, {
        mode: "append",
        requestId: crypto.randomUUID(),
        expectedRevision: first.revision,
        expectedRunId: first.plan.runId,
        proposalDigest: digestSentinelGoalProposal(goals),
        goals,
      });
      assert(second && second.revision > first.revision);
      await withFindingAssignmentGateway(baseDir, () => {
        throw new Error("A stale assignment may not request approval");
      }, async (turn) => {
        assertStringIncludes(await turn(ownerAssignment), "unavailable");
      });
      secondRevision = second.revision;
      const stale = await workerTurn(path, source, [[tool(assigned)], [
        tool(report, submission),
      ]]);
      assertStringIncludes(
        stale.results[1][0],
        "Read the exact linked evidence",
      );
      assertEquals(await list(), [original]);

      const worker = assignedLease(path, second, "trace");
      const update = {
        findingId: finding.id,
        requestId: crypto.randomUUID(),
        summary: "Newer retained evidence verifies the control.",
      };
      const goal = ensureSentinelFormalGoalContract(path, second);
      assert(goal);
      const scope = goal.scope;
      const rounds: unknown[] = [];
      let plannerClock = Date.now();
      const planner = createSentinelModelPlanner(
        path,
        (_state, assignment) => ({
          execute(prompt, send) {
            if (assignment) return Promise.resolve();
            const inputs = JSON.parse(String(prompt).split("\n").at(-1)!);
            rounds.push(inputs.findingRechecks ?? []);
            const receipt = inputs.findingRechecks?.[0];
            const finding = inputs.pendingRecheckFindings?.find(
              ({ id, targetId }: { id: string; targetId: string }) =>
                id === original.id && targetId === original.targetId,
            );
            send({
              type: "response",
              taint: "INTERNAL",
              text: JSON.stringify({
                assignments: receipt
                  ? [
                    {
                      kind: "trace",
                      nodeId: receipt.targetId,
                      depth: 1,
                      passingRecheckId: receipt.id,
                    },
                    {
                      kind: "impact",
                      nodeId: "dependent-asset",
                      dependsOn: [0],
                    },
                    {
                      kind: "trace",
                      nodeId: "dependent-asset",
                      depth: 1,
                      passingRecheckId: receipt.id,
                    },
                  ]
                  : finding
                  ? waitingAssignments(finding)
                  : [],
                prioritize: [],
                ...(receipt && {
                  goalObservations: [{
                    criterionId: inputs.goalCompletion.criteria[0].id,
                    evidence: [{
                      source: "finding_recheck",
                      reference: receipt.id,
                      detail: "Verified recheck",
                    }],
                  }],
                }),
              }),
            });
            return Promise.resolve();
          },
          clear() {},
        }),
        undefined,
        () => plannerClock,
      );
      modelPlanner = planner;
      const waitFor = (condition: () => boolean) =>
        waitForCondition(condition, () => planner.advance(second));
      const queue = () => readAdaptiveSentinel(path, second)?.tasks ?? [];
      const waitingGate = () =>
        queue().find(({ plannerRound }) =>
          plannerRound?.passingRecheckForFindingId === original.id
        );
      const waitingDependent = () =>
        queue().find(({ nodeId, kind }) =>
          nodeId === "waiting-dependent" && kind === "impact"
        );
      const pendingGate = waitingGate();
      assert(pendingGate);
      assert(pendingGate.id !== firstGate.id);
      assertEquals(waitingDependent()?.prerequisites, [pendingGate.id]);
      assertEquals(waitingDependent()?.status, "queued");
      planner.advance(second);
      await waitFor(() => !planner.hasInFlightWork());
      assertEquals(rounds, [[]]);
      waitingGateId = pendingGate.id;
      assertEquals(pendingGate.status, "queued");
      assertEquals(pendingGate.attempts, 0);
      assertEquals(waitingDependent()?.status, "queued");
      let coordinatorAdvances = 0;
      coordinator = startSentinelAssessmentCoordinator({
        snapshotPath: path,
        advanceAdaptive(current) {
          coordinatorAdvances++;
          advanceAdaptiveSentinel(path, current);
          planner.advance(current);
        },
      });
      await waitForCondition(() => coordinatorAdvances === 1, () => {});
      const rejected = await workerTurn(path, worker, [[
        tool(context, { findingId: original.id }),
        tool(assigned),
      ], [
        tool(recheck, { ...update, evidenceId: "failed-check" }),
      ]]);
      assertStringIncludes(rejected.results[1][0], "unavailable");
      assertEquals(coordinatorAdvances, 1);
      assertEquals(waitingGate()?.status, "queued");
      assertEquals(waitingDependent()?.status, "queued");

      const decision = await workerTurn(path, worker, [
        [tool(context, { findingId: finding.id }), tool(assigned)],
        [
          tool(recheck, { ...update, evidenceId: "passing-check" }),
          tool(recheck, { ...update, evidenceId: "passing-check" }),
        ],
      ], "output");
      await waitForCondition(
        () => waitingDependent()?.status === "completed",
        () => {},
      );
      assertEquals(coordinatorAdvances, 2);
      coordinator.stop();
      const proof = JSON.parse(decision.results[0][0]);
      assertEquals(proof.finding, original);
      assertEquals(proof.originalOutcome, "fail");
      assertEquals(proof.current.evidenceId, "passing-check");
      assertEquals(proof.current.outcome, "pass");
      assertStringIncludes(decision.results[0][1], "passing-check");
      assertStringIncludes(decision.results[0][1], "failed-check");
      const verified = JSON.parse(decision.results[1][0]).record;
      assertEquals(JSON.parse(decision.results[1][1]).record, verified);
      assertEquals(verified.kind, "recheck");
      assertEquals(verified.findingId, finding.id);
      assertEquals(verified.outcome, "pass");
      assertEquals(verified.evidenceRevision, second.revision);
      assertEquals(verified.taskId, worker.assignedTaskId);
      assertEquals(decision.reportPost, 2);
      assertEquals(
        decision.outputChecks.filter((content) =>
          content.includes("Reviewed the saved control evidence.")
        ).length,
        1,
      );
      assert(
        decision.outputChecks.some((content) => content.includes(verified.id)),
      );
      assert(!JSON.stringify(decision.events).includes(verified.id));
      assert(!decision.events.some(({ type }) => type === "response"));
      assert(decision.events.some(({ type }) => type === "error"));
      const firstPage = JSON.parse(
        (await workerTurn(path, worker, [[
          tool(findings, { limit: 1 }),
        ]])).results[0][0],
      );
      assertEquals(firstPage.records, [verified]);
      assertEquals(firstPage.nextBeforeReceiptId, verified.id);
      const nextPage = await workerTurn(path, worker, [[
        tool(findings, {
          limit: 1,
          beforeReceiptId: firstPage.nextBeforeReceiptId,
        }),
        tool(findings, {
          revision: first.revision,
          beforeReceiptId: firstPage.nextBeforeReceiptId,
        }),
      ]]);
      const older = JSON.parse(nextPage.results[0][0]);
      assertEquals(older.records, [original]);
      assertEquals(older.nextBeforeReceiptId, null);
      assertStringIncludes(nextPage.results[0][1], "unavailable");
      const lookup = tool(findings, { receiptId: verified.id });
      const exact = await workerTurn(path, worker, [[
        lookup,
        tool(findings, { receiptId: original.id, revision: first.revision }),
        tool(findings, { receiptId: verified.id, revision: first.revision }),
      ]]);
      assertEquals(JSON.parse(exact.results[0][0]).record, verified);
      assertEquals(JSON.parse(exact.results[0][1]).record, original);
      assertStringIncludes(exact.results[0][2], "unavailable");
      assert(exact.receiptHooks.includes("PRE_TOOL_CALL"));
      assert(exact.receiptHooks.includes("POST_TOOL_RESPONSE"));
      const blocked = await workerTurn(path, worker, [[lookup]], "receipt-pre");
      assertEquals(blocked.receiptHooks, ["PRE_TOOL_CALL"]);
      assert(!blocked.results[0][0].includes(verified.id));
      const withheld = await workerTurn(
        path,
        worker,
        [[lookup]],
        "receipt-post",
      );
      assertEquals(withheld.receiptHooks, [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      assertStringIncludes(withheld.results[0][0], "withheld by policy");
      const staleLookup = await workerTurn(path, source, [[lookup]]);
      assertStringIncludes(staleLookup.results[0][0], "unavailable");
      check = verified;
      const submit = (reference: string) =>
        reportSentinelGoalCompletion(
          path,
          scope,
          [{
            criterionId: "controls/remediated",
            evidence: [{ source: "finding_recheck", reference, detail: "" }],
          }],
        );
      assertEquals(submit(original.id).record.status, "open");
      assertEquals(
        submit(`worker-recheck:${"0".repeat(64)}`).record.status,
        "open",
      );
      planner.advance(second);
      assertEquals(rounds, [[]]);
      plannerClock += 60_001;
      planner.advance(second);
      await waitFor(() =>
        readSentinelGoalCompletionAtRevision(path, second.revision)?.status ===
          "awaiting_confirmation"
      );
      assertEquals(rounds, [[], [{
        id: verified.id,
        caseId: verified.caseId,
        runId: verified.runId,
        evidenceRevision: second.revision,
        taskId: worker.assignedTaskId,
        targetId: verified.targetId,
        findingId: original.id,
        controlId: verified.controlId,
        evidenceId: "passing-check",
        outcome: "pass",
        observedAt: verified.observedAt,
        validUntil: verified.validUntil,
      }]]);
      await waitFor(() =>
        queue().some(({ nodeId, kind, status }) =>
          nodeId === "dependent-asset" && kind === "impact" &&
          status === "completed"
        )
      );
      await waitFor(() => waitingDependent()?.status === "completed");
      assertEquals(waitingGate()?.id, pendingGate.id);
      assertEquals(waitingGate()?.status, "completed");
      assertEquals(waitingGate()?.attempts, 0);
      assertEquals(
        waitingGate()?.factSatisfaction?.findingRecheckId,
        verified.id,
      );
      assertEquals(
        waitingGate()?.factSatisfaction?.sourceTaskId,
        verified.taskId,
      );
      assertEquals(
        waitingGate()?.factSatisfaction?.evidenceRevision,
        second.revision,
      );
      assertEquals(waitingDependent()?.prerequisites, [pendingGate.id]);
      const dependentClaim = readAdaptiveSentinel(path, second)?.history.find(
        ({ taskId, event }) =>
          taskId === waitingDependent()?.id && event === "claimed",
      );
      assert(dependentClaim?.note);
      assertEquals(JSON.parse(dependentClaim.note), {
        controlPrerequisites: [{
          requirementTaskId: pendingGate.id,
          findingId: original.id,
          findingRecheckId: verified.id,
          sourceTaskId: verified.taskId,
          sourceObservationSha256: waitingGate()?.factSatisfaction
            ?.sourceObservationSha256,
          evidenceRevision: second.revision,
        }],
      });
      assertEquals(
        queue().filter(({ plannerRound }) =>
          plannerRound?.passingRecheckForFindingId === original.id
        ).length,
        1,
      );
      const gate = queue().find(({ plannerRound }) =>
        plannerRound?.passingRecheckId === verified.id
      );
      assert(gate);
      satisfiedGateId = gate.id;
      assertEquals(gate.status, "completed");
      assertEquals(gate.attempts, 0);
      assertEquals(gate.factSatisfaction?.findingRecheckId, verified.id);
      assertEquals(gate.factSatisfaction?.sourceTaskId, verified.taskId);
      assertEquals(gate.factSatisfaction?.evidenceRevision, second.revision);
      assertEquals(
        queue().find(({ nodeId, kind }) =>
          nodeId === "dependent-asset" && kind === "impact"
        )?.prerequisites,
        [gate.id],
      );
      assertEquals(
        queue().filter(({ plannerRound }) =>
          plannerRound?.passingRecheckId !== undefined
        ).length,
        1,
      );
      const savedHistory = readAdaptiveSentinel(path, second)
        ?.modelPlannerHistory;
      assertEquals(
        savedHistory?.map(({ inputManifest }) =>
          inputManifest?.findingRecheckIds
        ),
        [undefined, [verified.id]],
      );
      const verifiedGoal = readSentinelGoalCompletionAtRevision(
        path,
        second.revision,
      );
      assert(verifiedGoal);
      assertEquals(verifiedGoal.status, "awaiting_confirmation");
      assertEquals(
        verifiedGoal.observations[0].evidence[0].reference,
        verified.id,
      );
      assertEquals(
        submit(verified.id).record.observations,
        verifiedGoal.observations,
      );
      const offer = tool("sentinel_prove_goal", {
        goalId: "controls",
        criterionId: "remediated",
        source: "finding_recheck",
        evidenceId: verified.id,
      });
      const withheldProof = await workerTurn(
        path,
        worker,
        [[lookup], [offer]],
        "receipt-post",
      );
      assertStringIncludes(withheldProof.results[1][0], "exact evidence");
      const filed = await workerTurn(path, worker, [[lookup], [offer, offer]]);
      const workerProof = JSON.parse(filed.results[1][0]);
      assertEquals(workerProof.proof.reference, verified.id);
      assertEquals(workerProof.proof.source, "finding_recheck");
      assertStringIncludes(workerProof.proof.detail, worker.assignedTaskId);
      assertEquals(JSON.parse(filed.results[1][1]), workerProof);
      const draft = {
        findingId: original.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
        title: "Updated control gap report",
        summary:
          "The original failure remains evidence. A newer recheck passed.",
      };
      const edited = await workerTurn(path, worker, [[
        tool(amend, draft),
        tool(amend, draft),
        tool(amend, {
          ...draft,
          requestId: crypto.randomUUID(),
          title: "A different edit based on an older version",
        }),
        tool(amend, { ...draft, title: "Changed duplicate" }),
      ]]);
      const [changed, replayed, staleVersion, changedRetry] = edited.results[0];
      const version2 = JSON.parse(changed).amendment;
      assertEquals(JSON.parse(replayed).amendment, version2);
      assertStringIncludes(staleVersion, "unavailable");
      assertStringIncludes(changedRetry, "unavailable");
      assertEquals(edited.reportPre, 4);
      assertEquals(edited.reportPost, 4);
      assertEquals(version2.kind, "report_amendment");
      assertEquals(version2.version, 2);
      assertEquals(version2.findingId, original.id);
      assertEquals(version2.title, draft.title);
      assertEquals(version2.summary, draft.summary);
      assertEquals(version2.evidenceRevision, second.revision);
      assertEquals(version2.taskId, worker.assignedTaskId);
      amendment = version2;
      assertEquals(await list(first.revision), [original]);
      assertEquals(await list(second.revision), [verified]);
      assertEquals((await provenance(first.revision)).workerFindings, {
        findings: [original],
        rechecks: [],
        amendments: [],
        reports: [{
          finding: original,
          version: 1,
          title: original.title,
          summary: original.summary,
          amendments: [],
        }],
      });
      assertEquals((await provenance(second.revision)).workerFindings, {
        findings: [original],
        rechecks: [verified],
        amendments: [version2],
        reports: [{
          finding: original,
          version: 2,
          title: draft.title,
          summary: draft.summary,
          amendments: [version2],
        }],
      });
      const revision = adaptiveRevision(second);
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      let delayedTaskId: string;
      try {
        store.sync(revision, [{
          kind: "trace",
          nodeId: "waiting-dependent",
          depth: 7,
          reason: MODEL_ASSIGNMENT_REASON,
          prerequisites: [pendingGate.id],
        }], revision);
        const delayed = store.list(revision).find(({ nodeId, depth }) =>
          nodeId === "waiting-dependent" && depth === 7
        );
        assert(delayed);
        delayedTaskId = delayed.id;
        const expiry = Date.parse(verified.validUntil);
        assert(
          !store.controlTaskHolds(revision, expiry - 1).blocked.has(delayed.id),
        );
        assert(
          store.controlTaskHolds(revision, expiry).blocked.has(delayed.id),
        );
      } finally {
        store.close();
      }
      assert(recordSentinelOperatingConstraints(path, {
        runId: second.plan.runId!,
        evidenceRevision: second.revision,
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { deniedKinds: ["review_evidence"] },
      }));
      plannerClock += 60_001;
      await waitFor(() => rounds.length === 3);
      assertEquals(rounds[2], []);
      await waitFor(() => !planner.hasInFlightWork());
      advanceAdaptiveSentinel(path, second);
      const delayed = queue().find(({ id }) => id === delayedTaskId);
      assertEquals(delayed?.status, "queued");
      assertEquals(delayed?.attempts, 0);
    });

    assert(finding && check && secondRevision && amendment);
    assertEquals(
      readSentinelGoalCompletionAtRevision(path, secondRevision)
        ?.observations[0].evidence[0].reference,
      check.id,
    );
    await withTidepool(baseDir, async (list, provenance, request) => {
      const selected = {
        caseId: "main",
        revision: secondRevision,
        findingIds: [finding!.id],
      };
      const reviewed = await request("export", {
        ...selected,
        format: "findings-json",
      });
      assertEquals(reviewed.type, "export");
      const selectedReport = JSON.parse(String(reviewed.content));
      assertEquals(selectedReport.caseId, "main");
      assertEquals(selectedReport.revision, secondRevision);
      assertEquals(selectedReport.findings.length, 1);
      const [record] = selectedReport.findings;
      assertEquals(record.id, finding!.id);
      assertEquals(record.original.evidenceId, finding!.evidenceId);
      assertEquals(record.original.taskId, finding!.taskId);
      assertEquals(record.original.snapshotDigest, finding!.snapshotDigest);
      assertEquals(record.rechecks.map(({ id }: { id: string }) => id), [
        check!.id,
      ]);
      assertEquals(record.amendments.map(({ id }: { id: string }) => id), [
        amendment!.id,
      ]);
      assertEquals(record.reportVersion, amendment!.version);
      assertEquals(record.original.requestId, undefined);
      const originalOnly = JSON.parse(String(
        (await request("export", {
          ...selected,
          revision: first.revision,
          format: "findings-json",
        })).content,
      )).findings[0];
      assertEquals(originalOnly.reportVersion, 1);
      assertEquals(originalOnly.rechecks, []);
      assertEquals(originalOnly.amendments, []);
      for (const format of ["csv", "markdown"]) {
        const output = await request("export", { ...selected, format });
        assertEquals(output.type, "export");
        const visible = String(output.content).replace(
          /&#(\d+);/g,
          (_entity, code) => String.fromCodePoint(Number(code)),
        );
        assertStringIncludes(visible, finding!.id);
        assertStringIncludes(visible, check!.id);
        assert(!String(output.content).includes("Waiting dependent"));
      }
      const filterExport = {
        caseId: selected.caseId,
        revision: selected.revision,
        format: "findings-json",
      };
      const filtered = await request("export", {
        ...filterExport,
        findingFilter: {
          kind: "worker",
          assetId: "app",
          query: amendment!.title.toUpperCase(),
        },
      });
      assertEquals(filtered.type, "export");
      assertEquals(JSON.parse(String(filtered.content)).findings, [record]);
      const unfiltered = await request("export", {
        ...filterExport,
        findingFilter: {},
      });
      const all = JSON.parse(String(unfiltered.content));
      assert(
        all.findings.some(({ id }: { id: string }) => id === "review-gap"),
      );
      assert(all.findings.some(({ id }: { id: string }) => id === record.id));
      const empty = await request("export", {
        ...filterExport,
        revision: first.revision,
        findingFilter: { kind: "worker", query: amendment!.title },
      });
      assertEquals(JSON.parse(String(empty.content)).findings, []);
      for (
        const invalid of [
          { ...selected, findingFilter: {} },
          { ...filterExport, findingFilter: { caseId: "other" } },
          { ...filterExport, revision: undefined, findingFilter: {} },
        ]
      ) {
        const rejected = await request("export", {
          format: "findings-json",
          ...invalid,
        });
        assertEquals(rejected.type, "error");
        assertEquals(rejected.content, undefined);
      }
      const tooMany = await request("export", {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
        findingFilter: {},
      });
      assertEquals(tooMany.type, "error");
      assertEquals(tooMany.content, undefined);
      const narrowed = await request("export", {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
        findingFilter: { query: "Control gap" },
      });
      assertEquals(
        JSON.parse(String(narrowed.content)).findings.map(
          ({ id }: { id: string }) => id,
        ),
        ["review-gap"],
      );
      const ratedRequest = {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
      };
      const selectRated = async (disposition: string) => {
        const reply = await request("export", {
          ...ratedRequest,
          findingFilter: { severity: "high", disposition },
        });
        assertEquals(reply.type, "export");
        return JSON.parse(String(reply.content)).findings;
      };
      assertEquals(await selectRated("confirmed"), []);
      assertEquals((await selectRated("open"))[0].id, "review-gap");
      const savedReview = await request("review_finding", {
        caseId: ratedRequest.caseId,
        revision: ratedRequest.revision,
        findingId: "review-gap",
        disposition: "confirmed",
        note: "Verified against the recorded control failure.",
      });
      assertEquals(savedReview.type, "sentinel_state");
      assertEquals(await selectRated("open"), []);
      const confirmed = await selectRated("confirmed");
      assertEquals(confirmed.length, 1);
      assertEquals(confirmed[0].id, "review-gap");
      assertEquals(confirmed[0].severity, "high");
      assertEquals(confirmed[0].disposition, "confirmed");
      const localRatings = await request("export", {
        ...filterExport,
        findingFilter: { severity: "high", disposition: "confirmed" },
      });
      assertEquals(JSON.parse(String(localRatings.content)).findings, []);
      const unrated = await request("export", {
        ...filterExport,
        findingFilter: { kind: "worker", severity: "high" },
      });
      assertEquals(JSON.parse(String(unrated.content)).findings, []);
      const invalidRating = await request("export", {
        ...ratedRequest,
        findingFilter: { severity: "unknown" },
      });
      assertEquals(invalidRating.type, "error");
      const zipped = await request("export", {
        ...selected,
        format: "md-zip",
        findingIds: [finding!.id, "review-gap"],
      });
      assertEquals(zipped.type, "export");
      assertEquals(zipped.encoding, "base64");
      assertEquals(zipped.contentType, "application/zip");
      assertEquals(zipped.filename, `sentinel-findings-r${secondRevision}.zip`);
      const payload = Buffer.from(String(zipped.content), "base64");
      const end = payload.length - 22;
      assertEquals(payload.readUInt32LE(end), 0x06054b50);
      assertEquals(payload.readUInt16LE(end + 10), 2);
      let directory = payload.readUInt32LE(end + 16);
      for (
        const [index, included, excluded] of [
          [1, finding!.id, "review-gap"],
          [2, "review-gap", finding!.id],
        ] as const
      ) {
        assertEquals(payload.readUInt32LE(directory), 0x02014b50);
        const nameSize = payload.readUInt16LE(directory + 28);
        const local = payload.readUInt32LE(directory + 42);
        assertEquals(payload.readUInt32LE(local), 0x04034b50);
        assertEquals(payload.readUInt16LE(local + 8), 0);
        const name = payload.toString(
          "utf8",
          directory + 46,
          directory + 46 + nameSize,
        );
        assertEquals(name, `finding-0${index}.md`);
        assertEquals(
          payload.toString("utf8", local + 30, local + 30 + nameSize),
          name,
        );
        const bodyOffset = local + 30 + nameSize;
        const body = payload.subarray(
          bodyOffset,
          bodyOffset + payload.readUInt32LE(directory + 24),
        );
        assertEquals(
          payload.readUInt32LE(local + 14),
          payload.readUInt32LE(directory + 16),
        );
        const report = body.toString("utf8").replace(
          /&#(\d+);/g,
          (_entity, code) => String.fromCodePoint(Number(code)),
        );
        assertStringIncludes(report, included);
        assert(!report.includes(excluded));
        assert(!report.includes("Waiting dependent"));
        if (index === 1) {
          assertStringIncludes(report, finding!.evidenceId);
          assertStringIncludes(report, finding!.snapshotDigest);
          assertStringIncludes(report, check!.id);
          assert(!report.includes(finding!.requestId));
        }
        directory += 46 + nameSize;
      }
      assertEquals(directory, end);
      const badZip = await request("export", {
        ...selected,
        format: "md-zip",
        findingIds: [finding!.id, "../other-case.md"],
      });
      assertEquals(badZip.type, "error");
      assertEquals(badZip.content, undefined);
      const beforeUnknown = await request("export", {
        ...selected,
        format: "findings-json",
        findingIds: [finding!.id, "unrelated"],
      });
      assertEquals(beforeUnknown.type, "error");
      assertEquals(beforeUnknown.content, undefined);
      const importedExport = await request("export", {
        ...selected,
        revision: first.revision,
        format: "findings-json",
        findingIds: ["review-gap"],
      });
      assertEquals(importedExport.type, "export");
      const importedOnly = JSON.parse(String(importedExport.content));
      assertEquals(importedOnly.findings.map(({ id }: { id: string }) => id), [
        "review-gap",
      ]);
      assertEquals(importedOnly.findings[0].kind, "imported");
      assertEquals(importedOnly.findings[0].assetIds, ["app"]);
      assertEquals(
        (await request("export", { ...selected, format: "provenance" })).type,
        "error",
      );
      for (
        const change of [
          { caseId: "other" },
          { revision: undefined },
          { findingIds: [finding!.id, finding!.id] },
        ]
      ) {
        const rejected = await request("export", {
          ...selected,
          ...change,
          format: "findings-json",
        });
        assertEquals(rejected.type, "error");
        assertEquals(rejected.content, undefined);
      }
      assertEquals(await list(first.revision), [finding!]);
      assertEquals(await list(secondRevision), [check!]);
      assertEquals(
        (await list()).map(({ id }) => id).sort(),
        [finding!.id, check!.id].sort(),
      );
      assertEquals(await list(undefined, "other"), []);
      assertEquals(
        (await provenance(first.revision)).workerFindings.amendments,
        [],
      );
      const restored = await provenance(secondRevision!);
      assertEquals(restored.workerFindings.findings, [finding!]);
      assertEquals(restored.workerFindings.rechecks, [check!]);
      const receiptNode = restored.provenance.nodes.find(({ sourceId }) =>
        sourceId === check!.id
      );
      assert(receiptNode);
      for (const gateId of [satisfiedGateId, waitingGateId]) {
        assert(gateId);
        const gateNode = restored.provenance.nodes.find(({ sourceId }) =>
          sourceId === gateId
        );
        assert(gateNode);
        assert(
          restored.provenance.edges.some(({ from, to, relation }) =>
            from === gateNode.id && to === receiptNode.id &&
            relation === "references"
          ),
        );
      }

      assertEquals(
        restored.planningAttempts.map(({ inputManifest }) =>
          inputManifest?.findingRecheckIds
        ),
        [undefined, undefined, [check!.id], undefined],
      );
      assertEquals(restored.workerFindings.amendments, [amendment!]);
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(true),
        async (turn) => {
          const amended = JSON.parse(
            await turn({
              action: "amend_finding_report",
              kind: "sentinel",
              id: "main",
              revision: secondRevision,
              receiptId: finding!.id,
              reportVersion: amendment!.version,
              evidenceVersion: sentinelFindingTrafficEvidenceVersion(
                path,
                secondRevision!,
                finding!.id,
              ).digest,
              requestId: crypto.randomUUID(),
              findingCategory: "Identity control",
              disposition: "dismissed",
            }),
          ).amendment;
          assertEquals(amended.findingCategory, "Identity control");
          assertEquals(amended.disposition, "dismissed");
        },
      );
      const categoryExport = {
        ...filterExport,
        findingFilter: {
          findingCategory: "identity control",
          disposition: "dismissed",
        },
      };
      const categoryReport = await request("export", categoryExport);
      assertEquals(categoryReport.type, "export");
      const categoryFindings =
        JSON.parse(String(categoryReport.content)).findings;
      assertEquals(categoryFindings.length, 1);
      assertEquals(categoryFindings[0].id, finding!.id);
      assertEquals(categoryFindings[0].findingCategory, "Identity control");
      assertEquals(categoryFindings[0].disposition, "dismissed");
      assertEquals(
        categoryFindings[0].rechecks.map(({ id }: { id: string }) => id),
        [check!.id],
      );
      const earlierCategories = await request("export", {
        ...categoryExport,
        revision: first.revision,
      });
      assertEquals(JSON.parse(String(earlierCategories.content)).findings, []);
    });
    assert(stopSentinelAssessment(path));
    const latest = startSentinelAssessment(path, { goal: "New assessment" });
    assert(latest.plan.runId !== first.plan.runId);
    await verifyHistoricalFindingChat(baseDir, path, finding, check);
  } finally {
    coordinator?.stop();
    modelPlanner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyHistoricalFindingChat(
  baseDir: string,
  path: string,
  finding: SentinelWorkerFindingJournalRecord,
  recheck: SentinelWorkerFindingJournalRecord,
) {
  const registry = createProviderRegistry();
  let args: Record<string, unknown> = {};
  let observed = "";
  let modelCalls = 0;
  let denyResponse = false;
  const receiptHooks: string[] = [];
  registry.register({
    name: "historical-sentinel-finding",
    supportsStreaming: false,
    complete(messages) {
      const first = modelCalls++ === 0;
      const result = messages.findLast(({ role }) => role === "tool");
      if (result) observed = String(result.content);
      return Promise.resolve({
        content: first ? "" : '{"summary":"Finding reviewed.","followUps":[]}',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: first
          ? [{
            id: crypto.randomUUID(),
            type: "function",
            function: { name: findings, arguments: JSON.stringify(args) },
          }]
          : [],
      });
    },
  });
  registry.setDefault("historical-sentinel-finding");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "historical-finding" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner: {
        evaluateHook(hook, { input }) {
          if (input.tool_name === findings) receiptHooks.push(hook);
          const allowed = !denyResponse || hook !== "POST_TOOL_RESPONSE" ||
            input.tool_name !== findings;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
      enableStreaming: false,
      sentinelSnapshotPath: path,
      allowSentinelModelAccess: true,
      resolveSentinelChatCase: (id) => resolveSentinelCasePath(baseDir, id),
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (selector: Record<string, unknown>) => {
      args = selector;
      observed = "";
      modelCalls = 0;
      const done = Promise.withResolvers<void>();
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "turn_end") done.resolve();
        if (event.type === "error") done.reject(new Error(event.message));
      };
      const timer = setTimeout(
        () => done.reject(new Error("Missing Sentinel response")),
        3000,
      );
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({
          type: "message",
          content: "/sentinel-agent Review saved findings.",
        }));
        await done.promise;
        return observed;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    assertEquals(
      JSON.parse(await turn({ revision: finding.evidenceRevision })).records,
      [finding],
    );
    assertEquals(
      JSON.parse(
        await turn({
          receiptId: recheck.id,
          revision: recheck.evidenceRevision,
        }),
      ).record,
      recheck,
    );
    assertStringIncludes(await turn({ receiptId: finding.id }), "unavailable");
    assertStringIncludes(
      await turn({ receiptId: recheck.id, revision: finding.evidenceRevision }),
      "unavailable",
    );
    assert(receiptHooks.includes("PRE_TOOL_CALL"));
    assert(receiptHooks.includes("POST_TOOL_RESPONSE"));
    denyResponse = true;
    assertStringIncludes(
      await turn({
        receiptId: finding.id,
        revision: finding.evidenceRevision,
      }),
      "withheld by policy",
    );
  } finally {
    socket.close();
    await gateway.stop();
  }
}

async function verifyOperatorNativeRecheck(options: {
  baseDir: string;
  state: State;
  findingId: string;
  evidenceId: string;
  digest: string;
  trace?: { taskId: string; result: unknown; index?: number };
}) {
  let blocked = false;
  let blockOutput = false;
  let revokeOnConfirm = false;
  let modelResult: string | undefined;
  const registry = createProviderRegistry();
  registry.register({
    name: "operator-evidence-fixture",
    supportsStreaming: false,
    complete(messages) {
      const response = messages.at(-1)?.role === "tool"
        ? messages.at(-1)
        : undefined;
      if (response) modelResult = String(response.content);
      return Promise.resolve({
        content: response ? "Review complete." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: response ? [] : [{
          id: "native-control-read",
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify({
              kind: "sentinel",
              id: "main",
              revision: options.state.revision,
              ...(options.trace
                ? {
                  action: "worker_trace_result",
                  taskId: options.trace.taskId,
                  stepIndices: [options.trace.index ?? 0],
                }
                : {
                  action: "case_execution_evidence",
                  node: options.evidenceId,
                }),
            }),
          },
        }],
      });
    },
  });
  registry.setDefault("operator-evidence-fixture");
  const confirmations: string[] = [];
  const gateway = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "native-recheck" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    hookRunner: {
      evaluateHook(hook, { input }) {
        const allowed = !(blocked && hook === "PRE_TOOL_CALL" &&
          input.tool_name === "sentinel_live_workflow_status") &&
          !(blocked && hook === "PRE_TOOL_CALL" &&
            input.tool_name === findings) &&
          !(blockOutput && hook === "PRE_OUTPUT");
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          duration: 0,
          ruleId: null,
        });
      },
    },
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: options.baseDir,
      readLiveWorkflow: nativeWorkflowReader(),
      confirm(text) {
        confirmations.push(text);
        if (revokeOnConfirm) blocked = true;
        return Promise.resolve(true);
      },
    }),
  });
  const run = async (command: string) => {
    const events: ChatEvent[] = [];
    await gateway.executeAgentTurn(command, (event) => events.push(event));
    const last = events.at(-1);
    assert(last?.type === "response", JSON.stringify(events));
    return last.text;
  };
  const command =
    `/sentinel-recheck main ${options.state.revision} ${options.findingId}`;
  await run("Review the exact saved workflow evidence.");
  if (options.trace) {
    assertEquals(JSON.parse(modelResult ?? "").result, options.trace.result);
    blocked = true;
    await run("Review that exact worker exchange again.");
    assertStringIncludes(modelResult ?? "", "unavailable");
    return;
  }
  assertEquals(
    JSON.parse(modelResult ?? "").evidence.resultSha256,
    options.digest,
  );
  blockOutput = true;
  const hidden: ChatEvent[] = [];
  await gateway.executeAgentTurn(command, (event) => hidden.push(event));
  assertEquals(hidden.at(-1)?.type, "error");
  blockOutput = false;
  blocked = true;
  assertEquals(JSON.parse(await run(command)).candidates, []);
  blocked = false;
  const discovered = JSON.parse(await run(command));
  assertEquals(discovered.candidates, [{
    nodeId: options.evidenceId,
    resultSha256: options.digest,
  }]);
  assertEquals(discovered.runId, options.state.plan.runId);
  const requestId = crypto.randomUUID();
  const queue =
    `${command} queue ${options.evidenceId} ${discovered.runId} ${discovered.adaptiveRevision} ${requestId}`;
  revokeOnConfirm = true;
  assertStringIncludes(await run(queue), "unavailable");
  assertEquals(confirmations.length, 1);
  assertStringIncludes(confirmations[0], options.digest);
  blocked = false;
  revokeOnConfirm = false;
  const assigned = JSON.parse(await run(queue)).receipt;
  assertEquals(assigned.recheckFindingId, options.findingId);
  assertEquals(assigned.nodeId, options.evidenceId);
  assertEquals(JSON.parse(await run(queue)).receipt, assigned);
  assertEquals(confirmations.length, 2);

  let permitConnector = true;
  let metadataChecks = 0;
  let writes = 0;
  let originalReceipt: string | undefined;
  let recoveredReceipt: string | undefined;
  const reader = nativeWorkflowReader(() => {
    metadataChecks++;
    return permitConnector;
  });
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "native-recheck" as ChannelId,
    bumpersEnabled: false,
  });
  const recover = buildWorkflowRecoveryExecutor(
    { agent_recovery: { sentinel_assignment_cases: ["main"] } },
    options.baseDir,
    createMemorySecretStore(),
    undefined,
    undefined,
    true,
    { readLiveWorkflow: reader },
  );
  assert(recover);
  const assignment = {
    action: "assign",
    kind: "sentinel",
    id: "main",
    revision: options.state.revision,
    runId: discovered.runId,
    adaptiveRevision: discovered.adaptiveRevision,
    requestId: crypto.randomUUID(),
    taskKind: "review_evidence",
    node: options.evidenceId,
    recheckFindingId: options.findingId,
  };
  const recoveryCommand =
    `/recover ${crypto.randomUUID()} Queue the native workflow recheck.`;
  const execute = async (interrupt: boolean) => {
    const providers = createProviderRegistry();
    providers.register({
      name: "native-recovery-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.at(-1);
        const done = result?.role === "tool";
        if (done) recoveredReceipt = String(result.content);
        return Promise.resolve({
          content: done ? "Recovered native workflow assignment." : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: done ? [] : [{
            type: "function",
            id: "native-recheck-assignment",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(assignment),
            },
          }],
        });
      },
    });
    providers.setDefault("native-recovery-fixture");
    const operator = createOperatorRunToolExecutor({
      baseDir: options.baseDir,
      readLiveWorkflow: reader,
      confirm: () => Promise.resolve(true),
    });
    const chat = createChatSession({
      session: owner,
      providerRegistry: providers,
      hookRunner: {
        evaluateHook(hook, { input }) {
          if (
            interrupt && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "operator_runs"
          ) {
            originalReceipt = String(input.tool_response);
          }
          return Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor: (args, context) => {
        writes++;
        return operator(args, context);
      },
      recoverAgentTurn: interrupt
        ? (id, runner, options, control, context) =>
          recover(
            id,
            {
              executeAgentTurn: (turn) =>
                runner.executeAgentTurn({
                  ...turn,
                  onToolBatchCheckpoint: () =>
                    Promise.reject(new Error("fixture interruption")),
                }),
            },
            options,
            control,
            context,
          )
        : recover,
    });
    const events: ChatEvent[] = [];
    await chat.executeAgentTurn(recoveryCommand, (event) => events.push(event));
    return events.at(-1);
  };
  const interrupted = await execute(true);
  assert(interrupted?.type === "error");
  assertStringIncludes(interrupted.message, "checkpoint");
  assert(originalReceipt);
  assertEquals(
    JSON.parse(originalReceipt).receipt.requestId,
    assignment.requestId,
  );
  const originalChecks = metadataChecks;
  permitConnector = false;
  const denied = await execute(false);
  assert(denied?.type === "error");
  assertStringIncludes(denied.message, "uncertain outcome");
  assertEquals(metadataChecks, originalChecks + 1);
  assertEquals(recoveredReceipt, undefined);
  permitConnector = true;
  const resumed = await execute(false);
  assert(resumed?.type === "response");
  assertEquals(recoveredReceipt, originalReceipt);
  assertEquals(writes, 1);
}

async function verifyImportedFindingGrant(
  baseDir: string,
  original: Record<string, unknown>,
  recheck?: Record<string, unknown>,
  native = false,
) {
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
  const executionId = crypto.randomUUID();
  const selectedReceipt = recheck ?? original;
  const grant = {
    case: String(selectedReceipt.caseId),
    run_id: String(selectedReceipt.runId),
    revision: Number(selectedReceipt.evidenceRevision),
    observation_id: String(selectedReceipt.id),
    parent_session_id: owner.id,
    execution_id: executionId,
  };
  const config = {
    sentinel: { delegated_observation_reads: [grant] },
    ...(native ? {} : {
      agent_recovery: {
        github_repositories: ["owner/repo"],
        github_branch_protection: true,
        github_branch_names: { "owner/repo": ["main"] },
      },
    }),
  };
  const secrets = createMemorySecretStore();
  assert(
    (await secrets.setSecret("github-pat", "synthetic-source-credential")).ok,
  );
  let allowed = true;
  let block: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  let checkpoint = true;
  let blockOutput = false;
  let readCount = 0;
  let metadataChecks = 0;
  let modelReceipts = 0;
  let saved: string | undefined;
  const githubFetch: typeof fetch = (request) => {
    metadataChecks++;
    const url = new URL(String(request));
    assertEquals(url.origin, "https://api.github.com");
    if (url.pathname === "/repos/owner/repo") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 42,
            full_name: "owner/repo",
            visibility: "public",
          }),
          { status: allowed ? 200 : 403 },
        ),
      );
    }
    assertEquals(url.pathname, "/repositories/42/commits");
    return Promise.resolve(new Response("", { status: 200 }));
  };
  const authorize = buildExecutionTracePayloadAuthorizer(
    config,
    secrets,
    githubFetch,
  );
  if (!native) assert(authorize);
  const readLiveWorkflow = native
    ? nativeWorkflowReader(() => {
      metadataChecks++;
      return allowed;
    })
    : undefined;
  const sourceTool = native ? "sentinel_live_workflow_status" : "github_repos";
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input, session }) {
      if (
        native && hook === "PRE_TOOL_CALL" && input.tool_name === sourceTool
      ) {
        assertEquals(
          input.url,
          "https://api.github.com/repos/owner/repo/actions/workflows/22",
        );
        assertEquals(input.sentinel_case_id, grant.case);
        assertEquals(input.workflow_id, 22);
        assertEquals(input.is_outbound_request, true);
        assert(typeof input.sentinel_task_id === "string");
        assert(typeof input.sentinel_evidence_revision === "number");
      }
      const allowed = (hook !== block || input.tool_name !== sourceTool) &&
        !(blockOutput && hook === "PRE_OUTPUT" && session.id !== owner.id);
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        duration: 0,
        ruleId: null,
      });
    },
  };
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      assert(options?.recoverySessionId);
      const session = restoreSession({
        id: options.recoverySessionId,
        userId: owner.userId,
        channelId: channelId as ChannelId,
      });
      const selected = selectAgentObservationRead(config.sentinel, options);
      assert(selected);
      const read = createScheduledObservationRead(
        baseDir,
        selected,
        authorize,
        undefined,
        readLiveWorkflow,
      );
      const providerRegistry = createProviderRegistry();
      providerRegistry.register({
        name: "imported-recheck-grant-fixture",
        supportsStreaming: false,
        complete(messages) {
          const result = messages.findLast(({ role }) => role === "tool")
            ?.content;
          if (typeof result === "string" && result.startsWith("{")) {
            const projection = JSON.parse(result);
            assertEquals(projection.finding.id, original.id);
            assertEquals(projection.finding.evidenceId, original.evidenceId);
            assertEquals(projection.finding.taskId, original.taskId);
            assertEquals(
              projection.finding.evidenceRevision,
              original.evidenceRevision,
            );
            assertEquals(
              projection.kind,
              recheck ? "finding_recheck" : "finding",
            );
            if (recheck) {
              assertEquals(projection.recheck.id, recheck.id);
              assertEquals(projection.recheck.evidenceId, recheck.evidenceId);
              assertEquals(projection.recheck.findingId, original.id);
              assertEquals(projection.recheck.taskId, recheck.taskId);
            } else {
              assertEquals(projection.recheck, undefined);
              assertEquals(projection.finding.outcome, "fail");
              assertEquals(projection.finding.summary, undefined);
            }
            if (saved) assertEquals(result, saved);
            saved = result;
            modelReceipts++;
            if (checkpoint) throw new Error("Interrupt after checkpoint");
          }
          return Promise.resolve({
            content: result ? "Recheck reviewed." : "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: result ? [] : [{
              id: "imported-recheck",
              type: "function",
              function: {
                name: scheduledObservationTool.name,
                arguments: "{}",
              },
            }],
          });
        },
      });
      providerRegistry.setDefault("imported-recheck-grant-fixture");
      const orchestratorConfig: OrchestratorConfig = {
        providerRegistry,
        hookRunner,
        getSessionTaint: () => "INTERNAL",
        getNonOwnerCeiling: () => "INTERNAL",
        tools: [scheduledObservationTool, {
          name: "github_repos",
          description: "Fixture source registration",
          parameters: {},
        }],
        toolExecutor(name, args) {
          assertEquals(name, scheduledObservationTool.name);
          readCount++;
          return read(
            args,
            createSavedSourceAuthorization(orchestratorConfig, session),
          );
        },
      };
      return Promise.resolve({
        session,
        getSessionTaint: () => "INTERNAL",
        toolExecutor: orchestratorConfig.toolExecutor!,
        orchestrator: createOrchestrator(orchestratorConfig),
      });
    },
  };
  const token = crypto.randomUUID();
  const start = async () => {
    const chatSession = createChatSession({
      session: owner,
      targetClassification: "INTERNAL",
      providerRegistry: createProviderRegistry(),
      hookRunner,
      runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
        buildSubagentFactory(factory),
        undefined,
        (source) =>
          buildWorkflowRecoveryExecutor(
            config,
            baseDir,
            secrets,
            undefined,
            source,
            false,
            { githubFetch, readLiveWorkflow },
          ),
      ),
    });
    const gateway = createGatewayServer({ port: 0, token, chatSession });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return {
      async turn() {
        const result = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => result.reject(new Error("Missing gateway response")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "response") result.resolve(frame.text);
          if (frame.type === "error") result.reject(new Error(frame.message));
        };
        socket.addEventListener("message", receive);
        socket.send(JSON.stringify({
          type: "message",
          content:
            `/recover-subagent ${executionId} Review the exact imported recheck.`,
        }));
        try {
          return await result.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      },
      async stop() {
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true })
        );
        socket.close();
        await closed;
        await gateway.stop();
      },
    };
  };
  let gateway = await start();
  try {
    assertEquals(await gateway.turn(), "Durable subagent execution failed.");
    const initialChecks = (native ? 1 : 2) * (recheck ? 2 : 1);
    assertEquals([readCount, modelReceipts, metadataChecks], [
      1,
      1,
      initialChecks,
    ]);
    await gateway.stop();
    checkpoint = false;
    gateway = await start();
    block = "PRE_TOOL_CALL";
    assert((await gateway.turn()).startsWith("Sub-agent error:"));
    assertEquals(metadataChecks, initialChecks);
    block = "POST_TOOL_RESPONSE";
    assert((await gateway.turn()).startsWith("Sub-agent error:"));
    assertEquals(metadataChecks, initialChecks + (native ? 1 : 2));
    block = undefined;
    allowed = false;
    assert((await gateway.turn()).startsWith("Sub-agent error:"));
    assertEquals([readCount, modelReceipts], [1, 1]);
    allowed = true;
    blockOutput = true;
    assert((await gateway.turn()).startsWith("Sub-agent error:"));
    assertEquals([readCount, modelReceipts], [1, 2]);
    blockOutput = false;
    assertEquals(await gateway.turn(), "Recheck reviewed.");
    assertEquals([readCount, modelReceipts], [1, 3]);
  } finally {
    await gateway.stop();
  }
}

async function verifyConnectorFindingPublication(
  baseDir: string,
  path: string,
  state: State,
  finding: SentinelWorkerFindingRecord,
  sourceFamily: "repository" | "native" | "attempt" | "branch" | "listing",
) {
  const native = sourceFamily === "native";
  const attempt = sourceFamily === "attempt";
  const branch = sourceFamily === "branch";
  const listing = sourceFamily === "listing";
  const credential = "synthetic-visibility-credential";
  const secrets = createMemorySecretStore();
  assert((await secrets.setSecret("github-pat", credential)).ok);
  let access = true;
  let confirmAndRevoke = false;
  let checks = 0;
  let approvals = 0;
  let blockSource: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  const sourceHooks: string[] = [];
  const authorize = buildExecutionTracePayloadAuthorizer(
    {
      agent_recovery: {
        github_repositories: ["owner/repo"],
        github_repository_status: true,
        github_run_status: attempt,
        github_branch_protection: branch,
        github_branch_names: branch ? { "owner/repo": ["main"] } : undefined,
      },
    },
    secrets,
    (request, options) => {
      checks++;
      const url = new URL(String(request));
      assertEquals(url.origin, "https://api.github.com");
      assertEquals(
        new Headers(options?.headers).get("Authorization"),
        `Bearer ${credential}`,
      );
      if (attempt && url.pathname === "/repos/owner/repo/actions/workflows") {
        assertEquals(url.searchParams.get("per_page"), "1");
        return Promise.resolve(
          new Response("", { status: access ? 200 : 403 }),
        );
      }
      if (branch && url.pathname === "/repositories/42/commits") {
        assertEquals(url.searchParams.get("per_page"), "1");
        return Promise.resolve(
          new Response("", { status: access ? 200 : 403 }),
        );
      }
      if (
        listing && url.pathname === "/repos/owner/repo/actions/workflows/22"
      ) {
        assertEquals(url.search, "");
        return Promise.resolve(
          new Response("", { status: access ? 200 : 403 }),
        );
      }
      assertEquals(url.pathname, "/repos/owner/repo");
      // Current metadata checks permission. The saved result still reported "public".
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 42,
            full_name: "owner/repo",
            visibility: "internal",
          }),
          { status: access ? 200 : 403 },
        ),
      );
    },
  );
  assert(authorize);
  const sourceTool = native
    ? "sentinel_live_workflow_status"
    : attempt || listing
    ? "github_actions"
    : "github_repos";
  const evidenceNode = state.result?.sharedGraph.snapshot?.nodes.find((
    { id },
  ) => id === finding.evidenceId);
  const nativeSource = evidenceNode?.kind === "evidence"
    ? evidenceNode.nativeWorkflowSource
    : undefined;
  if (native) assert(nativeSource);
  const readLiveWorkflow = native
    ? nativeWorkflowReader(() => {
      checks++;
      return access;
    })
    : undefined;
  let command: Record<string, unknown> = {};
  let modelResult: string | undefined;
  const registry = createProviderRegistry();
  registry.register({
    name: "visibility-publication-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      modelResult = last?.role === "tool" ? String(last.content) : undefined;
      return Promise.resolve({
        content: modelResult ? "Reviewed exact finding publication." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: modelResult ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(command),
          },
        }],
      });
    },
  });
  registry.setDefault("visibility-publication-owner");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "internal-fixture" as ChannelId,
      }),
      providerRegistry: registry,
      enableStreaming: false,
      tools: [{
        name: sourceTool,
        description: "Fixture retained source",
        parameters: {},
      }],
      toolExecutor() {
        throw new Error(
          "Publication must reopen the approved projection through source authorization",
        );
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        authorizeExecutionTracePayload: authorize,
        readLiveWorkflow,
        confirm(message) {
          approvals++;
          assert(
            !message.includes("owner/repo") && !message.includes(credential),
          );
          if (confirmAndRevoke) access = false;
          return Promise.resolve(true);
        },
      }),
      hookRunner: {
        evaluateHook(hook, { input }) {
          const source = input.tool_name === sourceTool;
          if (source && listing && hook === "PRE_TOOL_CALL") {
            const call = input.tool_call as { args?: Record<string, unknown> };
            assertEquals(call.args, {
              action: "list_runs",
              repo: "owner/repo",
              workflow: "22",
              per_page: 1,
            });
          }
          if (source && branch && hook === "PRE_TOOL_CALL") {
            const call = input.tool_call as { args?: Record<string, unknown> };
            assertEquals(call.args, {
              action: "list_branches",
              repo: "owner/repo",
            });
          }
          if (source && attempt && hook === "PRE_TOOL_CALL") {
            const call = input.tool_call as { args?: Record<string, unknown> };
            assertEquals(call.args, {
              action: "get_run",
              repo: "owner/repo",
              run_id: 91,
              attempt: 2,
            });
          }
          if (source && native && hook === "PRE_TOOL_CALL") {
            assertEquals(input.sentinel_case_id, "main");
            assertEquals(input.repository, "owner/repo");
            assertEquals(input.workflow_id, 22);
            assertEquals(
              input.sentinel_evidence_revision,
              nativeSource?.revision,
            );
            assertEquals(input.sentinel_task_id, nativeSource?.taskId);
          }
          if (source) sourceHooks.push(hook);
          const allowed = !source || hook !== blockSource;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (request: Record<string, unknown>) => {
      command = {
        kind: "sentinel",
        id: "main",
        revision: state.revision,
        ...request,
      };
      modelResult = undefined;
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("No publication reply")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "response") done.resolve();
        if (event.type === "error") done.reject(new Error(event.message));
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Review the authorized publication.",
          }),
        );
        await done.promise;
        assert(modelResult);
        return modelResult;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    const selection = { receiptId: finding.id };
    const preview = { action: "preview_finding_publication", ...selection };
    blockSource = "PRE_TOOL_CALL";
    assertStringIncludes(await turn(preview), "unavailable");
    assertEquals(checks, 0);
    blockSource = "POST_TOOL_RESPONSE";
    assertStringIncludes(await turn(preview), "unavailable");
    assertEquals(checks, attempt || branch || listing ? 2 : 1);
    blockSource = undefined;
    access = false;
    assertStringIncludes(await turn(preview), "unavailable");
    access = true;
    if (attempt || listing) {
      assertStringIncludes(
        await turn({ ...preview, revision: state.revision - 1 }),
        "unavailable",
      );
      const bundle = join(dirname(path), sentinelExecutionEvidenceFile);
      const original = await Deno.readTextFile(bundle);
      const records = JSON.parse(original);
      const payload = records[0].payload;
      const otherReceipt = attempt ? { ...payload, attempt: 3 } : {
        ...payload,
        workflow: "23",
        runs: [{ ...payload.runs[0], id: 999 }],
      };
      await Deno.writeTextFile(
        bundle,
        JSON.stringify([{
          ...records[0],
          payload: otherReceipt,
          resultSha256: executionEvidenceDigest(otherReceipt),
        }]),
      );
      try {
        const checksBeforeConflict = checks;
        assertStringIncludes(await turn(preview), "unavailable");
        assertEquals(checks, checksBeforeConflict);
        assertEquals(approvals, 0);
        assertEquals(readSentinelWorkerFindingPublications(path, "main"), []);
      } finally {
        await Deno.writeTextFile(bundle, original);
      }
    }
    const approved = JSON.parse(await turn(preview)).preview;
    const publish = {
      ...selection,
      action: "publish_finding",
      requestId: crypto.randomUUID(),
      reportVersion: approved.finding.workerFindingSource.reportVersion,
      evidenceVersion: approved.evidenceVersion,
    };
    confirmAndRevoke = true;
    assertStringIncludes(await turn(publish), "unavailable");
    assertEquals(readSentinelWorkerFindingPublications(path, "main"), []);
    assertEquals(approvals, 1);
    confirmAndRevoke = false;
    access = true;
    const { publication } = JSON.parse(await turn(publish));
    assertEquals(
      publication.finding.label,
      native || listing
        ? "Workflow run control failed"
        : attempt
        ? "Workflow attempt control failed"
        : branch
        ? "Branch protection control failed"
        : "Repository visibility control failed",
    );
    assertEquals(
      publication.finding.workerFindingSource.evidenceId,
      finding.evidenceId,
    );
    assertEquals(
      publication.finding.workerFindingSource.snapshotDigest,
      finding.snapshotDigest,
    );
    const serialized = JSON.stringify(publication);
    assert(
      !serialized.includes("owner/repo") && !serialized.includes(credential),
    );
    assertEquals(approvals, 2);
    assertEquals(JSON.parse(await turn(publish)).publication, publication);
    assertEquals(approvals, 2);
    if (listing) {
      assert(!serialized.includes('"runs"'));
      assert(!serialized.includes('"workflow"'));
    }
    if (branch) {
      assert(!serialized.includes("approvedBranches"));
      assert(!serialized.includes('"dev"'));
    }
    assert(
      sourceHooks.includes("PRE_TOOL_CALL") &&
        sourceHooks.includes("POST_TOOL_RESPONSE"),
    );

    const consumerCase = "published-consumer";
    const consumerPath = resolveSentinelCasePath(baseDir, consumerCase);
    await Deno.mkdir(dirname(consumerPath), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      consumerPath,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", kind: "asset", label: "Consumer asset" }],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const started = JSON.parse(
      await turn({
        action: "spawn",
        targetKind: "sentinel",
        targetId: consumerCase,
        requestId: crypto.randomUUID(),
        sourceCases: [{ caseId: "main", revision: state.revision }],
      }),
    ).run;
    assertEquals(started.ref.id, consumerCase);
    const consumerState = readSentinelAssessment(consumerPath);
    assert(consumerState?.active);
    const consumer = assignedLease(consumerPath, consumerState, "impact");
    const selectedExecution: NonNullable<Parameters<typeof workerTurn>[6]> = {
      prompt: "Review the exact selected source.",
      options: [],
      authorizeExecutionTracePayload: authorize,
    };
    const listSelected = tool("sentinel_shared_asset_links", {
      asset: "app",
      sourceCase: "main",
      includeFindings: true,
    });
    const peer = await workerTurn(
      consumerPath,
      consumer,
      [[listSelected]],
      undefined,
      baseDir,
      readLiveWorkflow,
      selectedExecution,
    );
    const page = JSON.parse(peer.results[0][0]);
    const entry = page.findings.find((
      { finding: reported }: { finding: { id: string } },
    ) => reported.id === finding.id);
    assert(entry);
    assertEquals(
      entry.finding.workerFindingSource,
      publication.finding.workerFindingSource,
    );
    const exactSelected = tool("sentinel_shared_finding_source", {
      asset: "app",
      sourceCase: "main",
      sourceAsset: "app",
      finding: finding.id,
      snapshotDigest: entry.snapshotDigest,
    });
    const exact = await workerTurn(
      consumerPath,
      consumer,
      [[listSelected], [exactSelected]],
      undefined,
      baseDir,
      readLiveWorkflow,
      selectedExecution,
    );
    assert(!exact.results[1][0].startsWith("Error:"));
    assertStringIncludes(exact.results[1][0], finding.id);
    assert(!exact.results[1][0].includes(credential));

    if (attempt) {
      for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
        const before = checks;
        const denied = await workerTurn(
          consumerPath,
          consumer,
          [[listSelected]],
          undefined,
          baseDir,
          readLiveWorkflow,
          { ...selectedExecution, blockedSource: { name: sourceTool, hook } },
        );
        assert(!denied.results[0][0].includes(finding.id));
        assertEquals(checks === before, hook === "PRE_TOOL_CALL");
      }
      let revokeOnProposal = true;
      let proposed = 0;
      let plannerClock = Date.now();
      const providers = createProviderRegistry();
      providers.register({
        name: "selected-connector-planner",
        supportsStreaming: false,
        complete(messages) {
          const last = messages.at(-1);
          const prior = last?.role === "tool" ? String(last.content) : "";
          const call = !prior
            ? listSelected
            : prior.includes("live_published_inventory")
            ? exactSelected
            : undefined;
          if (!call) {
            assertStringIncludes(prior, finding.id);
            proposed++;
            if (revokeOnProposal) access = false;
          }
          return Promise.resolve({
            usage: { inputTokens: 1, outputTokens: 1 },
            content: call ? "" : JSON.stringify({
              prioritize: [],
              assignments: [{
                kind: "trace",
                nodeId: "app",
                depth: 1,
                peerFinding: {
                  localAssetId: "app",
                  sourceCaseId: "main",
                  sourceAssetId: "app",
                  sourceFindingId: finding.id,
                  snapshotDigest: entry.snapshotDigest,
                },
              }],
            }),
            toolCalls: call
              ? [{
                id: crypto.randomUUID(),
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              }]
              : [],
          });
        },
      });
      providers.setDefault("selected-connector-planner");
      const planner = createSentinelModelPlanner(
        consumerPath,
        (current, taskId) =>
          taskId
            ? { execute: () => Promise.resolve(), clear() {} }
            : createSentinelSubagent({
              snapshotPath: consumerPath,
              assessmentRevision: current.revision,
              plannerExecutionEvidenceRunId: current.plan.runId,
              sharedInventoryBaseDir: baseDir,
              authorizeExecutionTracePayload: authorize,
              allowModelAccess: true,
              providerRegistry: providers,
              hookRunner: {
                evaluateHook: (hook, { input }) => {
                  if (input.tool_name === sourceTool) sourceHooks.push(hook);
                  return Promise.resolve({
                    allowed: true,
                    action: "ALLOW",
                    ruleId: null,
                    duration: 0,
                  });
                },
              },
            }),
        undefined,
        () => plannerClock,
      );
      const hasCitedAssignment = () =>
        readAdaptiveSentinel(consumerPath, consumerState, "revision")
          ?.tasks.some(({ plannerRound }) =>
            plannerRound?.peerFindingCitations?.some(
              ({ sourceFindingId }) => sourceFindingId === finding.id,
            )
          ) ?? false;
      try {
        planner.advance(consumerState);
        await waitForCondition(
          () => proposed === 1 && !planner.hasInFlightWork(),
          () => {},
        );
        assertEquals(hasCitedAssignment(), false);
        access = true;
        revokeOnProposal = false;
        plannerClock += 65_000;
        addSentinelCaseHint(
          consumerPath,
          "Use authorized retained evidence for a follow-up.",
        );
        planner.advance(consumerState);
        await waitForCondition(hasCitedAssignment, () => {});
      } finally {
        planner.stop();
      }
    }

    access = false;
    const revokedSelected = await workerTurn(
      consumerPath,
      consumer,
      [[listSelected], [exactSelected]],
      undefined,
      baseDir,
      readLiveWorkflow,
      selectedExecution,
    );
    assert(!revokedSelected.results[0][0].includes(finding.id));
    assert(revokedSelected.results[1][0].startsWith("Error:"));
    const original = {
      action: "case_execution_evidence",
      node: finding.evidenceId,
    };
    assertStringIncludes(await turn(original), "unavailable");

    const withdrawal = {
      action: "withdraw_published_finding",
      ...selection,
      requestId: crypto.randomUUID(),
    };
    assert(JSON.parse(await turn(withdrawal)).publication.withdrawal);
    const future = await workerTurn(
      consumerPath,
      consumer,
      [[tool("sentinel_shared_asset_links", {
        asset: "app",
        sourceCase: "main",
        includeFindings: true,
      })]],
      undefined,
      baseDir,
    );
    assert(!future.results[0][0].includes(finding.id));
    await withTidepool(baseDir, async (_list, _provenance, request) => {
      const retained = await request("shared_finding_source", {
        caseId: consumerCase,
        sourceCase: "main",
        asset: "app",
        snapshotDigest: entry.snapshotDigest,
        finding: finding.id,
      });
      assertEquals(retained.type, "sentinel_source_snapshot");
      assertEquals(retained.published, false);
      const graph = retained.graph as {
        nodes: readonly { id: string; workerFindingSource?: unknown }[];
      };
      const saved = graph.nodes.find(({ id }) => id === finding.id);
      assertEquals(
        saved?.workerFindingSource,
        publication.finding.workerFindingSource,
      );
      assert(!JSON.stringify(retained).includes(credential));
    });
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

async function verifyReceiptFamily(
  family:
    | "branch protection"
    | "workflow attempt"
    | "repository visibility"
    | "workflow result"
    | "workflow result with repeated run"
    | "workflow result with older run"
    | "native workflow result",
  manual = false,
) {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let receiptPlanner:
    | ReturnType<typeof createSentinelModelPlanner>
    | undefined;
  const placeholder = `execution-evidence:${"a".repeat(64)}`;
  const validUntil = new Date(Date.now() + 3_600_000).toISOString();
  const repo = "owner/repo";
  const branchPayload = {
    kind: "github_branch_protection" as const,
    repo,
    repositoryId: 42,
    protectedCount: 0,
    unprotectedCount: 1,
    approvedBranches: [{ name: "main", protected: false }],
  };
  const visibilityPayload = {
    kind: "github_repository_status" as const,
    repo,
    repositoryId: 42,
    visibility: "public" as const,
  };
  const workflowPayload = {
    kind: "github_actions_status" as const,
    repo,
    repositoryId: 42,
    workflow: "22",
    perPage: 1,
    runs: [{
      id: 1,
      status: "completed",
      conclusion: "failure",
      created_at: "2025-01-02T00:00:00.000Z",
    }],
  };
  const attempt = family === "workflow attempt";
  const attemptPayload = {
    kind: "github_actions_run_status" as const,
    repo,
    repositoryId: 42,
    id: 91,
    attempt: 2,
    status: "completed",
    conclusion: "failure",
  };
  const visibility = family === "repository visibility";
  const repeatedRun = family === "workflow result with repeated run";
  const olderRun = family === "workflow result with older run";
  const native = family === "native workflow result";
  const workflow = native || family === "workflow result" || repeatedRun ||
    olderRun;
  const reader = native ? nativeWorkflowReader() : undefined;
  const nativeRuns = [
    {
      id: 1,
      status: "completed",
      conclusion: "failure",
      repositoryId: 42,
      createdAt: "2025-01-02T00:00:00.000Z",
    },
    {
      id: 2,
      status: "completed",
      conclusion: "success",
      repositoryId: 42,
      createdAt: "2025-01-03T00:00:00.000Z",
    },
    {
      id: 3,
      status: "completed",
      conclusion: "success",
      repositoryId: 42,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  const nativeSources: {
    runId: string;
    revision: number;
    taskId: string;
    stepIndex: number;
    workflowRunNumber: number;
    resultSha256: string;
  }[] = [];
  const payload = attempt
    ? attemptPayload
    : workflow
    ? workflowPayload
    : visibility
    ? visibilityPayload
    : branchPayload;
  const evidenceId = (
    runId: string,
    source: Parameters<typeof branchExecutionEvidenceId>[3],
    foreign = false,
  ) =>
    attempt
      ? workflowAttemptEvidenceId(
        runId,
        "app",
        "control",
        source,
        42,
        91,
        2,
        validUntil,
      )
      : workflow
      ? workflowControlEvidenceId(
        runId,
        "app",
        "control",
        source,
        42,
        foreign && !repeatedRun && !olderRun ? "23" : "22",
        validUntil,
      )
      : visibility
      ? repositoryVisibilityEvidenceId(
        runId,
        "app",
        "control",
        source,
        foreign ? 43 : 42,
        validUntil,
      )
      : branchExecutionEvidenceId(
        runId,
        "app",
        "control",
        source,
        "main",
        validUntil,
      );
  const recordedAt = new Date(Date.now() - 30_000).toISOString();
  const passedAt = new Date(Date.now() - 10_000).toISOString();
  const foreignAt = new Date(Date.now() - 5_000).toISOString();
  const source = {
    role: "delegated" as const,
    runId: "source-review",
    ordinal: 1,
    receiptId: `execution-trace:${"b".repeat(64)}`,
    resultSha256: executionEvidenceDigest(payload),
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned asset" },
          {
            id: "gap",
            kind: "finding",
            label: `${family} gap`,
            severity: "low",
          },
          { id: "control", kind: "control", label: family },
          {
            id: placeholder,
            kind: "evidence",
            label: `Saved ${family} receipt`,
            executionSource: source,
            controlVerification: {
              outcome: "fail",
              observedAt: recordedAt,
              validUntil,
            },
          },
        ],
        edges: [
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: placeholder, to: "control", relation: "verifies" },
          { from: placeholder, to: "app", relation: "observed_on" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(dirname(path), sentinelExecutionEvidenceFile),
      JSON.stringify([{
        ...source,
        recordedAt,
        classification: "INTERNAL",
        payload,
      }]),
      { mode: 0o600 },
    );
    const started = startSentinelAssessment(path);
    let node = evidenceId(started.plan.runId!, source);
    if (native) {
      const lease = assignedLease(path, started, "trace");
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      const steps = nativeRuns.map((run, stepIndex) => {
        const runs = [run];
        const resultSha256 = createHash("sha256").update(JSON.stringify(runs))
          .digest("hex");
        nativeSources.push({
          runId: started.plan.runId!,
          revision: started.revision,
          taskId: lease.assignedTaskId,
          stepIndex,
          workflowRunNumber: run.id,
          resultSha256,
        });
        return {
          tool: "sentinel_live_workflow_status",
          target: "app",
          outcome: "returned" as const,
          githubWorkflowRead: {
            repository: repo,
            workflowId: 22,
            evidenceRevision: started.revision,
            observedAt: [recordedAt, passedAt, foreignAt][stepIndex],
            connectorId: "github-actions" as const,
            resultSha256,
            runs,
          },
        };
      });
      try {
        assert(store.recordModelReviewProgress(
          adaptiveRevision(started),
          lease.assignedTaskId,
          lease.assignedTaskLeaseToken,
          steps,
        ));
      } finally {
        store.close();
      }
      node = "native-workflow-evidence:" + nativeSources[0].resultSha256;
    }
    const input = JSON.parse(
      (await Deno.readTextFile(path)).replaceAll(placeholder, node),
    );
    if (native) {
      const evidence = input.nodes.find((entry: { id: string }) =>
        entry.id === node
      );
      delete evidence.executionSource;
      evidence.nativeWorkflowSource = nativeSources[0];
    }
    const wrongBranch = family === "branch protection"
      ? branchExecutionEvidenceId(
        started.plan.runId!,
        "app",
        "dev-control",
        source,
        "dev",
        validUntil,
      )
      : undefined;
    if (wrongBranch) {
      // The retained main failure cannot substantiate a false failure for dev.
      input.nodes.push(
        { id: "dev-control", kind: "control", label: "Dev branch protection" },
        { id: "dev-gap", kind: "finding", label: "Dev claim", severity: "low" },
        {
          ...input.nodes.find(({ id }: { id: string }) => id === node),
          id: wrongBranch,
        },
      );
      input.edges.push(
        { from: "dev-gap", to: "app", relation: "affects" },
        { from: "dev-control", to: "dev-gap", relation: "mitigates" },
        { from: wrongBranch, to: "dev-control", relation: "verifies" },
        { from: wrongBranch, to: "app", relation: "observed_on" },
      );
    }
    await Deno.writeTextFile(path, JSON.stringify(input));
    const state = refreshSentinelAssessment(path);
    assert(state);
    if (wrongBranch) {
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        store.sync(
          adaptiveRevision(state),
          [node, wrongBranch].map((nodeId) => ({
            kind: "review_evidence",
            nodeId,
            reason: MODEL_ASSIGNMENT_REASON,
          })),
          store.activeRevision(),
        );
      } finally {
        store.close();
      }
      const wrong = await workerTurn(
        path,
        assignedLease(path, state, "review_evidence", wrongBranch),
        [
          [tool("sentinel_assigned_execution_evidence", { node: wrongBranch })],
          [tool(report, {
            graphFindingId: "dev-gap",
            controlId: "dev-control",
            evidenceId: wrongBranch,
            requestId: crypto.randomUUID(),
            title: "Incorrect dev outcome",
            summary: "This graph assertion conflicts with the exact receipt.",
          })],
        ],
        undefined,
        baseDir,
        reader,
      );
      assertEquals(
        JSON.parse(wrong.results[0][0]).evidence.payload,
        branchPayload,
      );
      assertStringIncludes(wrong.results[1][0], "unavailable");
    }
    const lease = assignedLease(path, state, "review_evidence", node);
    const submission = {
      graphFindingId: "gap",
      controlId: "control",
      evidenceId: node,
      requestId: crypto.randomUUID(),
      title: `${family} control gap`,
      summary: "The retained verification reports a failed control.",
    };
    const outcome = await workerTurn(
      path,
      lease,
      [
        [tool(assigned)],
        [tool(report, submission)],
        [tool("sentinel_assigned_execution_evidence", { node })],
        [tool(report, submission), tool(report, submission)],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertStringIncludes(
      outcome.results[1][0],
      "Read the exact linked evidence",
    );
    assertEquals(
      JSON.parse(outcome.results[2][0]).evidence.payload,
      native
        ? JSON.parse(JSON.stringify({ ...workflowPayload, perPage: undefined }))
        : payload,
    );

    const finding = JSON.parse(outcome.results[3][0]).record;
    assert(finding);
    assertEquals(finding.targetId, "app");
    assertEquals(finding.evidenceId, node);
    assertEquals(finding.taskId, lease.assignedTaskId);
    assertEquals(JSON.parse(outcome.results[3][1]).record, finding);
    if (
      visibility || attempt || (native && !manual) ||
      family === "branch protection" || family === "workflow result"
    ) {
      await verifyConnectorFindingPublication(
        baseDir,
        path,
        state,
        finding,
        native
          ? "native"
          : attempt
          ? "attempt"
          : family === "branch protection"
          ? "branch"
          : family === "workflow result"
          ? "listing"
          : "repository",
      );
    }
    if (family === "branch protection") {
      await verifyImportedFindingGrant(baseDir, finding);
    }
    if (native && !manual) {
      await verifyImportedFindingGrant(baseDir, finding, undefined, true);
    }
    if (attempt) return;
    await withTidepool(baseDir, async (list) => {
      assertEquals(await list(state.revision), [finding]);
    });
    const peer = await workerTurn(path, assignedLease(path, state, "trace"), [
      [tool(findings, { receiptId: finding.id })],
    ]);
    assertEquals(JSON.parse(peer.results[0][0]).record, finding);
    const planningRegistry = createProviderRegistry();
    let plannerTurns = 0;
    let workerFinding: string | undefined;
    let receiptTargets: string[] = [];
    let recheckCandidates: (string[] | undefined)[] = [];
    planningRegistry.register({
      name: "receipt-candidate-planner",
      supportsStreaming: false,
      complete(messages) {
        const completed = messages.filter(({ role }) => role === "tool");
        if (completed.length) {
          recheckCandidates = completed.map(({ content }) =>
            JSON.parse(String(content)).recheckFindingIds
          );
        }
        if (completed.length || !receiptTargets.length) {
          plannerTurns++;
          return Promise.resolve({
            content: JSON.stringify(
              recheckCandidates[0]?.length
                ? receiptTargets.map((nodeId) => ({
                  kind: "review_evidence",
                  nodeId,
                  recheckFindingId: recheckCandidates[0]![0],
                }))
                : [],
            ),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          });
        }
        return Promise.resolve({
          content: "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: receiptTargets.map((node, index) => ({
            type: "function",
            id: `candidate-receipt-${index}`,
            function: {
              name: "sentinel_case_execution_evidence",
              arguments: JSON.stringify({ node }),
            },
          })),
        });
      },
    });
    planningRegistry.setDefault("receipt-candidate-planner");
    let scheduledResult: Record<string, unknown> | undefined;
    let scheduledRead: unknown;
    let scheduledFindingRead: unknown;
    let scheduledFindingPage: unknown;
    const clock = Date.now();
    receiptPlanner = createSentinelModelPlanner(
      path,
      (state, taskId, token, role) =>
        role === "planner"
          ? createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: state.revision,
            plannerExecutionEvidenceRunId: state.plan.runId,
            sharedInventoryBaseDir: baseDir,
            readRetainedWorkflow: reader,
            providerRegistry: planningRegistry,
            authorizeExecutionTracePayload: (receipt) =>
              Promise.resolve([42, 43].includes(receipt.repositoryId)),
            allowModelAccess: true,
            hookRunner: {
              evaluateHook: () =>
                Promise.resolve({
                  allowed: true,
                  action: "ALLOW",
                  duration: 0,
                  ruleId: null,
                }),
            },
          })
          : {
            execute: async (
              message,
              send,
              signal,
              onStep,
              digests,
              checkpoint,
            ) => {
              const input = JSON.parse(String(message).split("\n").at(-1)!);
              if (input.recheckFindingId) {
                workerFinding = input.recheckFindingId;
                if (native) {
                  assert(taskId && token);
                  const check = {
                    findingId: input.recheckFindingId,
                    evidenceId: input.target,
                    requestId: crypto.randomUUID(),
                    summary: "Verified the newer native workflow run.",
                  };
                  const review = await workerTurn(
                    path,
                    {
                      assessmentRevision: state.revision,
                      assignedTaskId: taskId,
                      assignedTaskLeaseToken: token,
                    },
                    [
                      [tool("sentinel_assigned_execution_evidence", {
                        node: check.evidenceId,
                      })],
                      [tool(context, { findingId: check.findingId })],
                      [tool(recheck, check), tool(recheck, check)],
                      [
                        tool(findings, { receiptId: check.findingId }),
                        tool(findings, { limit: 1 }),
                      ],
                    ],
                    undefined,
                    baseDir,
                    reader,
                    {
                      prompt: message,
                      options: [signal, onStep, digests, checkpoint],
                    },
                  );
                  scheduledRead = JSON.parse(review.results[0][0]);
                  scheduledFindingRead = JSON.parse(review.results[3][0]);
                  scheduledFindingPage = JSON.parse(review.results[3][1]);
                  assertEquals(
                    JSON.parse(review.results[1][0]).current.evidenceId,
                    check.evidenceId,
                  );
                  scheduledResult = JSON.parse(review.results[2][0]).record;
                  assert(scheduledResult);
                  const { outcome, evidenceId, evidenceRevision } = JSON.parse(
                    review.results[2][0],
                  ).record;
                  assertEquals(outcome, "pass");
                  assertEquals(evidenceId, check.evidenceId);
                  assertEquals(evidenceRevision, state.revision);
                  assertEquals(
                    JSON.parse(review.results[2][1]).record,
                    scheduledResult,
                  );
                  for (const event of review.events) send(event);
                  return;
                }
              }
              send({
                type: "response",
                text: '{"summary":"Reviewed the assignment.","followUps":[]}',
                taint: "INTERNAL",
              });
            },
            clear() {},
          },
      undefined,
      () => clock,
    );
    const finishPlanning = async (state: State, count: number) => {
      for (let index = 0; index < 100; index++) {
        receiptPlanner!.advance(state);
        if (plannerTurns === count && !receiptPlanner!.hasInFlightWork()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(
        plannerTurns,
        count,
        JSON.stringify(readAdaptiveSentinel(path, state)),
      );
      assert(!receiptPlanner!.hasInFlightWork());
    };
    await finishPlanning(state, 1);
    const passingBranchPayload = {
      ...branchPayload,
      protectedCount: 1,
      unprotectedCount: 0,
      approvedBranches: [{ name: "main", protected: true }],
    };
    const passingVisibilityPayload = {
      ...visibilityPayload,
      visibility: "private" as const,
    };
    const passingWorkflowPayload = {
      ...workflowPayload,
      runs: [{
        id: 2,
        status: "completed",
        conclusion: "success",
        created_at: "2025-01-03T00:00:00.000Z",
      }],
    };
    const passingPayload = workflow
      ? passingWorkflowPayload
      : visibility
      ? passingVisibilityPayload
      : passingBranchPayload;
    const passedSource = {
      ...source,
      ordinal: 2,
      receiptId: `execution-trace:${"d".repeat(64)}`,
      resultSha256: executionEvidenceDigest(passingPayload),
    };
    const passingNode = native
      ? "native-workflow-evidence:" + nativeSources[1].resultSha256
      : evidenceId(finding.runId, passedSource);
    const foreignPayload = workflow
      ? repeatedRun || olderRun
        ? {
          ...passingWorkflowPayload,
          runs: [{
            ...passingWorkflowPayload.runs[0],
            id: repeatedRun ? 1 : 3,
            ...(olderRun && { created_at: "2025-01-01T00:00:00.000Z" }),
          }],
        }
        : { ...passingWorkflowPayload, workflow: "23" }
      : visibility
      ? { ...passingVisibilityPayload, repositoryId: 43 }
      : { ...passingBranchPayload, repositoryId: 43 };
    const foreignSource = {
      ...passedSource,
      ordinal: 3,
      receiptId: `execution-trace:${"f".repeat(64)}`,
      resultSha256: executionEvidenceDigest(foreignPayload),
    };
    const foreignNode = native
      ? "native-workflow-evidence:" + nativeSources[2].resultSha256
      : evidenceId(finding.runId, foreignSource, true);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          ...[
            { id: passingNode, source: passedSource, observedAt: passedAt },
            { id: foreignNode, source: foreignSource, observedAt: foreignAt },
          ].map(({ id, source, observedAt }, index) => ({
            id,
            kind: "evidence",
            label: `Passing ${family} receipt`,
            ...(native
              ? { nativeWorkflowSource: nativeSources[index + 1] }
              : { executionSource: source }),
            controlVerification: { outcome: "pass", observedAt, validUntil },
          })),
        ],
        edges: [
          ...snapshot.edges,
          {
            from: passingNode,
            to: "control",
            relation: "verifies",
          },
          { from: passingNode, to: "app", relation: "observed_on" },
          { from: foreignNode, to: "control", relation: "verifies" },
          { from: foreignNode, to: "app", relation: "observed_on" },
        ],
      }),
    );
    await Deno.writeTextFile(
      join(dirname(path), sentinelExecutionEvidenceFile),
      JSON.stringify([
        { ...source, recordedAt, classification: "INTERNAL", payload },
        {
          ...passedSource,
          recordedAt: passedAt,
          classification: "INTERNAL",
          payload: passingPayload,
        },
        {
          ...foreignSource,
          recordedAt: foreignAt,
          classification: "INTERNAL",
          payload: foreignPayload,
        },
      ]),
      { mode: 0o600 },
    );
    const updated = refreshSentinelAssessment(path);
    assert(updated && updated.revision > state.revision);
    receiptTargets = [passingNode, foreignNode];
    advanceAdaptiveSentinel(path, updated);
    if (manual) {
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
      });
      return;
    }
    await finishPlanning(updated, 2);
    assertEquals(recheckCandidates, [[finding.id], undefined]);
    const handoff = readAdaptiveSentinel(path, updated)?.tasks.filter((
      task,
    ) => task.plannerRound?.recheckFindingId);
    assertEquals(
      handoff?.map((
        task,
      ) => [task.nodeId, task.plannerRound?.recheckFindingId]),
      [[passingNode, finding.id]],
    );
    assertEquals(workerFinding, finding.id);
    receiptPlanner.stop();
    if (native) {
      assert(handoff?.[0]);
      const taskId = handoff[0].id;
      assertEquals(
        readAdaptiveSentinel(path, updated)?.modelReviewStates.find(
          (worker) => worker.taskId === taskId,
        )?.status,
        "completed",
      );
      assert(scheduledResult);
      assert(scheduledRead);
      await verifyImportedFindingGrant(baseDir, finding, scheduledResult, true);
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
        trace: { taskId, result: scheduledRead },
      });
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
        trace: { taskId, index: 4, result: scheduledFindingRead },
      });
      await verifyOperatorNativeRecheck({
        baseDir,
        state: updated,
        findingId: finding.id,
        evidenceId: passingNode,
        digest: nativeSources[1].resultSha256,
        trace: { taskId, index: 5, result: scheduledFindingPage },
      });
      await withTidepool(baseDir, async (_list, _provenance, request) => {
        const lineage = await request("worker_recheck_lineage", {
          revision: updated.revision,
          taskId,
        });
        assertEquals(lineage.type, "sentinel_worker_recheck_lineage");
        assertEquals(lineage.finding, finding);
        assertEquals(lineage.rechecks, [scheduledResult]);
      });
      return;
    }
    const passingLease = assignedLease(
      path,
      updated,
      "review_evidence",
      passingNode,
    );
    const recheckArgs = {
      findingId: finding.id,
      evidenceId: passingNode,
      requestId: crypto.randomUUID(),
      summary: "Verified the newer passing receipt.",
    };
    const foreign = await workerTurn(
      path,
      assignedLease(path, updated, "review_evidence", foreignNode),
      [
        [tool("sentinel_assigned_execution_evidence", { node: foreignNode })],
        [
          tool(context, { findingId: finding.id }),
          tool(recheck, { ...recheckArgs, evidenceId: foreignNode }),
          tool(findings),
          tool(findings, { receiptId: finding.id }),
        ],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertEquals(
      JSON.parse(foreign.results[0][0]).evidence.payload,
      foreignPayload,
    );
    assertStringIncludes(foreign.results[1][0], "unavailable");
    assertStringIncludes(foreign.results[1][1], "unavailable");
    assertEquals(JSON.parse(foreign.results[1][2]).records, []);
    assertStringIncludes(foreign.results[1][3], "unavailable");
    const verification = await workerTurn(
      path,
      passingLease,
      [
        [
          tool(context, { findingId: finding.id }),
          tool(recheck, recheckArgs),
          tool(findings),
        ],
        [tool("sentinel_assigned_execution_evidence", { node: passingNode })],
        [
          tool(findings),
          tool(context, { findingId: finding.id }),
          tool(findings, { receiptId: finding.id }),
        ],
        [
          tool(recheck, { ...recheckArgs, evidenceId: node }),
          tool(recheck, recheckArgs),
          tool(recheck, recheckArgs),
        ],
      ],
      undefined,
      baseDir,
      reader,
    );
    assertStringIncludes(verification.results[0][0], "unavailable");
    assertStringIncludes(
      verification.results[0][1],
      "Read the exact linked evidence",
    );
    assertEquals(JSON.parse(verification.results[0][2]).records, []);
    assertEquals(JSON.parse(verification.results[2][0]).records, [finding]);
    assertEquals(JSON.parse(verification.results[2][2]).record, finding);
    const read = JSON.parse(verification.results[2][1]);
    assertEquals(read.finding, finding);
    assertEquals(read.current.evidenceId, passingNode);
    assertStringIncludes(
      verification.results[3][0],
      "Read the exact linked evidence",
    );
    const saved = JSON.parse(verification.results[3][1]).record;
    assertEquals(saved.outcome, "pass");
    assertEquals(saved.findingId, finding.id);
    assertEquals(saved.evidenceId, passingNode);
    assertEquals(saved.evidenceRevision, updated.revision);
    assertEquals(JSON.parse(verification.results[3][2]).record, saved);
    if (family === "branch protection") {
      await verifyImportedFindingGrant(baseDir, finding, saved);
    }
    await withTidepool(baseDir, async (list, provenance, request) => {
      assertEquals(await list(state.revision), [finding]);
      const history = (await provenance(updated.revision)).workerFindings;
      assertEquals(history.findings, [finding]);
      assertEquals(history.rechecks, [saved]);
      assert(handoff?.[0]);
      const bound = await request("worker_recheck_lineage", {
        revision: updated.revision,
        taskId: handoff[0].id,
      });
      assertEquals(bound.type, "sentinel_worker_recheck_lineage");
      assertEquals(bound.finding, finding);
      // The test's separate, unbound asset recheck must not appear in this assignment.
      assertEquals(bound.rechecks, []);
      const foreignScope = await request("worker_recheck_lineage", {
        revision: updated.revision,
        taskId: handoff[0].id,
        caseId: "other",
      });
      assertEquals(foreignScope.type, "error");
    });
  } finally {
    receiptPlanner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

for (
  const family of [
    "branch protection",
    "repository visibility",
    "workflow result",
    "workflow result with repeated run",
    "workflow result with older run",
    "native workflow result",
  ] as const
) {
  Deno.test(
    `Leased ${family} evidence reviews publish a failed check and recheck it from a newer receipt`,
    () => verifyReceiptFamily(family),
  );
}

Deno.test("Gateway publication requires the exact saved workflow attempt and evidence revision", () =>
  verifyReceiptFamily("workflow attempt"));

Deno.test("Gateway operator discovers and queues one exact native remediation recheck", () =>
  verifyReceiptFamily("native workflow result", true));

Deno.test("Sentinel schedules one scoped report worker from a committed finding across restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    const time = Date.now();
    const hosts = ["service.example", "neighbor.example"];
    const entries = hosts.map((host) => ({
      startedDateTime: new Date(time - 1000).toISOString(),
      request: { url: `https://${host}/review`, method: "GET" },
      response: { status: 403, content: { text: "Reviewed response." } },
    }));
    const { observations } = importSentinelHar({
      log: { version: "1.2", entries },
    }, "report-fixture");
    const [service, neighbor] = observations;
    await Deno.mkdir(dirname(path), { recursive: true });
    await ingestSentinelTraffic(
      new Blob([entries.map((entry) => JSON.stringify(entry)).join("\n")])
        .stream(),
      "report-fixture",
      path,
      "har",
      true,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: service.assetId, kind: "asset", label: service.origin },
          { id: neighbor.assetId, kind: "asset", label: neighbor.origin },
          {
            id: "gap",
            kind: "finding",
            label: "Control gap",
            severity: "high",
          },
          { id: "control", kind: "control", label: "Control" },
          {
            id: "evidence",
            kind: "evidence",
            label: "Saved failed verification",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(time - 1_000).toISOString(),
              validUntil: new Date(time + 3_600_000).toISOString(),
            },
          },
        ],
        edges: [
          { from: "gap", to: service.assetId, relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: "evidence", to: service.assetId, relation: "observed_on" },
          { from: "evidence", to: "control", relation: "verifies" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const source = assignedLease(path, state, "impact", service.assetId);
    const [traffic] = hosts.map((host) => {
      const receipt = readSentinelTrafficReceiptPage(path, state.revision, {
        origin: `https://${host}`,
      })?.receipts[0];
      assert(receipt);
      return {
        revision: state.revision,
        evidenceId: receipt.evidenceId,
        digest: receipt.digest,
      };
    });
    const input = {
      graphFindingId: "gap",
      controlId: "control",
      evidenceId: "evidence",
      title: "Verified control gap",
      summary: "The case records a failed verification.",
      requestId: crypto.randomUUID(),
    };
    const published = await workerTurn(path, source, [
      [tool(assigned)],
      [tool(report, input), tool(report, input)],
    ]);
    const finding = JSON.parse(published.results[1][0]).record;
    assertEquals(JSON.parse(published.results[1][1]).record, finding);
    advanceAdaptiveSentinel(path, state);
    advanceAdaptiveSentinel(path, state);
    const tasks = () =>
      readAdaptiveSentinel(path, state)!.tasks.filter(
        ({ kind }) => kind === "report_finding",
      );
    assertEquals(tasks().length, 1);
    const reporter = tasks()[0];
    assertEquals(reporter.evidenceIds, [finding.id]);

    const registry = createProviderRegistry();
    let executions = 0;
    let interruptedAfterAttachment = false;
    let interruptedAfterCommit = false;
    const seenHooks: string[] = [];
    const attachmentHooks: string[] = [];
    let offeredAttachments = 0;
    const reportWrite = {
      findingId: finding.id,
      expectedVersion: 1,
      title: "Verification report",
      summary:
        "The saved control verification failed. Review the control configuration.",
      requestId: crypto.randomUUID(),
    };
    const attachment = {
      ...traffic,
      findingId: finding.id,
      reportVersion: 1,
      evidenceRole: "supporting",
      evidenceNote: "Retained response from the assigned asset.",
      requestId: crypto.randomUUID(),
    };
    registry.register({
      name: "report-work-fixture",
      supportsStreaming: false,
      complete(messages, definitions) {
        const names = (definitions ?? []).map((item) =>
          (item as { function?: { name?: string } }).function?.name
        );
        if (!names.includes(amend)) {
          return Promise.resolve({
            content: '{"assignments":[]}',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          });
        }
        assert(!names.includes("sentinel_live_workflow_status"));
        assert(!names.includes(report));
        const results = messages.filter(({ role }) => role === "tool");
        let batch: ReturnType<typeof tool>[] = [];
        if (!results.length) {
          executions++;
          batch = [
            tool("sentinel_worker_findings", { receiptId: finding.id }),
            tool("sentinel_traffic_search", { revision: state.revision }),
          ];
        } else if (results.length === 2) {
          assertEquals(JSON.parse(String(results[0].content)).record, finding);
          const page = JSON.parse(String(results[1].content));
          assertEquals(
            page.receipts.map(({ evidenceId }: { evidenceId: string }) =>
              evidenceId
            ),
            [
              traffic.evidenceId,
            ],
          );
          batch = [tool("sentinel_traffic_get", traffic)];
        } else if (results.length === 3) {
          assertEquals(
            JSON.parse(String(results[2].content)).receipt.digest,
            traffic.digest,
          );
          offeredAttachments++;
          batch = [tool("sentinel_attach_finding_traffic", attachment)];
        } else if (results.length === 4) {
          const { link } = JSON.parse(String(results[3].content));
          assertEquals(link.trafficDigest, traffic.digest);
          assertEquals(link.authority, {
            kind: "assignment",
            taskId: reporter.id,
          });
          batch = [tool("sentinel_finding_traffic_links", {
            revision: state.revision,
            findingId: finding.id,
          })];
        } else if (results.length === 5) {
          const { evidenceVersion } = JSON.parse(String(results[4].content));
          batch = [
            tool(amend, { ...reportWrite, evidenceVersion: "0".repeat(64) }),
            tool(amend, { ...reportWrite, evidenceVersion }),
          ];
        } else {
          assertStringIncludes(String(results[5].content), "unavailable");
          assertEquals(
            JSON.parse(String(results[6].content)).amendment.taskId,
            reporter.id,
          );
        }
        return Promise.resolve({
          content: batch.length
            ? ""
            : '{"summary":"Report saved.","followUps":[]}',
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: batch.map(({ name, args }, i) => ({
            id: `report-work-${results.length}-${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        });
      },
    });
    registry.setDefault("report-work-fixture");
    const createWorker = (
      _state: State,
      assignedTaskId?: string,
      assignedTaskLeaseToken?: string,
    ) =>
      createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: assignedTaskId
          ? undefined
          : state.plan.runId,
        assignedTaskId,
        assignedTaskLeaseToken,
        providerRegistry: registry,
        allowModelAccess: true,
        hookRunner: {
          evaluateHook(hook, { input }) {
            if (input.tool_name === "sentinel_attach_finding_traffic") {
              attachmentHooks.push(hook);
              if (
                hook === "POST_TOOL_RESPONSE" &&
                typeof input.tool_response === "string" &&
                input.tool_response.includes('"link"') &&
                !interruptedAfterAttachment
              ) {
                interruptedAfterAttachment = true;
                planner?.stop();
              }
            }
            if (input.tool_name === amend) {
              seenHooks.push(hook);
              if (
                hook === "POST_TOOL_RESPONSE" &&
                typeof input.tool_response === "string" &&
                input.tool_response.includes('"amendment"')
              ) {
                assertEquals(
                  readSentinelWorkerFindingReport(path, state.revision)
                    ?.amendments.length,
                  1,
                );
                interruptedAfterCommit = true;
                planner?.stop();
              }
            }
            return Promise.resolve({
              allowed: true,
              action: "ALLOW",
              ruleId: null,
              duration: 0,
            });
          },
        },
      });
    const waitFor = async (condition: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!condition() && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert(
        condition(),
        JSON.stringify(readAdaptiveSentinel(path, state)?.modelReviewStates),
      );
    };
    const review = () =>
      readAdaptiveSentinel(path, state)?.modelReviews.find(
        ({ taskId }) => taskId === reporter.id,
      );
    planner = createSentinelModelPlanner(path, createWorker);
    planner.advance(state);
    await waitFor(() =>
      interruptedAfterAttachment &&
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(
          ({ taskId }) => taskId === reporter.id,
        )?.status !== "running"
    );
    assertEquals(review(), undefined);
    assertEquals(
      readSentinelWorkerFindingReport(path, state.revision)?.amendments,
      [],
    );
    planner = createSentinelModelPlanner(path, createWorker);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await waitFor(() =>
      interruptedAfterCommit &&
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(
          ({ taskId }) => taskId === reporter.id,
        )?.status !== "running"
    );
    assertEquals(review(), undefined);
    planner = createSentinelModelPlanner(path, createWorker);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await waitFor(() => {
      if (review()) return true;
      planner?.advance(state);
      return false;
    });
    assertStringIncludes(review()?.summary ?? "", "Recovered the committed");
    const saved = readSentinelWorkerFindingReport(path, state.revision);
    assertEquals(saved?.amendments.length, 1);
    assertEquals(saved?.amendments[0].taskId, reporter.id);
    assertEquals(review()?.steps.at(-1)?.target, saved?.amendments[0].id);
    assertEquals(seenHooks, [
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
    ]);
    planner.stop();
    planner = createSentinelModelPlanner(path, createWorker);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    assertEquals(tasks().map(({ id }) => id), [reporter.id]);
    assertEquals(executions, 1);
    assertEquals(offeredAttachments, 1);
    assert(attachmentHooks.includes("PRE_TOOL_CALL"));
    assert(attachmentHooks.includes("POST_TOOL_RESPONSE"));
    await withTidepool(baseDir, async (_list, provenance, request) => {
      const exported = await provenance(state.revision);
      const links = exported.findingTrafficLinks ?? [];
      assertEquals(links.length, 1);
      assert(
        review()?.steps.some((step) =>
          step.tool === "sentinel_attach_finding_traffic" &&
          step.outcome === "returned" && step.target === links[0].id
        ),
      );
      assertEquals(
        links[0].trafficDigest,
        traffic.digest,
      );
      assertEquals(links[0].evidenceRole, attachment.evidenceRole);
      assertEquals(links[0].evidenceNote, attachment.evidenceNote);
      assert(saved);
      const evidenceVersion =
        sentinelFindingTrafficEvidenceVersion(path, state.revision, finding.id)
          .digest;
      let annotationId: string | undefined;
      let withdrawalId: string | undefined;
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(true),
        async (turn) => {
          const outcome = JSON.parse(
            await turn({
              action: "annotate_finding_traffic",
              kind: "sentinel",
              id: "main",
              revision: state.revision,
              receiptId: finding.id,
              trafficLinkId: links[0].id,
              reportVersion: saved.reports[0].version,
              evidenceVersion,
              evidenceRole: "verification",
              evidenceNote: "Reviewed the verification evidence.",
              requestId: crypto.randomUUID(),
            }),
          );
          annotationId = outcome.amendment.id;
          const latestVersion = sentinelFindingTrafficEvidenceVersion(
            path,
            state.revision,
            finding.id,
          ).digest;
          const withdrawal = JSON.parse(
            await turn({
              action: "withdraw_finding_traffic",
              kind: "sentinel",
              id: "main",
              revision: state.revision,
              receiptId: finding.id,
              trafficLinkId: links[0].id,
              reportVersion: saved.reports[0].version,
              evidenceVersion: latestVersion,
              requestId: crypto.randomUUID(),
            }),
          ).amendment;
          withdrawalId = withdrawal.id;
        },
      );
      const report = await request("export", {
        caseId: "main",
        revision: state.revision,
        format: "findings-json",
        findingIds: [finding.id],
      });
      assertEquals(report.type, "export");
      const exportedFinding = JSON.parse(String(report.content)).findings[0];
      const [exportedLink] = exportedFinding.trafficLinks;
      assertEquals(exportedLink.withdrawn, true);
      assertEquals(exportedFinding.trafficLinkSetHistory[0].id, withdrawalId);
      assertEquals(
        exportedFinding.trafficLinkSetHistory[0].requestId,
        undefined,
      );
      assertEquals(exportedLink.id, links[0].id);
      assertEquals(exportedLink.trafficDigest, traffic.digest);
      assertEquals(exportedLink.evidenceRole, attachment.evidenceRole);
      assertEquals(exportedLink.annotations[0].id, annotationId);
      assertEquals(exportedLink.annotations[0].evidenceRole, "verification");
      assertEquals(exportedLink.annotations[0].requestId, undefined);
    });
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Sentinel planner queues a cold finding only after an authorized exact read", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const now = Date.now();
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          { id: "finding", kind: "finding", label: "Gap", severity: "high" },
          { id: "control", kind: "control", label: "Control" },
          {
            id: "proof",
            kind: "evidence",
            label: "Failed verification",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(now - 60_000).toISOString(),
              validUntil: new Date(now + 60_000).toISOString(),
            },
          },
        ],
        edges: [
          { from: "finding", to: "app", relation: "affects" },
          { from: "control", to: "finding", relation: "mitigates" },
          { from: "proof", to: "control", relation: "verifies" },
          { from: "proof", to: "app", relation: "observed_on" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const lease = assignedLease(path, state, "impact");
    const reports = Array.from({ length: 9 }, (_, index) =>
      tool(report, {
        graphFindingId: "finding",
        controlId: "control",
        evidenceId: "proof",
        title: `Verified gap ${index}`,
        summary: `Verified failed control check ${index}.`,
        requestId: crypto.randomUUID(),
      }));
    const publication = await workerTurn(path, lease, [
      [tool(assigned)],
      reports.slice(0, 5),
      reports.slice(5),
    ]);
    const coldId = JSON.parse(publication.results[1][0]).record.id;
    assert(
      publication.results.slice(1).flat().every((result) =>
        JSON.parse(result).record.kind === "finding"
      ),
    );
    let answerTaint: string | undefined;
    let delivered: string | undefined;
    let hookCalls = 0;
    let denyRead = true;
    let plannerClock = Date.now();
    const providerRegistry = createProviderRegistry();
    providerRegistry.register({
      name: "cold-finding-planner",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (!result) {
          const prompt = messages.findLast(({ role }) => role === "user")!;
          const inputs = JSON.parse(String(prompt.content).split("\n").at(-1)!);
          assert(
            !inputs.pendingRecheckFindings.some(({ id }: { id: string }) =>
              id === coldId
            ),
          );
          return Promise.resolve({
            content: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [{
              id: "open-cold-finding",
              type: "function",
              function: {
                name: findings,
                arguments: JSON.stringify({ receiptId: coldId }),
              },
            }],
          });
        }
        const text = String(result.content);
        if (denyRead) assert(!text.includes(coldId));
        else delivered = JSON.parse(text).record.id;
        return Promise.resolve({
          content: JSON.stringify([{
            kind: "trace",
            nodeId: "app",
            depth: 1,
            passingRecheckForFindingId: coldId,
          }]),
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      },
    });
    providerRegistry.setDefault("cold-finding-planner");
    planner = createSentinelModelPlanner(
      path,
      (current, taskId) => {
        if (taskId) return { execute: () => Promise.resolve(), clear() {} };
        const agent = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          plannerExecutionEvidenceRunId: current.plan.runId,
          allowModelAccess: true,
          providerRegistry,
          hookRunner: {
            evaluateHook(hook, { input, session }) {
              if (
                (input.tool_name ??
                  (input.tool_call as { name?: string } | undefined)?.name) ===
                  findings
              ) {
                hookCalls++;
                if (denyRead && hook === "POST_TOOL_RESPONSE") {
                  return Promise.resolve({
                    allowed: false,
                    action: "BLOCK",
                    ruleId: "deny-cold-read",
                    duration: 0,
                  });
                }
              }
              if (hook === "PRE_OUTPUT") answerTaint = session.taint;
              return Promise.resolve({
                allowed: true,
                action: "ALLOW",
                ruleId: null,
                duration: 0,
              });
            },
          },
        });
        return agent;
      },
      undefined,
      () => plannerClock,
    );
    const view = () => readAdaptiveSentinel(path, state);
    const hasGate = () =>
      view()?.tasks.some(({ plannerRound }) =>
        plannerRound?.passingRecheckForFindingId === coldId
      ) === true;
    await waitForCondition(
      () => hookCalls === 2 && !planner?.hasInFlightWork(),
      () => planner?.advance(state),
    );
    assert(!hasGate());
    assertEquals(delivered, undefined);
    denyRead = false;
    plannerClock += 60_001;
    addSentinelCaseHint(path, "Reconsider the archived control gap.");
    await waitForCondition(
      hasGate,
      () => planner?.advance(state),
    );
    assertEquals(delivered, coldId);
    assertEquals(hookCalls, 4);
    assertEquals(answerTaint, "INTERNAL");
    const gate = view()?.tasks.find(({ plannerRound }) =>
      plannerRound?.passingRecheckForFindingId === coldId
    );
    assertEquals(gate?.status, "queued");
    assertEquals(gate?.attempts, 0);
    assert(
      view()?.modelPlannerHistory?.some(({ reads }) =>
        reads?.some(({ goalReceiptRead }) =>
          goalReceiptRead?.args.receiptId === coldId
        )
      ),
    );
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
