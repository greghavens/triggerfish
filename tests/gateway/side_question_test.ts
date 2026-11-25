import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  type ExecutionTraceApprovedPayload,
  executionTracePayloadCall,
  type ExecutionTraceRole,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import type { LlmProvider } from "../../src/core/types/llm.ts";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createSentinelModelPlanner } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { runRecoverableAgentTurn } from "../../src/core/agent_recovery.ts";
import {
  computeTimestampedHmac,
  createSchedulerService,
} from "../../src/scheduler/mod.ts";
import { openSchedulerWebhookAdmissions } from "../../src/scheduler/webhooks/admissions.ts";
import { openSchedulerTriggerAdmissions } from "../../src/scheduler/triggers/admissions.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";

function fixture(
  complete: LlmProvider["complete"],
  sentinel?: { path: string; base: string },
  config?: Partial<
    Pick<
      Parameters<typeof createChatSession>[0],
      | "operatorRunExecutor"
      | "tools"
      | "toolExecutor"
      | "hookRunner"
      | "resolveSideQuestionSession"
      | "sideQuestionTracePath"
      | "getSessionTaint"
    >
  >,
) {
  const registry = createProviderRegistry();
  registry.register({ name: "fixture", supportsStreaming: false, complete });
  registry.setDefault("fixture");
  const owner = createSession({
    userId: "owner" as UserId,
    channelId: "test" as ChannelId,
  });
  const messages = createMessageStore(createMemoryStorage());
  const chatSession = createChatSession({
    session: owner,
    providerRegistry: registry,
    messageStore: messages,
    hookRunner: createHookRunner(createPolicyEngine()),
    enableStreaming: false,
    ...config,
    ...(sentinel && {
      sentinelSnapshotPath: sentinel.path,
      allowSentinelModelAccess: true,
      resolveSentinelChatCase: (id: string) =>
        resolveSentinelCasePath(sentinel.base, id),
    }),
  });
  return { chatSession, owner, messages };
}

