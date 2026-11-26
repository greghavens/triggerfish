import { createWorkflowRunRegistry } from "../../src/workflow/registry.ts";
import { createOperatorWorkflowRuns } from "../../src/gateway/operator_workflow_runs.ts";
import { createWorkflowObservationVerifier } from "../../src/gateway/scheduled_observation_tool.ts";
import { subscribeCommittedEvidence } from "../../src/core/evidence_task_progression.ts";
import { DatabaseSync } from "node:sqlite";
import { INCONCLUSIVE_RECHECK_TOOL } from "../../src/sentinel/recheck_inconclusive.ts";
import { createFindingEvidenceDownload } from "../../tidepool-ui/src/screens/Sentinel/finding_evidence_download.ts";
import { createTrafficDownload } from "../../tidepool-ui/src/screens/Sentinel/traffic_download.ts";
import type { ChatSession } from "../../src/gateway/chat_session_interface.ts";
import { createFindingDownload } from "../../tidepool-ui/src/screens/Sentinel/finding_download.ts";
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
  readSentinelCaseHints,
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
  completeSentinelAssessmentGoal,
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelOperatingConstraintDigest,
  readSentinelOperatingConstraints,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { importSentinelHar } from "../../src/sentinel/har.ts";
import {
  listSentinelFindingTrafficLinks,
  openSentinelFindingTrafficLinks,
  sentinelFindingTrafficEvidenceVersion,
  type SentinelFindingTrafficLink,
} from "../../src/sentinel/finding_traffic_links.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";
import { readSentinelWorkerFindingPublications } from "../../src/sentinel/worker_finding_publications.ts";
import {
  openSentinelWorkerFindingStore,
  readSentinelWorkerFindingHistory,
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
  caseId = "main",
) {
  return createSentinelLiveWorkflowReader({
    scopes: [{
      case: caseId,
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
      const writing = [report, recheck, amend, INCONCLUSIVE_RECHECK_TOOL]
        .includes(name);
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
  readTrafficDownloadPage?: ChatSession["readSentinelTrafficDownloadPage"],
) {
  const key = crypto.randomUUID();
  const handler = createTidepoolSentinelHandler(
    {
      baseDir,
      config: { sentinel: { allow_model_access: true } },
    } as BootstrapResult,
    undefined,
    undefined,
    readTrafficDownloadPage,
  );
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
  timeoutMs = 2_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
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
  workflows?: ReturnType<typeof createOperatorWorkflowRuns>,
  readLiveWorkflow?: ReturnType<typeof nativeWorkflowReader>,
  echoToolResult = false,
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
        content: echoToolResult
          ? output
          : output
          ? "Reviewed Sentinel assignment."
          : "",
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
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      confirm,
      workflows,
      readLiveWorkflow,
    }),
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

Deno.test("A reviewed assignment question reaches only its leased worker and survives archive restore", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "assignment-question";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const questions = [
    "Which retained records show the first application control?",
    "Which retained records show the second application control?",
  ];
  const seen: { taskId: string; question: string; prompt: string }[] = [];
  const plannerInputs: string[] = [];
  let pauseFirst = true;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const createPlanner = () =>
    createSentinelModelPlanner(path, (state, taskId, lease) => {
      if (!taskId || !lease) {
        return {
          execute(prompt, send) {
            plannerInputs.push(String(prompt));
            send({ type: "response", text: "[]", taint: "INTERNAL" });
            return Promise.resolve();
          },
          clear() {},
        };
      }
      const providers = createProviderRegistry();
      providers.register({
        name: "reviewed-question-worker",
        supportsStreaming: false,
        async complete(messages) {
          const prompt = String(
            messages.findLast(({ role }) => role === "user")?.content,
          );
          const payload = JSON.parse(prompt.split("\n").at(-1)!);
          seen.push({ taskId, question: payload.operatorQuestion, prompt });
          if (pauseFirst) {
            entered.resolve();
            await release.promise;
          }
          return {
            content: JSON.stringify({
              summary:
                `Reviewed retained records for ${payload.operatorQuestion}`,
              followUps: [],
            }),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          };
        },
      });
      providers.setDefault("reviewed-question-worker");
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: lease,
        providerRegistry: providers,
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
      });
    });
  let planner: ReturnType<typeof createPlanner> | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", kind: "asset", label: "Reviewed application" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    advanceAdaptiveSentinel(path, state);
    const ref = { kind: "sentinel", id: caseId, revision: state.revision };
    const batch = {
      ...ref,
      action: "assign_batch",
      runId,
      adaptiveRevision: adaptiveRevision(state),
      requestId: crypto.randomUUID(),
      assignments: questions.map((question) => ({
        taskKind: "trace",
        node: "app",
        question,
      })),
    };
    let reviews = 0;
    let denyWrite = true;
    const confirm = () => {
      reviews++;
      return Promise.resolve(true);
    };
    const refs: { taskId: string; question: string }[] = [];
    let receipt: unknown;
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertStringIncludes(await turn(batch), "policy");
      denyWrite = false;
      assertStringIncludes(
        await turn({
          ...batch,
          assignments: [{ ...batch.assignments[0], question: "\u0001invalid" }],
        }),
        "unavailable",
      );
      assertEquals(reviews, 0);
      const admitted = JSON.parse(await turn(batch)).receipt;
      receipt = admitted;
      refs.push(
        ...admitted.receipts.map((
          { taskId, question }: typeof refs[number],
        ) => ({ taskId, question })),
      );
      assertEquals(refs.map(({ question }) => question), questions);
      assert(refs[0].taskId !== refs[1].taskId);
      assertEquals(JSON.parse(await turn(batch)).receipt, receipt);
      assertStringIncludes(
        await turn({
          ...batch,
          assignments: [{
            ...batch.assignments[0],
            question: "Different approved text?",
          }],
        }),
        "unavailable",
      );
      assertEquals(reviews, 1);
    }, (hook, input) =>
      !denyWrite || hook !== "PRE_TOOL_CALL" ||
      (input.tool_call as { args?: { action?: string } } | undefined)?.args
          ?.action !== "assign_batch");
    const archiveId = crypto.randomUUID();
    planner = createPlanner();
    planner.advance(state);
    const startTimeout = setTimeout(
      () => entered.reject(new Error("No question-bearing lease")),
      3_000,
    );
    try {
      await entered.promise;
    } finally {
      clearTimeout(startTimeout);
    }
    assertEquals(seen.length, 1);
    const interrupted = seen[0];
    const initial = refs.find(({ taskId }) => taskId === interrupted.taskId);
    assertEquals(interrupted.question, initial?.question);
    planner.stop();
    release.resolve();
    await waitForCondition(() => !planner?.hasInFlightWork(), () => {});
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(
        JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
        "stopped",
      );
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
    });
    await Deno.rename(dirname(path), join(baseDir, "before-question-restore"));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      assertEquals(JSON.parse(await turn(batch)).receipt, receipt);
      assertEquals(
        JSON.parse(await turn({ ...ref, action: "resume" })).run.status,
        "running",
      );
      const listing = await turn({ ...ref, action: "tasks" });
      assert(questions.every((question) => !listing.includes(question)));
    });
    const restored = readSentinelAssessment(path);
    assert(restored);
    pauseFirst = false;
    planner = createPlanner();
    const completed = () =>
      readAdaptiveSentinel(path, restored)?.modelReviews
        .filter(({ taskId }) =>
          refs.some((record) => record.taskId === taskId)
        ) ?? [];
    await waitForCondition(
      () => completed().length === 2,
      () => planner!.advance(restored),
      4_000,
    );
    assertEquals(
      seen.filter(({ taskId }) => taskId === interrupted.taskId).length,
      2,
    );
    assertEquals(seen.length, 3);
    for (const entry of seen) {
      const owner = refs.find(({ taskId }) => taskId === entry.taskId);
      assertEquals(entry.question, owner?.question);
      assert(
        questions.filter((question) => question !== entry.question).every((
          other,
        ) => !entry.prompt.includes(other)),
      );
    }
    await waitForCondition(
      () => plannerInputs.length > 0,
      () => planner!.advance(restored),
    );
    assert(
      plannerInputs.every((prompt) =>
        questions.every((question) => !prompt.includes(question))
      ),
    );
    assert(
      completed().every(({ summary }) =>
        questions.every((question) => !summary.includes(question))
      ),
    );
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: state.revision,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      constraints: { deniedKinds: ["trace"] },
    }));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertStringIncludes(await turn(batch), "unavailable");
      const longBatch = {
        ...batch,
        requestId: crypto.randomUUID(),
        assignments: Array.from({ length: 8 }, (_, index) => ({
          taskKind: "impact",
          node: "app",
          question: `Review retained control ${index}. ${
            "Recorded observation. ".repeat(26).trim()
          }`,
        })),
      };
      const compact = JSON.parse(await turn(longBatch)).receipt;
      assertEquals(compact.requestId, longBatch.requestId);
      assertEquals(compact.receipts.length, 8);
      assert(
        compact.receipts.every((
          { questionSha256 }: { questionSha256: string },
        ) => /^[a-f0-9]{64}$/.test(questionSha256)),
      );
      const reviewed = reviews;
      assertEquals(JSON.parse(await turn(longBatch)).receipt, compact);
      assertEquals(reviews, reviewed);
    });
  } finally {
    release.resolve();
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Reviewed analyst finding uses exact local failing evidence and survives gateway restore", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "reviewed-analyst";
  const path = resolveSentinelCasePath(baseDir, caseId);
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    const now = Date.now();
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Expected application" },
          { id: "other", kind: "asset", label: "Unrelated application" },
          {
            id: "gap",
            kind: "finding",
            label: "Control gap",
            severity: "high",
          },
          { id: "control", kind: "control", label: "Required control" },
          {
            id: "check",
            kind: "evidence",
            label: "Retained failed check",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(now - 60_000).toISOString(),
              validUntil: new Date(now + 3_600_000).toISOString(),
            },
          },
        ],
        edges: [
          { from: "check", to: "app", relation: "observed_on" },
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: "check", to: "control", relation: "verifies" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: state.revision,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      constraints: { allowedAssetIds: ["app"], deniedKinds: [] },
    }));
    const ref = { kind: "sentinel", id: caseId, revision: state.revision };
    const request = {
      ...ref,
      action: "record_analyst_finding",
      runId,
      targetId: "app",
      findingId: "gap",
      controlId: "control",
      evidenceId: "check",
      title: "Analyst reviewed required control",
      summary: "The retained control verification fails for this application.",
      severity: "high",
      findingCategory: "Configuration",
      requestId: crypto.randomUUID(),
    };
    let reviews = 0;
    let blocked = true;
    let denySources = false;
    let revokeOnReview = true;
    let classified = false;
    let deniedDelivery = 0;
    const frames: string[] = [];
    let clock = now;
    const seen = new Set<string>();
    planner = createSentinelModelPlanner(
      path,
      (_state, task) => ({
        execute(prompt, send) {
          if (!task) {
            const inputs = JSON.parse(String(prompt).split("\n").at(-1)!);
            for (const { id } of inputs.pendingRecheckFindings ?? []) {
              seen.add(id);
            }
            send({ type: "response", taint: "INTERNAL", text: "[]" });
          }
          return Promise.resolve();
        },
        clear() {},
      }),
      undefined,
      () => clock,
    );
    coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive: (current) => planner?.advance(current),
    });
    const confirm = () => {
      reviews++;
      denySources = revokeOnReview;
      return Promise.resolve(true);
    };
    const policy = (hook: string, input: Record<string, unknown>) => {
      if (
        hook === "PRE_OUTPUT" && String(input.content).includes(request.title)
      ) {
        deniedDelivery++;
        return false;
      }
      const call = input.tool_call as
        | { args?: { action?: string } }
        | undefined;
      if (hook === "PRE_TOOL_CALL") {
        if (blocked && call?.args?.action === request.action) return false;
        if (denySources && call?.args?.action === "node") return false;
      }
      if (
        hook === "POST_TOOL_RESPONSE" && input.tool_name === "operator_runs" &&
        typeof input.tool_response === "string" &&
        input.tool_response.includes('"operatorScope":"owner"')
      ) classified = true;
      return true;
    };
    let saved: SentinelWorkerFindingJournalRecord | undefined;
    await withFindingAssignmentGateway(
      baseDir,
      confirm,
      async (turn) => {
        assertStringIncludes(await turn(request), "policy");
        blocked = false;
        assertStringIncludes(
          await turn({ ...request, targetId: "other" }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({ ...request, revision: state.revision + 1 }),
          "unavailable",
        );
        assertEquals(reviews, 0);
        assertStringIncludes(await turn(request), "unavailable");
        assertEquals(reviews, 1);
        assertEquals(
          readSentinelWorkerFindingHistory(path, state.revision),
          [],
        );
        revokeOnReview = false;
        denySources = false;
        clock += 120_000;
        const committed = JSON.parse(await turn(request)).receipt;
        saved = committed;
        assertEquals(committed.analyst, { operatorScope: "owner" });
        assertEquals(saved?.taskId, undefined);
        assertEquals(saved?.targetId, request.targetId);
        assertEquals(saved?.evidenceRevision, state.revision);
        assertEquals(saved?.evidenceId, request.evidenceId);
        assertEquals(saved?.summary, request.summary);
        assert(classified);
        await waitForCondition(() => seen.has(committed.id), () => {});
      },
      policy,
      (frame) => frames.push(frame),
    );
    assert(saved);
    assert(deniedDelivery > 0);
    assert(frames.every((frame) => !frame.includes(request.title)));
    const receiptId = saved.id;
    const followupRequest = {
      ...ref,
      action: "assign",
      runId,
      adaptiveRevision: adaptiveRevision(state),
      taskKind: "trace",
      node: "app",
      receiptId,
      note: "Review the original retained analyst finding.",
      requestId: crypto.randomUUID(),
    };
    let followup: {
      taskId: string;
      findingFollowup:
        import("../../src/sentinel/adaptive_store.ts").AdaptiveFindingFollowup;
    };
    const archiveId = crypto.randomUUID();
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(JSON.parse(await turn(request)).receipt, saved);
      assertStringIncludes(
        await turn({ ...request, title: "Other claim" }),
        "unavailable",
      );
      assertEquals(reviews, 2);
      assertEquals(
        JSON.parse(await turn({ ...ref, receiptId, action: "finding_receipt" }))
          .record,
        saved,
      );
      assertEquals(
        JSON.parse(await turn({ ...ref, action: "pause" })).run.status,
        "paused",
      );
      const beforeScope = reviews;
      for (
        const invalid of [
          { ...followupRequest, revision: state.revision + 1 },
          { ...followupRequest, node: "other" },
        ]
      ) {
        assertStringIncludes(await turn(invalid), "unavailable");
      }
      assertEquals(reviews, beforeScope);
      const response = await turn(followupRequest);
      assert(response.startsWith("{"), response);
      followup = JSON.parse(response).receipt;
      const source = followup.findingFollowup;
      assertEquals(source.sourceTaskId, undefined);
      assertEquals(
        source.sourceAnalystSha256,
        createHash("sha256").update(JSON.stringify({ operatorScope: "owner" }))
          .digest("hex"),
      );
      assertEquals(source.findingId, receiptId);
      assertEquals(source.evidenceId, request.evidenceId);
      assertEquals(source.sourceRevision, state.revision);
      assertEquals(source.snapshotDigest, saved?.snapshotDigest);
      assertEquals(source.reportVersion, 1);
      assertEquals(reviews, beforeScope + 1);
      assertEquals(
        JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
        "stopped",
      );
      const archived = await turn({
        ...ref,
        runId,
        action: "archive",
        requestId: archiveId,
      });
      assert(archived.startsWith("{"), archived);
      assertEquals(JSON.parse(archived).receipt.status, "succeeded");
    });
    assert(followup!);
    coordinator.stop();
    planner.stop();
    await Deno.rename(dirname(path), join(baseDir, "before-analyst-restore"));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      assertEquals(
        JSON.parse(await turn({ ...ref, receiptId, action: "finding_receipt" }))
          .record,
        saved,
      );
      const beforeReplay = reviews;
      assertEquals(JSON.parse(await turn(followupRequest)).receipt, followup);
      assertEquals(reviews, beforeReplay);
      assertEquals(
        JSON.parse(await turn({ ...ref, action: "resume" })).run.status,
        "running",
      );
    });
    const adaptive = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const restoredLease = (() => {
      try {
        const leased = adaptive.claimModelReview(
          followupRequest.adaptiveRevision,
          MODEL_ASSIGNMENT_REASON,
          ({ id }) => id === followup.taskId,
        );
        assert(leased);
        assertEquals(leased.task.prerequisites, []);
        assertEquals(
          leased.task.plannerRound?.findingFollowup,
          followup.findingFollowup,
        );
        return {
          assessmentRevision: state.revision,
          assignedTaskId: leased.task.id,
          assignedTaskLeaseToken: leased.token,
        };
      } finally {
        adaptive.close();
      }
    })();
    const exactFinding = tool(findings, { receiptId });
    const worker = await workerTurn(path, restoredLease, [[exactFinding]]);
    assertEquals(JSON.parse(worker.results[0][0]).record, saved);
    assertEquals(worker.receiptHooks, ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]);
    await withTidepool(baseDir, async (list) => {
      assertEquals(await list(state.revision, caseId), [saved!]);
    });
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: state.revision,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      expectedVersion: 1,
      constraints: {
        allowedAssetIds: ["app"],
        deniedKinds: ["review_finding"],
      },
    }));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertStringIncludes(
        await turn({
          ...ref,
          receiptId,
          action: "finding_receipt",
        }),
        "unavailable",
      );
      assertStringIncludes(await turn(followupRequest), "unavailable");
    });
    const revoked = await workerTurn(path, restoredLease, [[exactFinding]]);
    assertStringIncludes(revoked.results[0][0], "unavailable");
    await withTidepool(baseDir, async (list) => {
      assertEquals(await list(state.revision, caseId), []);
    });
  } finally {
    coordinator?.stop();
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyReviewedMixedSourceAssignment(
  mode: "worker" | "analyst" | "planner",
) {
  const analyst = mode === "analyst";
  const plannerOrigin = mode === "planner";
  const baseDir = await Deno.makeTempDir();
  const caseId = "mixed-source-review";
  const path = resolveSentinelCasePath(baseDir, caseId);
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    const now = Date.now();
    const relationship = { from: "app", to: "other", relation: "depends_on" };
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Assigned application" },
          { id: "other", kind: "asset", label: "Different application" },
          {
            id: "gap",
            kind: "finding",
            label: "Control gap",
            severity: "high",
          },
          { id: "control", kind: "control", label: "Review control" },
          {
            id: "check",
            kind: "evidence",
            label: "Saved failed control check",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(now - 60_000).toISOString(),
              validUntil: new Date(now + 3_600_000).toISOString(),
            },
          },
        ],
        edges: [
          relationship,
          { from: "check", to: "app", relation: "observed_on" },
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: "check", to: "control", relation: "verifies" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const ref = { kind: "sentinel", id: caseId, revision: state.revision };
    const graphWorker = assignedLease(path, state, "review_evidence");
    const findingWorker = analyst
      ? undefined
      : assignedLease(path, state, "impact");
    const graphResult = await workerTurn(path, graphWorker, [
      [tool(assigned)],
      [tool("sentinel_publish_graph_fact", {
        ...relationship,
        requestId: crypto.randomUUID(),
      })],
    ]);
    const parsedFact = JSON.parse(graphResult.results[1][0]);
    assert(parsedFact.id);
    const findingInput = {
      controlId: "control",
      evidenceId: "check",
      title: "Retained failed control check",
      summary: "The verified local check failed.",
      requestId: crypto.randomUUID(),
    };
    let finding: SentinelWorkerFindingRecord;
    if (findingWorker) {
      const findingResult = await workerTurn(path, findingWorker, [
        [tool(assigned)],
        [tool(report, { ...findingInput, graphFindingId: "gap" })],
      ]);
      finding = JSON.parse(findingResult.results[1][0]).record;
    } else {
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(true),
        async (turn) => {
          const response = JSON.parse(
            await turn({
              ...ref,
              ...findingInput,
              action: "record_analyst_finding",
              runId,
              findingId: "gap",
              targetId: "app",
            }),
          );
          const receipt: SentinelWorkerFindingRecord = response.receipt;
          assert(receipt && "analyst" in receipt);
          assertEquals(receipt.analyst, { operatorScope: "owner" });
          assertEquals(receipt.taskId, undefined);
          finding = receipt;
        },
      );
    }
    assert(finding!);
    assert(finding.id);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      for (
        const lease of findingWorker
          ? [graphWorker, findingWorker]
          : [graphWorker]
      ) {
        assert(store.finishModelReview(
          revision,
          lease.assignedTaskId,
          lease.assignedTaskLeaseToken,
          { note: "Committed the exact scoped observation.", steps: [] },
        ));
      }
    } finally {
      store.close();
    }
    const batch = {
      ...ref,
      action: "assign_batch",
      runId,
      adaptiveRevision: revision,
      requestId: crypto.randomUUID(),
      assignments: [{
        taskKind: "trace",
        node: "app",
        sourceIds: [parsedFact.id, finding.id],
      }],
    };
    const archiveId = crypto.randomUUID();
    let reviews = 0;
    let revoke = false;
    let allowed = true;
    let denyAnalystSource = false;
    let reviewed: {
      receipts: {
        taskId: string;
        sourceEvidence: {
          id: string;
          taskId?: string;
          analyst?: unknown;
          evidenceRevision: number;
          digest: string;
          sourceStepIndex?: number;
        }[];
      }[];
    };
    const confirm = () => {
      reviews++;
      if (revoke) allowed = false;
      return Promise.resolve(true);
    };
    if (plannerOrigin) {
      const model = createProviderRegistry();
      let blockFinding = true;
      let proposals = 0;
      let plannerReads: string[] = [];
      const reviewSources = [parsedFact.id, finding.id];
      const requested = [
        tool("sentinel_graph_facts", { id: parsedFact.id }),
        tool(findings, { receiptId: finding.id }),
      ];
      model.register({
        name: "mixed-source-admission-planner",
        supportsStreaming: false,
        complete(messages) {
          const reads = messages.filter(({ role }) => role === "tool");
          const usage = { inputTokens: 1, outputTokens: 1 };
          if (!reads.length) {
            return Promise.resolve({
              content: "",
              usage,
              toolCalls: requested.map(({ name, args }, index) => ({
                type: "function",
                id: `mixed-plan-source-${index}`,
                function: { name, arguments: JSON.stringify(args) },
              })),
            });
          }
          plannerReads = reads.map(({ content }) => String(content));
          proposals++;
          return Promise.resolve({
            content: JSON.stringify({
              prioritize: [],
              assignments: [{
                kind: "trace",
                depth: 1,
                nodeId: "app",
                sourceEvidenceIds: reviewSources,
              }],
            }),
            usage,
            toolCalls: [],
          });
        },
      });
      model.setDefault("mixed-source-admission-planner");
      let clock = Date.now();
      const planned = () =>
        readAdaptiveSentinel(path, state, "revision")?.tasks
          .find(({ plannerRound }) =>
            plannerRound && "sourceEvidence" in plannerRound &&
            plannerRound.sourceEvidence?.length === 2
          );
      const admission = createSentinelModelPlanner(
        path,
        (current, taskId) =>
          taskId
            ? { execute: () => Promise.resolve(), clear() {} }
            : createSentinelSubagent({
              snapshotPath: path,
              assessmentRevision: current.revision,
              plannerExecutionEvidenceRunId: current.plan.runId,
              sharedInventoryBaseDir: baseDir,
              providerRegistry: model,
              allowModelAccess: true,
              hookRunner: {
                evaluateHook(hook, { input }) {
                  const name = input.tool_name ??
                    (input.tool_call as { name?: string } | undefined)?.name;
                  const permitted =
                    !(blockFinding && hook === "PRE_TOOL_CALL" &&
                      name === findings);
                  return Promise.resolve({
                    allowed: permitted,
                    action: permitted ? "ALLOW" : "BLOCK",
                    duration: 0,
                    ruleId: null,
                  });
                },
              },
            }),
        () => planned() ? undefined : () => {},
        () => clock,
      );
      try {
        admission.advance(state);
        await waitForCondition(
          () => proposals === 1 && !admission.hasInFlightWork(),
          () => {},
        );
        assertEquals(JSON.parse(plannerReads[0]).id, parsedFact.id);
        assertStringIncludes(plannerReads[1], "policy");
        assertEquals(planned(), undefined);
        blockFinding = false;
        clock += 65_000;
        addSentinelCaseHint(
          path,
          "Review both exact retained sources together.",
        );
        await waitForCondition(
          () => !!planned() && !admission.hasInFlightWork(),
          () => admission.advance(state),
        );
        assertEquals(JSON.parse(plannerReads[1]).record, finding);
        const accepted = planned()!;
        assert(
          accepted.plannerRound && "sourceEvidence" in accepted.plannerRound,
        );
        assert(accepted.plannerRound.sourceEvidence);
        assertEquals(accepted.nodeId, "app");
        reviewed = {
          receipts: [{
            taskId: accepted.id,
            sourceEvidence: [...accepted.plannerRound.sourceEvidence],
          }],
        };
      } finally {
        admission.stop();
      }
    } else {await withFindingAssignmentGateway(
        baseDir,
        confirm,
        async (turn) => {
          assertEquals(
            JSON.parse(await turn({ ...ref, action: "pause" })).run.status,
            "paused",
          );
          const beforeReview = reviews;
          for (
            const invalid of [
              { ...batch, revision: state.revision + 1 },
              {
                ...batch,
                assignments: [{ ...batch.assignments[0], node: "other" }],
              },
              {
                ...batch,
                assignments: [{
                  ...batch.assignments[0],
                  sourceIds: [parsedFact.id, parsedFact.id],
                }],
              },
            ]
          ) {
            assertStringIncludes(await turn(invalid), "unavailable");
          }
          assertEquals(reviews, beforeReview);
          const before = readAdaptiveSentinel(path, state)?.tasks;
          if (analyst) {
            denyAnalystSource = true;
            assertStringIncludes(await turn(batch), "unavailable");
            denyAnalystSource = false;
            assertEquals(reviews, beforeReview);
            assertEquals(readAdaptiveSentinel(path, state)?.tasks, before);
          }
          revoke = true;
          assertStringIncludes(await turn(batch), "unavailable");
          assertEquals(reviews, beforeReview + 1);
          assertEquals(readAdaptiveSentinel(path, state)?.tasks, before);
          revoke = false;
          allowed = true;
          reviewed = JSON.parse(await turn(batch)).receipt;
        },
        (hook, input) => {
          const action =
            (input.tool_call as { args?: { action?: string } } | undefined)
              ?.args?.action;
          return hook !== "PRE_TOOL_CALL" ||
            (allowed || action !== "assign_batch") &&
              (!denyAnalystSource || action !== "finding_receipt");
        },
      );}
    assert(reviewed!);
    const sources = reviewed.receipts[0].sourceEvidence;
    assertEquals(
      sources.map(({ id }) => id),
      plannerOrigin
        ? [parsedFact.id, finding.id].sort()
        : [parsedFact.id, finding.id],
    );
    const factSource = sources.find(({ id }) => id === parsedFact.id);
    const findingSource = sources.find(({ id }) => id === finding.id);
    assert(factSource && findingSource);
    assertEquals(factSource.taskId, graphWorker.assignedTaskId);
    assertEquals(findingSource.taskId, findingWorker?.assignedTaskId);
    if (analyst) {
      assertEquals(findingSource.analyst, { operatorScope: "owner" });
    }
    assertEquals(sources.map(({ evidenceRevision }) => evidenceRevision), [
      state.revision,
      state.revision,
    ]);
    assertEquals(factSource.digest, parsedFact.resultSha256);
    assertEquals(factSource.sourceStepIndex, parsedFact.sourceStepIndex);
    assert(/^[a-f0-9]{64}$/.test(findingSource.digest));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      const beforeReplay = reviews;
      if (!plannerOrigin) {
        assertEquals(JSON.parse(await turn(batch)).receipt, reviewed);
        assertStringIncludes(
          await turn({
            ...batch,
            assignments: [{
              ...batch.assignments[0],
              sourceIds: [...batch.assignments[0].sourceIds].reverse(),
            }],
          }),
          "unavailable",
        );
      }
      assertEquals(reviews, beforeReplay);
      assertEquals(
        JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
        "stopped",
      );
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
    });
    await Deno.rename(dirname(path), join(baseDir, "pre-mixed-source-restore"));
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      assert(readSentinelAssessment(path)?.paused);
      const beforeReplay = reviews;
      if (plannerOrigin) {
        const restored = readSentinelAssessment(path);
        assert(restored);
        const task = readAdaptiveSentinel(path, restored, "revision")?.tasks
          .find(({ id }) => id === reviewed.receipts[0].taskId);
        assert(task?.plannerRound && "sourceEvidence" in task.plannerRound);
        assertEquals<unknown>(task.plannerRound.sourceEvidence, sources);
      } else {
        assertEquals(JSON.parse(await turn(batch)).receipt, reviewed);
      }
      assertEquals(reviews, beforeReplay);
      assertEquals(
        JSON.parse(await turn({ ...ref, action: "resume" })).run.status,
        "running",
      );
    });
    let projected: unknown;
    let readResults: string[] = [];
    const receipt = reviewed.receipts[0];
    const providers = createProviderRegistry();
    providers.register({
      name: "mixed-source-review",
      supportsStreaming: false,
      complete(messages) {
        const results = messages.filter(({ role }) => role === "tool");
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (results.length) {
          readResults = results.map(({ content }) => String(content));
          return Promise.resolve({
            content:
              '{"summary":"Reviewed both scoped sources.","followUps":[]}',
            usage,
            toolCalls: [],
          });
        }
        const prompt = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        const payload = JSON.parse(prompt.split("\n").at(-1)!);
        projected = payload.sourceEvidence;
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [
            tool("sentinel_graph_facts", { id: parsedFact.id }),
            tool(findings, { receiptId: finding.id }),
          ].map(({ name, args }, index) => ({
            id: `mixed-source-${index}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        });
      },
    });
    providers.setDefault("mixed-source-review");
    const current = readSentinelAssessment(path);
    assert(current);
    const sourceHooks: string[] = [];
    planner = createSentinelModelPlanner(
      path,
      (_state, id, lease) =>
        id === receipt.taskId
          ? createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: state.revision,
            assignedTaskId: id,
            assignedTaskLeaseToken: lease,
            providerRegistry: providers,
            allowModelAccess: true,
            hookRunner: {
              evaluateHook(hook, { input }) {
                const name = input.tool_name ??
                  (input.tool_call as { name?: string } | undefined)?.name;
                if (name === findings || name === "sentinel_graph_facts") {
                  sourceHooks.push(`${hook}:${name}`);
                }
                return Promise.resolve({
                  allowed: true,
                  action: "ALLOW",
                  duration: 0,
                  ruleId: null,
                });
              },
            },
          })
          : { execute: () => Promise.resolve(), clear() {} },
    );
    planner.advance(current);
    const completed = () =>
      readAdaptiveSentinel(path, current)?.modelReviews
        .find(({ taskId }) => taskId === receipt.taskId);
    await waitForCondition(
      () => completed() !== undefined,
      () => planner!.advance(current),
    );
    assertEquals(projected, receipt.sourceEvidence);
    assertEquals(readResults.length, 2);
    assertEquals(JSON.parse(readResults[0]), parsedFact);
    assertEquals(JSON.parse(readResults[1]).record, finding);
    assertEquals(completed()?.summary, "Reviewed both scoped sources.");
    assertEquals(completed()?.steps.map(({ tool }) => tool), [
      "sentinel_graph_facts",
      findings,
    ]);
    for (const name of ["sentinel_graph_facts", findings]) {
      assert(sourceHooks.includes(`PRE_TOOL_CALL:${name}`));
      assert(sourceHooks.includes(`POST_TOOL_RESPONSE:${name}`));
    }
    const node = `task:adaptive:${receipt.taskId}`;
    const exactNode = { ...ref, action: "node", node };
    const scopedAssets = analyst ? ["app", "other"] : ["app"];
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertStringIncludes(await turn(exactNode), parsedFact.id);
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            action: "narrow_constraints",
            runId,
            requestId: crypto.randomUUID(),
            expectedVersion: 0,
            allowedAssetIds: scopedAssets,
            deniedKinds: analyst ? ["review_finding"] : [],
          }),
        ).record.constraints.allowedAssetIds,
        scopedAssets,
      );
      assertStringIncludes(await turn(batch), "unavailable");
      const scopedNode = await turn(exactNode);
      const page = JSON.parse(scopedNode).page;
      assertEquals(page.node.id, node);
      assert(!scopedNode.includes(parsedFact.id));
      assert(!scopedNode.includes(finding.id));
    });
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Reviewed mixed-source assignment retains exact graph and finding lineage across gateway restore", () =>
  verifyReviewedMixedSourceAssignment("worker"));

Deno.test("Reviewed mixed-source assignment preserves analyst actor and scoped evidence through gateway restore", () =>
  verifyReviewedMixedSourceAssignment("analyst"));

Deno.test("Planner mixed-source assignment requires both exact approved reads and resumes after gateway restore", () =>
  verifyReviewedMixedSourceAssignment("planner"));

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

    await withTidepool(baseDir, async (list, provenance, request) => {
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
      const remediation = {
        status: "pass",
        asOfRevision: second.revision,
        recheckId: verified.id,
        evidenceRevision: second.revision,
        evidenceId: verified.evidenceId,
        observedAt: verified.observedAt,
        validUntil: verified.validUntil,
      };
      const exports = await request("export", {
        caseId: "main",
        revision: second.revision,
        format: "findings-json",
        findingIds: [original.id],
      });
      assertEquals(
        JSON.parse(String(exports.content)).findings[0].remediation,
        remediation,
      );
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(false),
        async (turn) => {
          const scope = {
            action: "finding_report",
            kind: "sentinel",
            id: "main",
            receiptId: original.id,
          };
          assertEquals(
            JSON.parse(await turn({ ...scope, revision: first.revision }))
              .report.remediation,
            {
              status: "unknown",
              asOfRevision: first.revision,
            },
          );
          const report =
            JSON.parse(await turn({ ...scope, revision: second.revision }))
              .report;
          assertEquals(report.remediation, remediation);
          assertEquals(report.disposition, undefined);
        },
      );
      const reviewedDownload = {
        format: "findings-json",
        revision: second.revision,
        findingFilter: {},
        findingPageSize: 1,
      };
      const reviewedPage = await request("export", reviewedDownload);
      assertEquals(reviewedPage.type, "export");
      const oldFindingCursor =
        (reviewedPage.findingPage as { nextCursor?: string }).nextCursor;
      assert(oldFindingCursor);
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
      assertEquals(await list(first.revision), []);
      assertEquals(await list(second.revision), []);
      assertEquals(await list(), []);
      const hiddenProvenance = JSON.parse(String(
        (await request("export", {
          format: "provenance",
          revision: second.revision,
        })).content,
      ));
      assertEquals(hiddenProvenance.workerFindings, undefined);
      assert(
        !hiddenProvenance.provenance.nodes.some(
          ({ sourceId }: { sourceId: string }) => sourceId === check!.id,
        ),
      );
      const hiddenMarkdown = await request("export", {
        format: "markdown",
        revision: second.revision,
      });
      assertEquals(hiddenMarkdown.type, "export");
      assert(!String(hiddenMarkdown.content).includes(original.title));
      for (const format of ["findings-json", "markdown", "md-zip"]) {
        const deniedDownload = await request("export", {
          format,
          revision: second.revision,
          findingIds: ["review-gap", original.id],
        });
        assertEquals(deniedDownload.type, "error");
        assertEquals(deniedDownload.content, undefined);
      }
      const stalePage = await request("export", {
        ...reviewedDownload,
        findingCursor: oldFindingCursor,
      });
      assertEquals(stalePage.type, "error");
      assertEquals(stalePage.content, undefined);
      const filtered = await request("export", {
        ...reviewedDownload,
        findingFilter: { kind: "worker" },
      });
      assertEquals(filtered.type, "export");
      assertEquals(JSON.parse(String(filtered.content)).findings, []);
      assertEquals((filtered.findingPage as { total: number }).total, 0);
      assert(recordSentinelOperatingConstraints(path, {
        runId: second.plan.runId!,
        evidenceRevision: second.revision,
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { deniedKinds: [], allowedAssetIds: ["dependent-asset"] },
      }));
      const hiddenImported = await request("export", {
        format: "findings-json",
        revision: second.revision,
        findingIds: ["review-gap"],
      });
      assertEquals(hiddenImported.type, "error");
      assertEquals(hiddenImported.content, undefined);
      const matchingRun = readSentinelAssessment(path);
      assert(matchingRun?.plan.runId);
      const priorPolicyVersion = readSentinelOperatingConstraints(
        path,
        matchingRun.plan.runId,
      )?.version;
      assert(priorPolicyVersion);
      assert(recordSentinelOperatingConstraints(path, {
        runId: matchingRun.plan.runId,
        evidenceRevision: matchingRun.revision,
        expectedVersion: priorPolicyVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { deniedKinds: [] },
      }));
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
      const completeRequest = {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
        findingFilter: {},
      };
      const complete = await request("export", completeRequest);
      assertEquals(complete.type, "export");
      assertEquals(complete.findingPage, undefined);
      const completeIds: string[] = JSON.parse(String(complete.content))
        .findings
        .map(({ id }: { id: string }) => id);
      assertEquals(completeIds.length, 17);
      assertEquals(new Set(completeIds).size, 17);
      const explicit = await request("export", {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
        findingIds: completeIds,
      });
      assertEquals(explicit.content, complete.content);
      for (const format of ["csv", "markdown"]) {
        const output = await request("export", { ...completeRequest, format });
        assertEquals(output.type, "export");
        assertEquals(output.findingPage, undefined);
        const visible = String(output.content).replace(
          /&#(\d+);/g,
          (_entity, code) => String.fromCodePoint(Number(code)),
        );
        for (const id of completeIds) assertStringIncludes(visible, id);
      }
      const zip = await request("export", {
        ...completeRequest,
        format: "md-zip",
      });
      assertEquals(zip.type, "export");
      assertEquals(zip.findingPage, undefined);
      const bytes = Buffer.from(String(zip.content), "base64");
      const centralEnd = bytes.length - 22;
      assertEquals(bytes.readUInt32LE(centralEnd), 0x06054b50);
      assertEquals(bytes.readUInt16LE(centralEnd + 10), 17);
      const pageRequest = {
        ...filterExport,
        caseId: "other",
        revision: other.revision,
        findingFilter: {},
        findingPageSize: 8,
      };
      const exportPage = (frame: Record<string, unknown>) => {
        assertEquals(frame.type, "export");
        const metadata = frame.findingPage as {
          manifestDigest: string;
          count: number;
          offset: number;
          total: number;
          nextCursor: string | null;
        };
        const ids = JSON.parse(String(frame.content)).findings.map((
          { id }: { id: string },
        ) => id);
        return { ...metadata, ids };
      };
      const firstPage = exportPage(await request("export", pageRequest));
      assertEquals(firstPage.total, 17);
      assertEquals(firstPage.count, 8);
      assertEquals(firstPage.offset, 0);
      assert(firstPage.nextCursor);
      await withTidepool(baseDir, async (_list, _provenance, reconnected) => {
        const secondPage = exportPage(
          await reconnected("export", {
            ...pageRequest,
            findingCursor: firstPage.nextCursor,
          }),
        );
        assert(secondPage.nextCursor);
        assertEquals(secondPage.manifestDigest, firstPage.manifestDigest);
        assertEquals(secondPage.offset, 8);
        assertEquals(secondPage.count, 8);
        const lastPage = exportPage(
          await reconnected("export", {
            ...pageRequest,
            findingCursor: secondPage.nextCursor,
          }),
        );
        assertEquals(lastPage.offset, 16);
        assertEquals(lastPage.manifestDigest, firstPage.manifestDigest);
        assertEquals(lastPage.nextCursor, null);
        const allIds = [...firstPage.ids, ...secondPage.ids, ...lastPage.ids];
        assertEquals(allIds, completeIds);
        assertEquals(new Set(allIds).size, 17);
        assertEquals(
          [...allIds].sort(),
          [
            "review-gap",
            ...Array.from(
              { length: 16 },
              (_, index) => `other-finding-${index}`,
            ),
          ].sort(),
        );
      });
      const zipPageRequest = { ...pageRequest, format: "md-zip" };
      const zipPage = await request("export", zipPageRequest);
      assertEquals(zipPage.type, "export");
      const zipCursor =
        (zipPage.findingPage as { nextCursor: string }).nextCursor;
      const zipContinuation = await request("export", {
        ...zipPageRequest,
        findingCursor: zipCursor,
      });
      assertEquals(
        zipContinuation.filename,
        `sentinel-findings-r${other.revision}-offset-8.zip`,
      );
      const zipPayload = Buffer.from(String(zipContinuation.content), "base64");
      const firstNameSize = zipPayload.readUInt16LE(26);
      assertEquals(
        zipPayload.toString("utf8", 30, 30 + firstNameSize),
        "finding-09.md",
      );
      const wrongPage = await request("export", {
        ...pageRequest,
        caseId: "main",
        revision: secondRevision,
        findingCursor: firstPage.nextCursor,
      });
      assertEquals(wrongPage.type, "error");
      assertEquals(wrongPage.content, undefined);
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
      const stalePage = await request("export", {
        ...pageRequest,
        findingCursor: firstPage.nextCursor,
      });
      assertEquals(stalePage.type, "error");
      assertEquals(stalePage.content, undefined);
      const revisedFirstPage = exportPage(await request("export", pageRequest));
      assert(revisedFirstPage.manifestDigest !== firstPage.manifestDigest);
      assertEquals(revisedFirstPage.total, 17);
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
      const mixedRequest = {
        ...filterExport,
        findingIds: [finding!.id, "review-gap"],
        findingPageSize: 1,
      };
      const mixedPage = exportPage(await request("export", mixedRequest));
      assert(mixedPage.nextCursor);
      assertEquals(mixedPage.ids, [finding!.id]);
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
      const staleMixed = await request("export", {
        ...mixedRequest,
        findingCursor: mixedPage.nextCursor,
      });
      assertEquals(staleMixed.type, "error");
      assertEquals(staleMixed.content, undefined);
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

Deno.test("Sentinel recheck history preserves the original run's revocation after replacement", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  try {
    const snapshot = {
      version: 1,
      nodes: [{ id: "app", kind: "asset", label: "Reviewed asset" }],
      edges: [],
    };
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const first = startSentinelAssessment(path);
    const runId = first.plan.runId;
    assert(runId);
    const journal = openSentinelWorkerFindingStore(path);
    const { finding, recheck } = (() => {
      try {
        const observedAt = new Date(Date.now() - 2_000).toISOString();
        const evidence = {
          caseId: "main",
          runId,
          evidenceRevision: first.revision,
          taskId: "initial-review",
          targetId: "app",
          graphFindingId: "check-gap",
          controlId: "check-control",
          evidenceId: "initial-evidence",
          snapshotDigest: digestSentinelSnapshot(
            first.result!.sharedGraph.snapshot!,
          ),
          observedAt,
          evaluatedAt: observedAt,
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        };
        const finding = journal.recordFinding({
          ...evidence,
          requestId: crypto.randomUUID(),
          title: "Recorded control gap",
          summary: "Retained evidence showed a gap.",
        });
        assert(finding);
        const checkedAt = new Date(Date.now() - 1_000).toISOString();
        const recheck = journal.recordRecheck({
          ...evidence,
          requestId: crypto.randomUUID(),
          evidenceId: "recheck-evidence",
          observedAt: checkedAt,
          evaluatedAt: checkedAt,
          taskId: "recheck-review",
          findingId: finding.id,
          outcome: "pass",
          summary: "Control passed the later review.",
        });
        assert(recheck);
        return { finding, recheck };
      } finally {
        journal.close();
      }
    })();
    const selector = {
      action: "finding_recheck_attempts",
      kind: "sentinel",
      id: "main",
      revision: first.revision,
      receiptId: finding.id,
    };
    const read = (allowed: boolean) =>
      withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(false),
        async (turn) => {
          const result = await turn(selector);
          if (!allowed) {
            assertStringIncludes(result, "unavailable");
            assert(!result.includes(recheck.id));
            return;
          }
          assertEquals(JSON.parse(result).page, {
            runId,
            findingId: finding.id,
            evidenceRevision: first.revision,
            entries: [{
              taskId: recheck.taskId,
              status: "result_recorded",
              evidenceId: recheck.evidenceId,
              attempts: null,
              resultReceiptId: recheck.id,
              outcome: "pass",
            }],
            nextCursor: null,
          });
        },
      );
    await read(true);
    snapshot.nodes.push({
      id: "other-asset",
      kind: "asset",
      label: "Other asset",
    });
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const narrowed = refreshSentinelAssessment(path);
    assert(narrowed && narrowed.revision > first.revision);
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: narrowed.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "recheck-history-fixture",
      constraints: { allowedAssetIds: ["other-asset"], deniedKinds: [] },
    }));
    await read(false);
    assert(stopSentinelAssessment(path));
    const replacement = startSentinelAssessment(path);
    assert(replacement.plan.runId !== runId);
    await read(false);
  } finally {
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
  caseId?: string;
  inconclusive?: boolean;
  noResult?: boolean;
  stopAfterResult?: boolean;
  goalSettlement?: boolean;
  alternate?: { nodeId: string; resultSha256: string };
  state: State;
  findingId: string;
  evidenceId: string;
  digest: string;
  trace?: { taskId: string; result: unknown; index?: number };
}) {
  const caseId = options.caseId ?? "main";
  const path = resolveSentinelCasePath(options.baseDir, caseId);
  const amend = async (version: number, title: string) =>
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        const result = await turn({
          action: "amend_finding_report",
          kind: "sentinel",
          id: caseId,
          revision: options.state.revision,
          receiptId: options.findingId,
          reportVersion: version,
          evidenceVersion: sentinelFindingTrafficEvidenceVersion(
            path,
            options.state.revision,
            options.findingId,
          ).digest,
          requestId: crypto.randomUUID(),
          title,
          severity: version === 1 ? "high" : "low",
          findingCategory: version === 1 ? "Control coverage" : "Access policy",
          disposition: version === 1 ? "confirmed" : "dismissed",
          summary: "Reviewed finding evidence from the original control.",
        });
        assertEquals(JSON.parse(result).amendment.version, version + 1);
      },
    );
  let blocked = false;
  let blockOutput = false;
  let revokeOnConfirm = false;
  let changeReportOnConfirm = false;
  let modelResult: string | undefined;
  let showRemediation = false;
  let correlation: string | undefined;
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
              id: caseId,
              revision: options.state.revision,
              ...(showRemediation
                ? { action: "finding_report", receiptId: options.findingId }
                : options.trace
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
      readLiveWorkflow: nativeWorkflowReader(undefined, caseId),
      async confirm(text) {
        confirmations.push(text);
        if (revokeOnConfirm) blocked = true;
        if (changeReportOnConfirm) await amend(1, "Reviewed report title");
        return true;
      },
    }),
  });
  const run = async (command: string) => {
    const events: ChatEvent[] = [];
    await gateway.executeAgentTurn(command, (event) => events.push(event));
    const last = events.at(-1);
    assert(last?.type === "response", JSON.stringify(events));
    correlation = last.sentinelRecheckCommand;
    return last.text;
  };
  const command =
    `/sentinel-recheck ${caseId} ${options.state.revision} ${options.findingId}`;
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
  const recordPolicy = (
    expectedVersion: number,
    deniedKinds: ["impact"] | [],
  ) => {
    const record = recordSentinelOperatingConstraints(path, {
      runId: options.state.plan.runId!,
      evidenceRevision: options.state.revision,
      expectedVersion,
      requestId: crypto.randomUUID(),
      operatorScope: "owner",
      constraints: { deniedKinds, note: "Private operator policy note" },
    });
    assert(record);
    return {
      digest: record.digest,
      deniedKinds,
      assetInScope: true,
    };
  };
  const reviewedConstraints = options.alternate
    ? recordPolicy(0, ["impact"])
    : null;
  let currentConstraints = reviewedConstraints;
  const discovered = JSON.parse(await run(command));
  assertEquals(
    [...discovered.candidates].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    [{
      nodeId: options.evidenceId,
      resultSha256: options.digest,
    }, ...(options.alternate ? [options.alternate] : [])]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  );
  assertEquals(discovered.runId, options.state.plan.runId);
  const requestId = crypto.randomUUID();
  const recheckNote =
    "Review the retained control result and cite the latest workflow receipt.";
  const queue =
    `${command} queue ${options.evidenceId} ${discovered.runId} ${discovered.adaptiveRevision} ${requestId} ${recheckNote}`;
  const credentialShape = `Bearer ${"z".repeat(30)}`;
  const rejected = await run(queue.replace(recheckNote, credentialShape));
  assertStringIncludes(rejected, "unavailable");
  assert(!String(correlation).includes(credentialShape));
  assertEquals(confirmations.length, 0);
  revokeOnConfirm = true;
  assertStringIncludes(await run(queue), "unavailable");
  assertEquals(confirmations.length, 1);
  assertStringIncludes(confirmations[0], options.digest);
  assertStringIncludes(confirmations[0], recheckNote);
  blocked = false;
  revokeOnConfirm = false;
  if (options.alternate) {
    changeReportOnConfirm = true;
    assertStringIncludes(await run(queue), "unavailable");
    changeReportOnConfirm = false;
  }
  const assigned = JSON.parse(await run(queue)).receipt;
  assertEquals(
    assigned.recheckBaseline.reportVersion,
    options.alternate ? 2 : 1,
  );
  assertEquals(assigned.recheckFindingId, options.findingId);
  assertEquals(assigned.recheckNote, recheckNote);
  assertEquals(assigned.nodeId, options.evidenceId);
  assertEquals(JSON.parse(await run(queue)).receipt, assigned);
  assertStringIncludes(
    await run(queue.replace(recheckNote, "Changed note.")),
    "unavailable",
  );
  assertEquals(confirmations.length, options.alternate ? 3 : 2);

  const alternateQueue = options.alternate &&
    `${command} queue ${options.alternate.nodeId} ${discovered.runId} ${discovered.adaptiveRevision} ${crypto.randomUUID()}`;
  if (alternateQueue) {
    assertStringIncludes(await run(alternateQueue), "unavailable");
    assertEquals(JSON.parse(await run(queue)).receipt, assigned);
  }

  let permitConnector = true;
  let metadataChecks = 0;
  let writes = 0;
  let originalReceipt: string | undefined;
  let recoveredReceipt: string | undefined;
  const reader = nativeWorkflowReader(() => {
    metadataChecks++;
    return permitConnector;
  }, caseId);
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "native-recheck" as ChannelId,
    bumpersEnabled: false,
  });
  const recover = buildWorkflowRecoveryExecutor(
    { agent_recovery: { sentinel_assignment_cases: [caseId] } },
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
    id: caseId,
    revision: options.state.revision,
    runId: discovered.runId,
    adaptiveRevision: discovered.adaptiveRevision,
    requestId: crypto.randomUUID(),
    taskKind: "review_evidence",
    node: options.evidenceId,
    recheckFindingId: options.findingId,
    note: recheckNote,
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

  let currentAttachmentDigest = assigned.recheckBaseline.evidenceVersion;
  if (options.alternate) {
    await amend(2, "Updated after recheck admission");
    assertEquals(JSON.parse(await run(queue)).receipt, assigned);
    currentConstraints = recordPolicy(1, []);
    const journal = openSentinelFindingTrafficLinks(path);
    try {
      // Seed a retained receipt without requiring any target connection.
      assert(journal.record({
        caseId,
        evidenceRevision: options.state.revision,
        assetId: "app",
        findingId: options.findingId,
        reportVersion: 3,
        trafficId: `har:evidence:${"2".repeat(64)}`,
        trafficSource: "har",
        trafficDigest: "3".repeat(64),
        authority: { kind: "operator" },
        requestId: crypto.randomUUID(),
      }, () => true));
    } finally {
      journal.close();
    }
    currentAttachmentDigest = sentinelFindingTrafficEvidenceVersion(
      path,
      options.state.revision,
      options.findingId,
    ).digest;
    assert(
      currentAttachmentDigest !== assigned.recheckBaseline.evidenceVersion,
    );
  }
  const readLifecycle = async () => {
    let lifecycle: {
      queuedAt: string;
      attempt?: number;
      startedAt?: string;
      finishedAt?: string;
      note: string;
      baseline: {
        reportVersion: number;
        evidenceVersion: string;
        constraintsDigest: string | null;
      };
    } | undefined;
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const page = JSON.parse(
          await turn({
            action: "finding_recheck_attempts",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            receiptId: options.findingId,
            includeLifecycle: true,
            limit: 3,
          }),
        ).page;
        lifecycle = page.entries.find(({ taskId }: { taskId: string }) =>
          taskId === assigned.taskId
        )?.lifecycle;
      },
    );
    assert(lifecycle);
    return lifecycle;
  };
  const queuedLifecycle = await readLifecycle();
  assertEquals(queuedLifecycle, {
    queuedAt: queuedLifecycle.queuedAt,
    note: recheckNote,
    baseline: assigned.recheckBaseline,
  });
  assert(Number.isFinite(Date.parse(queuedLifecycle.queuedAt)));
  let startedAt: string | undefined;
  await withFindingAssignmentGateway(
    options.baseDir,
    () => Promise.resolve(false),
    async (turn) => {
      const selector = {
        action: "finding_recheck_attempts",
        kind: "sentinel",
        id: caseId,
        revision: options.state.revision,
      };
      const queued = JSON.parse(
        await turn({ ...selector, activeOnly: true, limit: 1 }),
      ).page;
      assertEquals(queued.entries, [{
        findingId: options.findingId,
        taskId: assigned.taskId,
        status: "queued",
        attempts: 0,
        evidenceId: options.evidenceId,
      }]);
      assertEquals(queued.nextCursor, null);
      assertStringIncludes(await turn(selector), "unavailable");
      assertStringIncludes(
        await turn({ ...selector, activeOnly: true, revision: 0 }),
        "unavailable",
      );
    },
  );
  let verified: { id: string } | undefined;
  let goalWorker: ReturnType<typeof assignedLease> | undefined;
  const reportGoal = async (id: string) => {
    assert(goalWorker);
    const result = await workerTurn(path, goalWorker, [
      [tool(findings, { receiptId: id })],
      [tool("sentinel_prove_goal", {
        goalId: "controls",
        criterionId: "remediated",
        source: "finding_recheck",
        evidenceId: id,
      })],
    ]);
    assertEquals(JSON.parse(result.results[0][0]).record.id, id);
    return result.results[1][0];
  };
  const otherId = "recheck-inventory-empty";
  let otherRevision: number | undefined;
  if (options.goalSettlement) {
    const otherPath = resolveSentinelCasePath(options.baseDir, otherId);
    await Deno.mkdir(dirname(otherPath), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      otherPath,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "second", kind: "asset", label: "Second asset" }],
        edges: [],
      }),
      { mode: 0o600 },
    );
    otherRevision = startSentinelAssessment(otherPath).revision;
  }
  const assertActiveCatalog = async (
    status: string | null,
    verifyDenial = false,
  ) => {
    assert(otherRevision);
    const read = {
      action: "active_finding_rechecks",
      scopes: [
        { id: caseId, revision: options.state.revision },
        { id: otherId, revision: otherRevision },
      ],
      limit: 1,
    };
    let blockedSource = false;
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const output = await turn(read);
        assert(!output.startsWith("Error:"), output);
        const groups = JSON.parse(output).groups;
        assertEquals(groups.map(({ run }: { run: { id: string } }) => run.id), [
          caseId,
          otherId,
        ]);
        assertEquals(groups[1].entries, []);
        assertEquals(
          groups[0].entries.map((
            { taskId, status }: { taskId: string; status: string },
          ) => ({ taskId, status })),
          status ? [{ taskId: assigned.taskId, status }] : [],
        );
        if (verifyDenial) {
          blockedSource = true;
          assertStringIncludes(await turn(read), "unavailable");
          blockedSource = false;
          assertStringIncludes(
            await turn({
              ...read,
              scopes: [read.scopes[0], {
                ...read.scopes[1],
                revision: otherRevision! + 1,
              }],
            }),
            "unavailable",
          );
        }
      },
      (hook, input) => {
        const args =
          (input.tool_call as { args?: Record<string, unknown> } | undefined)
            ?.args;
        return !(blockedSource && hook === "PRE_TOOL_CALL" &&
          args?.action === "finding_recheck_attempts" && args.id === otherId);
      },
    );
  };
  if (options.goalSettlement) await assertActiveCatalog("queued", true);
  const queued = () => readAdaptiveSentinel(path, options.state)?.tasks ?? [];
  const recheckGate = () =>
    queued().find(({ plannerRound }) =>
      plannerRound?.passingRecheckForFindingId === options.findingId
    );
  const recheckDependent = () => {
    const gate = recheckGate();
    return gate &&
      queued().find(({ prerequisites }) => prerequisites.includes(gate.id));
  };
  if (options.goalSettlement) {
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        const gate = JSON.parse(
          await turn({
            action: "assign",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            runId: discovered.runId,
            adaptiveRevision: discovered.adaptiveRevision,
            requestId: crypto.randomUUID(),
            taskKind: "trace",
            node: "app",
            passingRecheckForFindingId: options.findingId,
          }),
        ).receipt;
        assertEquals(recheckGate()?.id, gate.taskId);
        const store = openSentinelAdaptiveStore(
          join(dirname(path), "sentinel-adaptive.db"),
        );
        try {
          const added = store.applyModelPlan(
            discovered.adaptiveRevision,
            null,
            [{
              kind: "impact",
              nodeId: "dependent-recheck-asset",
              reason: "Review the connection after remediation.",
              prerequisites: [gate.taskId],
            }],
            {},
          );
          assertEquals(added, 1);
        } finally {
          store.close();
        }
      },
    );
  }
  const rationale =
    "The retained control evidence did not resolve the operator’s requested comparison.";
  const rationaleRequest = crypto.randomUUID();
  let workerRuns = 0;
  const workerStopped = Promise.withResolvers<void>();
  let workflows: ReturnType<typeof createOperatorWorkflowRuns> | undefined;
  const workflowRunIds: string[] = [];
  let workflowProofAuthorized = false;
  let workflowAccessChecks = 0;
  const checkedWorkflowAccess = Promise.withResolvers<void>();
  async function startEvidenceWaits(receiptId: string) {
    const proof = {
      case: caseId,
      run_id: discovered.runId,
      revision: options.state.revision,
    };
    const plans = [
      { ...proof, finding_recheck_id: receiptId },
      { ...proof, finding_id: options.findingId },
    ].map((satisfiedBy, index) => ({
      id: "remediation-wait-" + index,
      classification: "INTERNAL" as const,
      steps: [{ id: "verify", satisfiedBy, evidenceWaitSeconds: 8 }, {
        id: "dependent",
      }],
    }));
    const checked = Promise.withResolvers<void>();
    const probed = new Set<string>();
    const verify = createWorkflowObservationVerifier(
      options.baseDir,
      undefined,
      Date.now,
      nativeWorkflowReader(() => {
        workflowAccessChecks++;
        if (!workflowProofAuthorized) checkedWorkflowAccess.resolve();
        return workflowProofAuthorized;
      }, caseId),
    );
    workflows = createOperatorWorkflowRuns(
      createWorkflowRunRegistry(),
      plans,
      join(options.baseDir, "workflow-recheck-gate.db"),
      async (requirement) => {
        const result = await verify(requirement);
        probed.add("finding_id" in requirement ? "finding" : "recheck");
        if (probed.size === 2) checked.resolve();
        return result;
      },
    );
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        for (const plan of plans) {
          const started = JSON.parse(
            await turn({
              action: "start",
              kind: "workflow",
              id: plan.id,
              requestId: crypto.randomUUID(),
            }),
          );
          workflowRunIds.push(started.run.ref.id);
        }
        await checked.promise;
        assertEquals(workflowAccessChecks, 0);
        for (const id of workflowRunIds) {
          assertEquals(
            workflows?.inspect(id)?.steps.map(({ status }) => status),
            ["pending", "pending"],
          );
        }
      },
      undefined,
      undefined,
      workflows,
    );
  }
  let plannerClock = Date.now();
  const plannerReceipts: string[][] = [];
  const wakes: string[] = [];
  const planner = createSentinelModelPlanner(
    path,
    (state, taskId, leaseToken) => ({
      async execute(message, send, signal, onStep, digests, checkpoint) {
        if (taskId !== assigned.taskId) {
          if (options.goalSettlement && taskId === undefined) {
            const input = JSON.parse(String(message).split("\n").at(-1)!);
            plannerReceipts.push(
              (input.findingRechecks ?? []).map(({ id }: { id: string }) => id),
            );
          }
          send({
            type: "response",
            text:
              '{"assignments":[],"summary":"Review complete","followUps":[]}',
            taint: "INTERNAL",
          });
          return;
        }
        assert(taskId && leaseToken);
        workerRuns++;
        if (options.goalSettlement) await assertActiveCatalog("running");
        const activeLifecycle = await readLifecycle();
        startedAt = activeLifecycle.startedAt;
        assert(startedAt);
        assert(Date.parse(startedAt) >= Date.parse(queuedLifecycle.queuedAt));
        assertEquals(activeLifecycle, {
          ...queuedLifecycle,
          attempt: 1,
          startedAt,
        });
        if (alternateQueue) {
          assertStringIncludes(await run(alternateQueue), "unavailable");
        }
        const input = JSON.parse(String(message).split("\n").at(-1)!);
        assertEquals(input.assignment, assigned.taskId);
        assertEquals(input.recheckFindingId, options.findingId);
        assertEquals(input.recheckNote, recheckNote);
        assertEquals(input.target, options.evidenceId);
        const verifiedClaim = {
          findingId: options.findingId,
          evidenceId: options.evidenceId,
          requestId: crypto.randomUUID(),
          summary: "Confirmed the approved retained workflow recheck.",
        };
        const reviewed = await workerTurn(
          path,
          {
            assessmentRevision: state.revision,
            assignedTaskId: taskId,
            assignedTaskLeaseToken: leaseToken,
          },
          [
            [tool("sentinel_assigned_execution_evidence", {
              node: options.evidenceId,
            })],
            [tool(context, { findingId: options.findingId })],
            ...(options.noResult ? [] : [
              options.inconclusive
                ? [tool(INCONCLUSIVE_RECHECK_TOOL, {
                  findingId: options.findingId,
                  evidenceId: options.evidenceId,
                  requestId: rationaleRequest,
                  rationale,
                })]
                : [tool(recheck, verifiedClaim)],
            ]),
          ],
          undefined,
          options.baseDir,
          reader,
          {
            prompt: message,
            options: [signal, onStep, digests, checkpoint],
          },
        );
        assertEquals(
          JSON.parse(reviewed.results[0][0]).evidence.resultSha256,
          options.digest,
        );
        assertEquals(
          JSON.parse(reviewed.results[1][0]).current.evidenceId,
          options.evidenceId,
        );
        assertEquals(
          JSON.parse(reviewed.results[1][0]).recheckNote,
          recheckNote,
        );
        const reviewedBaseline = JSON.parse(reviewed.results[1][0]);
        assertEquals(reviewedBaseline.attachmentReview, {
          approvedDigest: assigned.recheckBaseline.evidenceVersion,
          currentDigest: currentAttachmentDigest,
          status: options.alternate ? "changed" : "unchanged",
        });
        assertEquals(reviewedBaseline.reviewedConstraints, reviewedConstraints);
        assertEquals(reviewedBaseline.currentConstraints, currentConstraints);
        assert(
          !reviewed.results[1][0].includes("Private operator policy note"),
        );
        assertEquals(
          reviewedBaseline.recheckBaseline,
          assigned.recheckBaseline,
        );
        assertEquals(
          reviewedBaseline.reportVersion,
          assigned.recheckBaseline.reportVersion,
        );
        if (options.alternate) {
          assertEquals(
            reviewedBaseline.reviewedReport,
            {
              title: "Reviewed report title",
              summary: "Reviewed finding evidence from the original control.",
              severity: "high",
              findingCategory: "Control coverage",
              disposition: "confirmed",
            },
          );
        }
        if (options.noResult) {
          assert(reviewed.events.some(({ type }) => type === "response"));
          assertEquals(reviewed.reportPre, 0);
          assertEquals(reviewed.reportPost, 0);
          for (const event of reviewed.events) send(event);
          return;
        }
        assertEquals(reviewed.reportPre, 1);
        assertEquals(reviewed.reportPost, 1);
        const record = JSON.parse(reviewed.results[2][0]).record;
        assertEquals(record.findingId, options.findingId);
        assertEquals(record.taskId, taskId);
        assertEquals(record.evidenceRevision, state.revision);
        if (options.inconclusive) {
          assertEquals(record.kind, "inconclusive_recheck");
          assertEquals(record.rationale, rationale);
          assertEquals(record.outcome, undefined);
        } else {
          assertEquals(record.outcome, "pass");
          const repeated = await workerTurn(
            path,
            {
              assessmentRevision: state.revision,
              assignedTaskId: taskId,
              assignedTaskLeaseToken: leaseToken,
            },
            [
              [tool("sentinel_assigned_execution_evidence", {
                node: options.evidenceId,
              })],
              [
                tool(recheck, verifiedClaim),
                tool(recheck, {
                  ...verifiedClaim,
                  requestId: crypto.randomUUID(),
                }),
                tool(recheck, {
                  ...verifiedClaim,
                  requestId: crypto.randomUUID(),
                  summary: "An alternate conclusion for the same assignment.",
                }),
              ],
            ],
            undefined,
            options.baseDir,
            reader,
          );
          assertEquals(repeated.reportPre, 3);
          assertEquals(JSON.parse(repeated.results[1][0]).record, record);
          assertEquals(JSON.parse(repeated.results[1][1]).record, record);
          assertStringIncludes(repeated.results[1][2], "Error:");
        }
        if (options.goalSettlement) {
          assert(!wakes.includes(record.id));
          assert(!plannerReceipts.some((ids) => ids.includes(record.id)));
          advanceAdaptiveSentinel(path, state);
          assertEquals(recheckGate()?.status, "queued");
          assertEquals(recheckGate()?.attempts, 0);
          assertEquals(recheckDependent()?.status, "queued");
          await startEvidenceWaits(record.id);
          goalWorker = assignedLease(path, state, "impact");
          assertStringIncludes(await reportGoal(record.id), "Error:");
          assertEquals(
            readSentinelGoalCompletionAtRevision(path, state.revision)?.status,
            "open",
          );
        }
        verified = record;
        if (options.stopAfterResult) {
          try {
            showRemediation = true;
            await run(
              "Review remediation while the verified result is staged.",
            );
            assertEquals(JSON.parse(modelResult ?? "").report.remediation, {
              status: "unknown",
              asOfRevision: options.state.revision,
            });
            await withFindingAssignmentGateway(
              options.baseDir,
              () => Promise.resolve(true),
              async (turn) => {
                const stopped = JSON.parse(
                  await turn({
                    action: "stop",
                    kind: "sentinel",
                    id: caseId,
                    revision: options.state.revision,
                    runId: options.state.plan.runId,
                    adaptiveRevision: discovered.adaptiveRevision,
                    taskId,
                    requestId: crypto.randomUUID(),
                  }),
                ).receipt;
                assert(stopped);
              },
            );
            workerStopped.resolve();
          } catch (error) {
            workerStopped.reject(error);
          }
        }
        if (options.goalSettlement) plannerClock += 60_001;
        for (const event of reviewed.events) send(event);
      },
      clear() {},
    }),
    undefined,
    () => plannerClock,
  );
  const unsubscribe = options.goalSettlement
    ? subscribeCommittedEvidence(caseId, (address) => {
      if (
        address.run_id === options.state.plan.runId &&
        address.revision === options.state.revision
      ) {
        wakes.push(address.observation_id);
      }
    })
    : undefined;
  const coordinator = options.goalSettlement
    ? startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive(current) {
        advanceAdaptiveSentinel(path, current);
        planner.advance(current);
      },
    })
    : undefined;
  try {
    for (let i = 0; i < 200; i++) {
      planner.advance(options.state);
      const completion = readAdaptiveSentinel(path, options.state)
        ?.modelReviewStates
        .find(({ taskId }) => taskId === assigned.taskId);
      if (
        completion?.status ===
          (options.noResult
            ? "retry_pending"
            : options.stopAfterResult
            ? "stopped"
            : "completed")
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (options.stopAfterResult) await workerStopped.promise;
    assert(
      options.noResult || verified,
      JSON.stringify(
        readAdaptiveSentinel(path, options.state)?.modelReviewStates,
      ),
    );
    if (options.goalSettlement) await assertActiveCatalog(null);
    assertEquals(workerRuns, 1);
    if (options.goalSettlement) {
      assert(verified);
      advanceAdaptiveSentinel(path, options.state);
      if (options.stopAfterResult) {
        assert(!wakes.includes(verified.id));
        assert(!plannerReceipts.some((ids) => ids.includes(verified!.id)));
        assertEquals(recheckGate()?.status, "queued");
        assertEquals(recheckDependent()?.status, "queued");
      } else {
        await waitForCondition(
          () => plannerReceipts.some((ids) => ids.includes(verified!.id)),
          () => {},
        );
        assertEquals(wakes.filter((id) => id === verified!.id), [verified.id]);
        assertEquals(wakes.filter((id) => id === options.findingId), [
          options.findingId,
        ]);
        assertEquals(recheckGate()?.status, "completed");
        assertEquals(recheckGate()?.attempts, 0);
        assertEquals(
          recheckGate()?.factSatisfaction?.findingRecheckId,
          verified.id,
        );
        assertEquals(recheckDependent()?.status, "completed");
      }
      if (options.stopAfterResult) {
        assertEquals(workflowAccessChecks, 0);
        for (const id of workflowRunIds) {
          assertEquals(
            workflows?.inspect(id)?.steps.map(({ status }) => status),
            ["pending", "pending"],
          );
        }
      } else {
        await checkedWorkflowAccess.promise;
        for (const id of workflowRunIds) {
          assertEquals(
            workflows?.inspect(id)?.steps.map(({ status }) => status),
            ["pending", "pending"],
          );
        }
        workflowProofAuthorized = true;
        await waitForCondition(
          () =>
            workflowRunIds.every((id) =>
              workflows?.inspect(id)?.status === "completed"
            ),
          () => {},
          4_500,
        );
        await withFindingAssignmentGateway(
          options.baseDir,
          () => Promise.resolve(false),
          async (turn) => {
            for (const id of workflowRunIds) {
              const events = JSON.parse(
                await turn({ action: "traces", kind: "workflow", id }),
              ).page.events;
              assertEquals(
                events.filter(({ event }: { event: string }) =>
                  event === "step_satisfied"
                ).map((
                  { evidence }: { evidence: { findingRecheckId: string } },
                ) => evidence.findingRecheckId),
                [verified!.id],
              );
            }
          },
          undefined,
          undefined,
          workflows,
        );
      }
      const proof = await reportGoal(verified.id);
      if (options.stopAfterResult) {
        assertStringIncludes(proof, "Error:");
        assertEquals(
          readSentinelGoalCompletionAtRevision(path, options.state.revision)
            ?.status,
          "open",
        );
      } else {
        assertEquals(JSON.parse(proof).status, "awaiting_confirmation");
        assertEquals(
          readSentinelGoalCompletionAtRevision(path, options.state.revision)
            ?.status,
          "awaiting_confirmation",
        );
      }
    }
    showRemediation = true;
    await run("Review the saved remediation status.");
    assertEquals(
      JSON.parse(modelResult ?? "").report.remediation.status,
      options.inconclusive || options.noResult || options.stopAfterResult
        ? "unknown"
        : "pass",
    );
    assertEquals(
      JSON.parse(modelResult ?? "").report.remediation.recheckId,
      options.inconclusive || options.stopAfterResult
        ? undefined
        : verified?.id,
    );
    blocked = true;
    await run(
      "Review the saved remediation status after the source policy changed.",
    );
    assertEquals(JSON.parse(modelResult ?? "").report.remediation, {
      status: "unknown",
      asOfRevision: options.state.revision,
    });
    blocked = false;

    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const attempts = JSON.parse(
          await turn({
            action: "finding_recheck_attempts",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            receiptId: options.findingId,
          }),
        ).page;
        assertEquals(
          attempts.entries.filter(
            ({ taskId }: { taskId: string }) => taskId === assigned.taskId,
          ).length,
          1,
        );
        const settled = attempts.entries.find((
          { taskId }: { taskId: string },
        ) => taskId === assigned.taskId);
        assertEquals(
          settled?.resultReceiptId,
          options.inconclusive ? undefined : verified?.id,
        );
        assertEquals(
          settled?.inconclusiveReceiptId,
          options.inconclusive ? verified?.id : undefined,
        );
        if (options.noResult) {
          assertEquals(settled?.lastAttempt?.outcome, "failed");
          assertEquals(settled?.lastAttempt?.reason, "missing_recheck_result");
          assertEquals(settled?.status, "retry_pending");
        } else {
          assertEquals(
            settled?.status,
            options.stopAfterResult ? "stopped" : "completed",
          );
        }
        assertEquals(
          settled?.outcome,
          options.inconclusive || options.noResult || options.stopAfterResult
            ? undefined
            : "pass",
        );
      },
    );
  } finally {
    for (const id of workflowRunIds) workflows?.cancel(id);
    coordinator?.stop();
    unsubscribe?.();
    planner.stop();
  }

  const finishedLifecycle = await readLifecycle();
  assert(startedAt && finishedLifecycle.finishedAt);
  assert(Date.parse(finishedLifecycle.finishedAt) >= Date.parse(startedAt));
  assertEquals(finishedLifecycle, {
    ...queuedLifecycle,
    attempt: 1,
    startedAt,
    finishedAt: finishedLifecycle.finishedAt,
  });

  if (alternateQueue) {
    const admitted = JSON.parse(await run(alternateQueue)).receipt;
    assertEquals(admitted.nodeId, options.alternate?.nodeId);
    assertEquals(admitted.recheckFindingId, options.findingId);
    assert(admitted.taskId !== assigned.taskId);
  }

  assert(stopSentinelAssessment(path));
  const archiveId = crypto.randomUUID();
  const reference = {
    kind: "sentinel",
    id: caseId,
    revision: options.state.revision,
    runId: options.state.plan.runId,
  };
  await withFindingAssignmentGateway(
    options.baseDir,
    () => Promise.resolve(true),
    async (turn) => {
      const receipt = JSON.parse(
        await turn({ ...reference, action: "archive", requestId: archiveId }),
      ).receipt;
      assertEquals(receipt.status, "succeeded");
    },
  );
  await Deno.rename(
    dirname(path),
    join(options.baseDir, "pre-remediation-restore"),
  );
  await withFindingAssignmentGateway(
    options.baseDir,
    () => Promise.resolve(true),
    async (turn) => {
      const receipt = JSON.parse(
        await turn({
          ...reference,
          action: "restore",
          archiveId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt;
      assertEquals(receipt.status, "succeeded");
    },
  );
  assertEquals(readSentinelAssessment(path)?.paused, true);
  assertEquals(await readLifecycle(), finishedLifecycle);
  assertEquals(
    sentinelFindingTrafficEvidenceVersion(
      path,
      options.state.revision,
      options.findingId,
    ).digest,
    currentAttachmentDigest,
  );
  if (reviewedConstraints) {
    const reviewed = readSentinelOperatingConstraintDigest(
      path,
      options.state.plan.runId!,
      options.state.revision,
      reviewedConstraints.digest,
    );
    assertEquals(
      reviewed?.constraints.deniedKinds,
      reviewedConstraints.deniedKinds,
    );
  }
  await run("Review the exact archived remediation status.");
  assertEquals(
    JSON.parse(modelResult ?? "").report.remediation.recheckId,
    options.inconclusive || options.stopAfterResult ? undefined : verified?.id,
  );
  assertEquals(
    JSON.parse(modelResult ?? "").report.remediation.status,
    options.inconclusive || options.noResult || options.stopAfterResult
      ? "unknown"
      : "pass",
  );
  if (options.stopAfterResult) {
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const page = JSON.parse(
          await turn({
            action: "finding_recheck_attempts",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            receiptId: options.findingId,
          }),
        ).page;
        const stopped = page.entries.find(({ taskId }: { taskId: string }) =>
          taskId === assigned.taskId
        );
        assertEquals(stopped?.status, "stopped");
        assertEquals(stopped?.resultReceiptId, verified?.id);
        assertEquals(stopped?.outcome, undefined);
      },
    );
  }
  if (options.noResult) {
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const attempts = JSON.parse(
          await turn({
            action: "finding_recheck_attempts",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            receiptId: options.findingId,
          }),
        ).page;
        const attempt = attempts.entries.find((entry: { taskId: string }) =>
          entry.taskId === assigned.taskId
        );
        assertEquals(attempt.lastAttempt.outcome, "failed");
        assertEquals(attempt.lastAttempt.reason, "missing_recheck_result");
        assertEquals(attempt.outcome, undefined);
        assertEquals(attempt.resultReceiptId, undefined);
      },
    );
  }
  if (options.inconclusive) {
    await withFindingAssignmentGateway(
      options.baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const query = {
          action: "finding_receipt",
          kind: "sentinel",
          id: caseId,
          revision: options.state.revision,
          receiptId: verified?.id,
        };
        const record = JSON.parse(await turn(query)).record;
        assertEquals(record.id, verified?.id);
        assertEquals(record.rationale, rationale);
        assertEquals(record.outcome, undefined);
        const trace = JSON.parse(
          await turn({
            action: "worker_trace_result",
            kind: "sentinel",
            id: caseId,
            revision: options.state.revision,
            taskId: assigned.taskId,
            stepIndices: [2],
          }),
        );
        assertEquals(trace.result.record, record);

        assertStringIncludes(
          await turn({ ...query, id: "main" }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({ ...query, revision: options.state.revision - 1 }),
          "unavailable",
        );
      },
    );
  }
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
    const turn = async (request: Record<string, unknown>): Promise<string> => {
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
    assert(consumerState?.active && consumerState.plan.runId);
    const membership = resolveSentinelCaseMembership(
      consumerState.result?.sharedGraph.snapshot,
      {
        caseId: consumerCase,
        evidenceRevision: consumerState.revision,
        selector: { kind: "assets", assetIds: ["app"] },
      },
    );
    assert(membership);
    const policy = recordSentinelOperatingConstraints(consumerPath, {
      runId: consumerState.plan.runId,
      evidenceRevision: consumerState.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "fixture-connector-owner",
      constraints: { allowedAssetIds: membership.assetIds, deniedKinds: [] },
      membership,
    });
    assert(policy);
    const consumer = assignedLease(consumerPath, consumerState, "impact");
    const selectedExecution: NonNullable<Parameters<typeof workerTurn>[6]> = {
      prompt: "Review the exact selected source.",
      options: [undefined, undefined, undefined, {
        operatingConstraints: {
          version: policy.version,
          digest: policy.digest,
        },
      }],
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

    const linked = {
      id: consumerCase,
      revision: consumerState.revision,
      action: "linked_finding",
      linkedFinding: exactSelected.args,
    };
    const catalog = {
      id: consumerCase,
      revision: consumerState.revision,
      action: "linked_findings",
      assetId: "app",
      sourceCase: "main",
    };
    const pageRead = await turn(catalog);
    const [catalogEntry] = JSON.parse(pageRead).entries;
    assertEquals(catalogEntry.source, publication.finding.workerFindingSource);
    assert(!pageRead.includes("owner/repo") && !pageRead.includes(credential));
    assertEquals(
      JSON.parse(
        await turn({ ...linked, linkedFinding: catalogEntry.selector }),
      ).source,
      catalogEntry.source,
    );
    const ownerRead = await turn(linked);
    assert(!ownerRead.startsWith("Error:"), ownerRead);
    const ownerFinding = JSON.parse(ownerRead);
    assertEquals(ownerFinding.source, publication.finding.workerFindingSource);
    assertEquals(ownerFinding.detail.finding.id, finding.id);
    assert(
      !ownerRead.includes("owner/repo") && !ownerRead.includes(credential),
    );
    for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
      blockSource = hook;
      const before = checks;
      assertStringIncludes(await turn(linked), "unavailable");
      assertEquals(checks === before, hook === "PRE_TOOL_CALL");
      const beforeList = checks;
      assertEquals(JSON.parse(await turn(catalog)).entries, []);
      assertEquals(checks === beforeList, hook === "PRE_TOOL_CALL");
    }
    blockSource = undefined;

    if (attempt) {
      const stalePolicy = await workerTurn(
        consumerPath,
        consumer,
        [[listSelected]],
        undefined,
        baseDir,
        readLiveWorkflow,
        {
          ...selectedExecution,
          options: [undefined, undefined, undefined, {
            operatingConstraints: {
              version: policy.version,
              digest: "0".repeat(64),
            },
          }],
        },
      );
      assertEquals(
        stalePolicy.results[0][0],
        "Tool response withheld by policy.",
      );
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
      let coverageResult: unknown;
      const linkedCoverage = tool("sentinel_case_inventory", {
        view: "coverage",
        assetId: "app",
        coverageGap: "missing_evidence",
        linkedFinding: exactSelected.args,
      });
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
            const page = JSON.parse(prior);
            assertEquals(page.assets, []);
            assertEquals(
              page.peerCoverage.source,
              publication.finding.workerFindingSource,
            );
            coverageResult = page;
            assert(
              !prior.includes(credential) && !prior.includes("owner/repo"),
            );
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
            toolCalls: (call === exactSelected
              ? [exactSelected, linkedCoverage]
              : call
              ? [call]
              : []).map((selected) => ({
                id: crypto.randomUUID(),
                type: "function" as const,
                function: {
                  name: selected.name,
                  arguments: JSON.stringify(selected.args),
                },
              })),
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
        const round = readAdaptiveSentinel(
          consumerPath,
          consumerState,
          "revision",
        )
          ?.modelPlannerHistory.find(({ reads }) =>
            reads?.some(({ tool }) => tool === "sentinel_case_inventory")
          );
        assert(round);
        const ordinal = (round.reads?.findIndex(({ tool }) =>
          tool === "sentinel_case_inventory"
        ) ?? -1) + 1;
        assert(ordinal > 0);
        const history = {
          id: consumerCase,
          revision: consumerState.revision,
          action: "planner_reads",
          plannerIdentity: round.identity,
          attempt: round.attempt,
          ordinal,
          includeResult: true,
        };
        assertEquals(JSON.parse(await turn(history)).result, coverageResult);
        for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"] as const) {
          blockSource = hook;
          const before = checks;
          assertStringIncludes(await turn(history), "unavailable");
          assertEquals(checks === before, hook === "PRE_TOOL_CALL");
        }
        blockSource = undefined;
        access = false;
        assertStringIncludes(await turn(history), "unavailable");
      } finally {
        planner.stop();
      }
    }

    access = false;
    assertStringIncludes(await turn(linked), "unavailable");
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
      const retainedSource = {
        caseId: consumerCase,
        sourceCase: "main",
        asset: "app",
        snapshotDigest: entry.snapshotDigest,
        finding: finding.id,
      };
      const retained = await request("shared_finding_source", retainedSource);
      assertEquals(retained.type, "sentinel_source_snapshot");
      assertEquals(retained.scopeRestricted, true);
      assertEquals(retained.published, false);
      const graph = retained.graph as {
        nodes: readonly { id: string; workerFindingSource?: unknown }[];
        edges: readonly unknown[];
      };
      assertEquals(
        graph.nodes.map(({ id }) => id).sort(),
        ["app", finding.id].sort(),
      );
      assertEquals(graph.edges, [{
        from: finding.id,
        to: "app",
        relation: "affects",
      }]);
      const saved = graph.nodes.find(({ id }) => id === finding.id);
      assertEquals(
        saved?.workerFindingSource,
        publication.finding.workerFindingSource,
      );
      assert(!JSON.stringify(retained).includes(credential));
      const blocked = await request("shared_finding_source", {
        ...retainedSource,
        asset: "outside",
      });
      assertEquals(blocked.type, "error");
      assertEquals(blocked.graph, undefined);
      assert(recordSentinelOperatingConstraints(consumerPath, {
        runId: consumerState.plan.runId!,
        evidenceRevision: consumerState.revision,
        expectedVersion: policy.version,
        requestId: crypto.randomUUID(),
        operatorScope: "fixture-connector-owner",
        constraints: { allowedAssetIds: [], deniedKinds: [] },
      }));
      const revoked = await request("shared_finding_source", retainedSource);
      assertEquals(revoked.type, "error");
      assertEquals(revoked.graph, undefined);
    });
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

async function verifyConnectorMixedAssignment(
  baseDir: string,
  caseId: string,
  path: string,
  state: State,
  finding: SentinelWorkerFindingRecord,
) {
  const runId = state.plan.runId!;
  const graphLease = assignedLease(path, state, "trace");
  const graph = await workerTurn(path, graphLease, [
    [tool(assigned)],
    [tool("sentinel_publish_graph_fact", {
      from: "gap",
      to: "app",
      relation: "affects",
      requestId: crypto.randomUUID(),
    })],
  ]);
  const fact = JSON.parse(graph.results[1][0]);
  assert(fact.id);
  const revision = adaptiveRevision(state);
  const ref = { kind: "sentinel", id: caseId, revision: state.revision };
  const assign = {
    ...ref,
    action: "assign_batch",
    runId,
    adaptiveRevision: revision,
    requestId: crypto.randomUUID(),
    assignments: [{
      taskKind: "trace",
      node: "app",
      sourceIds: [fact.id, finding.id],
    }],
  };
  const credential = "synthetic-mixed-assignment-credential";
  const credentials = createMemorySecretStore();
  assert((await credentials.setSecret("github-pat", credential)).ok);
  let credentialsRequested = 0;
  let metadataChecks = 0;
  let resultFetches = 0;
  const reader = createSentinelLiveWorkflowReader({
    scopes: [{
      case: caseId,
      asset: "app",
      owner: "owner",
      repo: "repo",
      workflow_id: 22,
    }],
    resolveToken: async () => {
      credentialsRequested++;
      const saved = await credentials.getSecret("github-pat");
      return saved.ok ? saved.value : undefined;
    },
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    verifyAccess: (_target, { token }) => {
      metadataChecks++;
      assertEquals(token, credential);
      return Promise.resolve(true);
    },
    readRuns: () => {
      resultFetches++;
      throw new Error(
        "A mixed assignment must reuse the approved retained result",
      );
    },
  });
  let blockHook: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
  let reviews = 0;
  let denyReceiptOutput = false;
  let blockedOutputs = 0;
  const frames: string[] = [];
  const sourceHooks: string[] = [];
  const policy = (hook: string, input: Record<string, unknown>) => {
    if (
      denyReceiptOutput && hook === "PRE_OUTPUT" &&
      String(input.content).includes(finding.id)
    ) {
      blockedOutputs++;
      return false;
    }
    const name = input.tool_name ??
      (input.tool_call as { name?: string } | undefined)?.name;
    if (name !== "sentinel_live_workflow_status") return true;
    sourceHooks.push(hook);
    return hook !== blockHook;
  };
  const gateway = (body: Parameters<typeof withFindingAssignmentGateway>[2]) =>
    withFindingAssignmentGateway(
      baseDir,
      () => {
        reviews++;
        return Promise.resolve(true);
      },
      body,
      policy,
      (frame) => frames.push(frame),
      undefined,
      reader,
      true,
    );
  let saved: {
    receipts: {
      taskId: string;
      sourceEvidence: { id: string; executionEvidenceId?: string }[];
    }[];
  } | undefined;
  const archiveId = crypto.randomUUID();
  await gateway(async (turn) => {
    assertEquals(
      JSON.parse(await turn({ ...ref, action: "pause" })).run.status,
      "paused",
    );
    const beforeReview = reviews;
    blockHook = "PRE_TOOL_CALL";
    assertStringIncludes(await turn(assign), "unavailable");
    assertEquals(credentialsRequested, 0);
    assertEquals(metadataChecks, 0);
    blockHook = "POST_TOOL_RESPONSE";
    assertStringIncludes(await turn(assign), "unavailable");
    assert(metadataChecks > 0);
    assertEquals(reviews, beforeReview);
    blockHook = undefined;
    saved = JSON.parse(await turn(assign)).receipt;
    assert(saved);
    assertEquals(saved.receipts[0].sourceEvidence.map(({ id }) => id), [
      fact.id,
      finding.id,
    ]);
    assertEquals(
      saved.receipts[0].sourceEvidence[1].executionEvidenceId,
      finding.evidenceId,
    );
    assertEquals(reviews, beforeReview + 1);
    const checksBeforeRevoke = metadataChecks;
    assert((await credentials.deleteSecret("github-pat")).ok);
    assertStringIncludes(await turn(assign), "unavailable");
    assertEquals(metadataChecks, checksBeforeRevoke);
    assertEquals(reviews, beforeReview + 1);
    assert((await credentials.setSecret("github-pat", credential)).ok);
    assertEquals(JSON.parse(await turn(assign)).receipt, saved);
    assertEquals(
      JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
      "stopped",
    );
    assertEquals(
      JSON.parse(
        await turn({ ...ref, runId, action: "archive", requestId: archiveId }),
      ).receipt.status,
      "succeeded",
    );
  });
  assert(saved);
  const receipt = saved.receipts[0];
  await Deno.rename(
    dirname(path),
    join(baseDir, "before-connector-assignment-restore"),
  );
  await gateway(async (turn) => {
    assertEquals(
      JSON.parse(
        await turn({
          ...ref,
          runId,
          action: "restore",
          archiveId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt.status,
      "succeeded",
    );
    const beforeReplay = reviews;
    assertEquals(JSON.parse(await turn(assign)).receipt, saved);
    assertEquals(reviews, beforeReplay);
    frames.length = 0;
    denyReceiptOutput = true;
    try {
      await assertRejects(() => turn(assign), Error);
    } finally {
      denyReceiptOutput = false;
    }
    assert(blockedOutputs > 0);
    assertEquals(reviews, beforeReplay);
    assert(!frames.join("").includes(finding.id));
    assertEquals(
      JSON.parse(await turn({ ...ref, action: "resume" })).run.status,
      "running",
    );
  });
  const current = readSentinelAssessment(path);
  assert(current);
  const providers = createProviderRegistry();
  let calls = 0;
  let prompt: Record<string, unknown> | undefined;
  let responses: string[] = [];
  providers.register({
    name: "connector-mixed-assignment",
    supportsStreaming: false,
    complete(messages) {
      calls++;
      const results = messages.filter(({ role }) => role === "tool");
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (results.length) {
        responses = results.map(({ content }) => String(content));
        return Promise.resolve({
          content:
            '{"summary":"Verified both retained sources.","followUps":[]}',
          usage,
          toolCalls: [],
        });
      }
      const text = String(
        messages.findLast(({ role }) => role === "user")?.content,
      );
      prompt = JSON.parse(text.split("\n").at(-1)!);
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [
          tool("sentinel_graph_facts", { id: fact.id }),
          tool(findings, { receiptId: finding.id }),
        ].map(({ name, args }, index) => ({
          type: "function",
          id: `mixed-connector-source-${index}`,
          function: { name, arguments: JSON.stringify(args) },
        })),
      });
    },
  });
  providers.setDefault("connector-mixed-assignment");
  let wokeOnProtectedReview = false;
  let workerClock = Date.now();
  const planner = createSentinelModelPlanner(
    path,
    (_state, taskId, lease) =>
      taskId === receipt.taskId
        ? createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          assignedTaskId: taskId,
          assignedTaskLeaseToken: lease,
          providerRegistry: providers,
          allowModelAccess: true,
          sharedInventoryBaseDir: baseDir,
          readRetainedWorkflow: reader,
          hookRunner: {
            evaluateHook(hook, { input }) {
              return Promise.resolve({
                allowed: policy(hook, input),
                action: "ALLOW",
                duration: 0,
                ruleId: null,
              });
            },
          },
        })
        : {
          execute(content, send) {
            if (!taskId) {
              const input = JSON.parse(String(content).split("\n").at(-1)!);
              wokeOnProtectedReview ||= input.protectedWorkerReviews?.some(
                ({ taskId }: { taskId: string }) => taskId === receipt.taskId,
              ) === true;
              send({
                type: "response",
                taint: "INTERNAL",
                text: '{"prioritize":[],"assignments":[]}',
              });
            }
            return Promise.resolve();
          },
          clear() {},
        },
    undefined,
    () => workerClock,
  );
  try {
    assert((await credentials.deleteSecret("github-pat")).ok);
    const beforeDenied = credentialsRequested;
    planner.advance(current);
    await waitForCondition(
      () => credentialsRequested > beforeDenied && !planner.hasInFlightWork(),
      () => {},
    );
    assertEquals(calls, 0);
    assert((await credentials.setSecret("github-pat", credential)).ok);
    workerClock += 65_000;
    const review = () =>
      readAdaptiveSentinel(path, current)?.modelReviews
        .find(({ taskId }) => taskId === receipt.taskId);
    await waitForCondition(
      () => review() !== undefined,
      () => planner.advance(current),
      20_000,
    );
    assertEquals(prompt?.sourceEvidence, receipt.sourceEvidence);
    assertEquals(JSON.parse(responses[0]), fact);
    assertEquals(JSON.parse(responses[1]).record, finding);
    assertEquals(review()?.summary, "Reviewed retained connector evidence.");
    await waitForCondition(() => wokeOnProtectedReview, () => {});
    const step = {
      ...ref,
      action: "worker_trace_result",
      taskId: receipt.taskId,
      stepIndices: [1],
    };
    await gateway(async (turn) => {
      const opened = JSON.parse(await turn(step));
      assertEquals(opened.result, JSON.parse(responses[1]));
      const beforeDenial = credentialsRequested;
      blockHook = "PRE_TOOL_CALL";
      try {
        assertStringIncludes(await turn(step), "unavailable");
      } finally {
        blockHook = undefined;
      }
      assertEquals(credentialsRequested, beforeDenial);
      assert((await credentials.deleteSecret("github-pat")).ok);
      assertStringIncludes(await turn(step), "unavailable");
    });
    assert(sourceHooks.includes("PRE_TOOL_CALL"));
    assert(sourceHooks.includes("POST_TOOL_RESPONSE"));
    assertEquals(resultFetches, 0);
    assert(!JSON.stringify({ prompt, responses }).includes(credential));
  } finally {
    planner.stop();
  }

  const provenanceTool = "sentinel_provenance_node";
  const selection = { node: `observation:adaptive:review:${receipt.taskId}` };
  const plannerProviders = createProviderRegistry();
  let proposalCount = 0;
  let revokeDuringProposal = true;
  let exactReview: unknown;
  let initialPlannerContext: string | undefined;
  plannerProviders.register({
    name: "protected-review-planner",
    supportsStreaming: false,
    async complete(messages) {
      const response = messages.findLast(({ role }) => role === "tool");
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!response) {
        initialPlannerContext = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        return {
          content: "",
          usage,
          toolCalls: [{
            type: "function",
            id: "protected-review",
            function: {
              name: provenanceTool,
              arguments: JSON.stringify(selection),
            },
          }],
        };
      }
      const review = JSON.parse(String(response.content));
      if (revokeDuringProposal) {
        assert((await credentials.deleteSecret("github-pat")).ok);
      } else {
        exactReview = review;
      }
      proposalCount++;
      return {
        usage,
        toolCalls: [],
        content: JSON.stringify({
          prioritize: [],
          assignments: [{
            kind: "impact",
            nodeId: "app",
            depth: 2,
            sourceTaskId: receipt.taskId,
            sourceKind: "model_review",
          }],
        }),
      };
    },
  });
  plannerProviders.setDefault("protected-review-planner");
  let plannerClock = workerClock + 65_000;
  const followups = () =>
    readAdaptiveSentinel(path, current, "revision")?.tasks.filter((task) =>
      task.kind === "impact" && task.nodeId === "app" && task.depth === 2 &&
      task.prerequisites.includes(receipt.taskId) &&
      task.plannerRound?.sourceKind === "model_review"
    ) ?? [];
  const protectedPlanner = createSentinelModelPlanner(
    path,
    (latest, taskId) =>
      taskId
        ? { execute: () => Promise.resolve(), clear() {} }
        : createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: latest.revision,
          plannerExecutionEvidenceRunId: latest.plan.runId,
          sharedInventoryBaseDir: baseDir,
          readRetainedWorkflow: reader,
          providerRegistry: plannerProviders,
          allowModelAccess: true,
          hookRunner: {
            evaluateHook(hook, { input }) {
              const allowed = policy(hook, input);
              return Promise.resolve({
                allowed,
                action: allowed ? "ALLOW" : "BLOCK",
                duration: 0,
                ruleId: null,
              });
            },
          },
        }),
    () => followups().length === 0 ? () => {} : undefined,
    () => plannerClock,
  );
  let recordedRead: Record<string, unknown>;
  try {
    assert((await credentials.setSecret("github-pat", credential)).ok);
    addSentinelCaseHint(path, "Review the exact saved assignment observation.");
    protectedPlanner.advance(current);
    await waitForCondition(
      () => proposalCount === 1 && !protectedPlanner.hasInFlightWork(),
      () => {
        if (!proposalCount) protectedPlanner.advance(current);
      },
    );
    assertEquals(followups(), []);
    assert((await credentials.setSecret("github-pat", credential)).ok);
    revokeDuringProposal = false;
    plannerClock += 65_000;
    addSentinelCaseHint(
      path,
      "Reopen the approved review for its assigned asset.",
    );
    await waitForCondition(
      () => followups().length === 1 && !protectedPlanner.hasInFlightWork(),
      () => protectedPlanner.advance(current),
    );
    const planningInput = JSON.parse(
      initialPlannerContext!.split("\n").at(-1)!,
    );
    assertEquals(planningInput.protectedWorkerReviews, [{
      taskId: receipt.taskId,
      nodeId: "app",
    }]);
    assert(!initialPlannerContext!.includes("Verified both retained sources."));
    assertEquals(
      (exactReview as { node: { modelReview: { summary: string } } })
        .node.modelReview.summary,
      "Verified both retained sources.",
    );
    const round = readAdaptiveSentinel(path, current, "revision")
      ?.modelPlannerHistory.findLast(({ reads }) =>
        reads?.some(({ tool }) => tool === provenanceTool)
      );
    assert(round);
    recordedRead = {
      ...ref,
      action: "planner_reads",
      plannerIdentity: round.identity,
      attempt: round.attempt,
      ordinal: round.reads!.findIndex(({ tool }) => tool === provenanceTool) +
        1,
      includeResult: true,
    };
  } finally {
    protectedPlanner.stop();
  }
  const reviewArchiveId = crypto.randomUUID();
  const [followup] = followups();
  assert(followup);
  await gateway(async (turn) => {
    assertEquals(JSON.parse(await turn(recordedRead)).result, exactReview);
    assertEquals(
      JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
      "stopped",
    );
    assertEquals(
      JSON.parse(
        await turn({
          ...ref,
          runId,
          action: "archive",
          requestId: reviewArchiveId,
        }),
      )
        .receipt.status,
      "succeeded",
    );
  });
  await Deno.rename(
    dirname(path),
    join(baseDir, "before-protected-planner-restore"),
  );
  await gateway(async (turn) => {
    assertEquals(
      JSON.parse(
        await turn({
          ...ref,
          runId,
          action: "restore",
          archiveId: reviewArchiveId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt.status,
      "succeeded",
    );
    assertEquals(JSON.parse(await turn(recordedRead)).result, exactReview);
    assert((await credentials.deleteSecret("github-pat")).ok);
    assertStringIncludes(await turn(recordedRead), "unavailable");
    assert((await credentials.setSecret("github-pat", credential)).ok);
    assertEquals(
      JSON.parse(await turn({ ...ref, action: "resume" })).run.status,
      "running",
    );
  });
  const restored = readSentinelAssessment(path);
  assert(restored);
  const unrelatedLease = (() => {
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const alternate = store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        depth: 7,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision).find(({ kind, depth }) => kind === "trace" && depth === 7);
      assert(alternate && alternate.id !== followup.id);
      advanceAdaptiveSentinel(path, restored);
      const lease = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ id }) => id === alternate.id,
      );
      assert(lease);
      return {
        assessmentRevision: restored.revision,
        assignedTaskId: lease.task.id,
        assignedTaskLeaseToken: lease.token,
      };
    } finally {
      store.close();
    }
  })();
  const unrelatedResult = await workerTurn(
    path,
    unrelatedLease,
    [[tool(provenanceTool, selection)]],
    undefined,
    baseDir,
    reader,
  );
  assert(
    !unrelatedResult.results[0][0].includes("Verified both retained sources."),
  );
  const protectedTrace = {
    ...ref,
    action: "worker_trace_result",
    taskId: followup.id,
    stepIndices: [0],
  };

  const followupProviders = createProviderRegistry();
  let phase: "interrupt" | "revoked" | "resume" = "interrupt";
  let followupPlanner: ReturnType<typeof createSentinelModelPlanner>;
  let workerRequests = 0;
  let protectedResult: unknown;
  let revokedDelivery = false;
  let resumedResult: unknown;
  followupProviders.register({
    name: "protected-prerequisite-worker",
    supportsStreaming: false,
    complete(messages) {
      const response = messages.findLast(({ role }) => role === "tool");
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (response) {
        const result = JSON.parse(String(response.content));
        if (phase === "interrupt") {
          protectedResult = result;
          followupPlanner.stop();
        } else if (phase === "revoked") {
          revokedDelivery = true;
        } else {
          resumedResult = result;
        }
        return Promise.resolve({
          content:
            '{"summary":"Verified the exact protected prerequisite.","followUps":[]}',
          usage,
          toolCalls: [],
        });
      }
      if (phase !== "interrupt") {
        return Promise.resolve({
          content:
            '{"summary":"Stopped before protected source reuse.","followUps":[]}',
          usage,
          toolCalls: [],
        });
      }
      workerRequests++;
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          type: "function",
          id: "exact-protected-prerequisite",
          function: {
            name: provenanceTool,
            arguments: JSON.stringify(selection),
          },
        }],
      });
    },
  });
  followupProviders.setDefault("protected-prerequisite-worker");
  const coordinator = () =>
    createSentinelModelPlanner(
      path,
      (latest, taskId, lease) =>
        taskId === followup.id
          ? createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: latest.revision,
            assignedTaskId: taskId,
            assignedTaskLeaseToken: lease,
            sharedInventoryBaseDir: baseDir,
            readRetainedWorkflow: reader,
            providerRegistry: followupProviders,
            allowModelAccess: true,
            hookRunner: {
              evaluateHook(hook, { input }) {
                const allowed = policy(hook, input);
                return Promise.resolve({
                  allowed,
                  action: allowed ? "ALLOW" : "BLOCK",
                  duration: 0,
                  ruleId: null,
                });
              },
            },
          })
          : { execute: () => Promise.resolve(), clear() {} },
    );
  followupPlanner = coordinator();
  try {
    followupPlanner.advance(restored);
    await waitForCondition(
      () => protectedResult !== undefined && !followupPlanner.hasInFlightWork(),
      () => {},
    );
    assertEquals(
      (protectedResult as { node: { modelReview: { summary: string } } })
        .node.modelReview.summary,
      "Verified both retained sources.",
    );
    phase = "revoked";
    assert((await credentials.deleteSecret("github-pat")).ok);
    const beforeRevocation = credentialsRequested;
    followupPlanner = coordinator();
    followupPlanner.advance(restored);
    await waitForCondition(
      () =>
        credentialsRequested > beforeRevocation &&
        !followupPlanner.hasInFlightWork(),
      () => {},
    );
    assertEquals(revokedDelivery, false);
    followupPlanner.stop();
    phase = "resume";
    assert((await credentials.setSecret("github-pat", credential)).ok);
    followupPlanner = coordinator();
    await waitForCondition(
      () => resumedResult !== undefined && !followupPlanner.hasInFlightWork(),
      () => followupPlanner.advance(restored),
      20_000,
    );
    assertEquals(resumedResult, protectedResult);
    assertEquals(workerRequests, 1);
  } finally {
    followupPlanner.stop();
  }
  await gateway(async (turn) => {
    assertEquals(
      JSON.parse(await turn(protectedTrace)).result,
      protectedResult,
    );
    blockHook = "PRE_TOOL_CALL";
    try {
      const before = credentialsRequested;
      assertStringIncludes(await turn(protectedTrace), "unavailable");
      assertEquals(credentialsRequested, before);
    } finally {
      blockHook = undefined;
    }
    assert((await credentials.deleteSecret("github-pat")).ok);
    assertStringIncludes(await turn(protectedTrace), "unavailable");
  });
  assertEquals(resultFetches, 0);
}

Deno.test("Reviewed cross-case worker review reaches a scoped planner and reopens after archive restore", async () => {
  const baseDir = await Deno.makeTempDir();
  const sourceCase = "shared-review-source";
  const approvedCase = "shared-review-approved";
  const linkOnlyCase = "shared-review-link-only";
  const wrongIdentityCase = "shared-review-wrong-identity";
  const path = (id: string) => resolveSentinelCasePath(baseDir, id);
  const exactSummary = "Checked the original retained application inventory.";
  const reviewedTool = "sentinel_shared_worker_review";
  try {
    for (
      const id of [sourceCase, approvedCase, linkOnlyCase, wrongIdentityCase]
    ) {
      await Deno.mkdir(dirname(path(id)), { recursive: true });
      await Deno.writeTextFile(
        path(id),
        JSON.stringify({
          version: 1,
          nodes: [
            {
              id: "app",
              kind: "asset",
              label: "Shared application",
              aliases: [
                id === wrongIdentityCase
                  ? "other.shared-review.example"
                  : "app.shared-review.example",
              ],
            },
            { id: "other", kind: "asset", label: "Independent application" },
          ],
          edges: [],
        }),
      );
    }
    const sourcePath = path(sourceCase);
    const source = startSentinelAssessment(sourcePath);
    const sourceRunId = source.plan.runId;
    assert(sourceRunId);
    const sourceAdaptiveRevision = adaptiveRevision(source);
    const recordScope = (expectedVersion: number, allowedAssetIds: string[]) =>
      recordSentinelOperatingConstraints(sourcePath, {
        runId: sourceRunId,
        evidenceRevision: source.revision,
        expectedVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { deniedKinds: [], allowedAssetIds },
      });
    assert(recordScope(0, ["app"]));
    advanceAdaptiveSentinel(sourcePath, source);
    const store = openSentinelAdaptiveStore(
      join(dirname(sourcePath), "sentinel-adaptive.db"),
    );
    const sourceTask = (() => {
      try {
        const result = store.sync(sourceAdaptiveRevision, [{
          kind: "trace",
          nodeId: "app",
          depth: 7,
          reason: MODEL_ASSIGNMENT_REASON,
        }], sourceAdaptiveRevision).find(({ kind, depth }) =>
          kind === "trace" && depth === 7
        );
        assert(result);
        return result;
      } finally {
        store.close();
      }
    })();
    const allowedHooks: HookRunner = {
      evaluateHook: () =>
        Promise.resolve({
          allowed: true,
          action: "ALLOW",
          duration: 0,
          ruleId: null,
        }),
    };
    const workerProviders = createProviderRegistry();
    workerProviders.register({
      name: "source-worker-review",
      supportsStreaming: false,
      complete(messages) {
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (messages.some(({ role }) => role === "tool")) {
          return Promise.resolve({
            content: JSON.stringify({ summary: exactSummary, followUps: [] }),
            usage,
            toolCalls: [],
          });
        }
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: "source-assigned-target",
            type: "function",
            function: { name: assigned, arguments: "{}" },
          }],
        });
      },
    });
    workerProviders.setDefault("source-worker-review");
    const sourcePlanner = createSentinelModelPlanner(
      sourcePath,
      (latest, id, lease) =>
        id === sourceTask.id
          ? createSentinelSubagent({
            snapshotPath: sourcePath,
            assessmentRevision: latest.revision,
            assignedTaskId: id,
            assignedTaskLeaseToken: lease,
            providerRegistry: workerProviders,
            allowModelAccess: true,
            hookRunner: allowedHooks,
          })
          : { execute: () => Promise.resolve(), clear() {} },
    );
    try {
      advanceAdaptiveSentinel(sourcePath, source);
      await waitForCondition(
        () =>
          readAdaptiveSentinel(sourcePath, source)?.modelReviews.some(
            ({ taskId, summary }) =>
              taskId === sourceTask.id && summary === exactSummary,
          ) === true,
        () => sourcePlanner.advance(source),
      );
    } finally {
      sourcePlanner.stop();
    }
    const sourceRef = {
      kind: "sentinel",
      id: sourceCase,
      revision: source.revision,
    };
    const selection = [{
      caseId: sourceCase,
      revision: source.revision,
      workerReviewTaskIds: [sourceTask.id],
    }];
    const spawn = {
      ...sourceRef,
      action: "spawn",
      targetKind: "sentinel",
      targetId: approvedCase,
      sourceCases: selection,
      requestId: crypto.randomUUID(),
    };
    let approvals = 0;
    let denyDelivery = false;
    let blockedDelivery = false;
    const frames: string[] = [];
    const gateway = (
      body: Parameters<typeof withFindingAssignmentGateway>[2],
    ) =>
      withFindingAssignmentGateway(
        baseDir,
        () => {
          approvals++;
          return Promise.resolve(true);
        },
        body,
        (hook, input) => {
          if (
            denyDelivery && hook === "PRE_OUTPUT" &&
            String(input.content).includes(exactSummary)
          ) {
            blockedDelivery = true;
            return false;
          }
          return true;
        },
        (frame) => frames.push(frame),
        undefined,
        undefined,
        true,
      );
    await gateway(async (turn) => {
      assertStringIncludes(
        await turn({
          ...spawn,
          sourceCases: [{ ...selection[0], revision: source.revision + 1 }],
        }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({
          ...spawn,
          sourceCases: [{
            ...selection[0],
            workerReviewTaskIds: [`adaptive:${"0".repeat(64)}`],
          }],
        }),
        "unavailable",
      );
      assertEquals(approvals, 0);
      const linkedOnly = JSON.parse(
        await turn({
          ...spawn,
          targetId: linkOnlyCase,
          sourceCases: undefined,
          requestId: crypto.randomUUID(),
        }),
      );
      assert([linkedOnly.link.left, linkedOnly.link.right].some(
        ({ id, revision }: { id: string; revision: number }) =>
          id === sourceRef.id && revision === sourceRef.revision,
      ));
      const admitted = await turn(spawn);
      assert(admitted.startsWith("{"), admitted);
      const { link } = JSON.parse(admitted);
      assert([link.left, link.right].some(
        ({ id, revision }: { id: string; revision: number }) =>
          id === sourceRef.id && revision === sourceRef.revision,
      ));
      assertEquals(approvals, 2);
      assertEquals(JSON.parse(await turn(spawn)), JSON.parse(admitted));
      assertEquals(approvals, 2);
      const mismatched = await turn({
        ...spawn,
        targetId: wrongIdentityCase,
        requestId: crypto.randomUUID(),
      });
      assertEquals(JSON.parse(mismatched).run.ref.id, wrongIdentityCase);
    });

    async function plan(
      id: string,
      authorized: boolean,
      revokeOnProposal = false,
    ) {
      const targetPath = path(id);
      const current = readSentinelAssessment(targetPath);
      assert(current?.active && current.plan.runId);
      const providers = createProviderRegistry();
      const hooks: string[] = [];
      const readArgs = { sourceCase, taskId: sourceTask.id, asset: "app" };
      let received: string | undefined;
      providers.register({
        name: "cross-case-review-planner",
        supportsStreaming: false,
        complete(messages) {
          const usage = { inputTokens: 1, outputTokens: 1 };
          const response = messages.findLast(({ role }) => role === "tool");
          if (!response) {
            return Promise.resolve({
              content: "",
              usage,
              toolCalls: [{
                type: "function",
                id: "exact-shared-worker-review",
                function: {
                  name: reviewedTool,
                  arguments: JSON.stringify(readArgs),
                },
              }],
            });
          }
          received = String(response.content);
          const selected = received.startsWith("{") &&
            JSON.parse(received).reference;
          if (selected && revokeOnProposal) assert(recordScope(1, []));
          return Promise.resolve({
            content: JSON.stringify({
              prioritize: [],
              assignments: selected
                ? [{
                  kind: "trace",
                  depth: 1,
                  nodeId: "app",
                  peerWorkerReview: selected,
                }]
                : [],
            }),
            usage,
            toolCalls: [],
          });
        },
      });
      providers.setDefault("cross-case-review-planner");
      const followups = () =>
        readAdaptiveSentinel(targetPath, current, "revision")?.tasks.filter(
          ({ plannerRound }) =>
            plannerRound?.peerWorkerReview?.sourceTaskId === sourceTask.id,
        ) ?? [];
      const planner = createSentinelModelPlanner(
        targetPath,
        (latest, id) =>
          id
            ? { execute: () => Promise.resolve(), clear() {} }
            : createSentinelSubagent({
              snapshotPath: targetPath,
              assessmentRevision: latest.revision,
              plannerExecutionEvidenceRunId: latest.plan.runId,
              sharedInventoryBaseDir: baseDir,
              providerRegistry: providers,
              allowModelAccess: true,
              hookRunner: {
                evaluateHook(hook, { input }) {
                  const name = input.tool_name ??
                    (input.tool_call as { name?: string } | undefined)?.name;
                  if (name === reviewedTool) hooks.push(hook);
                  return Promise.resolve({
                    allowed: true,
                    action: "ALLOW",
                    duration: 0,
                    ruleId: null,
                  });
                },
              },
            }),
        () => followups().length ? undefined : () => {},
        () => Date.now() + (revokeOnProposal ? 0 : 65_000),
      );
      try {
        planner.advance(current);
        await waitForCondition(
          () => received !== undefined && !planner.hasInFlightWork(),
          () => {},
        );
        assert(received);
        if (!authorized) {
          assert(!received.includes(exactSummary));
          assertEquals(followups(), []);
          return;
        }
        assert(received.startsWith("{"), received);
        const read = JSON.parse(received);
        assertEquals(read.summary, exactSummary);
        assertEquals(read.reference, {
          sourceCase,
          sourceRunId,
          sourceRevision: source.revision,
          sourceTaskId: sourceTask.id,
          sourceAssetId: "app",
          asset: "app",
          summarySha256: createHash("sha256").update(exactSummary).digest(
            "hex",
          ),
        });
        assert(hooks.includes("PRE_TOOL_CALL"));
        assert(hooks.includes("POST_TOOL_RESPONSE"));
        if (revokeOnProposal) {
          assertEquals(followups(), []);
          return;
        }
        const [scheduled] = followups();
        assert(scheduled);
        assertEquals(scheduled.kind, "trace");
        assertEquals(scheduled.nodeId, "app");
        assert(!scheduled.prerequisites.includes(sourceTask.id));
        assertEquals(scheduled.plannerRound?.peerWorkerReview, read.reference);
        const round = readAdaptiveSentinel(targetPath, current, "revision")
          ?.modelPlannerHistory.findLast(({ reads }) =>
            reads?.some(({ tool }) => tool === reviewedTool)
          );
        assert(round);
        return {
          read,
          assignment: scheduled.id,
          run: {
            kind: "sentinel",
            id,
            revision: current.revision,
            runId: current.plan.runId,
          },
          trace: {
            kind: "sentinel",
            id,
            revision: current.revision,
            action: "planner_reads",
            plannerIdentity: round.identity,
            attempt: round.attempt,
            ordinal: round.reads!.findIndex(({ tool }) =>
              tool === reviewedTool
            ) + 1,
            includeResult: true,
          },
        };
      } finally {
        planner.stop();
      }
    }
    await plan(linkOnlyCase, false);
    await plan(wrongIdentityCase, false);
    await plan(approvedCase, true, true);
    assert(recordScope(2, ["app"]));
    addSentinelCaseHint(
      path(approvedCase),
      "Reopen the approved source on its matching asset.",
    );
    const admitted = await plan(approvedCase, true);
    assert(admitted);
    const archiveId = crypto.randomUUID();
    await gateway(async (turn) => {
      assertEquals(
        JSON.parse(await turn(admitted.trace)).result,
        admitted.read,
      );
      frames.length = 0;
      denyDelivery = true;
      try {
        await assertRejects(() => turn(admitted.trace), Error);
      } finally {
        denyDelivery = false;
      }
      assert(blockedDelivery);
      assert(!frames.some((frame) => frame.includes(exactSummary)));
      assertEquals(
        JSON.parse(await turn({ ...admitted.run, action: "cancel" })).run
          .status,
        "stopped",
      );
      assertEquals(
        JSON.parse(
          await turn({
            ...admitted.run,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
    });
    await Deno.rename(
      dirname(path(approvedCase)),
      join(baseDir, "before-shared-review-restore"),
    );
    await gateway(async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...admitted.run,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      assertEquals(
        JSON.parse(await turn(admitted.trace)).result,
        admitted.read,
      );
      assertEquals(
        JSON.parse(
          await turn({
            kind: admitted.run.kind,
            id: admitted.run.id,
            revision: admitted.run.revision,
            action: "resume",
          }),
        ).run.status,
        "running",
      );
      const restoredPath = path(approvedCase);
      const restored = readSentinelAssessment(restoredPath);
      assert(restored);
      const journal = openSentinelAdaptiveStore(
        join(dirname(restoredPath), "sentinel-adaptive.db"),
      );
      const lease = (() => {
        try {
          const claimed = journal.claimModelReview(
            adaptiveRevision(restored),
            MODEL_ASSIGNMENT_REASON,
            ({ id }) => id === admitted.assignment,
          );
          assert(claimed);
          return {
            assessmentRevision: restored.revision,
            assignedTaskId: claimed.task.id,
            assignedTaskLeaseToken: claimed.token,
          };
        } finally {
          journal.close();
        }
      })();
      const readCall = tool(reviewedTool, {
        sourceCase,
        taskId: sourceTask.id,
        asset: "app",
      });
      const reused = await workerTurn(
        restoredPath,
        lease,
        [[readCall]],
        undefined,
        baseDir,
      );
      assertEquals(JSON.parse(reused.results[0][0]), admitted.read);
      assert(recordScope(3, []));
      assertStringIncludes(await turn(admitted.trace), "unavailable");
      const blocked = await workerTurn(
        restoredPath,
        lease,
        [[readCall]],
        undefined,
        baseDir,
      );
      assert(!blocked.results[0][0].includes(exactSummary));
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyReceiptFamily(
  family:
    | "branch protection"
    | "workflow attempt"
    | "repository visibility"
    | "workflow result"
    | "workflow result with repeated run"
    | "workflow result with older run"
    | "native workflow result",
  manual:
    | boolean
    | "inconclusive"
    | "no-result"
    | "stop-after-result"
    | "goal-pass"
    | "goal-stop"
    | "mixed-assignment" = false,
) {
  const baseDir = await Deno.makeTempDir();
  const caseId = manual ? "native-remediation" : "main";
  const path = resolveSentinelCasePath(baseDir, caseId);
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
  const reader = native ? nativeWorkflowReader(undefined, caseId) : undefined;
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
  if (manual === true) {
    nativeRuns.push({
      id: 4,
      status: "completed",
      conclusion: "success",
      repositoryId: 42,
      createdAt: "2025-01-04T00:00:00.000Z",
    });
  }
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
        caseId,
        validUntil,
      );
  const recordedAt = new Date(Date.now() - 30_000).toISOString();
  const passedAt = new Date(Date.now() - 10_000).toISOString();
  const foreignAt = new Date(Date.now() - 5_000).toISOString();
  const alternateAt = new Date(Date.now() - 1_000).toISOString();
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
            observedAt:
              [recordedAt, passedAt, foreignAt, alternateAt][stepIndex],
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
    if (manual === "mixed-assignment") {
      await verifyConnectorMixedAssignment(
        baseDir,
        caseId,
        path,
        state,
        finding,
      );
      return;
    }
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
      assertEquals(await list(state.revision, caseId), [finding]);
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
    let inspectedRunningAttempt = false;
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
                  await withFindingAssignmentGateway(baseDir, () => {
                    throw new Error(
                      "Read-only attempts must not require approval",
                    );
                  }, async (turn) => {
                    const running = JSON.parse(
                      await turn({
                        action: "finding_recheck_attempts",
                        kind: "sentinel",
                        id: "main",
                        revision: state.revision,
                        receiptId: input.recheckFindingId,
                        activeOnly: true,
                      }),
                    ).page;
                    assertEquals(running.entries, [{
                      taskId,
                      status: "running",
                      attempts: 1,
                      evidenceId: input.target,
                    }]);
                    const inventory = JSON.parse(
                      await turn({
                        action: "finding_recheck_attempts",
                        kind: "sentinel",
                        id: "main",
                        revision: state.revision,
                        activeOnly: true,
                      }),
                    ).page;
                    assertEquals(
                      inventory.entries,
                      running.entries.map(
                        (entry: Record<string, unknown>) => ({
                          ...entry,
                          findingId: input.recheckFindingId,
                        }),
                      ),
                    );
                    inspectedRunningAttempt = true;
                  });
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
    const goalSettlement = manual === "goal-pass" || manual === "goal-stop";
    const alternateSource = goalSettlement ? undefined : nativeSources[3];
    const alternateNode = alternateSource &&
      "native-workflow-evidence:" + alternateSource.resultSha256;
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          ...(goalSettlement
            ? [{
              id: "dependent-recheck-asset",
              kind: "asset",
              label: "Dependent asset",
            }]
            : []),
          ...(alternateNode
            ? [{
              id: alternateNode,
              kind: "evidence",
              label: "Alternate verified workflow receipt",
              nativeWorkflowSource: alternateSource,
              controlVerification: {
                outcome: "pass",
                observedAt: alternateAt,
                validUntil,
              },
            }]
            : []),
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
          ...(alternateNode
            ? [
              { from: alternateNode, to: "control", relation: "verifies" },
              { from: alternateNode, to: "app", relation: "observed_on" },
            ]
            : []),
          {
            from: passingNode,
            to: "control",
            relation: "verifies",
          },
          { from: passingNode, to: "app", relation: "observed_on" },
          ...(!goalSettlement
            ? [{ from: foreignNode, to: "control", relation: "verifies" }]
            : []),
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
    const goals: SentinelFormalGoal[] = [{
      id: "controls",
      title: "Verify settled remediation",
      policy: "operator",
      criteria: [{
        id: "remediated",
        description:
          "Confirm a passing settled retest of the reported control.",
        source: "finding_recheck",
        reference: `pass:${finding.id}`,
      }],
    }];
    const updated = goalSettlement
      ? applySentinelFormalGoals(path, {
        mode: "append",
        requestId: crypto.randomUUID(),
        expectedRevision: state.revision,
        expectedRunId: state.plan.runId,
        proposalDigest: digestSentinelGoalProposal(goals),
        goals,
      }).state
      : refreshSentinelAssessment(path);
    assert(updated && updated.revision > state.revision);
    receiptTargets = [passingNode, foreignNode];
    advanceAdaptiveSentinel(path, updated);
    if (manual) {
      await verifyOperatorNativeRecheck({
        baseDir,
        caseId,
        inconclusive: manual === "inconclusive",
        noResult: manual === "no-result",
        stopAfterResult: manual === "stop-after-result" ||
          manual === "goal-stop",
        goalSettlement,
        ...(alternateNode &&
          {
            alternate: {
              nodeId: alternateNode,
              resultSha256: alternateSource.resultSha256,
            },
          }),
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
      assert(inspectedRunningAttempt);
      const attempts = {
        action: "finding_recheck_attempts",
        kind: "sentinel",
        id: "main",
        revision: updated.revision,
        receiptId: finding.id,
      };
      await withFindingAssignmentGateway(baseDir, () => {
        throw new Error("History must not require approval");
      }, async (turn) => {
        const page = JSON.parse(await turn(attempts)).page;
        const [{ lastAttempt, ...entry }] = page.entries;
        assertEquals(lastAttempt.outcome, "completed");
        assertEquals([entry], [{
          taskId,
          status: "completed",
          attempts: 1,
          evidenceId: passingNode,
          resultReceiptId: scheduledResult?.id,
          outcome: "pass",
        }]);
        assertEquals(
          JSON.parse(await turn({ ...attempts, activeOnly: true })).page
            .entries,
          [],
        );
        assertStringIncludes(
          await turn({ ...attempts, id: "other" }),
          "unavailable",
        );
        assertStringIncludes(
          await turn({ ...attempts, receiptId: scheduledResult?.id }),
          "unavailable",
        );
      });
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
        assert(recordSentinelOperatingConstraints(path, {
          runId: updated.plan.runId!,
          evidenceRevision: updated.revision,
          expectedVersion: 0,
          requestId: crypto.randomUUID(),
          operatorScope: "owner",
          constraints: { deniedKinds: ["review_evidence"] },
        }));
        const revoked = await request("worker_recheck_lineage", {
          revision: updated.revision,
          taskId,
        });
        assertEquals(revoked.type, "error");
        assertEquals(revoked.finding, undefined);
        assertEquals(revoked.rechecks, undefined);
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
      const runId = updated.plan.runId;
      assert(runId);
      let allowSource = false;
      let checkCount = 0;
      let expireDuringAuthorization = false;
      let proofClock = Date.now();
      const verify = createWorkflowObservationVerifier(
        baseDir,
        (payload, classification) => {
          checkCount++;
          assertEquals(payload.kind, "github_branch_protection");
          assertEquals(payload.repositoryId, 42);
          assertEquals(classification, "INTERNAL");
          if (expireDuringAuthorization) {
            proofClock = Date.parse(saved.validUntil);
          }
          return Promise.resolve(allowSource);
        },
        () => proofClock,
      );
      const requirement = {
        case: "main",
        run_id: runId,
        revision: updated.revision,
        finding_recheck_id: saved.id,
      };
      assertEquals(await verify(requirement), undefined);
      assertEquals(checkCount, 1);
      allowSource = true;
      const proof = await verify(requirement);
      assert(proof && "findingRecheckId" in proof);
      assertEquals(proof.findingRecheckId, saved.id);
      assertEquals(checkCount, 2);
      expireDuringAuthorization = true;
      assertEquals(await verify(requirement), undefined);
      assertEquals(checkCount, 3);
    }
    if (family === "branch protection") {
      await verifyImportedFindingGrant(baseDir, finding, saved);
      const attempts = {
        action: "finding_recheck_attempts",
        kind: "sentinel",
        id: "main",
        revision: updated.revision,
        receiptId: finding.id,
        limit: 1,
      };
      let cursor: string | undefined;
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(false),
        async (turn) => {
          const page = JSON.parse(await turn(attempts)).page;
          assertEquals(page.entries, [{
            taskId: saved.taskId,
            status: "result_recorded",
            attempts: null,
            evidenceId: passingNode,
            resultReceiptId: saved.id,
            outcome: "pass",
          }]);
          cursor = page.nextCursor;
          assert(cursor);
        },
      );
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(false),
        async (turn) => {
          const denied = await turn({ ...attempts, activeOnly: true, cursor });
          assertStringIncludes(denied, "unavailable");
          const next = JSON.parse(await turn({ ...attempts, cursor })).page;
          const [{ lastAttempt, ...entry }] = next.entries;
          assertEquals(lastAttempt.outcome, "failed");
          assertEquals([entry], [{
            taskId: handoff?.[0].id,
            status: "retry_pending",
            attempts: 1,
            evidenceId: passingNode,
          }]);
          assertEquals(next.nextCursor, null);
        },
      );
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

Deno.test("Connector-backed mixed assignment reuses authorized saved results after restore", () =>
  verifyReceiptFamily("native workflow result", "mixed-assignment"));

Deno.test("Tidepool assembles oversized exact-version finding downloads without saving stale pages", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const path = resolveSentinelCasePath(baseDir);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: Array.from({ length: 280 }, (_, index) => ({
          id: `finding-${index}`,
          kind: "finding",
          label: "🔍".repeat(256),
          severity: "low",
        })),
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    await withTidepool(baseDir, async (_list, _provenance, request) => {
      const scope = { findingFilter: {} };
      for (
        const format of ["csv", "findings-json", "markdown", "md-zip"] as const
      ) {
        const download = createFindingDownload(
          "main",
          state.revision,
          format,
          scope,
        );
        const oversized = await request("export", {
          caseId: "main",
          ...download.initial,
        });
        assertEquals(oversized.type, "error");
        assertEquals(oversized.code, "finding_export_byte_limit");
        assertEquals(oversized.content, undefined);
        let outcome = download.accept(oversized);
        let pages = 0;
        while ("request" in outcome && pages < 25) {
          const response = await request("export", {
            caseId: "main",
            ...outcome.request,
          });
          assertEquals(response.type, "export");
          outcome = download.accept(response);
          pages++;
        }
        assert(pages > 1);
        assert("content" in outcome);
        const blob = new Blob([...outcome.content]);
        assert(blob.size > 256 * 1024);
        if (format === "md-zip") {
          const zip = Buffer.from(await blob.arrayBuffer());
          const end = zip.length - 22;
          assertEquals(zip.readUInt32LE(end), 0x06054b50);
          assertEquals(zip.readUInt16LE(end + 10), 280);
          let entry = zip.readUInt32LE(end + 16);
          for (let index = 0; index < 280; index++) {
            assertEquals(zip.readUInt32LE(entry), 0x02014b50);
            const nameSize = zip.readUInt16LE(entry + 28);
            const local = zip.readUInt32LE(entry + 42);
            assertEquals(zip.readUInt32LE(local), 0x04034b50);
            assertEquals(
              zip.subarray(entry + 46, entry + 46 + nameSize).toString(),
              `finding-${String(index + 1).padStart(2, "0")}.md`,
            );
            entry += 46 + nameSize;
          }
          assertEquals(entry, end);
          continue;
        }
        const content = await blob.text();
        if (format === "csv") {
          const lines = content.trimEnd().split("\r\n");
          assertEquals(lines.length, 281);
          assertEquals(
            lines.filter((line) => line.startsWith('"case_id"')).length,
            1,
          );
          assertEquals(
            new Set(lines.slice(1).map((line) => line.split(",")[2])).size,
            280,
          );
        } else if (format === "markdown") {
          assertEquals([...content.matchAll(/^# /gm)].length, 1);
          assertEquals([...content.matchAll(/^## /gm)].length, 280);
        } else {
          const result = JSON.parse(content);
          assertEquals(result.caseId, "main");
          assertEquals(result.revision, state.revision);
          assertEquals(result.findings.length, 280);
          assertEquals(
            new Set(result.findings.map(({ id }: { id: string }) => id)).size,
            280,
          );
        }
      }
      for (const format of ["markdown", "md-zip"] as const) {
        const selection = {
          findingIds: Array.from(
            { length: 17 },
            (_, index) => `finding-${index}`,
          ),
        };
        const direct = createFindingDownload(
          "main",
          state.revision,
          format,
          selection,
          "es",
        );
        const directFrame = await request("export", {
          caseId: "main",
          ...direct.initial,
        });
        const original = direct.accept(directFrame);
        assert("content" in original);
        const paged = createFindingDownload(
          "main",
          state.revision,
          format,
          selection,
          "es",
        );
        let assembled = paged.accept({
          type: "error",
          code: "finding_export_byte_limit",
          caseId: "main",
          revision: state.revision,
          format,
        });
        for (let index = 0; index < 2; index++) {
          assert("request" in assembled);
          assembled = paged.accept(
            await request("export", {
              caseId: "main",
              ...assembled.request,
            }),
          );
        }
        assert("content" in assembled);
        assertEquals(
          await new Blob([...assembled.content]).arrayBuffer(),
          await new Blob([...original.content]).arrayBuffer(),
        );
      }
      const pending = [];
      for (const format of ["markdown", "md-zip"] as const) {
        const stale = createFindingDownload(
          "main",
          state.revision,
          format,
          scope,
        );
        const firstRequest = stale.accept(
          await request("export", {
            caseId: "main",
            ...stale.initial,
          }),
        );
        assert("request" in firstRequest);
        const more = stale.accept(
          await request("export", {
            caseId: "main",
            ...firstRequest.request,
          }),
        );
        assert("request" in more);
        pending.push({ stale, request: more.request });
      }
      const update = await request("review_finding", {
        caseId: "main",
        revision: state.revision,
        findingId: "finding-0",
        disposition: "confirmed",
        note: "New reviewed disposition",
      });
      assertEquals(update.type, "sentinel_state");
      for (const continuation of pending) {
        const expired = await request("export", {
          caseId: "main",
          ...continuation.request,
        });
        assertEquals(expired.type, "error");
        assert("error" in continuation.stale.accept(expired));
      }
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Finding download assembly shrinks oversized pages and rejects oversized artifacts", () => {
  const download = createFindingDownload("main", 1, "csv", {
    findingFilter: {},
  });
  const scope = { caseId: "main", revision: 1, format: "csv" };
  const byteLimit = {
    ...scope,
    type: "error",
    code: "finding_export_byte_limit",
  };
  const initial = download.accept(byteLimit);
  assert("request" in initial);
  assertEquals(initial.request.findingPageSize, 16);
  const smaller = download.accept(byteLimit);
  assert("request" in smaller);
  assertEquals(smaller.request.findingPageSize, 8);
  const digest = "1".repeat(64);
  const header =
    '"case_id","evidence_revision","finding_id","title","exact_record"\r\n';
  const count = 8;
  const total = 288;
  let offset = 0;
  while (offset < total) {
    const end = offset + count;
    const content = header +
      Array.from(
        { length: count },
        (_, index) =>
          `"main","1","finding-${offset + index}","${
            "x".repeat(32_000)
          }","{}"\r\n`,
      ).join("");
    const outcome = download.accept({
      ...scope,
      type: "export",
      content,
      findingPage: {
        manifestDigest: digest,
        offset,
        count,
        total,
        nextCursor: end === total ? null : `finding-export:${digest}:${end}`,
      },
    });
    if ("error" in outcome) {
      assertEquals(end, 264);
      return;
    }
    assert("request" in outcome);
    offset = end;
  }
  throw new Error("The export exceeded the aggregate byte limit");
});

Deno.test("Reviewed Sentinel finding follow-up preserves the originating report and runs within its read scope", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    const time = Date.now();
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          { id: "neighbor", kind: "asset", label: "Neighbor" },
          { id: "gap", kind: "finding", label: "Gap", severity: "high" },
          { id: "control", kind: "control", label: "Control" },
          {
            id: "evidence",
            kind: "evidence",
            label: "Retained control check",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(time - 1000).toISOString(),
              validUntil: new Date(time + 3600000).toISOString(),
            },
          },
        ],
        edges: [
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: "evidence", to: "app", relation: "observed_on" },
          { from: "evidence", to: "control", relation: "verifies" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const source = assignedLease(path, state, "impact");
    const published = await workerTurn(path, source, [
      [tool(assigned)],
      [tool(report, {
        graphFindingId: "gap",
        controlId: "control",
        evidenceId: "evidence",
        title: "Saved check failed",
        summary: "The retained control result was negative.",
        requestId: crypto.randomUUID(),
      })],
    ]);
    const record = JSON.parse(published.results[1][0]).record;
    const input = {
      action: "assign",
      kind: "sentinel",
      id: "main",
      revision: state.revision,
      runId: state.plan.runId,
      adaptiveRevision: adaptiveRevision(state),
      taskKind: "trace",
      node: "app",
      receiptId: record.id,
      note: "Review the scope of the saved control failure.",
      requestId: crypto.randomUUID(),
    };
    let confirmations = 0;
    let approved = false;
    let deniedByPolicy = true;
    let outcome:
      | {
        taskId: string;
        findingFollowup:
          import("../../src/sentinel/adaptive_store.ts").AdaptiveFindingFollowup;
      }
      | undefined;
    await withFindingAssignmentGateway(baseDir, () => {
      confirmations++;
      return Promise.resolve(approved);
    }, async (turn) => {
      assertStringIncludes(await turn(input), "blocked");
      assertEquals(confirmations, 0);
      deniedByPolicy = false;
      assertStringIncludes(
        await turn({ ...input, node: "neighbor" }),
        "unavailable",
      );
      assertEquals(confirmations, 0);
      assertStringIncludes(await turn(input), "declined");
      assertEquals(confirmations, 1);
      assert(pauseSentinelAssessment(path, state.revision, state.plan.runId));
      approved = true;
      outcome = JSON.parse(await turn(input)).receipt;
      assertEquals(outcome?.findingFollowup, {
        findingId: record.id,
        sourceTaskId: source.assignedTaskId,
        evidenceId: "evidence",
        sourceRevision: state.revision,
        assignedRevision: state.revision,
        snapshotDigest: record.snapshotDigest,
        reportVersion: 1,
        note: input.note,
      });
      assertEquals(confirmations, 2);
    }, (hook, data) =>
      !(deniedByPolicy && hook === "PRE_TOOL_CALL" &&
        (data.tool_call as { name?: string } | undefined)?.name ===
          "operator_runs"));
    assert(outcome);
    const saved = outcome;
    assertEquals(
      readAdaptiveSentinel(path, state)?.tasks.find(
        ({ id }) => id === saved.taskId,
      )?.status,
      "queued",
    );
    await withFindingAssignmentGateway(baseDir, () => {
      throw new Error("An exact replay should use the existing receipt");
    }, async (turn) => {
      assertEquals(JSON.parse(await turn(input)).receipt, saved);
      assertStringIncludes(
        await turn({ ...input, note: "Different request." }),
        "unavailable",
      );
    });
    const resumed = resumeSentinelAssessment(
      path,
      undefined,
      state.revision,
      state.plan.runId,
    );
    assertEquals(resumed?.revision, state.revision);
    assert(resumed);
    advanceAdaptiveSentinel(path, resumed);
    const registry = createProviderRegistry();
    let consumed = false;
    const hooks: string[] = [];
    registry.register({
      name: "finding-followup-worker",
      supportsStreaming: false,
      complete(messages, definitions) {
        const prompt = messages.find(({ role }) => role === "user")?.content;
        const nameList = (definitions ?? []).map((definition) =>
          (definition as { function?: { name?: string } }).function?.name
        );
        if (!String(prompt).includes(input.note)) {
          return Promise.resolve({
            content:
              '{"summary":"Reviewed local evidence.","followUps":[],"assignments":[]}',
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          });
        }
        assertStringIncludes(String(prompt), record.id);
        assertEquals([...nameList].sort(), [assigned, findings].sort());
        const responses = messages.filter(({ role }) => role === "tool");
        const response = responses.at(-1);
        if (response) {
          assertStringIncludes(String(responses[0].content), "blocked");
          assertEquals(JSON.parse(String(response.content)).record, record);
          consumed = true;
        }
        return Promise.resolve({
          content: response
            ? '{"summary":"Reviewed the exact saved finding.","followUps":[]}'
            : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: response ? [] : [{
            id: "denied-finding-list",
            type: "function",
            function: { name: findings, arguments: "{}" },
          }, {
            id: "exact-finding-read",
            type: "function",
            function: {
              name: findings,
              arguments: JSON.stringify({ receiptId: record.id }),
            },
          }],
        });
      },
    });
    registry.setDefault("finding-followup-worker");
    planner = createSentinelModelPlanner(
      path,
      (_state, assignedTaskId, assignedTaskLeaseToken) =>
        createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId,
          assignedTaskLeaseToken,
          providerRegistry: registry,
          allowModelAccess: true,
          hookRunner: {
            evaluateHook(hook, { input }) {
              if (
                input.tool_name === findings ||
                (input.tool_call as { name?: string } | undefined)?.name ===
                  findings
              ) hooks.push(hook);
              return Promise.resolve({
                allowed: true,
                action: "ALLOW",
                ruleId: null,
                duration: 0,
              });
            },
          },
        }),
    );
    const until = Date.now() + 3000;
    while (!consumed && Date.now() < until) {
      planner.advance(resumed);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(consumed);
    assert(hooks.includes("PRE_TOOL_CALL"));
    assert(hooks.includes("POST_TOOL_RESPONSE"));
    const task = readAdaptiveSentinel(path, state)?.tasks.find(({ id }) =>
      id === saved.taskId
    );
    assertEquals(task?.plannerRound?.findingFollowup, saved.findingFollowup);
    const stale = { ...input, requestId: crypto.randomUUID() };
    await withFindingAssignmentGateway(baseDir, async () => {
      const graph = JSON.parse(await Deno.readTextFile(path));
      graph.nodes.push({
        id: "new-evidence",
        kind: "asset",
        label: "New revision",
      });
      await Deno.writeTextFile(path, JSON.stringify(graph));
      const refreshed = refreshSentinelAssessment(path);
      assert(refreshed && refreshed.revision > state.revision);
      return true;
    }, async (turn) => {
      assertStringIncludes(await turn(stale), "unavailable");
    });
    const journal = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      assertEquals(
        journal.readOperatorAssignmentIntent(stale.requestId),
        undefined,
      );
    } finally {
      journal.close();
    }
    planner.stop();
    const finalState = readSentinelAssessment(path);
    assert(finalState?.active);
    assert(completeSentinelAssessmentGoal(
      path,
      finalState.revision,
      finalState.plan.goal ?? null,
      "Reviewed original goal evidence.",
    ));
    const completed = readSentinelAssessment(path);
    assert(completed?.completion);
    assertEquals(completed.active, false);
    const terminal = {
      action: "completed_graph_followup",
      kind: "sentinel",
      id: "main",
      revision: completed.revision,
      runId: completed.plan.runId,
      requestId: crypto.randomUUID(),
      taskKind: "trace",
      node: "app",
      receiptId: record.id,
      note: "Review the retained local graph around the published finding.",
    };
    let terminalConfirmations = 0;
    let terminalReceipt:
      | { findingFollowup: typeof saved.findingFollowup }
      | undefined;
    await withFindingAssignmentGateway(baseDir, () => {
      terminalConfirmations++;
      return Promise.resolve(true);
    }, async (turn) => {
      for (
        const unsupported of [
          { ...terminal, node: "neighbor" },
          { ...terminal, taskKind: "impact" },
          { ...terminal, receiptId: `worker-finding:${"f".repeat(64)}` },
        ]
      ) {
        assertStringIncludes(await turn(unsupported), "unavailable");
      }
      assertEquals(terminalConfirmations, 0);
      terminalReceipt = JSON.parse(await turn(terminal)).receipt;
      assertEquals(terminalReceipt?.findingFollowup, {
        ...saved.findingFollowup,
        assignedRevision: completed.revision,
        note: terminal.note,
      });
      assertEquals(terminalConfirmations, 1);
    });
    assert(terminalReceipt);
    await withFindingAssignmentGateway(baseDir, () => {
      throw new Error(
        "Completed review replay must not request approval again",
      );
    }, async (turn) => {
      assertEquals(JSON.parse(await turn(terminal)).receipt, terminalReceipt);
      assertStringIncludes(await turn(input), "unavailable");
      const status = JSON.parse(
        await turn({
          action: "inspect",
          kind: "sentinel",
          id: "main",
          revision: completed.revision,
        }),
      ).run;
      assertEquals(status.status, "completed");
    });
    assertEquals(readSentinelAssessment(path), completed);
    await withTidepool(baseDir, async (list) => {
      assertEquals(
        (await list(state.revision)).filter(({ id }) => id === record.id),
        [record],
      );
    });
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Gateway publication requires the exact saved workflow attempt and evidence revision", () =>
  verifyReceiptFamily("workflow attempt"));

