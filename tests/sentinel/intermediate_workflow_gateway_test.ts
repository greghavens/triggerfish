import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
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
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Gateway workers cite an intermediate observation while its source review stays open", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const database = join(dirname(path), "sentinel-adaptive.db");
  const pool = createSentinelWorkerPool(2);
  const published = Promise.withResolvers<void>();
  const releaseSource = Promise.withResolvers<void>();
  let transportCalls = 0;
  let received = "";
  const reader = createSentinelLiveWorkflowReader({
    scopes: [{
      case: "main",
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
          caseId: "main",
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
    assertEquals(transportCalls, 1);

    planner.stop();
    releaseSource.resolve();
    await waitFor(() => !planner.hasInFlightWork());
    const fixture = fromFileUrl(
      new URL(
        "./fixtures/intermediate_workflow_export_process.ts",
        import.meta.url,
      ),
    );
    const reloaded = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", fixture, baseDir, String(state.revision)],
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
