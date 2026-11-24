import { createHash } from "node:crypto";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createProviderRegistry,
  type LlmProvider,
} from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import type { AgentTurnCheckpoint } from "../../src/core/types/orchestrator.ts";
import {
  createSentinelAgent,
  createSentinelSubagent,
  type SentinelReadTrace,
} from "../../src/gateway/sentinel_agent.ts";

import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  recordSentinelModelUsage,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  refreshSentinelAssessment,
  type SentinelReviewStep,
  startSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../../src/sentinel/assessment_store.ts";

import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
  sentinelIncidentCandidates,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  digestSentinelSnapshot,
  readArchivedSentinelSnapshot,
  readSharedSentinelTopologySource,
} from "../../src/sentinel/shared_inventory.ts";
import { syncSentinelTopology } from "../../src/gateway/sentinel_topology_sync.ts";
import { auditSentinelSourceSnapshots } from "../../src/sentinel/source_snapshot_audit.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

const allowHooks: HookRunner = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW",
      ruleId: null,
      duration: 0,
    }),
};

function complete(content: string, toolCalls: readonly unknown[] = []) {
  return { content, toolCalls, usage: { inputTokens: 1, outputTokens: 1 } };
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: "function",
    id,
    function: { name, arguments: JSON.stringify(input) },
  };
}

function registryWith(handler: LlmProvider["complete"]) {
  const registry = createProviderRegistry();
  const provider = {
    name: "sentinel-test",
    supportsStreaming: false,
    complete: handler,
  };
  registry.register(provider);
  registry.setDefault(provider.name);
  return registry;
}

function responses(events: readonly ChatEvent[]) {
  return events.filter((event) => event.type === "response");
}

Deno.test("Sentinel agent uses distinct turns and an exact defensive tool set", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "F-1",
          kind: "finding",
          label: "Missing update",
          severity: "high",
        }],
        edges: [],
      }),
    );
    const observedSessions: unknown[] = [];
    const observedUsers: unknown[] = [];
    let sawGraph = false;
    let outputLanguage: "en" | "ja" = "en";
    let blockedUnavailableTool = false;
    const registry = registryWith((messages, tools, options) => {
      observedSessions.push(options.sessionId);
      assertStringIncludes(
        JSON.stringify(messages),
        `review summaries in ${
          outputLanguage === "en" ? "English" : "Japanese"
        }`,
      );
      observedUsers.push(
        messages.filter(({ role }) => role === "user").map(({ content }) =>
          content
        ),
      );
      const encodedTools = JSON.stringify(tools);
      assertStringIncludes(encodedTools, "sentinel_report");
      assertStringIncludes(encodedTools, "sentinel_path");
      assertStringIncludes(encodedTools, "sentinel_subagent");
      assert(!encodedTools.includes("read_more"));
      assert(!encodedTools.includes("run_command"));

      if (observedSessions.length === 1) {
        return Promise.resolve(complete("", [
          toolCall("read", "sentinel_report", {}),
          toolCall("path", "sentinel_path", {
            from: "F-1",
            to: "F-1",
            depth: 0,
          }),
          toolCall("invalid-path", "sentinel_path", {
            from: "F-1",
            to: "F-1",
            direction: "wildcard",
          }),
          toolCall("denied", "run_command", { command: "false" }),
        ]));
      }
      const serialized = JSON.stringify(messages);
      if (observedSessions.length === 2) {
        sawGraph = serialized.includes("Missing update");
        blockedUnavailableTool = serialized.includes(
          "This tool is unavailable in Sentinel",
        );
      }
      return Promise.resolve(complete("Finding F-1 records a missing update."));
    });
    const agent = createSentinelAgent({
      providerRegistry: registry,
      hookRunner: allowHooks,
      snapshotPath: path,
      allowModelAccess: true,
      readOutputLanguage: () => outputLanguage,
    });
    const events: ChatEvent[] = [];
    const steps: unknown[] = [];
    await agent.execute(
      "Analyze the graph.",
      (event) => events.push(event),
      undefined,
      (step) => steps.push(step),
    );
    assertEquals(steps, [
      { tool: "sentinel_report", outcome: "returned" },
      { tool: "sentinel_path", target: "F-1", outcome: "returned" },
      { tool: "sentinel_path", outcome: "error" },
    ]);
    outputLanguage = "ja";
    await agent.execute("Continue analysis.", (event) => events.push(event));
    agent.clear();
    await agent.execute("New investigation.", (event) => events.push(event));

    assert(sawGraph);
    assert(blockedUnavailableTool);
    assertEquals(observedSessions[0], observedSessions[2]);
    assert(observedSessions[2] !== observedSessions[3]);
    assertEquals(observedUsers[3], ["New investigation."]);
    assertEquals(responses(events).map(({ taint }) => taint), [
      "INTERNAL",
      "INTERNAL",
      "INTERNAL",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel delegation uses a fresh worker with no recursive tool", async () => {
  let parentId: unknown;
  let workerId: unknown;
  let observedWorkerResult = false;
  const registry = registryWith((messages, tools, options) => {
    const serializedTools = JSON.stringify(tools);
    assertStringIncludes(
      JSON.stringify(messages),
      "Write user-facing replies and review summaries in Spanish",
    );
    if (!parentId) {
      parentId = options.sessionId;
      return Promise.resolve(complete("", [
        toolCall("worker", "sentinel_subagent", {
          question: "Review the evidence.",
        }),
      ]));
    }
    if (parentId === options.sessionId) {
      observedWorkerResult = JSON.stringify(messages).includes(
        "Worker analysis.",
      );
      return Promise.resolve(complete("Parent analysis is complete."));
    }
    workerId = options.sessionId;
    assertStringIncludes(serializedTools, "sentinel_report");
    assert(!serializedTools.includes("sentinel_subagent"));
    assert(!JSON.stringify(messages).includes("Parent investigation"));
    return Promise.resolve(complete("Worker analysis."));
  });
  const config = {
    providerRegistry: registry,
    hookRunner: allowHooks,
    snapshotPath: "unused",
    allowModelAccess: true,
    outputLanguage: "es" as const,
  };
  const agent = createSentinelAgent(config);
  const events: ChatEvent[] = [];
  await agent.execute("Parent investigation", (event) => events.push(event));
  assert(observedWorkerResult);
  assert(workerId !== parentId);
  assertEquals(responses(events).map(({ text }) => text), [
    "Parent analysis is complete.",
  ]);

  const worker = createSentinelSubagent(config);
  await worker.execute("Standalone investigation", () => {});
  assert(workerId !== parentId);
});