Deno.test("A leased inconclusive Sentinel recheck remains citable after gateway restart and archive restore", () =>
  verifyReceiptFamily("native workflow result", "inconclusive"));

Deno.test("Gateway operator discovers and queues one exact native remediation recheck", () =>
  verifyReceiptFamily("native workflow result", true));

Deno.test("A clean Sentinel recheck turn without an exact result records a failed attempt", () =>
  verifyReceiptFamily("native workflow result", "no-result"));

Deno.test("Stopping an exact recheck preserves its staged evidence without publishing remediation", () =>
  verifyReceiptFamily("native workflow result", "stop-after-result"));

async function verifyNativeFindingTrafficReadScope(
  baseDir: string,
  caseId: string,
  path: string,
  state: State,
  findingId: string,
  linkId: string,
  originalAssetId: string,
  nativeReceipt: { evidenceId: string; digest: string },
) {
  let name = "sentinel_finding_traffic_links";
  let args: Record<string, unknown> = { revision: state.revision };
  let result = "";
  let revokeOnResponse = false;
  let denyHistoryRead = false;
  const memory: Array<{ attachment: boolean; payload: boolean }> = [];
  const nativePayloadMemory: boolean[] = [];
  const registry = createProviderRegistry();
  registry.register({
    name: "finding-traffic-scope",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const memoryCheck = last?.role === "user" &&
        String(last.content).includes("Check saved traffic context");
      if (memoryCheck) {
        const retained = messages.filter(({ role }) => role === "tool").map(
          ({ content }) => {
            try {
              return JSON.parse(String(content));
            } catch {
              return undefined;
            }
          },
        );
        nativePayloadMemory.push(
          retained.some((page) =>
            page?.evidenceId === nativeReceipt.evidenceId &&
            typeof page.text === "string" && page.text.length > 0
          ),
        );
        memory.push({
          attachment: retained.some((page) =>
            page?.links?.some(
              (link: { id: string }) => link.id === linkId,
            )
          ),
          payload: retained.some((page) =>
            page?.link?.id === linkId &&
            typeof page.payload?.text === "string" &&
            page.payload.text.length > 0
          ),
        });
      }
      const done = memoryCheck || last?.role === "tool";
      if (last?.role === "tool") result = String(last.content);
      return Promise.resolve({
        content: done ? "Reviewed retained evidence." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: done ? [] : [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      });
    },
  });
  registry.setDefault("finding-traffic-scope");
  const setPolicy = (
    expectedVersion: number,
    deniedKinds: ["review_evidence"] | [],
    allowedAssetIds?: string[],
  ) =>
    assert(recordSentinelOperatingConstraints(path, {
      runId: state.plan.runId!,
      evidenceRevision: state.revision,
      expectedVersion,
      requestId: crypto.randomUUID(),
      operatorScope: "owner",
      constraints: { deniedKinds, allowedAssetIds },
    }));
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "finding-traffic-scope" as ChannelId,
        bumpersEnabled: false,
      }),
      providerRegistry: registry,
      sentinelSnapshotPath: path,
      allowSentinelModelAccess: true,
      hookRunner: {
        evaluateHook(hook, { input }) {
          if (
            revokeOnResponse && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === name
          ) {
            setPolicy(2, ["review_evidence"]);
            revokeOnResponse = false;
          }
          const allowed = !(denyHistoryRead && hook === "PRE_TOOL_CALL" &&
            input.tool_name === name);
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
    const turn = async (
      selected: Record<string, unknown>,
      content = "/sentinel-agent Read the retained finding traffic.",
    ) => {
      args = { revision: state.revision, ...selected };
      result = "";
      const completed = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => completed.reject(new Error("No Sentinel response")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        const frame = JSON.parse(data);
        if (frame.type === "error") completed.reject(new Error(frame.message));
        if (frame.type === "turn_end") completed.resolve();
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({
          type: "message",
          content,
        }));
        await completed.promise;
        return result;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    const payload = {
      findingId,
      trafficLinkId: linkId,
      payloadPart: "response",
    };
    assert(
      JSON.parse(await turn({ findingId })).links.some((link: { id: string }) =>
        link.id === linkId
      ),
    );
    const retained = JSON.parse(await turn(payload));
    assertEquals(retained.link.id, linkId);
    assert(retained.payload);
    await turn({}, "/sentinel on");
    await turn({ findingId }, "Open attachment list.");
    await turn(payload, "Open exact attachment response.");
    await turn({}, "Check saved traffic context while authorized.");
    denyHistoryRead = true;
    await turn({}, "Check saved traffic context after source denial.");
    denyHistoryRead = false;
    await turn({ findingId }, "Open accessible attachment list again.");
    await turn(payload, "Open accessible exact attachment response again.");
    setPolicy(0, ["review_evidence"]);
    await turn(
      {},
      "Check saved traffic context after withdrawing case access.",
    );
    assertEquals(memory, [
      { attachment: true, payload: true },
      { attachment: false, payload: false },
      { attachment: false, payload: false },
    ]);
    setPolicy(1, []);
    await turn({}, "/sentinel off");
    revokeOnResponse = true;
    assertStringIncludes(await turn(payload), "withheld by policy");
    assertStringIncludes(await turn(payload), "unavailable");
    assertStringIncludes(await turn({ findingId }), "unavailable");
    assertEquals(JSON.parse(await turn({})).links, []);
    setPolicy(3, []);
    name = "sentinel_traffic_search";
    const unfiltered = JSON.parse(await turn({ limit: 10 })).receipts;
    assert(
      unfiltered.some(({ assetIds }: { assetIds: string[] }) =>
        !assetIds.includes(originalAssetId)
      ),
    );
    const originalPage = JSON.parse(await turn({ limit: 1 }));
    assert(originalPage.nextCursor);
    setPolicy(4, [], [originalAssetId]);
    assertStringIncludes(
      await turn({ limit: 1, cursor: originalPage.nextCursor }),
      "unavailable",
    );
    const scoped = JSON.parse(await turn({ limit: 10 })).receipts;
    assert(
      scoped.length > 0 && scoped.every(
        ({ assetIds }: { assetIds: string[] }) =>
          assetIds.includes(originalAssetId),
      ),
    );
    name = "sentinel_traffic_get";
    assertEquals(
      JSON.parse(await turn(nativeReceipt)).receipt.digest,
      nativeReceipt.digest,
    );
    name = "sentinel_traffic_blob";
    const raw = { ...nativeReceipt, payloadPart: "response" };
    assertEquals(JSON.parse(await turn(raw)).text, retained.payload.text);
    await turn({}, "/sentinel on");
    await turn(raw, "Open the exact standalone traffic body.");
    await turn(
      {},
      "Check saved traffic context with the standalone body allowed.",
    );
    setPolicy(5, ["review_evidence"]);
    await turn(
      {},
      "Check saved traffic context after standalone access withdrawal.",
    );
    assertEquals(nativePayloadMemory.slice(-2), [true, false]);
    await turn({}, "/sentinel off");
    assertStringIncludes(await turn(raw), "unavailable");
    name = "sentinel_traffic_get";
    assertStringIncludes(await turn(nativeReceipt), "unavailable");
    name = "sentinel_traffic_search";
    assertEquals(JSON.parse(await turn({ limit: 10 })).receipts, []);
    await withTidepool(baseDir, async (_list, _provenance, request) => {
      const exported = await request("export", {
        caseId,
        revision: state.revision,
        format: "provenance",
      });
      assertEquals(exported.type, "export");
      const report = JSON.parse(String(exported.content));
      assertEquals(report.findingTrafficLinks, undefined);
      assertEquals(report.workerFindings, undefined);
    });
    const beforeAttach = listSentinelFindingTrafficLinks(path);
    await withFindingAssignmentGateway(baseDir, () => {
      throw new Error("Out-of-scope traffic must not reach confirmation");
    }, async (turn) => {
      const result = await turn({
        action: "attach_finding_traffic",
        kind: "sentinel",
        id: caseId,
        revision: state.revision,
        receiptId: findingId,
        reportVersion: 1,
        requestId: crypto.randomUUID(),
        ...nativeReceipt,
      });
      assertStringIncludes(result, "unavailable");
    });
    assertEquals(listSentinelFindingTrafficLinks(path), beforeAttach);
    setPolicy(6, []);
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

async function verifyInitialTrafficPublication(
  baseDir: string,
  path: string,
  state: State,
  source: ReturnType<typeof assignedLease>,
  findingInput: Record<string, unknown>,
  traffic: readonly { revision: number; evidenceId: string; digest: string }[],
  assetId: string,
  neighbor: { evidenceId: string; digest: string },
  mode: "resume" | "revoked" | "stale",
  hinted: boolean | "set",
) {
  const input = {
    ...findingInput,
    severity: "high",
    findingCategory: "Control coverage",
  };
  const ref = {
    kind: "sentinel",
    id: "retained-finding",
    revision: state.revision,
    runId: state.plan.runId,
  };
  const batch = traffic.length > 1;
  const hintId = hinted
    ? await (async () => {
      const sources = traffic.map(({ evidenceId, digest }) => ({
        evidenceId,
        digest,
      }));
      const selection = hinted === "set"
        ? { trafficReferences: sources }
        : { trafficReference: sources[0] };
      const request = {
        ...ref,
        action: "hint",
        requestId: crypto.randomUUID(),
        note: "Review this retained response.",
        assetIds: [assetId],
        ...selection,
      };
      let approvals = 0;
      let denyLast = hinted === "set";
      await withFindingAssignmentGateway(baseDir, () => {
        approvals++;
        return Promise.resolve(true);
      }, async (turn) => {
        if (denyLast) {
          const denied = await turn(request);
          assertStringIncludes(denied, "unavailable");
          assertEquals(approvals, 0);
          assertEquals(readSentinelCaseHints(path, 10), []);
          denyLast = false;
        }
        const result = await turn(request);
        assert(!result.startsWith("Error:"), result);
        assertEquals(await turn(request), result);
        assertEquals(approvals, 1);
        if (hinted === "set") {
          assertStringIncludes(
            await turn({
              ...request,
              trafficReferences: [...sources].reverse(),
            }),
            "unavailable",
          );
        }
      }, (hook, input) =>
        !(denyLast && hook === "PRE_TOOL_CALL" &&
          JSON.stringify(input).includes('"traffic_get"') &&
          JSON.stringify(input).includes(sources.at(-1)!.evidenceId)));
      const [hint] = readSentinelCaseHints(path, 10);
      assert(hint);
      assertEquals(
        hint.trafficReference,
        hinted === "set" ? sources : sources[0],
      );
      return hint.id;
    })()
    : undefined;
  const refs: { evidenceId: string; digest: string; sourceHintId?: number }[] =
    traffic.map(({ evidenceId, digest }, index) => ({
      evidenceId,
      digest,
      ...(hintId !== undefined && (index === 0 || hinted === "set") &&
        { sourceHintId: hintId }),
    }));
  const selectedArgs = (items: typeof refs) =>
    batch ? { trafficRefs: items } : {
      trafficEvidenceId: items[0].evidenceId,
      trafficDigest: items[0].digest,
      ...(items[0].sourceHintId !== undefined &&
        { sourceHintId: items[0].sourceHintId }),
    };
  const different = {
    evidenceId: neighbor.evidenceId,
    digest: neighbor.digest,
  };
  const stale = { evidenceId: refs.at(-1)!.evidenceId, digest: "f".repeat(64) };
  const denied = await workerTurn(path, source, [
    [
      tool(assigned),
      ...(hintId !== undefined
        ? [tool(report, { ...input, ...selectedArgs(refs) })]
        : []),
    ],
    traffic.map((value) => tool("sentinel_traffic_get", value)),
    [
      tool(report, {
        ...input,
        ...selectedArgs([...refs.slice(0, -1), different]),
      }),
      tool(report, {
        ...input,
        ...selectedArgs([...refs.slice(0, -1), stale]),
      }),
      tool(report, {
        ...input,
        findingCategory: `Bearer ${"c".repeat(32)}`,
        ...selectedArgs(refs),
      }),
      ...(hintId !== undefined
        ? [tool(report, {
          ...input,
          ...selectedArgs(
            batch && hinted !== "set"
              ? refs.map(({ evidenceId, digest }, index) => ({
                evidenceId,
                digest,
                ...(index === 1 && { sourceHintId: hintId }),
              }))
              : refs.map((ref, index) =>
                index === 0 ? { ...ref, sourceHintId: hintId + 1000 } : ref
              ),
          ),
        })]
        : []),
    ],
  ]);
  if (hintId !== undefined) {
    assertStringIncludes(denied.results[0][1], "Error:");
  }
  assert(denied.results[2].every((result) => result.startsWith("Error:")));
  assertEquals(readSentinelWorkerFindingHistory(path), []);
  assertEquals(listSentinelFindingTrafficLinks(path), []);
  const revision = adaptiveRevision(state);
  const adaptive = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  try {
    assert(
      adaptive.finishModelReview(
        revision,
        source.assignedTaskId,
        source.assignedTaskLeaseToken,
        "interrupted",
      ),
    );
  } finally {
    adaptive.close();
  }
  openSentinelWorkerFindingStore(path).close();
  const findingDb = new DatabaseSync(
    join(dirname(path), "sentinel-worker-findings.db"),
  );
  findingDb.exec(
    `CREATE TRIGGER interrupt_composite_finding BEFORE INSERT ON receipts
    BEGIN SELECT RAISE(ABORT, 'interrupt between link and finding'); END`,
  );
  findingDb.close();
  await Deno.writeTextFile(
    join(baseDir, "traffic-finding-fixture.json"),
    JSON.stringify({
      taskId: source.assignedTaskId,
      input: { ...input, ...selectedArgs(refs) },
      traffic,
    }),
    { mode: 0o600 },
  );
  const fixture = new URL(
    "./fixtures/traffic_finding_gateway_process.ts",
    import.meta.url,
  );
  const launch = async (phase: string) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fixture.pathname, baseDir, phase],
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
  };
  await launch("interrupt");
  assertEquals(readSentinelWorkerFindingHistory(path), []);
  assertEquals(listSentinelFindingTrafficLinks(path), []);
  const linksDb = new DatabaseSync(
    join(dirname(path), "sentinel-finding-traffic-links.db"),
    { readOnly: true },
  );
  try {
    assertEquals(
      linksDb.prepare("SELECT COUNT(*) AS count FROM staged_publication_links")
        .get()?.count,
      traffic.length,
    );
  } finally {
    linksDb.close();
  }
  const reopened = new DatabaseSync(
    join(dirname(path), "sentinel-worker-findings.db"),
  );
  reopened.exec("DROP TRIGGER interrupt_composite_finding");
  reopened.close();
  const expireFixtureLease = () => {
    const expired = new DatabaseSync(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      expired.exec(
        "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE token IS NOT NULL",
      );
    } finally {
      expired.close();
    }
  };
  expireFixtureLease();
  if (mode === "resume") {
    await launch("reclaim-crash");
    expireFixtureLease();
  }
  if (mode === "stale") {
    const graph = JSON.parse(await Deno.readTextFile(path));
    graph.nodes.find(({ id }: { id: string }) => id === "gap").label +=
      " (new evidence revision)";
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const updated = refreshSentinelAssessment(path);
    assert(updated && updated.revision > state.revision);
    await launch(mode);
    assertEquals(readSentinelWorkerFindingHistory(path), []);
    assertEquals(listSentinelFindingTrafficLinks(path), []);
    return;
  }
  await launch(mode);
  const events =
    (await Deno.readTextFile(join(baseDir, "traffic-finding-events.log")))
      .trim().split("\n");
  assertEquals(
    events.filter((event) => event.endsWith(":traffic-result")),
    traffic.map(() => "interrupt:traffic-result"),
  );
  assert(
    events.includes("interrupt:report-pre") &&
      events.includes("interrupt:interrupted"),
  );
  assert(events.includes(`${mode}:traffic-pre`));
  const restoreArchive = async () => {
    assert(stopSentinelAssessment(path));
    const archiveId = crypto.randomUUID();
    await withFindingAssignmentGateway(
      baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        assertEquals(
          JSON.parse(
            await turn({ ...ref, action: "archive", requestId: archiveId }),
          ).receipt.status,
          "succeeded",
        );
      },
    );
    await Deno.rename(
      dirname(path),
      join(baseDir, "before-traffic-finding-restore"),
    );
    await withFindingAssignmentGateway(
      baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        assertEquals(
          JSON.parse(
            await turn({
              ...ref,
              action: "restore",
              requestId: crypto.randomUUID(),
              archiveId,
            }),
          ).receipt.status,
          "succeeded",
        );
      },
    );
  };
  if (mode === "revoked") {
    assert(!events.includes("revoked:report-pre"));
    assertEquals(readSentinelWorkerFindingHistory(path), []);
    assertEquals(listSentinelFindingTrafficLinks(path), []);
    await restoreArchive();
    assertEquals(readSentinelWorkerFindingHistory(path), []);
    assertEquals(listSentinelFindingTrafficLinks(path), []);
    return;
  }
  assert(events.includes("reclaim-crash:traffic-pre"));
  assert(!events.includes("reclaim-crash:report-pre"));
  assert(events.includes("resume:report-pre"));
  assert(events.includes("resume:report-post"));
  const recovered = JSON.parse(
    await Deno.readTextFile(join(baseDir, "traffic-finding-result.json")),
  );
  const attached: SentinelFindingTrafficLink[] = recovered.links ??
    [recovered.link];
  assertEquals(
    attached.map(({ sourceHint }) => sourceHint),
    refs.map(({ sourceHintId }) =>
      sourceHintId === undefined
        ? undefined
        : { id: sourceHintId, runId: ref.runId }
    ),
  );
  assertEquals(
    attached.map(({ findingId }) => findingId),
    traffic.map(() => recovered.record.id),
  );
  assertEquals(
    attached.map(({ trafficDigest }) => trafficDigest),
    traffic.map(({ digest }) => digest),
  );
  assertEquals(
    attached.map(({ authority }) => authority),
    traffic.map(() => ({
      kind: "assignment" as const,
      taskId: source.assignedTaskId,
    })),
  );
  assertEquals(
    attached.map(({ sourceStep }) => sourceStep?.stepIndex),
    traffic.map((_, index) => index + 1),
  );
  assertEquals(recovered.record.severity, input.severity);
  assertEquals(recovered.record.findingCategory, input.findingCategory);
  assertEquals(recovered.record.runId, state.plan.runId);
  assertEquals(recovered.record.targetId, assetId);
  assertEquals(readSentinelWorkerFindingHistory(path), [recovered.record]);
  const byId = (
    left: SentinelFindingTrafficLink,
    right: SentinelFindingTrafficLink,
  ) => left.id.localeCompare(right.id);
  assertEquals(
    listSentinelFindingTrafficLinks(path).sort(byId),
    attached.toSorted(byId),
  );
  if (hinted === "set") {
    await verifyNativeFindingTrafficReadScope(
      baseDir,
      ref.id,
      path,
      state,
      recovered.record.id,
      attached[0].id,
      attached[0].assetId,
      { evidenceId: attached[0].trafficId, digest: attached[0].trafficDigest },
    );
  }
  const readTidepoolLinks = async () => {
    let links: SentinelFindingTrafficLink[] | undefined;
    await withTidepool(baseDir, async (_list, _provenance, request) => {
      const result = await request("export", {
        format: "provenance",
        revision: state.revision,
        caseId: ref.id,
      });
      assertEquals(result.type, "export");
      assertEquals(result.caseId, ref.id);
      links = JSON.parse(String(result.content)).findingTrafficLinks;
    });
    return links;
  };
  const reportRef = {
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision,
    receiptId: recovered.record.id,
  };
  const readInitialClassification = () =>
    withFindingAssignmentGateway(
      baseDir,
      () => Promise.resolve(false),
      async (turn) => {
        const { report } = JSON.parse(
          await turn({
            ...reportRef,
            action: "finding_report",
            reportVersion: 1,
          }),
        );
        assertEquals(report.severity, input.severity);
        assertEquals(report.findingCategory, input.findingCategory);
        assertEquals(report.disposition, undefined);
      },
    );
  await readInitialClassification();
  let baseline: unknown;
  if (hinted && !batch) {
    await withFindingAssignmentGateway(
      baseDir,
      () => Promise.resolve(true),
      async (turn) => {
        const report = {
          ...reportRef,
          action: "finding_report",
          includeReportEvidence: true,
        };
        const links = {
          ...reportRef,
          action: "finding_traffic",
          includeReportEvidence: true,
          limit: 1,
        };
        const first = JSON.parse(await turn(report)).report.reportEvidence;
        assertEquals(first.status, "current");
        assertEquals(first.current, first.reviewed);
        assertEquals(JSON.parse(await turn(links)).page.reportEvidence, first);
        const annotated = JSON.parse(
          await turn({
            ...reportRef,
            action: "annotate_finding_traffic",
            trafficLinkId: attached[0].id,
            reportVersion: 1,
            evidenceVersion: first.current.digest,
            requestId: crypto.randomUUID(),
            evidenceRole: "verification",
            evidenceNote: "Reviewed retained response.",
          }),
        ).amendment;
        assert(annotated);
        const stale = JSON.parse(await turn(report)).report.reportEvidence;
        assertEquals(stale.status, "changed");
        assertEquals(stale.reviewed, first.reviewed);
        assert(stale.current.digest !== stale.reviewed.digest);
        assertEquals(JSON.parse(await turn(links)).page.reportEvidence, stale);
        const amended = JSON.parse(
          await turn({
            ...reportRef,
            action: "amend_finding_report",
            reportVersion: 1,
            evidenceVersion: stale.current.digest,
            requestId: crypto.randomUUID(),
            title: "Reviewed control failure",
            summary: "The saved response supports the report.",
          }),
        ).amendment;
        assertEquals(amended.version, 2);
        baseline = JSON.parse(await turn(report)).report.reportEvidence;
        assertEquals(baseline, {
          reportVersion: 2,
          status: "current",
          reviewed: stale.current,
          current: stale.current,
        });
        assertEquals(
          JSON.parse(await turn({ ...report, reportVersion: 1 })).report
            .reportEvidence,
          stale,
        );
      },
    );
  }
  const liveTidepoolLinks = await readTidepoolLinks();
  assert(liveTidepoolLinks);
  assertEquals(liveTidepoolLinks.toSorted(byId), attached.toSorted(byId));
  await restoreArchive();
  await readInitialClassification();
  const listReceipts = {
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision,
    action: "finding_receipts",
  };
  const readReceipt = { ...reportRef, action: "finding_receipt" };
  const reportHistory = { ...reportRef, action: "finding_report_history" };
  await withFindingAssignmentGateway(
    baseDir,
    () => Promise.resolve(false),
    async (turn) => {
      assertEquals(
        JSON.parse(await turn(readReceipt)).record,
        recovered.record,
      );
      assertEquals(
        JSON.parse(await turn(reportHistory)).page.versions.at(-1)
          .sourceReceiptId,
        recovered.record.id,
      );
      assertEquals(
        JSON.parse(await turn(listReceipts)).page.records[0].id,
        recovered.record.id,
      );
    },
  );
  const traceQuery = {
    action: "worker_trace_result",
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision,
    taskId: source.assignedTaskId,
    stepIndices: [traffic.length + 1],
  };
  await withFindingAssignmentGateway(
    baseDir,
    () => Promise.resolve(false),
    async (turn) => {
      const reopened = JSON.parse(await turn(traceQuery));
      assertEquals(reopened.result, recovered);
      if (baseline) {
        const result = JSON.parse(
          await turn({
            ...reportRef,
            action: "finding_report",
            includeReportEvidence: true,
          }),
        );
        assertEquals(result.report.reportEvidence, baseline);
      }
    },
  );
  await withFindingAssignmentGateway(
    baseDir,
    () => Promise.resolve(false),
    async (turn) => {
      assertStringIncludes(await turn(traceQuery), "unavailable");
    },
    (hook, input) =>
      !(hook === "PRE_TOOL_CALL" && input.tool_name === "sentinel_traffic_get"),
  );
  assertEquals(await readTidepoolLinks(), liveTidepoolLinks);
  await verifyTidepoolTrafficDownload(
    baseDir,
    path,
    ref.id,
    state.revision,
    attached[0],
  );
  assertEquals(await readTidepoolLinks(), undefined);
  await withFindingAssignmentGateway(
    baseDir,
    () => Promise.resolve(false),
    async (turn) => {
      for (
        const request of [
          readReceipt,
          reportHistory,
          { ...reportRef, action: "finding_report", reportVersion: 1 },
          { ...listReceipts, cursor: recovered.record.id },
        ]
      ) {
        assertStringIncludes(await turn(request), "unavailable");
      }
      assertEquals(JSON.parse(await turn(listReceipts)).page, {
        records: [],
        nextCursor: null,
      });
    },
  );
}

