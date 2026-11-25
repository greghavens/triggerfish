import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  executeSentinelTask,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";

function connect(url: string) {
  const socket = new WebSocket(url);
  return new Promise<WebSocket>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function requestFrame(socket: WebSocket, content: unknown, type: string) {
  const reply = Promise.withResolvers<Record<string, unknown>>();
  const timeout = setTimeout(
    () => reply.reject(new Error(`No ${type} frame`)),
    3_000,
  );
  const listener = ({ data }: MessageEvent) => {
    const frame = JSON.parse(data);
    if (frame.type === type) reply.resolve(frame);
    if (frame.type === "error") reply.reject(new Error(String(frame.message)));
  };
  socket.addEventListener("message", listener);
  try {
    socket.send(JSON.stringify(content));
    return await reply.promise;
  } finally {
    clearTimeout(timeout);
    socket.removeEventListener("message", listener);
  }
}

Deno.test("The gateway satisfies an exact queued prerequisite from a committed fact and releases its dependent", async () => {
  const dir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(dir);
  const inventory = {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Application" },
      { id: "record", kind: "evidence", label: "Exact evidence" },
      { id: "other", kind: "evidence", label: "Unrelated evidence" },
      { id: "mixed", kind: "evidence", label: "Mixed evidence root" },
    ],
    edges: [{ from: "record", relation: "observed_on", to: "app" }],
  };
  const token = crypto.randomUUID();
  const registry = createProviderRegistry();
  let toolArguments: Record<string, unknown> | undefined;
  let output = "";
  const usage = { inputTokens: 1, outputTokens: 1 };
  registry.register({
    name: "exact-fact-operator",
    supportsStreaming: false,
    complete(messages) {
      const result = messages.at(-1);
      if (result?.role === "tool") {
        output = String(result.content);
        return Promise.resolve({ content: "Checked.", usage, toolCalls: [] });
      }
      assert(toolArguments);
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(toolArguments),
          },
        }],
      });
    },
  });
  registry.setDefault("exact-fact-operator");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
    }),
    providerRegistry: registry,
    hookRunner: {
      evaluateHook: () =>
        Promise.resolve({
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        }),
    },
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir: dir,
      confirm: () => Promise.resolve(true),
    }),
  });
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const tidepoolState = {
    clients: new Set<WebSocket>(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: token,
    lastMcpConnected: -1,
    lastMcpConfigured: 0,
    socketCleanupCallbacks: [],
    canvasRenders: [],
    topicHandlers: {
      sentinel: createTidepoolSentinelHandler(
        { baseDir: dir, config: {} } as BootstrapResult,
      ),
    },
  };
  let socket: WebSocket | undefined;
  let tidepoolSocket: WebSocket | undefined;
  let tidepoolServer: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const { port } = await gateway.start();
    socket = await connect(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const turn = async (args: Record<string, unknown>) => {
      toolArguments = args;
      output = "";
      await requestFrame(socket!, {
        type: "message",
        content: "Inspect the exact investigation.",
      }, "turn_end");
      return output;
    };
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "review_evidence",
        nodeId: "other",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const unrelated = store.claim(revision)!;
      assertEquals(unrelated.task.nodeId, "other");
      const unrelatedFact = executeSentinelTask(state, unrelated.task);
      store.complete({
        taskId: unrelated.task.id,
        leaseToken: unrelated.leaseToken,
        observation: unrelatedFact,
      });
      store.sync(revision, [{
        kind: "trace",
        nodeId: "record",
        depth: 1,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const queued = store.list(revision).find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "record"
      )!;
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [queued.id],
      }, {
        kind: "review_evidence",
        nodeId: "record",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const source = store.list(revision).find(({ kind, nodeId }) =>
        kind === "review_evidence" && nodeId === "record"
      )!;
      const dependent = store.list(revision).find(({ kind }) =>
        kind === "impact"
      )!;
      assertEquals(dependent.status, "queued");
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: queued.id,
          sourceTaskId: unrelated.task.id,
          sourceObservationSha256: createHash("sha256").update(
            JSON.stringify(unrelatedFact),
          ).digest("hex"),
        }),
      );
      assertEquals(
        store.list(revision).find(({ id }) => id === queued.id)?.status,
        "queued",
      );
      const ref = { kind: "sentinel", id: "main", revision: state.revision };
      const dependentRef = { ...ref, action: "tasks", taskId: dependent.id };
      const blocked = JSON.parse(await turn(dependentRef)).tasks[0];
      assertEquals(blocked.status, "queued");
      assertEquals(blocked.unfinishedPrerequisites, [queued.id]);
      const prioritized = JSON.parse(
        await turn({
          ...ref,
          action: "prioritize_task",
          taskId: source.id,
        }),
      );
      assertEquals(prioritized.action, "prioritize_task");
      const view = readAdaptiveSentinel(path, state)!;
      const satisfied = view.tasks.find(({ id }) => id === queued.id)!;
      assertEquals(satisfied.status, "completed");
      assertEquals(satisfied.attempts, 0);
      assertEquals(satisfied.factSatisfaction?.sourceTaskId, source.id);
      assertEquals(
        satisfied.factSatisfaction?.evidenceRevision,
        state.revision,
      );
      assertEquals(
        view.tasks.find(({ id }) => id === dependent.id)?.status,
        "completed",
      );
      assertEquals(
        view.history.filter(({ taskId, event }) =>
          taskId === queued.id && event === "fact_satisfied"
        ).length,
        1,
      );
      assert(
        !view.history.some(({ taskId, event }) =>
          taskId === queued.id &&
          (event === "claimed" || event === "model_review_claimed")
        ),
      );
      assertEquals(
        view.history.filter(({ taskId, event }) =>
          taskId === dependent.id && event === "claimed"
        ).length,
        1,
      );
      assertEquals(
        JSON.parse(await turn(dependentRef)).tasks[0].status,
        "completed",
      );
      assertEquals(
        JSON.parse(await turn({ ...ref, action: "tasks", taskId: queued.id }))
          .tasks[0].factSatisfaction,
        satisfied.factSatisfaction,
      );
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: queued.id,
          sourceTaskId: source.id,
          sourceObservationSha256:
            satisfied.factSatisfaction!.sourceObservationSha256,
        }),
      );
      const graph = buildSentinelProvenance(state.result, view).snapshot();
      assert(
        graph.edges.some(({ from, to, relation }) =>
          from.endsWith(queued.id) && to.endsWith(source.id) &&
          relation === "references"
        ),
      );

      store.sync(revision, [{
        kind: "review_evidence",
        nodeId: "mixed",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      const mixedSource = store.list(revision).find(({ kind, nodeId }) =>
        kind === "review_evidence" && nodeId === "mixed"
      )!;
      assert(store.prioritize(revision, mixedSource.id));
      const mixedLease = store.claim(revision)!;
      assertEquals(mixedLease.task.id, mixedSource.id);
      const mixedFact = executeSentinelTask(state, mixedLease.task);
      assert(store.complete({
        taskId: mixedSource.id,
        leaseToken: mixedLease.leaseToken,
        observation: mixedFact,
      }));
      store.sync(revision, [{
        kind: "trace",
        nodeId: "mixed",
        depth: 1,
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [mixedSource.id, unrelated.task.id],
        plannerRound: {
          identity: "mixed-worker-evidence",
          attempt: 1,
          workerSources: [
            { kind: "worker_result", taskId: mixedSource.id },
            { kind: "worker_result", taskId: unrelated.task.id },
          ],
        },
      }], revision);
      const mixedTarget = store.list(revision).find(({ kind, nodeId }) =>
        kind === "trace" && nodeId === "mixed"
      )!;
      assert(store.prioritize(revision, mixedTarget.id));
      assertEquals(store.peekNextClaimable(revision)?.id, mixedTarget.id);
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: mixedTarget.id,
          sourceTaskId: mixedSource.id,
          sourceObservationSha256: createHash("sha256").update(
            JSON.stringify(mixedFact),
          ).digest("hex"),
        }),
      );
      advanceAdaptiveSentinel(path, state);
      const mixedCompleted = readAdaptiveSentinel(path, state)?.tasks.find(
        ({ id }) => id === mixedTarget.id,
      );
      assertEquals(mixedCompleted?.status, "completed");
      assertEquals(mixedCompleted?.attempts, 1);
      assertEquals(mixedCompleted?.factSatisfaction, undefined);
      assertEquals(mixedCompleted?.prerequisites, mixedTarget.prerequisites);

      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...inventory,
          nodes: inventory.nodes.map((node) =>
            node.id === "record" ? { ...node, label: "Updated evidence" } : node
          ),
        }),
      );
      const next = refreshSentinelAssessment(path)!;
      assert(next.revision > state.revision);
      advanceAdaptiveSentinel(path, next);
      assert(
        !store.satisfyQueuedTaskFromFact(revision, {
          taskId: queued.id,
          sourceTaskId: source.id,
          sourceObservationSha256:
            satisfied.factSatisfaction!.sourceObservationSha256,
        }),
      );
      assert(
        !readAdaptiveSentinel(path, next)!.tasks.some(({ factSatisfaction }) =>
          factSatisfaction?.sourceTaskId === source.id
        ),
      );
      const retained = readHistoricalAdaptiveSentinel(path, state.revision);
      assert(retained);
      tidepoolServer = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        (request) => routeHostRequest(request, tidepoolState, chatSession),
      );
      tidepoolSocket = await connect(
        `ws://127.0.0.1:${tidepoolServer.addr.port}/?key=${token}`,
      );
      const historicalFrame = await requestFrame(tidepoolSocket, {
        topic: "sentinel",
        type: "revision",
        caseId: "main",
        revision: state.revision,
        focusTask: queued.id,
      }, "sentinel_revision");
      const historical = historicalFrame.provenance as ReturnType<
        ReturnType<typeof buildSentinelProvenance>["snapshot"]
      >;
      const historicalTask = historical.nodes.find(({ sourceId }) =>
        sourceId === queued.id
      );
      assert(historicalTask && "factSatisfaction" in historicalTask);
      assertEquals(historicalTask.factSatisfaction, satisfied.factSatisfaction);
      const exported = await requestFrame(tidepoolSocket, {
        topic: "sentinel",
        type: "export",
        caseId: "main",
        format: "provenance",
        revision: state.revision,
      }, "export");
      const savedExport = JSON.parse(String(exported.content));
      assertEquals(savedExport.revision, state.revision);
      const exact = savedExport.provenance.nodes.find((
        { sourceId }: { sourceId: string },
      ) => sourceId === queued.id);
      assertEquals(exact.factSatisfaction, satisfied.factSatisfaction);
      assert(savedExport.provenance.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from === exact.id && to === `observation:adaptive:${source.id}` &&
        relation === "references"
      ));
      assertStringIncludes(
        await turn({
          ...ref,
          action: "tasks",
          taskId: queued.id,
          revision: next.revision,
        }),
        "unavailable",
      );
      const retainedNode = buildSentinelProvenance(state.result, retained)
        .snapshot().nodes.find(({ sourceId }) => sourceId === queued.id);
      assert(retainedNode && "factSatisfaction" in retainedNode);
      assertEquals(retainedNode.factSatisfaction, satisfied.factSatisfaction);
      const savedTask = retained.tasks.find(({ id }) => id === queued.id)!;
      for (
        const replacement of [
          {
            ...savedTask,
            factSatisfaction: {
              ...satisfied.factSatisfaction!,
              evidenceRevision: next.revision,
            },
          },
          {
            ...savedTask,
            observation: { tampered: true },
          },
        ]
      ) {
        const mismatched = buildSentinelProvenance(state.result, {
          ...retained,
          tasks: retained.tasks.map((task) =>
            task.id === queued.id ? replacement : task
          ),
        }).snapshot();
        const mismatchedNode = mismatched.nodes.find(({ sourceId }) =>
          sourceId === queued.id
        )!;
        assert(!("factSatisfaction" in mismatchedNode));
        assert(
          !mismatched.edges.some(({ from, to, relation }) =>
            from === mismatchedNode.id && to.endsWith(source.id) &&
            relation === "references"
          ),
        );
      }
    } finally {
      store.close();
    }
  } finally {
    socket?.close();
    tidepoolSocket?.close();
    await Promise.all([gateway.stop(), tidepoolServer?.shutdown()]);
    await Deno.remove(dir, { recursive: true });
  }
});
