import { assert, assertEquals, assertFalse } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  createSentinelWorkerPool,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { readSentinelSharedAssetDiscoveries } from "../../src/gateway/sentinel_asset_discoveries.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { sentinelAssessmentModelRouting } from "../../src/gateway/sentinel_model_routing.ts";
import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

interface WorkerStatus {
  readonly taskId: string;
  readonly status: string;
  readonly lastSteering?: {
    readonly requestId: string;
    readonly appliedAt?: string;
  };
  readonly progressSteps?: readonly {
    readonly tool: string;
    readonly outcome: string;
  }[];
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(condition(), "Timed out waiting for the live worker");
}

async function withTidepoolSocket(
  baseDir: string,
  run: (
    request: (
      type: string,
      fields?: Record<string, unknown>,
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
  const origin = `ws://127.0.0.1:${server.addr.port}`;
  const unauthorized = new WebSocket(origin);
  const socket = new WebSocket(`${origin}/?key=${key}`);
  try {
    const rejected = Promise.withResolvers<number>();
    unauthorized.addEventListener(
      "close",
      (event) => rejected.resolve(event.code),
      { once: true },
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    assertEquals(await rejected.promise, 4401);
    let sequence = 0;
    await run((type, fields = {}) => {
      const requestId = ++sequence;
      const reply = Promise.withResolvers<Record<string, unknown>>();
      const timeout = setTimeout(
        () => reply.reject(new Error("No Tidepool reply")),
        3_000,
      );
      function receive(event: MessageEvent) {
        const value = JSON.parse(event.data);
        if (value.requestId === requestId && value.topic === "sentinel") {
          reply.resolve(value);
        }
      }
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({ topic: "sentinel", type, requestId, ...fields }),
      );
      return reply.promise.finally(() => {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
      });
    });
  } finally {
    unauthorized.close();
    socket.close();
    await server.shutdown();
  }
}

async function withOwnerControl(
  baseDir: string,
  run: (
    request: (args: Record<string, unknown>) => Promise<string>,
    approvals: string[],
  ) => Promise<void>,
  sentinelProfiles?: Parameters<
    typeof createOperatorRunToolExecutor
  >[0]["sentinelProfiles"],
  allowCall: () => boolean = () => true,
  options: {
    sentinelMode?: boolean;
    onConfirm?: () => void;
    graphRetries?: boolean;
    deniesSavedTarget?: (hook: string) => boolean;
  } = {},
) {
  const approvals: string[] = [];
  const providers = createProviderRegistry();
  let next: Record<string, unknown> | undefined;
  let result = "";
  let callId = 0;
  providers.register({
    name: "owner-control",
    supportsStreaming: false,
    complete(messages, tools) {
      const args = next;
      if (args && options.sentinelMode) {
        const definition = (tools as {
          function?: {
            name?: string;
            parameters?: { properties?: { action?: { enum?: string[] } } };
          };
        }[]).find((tool) => tool.function?.name === "operator_runs");
        const actions = definition?.function?.parameters?.properties?.action
          ?.enum;
        assert(actions);
        assert(actions.includes("steer"));
        assert(!actions.includes("stop"));
        assert(!actions.includes("hint"));
        assert(actions.includes("hint_batch"));
      }
      next = undefined;
      if (!args) {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        content: args ? "" : "Control request inspected.",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: args
          ? [{
            id: `owner-control-${++callId}`,
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }]
          : [],
      });
    },
  });
  providers.setDefault("owner-control");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "owner-control" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: providers,
    ...(options.sentinelMode && {
      sentinelSnapshotPath: resolveSentinelCasePath(baseDir),
      allowSentinelModelAccess: true,
    }),
    hookRunner: {
      evaluateHook(hook, { session, input, auditInput }) {
        const allowed =
          (hook !== "PRE_TOOL_CALL" || !input.tool_call || allowCall()) &&
          (input.tool_name !== "sentinel_assigned_target" ||
            !options.deniesSavedTarget?.(hook));
        if (
          hook === "POST_TOOL_RESPONSE" && input.tool_name === "operator_runs"
        ) {
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
          if (
            typeof input.tool_response === "string" &&
            input.tool_response.startsWith("{")
          ) {
            assertEquals(session.taint, "INTERNAL");
          }
        }
        if (hook === "PRE_OUTPUT") {
          assertEquals(input.target_classification, session.taint);
        }
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    },
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      sentinelProfiles,
      sentinelModelAccess: options.graphRetries,
      confirm(message) {
        approvals.push(message);
        options.onConfirm?.();
        return Promise.resolve(true);
      },
    }),
    enableStreaming: false,
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = (content: string) => {
      result = "";
      const reply = Promise.withResolvers<string>();
      const timer = setTimeout(
        () => reply.reject(new Error("No owner worker control result")),
        3000,
      );
      function receive(event: MessageEvent) {
        if (JSON.parse(event.data).type === "turn_end") reply.resolve(result);
      }
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          type: "message",
          content,
        }),
      );
      return reply.promise.finally(() => {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      });
    };
    if (options.sentinelMode) await turn("/sentinel on");
    await run((args) => {
      next = args;
      return turn("Use the exact requested Sentinel worker control.");
    }, approvals);
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

