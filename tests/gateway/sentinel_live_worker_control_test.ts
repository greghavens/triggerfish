import { assert, assertEquals, assertFalse } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
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

Deno.test("Tidepool steers one exact leased Sentinel worker and durably stops it", async () => {
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
      const accepted = await request("worker_steer", steer);
      assertEquals(
        accepted.type,
        "sentinel_worker_control",
        JSON.stringify(accepted),
      );
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
      const stop = await request("worker_stop", {
        ...fields,
        controlRequestId: stopId,
      });
      assertEquals(stop.type, "sentinel_worker_control");
      stopReceipt = stop.receipt;
      assert(stopReceipt);
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
