import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import {
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";
import { createSentinelLiveWorkflowReader } from "../../src/gateway/sentinel_live_workflow.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { readSentinelGitHubWorkflowRuns } from "../../src/sentinel/github_workflow_runs.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";

Deno.test("An approved live workflow read drives another defensive planning round", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const now = { value: Date.now() };
  let connectorCalls = 0;
  let credentialReads = 0;
  let sawResult = false;
  let sawFollowUp = false;
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
      const followsSaved = messages.some(({ content }) =>
        typeof content === "string" &&
        content.includes("Use sentinel_saved_workflow_receipt")
      );
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
              name: followsSaved
                ? "sentinel_saved_workflow_receipt"
                : "sentinel_live_workflow_status",
              arguments: "{}",
            },
          }],
        });
      }
      assert(JSON.stringify(read.content).includes("failure"));
      assert(!JSON.stringify(read.content).includes("fixture-token"));
      if (followsSaved) sawFollowUp = true;
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
                  sourceWorkflowResultSha256:
                    entry.githubWorkflowReads[0].resultSha256,
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
      sawResult && sawFollowUp &&
      !!readAdaptiveSentinel(path, state)?.tasks.some(({ kind }) =>
        kind === "trace"
      )
    );
    const adaptive = readAdaptiveSentinel(path, state)!;
    const followUp = adaptive.tasks.find(({ kind }) => kind === "trace")!;
    const source = adaptive.tasks.find(({ kind }) => kind === "impact")!;
    assertEquals(followUp.prerequisites, [source.id]);
    assertEquals(followUp.plannerRound?.sourceKind, "model_review");
    assertEquals(
      followUp.plannerRound?.githubWorkflowCitation?.sourceTaskId,
      source.id,
    );
    assertEquals(connectorCalls, 1);
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

