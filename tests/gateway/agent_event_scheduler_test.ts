import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
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
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
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
        tools: ["sentinel_assigned_target", "sentinel_worker_observation"],
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
  } finally {
    scheduler.stop();
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
