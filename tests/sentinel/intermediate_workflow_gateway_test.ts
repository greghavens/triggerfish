import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  createSentinelWorkerPool,
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

async function withOperator(
  baseDir: string,
  check: (
    call: (
      args: Record<string, unknown>,
      withhold?: boolean | "source",
    ) => Promise<string>,
  ) => Promise<void>,
  approveArchive = false,
) {
  const registry = createProviderRegistry();
  let args: Record<string, unknown> | undefined;
  let result = "";
  let withhold: boolean | "source" = false;
  registry.register({
    name: "intermediate-operator-fixture",
    supportsStreaming: false,
    complete(messages) {
      const next = args;
      args = undefined;
      if (!next) {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        usage: { inputTokens: 1, outputTokens: 1 },
        content: next ? "" : "Checked retained observations.",
        toolCalls: next
          ? [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(next),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("intermediate-operator-fixture");
  const token = crypto.randomUUID();
  const server = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        channelId: "fixture" as ChannelId,
        userId: "owner" as UserId,
        bumpersEnabled: false,
      }),
      providerRegistry: registry,
      hookRunner: {
        evaluateHook: (hook, { input }) => {
          const allowed = !(hook === "POST_TOOL_RESPONSE" &&
            (withhold === true ||
              withhold === "source" &&
                input.tool_name ===
                  "sentinel_intermediate_workflow_observation"));
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
        confirm: () => Promise.resolve(approveArchive),
      }),
    }),
  });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await check(async (input, deny = false) => {
      withhold = deny;
      args = input;
      const done = Promise.withResolvers<string>();
      const timeout = setTimeout(
        () => done.reject(new Error("Operator tool turn timed out")),
        3000,
      );
      const receive = (event: MessageEvent) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "response") done.resolve(result);
        if (frame.type === "error") {
          done.reject(new Error(JSON.stringify(frame)));
        }
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({
          type: "message",
          content: "Inspect committed observations.",
        }),
      );
      try {
        return await done.promise;
      } finally {
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
      }
    });
  } finally {
    socket.close();
    await server.stop();
  }
}