Deno.test("Owner socket steers and stops one exact leased worker with a shared Tidepool receipt", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let sawRead = false;
  const releaseStaleDecision = Promise.withResolvers<void>();
  let sawSteering = false;
  const releaseStoppedDecision = Promise.withResolvers<void>();
  const guidance =
    "Review the assigned inventory source before drawing a conclusion.";
  const steerId = crypto.randomUUID();
  const stopId = crypto.randomUUID();
  const usage = { inputTokens: 1, outputTokens: 1 };
  let modelCalls = 0;
  let toolCalls = 0;
  let assignedWorkers = 0;
  let seenResults: string[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook) {
      if (hook === "PRE_TOOL_CALL") toolCalls++;
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const registry = createProviderRegistry();
  const read = (id: string) => ({
    content: "",
    usage,
    toolCalls: [{
      id,
      type: "function",
      function: { name: "sentinel_assigned_target", arguments: "{}" },
    }],
  });
  registry.register({
    name: "worker-control-fixture",
    supportsStreaming: false,
    async complete(messages, tools) {
      modelCalls++;
      const results = messages.filter(({ role }) => role === "tool").map((
        { content },
      ) => String(content));
      const notes = messages.filter(({ role, content }) =>
        role === "user" && String(content).includes(guidance)
      );
      if (modelCalls === 1) return read("initial");
      if (modelCalls === 2) {
        assertEquals(results.length, 1);
        assert(results[0].includes("primary-asset"));
        seenResults = results;
        assertEquals(notes.length, 0);
        sawRead = true;
        await releaseStaleDecision.promise;
        return read("superseded-by-steering");
      }
      if (modelCalls === 4 || modelCalls === 5) {
        const definitions = tools as { function?: { name?: string } }[];
        assertEquals(definitions.map(({ function: tool }) => tool?.name), [
          "sentinel_assigned_target",
        ]);
        assertEquals(notes, []);
        if (modelCalls === 4) {
          assertEquals(results, []);
          return read("fresh-approved-retry");
        }
        assertEquals(results.length, 1);
        assert(results[0].includes("primary-asset"));
        return {
          content: JSON.stringify({
            summary: "Reviewed the pinned local graph in the fresh assignment.",
            followUps: [{ kind: "trace", nodeId: "primary-asset" }],
          }),
          usage,
          toolCalls: [],
        };
      }
      assertEquals(modelCalls, 3);
      assertEquals(results, seenResults);
      assertEquals(notes.length, 1);
      sawSteering = true;
      await releaseStoppedDecision.promise;
      return read("superseded-by-stop");
    },
  });
  registry.setDefault("worker-control-fixture");
  const makePlanner = () =>
    createSentinelModelPlanner(path, (state, taskId, token) => {
      if (!taskId || !token) {
        return {
          execute(_content, send) {
            send({
              type: "response",
              text: '[{"kind":"impact","nodeId":"primary-asset"}]',
              taint: "INTERNAL",
            });
            return Promise.resolve();
          },
          clear() {},
        };
      }
      assignedWorkers++;
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        hookRunner,
        providerRegistry: registry,
        allowModelAccess: true,
      });
    });
  const planner = makePlanner();
  const adaptive = () => {
    const current = readSentinelAssessment(path);
    return current && readAdaptiveSentinel(path, current);
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          {
            kind: "asset",
            id: "primary-asset",
            label: "Primary inventory asset",
          },
          {
            kind: "asset",
            id: "unrelated-asset",
            label: "Unrelated inventory asset",
          },
          {
            kind: "evidence",
            id: "source-record",
            label: "Approved inventory record",
          },
        ],
        edges: [{
          from: "source-record",
          to: "primary-asset",
          relation: "observed_on",
        }],
      }),
    );
    let fields: Record<string, unknown> = {};
    let stopReceipt: unknown;
    await withTidepoolSocket(baseDir, async (request) => {
      assertEquals(
        (await request("start", { goal: "Review approved inventory." })).type,
        "sentinel_state",
      );
      const initial = adaptive();
      assert(initial);
      const started = readSentinelAssessment(path);
      assert(started);
      planner.advance(started);
      await until(() =>
        adaptive()?.tasks.some(({ nodeId, status }) =>
          nodeId === "primary-asset" && status === "completed"
        ) === true
      );
      const target = adaptive()?.tasks.find(({ nodeId }) =>
        nodeId === "primary-asset"
      );
      assert(target);
      const assessment = readSentinelAssessment(path);
      assert(assessment);
      planner.advance(assessment);
      await until(() => sawRead);
      const status = await request("worker_status");
      assertEquals(status.type, "sentinel_worker_status");
      assertEquals(status.revision, initial.revision);
      const worker = (status.workers as WorkerStatus[]).find(({ taskId }) =>
        taskId === target.id
      );
      assertEquals(worker?.status, "running");
      assertEquals(
        worker?.progressSteps?.map(({ tool, outcome }) => [tool, outcome]),
        [
          ["sentinel_assigned_target", "returned"],
        ],
      );
      fields = { revision: initial.revision, taskId: target.id };
      const steer = {
        ...fields,
        controlRequestId: steerId,
        note: guidance,
      };
      assertEquals(
        (await request("worker_steer", { ...steer, revision: "stale" })).type,
        "error",
      );
      assertEquals(
        (await request("worker_steer", {
          ...steer,
          taskId: `adaptive:${"0".repeat(64)}`,
        })).type,
        "error",
      );
      const rootRef = {
        kind: "sentinel",
        id: "main",
        revision: assessment.revision,
      };
      const rootScope = {
        ...rootRef,
        runId: assessment.plan.runId,
        adaptiveRevision: initial.revision,
        taskId: target.id,
      };
      let rootSteering: unknown;
      await withOwnerControl(baseDir, async (owner, approvals) => {
        const inspection = JSON.parse(
          await owner({ action: "inspect", ...rootRef }),
        );
        assertEquals(inspection.run.details.adaptiveRevision, initial.revision);
        assertEquals(inspection.run.details.runId, assessment.plan.runId);
        const workers = JSON.parse(
          await owner({ action: "list_trace_workers", ...rootRef }),
        );
        const live = workers.page.workers.find((
          { taskId }: { taskId: string },
        ) => taskId === target.id);
        assertEquals(live.status, "running");
        assertEquals(live.stepCount, 1);
        const trace = {
          action: "worker_trace_progress",
          ...rootRef,
          taskId: target.id,
          stepIndices: [0],
        };
        const progress = JSON.parse(await owner(trace));
        assertEquals(progress.status, "running");
        assertEquals(progress.page.steps, [{
          index: 0,
          target: "primary-asset",
          tool: "sentinel_assigned_target",
          outcome: "returned",
        }]);
        assert(
          (await owner({ ...trace, stepIndices: [1] })).includes("unavailable"),
        );
        assert(
          (await owner({ ...trace, revision: rootRef.revision + 1 })).includes(
            "unavailable",
          ),
        );
        assertEquals(approvals, []);
      });
      const command = {
        action: "steer",
        ...rootScope,
        requestId: steerId,
        note: guidance,
      };
      let allowSteering = true;
      let revokeWhenConfirmed = true;
      await withOwnerControl(
        baseDir,
        async (owner, approvals) => {
          assert(
            (await owner({ ...command, adaptiveRevision: "f".repeat(64) }))
              .startsWith("Error:"),
          );
          assert(
            (await owner({ ...command, runId: crypto.randomUUID() }))
              .startsWith(
                "Error:",
              ),
          );
          assert(
            (await owner({ ...command, action: "stop", note: undefined }))
              .startsWith("Error:"),
          );
          assert(
            (await owner({ ...command, id: "other-case" })).startsWith(
              "Error:",
            ),
          );
          assert(
            (await owner({ ...command, taskId: `adaptive:${"e".repeat(64)}` }))
              .startsWith("Error:"),
          );
          assertEquals(approvals, []);
          allowSteering = false;
          await owner(command);
          assertEquals(approvals, []);
          allowSteering = true;
          assert((await owner(command)).startsWith("Error:"));
          assertEquals(approvals.length, 1);
          assert(!sawSteering);
          allowSteering = true;
          revokeWhenConfirmed = false;
          rootSteering = JSON.parse(await owner(command)).receipt;
          assert(rootSteering);
          assert(approvals[1].includes(target.id));
          assert(approvals[1].includes(initial.revision));
          assertEquals(JSON.parse(await owner(command)).receipt, rootSteering);
        },
        undefined,
        () => allowSteering,
        {
          sentinelMode: true,
          onConfirm() {
            if (revokeWhenConfirmed) allowSteering = false;
          },
        },
      );
      const accepted = await request("worker_steer", steer);
      assertEquals(
        accepted.type,
        "sentinel_worker_control",
        JSON.stringify(accepted),
      );
      assertEquals(accepted.receipt, rootSteering);
      assertEquals(
        (await request("worker_steer", steer)).type,
        "sentinel_worker_control",
      );
      assertEquals(
        (await request("worker_steer", { ...steer, note: "Changed request" }))
          .type,
        "error",
      );

      releaseStaleDecision.resolve();
      await until(() => sawSteering);
      const active = (await request("worker_status")).workers as WorkerStatus[];
      const activeWorker = active.find(({ taskId }) => taskId === target.id);
      assertEquals(activeWorker?.lastSteering?.requestId, steerId);
      assert(activeWorker?.lastSteering?.appliedAt);
      await withOwnerControl(baseDir, async (owner, approvals) => {
        const command = { action: "stop", ...rootScope, requestId: stopId };
        assert(
          (await owner({ ...command, note: "Invalid stop note" })).startsWith(
            "Error:",
          ),
        );
        assertEquals(approvals, []);
        const stopped = JSON.parse(await owner(command));
        stopReceipt = stopped.receipt;
        assert(stopReceipt);
        assertEquals(stopped.run, rootRef);
      });
      releaseStoppedDecision.resolve();
      await until(() => !planner.hasInFlightWork());
      assertEquals(toolCalls, 1);
      assertEquals(assignedWorkers, 1);
      assertEquals(modelCalls, 3);
      assertFalse(
        adaptive()?.modelReviews.some(({ taskId }) => taskId === target.id),
      );
    });

    await withTidepoolSocket(baseDir, async (request) => {
      const status = await request("worker_status");
      assertEquals(status.type, "sentinel_worker_status");
      assert((status.workers as { taskId: string; status: string }[]).some(
        ({ taskId, status }) =>
          taskId === fields.taskId && status === "stopped",
      ));
      let denySourceHook: string | undefined;
      await withOwnerControl(
        baseDir,
        async (owner) => {
          const state = readSentinelAssessment(path)!;
          const progress = JSON.parse(
            await owner({
              action: "worker_trace_progress",
              kind: "sentinel",
              id: "main",
              revision: state.revision,
              taskId: fields.taskId,
              stepIndices: [0],
            }),
          );
          assertEquals(progress.status, "stopped");
          assertEquals(progress.page.steps[0].tool, "sentinel_assigned_target");
          const latest = {
            action: "worker_trace_result",
            kind: "sentinel",
            id: "main",
            revision: state.revision,
            taskId: fields.taskId,
            latestResult: true,
          };
          const output = JSON.parse(await owner(latest));
          assertEquals(output.status, "stopped");
          assertEquals(output.index, 0);
          assertEquals(output.result, JSON.parse(seenResults[0]));
          assert(
            (await owner({ ...latest, stepIndices: [0] })).includes(
              "unavailable",
            ),
          );
          assert(
            (await owner({ ...latest, revision: state.revision + 1 })).includes(
              "unavailable",
            ),
          );
          for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]) {
            denySourceHook = hook;
            assert((await owner(latest)).includes("unavailable"));
          }
          denySourceHook = undefined;
          assertEquals(JSON.parse(await owner(latest)), output);
        },
        undefined,
        undefined,
        {
          sentinelMode: true,
          deniesSavedTarget: (hook) => hook === denySourceHook,
        },
      );
      const duplicate = await request("worker_stop", {
        ...fields,
        controlRequestId: stopId,
      });
      assertEquals(duplicate.type, "sentinel_worker_control");
      assertEquals(duplicate.receipt, stopReceipt);
      assertEquals(
        (await request("worker_steer", {
          ...fields,
          controlRequestId: stopId,
          note: "Conflicting reuse of the stop ID",
        })).type,
        "error",
      );
      assertEquals((await request("retry_model_review", fields)).type, "error");
      const current = readSentinelAssessment(path);
      assert(current);
      const restarted = makePlanner();
      try {
        advanceAdaptiveSentinel(path, current);
        restarted.advance(current);
        await until(() => !restarted.hasInFlightWork());
        assertEquals(assignedWorkers, 1);
        assertEquals(modelCalls, 3);
        assertEquals(toolCalls, 1);
        const retry = {
          action: "retry_model_review",
          kind: "sentinel",
          id: "main",
          revision: current.revision,
          runId: current.plan.runId,
          adaptiveRevision: fields.revision,
          taskId: fields.taskId,
          stopRequestId: stopId,
          requestId: crypto.randomUUID(),
        };
        let child: string | undefined;
        let allowRetry = true;
        let revokeRetryOnConfirmation = true;
        await withOwnerControl(
          baseDir,
          async (owner, approvals) => {
            assert(
              (await owner({ ...retry, stopRequestId: crypto.randomUUID() }))
                .startsWith("Error:"),
            );
            assert(
              (await owner({ ...retry, revision: current.revision + 1 }))
                .startsWith("Error:"),
            );
            assertEquals(approvals, []);
            assert((await owner(retry)).startsWith("Error:"));
            assertEquals(approvals.length, 1);
            assertEquals(assignedWorkers, 1);
            allowRetry = true;
            revokeRetryOnConfirmation = false;
            const admitted = JSON.parse(await owner(retry));
            assertEquals(admitted.sourceTaskId, fields.taskId);
            assertEquals(admitted.stopRequestId, stopId);
            child = admitted.receipt.taskId;
            assert(child && child !== fields.taskId);
            assertEquals(JSON.parse(await owner(retry)), admitted);
            assert(
              (await owner({ ...retry, requestId: crypto.randomUUID() }))
                .startsWith("Error:"),
            );
            assertEquals(approvals.length, 2);
          },
          undefined,
          () => allowRetry,
          {
            graphRetries: true,
            onConfirm() {
              if (revokeRetryOnConfirmation) allowRetry = false;
            },
          },
        );
        assert(child);
        restarted.advance(current);
        await until(() =>
          adaptive()?.modelReviews.some(({ taskId }) => taskId === child) ===
            true
        );
        assertEquals(assignedWorkers, 2);
        assertEquals(modelCalls, 5);
        assertEquals(toolCalls, 2);
        assertFalse(
          adaptive()?.modelReviews.some(({ taskId }) =>
            taskId === fields.taskId
          ),
        );
        const reusedStop = await request("worker_stop", {
          ...fields,
          controlRequestId: stopId,
        });
        assertEquals(reusedStop.receipt, stopReceipt);
        const projected = (await request("worker_status"))
          .workers as WorkerStatus[];
        assertEquals(
          projected.find(({ taskId }) => taskId === fields.taskId)?.status,
          "stopped",
        );
        assertEquals(
          projected.find(({ taskId }) => taskId === child)?.status,
          "completed",
        );
      } finally {
        restarted.stop();
      }
    });
  } finally {
    releaseStaleDecision.resolve();
    releaseStoppedDecision.resolve();
    planner.stop();
    await until(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});