function textResult(content: string) {
  return { content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
}

async function connect(
  chatSession: ReturnType<typeof createChatSession>,
  schedulerService?: ReturnType<typeof createSchedulerService>,
) {
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession,
    schedulerService,
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const events: Record<string, unknown>[] = [];
  socket.addEventListener(
    "message",
    ({ data }) => events.push(JSON.parse(data)),
  );
  function next(type: string) {
    const result = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(
      () => result.reject(new Error("No " + type)),
      2000,
    );
    const receive = ({ data }: MessageEvent) => {
      const event = JSON.parse(data);
      if (event.type === type) result.resolve(event);
    };
    socket.addEventListener("message", receive);
    return result.promise.finally(() => {
      clearTimeout(timer);
      socket.removeEventListener("message", receive);
    });
  }
  function send(content: string, response: string) {
    const receipt = next(response);
    socket.send(JSON.stringify({ type: "message", content }));
    return receipt;
  }
  return {
    port,
    socket,
    events,
    send,
    next,
    async close() {
      const closed = new Promise((resolve) =>
        socket.addEventListener("close", resolve, { once: true })
      );
      socket.close();
      await closed;
      await gateway.stop();
    },
  };
}

Deno.test("authenticated /btw reads committed chat while the actual parent turn is held and cancels independently", async () => {
  const held = Promise.withResolvers<void>();
  const parentStarted = Promise.withResolvers<void>();
  const sideStarted = Promise.withResolvers<AbortSignal>();
  let context = "";
  const { chatSession, owner, messages } = fixture(
    async (input, tools, options) => {
      const system = String(input[0]?.content);
      const body = String(input.at(-1)?.content);
      if (system.startsWith("Answer the owner's independent")) {
        assertEquals(tools, []);
        context = body;
        if (body.includes("cancel me")) {
          const signal = options.signal as AbortSignal;
          sideStarted.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return textResult("Committed context answer.");
      }
      parentStarted.resolve();
      await held.promise;
      return textResult("Parent finished independently.");
    },
  );
  for (
    const [role, content] of [
      ["user", "A superseded failed request"],
      ["user", "Committed question"],
      ["assistant", "Committed answer"],
      ["tool_call", "Forbidden raw tool result"],
    ] as const
  ) {
    await messages.append({
      session_id: owner.id,
      role,
      content,
      classification: "PUBLIC",
    });
  }
  const ws = await connect(chatSession);
  try {
    const parent = ws.send("In-flight ordinary question", "turn_end");
    await parentStarted.promise;
    const answer = await ws.send("/btw recap this", "side_answer");
    assertStringIncludes(context, "Committed answer");
    assert(!context.includes("In-flight ordinary question"));
    assert(!context.includes("Forbidden raw tool result"));
    assert(!context.includes("superseded failed request"));
    assertEquals(ws.events.some(({ type }) => type === "turn_end"), false);
    const history = await ws.send("/btw", "side_history");
    assertEquals(history.entries, [answer.entry]);
    ws.socket.send(
      JSON.stringify({ type: "message", content: "/btw cancel me" }),
    );
    const sideSignal = await sideStarted.promise;
    const cancelled = ws.next("side_cancelled");
    ws.socket.send(JSON.stringify({ type: "side_cancel" }));
    await cancelled;
    assert(sideSignal.aborted);
    assertEquals(
      ws.events.some(({ type }) => type === "cancelled" || type === "turn_end"),
      false,
    );
    held.resolve();
    await parent;
    const after = await ws.send("/btw", "side_history");
    assertEquals(after.entries, [answer.entry]);
    const parentRows = await messages.loadActive(owner.id);
    assert(
      parentRows.some(({ content }) =>
        content === "Parent finished independently."
      ),
    );
    assert(
      !parentRows.some(({ content }) =>
        content.includes("recap this") ||
        content.includes("Committed context answer.")
      ),
    );
  } finally {
    held.resolve();
    await ws.close();
  }
});

Deno.test("authenticated Sentinel /btw reads only the selected running worker's durable progress", async () => {
  const base = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(base);
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const snapshot = {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Application" },
      { id: "evidence", kind: "evidence", label: "Evidence" },
    ],
    edges: [{ from: "evidence", to: "app", relation: "observed_on" }],
  };
  await Deno.writeTextFile(path, JSON.stringify(snapshot));
  const alternate = resolveSentinelCasePath(base, "different-case");
  await Deno.mkdir(dirname(alternate), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(alternate, JSON.stringify(snapshot));
  startSentinelAssessment(alternate);
  const state = startSentinelAssessment(path);
  const revision = adaptiveRevision(state);
  const db = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  let prompt = "";
  const sentinelSideStarted = Promise.withResolvers<AbortSignal>();
  const { chatSession, messages, owner } = fixture(
    async (input, tools, options) => {
      assertEquals(tools, []);
      prompt = String(input.at(-1)?.content);
      if (prompt.includes("cancel worker side only")) {
        const signal = options.signal as AbortSignal;
        sentinelSideStarted.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }
      return textResult("The approved worker observed the scoped evidence.");
    },
    { path, base },
  );
  await messages.append({
    session_id: owner.id,
    role: "assistant",
    content: "Committed ordinary chat fixture.",
    classification: "PUBLIC",
  });
  const workerReached = Promise.withResolvers<AbortSignal>();
  const releaseWorker = Promise.withResolvers<void>();
  const workerClosed = Promise.withResolvers<void>();
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    async execute(_content, send, signal, record) {
      if (!taskId) return;
      record?.({
        tool: "sentinel_assigned_target",
        target: "app",
        outcome: "returned",
        assignedTarget: { targetId: "app", linkedNodeIds: ["evidence"] },
        resultSnapshot: {
          sha256: "a".repeat(64),
          excerpt: "Private raw draft",
          truncated: false,
        },
      });
      assertExists(signal);
      workerReached.resolve(signal);
      await releaseWorker.promise;
      send({
        type: "response",
        text: "Worker independently finished.",
        taint: "INTERNAL",
      });
    },
    clear() {
      if (taskId) workerClosed.resolve();
    },
  }));
  const ws = await connect(chatSession);
  try {
    const [task] = db.sync(
      revision,
      [{
        kind: "trace",
        nodeId: "app",
        evidenceIds: ["evidence"],
        reason: MODEL_ASSIGNMENT_REASON,
      }],
      null,
      {
        number: state.revision,
        goal: {
          id: state.plan.runId!,
          label: "Investigate prioritized defensive findings",
        },
      },
    );
    const deterministic = db.claim(revision);
    assertExists(deterministic);
    assert(
      db.complete({
        taskId: task.id,
        leaseToken: deterministic.leaseToken,
        observation: {},
      }),
    );
    planner.advance(state);
    const timer = setTimeout(
      () =>
        workerReached.reject(
          new Error("The assigned model worker did not start"),
        ),
      2000,
    );
    const workerSignal = await workerReached.promise.finally(() =>
      clearTimeout(timer)
    );
    await ws.send("/sentinel on", "turn_end");
    await ws.send("/btw", "side_error");
    const answer = await ws.send(
      `/btw --worker ${state.revision} ${task.id} what did it read?`,
      "side_answer",
    );
    assertStringIncludes(prompt, "sentinel_assigned_target");
    assertStringIncludes(prompt, '"linkedNodeIds":["evidence"]');
    assert(!prompt.includes("Private raw draft"));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      answer.entry,
    ]);
    assertEquals(
      db.modelReviewStates(revision).find((item) => item.taskId === task.id)
        ?.status,
      "running",
    );
    assert(!workerSignal.aborted);
    ws.socket.send(
      JSON.stringify({
        type: "message",
        content: "/btw cancel worker side only",
      }),
    );
    const sideSignal = await sentinelSideStarted.promise;
    const cancelled = ws.next("side_cancelled");
    ws.socket.send(JSON.stringify({ type: "side_cancel" }));
    await cancelled;
    assert(sideSignal.aborted);
    assert(!workerSignal.aborted);
    const ordinary = await ws.send(
      "/btw --session current what did ordinary chat commit?",
      "side_answer",
    );
    assertStringIncludes(prompt, "Committed ordinary chat fixture.");
    assert(!prompt.includes("sentinel_assigned_target"));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      ordinary.entry,
    ]);
    assertEquals(
      (await ws.send(
        `/btw --worker ${state.revision} ${task.id}`,
        "side_history",
      )).entries,
      [answer.entry],
    );
    await ws.send("/sentinel case different-case", "turn_end");
    await ws.send(
      `/btw --worker ${state.revision} ${task.id} do not cross case`,
      "side_error",
    );
    assertEquals(
      db.modelReviewStates(revision).find((item) => item.taskId === task.id)
        ?.status,
      "running",
    );
    assert(!workerSignal.aborted);
    releaseWorker.resolve();
    await workerClosed.promise;
  } finally {
    releaseWorker.resolve();
    planner.stop();
    await ws.close();
    db.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("side questions verify owner session selection and reapply classified policy on history", async () => {
  const target = createSession({
    userId: "owner" as UserId,
    channelId: "authorized" as ChannelId,
  });
  const privateSession = createSession({
    userId: "different-owner" as UserId,
    channelId: "private" as ChannelId,
  });
  let blockHistory = false;
  let providerCalls = 0;
  let outbound = "";
  const inputs: { taint: string; content: unknown; audit: unknown }[] = [];
  const outputs: { taint: string; target: unknown }[] = [];
  const { chatSession, messages } = fixture(
    (input) => {
      ++providerCalls;
      outbound = String(input.at(-1)?.content);
      return Promise.resolve(textResult("Authorized side evidence."));
    },
    undefined,
    {
      getSessionTaint: () => "INTERNAL",
      resolveSideQuestionSession: (id) =>
        Promise.resolve(
          id === target.id
            ? target
            : id === privateSession.id
            ? privateSession
            : null,
        ),
      hookRunner: {
        evaluateHook(hook, { session, input, auditInput }) {
          if (hook === "PRE_CONTEXT_INJECTION") {
            inputs.push({
              taint: session.taint,
              content: input.content,
              audit: auditInput,
            });
          }
          if (hook === "PRE_OUTPUT") {
            outputs.push({
              taint: session.taint,
              target: input.target_classification,
            });
          }
          const allowed = !(hook === "PRE_CONTEXT_INJECTION" &&
            String(input.content).includes("deny input")) &&
            !(hook === "PRE_OUTPUT" && blockHistory);
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    },
  );
  await messages.append({
    session_id: target.id,
    role: "assistant",
    content: "Public committed delegated context.",
    classification: "PUBLIC",
  });
  await messages.append({
    session_id: privateSession.id,
    role: "assistant",
    content: "Private conversation.",
    classification: "PUBLIC",
  });
  const ws = await connect(chatSession);
  try {
    const answer = await ws.send(
      `/btw --session ${target.id} recap`,
      "side_answer",
    );
    assertStringIncludes(outbound, "Public committed delegated context.");
    assert(!outbound.includes("Private conversation."));
    assertEquals(inputs[0], {
      taint: "INTERNAL",
      content: outbound,
      audit: { source_type: "OWNER" },
    });
    assertEquals(outputs[0], { taint: "INTERNAL", target: "INTERNAL" });
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      answer.entry,
    ]);
    assertEquals(outputs.length, 2);
    blockHistory = true;
    assertEquals((await ws.send("/btw", "side_history")).entries, []);
    blockHistory = false;
    await ws.send("/btw deny input", "side_error");
    await ws.send(`/btw --session ${privateSession.id} recap`, "side_error");
    await ws.send(`/btw --session ${crypto.randomUUID()} recap`, "side_error");
    assertEquals(providerCalls, 1);
  } finally {
    await ws.close();
  }
});

Deno.test("authorized run side questions keep delegated and scheduled receipts and history separate", async () => {
  const base = await Deno.makeTempDir();
  const path = join(base, "execution-traces.db");
  const journal = openExecutionTraces(path);
  const delegated = {
    role: "delegated" as const,
    runId: "committed-fixture",
    sessionId: crypto.randomUUID(),
    classification: "INTERNAL" as const,
  };
  const scheduled = {
    ...delegated,
    role: "scheduled" as const,
    sessionId: crypto.randomUUID(),
  };
  const receipt = {
    classification: "INTERNAL" as const,
    outcome: "returned" as const,
  };
  let outbound = "";
  let providerCalls = 0;
  const { chatSession, messages, owner } = fixture(
    (input, tools) => {
      assertEquals(tools, []);
      outbound = String(input.at(-1)?.content);
      providerCalls++;
      if (outbound.includes("classification changed")) {
        assert(journal.appendNext(scheduled, {
          ...receipt,
          tool: "confidential_step",
          classification: "CONFIDENTIAL",
        }));
      }
      return Promise.resolve(textResult("Independent trace answer."));
    },
    undefined,
    { sideQuestionTracePath: path },
  );
  const ws = await connect(chatSession);
  try {
    assert(journal.admit(delegated));
    assert(journal.admit(scheduled));
    for (let ordinal = 1; ordinal <= 14; ordinal++) {
      assert(
        journal.append(delegated, {
          ordinal,
          ...receipt,
          tool: `delegated_step_${ordinal}`,
        }),
      );
    }
    assert(
      journal.appendNext(scheduled, {
        ...receipt,
        tool: "scheduled_unique_step",
      }),
    );
    const first = await ws.send(
      "/btw --run delegated committed-fixture recap",
      "side_answer",
    );
    const context = JSON.parse(outbound).committedContext;
    assertEquals(
      context.steps.map(({ ordinal }: { ordinal: number }) => ordinal),
      Array.from({ length: 12 }, (_, index) => index + 3),
    );
    assert(!outbound.includes("scheduled_unique_step"));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      first.entry,
    ]);

    assertEquals(
      (await ws.send("/btw --run scheduled committed-fixture", "side_history"))
        .entries,
      [],
    );
    const second = await ws.send("/btw recap scheduled", "side_answer");
    assertStringIncludes(outbound, "scheduled_unique_step");
    assert(!outbound.includes("delegated_step"));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      second.entry,
    ]);
    await ws.send("/btw classification changed", "side_error");
    await ws.send("/btw", "side_error");
    await ws.send("/btw --run scheduled missing-run recap", "side_error");
    assertEquals(providerCalls, 3);
    assertEquals(
      (await ws.send("/btw --run delegated committed-fixture", "side_history"))
        .entries,
      [first.entry],
    );
    assertEquals(await messages.loadActive(owner.id), []);
  } finally {
    await ws.close();
    journal.close();
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("exact receipt side questions reauthorize saved evidence for model, output, and history", () =>
  checkApprovedReceipt("delegated", {
    kind: "github_actions_status",
    repo: "acme/defense",
    repositoryId: 123,
    runs: [{ id: 45, status: "completed", conclusion: "success" }],
  }));
for (const role of ["delegated", "scheduled"] as const) {
  Deno.test(`Side questions reopen the exact ${role} Actions run and attempt without dispatch`, () =>
    checkApprovedReceipt(role, {
      kind: "github_actions_run_status",
      repo: "acme/defense",
      repositoryId: 123,
      id: 45,
      attempt: 2,
      status: "completed",
      conclusion: "success",
    }));
}

async function checkApprovedReceipt(
  role: ExecutionTraceRole,
  payload: ExecutionTraceApprovedPayload,
) {
  const base = await Deno.makeTempDir();
  const path = join(base, "execution-traces.db");
  const journal = openExecutionTraces(path);
  const scope = {
    role,
    runId: "approved-evidence",
    sessionId: crypto.randomUUID(),
  };
  const originalHooks: string[] = [];
  let allowed = true;
  let deniedHook: string | undefined;
  let providerCalls = 0;
  let handlerCalls = 0;
  const { chatSession } = fixture(
    (messages, tools) => {
      providerCalls++;
      assertEquals(tools, []);
      const prompt = JSON.parse(String(messages.at(-1)?.content));
      assertEquals(prompt.committedContext.evidence.payload, payload);
      if (prompt.question === "revoke during answer") allowed = false;
      return Promise.resolve(textResult("The saved workflow succeeded."));
    },
    undefined,
    {
      sideQuestionTracePath: path,
      tools: [{
        name: "github_actions",
        description: "Approved status",
        parameters: {},
      }],
      toolExecutor: () => {
        handlerCalls++;
        return Promise.resolve("Tool should never execute");
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: base,
        confirm: () => Promise.reject(new Error("Unexpected confirmation")),
        authorizeExecutionTracePayload: (saved, classification) => {
          assertEquals(saved, payload);
          assertEquals(classification, "INTERNAL");
          return Promise.resolve(allowed);
        },
      }),
      hookRunner: {
        evaluateHook(hook, { input }) {
          if (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE") {
            originalHooks.push(hook);
            assertEquals(input.tool_name, "github_actions");
            if (hook === "PRE_TOOL_CALL") {
              assertEquals(input.tool_call, executionTracePayloadCall(payload));
            }
          }
          const allow = hook !== deniedHook;
          return Promise.resolve({
            allowed: allow,
            action: allow ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    },
  );
  const ws = await connect(chatSession);
  try {
    assert(journal.admit(scope));
    const step = journal.appendNext(scope, {
      tool: "github_actions",
      classification: "INTERNAL",
      outcome: "returned",
    }, payload);
    assert(step);
    const runCommand = `/btw --run ${role} approved-evidence`;
    const command = `${runCommand} --receipt 1`;
    for (const hook of ["PRE_TOOL_CALL", "POST_TOOL_RESPONSE"]) {
      deniedHook = hook;
      await ws.send(`${command} blocked before model`, "side_error");
    }
    deniedHook = undefined;
    allowed = false;
    await ws.send(`${command} source approval revoked`, "side_error");
    assertEquals(providerCalls, 0);
    allowed = true;
    const latest = `${runCommand} --latest-receipt`;
    const answer = await ws.send(`${latest} recap`, "side_answer");
    assert(originalHooks.includes("PRE_TOOL_CALL"));
    assert(originalHooks.includes("POST_TOOL_RESPONSE"));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      answer.entry,
    ]);
    assertEquals(
      (await ws.send(runCommand, "side_history")).entries,
      [],
    );
    deniedHook = "PRE_OUTPUT";
    await ws.send(`${command} blocked output`, "side_error");
    deniedHook = undefined;
    await ws.send(`${command} revoke during answer`, "side_error");
    await ws.send("/btw", "side_error");
    allowed = true;
    assertEquals((await ws.send(command, "side_history")).entries, [
      answer.entry,
    ]);
    assertEquals(providerCalls, 3);
    assertEquals(handlerCalls, 0);
    assertEquals(journal.recent(role, scope.runId, "INTERNAL")?.steps, [step]);
    assert(journal.appendNext(scope, {
      tool: "fixture_metadata_only",
      classification: "INTERNAL",
      outcome: "returned",
    }));
    assertEquals((await ws.send(latest, "side_history")).entries, [
      answer.entry,
    ]);
    assert(journal.appendNext(scope, {
      tool: "github_actions",
      classification: "INTERNAL",
      outcome: "returned",
    }, payload));
    assertEquals((await ws.send("/btw", "side_history")).entries, [
      answer.entry,
    ]);
    assertEquals((await ws.send(latest, "side_history")).entries, []);
    assertEquals((await ws.send(command, "side_history")).entries, [
      answer.entry,
    ]);
  } finally {
    await ws.close();
    journal.close();
    await Deno.remove(base, { recursive: true });
  }
}

Deno.test("latest approved receipts are available from real trigger and signed webhook executions", async () => {
  const base = await Deno.makeTempDir();
  const tracePath = join(base, "execution-traces.db");
  const triggerMdPath = join(base, "TRIGGER.md");
  const repo = "acme/defense";
  const repositoryId = 123;
  const ceiling = "INTERNAL";
  const secret = "signed-scheduler-fixture";
  const webhookBody =
    '{"event":"fixture","secret":"private webhook body marker"}';
  const tool = {
    name: "github_actions",
    description: "Approved status",
    parameters: {},
  };
  const readCounts = new Map<string, number>();
  const observedReceipts: string[] = [];
  const confirmedRuns = new Map<string, number>();
  let allowSource = true;
  const scheduler = createSchedulerService({
    triggerMdPath,
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: ceiling,
    },
    triggerAdmissions: openSchedulerTriggerAdmissions(
      join(base, "scheduler-trigger-admissions.db"),
    ),
    webhooks: {
      enabled: true,
      sources: { fixture: { secret, classification: ceiling } },
    },
    webhookAdmissions: openSchedulerWebhookAdmissions(
      join(base, "scheduler-webhook-admissions.db"),
    ),
    executionTracePath: tracePath,
    recoverTurn(execution, orchestrator, options) {
      confirmedRuns.set(execution.id, execution.kind === "trigger" ? 101 : 202);
      return runRecoverableAgentTurn(
        join(base, "agent-recovery.db"),
        execution.id,
        createWorkflowRecoveryPolicy({
          repositories: [repo],
          runStatus: true,
          classification: () => ceiling,
          authorizeRepository: () => Promise.resolve(true),
        }),
        orchestrator,
        options,
      );
    },
    orchestratorFactory: {
      create(channel, options) {
        assert(options?.recoverySessionId);
        const session = restoreSession({
          id: options.recoverySessionId,
          userId: "fixture" as UserId,
          channelId: channel as ChannelId,
        });
        const registry = createProviderRegistry();
        registry.register({
          name: "scheduled-side-fixture",
          supportsStreaming: false,
          complete(messages) {
            const expectedRun = confirmedRuns.get(channel);
            assert(expectedRun);
            if (messages.at(-1)?.role === "tool") {
              return Promise.resolve(textResult("Defensive check finished."));
            }
            return Promise.resolve({
              ...textResult(""),
              toolCalls: [{
                type: "function",
                id: crypto.randomUUID(),
                function: {
                  name: tool.name,
                  arguments: JSON.stringify({
                    action: "get_run",
                    repo,
                    run_id: expectedRun,
                    attempt: 2,
                  }),
                },
              }],
            });
          },
        });
        registry.setDefault("scheduled-side-fixture");
        const toolExecutor = (name: string, args: Record<string, unknown>) => {
          if (name === "memory_get") return Promise.resolve('{"found":false}');
          if (name === "memory_save") return Promise.resolve("Saved.");
          assertEquals(name, tool.name);
          readCounts.set(channel, (readCounts.get(channel) ?? 0) + 1);
          return Promise.resolve(JSON.stringify({
            id: args.run_id,
            repositoryId,
            attempt: args.attempt,
            status: "completed",
            conclusion: "success",
            private: "unapproved connector response marker",
          }));
        };
        return Promise.resolve({
          session,
          toolExecutor,
          getSessionTaint: () => ceiling,
          orchestrator: createOrchestrator({
            providerRegistry: registry,
            hookRunner: createHookRunner(createPolicyEngine()),
            getSessionTaint: () => ceiling,
            tools: [tool],
            toolExecutor,
            enableStreaming: false,
          }),
        });
      },
    },
  });
  const { chatSession } = fixture(
    (messages, tools) => {
      assertEquals(tools, []);
      const text = String(messages.at(-1)?.content);
      const { committedContext } = JSON.parse(text);
      assert(!text.includes("private webhook body marker"));
      assert(!text.includes("unapproved connector response marker"));
      const { run, evidence } = committedContext;
      assertEquals(evidence.payload.kind, "github_actions_run_status");
      assertEquals(evidence.payload.id, confirmedRuns.get(run.scope.runId));
      assertEquals(evidence.payload.attempt, 2);
      observedReceipts.push(evidence.step.id);
      return Promise.resolve(
        textResult("The approved scheduled check passed."),
      );
    },
    undefined,
    {
      sideQuestionTracePath: tracePath,
      tools: [tool],
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: base,
        confirm: () =>
          Promise.reject(new Error("Unexpected side confirmation")),
        authorizeExecutionTracePayload(payload, classification) {
          assertEquals(payload.kind, "github_actions_run_status");
          assertEquals(payload.repositoryId, repositoryId);
          assertEquals(classification, ceiling);
          return Promise.resolve(allowSource);
        },
      }),
    },
  );
  const ws = await connect(chatSession, scheduler);
  try {
    await Deno.writeTextFile(
      triggerMdPath,
      "Check the scheduled defensive fixture.",
    );
    await scheduler.runTrigger();
    const timestamp = String(Date.now());
    const post = (signature: string) =>
      fetch(`http://127.0.0.1:${ws.port}/webhooks/fixture`, {
        method: "POST",
        body: webhookBody,
        headers: { "x-timestamp": timestamp, "x-signature": signature },
      });
    const invalid = await post(
      await computeTimestampedHmac(timestamp, webhookBody, "wrong-key"),
    );
    assertEquals(invalid.status, 401);
    await invalid.body?.cancel();
    const accepted = await post(
      await computeTimestampedHmac(timestamp, webhookBody, secret),
    );
    assertEquals(accepted.status, 200);
    const { executionId } = await accepted.json();
    const journal = openExecutionTraces(tracePath);
    try {
      const runs = journal.listRuns({ role: "scheduled", ceiling })?.runs ?? [];
      assertEquals(runs.length, 2);
      const trigger = runs.find(({ scope }) => scope.sourceId === "trigger");
      const webhook = runs.find(({ scope }) => scope.sourceId === "fixture");
      assert(trigger && webhook);
      assertEquals(webhook.scope.runId, executionId);
      assert(/^scheduler-trigger-[a-f0-9]{64}$/.test(trigger.scope.runId));
      assert(/^scheduler-webhook-[a-f0-9]{64}$/.test(webhook.scope.runId));
      for (const run of [trigger, webhook]) {
        assertEquals(run.status, "completed");
        assertEquals(
          journal.latestApprovedStep(run.scope, ceiling)?.classification,
          ceiling,
        );
        const latest =
          `/btw --run scheduled ${run.scope.runId} --latest-receipt`;
        allowSource = false;
        await ws.send(`${latest} summarize`, "side_error");
        allowSource = true;
        const answer = await ws.send(`${latest} summarize`, "side_answer");
        const saved = journal.latestApprovedStep(run.scope, ceiling);
        assert(saved);
        assertEquals(observedReceipts.at(-1), saved.id);
        assertEquals(
          (await ws.send(
            `/btw --run scheduled ${run.scope.runId} --receipt ${saved.ordinal}`,
            "side_history",
          )).entries,
          [answer.entry],
        );
        assertEquals(readCounts.get(run.scope.runId), 1);
      }
      assertEquals(new Set(observedReceipts).size, 2);
    } finally {
      journal.close();
    }
  } finally {
    await ws.close();
    scheduler.stop();
    await Deno.remove(base, { recursive: true });
  }
});
