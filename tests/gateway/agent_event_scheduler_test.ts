import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { sentinelAgentEventSources } from "../../src/gateway/sentinel_agent_event_sources.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createAgentEventScheduler } from "../../src/scheduler/service_agent_events.ts";
import {
  completeSentinelAssessmentGoal,
  readSentinelCaseStatus,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { reconcileSentinelDeadlineGoal } from "../../src/gateway/sentinel_goal_completion.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { openSentinelWorkerFindingStore } from "../../src/sentinel/worker_finding_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { dirname, join } from "@std/path";

Deno.test("Reviewed event subscription dispatches committed case metadata only once across restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const registry = createProviderRegistry();
  const token = crypto.randomUUID();
  let requested: Record<string, unknown> = {};
  let result = "";
  let approve = true;
  let rootCalls = 0;
  registry.register({
    name: "agent-event-fixture",
    supportsStreaming: false,
    complete(messages) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      const last = messages.at(-1);
      if (last?.role === "tool") {
        result = String(last.content);
        return Promise.resolve({ content: "Done.", usage, toolCalls: [] });
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(requested),
          },
        }],
      });
    },
  });
  registry.setDefault("agent-event-fixture");
  const owner = "owner" as UserId;
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: owner,
        channelId: "owner-event" as ChannelId,
      }),
      providerRegistry: registry,
      toolExecutor: () => Promise.resolve("Unexpected tool"),
      hookRunner: {
        evaluateHook(hook, context) {
          if (
            hook === "PRE_TOOL_CALL" &&
            context.input.tool_name === "operator_runs"
          ) rootCalls++;
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
        confirm: () => Promise.resolve(approve),
      }),
    }),
  });
  let socket: WebSocket | undefined;
  const messages: string[] = [];
  const prompts: string[][] = [];
  const scheduler = createAgentEventScheduler({
    agentEvents: sentinelAgentEventSources(baseDir),
    orchestratorFactory: {
      create(channel, options) {
        assert(options?.eventRecipient);
        assert(options.eventRecipient.isCurrent());
        assertEquals(options.eventRecipient.tools, ["list_directory"]);
        prompts.push([...(options.systemPromptSections ?? [])]);
        const session = createSession({
          userId: owner,
          channelId: channel as ChannelId,
        });
        return Promise.resolve({
          session,
          toolExecutor: () =>
            Promise.resolve("No tools in the scheduler fixture."),
          getSessionTaint: () => "INTERNAL" as const,
          orchestrator: {
            getHistory: () => [],
            clearHistory() {},
            compactHistory: () =>
              Promise.resolve({
                messagesBefore: 0,
                messagesAfter: 0,
                tokensBefore: 0,
                tokensAfter: 0,
              }),
            executeAgentTurn({ message }) {
              messages.push(String(message));
              return Promise.resolve({
                ok: true as const,
                value: {
                  response: "NO_ACTION",
                  tokenUsage: { inputTokens: 1, outputTokens: 1 },
                },
              });
            },
          },
        });
      },
    },
    triggerMdPath: "/does-not-exist",
    trigger: {
      enabled: false,
      intervalMinutes: 10,
      classificationCeiling: "INTERNAL",
    },
    webhooks: { enabled: false, sources: {} },
  });
  assert(scheduler);
  try {
    const { port } = await gateway.start();
    const ws = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const manage = async (args: Record<string, unknown>) => {
      requested = args;
      result = "";
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("No owner turn result")),
        5000,
      );
      const listener = ({ data }: MessageEvent) => {
        if (JSON.parse(String(data)).type === "turn_end") done.resolve();
      };
      ws.addEventListener("message", listener);
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            content: "Perform the reviewed operation.",
          }),
        );
        await done.promise;
        return result;
      } finally {
        clearTimeout(timer);
        ws.removeEventListener("message", listener);
      }
    };

    const agent = await manage({
      action: "set_agent_profile",
      id: "review-agent",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      profileSettings: {
        name: "Review agent",
        description: "Review requested cases.",
        role: "event",
        prompt: "Review new assessments.",
        tools: ["list_directory"],
      },
    });
    assertEquals(JSON.parse(agent).profile.version, 1);
    const subscription = {
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "new-main-review",
        agent: "review-agent",
        kinds: [
          "task_created",
          "finding",
          "goal_completed",
          "tool_completed",
          "timeout",
        ],
        tools: [
          "sentinel_assigned_target",
          "sentinel_worker_observation",
          "sentinel_report_finding",
          "list_directory",
        ],
        instructions: {
          finding: "Review current finding metadata.",
          timeout: "Review the elapsed assessment deadline.",
        },
        merge: "by_case",
        maxConcurrent: 1,
        enabled: true,
      },
    };
    approve = false;
    assertStringIncludes(await manage(subscription), "declined");
    approve = true;
    assertEquals(JSON.parse(await manage(subscription)).saved.version, 1);
    assertStringIncludes(await manage(subscription), "unavailable");
    assert(rootCalls >= 4);
    const path = resolveSentinelCasePath(baseDir);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "local",
          kind: "asset",
          label: "private case asset label",
        }],
        edges: [],
      }),
    );
    const started = startSentinelAssessment(path);
    const runId = started.plan.runId;
    assert(runId);
    advanceAdaptiveSentinel(path, started);
    const revision = adaptiveRevision(started);
    const queue = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let taskId: string;
    try {
      queue.sync(revision, [{
        kind: "trace",
        nodeId: "local",
        depth: 9,
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, started);
      const claim = queue.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.nodeId === "local",
      );
      assert(claim);
      taskId = claim.task.id;
      assert(queue.finishModelReview(revision, taskId, claim.token, {
        note: "Committed private review summary.",
        steps: [
          {
            tool: "sentinel_assigned_target",
            outcome: "returned",
            target: "local",
          },
          {
            tool: "sentinel_worker_observation",
            outcome: "returned",
            target: "local",
          },
          { tool: "sentinel_skipped", outcome: "returned", target: "local" },
          { tool: "sentinel_assigned_target", outcome: "error" },
        ],
      }));
    } finally {
      queue.close();
    }
    const findings = openSentinelWorkerFindingStore(path);
    let findingId: string;
    try {
      const finding = findings.recordFinding({
        caseId: "main",
        runId,
        evidenceRevision: started.revision,
        taskId,
        targetId: "local",
        graphFindingId: "local-finding",
        controlId: "local-control",
        evidenceId: "local-evidence",
        snapshotDigest: "a".repeat(64),
        requestId: crypto.randomUUID(),
        evaluatedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        title: "Local event fixture",
        summary: "Committed private finding summary.",
      });
      assert(finding);
      findingId = finding.id;
    } finally {
      findings.close();
    }
    assert(completeSentinelAssessmentGoal(
      path,
      started.revision,
      started.plan.goal ?? null,
      "Committed private goal conclusion.",
    ));
    scheduler.start();
    const seen = await manage({ action: "agent_event_subscriptions" });
    assertEquals(
      JSON.parse(seen).deliveries.map(({ state }: { state: string }) => state),
      ["completed"],
    );
    assertEquals(messages.length, 1);
    assertStringIncludes(messages[0], '"kind":"task_created"');
    assertStringIncludes(messages[0], started.plan.runId!);
    assertStringIncludes(messages[0], '"kind":"finding"');
    assertStringIncludes(messages[0], findingId);
    assertStringIncludes(messages[0], '"kind":"goal_completed"');
    assertStringIncludes(messages[0], '"kind":"tool_completed"');
    assertStringIncludes(messages[0], `${taskId}:0`);
    assertStringIncludes(messages[0], `${taskId}:1`);
    assert(!messages[0].includes("sentinel_skipped"));
    assert(!messages[0].includes(`${taskId}:3`));
    assertEquals(prompts[0], [
      "Review new assessments.",
      "Reviewed instruction for finding: Review current finding metadata.",
    ]);
    assert(!messages[0].includes("private case asset label"));
    assert(!messages[0].includes("Committed private"));
    scheduler.stop();
    scheduler.start();
    assertEquals(messages.length, 1);
    const final = await manage({ action: "agent_event_subscriptions" });
    assertEquals(JSON.parse(final).deliveries.length, 1);
    assertEquals(messages.length, 1);

    scheduler.stop();
    const timeoutCase = "deadline-case";
    const timeoutPath = resolveSentinelCasePath(baseDir, timeoutCase);
    await Deno.mkdir(dirname(timeoutPath), { recursive: true });
    await Deno.copyFile(path, timeoutPath);
    const timed = JSON.parse(
      await manage({
        action: "spawn",
        kind: "sentinel",
        id: "main",
        revision: started.revision,
        targetKind: "sentinel",
        targetId: timeoutCase,
        requestId: crypto.randomUUID(),
        timeoutSeconds: 1,
      }),
    ).run;
    assertEquals(timed.status, "running");
    const cutoff = timed.details.deadlineAt;
    assert(typeof cutoff === "number");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, cutoff - Date.now()) + 10)
    );
    assert(reconcileSentinelDeadlineGoal(timeoutPath));
    const settled = readSentinelCaseStatus(timeoutPath, true);
    assertEquals(settled?.status, "timed_out");
    const timedRunId = settled?.discovery?.runId;
    assert(timedRunId);
    const afterTimeout = startSentinelAssessment(timeoutPath);
    assert(afterTimeout.plan.runId !== timedRunId);
    assertEquals(readSentinelCaseStatus(timeoutPath, true)?.status, "running");
    scheduler.start();
    // The authenticated owner waits for the scheduler's durable delivery ledger.
    const deliveries = await manage({ action: "agent_event_subscriptions" });
    assertEquals(JSON.parse(deliveries).deliveries.length, 2);
    assertEquals(messages.length, 2);
    assertEquals(prompts[1], [
      "Review new assessments.",
      "Reviewed instruction for timeout: Review the elapsed assessment deadline.",
    ]);
    assertStringIncludes(
      messages[1],
      JSON.stringify({
        kind: "timeout",
        receipt: timedRunId,
        caseId: timeoutCase,
        recordedAt: cutoff,
      }),
    );
    scheduler.stop();
    scheduler.start();
    const afterRestart = await manage({ action: "agent_event_subscriptions" });
    assertEquals(JSON.parse(afterRestart).deliveries.length, 2);
    assertEquals(messages.length, 2);

    scheduler.stop();
    const interval = {
      ...subscription,
      subscriptionSettings: {
        id: "interval-health",
        agent: "review-agent",
        kinds: ["interval"],
        intervalMs: 60_000,
        fireOnStart: true,
        merge: "none",
        maxConcurrent: 1,
        enabled: true,
      },
    };
    assertEquals(JSON.parse(await manage(interval)).saved.version, 1);
    scheduler.start();
    const intervalLedger = await manage({
      action: "agent_event_subscriptions",
    });
    assertEquals(JSON.parse(intervalLedger).deliveries.length, 3);
    assertEquals(messages.length, 3);
    assertStringIncludes(messages[2], '"kind":"interval"');
    scheduler.stop();
    scheduler.start();
    const intervalRestart = await manage({
      action: "agent_event_subscriptions",
    });
    assertEquals(JSON.parse(intervalRestart).deliveries.length, 3);
    assertEquals(messages.length, 3);

    const remove = {
      action: "delete_agent_event_subscription",
      id: interval.subscriptionSettings.id,
      expectedVersion: 1,
    };
    approve = false;
    assertStringIncludes(await manage(remove), "declined");
    approve = true;
    assertStringIncludes(
      await manage({ ...remove, expectedVersion: 2 }),
      "unavailable",
    );
    const deleted = JSON.parse(await manage(remove));
    assertEquals(deleted.saved, { id: remove.id, version: 2, deleted: true });
    scheduler.stop();
    scheduler.start();
    assertEquals(JSON.parse(await manage(remove)), deleted);
    const remaining = JSON.parse(
      await manage({ action: "agent_event_subscriptions" }),
    );
    assertEquals(
      remaining.subscriptions.map(({ subscription }: {
        subscription: { id: string };
      }) => subscription.id),
      [subscription.subscriptionSettings.id],
    );
    assertEquals(remaining.deliveries.length, 3);
    assertEquals(messages.length, 3);

    scheduler.stop();
    assertEquals(
      JSON.parse(
        await manage({
          ...subscription,
          expectedVersion: 1,
          subscriptionSettings: {
            ...subscription.subscriptionSettings,
            includeToolErrors: true,
          },
        }),
      ).saved.version,
      2,
    );
    const closed = startSentinelAssessment(path, { goal: "Retained goal" });
    assert(closed.plan.runId);
    advanceAdaptiveSentinel(path, closed);
    const endedRevision = adaptiveRevision(closed);
    const endedQueue = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let endedTaskId: string;
    try {
      endedQueue.sync(endedRevision, [{
        kind: "trace",
        nodeId: "local",
        depth: 9,
        reason: MODEL_ASSIGNMENT_REASON,
      }], endedRevision);
      advanceAdaptiveSentinel(path, closed);
      const claim = endedQueue.claimModelReview(
        endedRevision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.nodeId === "local",
      );
      assert(claim);
      endedTaskId = claim.task.id;
      assert(
        endedQueue.finishModelReview(endedRevision, endedTaskId, claim.token, {
          note: "Private historical tool result.",
          steps: [
            {
              tool: "sentinel_assigned_target",
              outcome: "returned",
              target: "local",
            },
            { tool: "sentinel_assigned_target", outcome: "error" },
            { tool: "sentinel_report_finding", outcome: "error" },
          ],
        }),
      );
    } finally {
      endedQueue.close();
    }
    const closedFindings = openSentinelWorkerFindingStore(path);
    let closedFindingId: string;
    try {
      const finding = closedFindings.recordFinding({
        caseId: "main",
        runId: closed.plan.runId,
        evidenceRevision: closed.revision,
        taskId: endedTaskId,
        targetId: "local",
        graphFindingId: "retained-finding",
        controlId: "local-control",
        evidenceId: "local-evidence",
        snapshotDigest: "b".repeat(64),
        requestId: crypto.randomUUID(),
        evaluatedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        title: "Retained finding",
        summary: "Private historical finding.",
      });
      assert(finding);
      closedFindingId = finding.id;
    } finally {
      closedFindings.close();
    }
    assert(completeSentinelAssessmentGoal(
      path,
      closed.revision,
      "Retained goal",
      "Private historical conclusion.",
    ));
    const replacement = startSentinelAssessment(path, { goal: "New goal" });
    assert(replacement.revision > closed.revision);
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 4);

    assertStringIncludes(messages[3], '"kind":"goal_completed"');
    assertStringIncludes(
      messages[3],
      `${closed.plan.runId}:${closed.revision}`,
    );
    assert(!messages[3].includes("Private historical conclusion"));
    assertStringIncludes(messages[3], '"kind":"finding"');
    assertStringIncludes(messages[3], closedFindingId);
    assert(!messages[3].includes("Private historical finding"));
    assertStringIncludes(messages[3], '"kind":"tool_completed"');
    assertStringIncludes(messages[3], `${endedTaskId}:0`);
    assertStringIncludes(messages[3], `${endedTaskId}:1`);
    assertStringIncludes(messages[3], '"outcome":"error"');
    assert(!messages[3].includes(`${endedTaskId}:2`));
    assert(!messages[3].includes("Private historical tool result"));
    for (const run of [closed, replacement]) {
      assertStringIncludes(
        messages[3],
        JSON.stringify({
          kind: "task_created",
          receipt: run.plan.runId,
          caseId: "main",
          recordedAt: run.plan.runStartedAt,
        }),
      );
    }
    scheduler.stop();
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 4);

    scheduler.stop();
    const traces = openExecutionTraces(join(baseDir, "execution-traces.db"));
    const backgroundScope = {
      role: "scheduled" as const,
      runId: "scheduled-fixture-run",
      sessionId: "scheduled-fixture-session",
      sourceId: "scheduler-fixture",
    };
    try {
      assert(traces.admit(backgroundScope));
      for (const outcome of ["failed", "blocked"] as const) {
        assert(traces.appendNext(backgroundScope, {
          tool: "list_directory",
          outcome,
          classification: "INTERNAL",
        }));
      }
    } finally {
      traces.close();
    }
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 5);
    assertStringIncludes(messages[4], '"tool":"list_directory"');
    assertStringIncludes(messages[4], '"outcome":"error"');
    assert(!messages[4].includes('"outcome":"blocked"'));

    scheduler.stop();
    const burst = {
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "background-burst",
        agent: "review-agent",
        kinds: ["tool_completed"],
        tool: "fixture_background_burst",
        merge: "all",
        maxConcurrent: 1,
        enabled: true,
      },
    };
    assertEquals(JSON.parse(await manage(burst)).saved.version, 1);
    const burstTraces = openExecutionTraces(
      join(baseDir, "execution-traces.db"),
    );
    const burstIds: string[] = [];
    try {
      for (let index = 0; index < 53; index++) {
        const entry = burstTraces.appendNext(backgroundScope, {
          tool: burst.subscriptionSettings.tool,
          outcome: "returned",
          classification: "INTERNAL",
        });
        assert(entry);
        burstIds.push(entry.id);
      }
    } finally {
      burstTraces.close();
    }
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 6);
    for (const receipt of burstIds) assertStringIncludes(messages[5], receipt);
    scheduler.stop();
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 6);
    scheduler.stop();
    for (
      const [id, expectedVersion] of [
        [subscription.subscriptionSettings.id, 2],
        [burst.subscriptionSettings.id, 1],
      ] as const
    ) {
      const removed = JSON.parse(
        await manage({
          action: "delete_agent_event_subscription",
          id,
          expectedVersion,
        }),
      );
      assertEquals(removed.saved.deleted, true);
    }
    const fifoCaseId = "fifo-restart";
    const fifoTool = "fixture_fifo_trace";
    for (
      const setting of [
        {
          id: "aaa-newer-case",
          kinds: ["task_created"],
          caseId: fifoCaseId,
          merge: "none",
        },
        {
          id: "zzz-older-trace",
          kinds: ["tool_completed"],
          tool: fifoTool,
          merge: "all",
        },
      ]
    ) {
      const configured = await manage({
        action: "set_agent_event_subscription",
        expectedVersion: 0,
        subscriptionSettings: {
          ...setting,
          agent: "review-agent",
          maxConcurrent: 1,
          enabled: true,
        },
      });
      assertEquals(JSON.parse(configured).saved.version, 1);
    }
    let committedAt = Date.now();
    const fifoTraces = openExecutionTraces(
      join(baseDir, "execution-traces.db"),
      () => committedAt,
    );
    const orderedReceipts: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const receipt = fifoTraces.appendNext(backgroundScope, {
          tool: fifoTool,
          outcome: "returned",
          classification: "INTERNAL",
        });
        assert(receipt);
        orderedReceipts.push(receipt.id);
        committedAt++;
      }
    } finally {
      fifoTraces.close();
    }
    const fifoPath = resolveSentinelCasePath(baseDir, fifoCaseId);
    await Deno.mkdir(dirname(fifoPath), { recursive: true });
    await Deno.copyFile(path, fifoPath);
    while (Date.now() <= committedAt) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const newest = startSentinelAssessment(fifoPath);
    assert(newest.plan.runStartedAt! > committedAt);
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 7);
    const receiptsIn = (message: string) =>
      (JSON.parse(message.split("\n").at(-1)!) as { receipt: string }[])
        .map(({ receipt }) => receipt);
    assertEquals(receiptsIn(messages[6]), orderedReceipts);

    scheduler.stop();
    scheduler.start();
    const fifoHistory = JSON.parse(
      await manage({ action: "agent_event_subscriptions" }),
    );
    assertEquals(messages.length, 8);
    assertEquals(receiptsIn(messages[7]), [newest.plan.runId]);
    assertEquals(
      fifoHistory.deliveries.slice(0, 2).map(
        (
          { subscription, state }: { subscription: string; state: string },
        ) => [subscription, state],
      ),
      [["aaa-newer-case", "completed"], ["zzz-older-trace", "completed"]],
    );
    scheduler.stop();
    scheduler.start();
    await manage({ action: "agent_event_subscriptions" });
    assertEquals(messages.length, 8);

    scheduler.stop();
    const liveSubscription = await manage({
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "live-worker-steps",
        agent: "review-agent",
        caseId: fifoCaseId,
        kinds: ["tool_completed"],
        tool: "sentinel_assigned_target",
        merge: "by_case",
        maxConcurrent: 1,
        enabled: true,
      },
    });
    assertEquals(JSON.parse(liveSubscription).saved.version, 1);
    advanceAdaptiveSentinel(fifoPath, newest);
    const liveQueue = openSentinelAdaptiveStore(
      join(dirname(fifoPath), "sentinel-adaptive.db"),
    );
    const liveRevision = adaptiveRevision(newest);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const workerRegistry = createProviderRegistry();
    const steps: Parameters<
      typeof liveQueue.recordModelReviewProgress
    >[3][number][] = [];
    let calls = 0;
    workerRegistry.register({
      name: "live-step-fixture",
      supportsStreaming: false,
      async complete() {
        if (++calls <= 3) {
          return {
            content: "",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [{
              id: `assigned-target-${calls}`,
              type: "function" as const,
              function: { name: "sentinel_assigned_target", arguments: "{}" },
            }],
          };
        }
        ready.resolve();
        await release.promise;
        return {
          content: "Review done.",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    workerRegistry.setDefault("live-step-fixture");
    try {
      liveQueue.sync(liveRevision, [{
        kind: "trace",
        nodeId: "local",
        depth: 9,
        reason: MODEL_ASSIGNMENT_REASON,
      }], liveRevision);
      advanceAdaptiveSentinel(fifoPath, newest);
      const claim = liveQueue.claimModelReview(
        liveRevision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.nodeId === "local",
      );
      assert(claim);
      let checked = 0;
      const worker = createSentinelSubagent({
        snapshotPath: fifoPath,
        assessmentRevision: newest.revision,
        assignedTaskId: claim.task.id,
        assignedTaskLeaseToken: claim.token,
        providerRegistry: workerRegistry,
        allowModelAccess: true,
        hookRunner: {
          evaluateHook(hook, context) {
            const blocked = hook === "PRE_TOOL_CALL" &&
              context.input.tool_name === "sentinel_assigned_target" &&
              ++checked === 1;
            return Promise.resolve({
              allowed: !blocked,
              action: blocked ? "BLOCK" : "ALLOW",
              ruleId: null,
              duration: 0,
            });
          },
        },
      });
      const execute = worker.execute(
        "Read the assigned asset.",
        () => {},
        undefined,
        (step) => {
          steps.push(step);
          assert(liveQueue.recordModelReviewProgress(
            liveRevision,
            claim.task.id,
            claim.token,
            steps,
          ));
        },
      );
      try {
        await Promise.race([
          ready.promise,
          execute.then(() => {
            throw new Error("Worker ended before it saved a live step");
          }),
        ]);
        assertEquals(checked, 3);
        assertEquals(steps.map(({ outcome }) => outcome), [
          "returned",
          "returned",
        ]);
        assert(liveQueue.activeModelReviewTask(
          liveRevision,
          claim.task.id,
          claim.token,
        ));
        assertEquals(liveQueue.modelReviewNotes(liveRevision), []);
        assert(liveQueue.recordModelReviewProgress(
          liveRevision,
          claim.task.id,
          claim.token,
          steps,
        ));
        scheduler.start();
        await manage({ action: "agent_event_subscriptions" });
        assertEquals(messages.length, 9);
        const receipts = receiptsIn(messages[8]);
        assertEquals(receipts.length, 2);
        assertEquals(new Set(receipts).size, 2);
        assert(
          receipts.every((receipt) =>
            /^worker-step:[a-f0-9]{64}$/.test(receipt)
          ),
        );
        assertStringIncludes(messages[8], '"tool":"sentinel_assigned_target"');
        assert(!messages[8].includes('"target":"local"'));
      } finally {
        release.resolve();
        await execute;
        worker.clear();
      }
      assert(
        liveQueue.finishModelReview(liveRevision, claim.task.id, claim.token, {
          note: "Review done.",
          steps,
        }),
      );
      scheduler.stop();
      scheduler.start();
      await manage({ action: "agent_event_subscriptions" });
      assertEquals(messages.length, 9);
    } finally {
      liveQueue.close();
    }

    scheduler.stop();
    const planningSubscription = await manage({
      action: "set_agent_event_subscription",
      expectedVersion: 0,
      subscriptionSettings: {
        id: "live-planner-steps",
        agent: "review-agent",
        caseId: fifoCaseId,
        kinds: ["tool_completed"],
        tool: "sentinel_graph_overview",
        merge: "by_case",
        maxConcurrent: 1,
        enabled: true,
      },
    });
    assertEquals(JSON.parse(planningSubscription).saved.version, 1);
    const planningRegistry = createProviderRegistry();
    const plannerRead = Promise.withResolvers<void>();
    const finishPlanning = Promise.withResolvers<void>();
    let planningCalls = 0;
    let checkedPlannerCalls = 0;
    let plannerResults: string[] = [];
    planningRegistry.register({
      name: "planner-event-fixture",
      supportsStreaming: false,
      async complete(messages) {
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (++planningCalls <= 2) {
          return {
            content: "",
            usage,
            toolCalls: [{
              id: `overview-${planningCalls}`,
              type: "function",
              function: { name: "sentinel_graph_overview", arguments: "{}" },
            }],
          };
        }
        plannerResults = messages.filter(({ role }) => role === "tool")
          .map(({ content }) => String(content));
        plannerRead.resolve();
        await finishPlanning.promise;
        return { content: "[]", usage, toolCalls: [] };
      },
    });
    planningRegistry.setDefault("planner-event-fixture");
    const planner = createSentinelModelPlanner(
      fifoPath,
      (state, taskId) =>
        taskId
          ? { execute: () => Promise.resolve(), clear() {} }
          : createSentinelSubagent({
            snapshotPath: fifoPath,
            assessmentRevision: state.revision,
            plannerExecutionEvidenceRunId: state.plan.runId,
            providerRegistry: planningRegistry,
            allowModelAccess: true,
            hookRunner: {
              evaluateHook(hook, context) {
                const blocked = hook === "PRE_TOOL_CALL" &&
                  context.input.tool_name === "sentinel_graph_overview" &&
                  ++checkedPlannerCalls === 1;
                return Promise.resolve({
                  allowed: !blocked,
                  action: blocked ? "BLOCK" : "ALLOW",
                  ruleId: null,
                  duration: 0,
                });
              },
            },
          }),
    );
    const timeout = setTimeout(() => {
      plannerRead.reject(
        new Error("Planner did not reach the saved tool result"),
      );
    }, 5_000);
    try {
      planner.advance(newest);
      await plannerRead.promise;
      assertEquals(checkedPlannerCalls, 2);
      assertEquals(plannerResults.length, 2);
      assertStringIncludes(plannerResults[0], "blocked by policy");
      assert(plannerResults[1].startsWith("{"), plannerResults[1]);
      scheduler.start();
      await manage({ action: "agent_event_subscriptions" });
      assertEquals(messages.length, 10);
      const receipts = receiptsIn(messages[9]);
      assertEquals(receipts.length, 1);
      assert(/^planner-step:[a-f0-9]{64}$/.test(receipts[0]));
      assertStringIncludes(messages[9], '"tool":"sentinel_graph_overview"');
      assert(!messages[9].includes('"nodes"'));
      scheduler.stop();
      scheduler.start();
      await manage({ action: "agent_event_subscriptions" });
      assertEquals(messages.length, 10);
    } finally {
      clearTimeout(timeout);
      finishPlanning.resolve();
      planner.stop();
    }
  } finally {
    scheduler.stop();
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
