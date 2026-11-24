import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
  readAssignedSentinelModelReview,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

Deno.test("An approved live workflow read drives another defensive planning round", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const now = { value: Date.now() };
  let connectorCalls = 0;
  let credentialReads = 0;
  let sawResult = false;
  let hookDestination: unknown;
  const reader = createSentinelLiveWorkflowReader({
    scopes: [{
      case: "main",
      asset: "delivery",
      owner: "owner",
      repo: "pipeline",
      workflow_id: 17,
    }],
    resolveToken: () => {
      credentialReads++;
      return Promise.resolve("fixture-token");
    },
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    readRuns: (target, { token }) => {
      connectorCalls++;
      assertEquals(target, {
        owner: "owner",
        repo: "pipeline",
        workflowId: 17,
      });
      assertEquals(token, "fixture-token");
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
    evaluateHook: (hook, context) => {
      if (hook === "PRE_TOOL_CALL" && context.input.url) {
        hookDestination = context.input.url;
        assertEquals(context.input.sentinel_case_id, "main");
      }
      return Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const registry = createProviderRegistry();
  registry.register({
    name: "live-read-fixture",
    supportsStreaming: false,
    complete(messages) {
      const read = messages.find(({ role }) => role === "tool");
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!read) {
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: "workflow",
            type: "function",
            function: {
              name: "sentinel_live_workflow_status",
              arguments: "{}",
            },
          }],
        });
      }
      assert(JSON.stringify(read.content).includes("failure"));
      assert(!JSON.stringify(read.content).includes("fixture-token"));
      return Promise.resolve({
        content: '{"summary":"The approved workflow failed.","followUps":[]}',
        usage,
        toolCalls: [],
      });
    },
  });
  registry.setDefault("live-read-fixture");

  const planner = createSentinelModelPlanner(
    path,
    (state, taskId, token) => {
      if (!taskId || !token) {
        return {
          execute(message, send) {
            const input = JSON.parse(String(message).split("\n").at(-1)!);
            const entry = input.workerObservations.find((
              item: { githubWorkflowReads?: unknown[] },
            ) => item.githubWorkflowReads?.length);
            if (entry) {
              assertEquals(entry.githubWorkflowReads[0].runs, [{
                id: 51,
                status: "completed",
                conclusion: "failure",
              }]);
              sawResult = true;
            }
            send({
              type: "response",
              taint: "INTERNAL",
              text: entry
                ? JSON.stringify([{
                  kind: "trace",
                  nodeId: "delivery",
                  sourceTaskId: entry.taskId,
                  sourceKind: "model_review",
                }])
                : '[{"kind":"impact","nodeId":"delivery"}]',
            });
            return Promise.resolve();
          },
          clear() {},
        };
      }
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        hookRunner,
        providerRegistry: registry,
        allowModelAccess: true,
        readLiveWorkflowStatus: (
          { task, evidenceRevision, signal, authorize },
        ) =>
          reader({
            caseId: "main",
            assetId: task.nodeId!,
            evidenceRevision,
            signal,
            authorize,
            isCurrent: () =>
              !!readAssignedSentinelModelReview(
                path,
                evidenceRevision,
                taskId,
                token,
              ),
          }),
      });
    },
    undefined,
    () => now.value,
  );
  async function waitFor(condition: () => boolean) {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
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
    const denied = await reader({
      caseId: "outside",
      assetId: "delivery",
      evidenceRevision: state.revision,
      signal: new AbortController().signal,
      authorize: () => {
        throw new Error("An out-of-scope case must not reach the hook");
      },
      isCurrent: () => true,
    });
    assertEquals(denied, undefined);
    assertEquals(credentialReads, 0);
    assertEquals(connectorCalls, 0);
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    await waitFor(() =>
      !!readAdaptiveSentinel(path, state)?.modelReviews.some(({ steps }) =>
        steps.some(({ githubWorkflowRead }) =>
          githubWorkflowRead?.runs[0]?.id === 51
        )
      )
    );
    assertEquals(
      hookDestination,
      "https://api.github.com/repos/owner/pipeline/actions/workflows/17/runs?per_page=10&page=1",
    );
    assertEquals(connectorCalls, 1);
    const db = new DatabaseSync(join(dirname(path), "sentinel-adaptive.db"));
    try {
      db.exec("UPDATE adaptive_model_attempts SET started = 0");
    } finally {
      db.close();
    }
    now.value += 60_001;
    planner.advance(state);
    await waitFor(() =>
      sawResult &&
      !!readAdaptiveSentinel(path, state)?.tasks.some(({ kind }) =>
        kind === "trace"
      )
    );
    const adaptive = readAdaptiveSentinel(path, state)!;
    const followUp = adaptive.tasks.find(({ kind }) => kind === "trace")!;
    const source = adaptive.tasks.find(({ kind }) => kind === "impact")!;
    assertEquals(followUp.prerequisites, [source.id]);
    assertEquals(followUp.plannerRound?.sourceKind, "model_review");
    const graph = buildSentinelProvenance(state.result, adaptive).snapshot();
    const receipt = graph.nodes.find((node) =>
      "githubWorkflowRead" in node &&
      node.githubWorkflowRead?.runs[0]?.id === 51
    );
    assert(receipt);
    assert(
      graph.edges.some(({ to, relation }) =>
        to === receipt.id && relation === "references"
      ),
    );
  } finally {
    planner.stop();
    await waitFor(() => !planner.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});