async function verifyTidepoolTrafficDownload(
  baseDir: string,
  path: string,
  caseId: string,
  revision: number,
  link: SentinelFindingTrafficLink,
) {
  const providers = createProviderRegistry();
  let denied: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  const ownership = createSession({
    userId: "owner" as UserId,
    channelId: "tidepool-fixture" as ChannelId,
  });
  let handlerCalls = 0;
  let revokeOnResponse = false;
  const dispatch = createOperatorRunToolExecutor({
    baseDir,
    confirm: () => Promise.resolve(false),
  });
  const observed: string[] = [];
  const chat = createChatSession({
    session: ownership,
    providerRegistry: providers,
    targetClassification: "INTERNAL",
    resolveSentinelChatCase: (id) => id === caseId ? path : undefined,
    operatorRunExecutor: (args, context) => {
      handlerCalls++;
      return dispatch(args, context);
    },
    hookRunner: {
      evaluateHook(hook, { session, input, auditInput }) {
        if (hook === "PRE_OUTPUT" || input.tool_name === "operator_runs") {
          observed.push(hook);
          assertEquals(session.id, ownership.id);
          assert(!JSON.stringify(auditInput ?? {}).includes("Boundary🙂"));
          if (hook === "PRE_OUTPUT") {
            assertEquals(input.target_classification, "INTERNAL");
          }
        }
        if (
          revokeOnResponse && hook === "POST_TOOL_RESPONSE" &&
          input.tool_name === "operator_runs"
        ) {
          const current = readSentinelAssessment(path);
          assert(current?.plan.runId);
          assert(recordSentinelOperatingConstraints(path, {
            runId: current.plan.runId,
            evidenceRevision: current.revision,
            expectedVersion: readSentinelOperatingConstraints(
              path,
              current.plan.runId,
            )?.version ?? 0,
            requestId: crypto.randomUUID(),
            operatorScope: "traffic-download-fixture",
            constraints: { deniedKinds: ["review_evidence"] },
          }));
        }
        const allowed = hook !== denied;
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          duration: 0,
          ruleId: null,
        });
      },
    },
  });
  const selection = {
    caseId,
    revision,
    currentRevision: revision,
    findingId: link.findingId,
    trafficLinkId: link.id,
    payloadPart: "response" as const,
  };
  await withTidepool(baseDir, async (_list, _provenance, request) => {
    const page = (input: ReturnType<typeof createTrafficDownload>["initial"]) =>
      request("finding_traffic_download_page", { caseId, ...input });
    const first = createTrafficDownload(selection).initial;
    for (
      const hook of [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_OUTPUT",
      ] as const
    ) {
      denied = hook;
      const count = handlerCalls;
      const response = await page(first);
      assertEquals(response.type, "error", JSON.stringify(response));
      assert(!JSON.stringify(response).includes("Boundary🙂"));
      assertEquals(handlerCalls - count, hook === "PRE_TOOL_CALL" ? 0 : 1);
      assert(observed.includes(hook));
    }
    denied = undefined;
    const before = handlerCalls;
    assertEquals(
      (await page({ ...first, currentRevision: revision + 1 })).type,
      "error",
    );
    assertEquals(handlerCalls, before);
    const interrupted = createTrafficDownload(selection);
    const start = await interrupted.accept(await page(interrupted.initial));
    assert("request" in start);
    denied = "POST_TOOL_RESPONSE";
    const blocked = await interrupted.accept(await page(start.request));
    assert("error" in blocked);
    denied = undefined;

    const download = createTrafficDownload(selection);
    let input = download.initial;
    let pages = 0;
    for (;;) {
      assert(pages++ < 5);
      const outcome = await download.accept(await page(input));
      if ("request" in outcome) {
        input = outcome.request;
        continue;
      }
      assert("content" in outcome);
      assertEquals(
        new TextDecoder().decode(outcome.content),
        "Boundary🙂".repeat(240),
      );
      break;
    }
    assert(pages > 1);
    const changed = createTrafficDownload(selection);
    const modified = await page(changed.initial);
    const payload = (modified.page as { payload: { text: string } }).payload;
    payload.text = payload.text.replace("Boundary", "Xoundary");
    let outcome = await changed.accept(modified);
    while ("request" in outcome) {
      outcome = await changed.accept(await page(outcome.request));
    }
    assert(
      "error" in outcome,
      "The complete body digest must reject a corrupted page",
    );
    const archive = async (
      mode: "ok" | "revoke" | "manifest" | "revokeResponse",
      paired = false,
    ) => {
      const zip = createFindingEvidenceDownload({
        ...selection,
        payloadPart: paired ? "request-response" : "response",
      });
      let response = await zip.accept(
        await request("export", { caseId, ...zip.initial }),
      );
      const seenLinks = new Set<string>();
      let count = 0;
      while ("request" in response) {
        assert(count++ < 40);
        if (response.topic === "finding_traffic_download_page") {
          const selection = response.request;
          if (selection.offset === 0) {
            const key = selection.trafficLinkId + ":" + selection.payloadPart;
            if (
              seenLinks.has(key) && (mode === "revoke" ||
                (mode === "revokeResponse" &&
                  selection.payloadPart === "response"))
            ) {
              denied = "PRE_TOOL_CALL";
            }
            seenLinks.add(key);
          }
          response = await zip.accept(
            await request(response.topic, { caseId, ...selection }),
          );
        } else {
          const next = await request(response.topic, {
            caseId,
            ...response.request,
          });
          response = await zip.accept(
            mode === "manifest"
              ? { ...next, content: String(next.content) + " " }
              : next,
          );
        }
      }
      denied = undefined;
      return response;
    };
    const verifyZip = (content: ArrayBuffer, paired = false) => {
      const contents = new Uint8Array(content);
      const view = new DataView(content);
      const entries = new Map<string, string>();
      const decode = new TextDecoder();
      for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const length = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const start = offset + 30 + nameLength;
        const name = decode.decode(contents.subarray(offset + 30, start));
        assert(!entries.has(name));
        entries.set(
          name,
          decode.decode(contents.subarray(start, start + length)),
        );
        offset = start + length;
      }
      const prefix = "evidence/finding-01/link-1/";
      assert(entries.has("finding-01.md"));
      assertEquals(
        entries.get(prefix + "response.bin"),
        "Boundary🙂".repeat(240),
      );
      const descriptor = (part: string, text: string) => ({
        part,
        sha256: createHash("sha256").update(text).digest("hex"),
        byteLength: new TextEncoder().encode(text).length,
      });
      const manifest = JSON.parse(entries.get(prefix + "manifest.json")!);
      const response = descriptor("response", "Boundary🙂".repeat(240));
      if (paired) {
        assertEquals(
          entries.get(prefix + "request.bin"),
          "Reviewed synthetic request.",
        );
        assertEquals(manifest.retainedPayloads, [
          descriptor("request", "Reviewed synthetic request."),
          response,
        ]);
      } else assertEquals(manifest.retainedPayload, response);
    };
    const zipped = await archive("ok");
    assert("content" in zipped);
    verifyZip(zipped.content);
    const exchange = await archive("ok", true);
    assert("content" in exchange);
    verifyZip(exchange.content, true);
    assert("error" in await archive("revokeResponse", true));
    assert("error" in await archive("revoke"));
    assert("error" in await archive("manifest"));

    revokeOnResponse = true;
    assertEquals((await page(first)).type, "error");
    revokeOnResponse = false;
  }, chat.readSentinelTrafficDownloadPage);
}