Deno.test("A background Sentinel worker rejects unregistered capabilities and model-supplied evidence locations", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    const finding = (label: string) => ({
      version: 1,
      nodes: [{ id: "record", kind: "finding", severity: "high", label }],
      edges: [],
    });
    await Deno.writeTextFile(path, JSON.stringify(finding("Pinned record")));
    const pinned = startSentinelAssessment(path);
    await Deno.writeTextFile(path, JSON.stringify(finding("Live-only record")));
    refreshSentinelAssessment(path);
    const forbidden = [
      toolCall("http", "web_fetch", { url: "https://example.invalid" }),
      toolCall("shell", "run_command", { command: "pwd" }),
      toolCall("net", "network_scan", { host: "example.invalid" }),
      toolCall("secrets", "get_credentials", { name: "example" }),
      toolCall("prefix", "sentinel_web_fetch", {
        url: "https://example.invalid",
      }),
      toolCall("recursion", "sentinel_subagent", {
        question: "Read outside this case.",
      }),
      toolCall("current", "sentinel_assessment", {}),
      toolCall("unleased-target", "sentinel_assigned_target", {}),
      toolCall("unleased-prior", "sentinel_prior_assigned_evidence", {}),
    ];
    let advertised = "";
    let replies: string[] = [];
    const worker = createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: pinned.revision,
      snapshotOverride: finding("Detached override"),
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages, tools) => {
        advertised = JSON.stringify(tools);
        replies = messages.filter(({ role }) => role === "tool").map(
          ({ content }) => String(content),
        );
        if (!replies.length) {
          return Promise.resolve(complete("", [
            ...forbidden,
            toolCall("path", "sentinel_report", { path: "foreign.json" }),
            toolCall("case", "sentinel_case_hints", { case: "foreign" }),
            toolCall("revision", "sentinel_provenance_search", {
              revision: pinned.revision + 1,
            }),
            toolCall("pinned", "sentinel_report", {}),
          ]));
        }
        return Promise.resolve(complete("Reviewed the pinned evidence."));
      }),
    });
    await worker.execute("Review the archived defensive evidence.", () => {});
    assertEquals(replies.length, forbidden.length + 4);
    for (const [index, { function: { name } }] of forbidden.entries()) {
      assert(!advertised.includes(`"${name}"`));
      assertStringIncludes(
        replies[index],
        "This tool is unavailable in Sentinel",
      );
    }
    for (const reply of replies.slice(forbidden.length, -1)) {
      assertStringIncludes(reply, "Error:");
    }
    assertStringIncludes(replies.at(-1)!, "Pinned record");
    assert(!replies.join("").includes("Live-only record"));
    assert(!replies.join("").includes("Detached override"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live workflow status requires exact leased scope and trusted outbound policy", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/data/sentinel.json";
  try {
    await Deno.mkdir(dir + "/data");
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", label: "Application", kind: "asset" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(dir + "/data/sentinel-adaptive.db");
    try {
      store.sync(revision, [{
        kind: "trace",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON);
      assert(claim);
      const destination = {
        url:
          "https://api.github.com/repos/example/service/actions/workflows/10/runs",
        caseId: "main",
        repository: "example/service",
        workflowId: 10,
      };
      const receipt = {
        repository: destination.repository,
        workflowId: destination.workflowId,
        connectorId: "approved-status",
        observedAt: "2026-11-24T11:00:00.000Z",
        evidenceRevision: state.revision,
        resultSha256: "a".repeat(64),
        runs: [{ id: 20, status: "completed", conclusion: "success" }],
      };
      let mode: "normal" | "blocked" | "expired" = "normal";
      const authorizationResults: boolean[] = [];
      const requests: { taskId: string; revision: number }[] = [];
      const policyInputs: Record<string, unknown>[] = [];
      const policySessions: unknown[] = [];
      const providerSessions: unknown[] = [];
      const traces: SentinelReadTrace[] = [];
      const replies: string[][] = [];
      let calls = 0;
      const worker = createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
        allowModelAccess: true,
        hookRunner: {
          async evaluateHook(hook, context) {
            if (
              hook === "PRE_TOOL_CALL" &&
              context.input.is_outbound_request === true
            ) {
              policyInputs.push(context.input);
              policySessions.push(context.session.id);
              if (mode === "blocked") {
                return {
                  allowed: false,
                  action: "BLOCK",
                  ruleId: "fixture",
                  duration: 0,
                };
              }
            }
            return await allowHooks.evaluateHook(hook, context);
          },
        },
        async readLiveWorkflowStatus(
          { task, evidenceRevision, signal, authorize },
        ) {
          requests.push({ taskId: task.id, revision: evidenceRevision });
          if (signal.aborted) return undefined;
          authorizationResults.push(
            await authorize({ ...destination, caseId: "foreign" }),
          );
          authorizationResults.push(await authorize(destination));
          if (mode === "expired") {
            assert(
              store.finishModelReview(revision, task.id, claim.token, "failed"),
            );
          }
          return { ...receipt, ignoredRawBody: "do not expose raw content" };
        },
        providerRegistry: registryWith((messages, _tools, callOptions) => {
          providerSessions.push(callOptions.sessionId);
          if (++calls % 2 === 1) {
            return Promise.resolve(complete("", [
              toolCall("forged", "sentinel_live_workflow_status", {
                url: "https://untrusted.invalid",
              }),
              toolCall("read", "sentinel_live_workflow_status", {}),
              toolCall("repeat", "sentinel_live_workflow_status", {}),
            ]));
          }
          replies.push(
            messages.filter(({ role }) => role === "tool")
              .map(({ content }) => String(content)).slice(-3),
          );
          return Promise.resolve(complete("Reviewed workflow status."));
        }),
      });
      for (const current of ["normal", "blocked", "expired"] as const) {
        mode = current;
        await worker.execute(
          "Read the workflow status.",
          () => {},
          undefined,
          (step) => traces.push(step),
        );
      }
      assertEquals(
        requests,
        Array.from({ length: 3 }, () => ({
          taskId: claim.task.id,
          revision: state.revision,
        })),
      );
      assertEquals(authorizationResults, [
        false,
        true,
        false,
        false,
        false,
        true,
      ]);
      assertEquals(policyInputs.length, 3);
      assertEquals(policySessions, Array(3).fill(providerSessions[0]));
      assertEquals(policyInputs[0].url, destination.url);
      assertEquals(policyInputs[0].operation_type, "read");
      assertEquals(policyInputs[0].sentinel_case_id, "main");
      assertEquals(policyInputs[0].sentinel_evidence_revision, state.revision);
      assertEquals(policyInputs[0].sentinel_task_id, claim.task.id);
      assertStringIncludes(replies[0][0], "takes no arguments");
      assertEquals(JSON.parse(replies[0][1]), { targetId: "app", ...receipt });
      assertStringIncludes(replies[0][2], "already attempted");
      assertStringIncludes(replies[1][1], "unavailable for this assignment");
      assertStringIncludes(replies[2][1], "unavailable for this assignment");
      const liveReceipts = traces.filter(({ githubWorkflowRead }) =>
        githubWorkflowRead
      );
      assertEquals(liveReceipts.length, 1);
      assertEquals(liveReceipts[0].target, "app");
      assertEquals(liveReceipts[0].githubWorkflowRead, receipt);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A leased follow-up reads only its exact approved saved workflow receipt", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/sentinel.json";
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", label: "Application", kind: "asset" }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(dir + "/sentinel-adaptive.db");
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const source = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON);
      assert(source);
      const receipt = {
        repository: "example/service",
        workflowId: 12,
        connectorId: "workflow-status",
        observedAt: "2026-11-24T11:00:00.000Z",
        evidenceRevision: state.revision,
        resultSha256: "1".repeat(64),
        runs: [{ id: 20, status: "completed", conclusion: "success" }],
      };
      const otherReceipt = {
        ...receipt,
        repository: "example/other",
        resultSha256: "2".repeat(64),
      };
      assert(store.finishModelReview(revision, source.task.id, source.token, {
        note: "Saved workflow review.",
        steps: [{
          tool: "sentinel_live_workflow_status",
          target: "app",
          outcome: "returned",
          githubWorkflowRead: otherReceipt,
        }, {
          tool: "sentinel_live_workflow_status",
          target: "app",
          outcome: "returned",
          githubWorkflowRead: receipt,
        }, {
          tool: "sentinel_live_workflow_status",
          target: "app",
          outcome: "returned",
          githubWorkflowRead: { ...otherReceipt, workflowId: 99 },
        }],
      }));
      assertEquals(
        store.readSavedGitHubWorkflowReceipt(
          revision,
          source.task.id,
          "app",
          state.revision,
          otherReceipt.resultSha256,
        ),
        undefined,
      );
      store.sync(
        revision,
        [1, 2].map((depth) => ({
          kind: "trace",
          nodeId: "app",
          depth,
          reason: MODEL_ASSIGNMENT_REASON,
          prerequisites: [source.task.id],
          reviewedFrom: source.task.id,
          plannerRound: {
            identity: revision,
            attempt: 1,
            sourceKind: "model_review",
            ...(depth === 1 && {
              githubWorkflowCitation: {
                sourceTaskId: source.task.id,
                resultSha256: receipt.resultSha256,
              },
            }),
          },
        })),
        revision,
      );
      advanceAdaptiveSentinel(path, state);
      let liveAttempts = 0;
      for (const depth of [1, 2]) {
        const lease = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.depth === depth && task.kind === "trace",
        );
        assert(lease);
        let calls = 0;
        let replies: string[] = [];
        const worker = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: lease.task.id,
          assignedTaskLeaseToken: lease.token,
          hookRunner: allowHooks,
          allowModelAccess: true,
          readLiveWorkflowStatus() {
            liveAttempts++;
            return Promise.resolve(undefined);
          },
          providerRegistry: registryWith((messages) => {
            if (++calls % 2 === 1) {
              return Promise.resolve(complete("", [
                toolCall("receipt", "sentinel_saved_workflow_receipt", {}),
                toolCall("forged", "sentinel_saved_workflow_receipt", {
                  sourceTaskId: source.task.id,
                  resultSha256: otherReceipt.resultSha256,
                }),
                toolCall("trace-bypass", "sentinel_worker_trace_search", {
                  task: source.task.id,
                  stepIndices: [0, 1],
                }),
                toolCall("provenance-bypass", "sentinel_provenance_node", {
                  node: `observation:adaptive:review:${source.task.id}`,
                }),
              ]));
            }
            replies = messages.filter(({ role }) => role === "tool")
              .map(({ content }) => String(content)).slice(-4);
            return Promise.resolve(complete("Reviewed authorized records."));
          }),
        });
        await worker.execute("Review the saved workflow result.", () => {});
        if (depth === 1) {
          assertEquals(JSON.parse(replies[0]), {
            targetId: "app",
            sourceTaskId: source.task.id,
            stepIndex: 1,
            receipt,
          });
        } else {
          assertStringIncludes(
            replies[0],
            "No approved saved workflow receipt",
          );
        }
        assertStringIncludes(replies[1], "takes no arguments");
        assertStringIncludes(replies[2], "trace step is unavailable");
        assert(!replies.join("").includes(otherReceipt.repository));
        assert(!replies[3].includes(receipt.repository));
        assert(
          store.finishModelReview(
            revision,
            lease.task.id,
            lease.token,
            "failed",
          ),
        );
        await worker.execute("Try again after the lease ended.", () => {});
        assertStringIncludes(replies[0], "No approved saved workflow receipt");
      }
      assertEquals(liveAttempts, 0);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A leased Sentinel worker resumes a completed tool batch without replaying it", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/sentinel.json";
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "F-1",
          label: "Saved inventory result",
          kind: "finding",
          severity: "high",
        }],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(dir + "/sentinel-adaptive.db");
    try {
      store.sync(revision, [{
        kind: "trace",
        nodeId: "F-1",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON);
      assert(claim);
      let checkpoint: AgentTurnCheckpoint | undefined;
      const abort = new AbortController();
      const baseOptions = {
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
        hookRunner: allowHooks,
        allowModelAccess: true,
      };
      let originalProviderCalls = 0;
      const worker = createSentinelSubagent({
        ...baseOptions,
        providerRegistry: registryWith(() => {
          originalProviderCalls++;
          return Promise.resolve(complete("", [
            toolCall("report", "sentinel_report", {}),
          ]));
        }),
      });
      const question = "Review the saved case evidence.";
      await worker.execute(
        question,
        () => {},
        abort.signal,
        undefined,
        undefined,
        {
          onToolBatchCheckpoint(value) {
            checkpoint = value;
            abort.abort();
            return Promise.resolve();
          },
        },
      );
      assertEquals(originalProviderCalls, 1);
      assert(checkpoint);
      assertEquals(checkpoint.completedIterations, 1);
      assertEquals(checkpoint.toolCallCounts, [["sentinel_report:{}", 1]]);
      let resumedHistory = "";
      const replayedTools: string[] = [];
      const events: ChatEvent[] = [];
      const recovered = createSentinelSubagent({
        ...baseOptions,
        providerRegistry: registryWith((messages) => {
          resumedHistory = JSON.stringify(messages);
          return Promise.resolve(complete("Completed the recovered review."));
        }),
      });
      await recovered.execute(
        question,
        (event) => events.push(event),
        undefined,
        (step) => replayedTools.push(step.tool),
        undefined,
        { resume: checkpoint },
      );
      assertStringIncludes(resumedHistory, "Saved inventory result");
      assertEquals(replayedTools, []);
      assertEquals(responses(events).map(({ text }) => text), [
        "Completed the recovered review.",
      ]);
      let rejectedResumeAccepted = false;
      resumedHistory = "";
      await recovered.execute(
        question,
        () => {},
        undefined,
        undefined,
        undefined,
        {
          resume: {
            ...checkpoint,
            toolCallCounts: [
              ...checkpoint.toolCallCounts,
              ["sentinel_live_workflow_status:{}", 1],
            ],
          },
          onResumeAccepted() {
            rejectedResumeAccepted = true;
          },
        },
      );
      assert(!rejectedResumeAccepted);
      assert(!resumedHistory.includes("Saved inventory result"));
      assert(
        store.finishModelReview(revision, claim.task.id, claim.token, "failed"),
      );
      resumedHistory = "";
      const stale: ChatEvent[] = [];
      await recovered.execute(
        question,
        (event) => stale.push(event),
        undefined,
        undefined,
        undefined,
        {
          resume: checkpoint,
        },
      );
      assertEquals(resumedHistory, "");
      assertEquals(stale, [{
        type: "error",
        message: "Sentinel checkpointing requires an active pinned assignment.",
      }]);
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel blocks model access before provider calls without operator opt-in", async () => {
  let called = false;
  const agent = createSentinelAgent({
    providerRegistry: registryWith(() => {
      called = true;
      return Promise.resolve(complete("unexpected"));
    }),
    hookRunner: allowHooks,
    snapshotPath: "unused",
    allowModelAccess: false,
  });
  const events: ChatEvent[] = [];
  await agent.execute("Analyze this.", (event) => events.push(event));
  assert(!called);
  assertEquals(events.map(({ type }) => type), ["error"]);
});

Deno.test("Sentinel runs output policy even when the orchestrator forces a last response", async () => {
  let preOutputCalls = 0;
  const agent = createSentinelSubagent({
    providerRegistry: registryWith((_messages, tools) =>
      Promise.resolve(
        tools.length
          ? complete("", [toolCall(crypto.randomUUID(), "sentinel_trace", {})])
          : complete("Raw forced summary."),
      )
    ),
    hookRunner: {
      evaluateHook(hook, context) {
        if (hook === "PRE_OUTPUT") {
          preOutputCalls++;
          assertEquals(context.session.taint, "INTERNAL");
          assertEquals(context.input.target_classification, "INTERNAL");
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: null,
            duration: 0,
          });
        }
        return allowHooks.evaluateHook(hook, context);
      },
    },
    snapshotPath: "unused",
    allowModelAccess: true,
  });
  const events: ChatEvent[] = [];
  await agent.execute("Analyze the graph.", (event) => events.push(event));
  assertEquals(preOutputCalls, 1);
  assertEquals(responses(events), []);
  assertEquals(events.at(-1)?.type, "error");
});