Deno.test("Gateway workers cite an intermediate observation while its source review stays open", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "workflow-evidence";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const database = join(dirname(path), "sentinel-adaptive.db");
  const pool = createSentinelWorkerPool(2);
  const published = Promise.withResolvers<void>();
  const releaseSource = Promise.withResolvers<void>();
  let transportCalls = 0;
  let received = "";
  const reader = createSentinelLiveWorkflowReader({
    scopes: [{
      case: caseId,
      asset: "delivery",
      owner: "owner",
      repo: "pipeline",
      workflow_id: 17,
    }],
    resolveToken: () => Promise.resolve("fixture-token"),
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    readRuns: () => {
      transportCalls++;
      return Promise.resolve([{
        id: 51,
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      }]);
    },
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
  const registry = createProviderRegistry();
  const usage = { inputTokens: 1, outputTokens: 1 };
  function call(name: string, args: object = {}) {
    return {
      content: "",
      usage,
      toolCalls: [{
        type: "function",
        id: name + JSON.stringify(args),
        function: { name, arguments: JSON.stringify(args) },
      }],
    };
  }
  function summary(text: string) {
    return {
      content: JSON.stringify({ summary: text, followUps: [] }),
      usage,
      toolCalls: [],
    };
  }
  registry.register({
    name: "intermediate-workflow-fixture",
    supportsStreaming: false,
    async complete(messages) {
      const source = messages.some(({ role, content }) =>
        role === "user" && typeof content === "string" &&
        content.includes('"kind":"impact"')
      );
      const results = messages.filter(({ role }) => role === "tool");
      if (source) {
        if (!results.length) return call("sentinel_live_workflow_status");
        if (results.length === 1) {
          assert(String(results[0].content).includes('"id":51'));
          return call("sentinel_publish_workflow_observation");
        }
        assert(String(results[1].content).includes("workflow-observation:"));
        published.resolve();
        await releaseSource.promise;
        return summary("Source was released.");
      }
      await published.promise;
      if (!results.length) {
        return call("sentinel_intermediate_workflow_observation");
      }
      if (results.length === 1) {
        const id = String(results[0].content).match(
          /workflow-observation:[a-f0-9]{64}/,
        )?.[0];
        assert(id);
        received = id;
        return call("sentinel_intermediate_workflow_observation", { id });
      }
      const receipt = String(results[1].content);
      assert(
        receipt.includes(received) && receipt.includes('"id":51') &&
          receipt.includes('"failure"'),
      );
      return summary("Peer cited the exact failed run.");
    },
  });
  registry.setDefault("intermediate-workflow-fixture");
  const planner = createSentinelModelPlanner(path, (state, taskId, token) => {
    if (!taskId || !token) {
      return {
        execute(_message, send) {
          send({
            type: "response",
            taint: "INTERNAL",
            text:
              '[{"kind":"impact","nodeId":"delivery"},{"kind":"trace","nodeId":"delivery"}]',
          });
          return Promise.resolve();
        },
        clear() {},
      };
    }
    const withStore = <T>(
      operation: (store: ReturnType<typeof openSentinelAdaptiveStore>) => T,
    ) => {
      const store = openSentinelAdaptiveStore(database);
      try {
        return operation(store);
      } finally {
        store.close();
      }
    };
    return createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      assignedTaskId: taskId,
      assignedTaskLeaseToken: token,
      hookRunner,
      providerRegistry: registry,
      allowModelAccess: true,
      readLiveWorkflowStatus: (
        { task, evidenceRevision, signal, authorize, resumeOnly },
      ) =>
        reader({
          caseId,
          assetId: task.nodeId!,
          evidenceRevision,
          signal,
          authorize,
          resumeOnly,
          isCurrent: () =>
            !!readAssignedSentinelModelReview(
              path,
              evidenceRevision,
              taskId,
              token,
            ),
          loadSaved: () =>
            withStore((store) =>
              store.readLeasedGitHubWorkflowResult(
                task.revision,
                task.id,
                token,
                evidenceRevision,
              )
            ),
          saveResult: (receipt) =>
            withStore((store) =>
              store.recordLeasedGitHubWorkflowResult(
                task.revision,
                task.id,
                token,
                evidenceRevision,
                receipt,
              )
            ),
        }),
    });
  }, () => pool(path));

  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 160 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(condition());
  }
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "delivery", kind: "asset", label: "Delivery pipeline" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await waitFor(() =>
      !!readAdaptiveSentinel(path, state)?.modelReviews.some(({ summary }) =>
        summary === "Peer cited the exact failed run."
      )
    );
    const view = readAdaptiveSentinel(path, state)!;
    const [observation] = view.workflowObservations;
    const source = view.tasks.find(({ kind }) => kind === "impact")!;
    const peer = view.tasks.find(({ kind }) => kind === "trace")!;
    assertEquals(observation.id, received);
    assertEquals(observation.taskId, source.id);
    assertEquals(observation.evidenceRevision, state.revision);
    assertEquals(observation.stepIndex, 0);
    assertEquals(
      view.modelReviewStates.find(({ taskId }) => taskId === source.id)?.status,
      "running",
    );
    assert(!view.modelReviews.some(({ taskId }) => taskId === source.id));
    const trace = {
      action: "worker_trace_result",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      taskId: source.id,
      stepIndices: [1],
    };
    const peerStep = view.modelReviews.find(({ taskId }) => taskId === peer.id)
      ?.steps.findIndex(({ intermediateWorkflowObservation }) =>
        intermediateWorkflowObservation?.observationId === observation.id
      );
    assert(peerStep !== undefined && peerStep > 0);
    const peerTrace = { ...trace, taskId: peer.id, stepIndices: [peerStep] };
    const expectedPublication = {
      id: observation.id,
      targetId: observation.targetId,
      evidenceRevision: state.revision,
    };
    await withOperator(baseDir, async (turn) => {
      const query = {
        action: "intermediate_observations",
        kind: "sentinel",
        id: caseId,
        revision: state.revision,
      };
      const publication = JSON.parse(await turn(trace));
      assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
      assert((await turn(peerTrace, "source")).includes("unavailable"));
      assertEquals(
        await turn(peerTrace, true),
        "Tool response withheld by policy.",
      );
      assert(
        (await turn({ ...peerTrace, stepIndices: [0] })).includes(
          "unavailable",
        ),
      );
      assertEquals(publication.result, expectedPublication);
      assertEquals(
        await turn(trace, true),
        "Tool response withheld by policy.",
      );
      assert(
        (await turn({ ...trace, taskId: peer.id, stepIndices: [9] })).includes(
          "unavailable",
        ),
      );
      const listed = JSON.parse(await turn(query)).page;
      assertEquals(listed.observations.map(({ id }: { id: string }) => id), [
        observation.id,
      ]);
      const exact = { ...query, observationId: observation.id };
      assertEquals(JSON.parse(await turn(exact)).page.observation, observation);
      assertEquals(
        await turn(exact, true),
        "Tool response withheld by policy.",
      );
      assert(
        (await turn({ ...exact, id: "unpublished-case" })).includes(
          "unavailable",
        ),
      );
      assert(
        (await turn({ ...exact, revision: state.revision + 1 })).includes(
          "unavailable",
        ),
      );
    });
    assertEquals(
      readAdaptiveSentinel(path, state)?.modelReviewStates.find(({ taskId }) =>
        taskId === source.id
      )?.status,
      "running",
    );
    assertEquals(transportCalls, 1);

    planner.stop();
    releaseSource.resolve();
    await waitFor(() => !planner.hasInFlightWork());
    assert(stopSentinelAssessment(path));
    const ref = {
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      runId: state.plan.runId,
    };
    const archiveId = crypto.randomUUID();
    await withOperator(baseDir, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            action: "archive",
            requestId: archiveId,
          }),
        ).receipt?.status,
        "succeeded",
      );
    }, true);
    const archiveDir = join(baseDir, "data", "run-archives", archiveId);
    for await (const entry of Deno.readDir(archiveDir)) {
      if (!entry.isFile) continue;
      const bytes = await Deno.readFile(join(archiveDir, entry.name));
      assert(!new TextDecoder().decode(bytes).includes("fixture-token"));
    }
    await Deno.rename(dirname(path), join(baseDir, "stopped-fixture"));
    await withOperator(baseDir, async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({
            ...ref,
            action: "restore",
            archiveId,
            requestId: crypto.randomUUID(),
          }),
        ).receipt?.status,
        "succeeded",
      );
      const restored = readSentinelAssessment(path);
      assert(restored?.paused);
      assertEquals(restored.plan.runId, state.plan.runId);
      assertEquals(JSON.parse(await turn(trace)).result, expectedPublication);
      assertEquals(JSON.parse(await turn(peerTrace)).result, observation);
      const exact = {
        action: "intermediate_observations",
        kind: ref.kind,
        id: caseId,
        revision: state.revision,
        observationId: observation.id,
      };
      assertEquals(JSON.parse(await turn(exact)).page.observation, observation);
      assert(
        !readAdaptiveSentinel(path, restored)?.modelReviews.some(({ taskId }) =>
          taskId === source.id
        ),
      );
    }, true);
    assertEquals(transportCalls, 1);
    const fixture = fromFileUrl(
      new URL(
        "./fixtures/intermediate_workflow_export_process.ts",
        import.meta.url,
      ),
    );
    const reloaded = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fixture, baseDir, String(state.revision), caseId],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(reloaded.success, new TextDecoder().decode(reloaded.stderr));
    const frame = JSON.parse(new TextDecoder().decode(reloaded.stdout));
    const graph = JSON.parse(frame.content).provenance;
    const saved = graph.nodes.find((node: { sourceId?: string }) =>
      node.sourceId === received
    );
    assert(saved);
    assert(
      graph.edges.some((
        { from, to, relation }: { from: string; to: string; relation: string },
      ) =>
        from.endsWith(peer.id) && to === saved.id && relation === "references"
      ),
    );
  } finally {
    planner.stop();
    published.resolve();
    releaseSource.resolve();
    await waitFor(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});