async function testScopedReporterRestart(
  useBatch: boolean,
  denyMember = false,
  initialPublication?: "resume" | "revoked" | "stale",
  hinted: boolean | "set" = false,
) {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(
    baseDir,
    initialPublication ? "retained-finding" : undefined,
  );
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  try {
    const time = Date.now();
    const hosts = ["service.example", "neighbor.example"];
    const entries = [...hosts, ...(useBatch ? [hosts[0]] : [])].map((
      host,
      index,
    ) => ({
      startedDateTime: new Date(time - 1000 - index).toISOString(),
      request: {
        url: `https://${host}/review/${index}`,
        method: "GET",
        ...(initialPublication &&
          { postData: { text: "Reviewed synthetic request." } }),
      },
      response: {
        status: 403,
        content: {
          text: initialPublication
            ? "Boundary🙂".repeat(240)
            : "Reviewed response.",
        },
      },
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
      !!initialPublication,
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
    const trafficRecords = readSentinelTrafficReceiptPage(
      path,
      state.revision,
      {
        origin: `https://${hosts[0]}`,
      },
    )?.receipts.map(({ evidenceId, digest }) => ({
      revision: state.revision,
      evidenceId,
      digest,
    }));
    assertEquals(trafficRecords?.length, useBatch ? 2 : 1);
    assert(trafficRecords);
    const [traffic] = trafficRecords;
    const neighborReceipt = readSentinelTrafficReceiptPage(
      path,
      state.revision,
      {
        origin: `https://${hosts[1]}`,
      },
    )?.receipts[0];
    assert(neighborReceipt);
    const input = {
      graphFindingId: "gap",
      controlId: "control",
      evidenceId: "evidence",
      title: "Verified control gap",
      summary: "The case records a failed verification.",
      requestId: crypto.randomUUID(),
    };
    if (initialPublication) {
      await verifyInitialTrafficPublication(
        baseDir,
        path,
        state,
        source,
        input,
        trafficRecords,
        service.assetId,
        neighborReceipt,
        initialPublication,
        hinted,
      );
      return;
    }
    const published = await workerTurn(path, source, [
      [tool(assigned)],
      [tool(report, input), tool(report, input)],
    ]);
    const finding = JSON.parse(published.results[1][0]).record;
    assertEquals(JSON.parse(published.results[1][1]).record, finding);
    if (!useBatch) {
      await withFindingAssignmentGateway(
        baseDir,
        () => Promise.resolve(false),
        async (turn) => {
          const report = JSON.parse(
            await turn({
              action: "finding_report",
              kind: "sentinel",
              id: "main",
              revision: state.revision,
              receiptId: finding.id,
              includeReportEvidence: true,
            }),
          ).report;
          assertEquals(report.reportEvidence.status, "unbound");
          assertEquals(report.reportEvidence.reviewed, null);
        },
      );
    }
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
          assertEquals(
            JSON.parse(String(results[0].content)).record,
            finding,
          );
          const page = JSON.parse(String(results[1].content));
          assertEquals(
            page.receipts.map(({ evidenceId }: { evidenceId: string }) =>
              evidenceId
            ),
            trafficRecords.map(({ evidenceId }) => evidenceId),
          );
          batch = trafficRecords.map((record) =>
            tool("sentinel_traffic_get", record)
          );
        } else if (results.length === 2 + trafficRecords.length) {
          assertEquals(
            JSON.parse(String(results[2].content)).receipt.digest,
            traffic.digest,
          );
          offeredAttachments++;
          const {
            evidenceId: _evidenceId,
            digest: _digest,
            evidenceRole,
            evidenceNote,
            ...scope
          } = attachment;
          batch = [tool(
            "sentinel_attach_finding_traffic",
            useBatch
              ? {
                ...scope,
                trafficRefs: trafficRecords.map((
                  { evidenceId, digest },
                  index,
                ) => ({
                  evidenceId: denyMember && index === 1
                    ? neighborReceipt.evidenceId
                    : evidenceId,
                  digest: denyMember && index === 1
                    ? neighborReceipt.digest
                    : digest,
                  evidenceRole,
                  evidenceNote,
                })),
              }
              : attachment,
          )];
        } else if (results.length === 3 + trafficRecords.length) {
          if (denyMember) {
            assertStringIncludes(
              String(results.at(-1)?.content),
              "Open that exact",
            );
            return Promise.resolve({
              content:
                '{"summary":"Out-of-scope batch denied.","followUps":[]}',
              usage: { inputTokens: 1, outputTokens: 1 },
              toolCalls: [],
            });
          }
          const savedAttachment = JSON.parse(String(results.at(-1)?.content));
          const link = useBatch
            ? savedAttachment.links[0]
            : savedAttachment.link;
          if (useBatch) {
            assert(
              /^finding-traffic-batch:[a-f0-9]{64}$/.test(savedAttachment.id),
            );
            assertEquals(
              savedAttachment.links.map((
                item: { sourceStep: { stepIndex: number } },
              ) => item.sourceStep.stepIndex),
              [2, 3],
            );
          } else {
            assertEquals(link.sourceStep, {
              stepIndex: 2,
              sha256: createHash("sha256").update(String(results[2].content))
                .digest("hex"),
            });
          }
          assertEquals(link.trafficDigest, traffic.digest);
          assertEquals(link.authority, {
            kind: "assignment",
            taskId: reporter.id,
          });
          batch = [tool("sentinel_finding_traffic_links", {
            revision: state.revision,
            findingId: finding.id,
          })];
        } else if (results.length === 4 + trafficRecords.length) {
          const { evidenceVersion } = JSON.parse(
            String(results.at(-1)?.content),
          );
          batch = [
            tool(amend, { ...reportWrite, evidenceVersion: "0".repeat(64) }),
            tool(amend, { ...reportWrite, evidenceVersion }),
          ];
        } else {
          assertStringIncludes(
            String(results.at(-2)?.content),
            "unavailable",
          );
          assertEquals(
            JSON.parse(String(results.at(-1)?.content)).amendment.taskId,
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
                input.tool_response.includes(
                  useBatch ? '"links"' : '"link"',
                ) &&
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
    if (denyMember) {
      await waitFor(() =>
        readAdaptiveSentinel(path, state)?.modelReviewStates.find(
          ({ taskId }) => taskId === reporter.id,
        )?.progressSteps?.some((step) =>
          step.tool === "sentinel_attach_finding_traffic" &&
          step.outcome === "error"
        ) === true
      );
      assertEquals(offeredAttachments, 1);
      assertEquals(executions, 1);
      assertEquals(interruptedAfterAttachment, false);
      await withTidepool(baseDir, async (_list, provenance) => {
        assertEquals(
          (await provenance(state.revision)).findingTrafficLinks ?? [],
          [],
        );
      });
      return;
    }
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
      assertEquals(links.length, useBatch ? 2 : 1);
      if (useBatch) {
        assertEquals(links.map(({ authority }) => authority), [
          { kind: "assignment", taskId: reporter.id },
          { kind: "assignment", taskId: reporter.id },
        ]);
        assertEquals(
          links.map(({ sourceStep }) => sourceStep?.stepIndex).sort(),
          [
            2,
            3,
          ],
        );
        return;
      }
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
      assertEquals(links[0].sourceStep?.stepIndex, 2);
      assertEquals(links[0].evidenceRole, attachment.evidenceRole);
      assertEquals(links[0].evidenceNote, attachment.evidenceNote);
      assert(saved);
      const evidenceVersion = sentinelFindingTrafficEvidenceVersion(
        path,
        state.revision,
        finding.id,
      )
        .digest;
      let annotationId: string | undefined;
      let withdrawalId: string | undefined;
      const pagedCase = {
        caseId: "main",
        revision: state.revision,
        format: "findings-json",
        findingIds: [finding.id, "gap"],
        findingPageSize: 1,
      };
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
          const findingRef = {
            kind: "sentinel",
            id: "main",
            revision: state.revision,
            receiptId: finding.id,
          };
          const anotherLink = JSON.parse(
            await turn({
              ...findingRef,
              action: "attach_finding_traffic",
              evidenceId: traffic.evidenceId,
              digest: traffic.digest,
              reportVersion: saved.reports[0].version,
              evidenceRole: "supporting",
              evidenceNote: "Second exact attachment for ordering.",
              requestId: crypto.randomUUID(),
            }),
          ).link;
          const beforeOrder = await request("export", pagedCase);
          assertEquals(beforeOrder.type, "export");
          const beforeCursor =
            (beforeOrder.findingPage as { nextCursor: string }).nextCursor;
          assert(beforeCursor);
          const reordered = JSON.parse(
            await turn({
              ...findingRef,
              action: "reorder_finding_traffic",
              trafficLinkIds: [links[0].id, anotherLink.id],
              reportVersion: saved.reports[0].version,
              evidenceVersion: sentinelFindingTrafficEvidenceVersion(
                path,
                state.revision,
                finding.id,
              ).digest,
              requestId: crypto.randomUUID(),
            }),
          ).amendment;
          assertEquals(reordered.operation, "reorder");
          const staleOrder = await request("export", {
            ...pagedCase,
            findingCursor: beforeCursor,
          });
          assertEquals(staleOrder.type, "error");
          assertEquals(staleOrder.content, undefined);
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
      const exportedLink = exportedFinding.trafficLinks.find((
        { id }: { id: string },
      ) => id === links[0].id);
      assertEquals(exportedLink.withdrawn, true);
      const withdrawal = exportedFinding.trafficLinkSetHistory.find((
        { operation }: { operation: string },
      ) => operation === "withdraw");
      assertEquals(withdrawal.id, withdrawalId);
      assertEquals(withdrawal.requestId, undefined);
      assertEquals(exportedLink.id, links[0].id);
      assertEquals(exportedLink.trafficDigest, traffic.digest);
      assertEquals(exportedLink.evidenceRole, attachment.evidenceRole);
      assertEquals(exportedLink.annotations[0].id, annotationId);
      assertEquals(exportedLink.annotations[0].evidenceRole, "verification");
      assertEquals(exportedLink.annotations[0].requestId, undefined);
      const exportZip = createFindingDownload(
        "main",
        state.revision,
        "md-zip",
        {
          findingIds: pagedCase.findingIds,
        },
      );
      const direct = await request("export", {
        caseId: "main",
        ...exportZip.initial,
      });
      const zip = Buffer.from(String(direct.content), "base64");
      const directoryEnd = zip.length - 22;
      assertEquals(zip.readUInt32LE(directoryEnd), 0x06054b50);
      assertEquals(zip.readUInt16LE(directoryEnd + 10), 4);
      let entry = zip.readUInt32LE(directoryEnd + 16);
      const manifests = new Map<string, Record<string, unknown>>();
      const names = [];
      for (let index = 0; index < 4; index++) {
        const nameSize = zip.readUInt16LE(entry + 28);
        const name = zip.toString("utf8", entry + 46, entry + 46 + nameSize);
        names.push(name);
        if (name.endsWith("/manifest.json")) {
          const local = zip.readUInt32LE(entry + 42);
          const start = local + 30 + nameSize;
          const manifest = JSON.parse(
            zip.toString("utf8", start, start + zip.readUInt32LE(entry + 24)),
          );
          manifests.set(manifest.linkId, manifest);
        }
        entry += 46 + nameSize;
      }
      assertEquals(names, [
        "finding-01.md",
        "evidence/finding-01/link-1/manifest.json",
        "evidence/finding-01/link-2/manifest.json",
        "finding-02.md",
      ]);
      const historical = manifests.get(links[0].id);
      assertEquals(historical, {
        version: 1,
        caseId: "main",
        runId: state.plan.runId,
        reportRevision: state.revision,
        findingId: finding.id,
        linkId: links[0].id,
        assetId: links[0].assetId,
        evidenceRevision: state.revision,
        reportVersion: saved.reports[0].version,
        attachmentReportVersion: 1,
        trafficId: traffic.evidenceId,
        trafficSource: links[0].trafficSource,
        trafficDigest: traffic.digest,
        authority: links[0].authority,
        sourceStep: links[0].sourceStep,
        recordedAt: links[0].recordedAt,
        evidenceRole: attachment.evidenceRole,
        evidenceNote: attachment.evidenceNote,
        withdrawn: true,
        annotations: exportedLink.annotations,
      });
      assertEquals(
        [...manifests.values()].filter(({ withdrawn }) => withdrawn === false)
          .length,
        1,
      );
      assert(!zip.toString().includes("Reviewed response."));
      assert(!zip.toString().includes(links[0].requestId));
      const legacyPage = await request("export", {
        caseId: "main",
        ...exportZip.initial,
        findingPageSize: 1,
      });
      assertEquals(legacyPage.encoding, "base64");
      const legacyZip = Buffer.from(String(legacyPage.content), "base64");
      assertEquals(legacyZip.readUInt16LE(legacyZip.length - 12), 3);
      assertStringIncludes(
        legacyZip.toString(),
        JSON.stringify(historical, null, 2),
      );
      let assembled = exportZip.accept({
        type: "error",
        code: "finding_export_byte_limit",
        caseId: "main",
        revision: state.revision,
        format: "md-zip",
      });
      for (const _pageSize of [16, 8, 4, 2]) {
        assert("request" in assembled);
        assertEquals(assembled.request.findingPageSize, _pageSize);
        assembled = exportZip.accept({
          type: "error",
          code: "finding_export_byte_limit",
          caseId: "main",
          revision: state.revision,
          format: "md-zip",
        });
      }
      for (let index = 0; index < 2; index++) {
        assert("request" in assembled);
        assertEquals(assembled.request.findingPageSize, 1);
        const page = await request("export", {
          caseId: "main",
          ...assembled.request,
        });
        assertEquals(page.encoding, "finding-zip-entries-v2");
        assembled = exportZip.accept(page);
      }
      assert("content" in assembled);
      assertEquals(
        Buffer.from(await new Blob([...assembled.content]).arrayBuffer()),
        zip,
      );
      const finalPage = await request("export", pagedCase);
      const archivedCursor =
        (finalPage.findingPage as { nextCursor: string }).nextCursor;
      assert(archivedCursor);
      assert(stopSentinelAssessment(path));
      const next = startSentinelAssessment(path, {
        goal: "Investigate another saved run",
      });
      assert(next.revision > state.revision);
      const archivedZip = await request("export", {
        caseId: "main",
        ...exportZip.initial,
      });
      assertEquals(archivedZip.revision, state.revision);
      assertEquals(archivedZip.content, direct.content);
      const archivedPage = await request("export", {
        ...pagedCase,
        findingCursor: archivedCursor,
      });
      assertEquals(archivedPage.type, "export");
      assertEquals(archivedPage.revision, state.revision);
      assertEquals(
        JSON.parse(String(archivedPage.content)).findings[0].id,
        "gap",
      );
    });
  } finally {
    planner?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Sentinel resumes a staged finding and traffic receipt through root dispatch", () =>
  testScopedReporterRestart(false, false, "resume"));

Deno.test("Sentinel publishes a finding with an exact retained traffic set after restart", () =>
  testScopedReporterRestart(true, false, "resume"));

Deno.test("Revoking one source prevents publication of a staged finding traffic set", () =>
  testScopedReporterRestart(true, false, "revoked"));

Deno.test("Revoked traffic source policy blocks staged finding recovery across a gateway restart", () =>
  testScopedReporterRestart(false, false, "revoked"));

Deno.test("A newer case revision cannot replay a staged traffic finding", () =>
  testScopedReporterRestart(false, false, "stale"));

Deno.test("Sentinel resumes a scoped report worker after committing one traffic link", () =>
  testScopedReporterRestart(false));

Deno.test("Sentinel resumes a scoped report worker after committing an atomic traffic batch", () =>
  testScopedReporterRestart(true));

Deno.test("Sentinel rejects every reporter batch link when one member is outside the assigned asset", () =>
  testScopedReporterRestart(true, true));

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

Deno.test("Sentinel recovers approved traffic hint provenance for mixed initial finding attachments", () =>
  testScopedReporterRestart(true, false, "resume", true));

Deno.test("Sentinel recovers approved traffic hint provenance for a singular initial finding attachment", () =>
  testScopedReporterRestart(false, false, "resume", true));

Deno.test("Sentinel preserves a reviewed ordered traffic hint set through initial finding recovery", () =>
  testScopedReporterRestart(true, false, "resume", "set"));

Deno.test("A dedicated recheck can prove a formal goal only after successful settlement", () =>
  verifyReceiptFamily("native workflow result", "goal-pass"));

Deno.test("A stopped dedicated recheck cannot prove a formal goal using its staged passing receipt", () =>
  verifyReceiptFamily("native workflow result", "goal-stop"));

Deno.test("Interactive Sentinel recheck context rejects withdrawn case access", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Allowed application" },
          { id: "other", kind: "asset", label: "Other application" },
        ],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path, {
      goal: "Review retained control evidence",
    });
    assert(state.plan.runId);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    const journal = openSentinelWorkerFindingStore(path);
    const time = Date.now();
    const original = journal.recordFinding({
      caseId: "main",
      runId: state.plan.runId,
      evidenceRevision: state.revision,
      taskId: "original-worker",
      targetId: "app",
      graphFindingId: "previous-failure",
      controlId: "control",
      evidenceId: "retained-result",
      snapshotDigest: digestSentinelSnapshot(snapshot),
      observedAt: new Date(time - 1000).toISOString(),
      evaluatedAt: new Date(time).toISOString(),
      validUntil: new Date(time + 60000).toISOString(),
      requestId: crypto.randomUUID(),
      title: "Retained control finding",
      summary: "Authorized original observation.",
    });
    journal.close();
    assert(original);
    let result = "";
    let findingTool = context;
    let findingArgs: Record<string, unknown> = { findingId: original.id };
    let revokeOnResponse = false;
    let denyHistoryPre = false;
    const retainedFindingMarker = "Authorized original observation.";
    const memorySeen: boolean[] = [];
    const setPolicy = (expectedVersion: number, asset: string) =>
      assert(recordSentinelOperatingConstraints(path, {
        runId: state.plan.runId!,
        evidenceRevision: state.revision,
        expectedVersion,
        requestId: crypto.randomUUID(),
        operatorScope: "owner",
        constraints: { allowedAssetIds: [asset], deniedKinds: [] },
      }));
    let permitted = 0;
    const registry = createProviderRegistry();
    registry.register({
      name: "interactive-finding-context",
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        const memoryCheck = last?.role === "user" &&
          String(last.content).includes("Check prior context");
        if (memoryCheck) {
          memorySeen.push(
            JSON.stringify(messages).includes(retainedFindingMarker),
          );
        }
        const response = memoryCheck || last?.role === "tool";
        if (last?.role === "tool") result = String(last.content);
        return Promise.resolve({
          content: response ? "Reviewed the retained context." : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: response ? [] : [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: findingTool,
              arguments: JSON.stringify(findingArgs),
            },
          }],
        });
      },
    });
    registry.setDefault("interactive-finding-context");
    const chat = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "interactive-finding-context" as ChannelId,
        bumpersEnabled: false,
      }),
      providerRegistry: registry,
      sentinelSnapshotPath: path,
      allowSentinelModelAccess: true,
      hookRunner: {
        evaluateHook(hook, { input }) {
          if (
            hook === "POST_TOOL_RESPONSE" && input.tool_name === context &&
            typeof input.tool_response === "string" &&
            input.tool_response.startsWith("{")
          ) {
            permitted++;
            if (revokeOnResponse) {
              setPolicy(2, "other");
            }
          }
          const allowed = !(denyHistoryPre && hook === "PRE_TOOL_CALL" &&
            input.tool_name === context);
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    });
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({ token, port: 0, chatSession: chat });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve(), { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const turn = async (content: string) => {
        const completed = Promise.withResolvers<void>();
        const timer = setTimeout(
          () => completed.reject(new Error("No Sentinel response")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          if (frame.type === "error") {
            completed.reject(new Error(`${content}: ${frame.message}`));
          }
          if (frame.type === "turn_end") completed.resolve();
        };
        socket.addEventListener("message", receive);
        try {
          socket.send(JSON.stringify({ type: "message", content }));
          await completed.promise;
        } finally {
          clearTimeout(timer);
          socket.removeEventListener("message", receive);
        }
      };
      await turn("/sentinel on");
      await turn("Read this retained finding for remediation.");
      assertEquals(JSON.parse(result).finding.id, original.id);
      await turn("Check prior context while the saved read remains allowed.");
      denyHistoryPre = true;
      await turn("Check prior context after the read policy denies replay.");
      denyHistoryPre = false;
      await turn("Reopen this retained finding for remediation.");
      assertEquals(JSON.parse(result).finding.id, original.id);
      setPolicy(0, "other");
      await turn("Check prior context after case membership narrows.");
      assertEquals(memorySeen, [true, false, false]);

      setPolicy(1, "app");
      await turn("/sentinel off");
      await turn("/sentinel on");
      revokeOnResponse = true;
      await turn("Review the same finding again.");
      assertEquals(result, "Tool response withheld by policy.");
      revokeOnResponse = false;
      await turn("Read the same exact finding a third time.");
      assertStringIncludes(result, "unavailable");
      setPolicy(3, "app");
      await turn("/sentinel off");
      await turn("/sentinel on");
      findingTool = findings;
      findingArgs = { receiptId: original.id };
      await turn("Read the exact retained worker receipt.");
      assertEquals(JSON.parse(result).record.id, original.id);
      await turn("Check prior context with the receipt still allowed.");
      setPolicy(4, "other");
      await turn("Check prior context after access to the receipt changes.");
      assertEquals(memorySeen, [true, false, false, true, false]);
      await turn("Read the withdrawn exact worker receipt.");
      assertStringIncludes(result, "unavailable");
      findingArgs = { beforeReceiptId: original.id };
      await turn("Page from the withdrawn saved worker receipt.");
      assertStringIncludes(result, "unavailable");
      findingArgs = {};
      await turn("List available worker receipts.");
      assertEquals(JSON.parse(result).records, []);
      findingTool = context;
      findingArgs = { findingId: original.id };
      assert(stopSentinelAssessment(path));
      const next = startSentinelAssessment(path);
      assert(next.plan.runId && next.plan.runId !== state.plan.runId);
      await turn("/sentinel off");
      await turn("/sentinel on");
      await turn("Read the earlier run's exact finding.");
      assertStringIncludes(result, "unavailable");
      assertEquals(permitted, 4);
    } finally {
      socket.close();
      await closed.promise;
      await gateway.stop();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Reviewed analyst publications retain exact actor provenance through gateway restore", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "analyst-publication";
  const path = resolveSentinelCasePath(baseDir, caseId);
  try {
    const now = Date.now();
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Application" },
          {
            id: "gap",
            kind: "finding",
            label: "Control gap",
            severity: "high",
          },
          { id: "control", kind: "control", label: "Required control" },
          {
            id: "check",
            kind: "evidence",
            label: "Retained failed check",
            controlVerification: {
              outcome: "fail",
              observedAt: new Date(now - 60_000).toISOString(),
              validUntil: new Date(now + 3_600_000).toISOString(),
            },
          },
        ],
        edges: [
          { from: "check", to: "app", relation: "observed_on" },
          { from: "gap", to: "app", relation: "affects" },
          { from: "control", to: "gap", relation: "mitigates" },
          { from: "check", to: "control", relation: "verifies" },
        ],
      }),
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const ref = { kind: "sentinel", id: caseId, revision: state.revision };
    const setReviewPolicy = (
      deniedKinds: readonly ["review_finding"] | readonly [],
    ) =>
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: state.revision,
        operatorScope: "owner",
        requestId: crypto.randomUUID(),
        expectedVersion:
          readSentinelOperatingConstraints(path, runId)?.version ?? 0,
        constraints: { allowedAssetIds: ["app"], deniedKinds },
      }));
    setReviewPolicy([]);
    let narrowOnApproval = false;
    let revokeRootOnApproval = false;
    let revokeRoot = false;
    const policy = (hook: string, input: Record<string, unknown>) =>
      !revokeRoot || hook !== "PRE_TOOL_CALL" ||
      (input.tool_call as { args?: { action?: string } } | undefined)?.args
          ?.action !== "publish_finding";
    const confirm = () => {
      if (narrowOnApproval) setReviewPolicy(["review_finding"]);
      if (revokeRootOnApproval) revokeRoot = true;
      return Promise.resolve(true);
    };
    let publish: Record<string, unknown> = {};
    let preview: Record<string, unknown> = {};
    let publication: unknown;
    let linked: Record<string, unknown> = {};
    let sharedSource: unknown;
    const archiveId = crypto.randomUUID();
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      const recorded = JSON.parse(
        await turn({
          ...ref,
          runId,
          action: "record_analyst_finding",
          requestId: crypto.randomUUID(),
          targetId: "app",
          findingId: "gap",
          controlId: "control",
          evidenceId: "check",
          title: "Retained required control failure",
          summary: "The exact local verification failed.",
        }),
      ).receipt;
      assertEquals(recorded.analyst, { operatorScope: "owner" });
      preview = {
        ...ref,
        action: "preview_finding_publication",
        receiptId: recorded.id,
      };
      const draft = JSON.parse(await turn(preview)).preview;
      const origin = draft.finding.workerFindingSource;
      assertEquals(origin.analyst, recorded.analyst);
      assertEquals(origin.taskId, undefined);
      assertEquals(origin.evidenceId, recorded.evidenceId);
      assertEquals(origin.snapshotDigest, recorded.snapshotDigest);
      publish = {
        ...preview,
        action: "publish_finding",
        requestId: crypto.randomUUID(),
        reportVersion: origin.reportVersion,
        evidenceVersion: draft.evidenceVersion,
      };
      revokeRootOnApproval = true;
      assertStringIncludes(await turn(publish), "unavailable");
      assertEquals(readSentinelWorkerFindingPublications(path, caseId), []);
      revokeRoot = false;
      revokeRootOnApproval = false;
      narrowOnApproval = true;
      assertStringIncludes(await turn(publish), "unavailable");
      assertEquals(readSentinelWorkerFindingPublications(path, caseId), []);
      assertStringIncludes(await turn(preview), "unavailable");
      narrowOnApproval = false;
      setReviewPolicy([]);
      publication = JSON.parse(await turn(publish)).publication;
      assertEquals(JSON.parse(await turn(publish)).publication, publication);
      const consumerCase = "analyst-publication-recipient";
      const consumerPath = resolveSentinelCasePath(baseDir, consumerCase);
      await Deno.mkdir(dirname(consumerPath), { recursive: true });
      await Deno.writeTextFile(
        consumerPath,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "app", kind: "asset", label: "Application" }],
          edges: [],
        }),
      );
      const consumer = JSON.parse(
        await turn({
          ...ref,
          action: "spawn",
          targetKind: "sentinel",
          targetId: consumerCase,
          requestId: crypto.randomUUID(),
          sourceCases: [{ caseId, revision: state.revision }],
        }),
      ).run;
      assertEquals(consumer.ref.id, consumerCase);
      const consumerState = readSentinelAssessment(consumerPath);
      assert(consumerState?.plan.runId);
      const consumerRef = {
        kind: "sentinel",
        id: consumerCase,
        revision: consumerState.revision,
      };
      const membership = resolveSentinelCaseMembership(
        consumerState.result?.sharedGraph.snapshot,
        {
          caseId: consumerCase,
          evidenceRevision: consumerState.revision,
          selector: { kind: "assets", assetIds: ["app"] },
        },
      );
      assert(membership);
      assert(recordSentinelOperatingConstraints(consumerPath, {
        runId: consumerState.plan.runId,
        evidenceRevision: consumerState.revision,
        expectedVersion: 0,
        operatorScope: "owner",
        requestId: crypto.randomUUID(),
        constraints: { allowedAssetIds: membership.assetIds, deniedKinds: [] },
        membership,
      }));
      const catalog = JSON.parse(
        await turn({
          ...consumerRef,
          action: "linked_findings",
          assetId: "app",
          sourceCase: caseId,
        }),
      ).entries;
      assertEquals(catalog.length, 1);
      assertEquals(catalog[0].source, origin);
      linked = {
        ...consumerRef,
        action: "linked_finding",
        linkedFinding: catalog[0].selector,
      };
      const exact = JSON.parse(await turn(linked));
      assertEquals(exact.source, origin);
      assertEquals(exact.detail.finding.id, recorded.id);
      sharedSource = exact.source;
      assertEquals(
        JSON.parse(await turn({ ...ref, runId, action: "cancel" })).run.status,
        "stopped",
      );
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
    }, policy);
    await Deno.rename(
      dirname(path),
      join(baseDir, "before-analyst-publication-restore"),
    );
    await withFindingAssignmentGateway(baseDir, confirm, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            runId,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      assertEquals(JSON.parse(await turn(preview)).publication, publication);
      assertEquals(JSON.parse(await turn(publish)).publication, publication);
      assertEquals(JSON.parse(await turn(linked)).source, sharedSource);
      setReviewPolicy(["review_finding"]);
      assertStringIncludes(await turn(linked), "unavailable");
      assertStringIncludes(await turn(preview), "unavailable");
      assertStringIncludes(await turn(publish), "unavailable");
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