async function verifyPausedGraphWorker(cold: boolean, denySavedRead = false) {
  const baseDir = await Deno.makeTempDir();
  const caseId = cold ? "portable-worker" : "main";
  const path = resolveSentinelCasePath(baseDir, caseId);
  let blockedSavedRead = 0;
  let enforceReadRevocation = false;
  const release = Promise.withResolvers<void>();
  const releasePeer = Promise.withResolvers<void>();
  let peerStarted = false;
  const usage = { inputTokens: 1, outputTokens: 1 };
  const sourceCalls = new Map<string, number>();
  let heldStep = false;
  let reused = false;
  let peerCompleted = false;
  const provider = (id: string) => {
    const registry = createProviderRegistry();
    const name = `hold-fixture-${id}`;
    registry.register({
      name,
      supportsStreaming: false,
      async complete(messages) {
        const saved = messages.findLast(({ role }) => role === "tool");
        if (!saved) {
          sourceCalls.set(id, (sourceCalls.get(id) ?? 0) + 1);
          return {
            content: "",
            usage,
            toolCalls: [{
              id: `read-${id}`,
              type: "function",
              function: { name: "sentinel_assigned_target", arguments: "{}" },
            }],
          };
        }
        assert(String(saved.content).includes(id));
        if (id === "held-graph") {
          if (!heldStep) {
            heldStep = true;
            await release.promise;
          } else reused = true;
        } else {
          peerStarted = true;
          await releasePeer.promise;
          peerCompleted = true;
        }
        return {
          content: JSON.stringify({
            summary: "Reviewed the pinned local target.",
          }),
          usage,
          toolCalls: [],
        };
      },
    });
    registry.setDefault(name);
    return registry;
  };
  const heldProvider = provider("held-graph");
  const peerProvider = provider("peer-graph");
  const workerPool = createSentinelWorkerPool(2);
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input }) {
      if (
        enforceReadRevocation && hook === "PRE_TOOL_CALL" &&
        input.tool_name === "sentinel_assigned_target"
      ) {
        blockedSavedRead++;
        return Promise.resolve({
          allowed: false,
          action: "BLOCK",
          ruleId: null,
          duration: 0,
        });
      }
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const adaptive = () => {
    const state = readSentinelAssessment(path);
    return state && readAdaptiveSentinel(path, state);
  };
  const planners: ReturnType<typeof createSentinelModelPlanner>[] = [];
  const startPlanner = () => {
    const planner = createSentinelModelPlanner(path, (state, taskId, token) => {
      if (!taskId || !token) {
        return {
          execute(_content, send) {
            send({
              type: "response",
              text: JSON.stringify([
                { kind: "impact", nodeId: "held-graph" },
                { kind: "impact", nodeId: "peer-graph" },
              ]),
              taint: "INTERNAL",
            });
            return Promise.resolve();
          },
          clear() {},
        };
      }
      const target = adaptive()?.tasks.find(({ id }) => id === taskId)?.nodeId;
      const registry = target === "held-graph" ? heldProvider : peerProvider;
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        hookRunner,
        providerRegistry: registry,
        allowModelAccess: true,
      });
    }, () => workerPool(path));
    planners.push(planner);
    return planner;
  };
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: ["held-graph", "peer-graph"].map((id) => ({
          kind: "asset",
          id,
          label: id,
        })),
        edges: [],
      }),
    );
    const initial = startSentinelAssessment(path, {
      goal: "Review two graph assets.",
    });
    advanceAdaptiveSentinel(path, initial);
    const first = startPlanner();
    first.advance(initial);
    await until(() =>
      !!adaptive()?.tasks.find(({ nodeId, status }) =>
        nodeId === "held-graph" && status === "completed"
      )
    );
    first.advance(initial);
    await until(() => heldStep);
    const status = adaptive()!;
    const held = status.tasks.find(({ nodeId }) => nodeId === "held-graph")!;
    const pause = {
      action: "pause_assignment",
      kind: "sentinel",
      id: caseId,
      revision: initial.revision,
      runId: initial.plan.runId,
      adaptiveRevision: status.revision,
      taskId: held.id,
      attempt: 1,
      requestId: crypto.randomUUID(),
    };
    let pauseReceipt: unknown;
    await withOwnerControl(baseDir, async (request, approvals) => {
      assert((await request({ ...pause, attempt: 2 })).includes("unavailable"));
      assertEquals(approvals.length, 0);
      pauseReceipt = JSON.parse(await request(pause)).receipt;
      assertEquals(approvals.length, 1);
      assertEquals(
        adaptive()?.modelReviewStates.find(({ taskId }) => taskId === held.id)
          ?.status,
        "paused",
      );
      first.advance(initial);
      await until(() => peerStarted);
      releasePeer.resolve();
      await until(() => peerCompleted);
      assertEquals(sourceCalls.get("held-graph"), 1);
    });
    first.stop();
    release.resolve();
    await until(() => !first.hasInFlightWork());
    if (cold) {
      const ref = {
        kind: "sentinel",
        id: caseId,
        revision: initial.revision,
        runId: initial.plan.runId,
      };
      const archiveId = crypto.randomUUID();
      await withOwnerControl(baseDir, async (request) => {
        assertEquals(
          JSON.parse(await request({ action: "cancel", ...ref })).run.status,
          "stopped",
        );
        assertEquals(
          JSON.parse(
            await request({ action: "archive", ...ref, requestId: archiveId }),
          ).receipt.status,
          "succeeded",
        );
      });
      await Deno.rename(dirname(path), join(baseDir, "removed-live-case"));
      assertEquals(readSentinelAssessment(path), undefined);
      await withOwnerControl(baseDir, async (request) => {
        assertEquals(
          JSON.parse(
            await request({
              action: "restore",
              ...ref,
              archiveId,
              requestId: crypto.randomUUID(),
            }),
          ).receipt.status,
          "succeeded",
        );
        assertEquals(readSentinelAssessment(path)?.paused, true);
        assertEquals(
          JSON.parse(await request({ action: "resume", ...ref })).run.status,
          "running",
        );
        assertEquals(readSentinelAssessment(path)?.revision, initial.revision);
      });
    }
    const resumed = startPlanner();
    const resume = {
      ...pause,
      action: "resume_assignment",
      requestId: crypto.randomUUID(),
    };
    let revoked = false;
    await withOwnerControl(
      baseDir,
      async (request, approvals) => {
        assert((await request(resume)).includes("unavailable"));
        assertEquals(approvals.length, 1);
        assertEquals(
          adaptive()?.modelReviewStates.find(({ taskId }) => taskId === held.id)
            ?.status,
          "paused",
        );
      },
      undefined,
      () => !revoked,
      {
        onConfirm: () => {
          revoked = true;
        },
      },
    );
    await withOwnerControl(baseDir, async (request, approvals) => {
      assertEquals(JSON.parse(await request(pause)).receipt, pauseReceipt);
      assertEquals(approvals.length, 0);
      const receipt = JSON.parse(await request(resume)).receipt;
      assertEquals(receipt.action, "resume_assignment");
      assertEquals(JSON.parse(await request(resume)).receipt, receipt);
      assertEquals(approvals.length, 1);
    });
    enforceReadRevocation = denySavedRead;
    resumed.advance(readSentinelAssessment(path)!);
    if (denySavedRead) {
      await until(() => blockedSavedRead > 0 && !resumed.hasInFlightWork());
      assertEquals(reused, false);
      assertEquals(sourceCalls.get("held-graph"), 1);
      return;
    }
    await until(() => reused);
    assertEquals(sourceCalls.get("held-graph"), 1);
    await until(() =>
      adaptive()?.modelReviewStates.some(({ taskId, status }) =>
        taskId === held.id && status === "completed"
      ) === true
    );
  } finally {
    release.resolve();
    releasePeer.resolve();
    for (const planner of planners) planner.stop();
    for (const planner of planners) {
      await until(() => !planner.hasInFlightWork());
    }
    await Deno.remove(baseDir, { recursive: true });
  }
}

Deno.test("Owner gateway pauses and resumes one graph worker from its committed checkpoint", () =>
  verifyPausedGraphWorker(false));

Deno.test("Owner gateway restores a portable paused graph worker before reusing its checkpoint", () =>
  verifyPausedGraphWorker(true));

Deno.test("Owner gateway reauthorizes a portable paused graph worker before exposing its saved result", () =>
  verifyPausedGraphWorker(true, true));

