import { assert, assertEquals, assertFalse } from "@std/assert";
import { dirname } from "@std/path";
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
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import { readSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
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
) {
  const approvals: string[] = [];
  const providers = createProviderRegistry();
  let next: Record<string, unknown> | undefined;
  let result = "";
  let callId = 0;
  providers.register({
    name: "owner-control",
    supportsStreaming: false,
    complete(messages) {
      const args = next;
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
    hookRunner: {
      evaluateHook(hook, { session, input, auditInput }) {
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
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        });
      },
    },
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      confirm(message) {
        approvals.push(message);
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
    await run((args) => {
      next = args;
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
          content: "Use the exact requested Sentinel worker control.",
        }),
      );
      return reply.promise.finally(() => {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      });
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
    async complete(messages) {
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
        const command = {
          action: "steer",
          ...rootScope,
          requestId: steerId,
          note: guidance,
        };
        assert(
          (await owner({ ...command, adaptiveRevision: "f".repeat(64) }))
            .startsWith("Error:"),
        );
        assert(
          (await owner({ ...command, runId: crypto.randomUUID() })).startsWith(
            "Error:",
          ),
        );
        assertEquals(approvals, []);
        rootSteering = JSON.parse(await owner(command)).receipt;
        assert(rootSteering);
        assert(approvals[0].includes(target.id));
        assert(approvals[0].includes(initial.revision));
        assertEquals(JSON.parse(await owner(command)).receipt, rootSteering);
      });
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
      await withOwnerControl(baseDir, async (owner) => {
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
      });
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