Deno.test("Clearing Sentinel cancels an in-flight provider and suppresses its response", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const completion = Promise.withResolvers<ReturnType<typeof complete>>();
  const agent = createSentinelAgent({
    providerRegistry: registryWith((_messages, _tools, { signal }) => {
      assert(signal instanceof AbortSignal);
      started.resolve(signal);
      return completion.promise;
    }),
    hookRunner: allowHooks,
    snapshotPath: "unused",
    allowModelAccess: true,
  });

  const events: ChatEvent[] = [];
  const running = agent.execute(
    "Investigate the graph.",
    (event) => events.push(event),
  );
  const signal = await started.promise;
  agent.clear();
  assert(signal.aborted);
  completion.resolve(complete("Stale response."));
  await running;
  assertEquals(responses(events), []);
});

Deno.test("Sentinel workers can trace generated provenance within their assigned revision", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = dir + "/sentinel.json";
    const inventory = {
      version: 1,
      nodes: [
        {
          id: "F-1",
          kind: "finding",
          label: "Missing update",
          severity: "high",
        },
        { id: "log-1", kind: "evidence", label: "Linked service log" },
      ],
      edges: [{ from: "log-1", to: "F-1", relation: "supports" }],
    };
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    const state = startSentinelAssessment(path);
    advanceAdaptiveSentinel(path, state);
    addSentinelCaseHint(path, "Review the patch evidence.");
    const task = readAdaptiveSentinel(path, state)!.tasks.find(({ kind }) =>
      kind === "review_finding"
    )!;
    const store = openSentinelAdaptiveStore(dir + "/sentinel-adaptive.db");
    let reviewingTask: string;
    let observation: unknown;
    let pathOutput = "";
    const reviewOutput = '{"finding":"F-1"}';
    const reviewSnapshot = {
      sha256: createHash("sha256").update(reviewOutput).digest("hex"),
      excerpt: reviewOutput,
      truncated: false,
    };
    const other = dir + "/other";
    await Deno.mkdir(other);
    const foreignPath = other + "/sentinel.json";
    await Deno.writeTextFile(foreignPath, JSON.stringify(inventory));
    const foreignState = startSentinelAssessment(foreignPath);
    advanceAdaptiveSentinel(foreignPath, foreignState);
    const foreignTask =
      readAdaptiveSentinel(foreignPath, foreignState)!.tasks[0];
    try {
      const revision = store.activeRevision()!;
      store.sync(revision, [{
        kind: "trace",
        nodeId: "F-1",
        reason: MODEL_ASSIGNMENT_REASON,
      }]);
      advanceAdaptiveSentinel(path, state);
      const traced = store.list(revision).find(({ kind }) => kind === "trace")!;
      reviewingTask = traced.id;
      observation = traced.observation;
      const claim = store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON)!;
      assertEquals(claim.task.id, traced.id);
      assert(store.finishModelReview(revision, traced.id, claim.token, {
        note: "Reviewed evidence for this finding.",
        steps: [
          {
            tool: "sentinel_assigned_target",
            target: "F-1",
            outcome: "returned",
            resultSnapshot: reviewSnapshot,
            assignedTarget: { targetId: "F-1", linkedNodeIds: ["log-1"] },
          },
          { tool: "sentinel_impact", target: "F-1", outcome: "error" },
        ],
      }));
      const peer = store.claimModelReview(revision, task.reason!)!;
      assertEquals(peer.task.id, task.id);
      assert(store.finishModelReview(revision, task.id, peer.token, {
        note: "Independent peer review",
        steps: [{ tool: "sentinel_trace", target: "F-1", outcome: "returned" }],
      }));
    } finally {
      store.close();
    }
    const from = `task:adaptive:${task.id}`;
    const to = "finding:F-1";
    let calls = 0;
    const agent = createSentinelSubagent({
      snapshotPath: path,
      snapshotOverride: inventory,
      assessmentRevision: state.revision,
      assignedTaskId: reviewingTask,
      onUsage: (usage) => recordSentinelModelUsage(path, state.revision, usage),
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages) => {
        if (++calls === 1) {
          return Promise.resolve(complete("", [
            toolCall("first-page", "sentinel_provenance_search", {
              kind: "task",
              origin: "adaptive",
              limit: 1,
            }),
            toolCall("second-page", "sentinel_provenance_search", {
              kind: "task",
              origin: "adaptive",
              limit: 1,
              offset: 1,
            }),
            toolCall("search", "sentinel_worker_trace_search", {
              query: "f-1",
            }),
            toolCall("path", "sentinel_path", {
              graph: "provenance",
              from,
              to,
              depth: 2,
              direction: "outgoing",
            }),
            toolCall("inspect", "sentinel_provenance_node", {
              node: from,
              limit: 1,
            }),
            toolCall("exact-review", "sentinel_provenance_node", {
              node: `observation:adaptive:review:${reviewingTask}`,
            }),
            toolCall("wrong-revision", "sentinel_path", {
              graph: "provenance",
              from,
              to,
              revision: state.revision + 1,
            }),
            toolCall("exact-trace-step", "sentinel_worker_trace_search", {
              stepIndices: [0, 1],
              task: reviewingTask,
              limit: 1,
            }),
            toolCall("hints", "sentinel_case_hints", { limit: 1 }),
            toolCall("observation", "sentinel_worker_observation", {
              task: reviewingTask,
            }),
            toolCall("wrong-case", "sentinel_worker_observation", {
              task: foreignTask.id,
            }),
            toolCall("other-revision", "sentinel_worker_observation", {
              task: reviewingTask,
              revision: state.revision + 1,
            }),
          ]));
        }
        const results = messages.filter(({ role }) => role === "tool").map((
          { content },
        ) => content);
        const first = JSON.parse(String(results[0]));
        const second = JSON.parse(String(results[1]));
        assertEquals(first.revision, state.revision);
        assertEquals(first.nextOffset, 1);
        assertEquals(second.offset, 1);
        assert(first.nodes[0].id !== second.nodes[0].id);
        const matches = JSON.parse(String(results[2]));
        assertEquals(matches.totalSteps, 1);
        assertEquals(matches.steps[0].taskId, task.id);
        assertEquals(matches.steps[0].assignedTarget, undefined);
        pathOutput = String(results[3]);
        const output = JSON.parse(pathOutput);
        assertEquals(output.revision, state.revision);
        assertEquals(
          output.path.edges.map(({ relation }: { relation: string }) =>
            relation
          ),
          ["produces", "references"],
        );
        const inspected = JSON.parse(String(results[4]));

        assertEquals(inspected.node.id, from);
        assertEquals(inspected.nextOffset, 1);
        assertEquals(inspected.connections[0].kind, "edge");

        assertStringIncludes(
          String(results[6]),
          "outside the worker's assigned evidence revision",
        );
        const trace = JSON.parse(String(results[7]));
        assertEquals(trace.totalSteps, 2);
        assertEquals(trace.steps.length, 1);
        assertEquals(
          trace.steps[0].reviewId,
          `observation:adaptive:review:${reviewingTask}`,
        );
        assertEquals(trace.steps[0].index, 0);
        assertEquals(trace.steps[0].tool, "sentinel_assigned_target");
        assertEquals(trace.steps[0].resultSnapshot, reviewSnapshot);
        assertEquals(trace.steps[0].assignedTarget, {
          targetId: "F-1",
          linkedNodeIds: ["log-1"],
        });
        assertEquals(
          JSON.parse(String(results[8])).hints[0].text,
          "Review the patch evidence.",
        );
        const saved = JSON.parse(String(results[9]));
        assertEquals(saved.revision, state.revision);
        assertEquals(saved.task, reviewingTask);
        assertEquals(JSON.parse(saved.observationJson), observation);
        assertStringIncludes(
          String(results[10]),
          "unavailable in this case and revision",
        );
        assertStringIncludes(
          String(results[11]),
          "outside the assigned evidence revision",
        );
        assertStringIncludes(
          String(results[5]),
          `observation:adaptive:review:${reviewingTask}`,
        );
        assertStringIncludes(
          String(results[5]),
          "Reviewed evidence for this finding.",
        );
        return Promise.resolve(
          complete("The recorded task links to the finding."),
        );
      }),
    });
    const steps: unknown[] = [];
    const events: ChatEvent[] = [];
    await agent.execute(
      "Trace the saved task to the finding.",
      (event) => events.push(event),
      undefined,
      (step) => steps.push(step),
    );
    assertEquals(responses(events).map(({ text }) => text), [
      "The recorded task links to the finding.",
    ]);
    assertEquals(steps, [
      ...Array.from(
        { length: 2 },
        () => ({ tool: "sentinel_provenance_search", outcome: "returned" }),
      ),
      { tool: "sentinel_worker_trace_search", outcome: "returned" },
      {
        tool: "sentinel_path",
        target: to,
        outcome: "returned",
        resultSnapshot: {
          sha256: createHash("sha256").update(pathOutput).digest("hex"),
          excerpt: pathOutput.slice(0, 512),
          truncated: pathOutput.length > 512,
        },
      },
      { tool: "sentinel_provenance_node", target: from, outcome: "returned" },
      {
        tool: "sentinel_provenance_node",
        target: `observation:adaptive:review:${reviewingTask}`,
        outcome: "returned",
      },
      { tool: "sentinel_path", outcome: "error" },
      {
        tool: "sentinel_worker_trace_search",
        target: `observation:adaptive:review:${reviewingTask}`,
        outcome: "returned",
        workerTrace: {
          sourceTaskId: reviewingTask,
          evidenceRevision: state.revision,
          stepIndices: [0],
        },
      },
      { tool: "sentinel_case_hints", outcome: "returned" },
      {
        tool: "sentinel_worker_observation",
        target: reviewingTask,
        outcome: "returned",
      },
      { tool: "sentinel_worker_observation", outcome: "error" },
      { tool: "sentinel_worker_observation", outcome: "error" },
    ]);
    assertEquals(calls, 2);
    assertEquals(readAdaptiveSentinel(path, state)?.modelUsage, {
      calls: 2,
      inputTokens: 2,
      outputTokens: 2,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel shared asset links are anchored to the assigned case inventory", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const main = baseDir + "/data/sentinel.json";
    const namedDir = baseDir + "/data/sentinel-cases/named";
    await Deno.mkdir(namedDir, { recursive: true });
    const app = { id: "app", kind: "asset", label: "Application" };
    await Deno.writeTextFile(
      main,
      JSON.stringify({ version: 1, nodes: [app], edges: [] }),
    );
    const assigned = startSentinelAssessment(main);
    await Deno.writeTextFile(
      main,
      JSON.stringify({
        version: 1,
        nodes: [app, {
          id: "live-only",
          kind: "asset",
          label: "Live-only dependency",
        }],
        edges: [{ from: "app", to: "live-only", relation: "depends_on" }],
      }),
    );
    await Deno.writeTextFile(
      namedDir + "/sentinel.json",
      JSON.stringify({
        version: 1,
        nodes: [{ ...app, id: "remote-app", aliases: ["app"] }, {
          id: "dep",
          kind: "asset",
          label: "Dependency",
        }, {
          id: "private",
          kind: "finding",
          label: "Other case finding",
          severity: "high",
        }],
        edges: [
          { from: "remote-app", to: "dep", relation: "depends_on" },
          { from: "private", to: "remote-app", relation: "affects" },
        ],
      }),
    );
    let calls = 0;
    const worker = createSentinelSubagent({
      snapshotPath: main,
      assessmentRevision: assigned.revision,
      sharedInventoryBaseDir: baseDir,
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages) => {
        if (++calls === 1) {
          return Promise.resolve(complete("", [
            toolCall("allowed", "sentinel_shared_asset_links", {
              asset: "app",
            }),
            toolCall("out-of-case", "sentinel_shared_asset_links", {
              asset: "dep",
            }),
          ]));
        }
        const replies = messages.filter(({ role }) => role === "tool").map((
          { content },
        ) => String(content));
        const shared = JSON.parse(replies[0]);
        assertEquals(shared.source, "live_published_inventory");
        assertEquals(shared.caseEvidenceRevision, assigned.revision);
        assertEquals(shared.sourceSnapshots, [{
          caseId: "named",
          assetId: "remote-app",
          snapshotDigest: digestSentinelSnapshot(
            loadSentinelGraph(
              JSON.parse(Deno.readTextFileSync(namedDir + "/sentinel.json")),
            ).snapshot(),
          ),
        }]);
        assertEquals(shared.links, [{
          from: "app",
          to: "dep",
          relation: "depends_on",
          caseIds: ["named"],
          remapped: [{ caseId: "named", from: "remote-app", to: "dep" }],
        }]);
        assert(!replies[0].includes("Other case finding"));
        assert(!replies[0].includes("live-only"));
        assertStringIncludes(
          replies[1],
          "asset is unavailable in the assigned case",
        );
        return Promise.resolve(complete("A named case reports a dependency."));
      }),
    });
    const trace: SentinelReviewStep[] = [];
    await worker.execute(
      "What dependencies are recorded for the application?",
      () => {},
      undefined,
      (step) => trace.push(step),
    );
    assertEquals(trace[0], {
      tool: "sentinel_shared_asset_links",
      target: "app",
      outcome: "returned",
      sourceSnapshots: [{
        caseId: "named",
        assetId: "remote-app",
        snapshotDigest: digestSentinelSnapshot(
          loadSentinelGraph(
            JSON.parse(Deno.readTextFileSync(namedDir + "/sentinel.json")),
          ).snapshot(),
        ),
      }],
    });
    const source = trace[0].sourceSnapshots?.[0];
    assert(source);
    await Deno.writeTextFile(
      namedDir + "/sentinel.json",
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
    );
    const archived = await readArchivedSentinelSnapshot(
      baseDir,
      source.caseId,
      source.snapshotDigest,
    );
    assertEquals(digestSentinelSnapshot(archived), source.snapshotDigest);
    advanceAdaptiveSentinel(main, assigned);
    const store = openSentinelAdaptiveStore(
      baseDir + "/data/sentinel-adaptive.db",
    );
    try {
      const revision = store.activeRevision()!;
      store.addNote(revision, "Saved worker observations.", undefined, trace);
    } finally {
      store.close();
    }
    const audit = await auditSentinelSourceSnapshots(baseDir);
    assertEquals(audit.referencedCount, 1);
    assertEquals(audit.candidates, []);
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Pinned Sentinel workers reopen exact shared findings discovered this turn or cited in a live assignment", async () => {
  const baseDir = await Deno.makeTempDir();
  const oversizedNeighbor = "large-evidence-".padEnd(7_100, "x");
  try {
    const main = baseDir + "/data/sentinel.json";
    const peerDir = baseDir + "/data/sentinel-cases/peer";
    const peer = peerDir + "/sentinel.json";
    await Deno.mkdir(peerDir, { recursive: true });
    await Deno.writeTextFile(
      main,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "local-app", kind: "asset", label: "Application" },
          { id: oversizedNeighbor, kind: "evidence", label: "Large exact ID" },
          { id: "local-log", kind: "evidence", label: "Pinned service log" },
          { id: "separate", kind: "asset", label: "Unrelated case asset" },
        ],
        edges: [
          { from: oversizedNeighbor, to: "local-app", relation: "observed_on" },
          { from: "local-log", to: "local-app", relation: "observed_on" },
        ],
      }),
    );
    const assigned = startSentinelAssessment(main);
    await Deno.writeTextFile(
      main,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "new-live-app",
          kind: "asset",
          label: "New live publication",
        }],
        edges: [],
      }),
    );
    const source = {
      version: 1,
      nodes: [
        {
          id: "remote-app",
          kind: "asset",
          label: "Peer app",
          aliases: ["local-app"],
        },
        {
          id: "finding-a",
          kind: "finding",
          label: "Original reported finding",
          severity: "high",
        },
        {
          id: "finding-b",
          kind: "finding",
          label: "Other finding",
          severity: "info",
        },
        {
          id: "record-a",
          kind: "evidence",
          label: "Original supporting record",
        },
        { id: "record-b", kind: "evidence", label: "Unrelated peer evidence" },
      ],
      edges: [
        { from: "finding-a", to: "remote-app", relation: "affects" },
        { from: "finding-b", to: "remote-app", relation: "affects" },
        { from: "record-a", to: "finding-a", relation: "supports" },
        { from: "record-b", to: "finding-b", relation: "supports" },
      ],
    };
    await Deno.writeTextFile(peer, JSON.stringify(source));
    const digest = digestSentinelSnapshot(loadSentinelGraph(source).snapshot());
    const exact = {
      asset: "local-app",
      sourceCase: "peer",
      sourceAsset: "remote-app",
      finding: "finding-a",
      snapshotDigest: digest,
    };
    const sourceRef = {
      caseId: "peer",
      assetId: "remote-app",
      snapshotDigest: digest,
    };
    let calls = 0;
    const worker = createSentinelSubagent({
      snapshotPath: main,
      assessmentRevision: assigned.revision,
      sharedInventoryBaseDir: baseDir,
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages) => {
        const replies = messages.filter(({ role }) => role === "tool").map(
          ({ content }) => String(content),
        );
        if (++calls === 1) {
          return Promise.resolve(complete("", [
            toolCall("guessed", "sentinel_shared_finding_source", exact),
            toolCall("other-local", "sentinel_shared_asset_links", {
              asset: "new-live-app",
              includeFindings: true,
            }),
            toolCall("bounded-discovery", "sentinel_shared_asset_links", {
              asset: exact.asset,
              includeFindings: true,
              limit: 1,
            }),
          ]));
        }
        if (calls === 2) {
          assertStringIncludes(
            replies[0],
            "not returned for this assigned case",
          );
          assertStringIncludes(
            replies[1],
            "asset is unavailable in the assigned case",
          );
          const delivered = JSON.parse(replies[2]);
          assertEquals(
            delivered.findings.map(
              ({ finding }: { finding: { id: string } }) => finding.id,
            ),
            [exact.finding],
          );
          assertEquals(delivered.sourceSnapshots, [sourceRef]);
          assertEquals(delivered.links, []);
          Deno.writeTextFileSync(
            peer,
            JSON.stringify({
              ...source,
              nodes: source.nodes.map((node) =>
                node.id === "record-a"
                  ? { ...node, label: "Later replacement evidence" }
                  : node
              ),
            }),
          );
          return Promise.resolve(complete("", [
            toolCall(
              "archived-source",
              "sentinel_shared_finding_source",
              exact,
            ),
            toolCall("outside-page", "sentinel_shared_finding_source", {
              ...exact,
              finding: "finding-b",
            }),
            toolCall("wrong-case", "sentinel_shared_finding_source", {
              ...exact,
              sourceCase: "main",
            }),
            toolCall("wrong-original-asset", "sentinel_shared_finding_source", {
              ...exact,
              sourceAsset: exact.asset,
            }),
            toolCall("wrong-digest", "sentinel_shared_finding_source", {
              ...exact,
              snapshotDigest: "0".repeat(64),
            }),
          ]));
        }
        if (calls === 3) {
          const archived = JSON.parse(replies[3]);
          assertEquals(archived.caseEvidenceRevision, assigned.revision);
          assertEquals(archived.finding.id, exact.finding);
          assertEquals(archived.relationship, {
            from: "finding-a",
            relation: "affects",
            to: "remote-app",
          });
          assertEquals(archived.evidence, [{
            id: "record-a",
            label: "Original supporting record",
          }]);
          assertEquals(archived.sourceSnapshots, [sourceRef]);
          assert(!replies[3].includes("Later replacement evidence"));
          for (const error of replies.slice(4)) {
            assertStringIncludes(error, "not returned for this assigned case");
          }
          return Promise.resolve(
            complete("The original record supports the reported finding."),
          );
        }
        if (calls === 4) {
          return Promise.resolve(complete("", [
            toolCall("prior-turn", "sentinel_shared_finding_source", exact),
          ]));
        }
        assertStringIncludes(
          replies.at(-1)!,
          "not returned for this assigned case",
        );
        return Promise.resolve(
          complete("The previous turn's lookup does not authorize this read."),
        );
      }),
    });
    const trace: SentinelReviewStep[] = [];
    const peerReceipts: unknown[] = [];
    await worker.execute(
      "Inspect the peer report.",
      () => {},
      undefined,
      (step) => {
        trace.push(step);
        if (step.peerFinding) peerReceipts.push(step.peerFinding);
      },
      true,
    );
    assertEquals(peerReceipts, [{
      localAssetId: exact.asset,
      sourceCaseId: exact.sourceCase,
      sourceAssetId: exact.sourceAsset,
      sourceFindingId: exact.finding,
      snapshotDigest: exact.snapshotDigest,
    }]);
    assertEquals(calls, 3);
    await worker.execute("Try the old reference again.", () => {});
    assertEquals(calls, 5);

    const retained = trace.filter(({ outcome }) => outcome === "returned");
    assertEquals(
      retained.map(({ tool, sourceSnapshots }) => [tool, sourceSnapshots]),
      [
        ["sentinel_shared_asset_links", [sourceRef]],
        ["sentinel_shared_finding_source", [sourceRef]],
      ],
    );
    assert(retained[1].resultSnapshot?.sha256);
    advanceAdaptiveSentinel(main, assigned);
    const store = openSentinelAdaptiveStore(
      baseDir + "/data/sentinel-adaptive.db",
    );
    try {
      const revision = store.activeRevision()!;
      store.addNote(revision, "Saved finding source.", undefined, trace);
      const citation = {
        localAssetId: exact.asset,
        sourceCaseId: exact.sourceCase,
        sourceAssetId: exact.sourceAsset,
        sourceFindingId: exact.finding,
        snapshotDigest: exact.snapshotDigest,
      };
      const otherCitation = { ...citation, sourceFindingId: "finding-b" };
      store.sync(revision, [{
        kind: "trace",
        nodeId: exact.asset,
        reason: MODEL_ASSIGNMENT_REASON,
        plannerRound: {
          identity: revision,
          attempt: 1,
          peerFindingCitations: [citation],
        },
      }, {
        kind: "impact",
        nodeId: exact.asset,
        reason: MODEL_ASSIGNMENT_REASON,
        plannerRound: {
          identity: revision,
          attempt: 1,
          peerFindingCitations: [otherCitation],
        },
      }]);
      advanceAdaptiveSentinel(main, assigned);
      const claim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ kind }) => kind === "trace",
      );
      assert(claim);
      const otherClaim = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        ({ kind }) => kind === "impact",
      );
      assert(otherClaim);
      let followUpCalls = 0;
      const followUpReplies: string[][] = [];
      const targetTrace: SentinelReadTrace[] = [];
      const followUp = createSentinelSubagent({
        snapshotPath: main,
        snapshotOverride: { version: 1, nodes: [], edges: [] },
        assessmentRevision: assigned.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
        sharedInventoryBaseDir: baseDir,
        hookRunner: allowHooks,
        allowModelAccess: true,
        providerRegistry: registryWith((messages) => {
          const replies = messages.filter(({ role }) => role === "tool")
            .map(({ content }) => String(content));
          if (++followUpCalls % 2 === 1) {
            return Promise.resolve(complete("", [
              toolCall("assigned", "sentinel_shared_finding_source", exact),
              toolCall("unassigned", "sentinel_shared_finding_source", {
                ...exact,
                finding: otherCitation.sourceFindingId,
              }),
              toolCall("target", "sentinel_assigned_target", {}),
              toolCall("wrong-target", "sentinel_assigned_target", {
                node: "separate",
              }),
            ]));
          }
          followUpReplies.push(replies.slice(-4));
          return Promise.resolve(
            complete("Reviewed the available assigned record."),
          );
        }),
      });
      await followUp.execute(
        "Read the assigned archived finding.",
        () => {},
        undefined,
        (step) => targetTrace.push(step),
      );
      assert(
        store.finishModelReview(revision, claim.task.id, claim.token, "failed"),
      );
      await followUp.execute("Reuse the expired assignment.", () => {});
      assertEquals(followUpReplies.length, 2);
      assertStringIncludes(followUpReplies[0][0], "Original supporting record");
      assert(!followUpReplies[0][0].includes("Unrelated peer evidence"));
      for (
        const reply of [
          followUpReplies[0][1],
          ...followUpReplies[1].slice(0, 2),
        ]
      ) {
        assertStringIncludes(reply, "not returned for this assigned case");
      }
      const target = JSON.parse(followUpReplies[0][2]);
      assertEquals(target.taskId, claim.task.id);
      assertEquals(target.revision, assigned.revision);
      assertEquals(target.target.id, exact.asset);
      assertEquals(target.linked, [{
        id: "local-log",
        kind: "evidence",
        label: "Pinned service log",
      }]);
      assertEquals(target.relationships, [
        { from: "local-log", to: exact.asset, relation: "observed_on" },
      ]);
      assertEquals(target.linkedCount, 2);
      assertEquals(target.relationshipCount, 2);
      assertEquals(target.truncated, true);
      assert(!followUpReplies[0][2].includes("Unrelated case asset"));
      assertStringIncludes(followUpReplies[0][3], "takes no arguments");
      assertStringIncludes(followUpReplies[1][2], "no available graph target");
      const successful = targetTrace.find(({ tool, outcome }) =>
        tool === "sentinel_assigned_target" && outcome === "returned"
      );
      assertEquals(successful?.target, exact.asset);
      assertEquals(successful?.assignedTarget, {
        targetId: exact.asset,
        linkedNodeIds: ["local-log"],
      });
      assertEquals(
        targetTrace.find(({ tool, outcome }) =>
          tool === "sentinel_assigned_target" && outcome === "error"
        )?.assignedTarget,
        undefined,
      );
      assertEquals(
        successful?.resultSnapshot?.sha256,
        createHash("sha256").update(followUpReplies[0][2]).digest("hex"),
      );
    } finally {
      store.close();
    }
    const audit = await auditSentinelSourceSnapshots(baseDir);
    assertEquals(audit.referencedCount, 1);
    assertEquals(audit.candidates, []);
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("A leased Sentinel worker reopens only the authorized evidence from an exact prior review step", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/sentinel.json";
  try {
    const graph = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Application" },
        { id: "record", kind: "evidence", label: "Authorized record" },
        { id: "other", kind: "evidence", label: "Unrelated saved evidence" },
      ],
      edges: ["record", "other"].map((from) => ({
        from,
        to: "app",
        relation: "observed_on",
      })),
    };
    await Deno.writeTextFile(path, JSON.stringify(graph));
    const originalGoal = "Review assigned evidence";
    const earlier = startSentinelAssessment(path, { goal: originalGoal });
    advanceAdaptiveSentinel(path, earlier);
    const oldRevision = adaptiveRevision(earlier);
    const store = openSentinelAdaptiveStore(dir + "/sentinel-adaptive.db");
    try {
      store.sync(oldRevision, [{
        kind: "impact",
        nodeId: "app",
        reason: MODEL_ASSIGNMENT_REASON,
      }], oldRevision);
      advanceAdaptiveSentinel(path, earlier);
      const source = store.claimModelReview(
        oldRevision,
        MODEL_ASSIGNMENT_REASON,
      )!;
      const savedText = "Private narrative of the earlier review";
      assert(
        store.finishModelReview(oldRevision, source.task.id, source.token, {
          note: savedText,
          steps: [{
            tool: "sentinel_assigned_target",
            target: "app",
            outcome: "returned",
            assignedTarget: {
              targetId: "app",
              linkedNodeIds: ["record", "other"],
            },
            resultSnapshot: {
              sha256: createHash("sha256").update(savedText).digest("hex"),
              excerpt: savedText,
              truncated: false,
            },
          }],
        }),
      );
      store.sync(oldRevision, [{
        kind: "review_evidence",
        nodeId: "record",
        reason: MODEL_ASSIGNMENT_REASON,
        prerequisites: [source.task.id],
        plannerRound: {
          identity: oldRevision,
          attempt: 1,
          workerSources: [{ taskId: source.task.id, kind: "model_review" }],
        },
      }], oldRevision);
      advanceAdaptiveSentinel(path, earlier);
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...graph,
          nodes: [...graph.nodes, {
            id: "new",
            kind: "asset",
            label: "New record",
          }],
        }),
      );
      const current = refreshSentinelAssessment(path)!;
      assert(current.revision > earlier.revision);
      advanceAdaptiveSentinel(path, current);
      const currentRevision = adaptiveRevision(current);
      const claim = store.claimModelReview(
        currentRevision,
        MODEL_ASSIGNMENT_REASON,
        ({ nodeId }) => nodeId === "record",
      );
      assert(claim);
      const citation = {
        sourceTaskId: source.task.id,
        evidenceRevision: earlier.revision,
        targetId: "record",
        stepIndex: 0,
      };
      assertEquals(claim.task.plannerRound?.priorAssignedTargetCitations, [
        citation,
      ]);
      let calls = 0;
      const responsesByTurn: string[][] = [];
      const reopenTrace: SentinelReviewStep[] = [];
      const worker = createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: current.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
        hookRunner: allowHooks,
        allowModelAccess: true,
        providerRegistry: registryWith((messages) => {
          if (++calls % 2 === 1) {
            return Promise.resolve(complete("", [
              toolCall("exact-reopen", "sentinel_prior_assigned_evidence", {}),
              toolCall("forged-arg", "sentinel_prior_assigned_evidence", {
                targetId: "other",
              }),
              toolCall("old-trace", "sentinel_worker_trace_search", {
                task: source.task.id,
                revision: earlier.revision,
                stepIndices: [0],
              }),
            ]));
          }
          responsesByTurn.push(
            messages.filter(({ role }) => role === "tool")
              .map(({ content }) => String(content)).slice(-3),
          );
          return Promise.resolve(complete("Reviewed the available evidence."));
        }),
      });
      await worker.execute(
        "Read the carried evidence.",
        () => {},
        undefined,
        (step) => reopenTrace.push(step),
      );
      assertStringIncludes(responsesByTurn[0][0], "Authorized record");
      assertEquals(JSON.parse(responsesByTurn[0][0]), {
        revision: current.revision,
        taskId: claim.task.id,
        citations: [{
          ...citation,
          sourceTargetId: "app",
          evidence: {
            id: "record",
            kind: "evidence",
            label: "Authorized record",
          },
          relationships: [{
            from: "record",
            to: "app",
            relation: "observed_on",
          }],
        }],
        unavailableCount: 0,
        truncated: false,
      });
      assert(!responsesByTurn[0][0].includes(savedText));
      assert(!responsesByTurn[0][0].includes("Unrelated saved evidence"));
      assertEquals(reopenTrace[0].target, citation.targetId);
      assertEquals(
        reopenTrace[0].resultSnapshot?.sha256,
        createHash("sha256").update(responsesByTurn[0][0]).digest("hex"),
      );
      assertStringIncludes(responsesByTurn[0][1], "takes no arguments");
      assertStringIncludes(
        responsesByTurn[0][2],
        "outside the worker's assigned evidence revision",
      );
      assert(
        updateSentinelAssessmentGoal(path, "Review a different objective"),
      );
      await worker.execute("Try again after the case goal changed.", () => {});
      assertStringIncludes(
        responsesByTurn[1][0],
        "no available prior evidence citation",
      );
      assert(updateSentinelAssessmentGoal(path, originalGoal));
      assert(
        store.finishModelReview(
          currentRevision,
          claim.task.id,
          claim.token,
          "failed",
        ),
      );
      await worker.execute("Try again after the lease expired.", () => {});
      assertStringIncludes(
        responsesByTurn[2][0],
        "no available prior evidence citation",
      );
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel workers can page saved incident alerts only at their pinned revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/sentinel.json";
  try {
    const inventory = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "App" },
        { id: "finding", kind: "finding", label: "Finding", severity: "high" },
        { id: "log", kind: "evidence", label: "Log" },
      ],
      edges: [
        { from: "finding", to: "app", relation: "affects" },
        { from: "log", to: "finding", relation: "supports" },
      ],
    };
    await Deno.writeTextFile(path, JSON.stringify(inventory));
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        {
          type: "authentication_failure_burst",
          severity: "medium",
          asset: "app",
          subject: "user",
          observedAt: "2026-01-01T00:00:00.000Z",
          evidenceIds: ["auth"],
        },
        {
          type: "network_security_alert",
          severity: "high",
          asset: "app",
          subject: "sensor",
          observedAt: "2026-01-01T00:00:01.000Z",
          evidenceIds: ["net"],
        },
      ]),
    );
    const state = startSentinelAssessment(path);
    const incidentId = sentinelIncidentCandidates(state)[0].id;
    let calls = 0;
    const agent = createSentinelSubagent({
      snapshotPath: path,
      snapshotOverride: inventory,
      assessmentRevision: state.revision,
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages) => {
        if (++calls === 1) {
          return Promise.resolve(complete("", [
            toolCall("first", "sentinel_incident_alerts", {
              incidentId,
              limit: 1,
            }),
            toolCall("second", "sentinel_incident_alerts", {
              incidentId,
              offset: 1,
              limit: 1,
            }),
            toolCall("wrong", "sentinel_incident_alerts", {
              incidentId,
              revision: state.revision + 1,
            }),
          ]));
        }
        const replies = messages.filter(({ role }) => role === "tool").map((
          { content },
        ) => String(content));
        assertEquals(JSON.parse(replies[0]).alerts[0].evidenceIds, ["auth"]);
        assertEquals(JSON.parse(replies[0]).nextOffset, 1);
        assertEquals(JSON.parse(replies[1]).alerts[0].evidenceIds, ["net"]);
        assertStringIncludes(
          replies[2],
          "outside the worker's assigned evidence revision",
        );
        return Promise.resolve(complete("Reviewed saved incident evidence."));
      }),
    });
    await agent.execute("Check the saved incident.", () => {});
    assertEquals(calls, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Background Sentinel workers preserve short JSON and report unusable output as an error", async () => {
  const review = '{"summary":"Review complete","followUps":[]}';
  let content = review;
  const worker = createSentinelSubagent({
    providerRegistry: registryWith(() => Promise.resolve(complete(content))),
    hookRunner: allowHooks,
    snapshotPath: "unused",
    allowModelAccess: true,
    assessmentRevision: 1,
  });
  try {
    const events: ChatEvent[] = [];
    await worker.execute(
      "Review the assigned evidence.",
      (event) => events.push(event),
    );
    assertEquals(responses(events).map(({ text }) => text), [review]);

    content = "";
    events.length = 0;
    await worker.execute(
      "Review the same evidence again.",
      (event) => events.push(event),
    );
    assertEquals(responses(events), []);
    assert(events.some(({ type }) => type === "error"));
  } finally {
    worker.clear();
  }
});