Deno.test("A scoped GitHub read reaches the transport only after policy approval and drops stale evidence", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  const destination =
    "https://api.github.com/repos/owner/pipeline/actions/workflows/17/runs?per_page=10&page=1";
  const transportStarted = Promise.withResolvers<void>();
  const releaseTransport = Promise.withResolvers<void>();
  const hookInputs: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const secret = "fixture-actions-token";
  let credentialReads = 0;
  let mode: "allow" | "deny" | "stale" = "allow";
  const live = createSentinelLiveWorkflowReader({
    scopes: [{
      case: "main",
      asset: "delivery",
      owner: "owner",
      repo: "pipeline",
      workflow_id: 17,
    }],
    resolveToken: () => {
      credentialReads++;
      return Promise.resolve(secret);
    },
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    readRuns: (target, options) =>
      readSentinelGitHubWorkflowRuns(target, {
        ...options,
        async request(url, init, _dns, policy) {
          requests.push(String(url));
          assertEquals(url, destination);
          assertEquals(init?.method, "GET");
          assertEquals(policy?.maxRedirects, 0);
          assertEquals(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${secret}`,
          );
          if (mode === "stale") {
            transportStarted.resolve();
            await releaseTransport.promise;
          }
          return {
            ok: true,
            value: Response.json({
              workflow_runs: [{
                id: 51,
                workflow_id: 17,
                repository: { full_name: "owner/pipeline" },
                status: "completed",
                conclusion: "failure",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:01:00Z",
                actor: { login: "fixture-private-actor" },
              }],
            }),
          };
        },
      }),
  });
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    const inventory = {
      version: 1,
      nodes: [{ id: "delivery", kind: "asset", label: "Pipeline" }],
      edges: [],
    };
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      store.sync(revision, [{
        kind: "trace",
        nodeId: "delivery",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON);
      assert(claim);
      const runWorker = async () => {
        const registry = createProviderRegistry();
        const traces: SentinelReadTrace[] = [];
        let reply = "";
        const usage = { inputTokens: 1, outputTokens: 1 };
        registry.register({
          name: "live-workflow-transport-fixture",
          supportsStreaming: false,
          complete(messages) {
            const read = messages.find(({ role }) => role === "tool");
            if (read) {
              reply = String(read.content);
              return Promise.resolve({
                content: "Reviewed.",
                usage,
                toolCalls: [],
              });
            }
            return Promise.resolve({
              content: "",
              usage,
              toolCalls: [{
                id: "fixed-read",
                type: "function",
                function: {
                  name: "sentinel_live_workflow_status",
                  arguments: "{}",
                },
              }],
            });
          },
        });
        registry.setDefault("live-workflow-transport-fixture");
        const worker = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: claim.task.id,
          assignedTaskLeaseToken: claim.token,
          providerRegistry: registry,
          allowModelAccess: true,
          hookRunner: {
            evaluateHook(hook, context) {
              const outbound = hook === "PRE_TOOL_CALL" &&
                context.input.is_outbound_request === true;
              if (outbound) hookInputs.push(context.input);
              const allowed = !outbound || mode !== "deny";
              return Promise.resolve({
                allowed,
                action: allowed ? "ALLOW" : "BLOCK",
                ruleId: null,
                duration: 0,
              });
            },
          },
          readLiveWorkflowStatus: (
            { task, evidenceRevision, signal, authorize },
          ) =>
            live({
              caseId: "main",
              assetId: task.nodeId!,
              evidenceRevision,
              signal,
              authorize,
              isCurrent: () =>
                !!readAssignedSentinelModelReview(
                  path,
                  evidenceRevision,
                  task.id,
                  claim.token,
                ),
            }),
        });
        try {
          await worker.execute(
            "Review workflow status.",
            () => {},
            undefined,
            (trace) => traces.push(trace),
          );
          return { reply, traces };
        } finally {
          worker.clear();
        }
      };
      const allowed = await runWorker();
      assertEquals(JSON.parse(allowed.reply).runs, [{
        id: 51,
        status: "completed",
        conclusion: "failure",
      }]);
      assert(!allowed.reply.includes(secret));
      assert(!allowed.reply.includes("fixture-private-actor"));
      assertEquals(
        allowed.traces[0].githubWorkflowRead?.evidenceRevision,
        state.revision,
      );
      assertEquals(credentialReads, 1);
      assertEquals(requests, [destination]);
      mode = "deny";
      const denied = await runWorker();
      assertStringIncludes(denied.reply, "unavailable for this assignment");
      assert(
        !denied.traces.some(({ githubWorkflowRead }) => githubWorkflowRead),
      );
      assertEquals(credentialReads, 1);
      assertEquals(requests, [destination]);
      mode = "stale";
      const pending = runWorker();
      let next;
      try {
        await Promise.race([
          transportStarted.promise,
          pending.then(() => {
            throw new Error(
              "The stale fixture must reach the approved transport.",
            );
          }),
        ]);
        await Deno.writeTextFile(
          path,
          JSON.stringify({
            ...inventory,
            nodes: [{
              ...inventory.nodes[0],
              label: "Pipeline with new evidence",
            }],
          }),
        );
        next = refreshSentinelAssessment(path);
        assert(next && next.revision > state.revision);
      } finally {
        releaseTransport.resolve();
      }
      const stale = await pending;
      assertStringIncludes(stale.reply, "unavailable for this assignment");
      assert(
        !stale.traces.some(({ githubWorkflowRead }) => githubWorkflowRead),
      );
      assertEquals(credentialReads, 2);
      assertEquals(requests, [destination, destination]);
      assertEquals(
        hookInputs.map((
          {
            url,
            sentinel_case_id,
            sentinel_evidence_revision,
            sentinel_task_id,
          },
        ) => [
          url,
          sentinel_case_id,
          sentinel_evidence_revision,
          sentinel_task_id,
        ]),
        Array(3).fill([destination, "main", state.revision, claim.task.id]),
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