Deno.test("An enabled idle planner heartbeat resumes from durable case history and respects gateway pause", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const intervalSeconds = 600;
  const interval = intervalSeconds * 1_000;
  let time = Date.now();
  const prompts: string[] = [];
  const registry = createProviderRegistry();
  registry.register({
    name: "idle-planner-fixture",
    supportsStreaming: false,
    complete(messages) {
      prompts.push(messages.map(({ content }) => String(content)).join("\n"));
      return Promise.resolve({
        content: "[]",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [],
      });
    },
  });
  registry.setDefault("idle-planner-fixture");
  const hookRunner: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  const makePlanner = () =>
    createSentinelModelPlanner(
      path,
      (state) =>
        createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          hookRunner,
          providerRegistry: registry,
          allowModelAccess: true,
        }),
      undefined,
      () => time,
      false,
      intervalSeconds,
    );
  let planner = makePlanner();
  function tick() {
    const state = readSentinelAssessment(path);
    assert(state);
    planner.advance(state);
  }
  function history() {
    const state = readSentinelAssessment(path);
    assert(state);
    return readAdaptiveSentinel(path, state, "revision")?.modelPlannerHistory ??
      [];
  }
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
    );
    await withTidepoolSocket(baseDir, async (request) => {
      assertEquals(
        (await request("start", { goal: "Review approved inventory." })).type,
        "sentinel_state",
      );
    });
    tick();
    await until(() => prompts.length === 1 && !planner.hasInFlightWork());
    const initial = history();
    assertEquals(initial.length, 1);
    assert(initial[0].finished);
    assertFalse(prompts[0].includes("idle_planner_check"));

    planner.stop();
    planner = makePlanner();
    time += interval - 1;
    tick();
    assertFalse(planner.hasInFlightWork());
    assertEquals(history(), initial);

    time += 1;
    tick();
    tick();
    await until(() => prompts.length === 2 && !planner.hasInFlightWork());
    const repeated = history();
    assertEquals(repeated.length, 2);
    assert(
      repeated[1].identity.startsWith(initial[0].identity + ":heartbeat:"),
    );
    assertEquals(repeated[1].outcome, "no_new_assignments");
    assert(prompts[1].includes("idle_planner_check"));
    planner.stop();
    planner = makePlanner();
    tick();
    assertFalse(planner.hasInFlightWork());

    const state = readSentinelAssessment(path);
    assert(state);
    const target = { kind: "sentinel", id: "main", revision: state.revision };
    await withOwnerControl(baseDir, async (request) => {
      assertEquals(
        JSON.parse(await request({ ...target, action: "pause" })).run.status,
        "paused",
      );
      time += 2 * interval;
      tick();
      assertFalse(planner.hasInFlightWork());
      assertEquals(history(), repeated);
      assertEquals(
        JSON.parse(await request({ ...target, action: "resume" })).run.status,
        "running",
      );
      tick();
      await until(() => prompts.length === 3 && !planner.hasInFlightWork());
      const resumed = readSentinelAssessment(path);
      assert(resumed);
      assert(resumed.revision > target.revision);
      assertEquals(history().length, 1);
      assertFalse(prompts[2].includes("idle_planner_check"));
      time += interval;
      tick();
      await until(() => prompts.length === 4 && !planner.hasInFlightWork());
      assertEquals(history().length, 2);
      assert(prompts[3].includes("idle_planner_check"));
    });
  } finally {
    planner.stop();
    await until(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Owner gateway selects a permitted Sentinel model for a child and omission inherits it", async () => {
  const baseDir = await Deno.makeTempDir();
  const providerRegistry = createProviderRegistry();
  const calls: string[] = [];
  for (const provider of ["default", "review", "public-only"]) {
    providerRegistry.register({
      name: provider,
      model: provider + "-model",
      supportsStreaming: false,
      complete() {
        calls.push(provider);
        return Promise.resolve({
          content: "[]",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      },
    });
  }
  providerRegistry.setDefault("default");
  const allowed = ["review"];
  const routing = sentinelAssessmentModelRouting(providerRegistry, {
    PUBLIC: ["public-only"],
    INTERNAL: allowed,
  });
  const hookRunner: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  const planners: ReturnType<typeof createSentinelModelPlanner>[] = [];
  const pathFor = (id: string) => resolveSentinelCasePath(baseDir, id);
  try {
    for (const id of ["main", "selected", "inherited", "denied", "default"]) {
      const path = pathFor(id);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({ version: 1, nodes: [], edges: [] }),
      );
    }
    await withTidepoolSocket(baseDir, async (request) => {
      assertEquals((await request("start", {})).type, "sentinel_state");
    });
    const source = readSentinelAssessment(pathFor("main"));
    assert(source);
    const root = { kind: "sentinel", id: "main", revision: source.revision };
    const profile = { provider: "review", model: "review-model" };
    await withOwnerControl(baseDir, async (request, approvals) => {
      const listed = JSON.parse(await request({ action: "profiles" }));
      assertEquals(listed.sentinelProfiles, [profile]);
      const denied = await request({
        action: "spawn",
        ...root,
        targetKind: "sentinel",
        targetId: "denied",
        requestId: crypto.randomUUID(),
        modelProfile: "public-only",
      });
      assert(denied.startsWith("Error:"));
      assertEquals(approvals.length, 0);
      assertEquals(readSentinelAssessment(pathFor("denied")), undefined);

      const proposed = {
        action: "spawn",
        ...root,
        targetKind: "sentinel",
        targetId: "selected",
        requestId: crypto.randomUUID(),
        modelProfile: "review",
      };
      const selected = JSON.parse(await request(proposed));
      assertEquals(selected.run.details.modelProfile, profile);
      assert(approvals[0].includes(JSON.stringify(profile)));
      assertEquals(JSON.parse(await request(proposed)), selected);
      assertEquals(approvals.length, 1);
      const inherited = JSON.parse(
        await request({
          action: "spawn",
          ...selected.run.ref,
          targetKind: "sentinel",
          targetId: "inherited",
          requestId: crypto.randomUUID(),
        }),
      );
      assertEquals(inherited.run.details.modelProfile, profile);
      const fallback = JSON.parse(
        await request({
          action: "spawn",
          ...root,
          targetKind: "sentinel",
          targetId: "default",
          requestId: crypto.randomUUID(),
        }),
      );
      assertEquals(fallback.run.details.modelProfile, undefined);
      const discovery =
        JSON.parse(await request({ action: "list", kind: "sentinel" })).runs;
      assertEquals(
        discovery.find(({ ref }: { ref: { id: string } }) =>
          ref.id === "selected"
        )?.details.modelProfile,
        profile,
      );
      assertEquals(
        discovery.find(({ ref }: { ref: { id: string } }) =>
          ref.id === "inherited"
        )?.details.parent,
        selected.run.ref,
      );
      assertEquals(approvals.length, 3);
    }, routing.list);
    for (const id of ["selected", "inherited", "default"]) {
      const path = pathFor(id);
      const child = readSentinelAssessment(path);
      assert(child);
      const planner = createSentinelModelPlanner(
        path,
        (state) =>
          createSentinelSubagent({
            ...routing.workerOptions(state.plan.modelProfile),
            snapshotPath: path,
            assessmentRevision: state.revision,
            plannerExecutionEvidenceRunId: state.plan.runId,
            hookRunner,
          }),
      );
      planners.push(planner);
      planner.advance(child);
      await until(() => !planner.hasInFlightWork());
    }
    assertEquals(calls, ["review", "review", "default"]);
    allowed.length = 0;
    assertFalse(routing.workerOptions(profile).allowModelAccess);
  } finally {
    for (const planner of planners) planner.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("A linked Sentinel run keeps its reviewed idle interval through exact retries and archive restore", async () => {
  const baseDir = await Deno.makeTempDir();
  const rootPath = resolveSentinelCasePath(baseDir);
  const childPath = resolveSentinelCasePath(baseDir, "idle-child");
  let time = Date.now();
  const prompts: string[] = [];
  const planner = createSentinelModelPlanner(
    childPath,
    () => ({
      execute(prompt, send) {
        prompts.push(String(prompt));
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }),
    undefined,
    () => time,
    false,
  );
  const state = () => {
    const current = readSentinelAssessment(childPath);
    assert(current);
    return current;
  };
  try {
    for (const path of [rootPath, childPath]) {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({ version: 1, nodes: [], edges: [] }),
      );
    }
    await withTidepoolSocket(baseDir, async (request) => {
      assertEquals((await request("start")).type, "sentinel_state");
    });
    const root = readSentinelAssessment(rootPath);
    assert(root);
    const spawn = {
      action: "spawn",
      kind: "sentinel",
      id: "main",
      revision: root.revision,
      targetKind: "sentinel",
      targetId: "idle-child",
      requestId: crypto.randomUUID(),
      plannerHeartbeatSeconds: 600,
    };
    await withOwnerControl(baseDir, async (request, approvals) => {
      assert((await request({
        ...spawn,
        plannerHeartbeatSeconds: 599,
      })).startsWith("Error:"));
      assertEquals(approvals.length, 0);
      const started = JSON.parse(await request(spawn));
      assertEquals(started.run.details.plannerHeartbeatSeconds, 600);
      assert(approvals[0].includes('"plannerHeartbeatSeconds":600'));
      assertEquals(JSON.parse(await request(spawn)), started);
      assert((await request({
        ...spawn,
        plannerHeartbeatSeconds: 601,
      })).startsWith("Error:"));
      assertEquals(approvals.length, 1);

      planner.advance(state());
      await until(() => prompts.length === 1 && !planner.hasInFlightWork());
      time += 599_999;
      planner.advance(state());
      assertFalse(planner.hasInFlightWork());
      time += 1;
      planner.advance(state());
      await until(() => prompts.length === 2 && !planner.hasInFlightWork());
      assert(prompts[1].includes("idle_planner_check"));

      const child = { ...started.run.ref, runId: started.run.details.runId };
      assertEquals(
        JSON.parse(
          await request({
            ...child,
            action: "cancel",
          }),
        ).run.status,
        "stopped",
      );
      const archiveId = crypto.randomUUID();
      assertEquals(
        JSON.parse(
          await request({
            ...child,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
      await Deno.rename(dirname(childPath), join(baseDir, "prior-idle-child"));
      assertEquals(
        JSON.parse(
          await request({
            ...child,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      const { run } = JSON.parse(
        await request({
          ...started.run.ref,
          action: "inspect",
        }),
      );
      assertEquals(run.status, "paused");
      assertEquals(run.details.plannerHeartbeatSeconds, 600);
      assertEquals(state().plan.plannerHeartbeatSeconds, 600);
      planner.advance(state());
      assertFalse(planner.hasInFlightWork());
    });
  } finally {
    planner.stop();
    await until(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("A linked child reuses only approved discoveries from its reviewed source revisions", async () => {
  const baseDir = await Deno.makeTempDir();
  const pathFor = (id: string) => resolveSentinelCasePath(baseDir, id);
  const makeGraph = (local = false) => ({
    version: 1,
    nodes: [
      {
        kind: "asset",
        id: local ? "local-a" : "canonical-a",
        label: "Application",
        ...(local && { aliases: ["canonical-a"] }),
      },
      {
        kind: "asset",
        id: local ? "local-b" : "canonical-b",
        label: "Dependency",
        ...(local && { aliases: ["canonical-b"] }),
      },
      { kind: "evidence", id: "record", label: "Exact source record" },
    ],
    edges: local ? [] : [
      { from: "canonical-a", to: "canonical-b", relation: "depends_on" },
      { from: "record", to: "canonical-a", relation: "observed_on" },
      { from: "record", to: "canonical-b", relation: "observed_on" },
    ],
  });
  const hooks: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  const childPath = pathFor("child");
  const childState = () => {
    const child = readSentinelAssessment(childPath);
    assert(child);
    return child;
  };
  try {
    for (const id of ["main", "approved", "excluded", "child"]) {
      const path = pathFor(id);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, JSON.stringify(makeGraph(id === "child")));
    }
    const parent = startSentinelAssessment(pathFor("main"));
    const source = startSentinelAssessment(pathFor("approved"));
    const other = startSentinelAssessment(pathFor("excluded"));
    const sourcePath = pathFor("approved");
    advanceAdaptiveSentinel(sourcePath, source);
    const sourceQueue = openSentinelAdaptiveStore(
      join(dirname(sourcePath), "sentinel-adaptive.db"),
    );
    const sourceRevision = adaptiveRevision(source);
    let sourceLease;
    try {
      sourceQueue.sync(sourceRevision, [{
        kind: "impact",
        nodeId: "canonical-a",
        reason: MODEL_ASSIGNMENT_REASON,
      }], sourceRevision);
      advanceAdaptiveSentinel(sourcePath, source);
      sourceLease = sourceQueue.claimModelReview(
        sourceRevision,
        MODEL_ASSIGNMENT_REASON,
        ({ nodeId }) => nodeId === "canonical-a",
      );
    } finally {
      sourceQueue.close();
    }
    assert(sourceLease);
    let fact:
      | { id: string; sourceStepIndex: number; resultSha256: string }
      | undefined;
    const model = createProviderRegistry();
    const factCalls = [{
      name: "sentinel_assigned_target",
      args: {},
    }, {
      name: "sentinel_publish_graph_fact",
      args: {
        from: "canonical-a",
        to: "canonical-b",
        relation: "depends_on",
        requestId: crypto.randomUUID(),
      },
    }];
    model.register({
      name: "source-fact",
      supportsStreaming: false,
      complete(messages) {
        const results = messages.filter(({ role }) => role === "tool");
        const next = factCalls[results.length];
        if (!next) {
          const returned = JSON.parse(String(results.at(-1)?.content));
          fact = returned.fact ?? returned;
        }
        return Promise.resolve({
          content: next ? "" : "The exact relationship was recorded.",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: next
            ? [{
              id: next.name,
              type: "function",
              function: {
                name: next.name,
                arguments: JSON.stringify(next.args),
              },
            }]
            : [],
        });
      },
    });
    model.setDefault("source-fact");
    const producer = createSentinelSubagent({
      snapshotPath: sourcePath,
      assessmentRevision: source.revision,
      assignedTaskId: sourceLease.task.id,
      assignedTaskLeaseToken: sourceLease.token,
      providerRegistry: model,
      hookRunner: hooks,
      allowModelAccess: true,
    });
    try {
      await producer.execute(
        "Record the dependency in the assigned evidence.",
        () => {},
      );
    } finally {
      producer.clear();
    }
    assert(fact);
    assert(fact.id.startsWith("worker-graph-fact:"));
    const sourceRunId = source.plan.runId;
    assert(sourceRunId);
    const expectedFact = {
      id: fact.id,
      runId: sourceRunId,
      stepIndex: fact.sourceStepIndex,
      resultSha256: fact.resultSha256,
    };
    const requestProposal = {
      action: "propose_graph_fact_discovery",
      kind: "sentinel",
      id: "approved",
      revision: source.revision,
      factId: fact.id,
      node: "record",
      requestId: crypto.randomUUID(),
    };
    let approved: { id: string; version: number; status: string } | undefined;
    let allowProposal = false;
    await withOwnerControl(
      baseDir,
      async (request) => {
        assert((await request(requestProposal)).includes("blocked"));
        allowProposal = true;
        const { proposals } = JSON.parse(
          await request({
            kind: requestProposal.kind,
            id: requestProposal.id,
            revision: requestProposal.revision,
            action: "discovery_proposals",
          }),
        );
        assertEquals(proposals, []);
        assert(
          (await request({ ...requestProposal, node: "unknown-evidence" }))
            .startsWith("Error:"),
        );
        assert(
          (await request({ ...requestProposal, id: "excluded" })).startsWith(
            "Error:",
          ),
        );
        const { proposal } = JSON.parse(await request(requestProposal));
        assertEquals(proposal.status, "pending");
        assertEquals(proposal.graphFactSource, expectedFact);
        assertEquals(
          JSON.parse(await request(requestProposal)).proposal,
          proposal,
        );
        approved = proposal;
      },
      undefined,
      () => allowProposal,
    );
    assert(approved);
    const approval = approved;
    await withTidepoolSocket(baseDir, async (request) => {
      const response = await request("asset_discovery_decision", {
        caseId: "approved",
        action: "approve",
        id: approval.id,
        version: approval.version,
      });
      assertEquals(response.type, "sentinel_asset_discovery_decision");
      assertEquals((response.record as typeof approval).status, "approved");
    });
    const sourceGraph = makeGraph();
    sourceGraph.nodes.push({
      kind: "asset",
      id: "new-source-asset",
      label: "New source-revision asset",
    });
    await Deno.writeTextFile(pathFor("approved"), JSON.stringify(sourceGraph));
    const newer = refreshSentinelAssessment(pathFor("approved"));
    assert(newer && newer.revision > source.revision);
    const registry = openSentinelAssetDiscoveryStore(baseDir);
    let excludedCase: string;
    let excludedRevision: string;
    try {
      const publish = (
        caseId: string,
        state: typeof source,
        seed: string,
      ) => {
        const snapshot = state.result?.sharedGraph.snapshot;
        assert(snapshot);
        const record = registry.propose({
          sourceCaseId: caseId,
          evidenceRevision: state.revision,
          sourceDigest: digestSentinelSnapshot(snapshot),
          taskId: "adaptive:" + seed.repeat(64),
          claim: {
            kind: "relationship",
            assetId: "canonical-a",
            to: "canonical-b",
            relation: "depends_on",
            evidenceId: "record",
          },
        });
        assert(registry.approve(record.id, record.version));
        return record.id;
      };
      excludedCase = publish("excluded", other, "b");
      excludedRevision = publish("approved", newer, "c");
    } finally {
      registry.close();
    }
    const expected = [{
      caseId: "approved",
      revision: source.revision,
      runId: sourceRunId,
    }];
    const spawn = {
      action: "spawn",
      kind: "sentinel",
      id: "main",
      revision: parent.revision,
      targetKind: "sentinel",
      targetId: "child",
      requestId: crypto.randomUUID(),
      sourceCases: [{ caseId: "approved", revision: source.revision }],
    };
    await withOwnerControl(baseDir, async (request, approvals) => {
      assert((await request({
        ...spawn,
        sourceCases: [{ caseId: "approved", revision: newer.revision + 1 }],
      })).startsWith("Error:"));
      assertEquals(approvals.length, 0);
      const created = JSON.parse(await request(spawn));
      assertEquals(created.run.details.linkedCaseSources, expected);
      assertEquals(
        [created.link.left.id, created.link.right.id].sort(),
        ["child", "main"],
      );
      assert(approvals[0].includes(JSON.stringify(expected)));
      assertEquals(JSON.parse(await request(spawn)), created);
      assert((await request({
        ...spawn,
        sourceCases: [{ caseId: "approved", revision: newer.revision }],
      })).startsWith("Error:"));
      assertEquals(approvals.length, 1);
    });
    const observed = {
      planner: [] as string[],
      worker: [] as string[],
    };
    let plannerReceivedSources = false;
    type Candidate = {
      id: string;
      sourceCaseId: string;
      sourceRunId: string;
      sourceEvidenceRevision: number;
      localAssetId: string;
    };
    const catalogReads: Candidate[][] = [];

    const modelFor = (role: keyof typeof observed) => {
      const providers = createProviderRegistry();
      providers.register({
        name: role,
        supportsStreaming: false,
        complete(messages) {
          const results = messages.filter(({ role }) => role === "tool");
          let hints: Candidate[] = [];
          if (role === "planner") {
            const prompt = messages.find(({ content }) =>
              typeof content === "string" &&
              content.includes('"approvedDiscoverySources"')
            )?.content;
            if (typeof prompt === "string") {
              plannerReceivedSources = true;
              hints = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))
                .linkedDiscoveryCandidates ?? [];
              if (!results.length) catalogReads.push(hints);
            }
          }
          const args = [
            {},
            { id: excludedCase },
            { id: excludedRevision },
            { id: hints[0]?.id ?? approval.id },
          ];
          if (results.length === args.length) {
            observed[role] = results.map(({ content }) => String(content));
          }
          return Promise.resolve({
            content: results.length < args.length
              ? ""
              : role === "planner"
              ? "[]"
              : JSON.stringify({
                summary: "Reviewed the exact approved relationship.",
                followUps: [],
              }),
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: results.length < args.length
              ? [{
                id: `discovery-${results.length}`,
                type: "function",
                function: {
                  name: "sentinel_shared_asset_discoveries",
                  arguments: JSON.stringify(args[results.length]),
                },
              }]
              : [],
          });
        },
      });
      providers.setDefault(role);
      return providers;
    };
    const child = childState();
    advanceAdaptiveSentinel(childPath, child);
    let plannerNow = Date.now();
    planner = createSentinelModelPlanner(
      childPath,
      (state) =>
        createSentinelSubagent({
          snapshotPath: childPath,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry: modelFor("planner"),
          hookRunner: hooks,
          sharedInventoryBaseDir: baseDir,
          allowModelAccess: true,
        }),
      undefined,
      () => plannerNow,
    );
    planner.advance(child);
    await until(() =>
      observed.planner.length === 4 && !planner!.hasInFlightWork()
    );
    assert(plannerReceivedSources);
    assertEquals(catalogReads, [[{
      id: approval.id,
      sourceCaseId: "approved",
      sourceRunId,
      sourceEvidenceRevision: source.revision,
      localAssetId: "local-a",
    }]]);

    const queue = openSentinelAdaptiveStore(
      join(dirname(childPath), "sentinel-adaptive.db"),
    );
    try {
      const revision = adaptiveRevision(child);
      queue.sync(revision, [{
        kind: "impact",
        nodeId: "local-a",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(childPath, child);
      const lease = queue.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ nodeId }) => nodeId === "local-a",
      );
      assert(lease);
      const assignment = {
        taskId: lease.task.id,
        token: lease.token,
        evidenceRevision: child.revision,
      };
      const worker = createSentinelSubagent({
        snapshotPath: childPath,
        assessmentRevision: assignment.evidenceRevision,
        assignedTaskId: assignment.taskId,
        assignedTaskLeaseToken: assignment.token,
        providerRegistry: modelFor("worker"),
        hookRunner: hooks,
        allowModelAccess: true,
        readSharedAssetDiscoveries: ({ id, signal, after }) =>
          readSentinelSharedAssetDiscoveries(
            childPath,
            assignment,
            id,
            signal,
            after,
          ),
      });
      try {
        await worker.execute("Read the matching approved source.", () => {});
      } finally {
        worker.clear();
      }
    } finally {
      queue.close();
    }
    for (const results of [observed.planner, observed.worker]) {
      assertEquals(
        JSON.parse(results[0]).discoveries.map(({ id }: { id: string }) => id),
        [approval.id],
      );
      assert(results[1].startsWith("Error:"));
      assert(results[2].startsWith("Error:"));
      const { discovery } = JSON.parse(results[3]);
      assertEquals(discovery.id, approval.id);
      assertEquals(discovery.graphFactSource, expectedFact);
      assertEquals(discovery.evidenceRevision, source.revision);
      assertEquals(discovery.mappedTo, "local-b");
    }
    const exactBeforeWithdrawal = JSON.parse(observed.planner[3]);
    const history = readAdaptiveSentinel(childPath, child, "revision");
    const round = history?.modelPlannerHistory.find(({ reads }) =>
      reads?.some(({ target }) => target === approval.id)
    );
    assert(round);
    const exactOrdinal = (round.reads?.findIndex(({ target }) =>
      target === approval.id
    ) ?? -1) + 1;
    assert(exactOrdinal > 0);
    await withTidepoolSocket(baseDir, async (request) => {
      const response = await request("asset_discovery_decision", {
        caseId: "approved",
        action: "withdraw",
        id: approval.id,
        version: approval.version + 1,
      });
      assertEquals((response.record as typeof approval).status, "withdrawn");
    });
    await withOwnerControl(baseDir, async (request) => {
      const response = await request({
        action: "hint",
        kind: "sentinel",
        id: "child",
        revision: child.revision,
        note: "Check current approved evidence.",
        requestId: crypto.randomUUID(),
      });
      assert(!response.startsWith("Error:"));
    });
    plannerNow += 60_001;
    planner.advance(childState());
    await until(() => catalogReads.length >= 2 && !planner!.hasInFlightWork());
    assertEquals(catalogReads.at(-1), []);

    const currentReader = createSentinelSubagent({
      snapshotPath: childPath,
      assessmentRevision: child.revision,
      plannerExecutionEvidenceRunId: child.plan.runId,
      providerRegistry: modelFor("planner"),
      hookRunner: hooks,
      sharedInventoryBaseDir: baseDir,
      allowModelAccess: true,
    });
    try {
      await currentReader.execute("Confirm the current approval.", () => {});
    } finally {
      currentReader.clear();
    }
    assertEquals(JSON.parse(observed.planner[0]).discoveries, []);
    assert(observed.planner[3].startsWith("Error:"));

    const scope = {
      kind: "sentinel",
      id: "child",
      revision: child.revision,
      runId: child.plan.runId,
    };
    await withOwnerControl(baseDir, async (request) => {
      assertEquals(
        JSON.parse(
          await request({
            ...scope,
            action: "cancel",
          }),
        ).run.status,
        "stopped",
      );
      const archiveId = crypto.randomUUID();
      assertEquals(
        JSON.parse(
          await request({
            ...scope,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
      await Deno.rename(dirname(childPath), join(baseDir, "prior-child"));
      await Deno.rename(dirname(sourcePath), join(baseDir, "prior-source"));
      await Deno.rename(
        join(baseDir, "data", "sentinel-asset-discoveries.db"),
        join(baseDir, "prior-discoveries.db"),
      );
      assertEquals(
        JSON.parse(
          await request({
            ...scope,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      const restored = childState();
      assert(restored.paused);
      assertEquals(restored.plan.linkedCaseSources, expected);
      const reopened = JSON.parse(
        await request({
          kind: scope.kind,
          id: scope.id,
          revision: scope.revision,
          action: "planner_reads",
          plannerIdentity: round.identity,
          attempt: round.attempt,
          ordinal: exactOrdinal,
          includeResult: true,
        }),
      );
      assertEquals(reopened.result.discovery.graphFactSource, expectedFact);
      assertEquals(reopened.result, exactBeforeWithdrawal);
    });
  } finally {
    planner?.stop();
    await until(() => !planner?.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("An approved linked run fails over only the unfinished model call and retains the selected route", async () => {
  const baseDir = await Deno.makeTempDir();
  const pathFor = (id: string) => resolveSentinelCasePath(baseDir, id);
  const registry = createProviderRegistry();
  let scenario: "availability" | "restart" | "authentication" = "availability";
  const calls: string[] = [];
  const usage = { inputTokens: 1, outputTokens: 1 };
  let preservedResult = "";
  registry.register({
    name: "primary",
    model: "primary-model",
    supportsStreaming: false,
    complete(messages) {
      calls.push("primary");
      if (scenario === "authentication") {
        return Promise.reject(
          new Error("Provider request failed (401): body (429)"),
        );
      }
      if (messages.some(({ role }) => role === "tool")) {
        return Promise.reject(
          new Error("Provider request failed (503): unavailable"),
        );
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: "read-once",
          type: "function",
          function: { name: "sentinel_graph_overview", arguments: "{}" },
        }],
      });
    },
  });
  registry.register({
    name: "alternate",
    model: "alternate-model",
    supportsStreaming: false,
    complete(messages) {
      calls.push("alternate");
      if (scenario === "availability") {
        preservedResult = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({ content: "[]", usage, toolCalls: [] });
    },
  });
  registry.register({
    name: "public-only",
    supportsStreaming: false,
    complete() {
      throw new Error("An unapproved model must never receive a prompt.");
    },
  });
  registry.setDefault("primary");
  const allowedModels = ["primary", "alternate"];
  const routing = sentinelAssessmentModelRouting(registry, {
    INTERNAL: allowedModels,
    PUBLIC: ["public-only"],
  });
  let rootReads = 0;
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input }) {
      if (
        hook === "PRE_TOOL_CALL" &&
        (input.tool_call as { name?: string } | undefined)?.name ===
          "sentinel_graph_overview"
      ) rootReads++;
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const createPlannerAgent = (id: string) => {
    const path = pathFor(id);
    const state = readSentinelAssessment(path);
    assert(state?.plan.runId && state.plan.modelFallbackProfiles);
    return createSentinelSubagent({
      ...routing.workerOptions(state.plan.modelProfile, {
        path,
        runId: state.plan.runId,
        revision: state.revision,
        alternates: state.plan.modelFallbackProfiles,
      }),
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      hookRunner,
    });
  };
  const runPlanner = async (id: string) => {
    const agent = createPlannerAgent(id);
    try {
      await agent.execute("Review the approved case overview.", () => {});
    } finally {
      agent.clear();
    }
  };
  try {
    for (const id of ["main", "failover", "unauthorized", "auth-failure"]) {
      const path = pathFor(id);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({ version: 1, nodes: [], edges: [] }),
      );
    }
    const root = startSentinelAssessment(pathFor("main"));
    const start = {
      action: "spawn",
      kind: "sentinel",
      id: "main",
      revision: root.revision,
      targetKind: "sentinel",
      modelProfile: "primary",
    };
    const spawn = {
      ...start,
      targetId: "failover",
      requestId: crypto.randomUUID(),
      fallbackModelProfiles: ["alternate"],
    };
    await withOwnerControl(baseDir, async (request, approvals) => {
      assert((await request({
        ...start,
        targetId: "unauthorized",
        requestId: crypto.randomUUID(),
        fallbackModelProfiles: ["public-only"],
      })).startsWith("Error:"));
      assertEquals(approvals.length, 0);
      assertEquals(readSentinelAssessment(pathFor("unauthorized")), undefined);
      const { run } = JSON.parse(await request(spawn));
      assertEquals(run.details.modelFallbackProfiles, [{
        provider: "alternate",
        model: "alternate-model",
      }]);
      assert(approvals[0].includes('"modelFallbackProfiles"'));
      assertEquals(JSON.parse(await request(spawn)).run, run);
      assert((await request({
        ...spawn,
        fallbackModelProfiles: undefined,
      })).startsWith("Error:"));
      assertEquals(approvals.length, 1);

      await runPlanner("failover");
      assertEquals(calls, ["primary", "primary", "alternate"]);
      assertEquals(rootReads, 1);
      assert(preservedResult.startsWith("{"));
      const active =
        JSON.parse(await request({ ...run.ref, action: "inspect" })).run;
      assertEquals(active.details.activeModelProfile, {
        provider: "alternate",
        model: "alternate-model",
      });

      scenario = "restart";
      await runPlanner("failover");
      assertEquals(calls, ["primary", "primary", "alternate", "alternate"]);
      assertEquals(rootReads, 1);
      allowedModels.pop();
      await runPlanner("failover");
      assertEquals(calls, ["primary", "primary", "alternate", "alternate"]);
      allowedModels.push("alternate");

      const child = JSON.parse(
        await request({
          ...run.ref,
          action: "spawn",
          targetKind: "sentinel",
          targetId: "auth-failure",
          requestId: crypto.randomUUID(),
        }),
      ).run;
      assertEquals(
        child.details.modelFallbackProfiles,
        run.details.modelFallbackProfiles,
      );
      scenario = "authentication";
      await runPlanner("auth-failure");
      assertEquals(calls, [
        "primary",
        "primary",
        "alternate",
        "alternate",
        "primary",
      ]);
      assertEquals(
        readSentinelAssessment(pathFor("auth-failure"))?.plan
          .modelFallbackIndex,
        undefined,
      );
      const archiveScope = { ...run.ref, runId: run.details.runId };
      assertEquals(
        JSON.parse(
          await request({
            ...archiveScope,
            action: "cancel",
          }),
        ).run.status,
        "stopped",
      );
      const archiveId = crypto.randomUUID();
      assertEquals(
        JSON.parse(
          await request({
            ...archiveScope,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
      await Deno.rename(
        dirname(pathFor("failover")),
        join(baseDir, "prior-failover"),
      );
      assertEquals(
        JSON.parse(
          await request({
            ...archiveScope,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      const restored = readSentinelAssessment(pathFor("failover"));
      assert(restored?.paused);
      assertEquals(restored.plan.modelFallbackIndex, 1);
    }, routing.list);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("A reviewed model route replacement preserves the running response and applies to the next call", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "route-review";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const registry = createProviderRegistry();
  const pausedCall = Promise.withResolvers<void>();
  const releaseCall = Promise.withResolvers<void>();
  const allowedNames = ["replacement", "secondary"];
  const calls: string[] = [];
  const usage = { inputTokens: 1, outputTokens: 1 };
  let preservedResult = "";
  let committedTool = 0;
  registry.register({
    name: "default",
    model: "previous",
    supportsStreaming: false,
    async complete() {
      calls.push("default");
      pausedCall.resolve();
      await releaseCall.promise;
      return {
        content: "",
        usage,
        toolCalls: [{
          id: "committed-after-review",
          type: "function",
          function: { name: "sentinel_graph_overview", arguments: "{}" },
        }],
      };
    },
  });
  for (const name of ["replacement", "secondary"]) {
    registry.register({
      name,
      model: name + "-model",
      supportsStreaming: false,
      complete(messages) {
        calls.push(name);
        preservedResult = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
        return Promise.resolve({ content: "[]", usage, toolCalls: [] });
      },
    });
  }
  registry.setDefault("default");
  const routing = sentinelAssessmentModelRouting(registry, {
    INTERNAL: allowedNames,
  });
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input }) {
      if (
        hook === "POST_TOOL_RESPONSE" &&
        input.tool_name === "sentinel_graph_overview"
      ) {
        committedTool++;
      }
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  let running: Promise<void> | undefined;
  let agent: ReturnType<typeof createSentinelSubagent> | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
    );
    const assessment = startSentinelAssessment(path);
    const runId = assessment.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: assessment.revision,
      runId,
    };
    const makeAgent = () =>
      createSentinelSubagent({
        ...routing.workerOptions(undefined, {
          path,
          runId,
          revision: ref.revision,
        }),
        snapshotPath: path,
        assessmentRevision: ref.revision,
        plannerExecutionEvidenceRunId: runId,
        hookRunner,
      });
    agent = makeAgent();
    running = agent.execute("Review saved inventory.", () => {});
    await pausedCall.promise;

    const change = {
      ...ref,
      action: "set_model_route",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      modelProfile: "replacement",
      fallbackModelProfiles: ["secondary"],
      activeModelProfile: "secondary",
    };
    let permitCall = false;
    await withOwnerControl(
      baseDir,
      async (request, approvals) => {
        assert((await request(change)).includes("blocked"));
        permitCall = true;
        assertEquals(
          JSON.parse(await request({ ...ref, action: "model_route" })).version,
          0,
        );
        assert(
          (await request({ ...change, runId: crypto.randomUUID() })).startsWith(
            "Error:",
          ),
        );
        assert(
          (await request({ ...change, activeModelProfile: "default" }))
            .startsWith("Error:"),
        );
        assertEquals(approvals.length, 0);
        const edited = JSON.parse(await request(change));
        assertEquals(edited.edit.before, { activeIndex: 0 });
        assertEquals(edited.edit.after, {
          primary: { provider: "replacement", model: "replacement-model" },
          alternates: [{ provider: "secondary", model: "secondary-model" }],
          activeIndex: 1,
        });
        assertEquals(JSON.parse(await request(change)), edited);
        assert(
          (await request({ ...change, requestId: crypto.randomUUID() }))
            .startsWith("Error:"),
        );
        assertEquals(approvals.length, 1);
        releaseCall.resolve();
        await running;
        assertEquals(calls, ["default", "secondary"]);
        assertEquals(committedTool, 1);
        assert(preservedResult.startsWith("{"));

        allowedNames.pop();
        const revoked = makeAgent();
        try {
          await revoked.execute("Review again after revocation.", () => {});
        } finally {
          revoked.clear();
        }
        assertEquals(calls, ["default", "secondary"]);
        allowedNames.push("secondary");

        assertEquals(
          JSON.parse(await request({ ...ref, action: "cancel" })).run.status,
          "stopped",
        );
        const archiveId = crypto.randomUUID();
        assertEquals(
          JSON.parse(
            await request({
              ...ref,
              action: "archive",
              requestId: archiveId,
            }),
          ).receipt.status,
          "succeeded",
        );
        await Deno.rename(dirname(path), join(baseDir, "old-route-case"));
        assertEquals(
          JSON.parse(
            await request({
              ...ref,
              action: "restore",
              archiveId,
              requestId: crypto.randomUUID(),
            }),
          ).receipt.status,
          "succeeded",
        );
        const restored = JSON.parse(
          await request({ ...ref, action: "model_route" }),
        );
        assertEquals(restored.route, edited.edit.after);
        assertEquals(restored.history, [edited.edit]);
        assertEquals(restored.version, 1);
      },
      routing.list,
      () => permitCall,
    );
  } finally {
    releaseCall.resolve();
    await running?.catch(() => {});
    agent?.clear();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Selected Sentinel chat and its worker use the reviewed case model route", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "route-chat";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const mainPath = resolveSentinelCasePath(baseDir);
  const providers = createProviderRegistry();
  const allow = ["primary", "alternate", "replacement"];
  const modelAllowlists = { INTERNAL: allow };
  const calls: string[] = [];
  let unavailable = false;
  for (const name of ["global", ...allow]) {
    providers.register({
      name,
      model: name + "-model",
      supportsStreaming: false,
      complete() {
        calls.push(name);
        if (name === "primary" && unavailable) {
          return Promise.reject(
            Object.assign(new Error("Provider unavailable"), { status: 503 }),
          );
        }
        return Promise.resolve({
          content: "Reviewed with " + name,
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      },
    });
  }
  providers.setDefault("global");
  const routing = sentinelAssessmentModelRouting(providers, modelAllowlists);
  let gateway: ReturnType<typeof createGatewayServer> | undefined;
  let socket: WebSocket | undefined;
  try {
    for (const file of [mainPath, path]) {
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(
        file,
        JSON.stringify({ version: 1, nodes: [], edges: [] }),
      );
    }
    const started = startSentinelAssessment(path);
    const runId = started.plan.runId;
    assert(runId);
    const scope = {
      kind: "sentinel",
      id: caseId,
      runId,
      revision: started.revision,
    };
    async function setRoute(
      modelProfile: string,
      expectedVersion: number,
      fallbackModelProfiles?: string[],
    ) {
      await withOwnerControl(baseDir, async (request) => {
        const { edit } = JSON.parse(
          await request({
            ...scope,
            action: "set_model_route",
            requestId: crypto.randomUUID(),
            modelProfile,
            expectedVersion,
            fallbackModelProfiles,
          }),
        );
        assertEquals(edit.version, expectedVersion + 1);
      }, routing.list);
    }
    await setRoute("primary", 0, ["alternate"]);

    const token = crypto.randomUUID();
    gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "case-route-chat" as ChannelId,
          bumpersEnabled: false,
        }),
        providerRegistry: providers,
        hookRunner: {
          evaluateHook: () =>
            Promise.resolve({
              allowed: true,
              action: "ALLOW",
              ruleId: null,
              duration: 0,
            }),
        },
        sentinelSnapshotPath: mainPath,
        allowSentinelModelAccess: true,
        sentinelModelProfileAllowlists: modelAllowlists,
        resolveSentinelChatCase: (id) => id === caseId ? path : undefined,
        enableStreaming: false,
      }),
    });
    const { port } = await gateway.start();
    const connected = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      connected.addEventListener("open", () => resolve(), { once: true });
      connected.addEventListener("error", reject, { once: true });
    });
    async function turn(content: string) {
      const done = Promise.withResolvers<string>();
      const seen: string[] = [];
      const timeout = setTimeout(
        () => done.reject(new Error("Case chat did not end")),
        3000,
      );
      function receive({ data }: MessageEvent) {
        seen.push(String(data));
        if (JSON.parse(data).type === "turn_end") done.resolve(seen.join("\n"));
      }
      connected.addEventListener("message", receive);
      try {
        connected.send(JSON.stringify({ type: "message", content }));
        return await done.promise;
      } finally {
        clearTimeout(timeout);
        connected.removeEventListener("message", receive);
      }
    }
    assert(
      (await turn("Review normal chat.")).includes("Reviewed with global"),
    );
    await turn("/sentinel on");
    assert((await turn(`/sentinel case ${caseId}`)).includes(caseId));
    assert(
      (await turn("Review the selected case.")).includes(
        "Reviewed with primary",
      ),
    );
    assert(
      (await turn("/sentinel-agent Review scoped evidence.")).includes(
        "Reviewed with primary",
      ),
    );
    assertEquals(calls, ["global", "primary", "primary"]);

    await withOwnerControl(baseDir, async (request) => {
      assertEquals(
        JSON.parse(await request({ ...scope, action: "cancel" })).run.status,
        "stopped",
      );
    }, routing.list);
    unavailable = true;
    assert(
      (await turn("Review the stopped case.")).includes(
        "Reviewed with alternate",
      ),
    );
    assertEquals(calls, [
      "global",
      "primary",
      "primary",
      "primary",
      "alternate",
    ]);
    const stopped = readSentinelAssessment(path);
    assertFalse(stopped?.active);
    assertEquals(stopped?.plan.modelFallbackIndex, 1);

    allow.splice(allow.indexOf("alternate"), 1);
    assert(
      !(await turn("Review after grant revocation.")).includes("Reviewed with"),
    );
    assertEquals(calls.length, 5);
    await setRoute("replacement", 1);
    assert(
      (await turn("Review using the replacement.")).includes(
        "Reviewed with replacement",
      ),
    );
    await turn("/sentinel off");
    assert(
      (await turn("Return to normal chat.")).includes("Reviewed with global"),
    );
    assertEquals(calls.slice(-2), ["replacement", "global"]);
  } finally {
    socket?.close();
    await gateway?.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Reviewed Sentinel role routes resolve and dispatch independently of the case chain", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "per-role";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const mainPath = resolveSentinelCasePath(baseDir);
  const registry = createProviderRegistry();
  const approved = ["run-model", "planner-model", "worker-model", "chat-model"];
  const allowlists = { INTERNAL: approved, PUBLIC: ["public-model"] };
  const calls: string[] = [];
  let plannerCalls = 0;
  let workerUnavailable = false;
  for (const provider of ["ordinary", ...approved, "public-model"]) {
    registry.register({
      name: provider,
      model: provider + "-version",
      supportsStreaming: false,
      complete(_messages, tools) {
        calls.push(provider);
        if (provider === "planner-model") {
          const definitions = tools as {
            function?: {
              name?: string;
              parameters?: { properties?: { view?: { enum?: string[] } } };
            };
          }[];
          assertEquals(
            definitions.find((tool) =>
              tool.function?.name === "sentinel_case_inventory"
            )?.function?.parameters?.properties?.view?.enum,
            [
              "assets",
              "organizations",
            ],
          );
          assert(
            definitions.some((tool) =>
              tool.function?.name === "sentinel_defense"
            ),
          );
        }
        if (provider === "worker-model" && workerUnavailable) {
          return Promise.reject(
            Object.assign(new Error("Unavailable"), { status: 503 }),
          );
        }
        const content = provider === "planner-model"
          ? (++plannerCalls === 1 ? '[{"kind":"impact","nodeId":"app"}]' : "[]")
          : provider === "worker-model" &&
              calls.filter((item) => item === "worker-model").length === 1
          ? '{"summary":"Reviewed using worker-model","followUps":[]}'
          : "Reviewed using " + provider;
        return Promise.resolve({
          content,
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      },
    });
  }
  registry.setDefault("ordinary");
  const routing = sentinelAssessmentModelRouting(registry, allowlists);
  const hooks: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let gateway: ReturnType<typeof createGatewayServer> | undefined;
  let socket: WebSocket | undefined;
  try {
    for (const file of [path, mainPath]) {
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "app", kind: "asset", label: "Application" }],
          edges: [],
        }),
      );
    }
    const assessment = startSentinelAssessment(path, {
      inventoryCoverageEnabled: false,
    });
    const runId = assessment.plan.runId;
    assert(runId);
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: assessment.revision,
      runId,
    };
    const edit = (
      modelRole: string,
      expectedVersion: number,
      modelProfile?: string,
    ) => ({
      ...ref,
      action: "set_model_role",
      modelRole,
      expectedVersion,
      modelProfile,
      requestId: crypto.randomUUID(),
    });
    const plannerEdit = edit("planner", 1, "planner-model");
    await withOwnerControl(baseDir, async (request, confirmations) => {
      const run = {
        ...ref,
        action: "set_model_route",
        modelProfile: "run-model",
        expectedVersion: 0,
        requestId: crypto.randomUUID(),
      };
      assertEquals(JSON.parse(await request(run)).edit.version, 1);
      assert(
        (await request(edit("delegate", 1, "planner-model"))).startsWith(
          "Error:",
        ),
      );
      assert(
        (await request(edit("planner", 1, "public-model"))).startsWith(
          "Error:",
        ),
      );
      assertEquals(confirmations.length, 1);
      const first = JSON.parse(await request(plannerEdit));
      assertEquals(first.edit.version, 2);
      assertEquals(
        JSON.parse(await request(edit("worker", 2, "worker-model"))).edit
          .version,
        3,
      );
      assertEquals(
        JSON.parse(await request(edit("interactive", 3, "chat-model"))).edit
          .version,
        4,
      );
      assertEquals(JSON.parse(await request(plannerEdit)), first);
      assertEquals(confirmations.length, 4);
      const selection = JSON.parse(
        await request({ ...ref, action: "model_route" }),
      );
      assertEquals(selection.route.primary.provider, "run-model");
      assertEquals(selection.route.activeIndex, 0);
      assertEquals(
        Object.values(selection.roles).map((raw) => {
          const role = raw as {
            source: string;
            available: boolean;
            profile: { provider: string };
          };
          return [role.source, role.available, role.profile.provider];
        }),
        [["role", true, "chat-model"], ["role", true, "planner-model"], [
          "role",
          true,
          "worker-model",
        ]],
      );
    }, routing.list);

    const state = readSentinelAssessment(path);
    assert(state);
    advanceAdaptiveSentinel(path, state);
    planner = createSentinelModelPlanner(
      path,
      (current, taskId, token, role) =>
        createSentinelSubagent({
          ...routing.workerOptions(current.plan.modelProfile, {
            path,
            runId,
            revision: current.revision,
            role: role ?? "worker",
          }),
          snapshotPath: path,
          assessmentRevision: current.revision,
          assignedTaskId: taskId,
          assignedTaskLeaseToken: token,
          plannerExecutionEvidenceRunId: role === "planner" ? runId : undefined,
          hookRunner: hooks,
        }),
    );
    planner.advance(state);
    await until(() =>
      calls.includes("worker-model") && !planner!.hasInFlightWork()
    );
    assert(calls[0] === "planner-model");
    assert(!calls.includes("run-model"));
    assert(
      readAdaptiveSentinel(path, state, "revision")?.modelReviews.some((
        { summary },
      ) => summary.includes("worker-model")),
    );

    const token = crypto.randomUUID();
    gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "roles" as ChannelId,
        }),
        providerRegistry: registry,
        hookRunner: hooks,
        sentinelSnapshotPath: mainPath,
        allowSentinelModelAccess: true,
        sentinelModelProfileAllowlists: allowlists,
        resolveSentinelChatCase: (id) => id === caseId ? path : undefined,
        enableStreaming: false,
      }),
    });
    const { port } = await gateway.start();
    const connected = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    socket = connected;
    await new Promise<void>((resolve, reject) => {
      connected.addEventListener("open", () => resolve(), { once: true });
      connected.addEventListener("error", reject, { once: true });
    });
    async function turn(content: string) {
      const done = Promise.withResolvers<string>();
      const seen: string[] = [];
      const timeout = setTimeout(
        () => done.reject(new Error("Case chat did not end")),
        3000,
      );
      function receive({ data }: MessageEvent) {
        seen.push(String(data));
        if (JSON.parse(data).type === "turn_end") done.resolve(seen.join("\n"));
      }
      connected.addEventListener("message", receive);
      try {
        connected.send(JSON.stringify({ type: "message", content }));
        return await done.promise;
      } finally {
        clearTimeout(timeout);
        connected.removeEventListener("message", receive);
      }
    }
    await turn("/sentinel on");
    await turn(`/sentinel case ${caseId}`);
    assert(
      (await turn("Review this assessment.")).includes(
        "Reviewed using chat-model",
      ),
    );
    assert(
      (await turn("/sentinel-agent Review the assigned evidence.")).includes(
        "worker-model",
      ),
    );
    const callsBeforeFailure = calls.length;
    workerUnavailable = true;
    await turn("/sentinel-agent Check the unavailable scoped model.");
    assertEquals(calls.slice(callsBeforeFailure), ["worker-model"]);
    assertEquals(
      readSentinelAssessment(path)?.plan.modelFallbackIndex,
      undefined,
    );

    await withOwnerControl(baseDir, async (request) => {
      const receipt = JSON.parse(await request(edit("interactive", 4)));
      assertEquals(receipt.edit.after.roles.interactive, undefined);
      assertEquals(receipt.edit.after.roles.planner.provider, "planner-model");
      assertEquals(receipt.edit.after.roles.worker.provider, "worker-model");
    }, routing.list);
    assert(
      (await turn("Review with the unchanged run model.")).includes(
        "Reviewed using run-model",
      ),
    );
    assertEquals(readSentinelAssessment(path)?.revision, assessment.revision);
    planner.stop();
    await withOwnerControl(baseDir, async (request) => {
      assertEquals(
        JSON.parse(await request({ ...ref, action: "cancel" })).run.status,
        "stopped",
      );
      const archiveId = crypto.randomUUID();
      assertEquals(
        JSON.parse(
          await request({
            ...ref,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt.status,
        "succeeded",
      );
      await Deno.rename(dirname(path), join(baseDir, "old-role-case"));
      assertEquals(
        JSON.parse(
          await request({
            ...ref,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt.status,
        "succeeded",
      );
      const restored = JSON.parse(
        await request({ ...ref, action: "model_route" }),
      );
      assertEquals(restored.version, 5);
      const coverage = JSON.parse(
        await request({
          action: "inventory",
          kind: ref.kind,
          id: ref.id,
          revision: ref.revision,
          view: "coverage",
        }),
      );
      assertEquals(coverage.page.enabled, false);
      assertEquals(coverage.page.assets, undefined);
      assertEquals(restored.roles.interactive.source, "run");
      assertEquals(restored.roles.worker.profile.provider, "worker-model");
      assertEquals(
        restored.history[3].after.roles.interactive.provider,
        "chat-model",
      );
    }, routing.list);
  } finally {
    planner?.stop();
    socket?.close();
    await gateway?.stop();
    await until(() => !planner?.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});