Deno.test("Sentinel pins graph and defense coverage reads to the assigned revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = dir + "/sentinel.json";
  const now = Date.now();
  const expiry = new Date(now + 60_000);
  let controlStatus: string | undefined;
  const writeRevision = async (label: string, evidenceId: string) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "finding", kind: "finding", label, severity: "high" },
          { id: "control", kind: "control", label: "Mitigation" },
          {
            id: "record",
            kind: "evidence",
            label: "Verification",
            controlVerification: {
              outcome: "pass",
              observedAt: new Date(now - 1_000).toISOString(),
              validUntil: expiry.toISOString(),
            },
          },
        ],
        edges: [
          { from: "control", to: "finding", relation: "mitigates" },
          { from: "record", to: "control", relation: "verifies" },
        ],
      }),
    );
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        {
          type: "authentication_success_after_failures",
          severity: "high",
          asset: "fixture",
          subject: "fixture-account",
          observedAt: "2026-11-24T12:34:56.000Z",
          evidenceIds: [evidenceId],
        },
        ...["StopLogging", "UpdateTrail", "StopLogging"].map((
          action,
          index,
        ) => ({
          type: "integrity_change",
          severity: "high",
          asset: "fixture",
          subject: "fixture-account",
          observedAt: "2026-11-24T12:34:56.000Z",
          evidenceIds: [`${evidenceId}-upstream-${index}`],
          triggeringAction: `cloudtrail.amazonaws.com:${action}`,
        })),
      ]),
    );
  };
  let seen = "";
  const worker = createSentinelSubagent({
    providerRegistry: registryWith((messages) => {
      const results = messages.filter(({ role }) => role === "tool");
      if (!results.length) {
        return Promise.resolve(complete("", [
          toolCall("graph", "sentinel_coverage", {}),
          toolCall("coverage", "sentinel_defense", {
            behavior: "credential_abuse",
          }),
          toolCall("upstream-first", "sentinel_defense", {
            upstreamCheck: "cloudtrail_logging_stopped",
            limit: 1,
          }),
          toolCall("upstream-second", "sentinel_defense", {
            upstreamCheck: "cloudtrail_logging_stopped",
            offset: 1,
            limit: 1,
          }),
        ]));
      }
      seen = JSON.stringify(results);
      controlStatus =
        JSON.parse(String(results[0].content)).findings[0].controlVerification
          .status;
      const first = JSON.parse(String(results[2].content));
      const second = JSON.parse(String(results[3].content));
      assertEquals(first.revision, 1);
      assertEquals(first.matchCount, 2);
      assertEquals(first.nextOffset, 1);
      assertEquals(second.nextOffset, null);
      assertEquals(first.matches[0].evidenceIds, [
        "archived-alert-id-upstream-0",
      ]);
      assertEquals(second.matches[0].evidenceIds, [
        "archived-alert-id-upstream-2",
      ]);
      assert(first.matches[0].alertId.startsWith("case-alert:"));

      return Promise.resolve(complete("Reviewed the assigned evidence."));
    }),
    hookRunner: allowHooks,
    snapshotPath: path,
    allowModelAccess: true,
    assessmentRevision: 1,
  });
  try {
    await writeRevision("Original saved finding", "archived-alert-id");
    startSentinelAssessment(path);
    await writeRevision("Current replacement finding", "live-alert-id");
    assertEquals(
      refreshSentinelAssessment(path, undefined, expiry)?.revision,
      2,
    );
    await worker.execute(
      "Review the assigned graph and defensive signals.",
      () => {},
    );
    assertEquals(controlStatus, "pass");
    assertStringIncludes(seen, "Original saved finding");
    assertStringIncludes(seen, "archived-alert-id");
    assert(!seen.includes("Current replacement finding"));
    assert(!seen.includes("live-alert-id"));
  } finally {
    worker.clear();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("A pinned worker reconstructs only its cited shared relationship after source replacement", async () => {
  const baseDir = await Deno.makeTempDir();
  try {
    const main = baseDir + "/data/sentinel.json";
    const reporter = baseDir + "/data/sentinel-cases/reporter";
    await Deno.mkdir(reporter, { recursive: true, mode: 0o700 });
    const endpoint = { id: "app", kind: "asset", label: "Local application" };
    const dependency = { id: "db", kind: "asset", label: "Local dependency" };
    await Deno.writeTextFile(
      main,
      JSON.stringify({
        version: 1,
        nodes: [endpoint, dependency],
        edges: [],
      }),
    );
    const publication = {
      version: 1,
      nodes: [
        {
          ...endpoint,
          id: "remote-app",
          label: "Reported app",
          aliases: ["app"],
        },
        {
          ...dependency,
          id: "remote-db",
          label: "Reported DB",
          aliases: ["db"],
        },
        {
          id: "other",
          kind: "finding",
          label: "Unrelated source finding",
          severity: "low",
        },
      ],
      edges: [
        { from: "remote-app", to: "remote-db", relation: "depends_on" },
        { from: "other", to: "remote-app", relation: "affects" },
      ],
    };
    await Deno.writeTextFile(
      reporter + "/sentinel.json",
      JSON.stringify(publication),
    );
    await syncSentinelTopology(baseDir, "main", main);
    const assigned = startSentinelAssessment(main);
    const oldGraph = assigned.result?.sharedGraph.snapshot;
    assert(oldGraph);
    const evidence = oldGraph.nodes.find((node) =>
      node.kind === "evidence" && node.relationshipSources?.length
    );
    assert(evidence?.kind === "evidence");
    const digest = digestSentinelSnapshot(
      loadSentinelGraph(publication).snapshot(),
    );

    await Deno.writeTextFile(
      reporter + "/sentinel.json",
      JSON.stringify({
        ...publication,
        edges: [],
      }),
    );
    await syncSentinelTopology(baseDir, "main", main);
    const current = refreshSentinelAssessment(main)!;
    assert(current.revision > assigned.revision);
    assert(
      !current.result?.sharedGraph.snapshot?.nodes.some(({ id }) =>
        id === evidence.id
      ),
    );

    let calls = 0;
    let observed = "";
    const worker = createSentinelSubagent({
      snapshotPath: main,
      assessmentRevision: assigned.revision,
      sharedInventoryBaseDir: baseDir,
      hookRunner: allowHooks,
      allowModelAccess: true,
      providerRegistry: registryWith((messages, tools) => {
        if (++calls === 1) {
          assertStringIncludes(
            JSON.stringify(tools),
            "sentinel_shared_topology_source",
          );
          return Promise.resolve(complete("", [
            toolCall("allowed", "sentinel_shared_topology_source", {
              evidenceId: evidence.id,
              sourceCase: "reporter",
            }),
            toolCall("unrelated-case", "sentinel_shared_topology_source", {
              evidenceId: evidence.id,
              sourceCase: "main",
            }),
          ]));
        }
        const replies = messages.filter(({ role }) => role === "tool").map(
          ({ content }) => String(content),
        );
        observed = replies[0];
        assert(!observed.includes("Unrelated source finding"));
        assertEquals(JSON.parse(observed), {
          evidenceId: evidence.id,
          localRelationship: { from: "app", to: "db", relation: "depends_on" },
          archivedSource: {
            caseId: "reporter",
            snapshotDigest: digest,
            relationship: {
              from: "remote-app",
              to: "remote-db",
              relation: "depends_on",
            },
            endpoints: [
              { id: "remote-app", label: "Reported app" },
              { id: "remote-db", label: "Reported DB" },
            ],
          },
          caseEvidenceRevision: assigned.revision,
          sourceSnapshots: [
            {
              caseId: "reporter",
              assetId: "remote-app",
              snapshotDigest: digest,
            },
            {
              caseId: "reporter",
              assetId: "remote-db",
              snapshotDigest: digest,
            },
          ],
        });
        assertStringIncludes(replies[1], "cited by this assigned graph");
        return Promise.resolve(
          complete("The archived source verifies the recorded relationship."),
        );
      }),
    });
    const trace: SentinelReviewStep[] = [];
    await worker.execute(
      "Verify where the recorded relationship came from.",
      () => {},
      undefined,
      (step) => trace.push(step),
    );
    assertEquals(calls, 2);
    assertEquals(trace[0].target, evidence.id);
    assertEquals(
      trace[0].sourceSnapshots,
      JSON.parse(observed).sourceSnapshots,
    );
    assertEquals(
      trace[0].resultSnapshot?.sha256,
      createHash("sha256").update(observed).digest("hex"),
    );
    assertEquals(trace[1].outcome, "error");

    const forged = loadSentinelGraph({
      ...oldGraph,
      nodes: oldGraph.nodes.map((node) =>
        node.id !== evidence.id ? node : {
          ...evidence,
          relationshipSources: [{
            caseId: "reporter",
            snapshotDigest: digest,
            from: "remote-db",
            to: "remote-app",
          }],
        }
      ),
    }).snapshot();
    assertEquals(
      await readSharedSentinelTopologySource(
        baseDir,
        forged,
        evidence.id,
        "reporter",
      ),
      undefined,
    );
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
