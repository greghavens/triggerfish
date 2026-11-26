import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { monitorProviderRegistry } from "../../src/agent/providers/monitoring.ts";
import { withRetry } from "../../src/agent/providers/retry.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";
import {
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("gateway reviews model retry edits and keeps monitoring metadata classified across restart", async () => {
  const baseDir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".model-monitor-",
  });
  const token = crypto.randomUUID();
  const profile = { modelProfile: "fixture", modelRouteModel: "fixture-v1" };
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  let reviews = 0;
  let holds = false;
  let revokeOnReview = false;
  let classified = 0;
  let holdOutput = false;
  let blockedOutput = 0;
  let denyRollup = false;
  let exerciseFailure = () => Promise.resolve();
  const inputClassification = "INTERNAL";
  let attempts = 0;
  let failingAttempts = 0;
  let socket: WebSocket | undefined;
  const policy = createHookRunner(createPolicyEngine());
  function makeGateway(targetClassification: "INTERNAL" | "RESTRICTED") {
    const { registry, retryPolicy } = monitorProviderRegistry(
      createProviderRegistry(),
      baseDir,
    );
    registry.register(withRetry({
      name: profile.modelProfile,
      model: profile.modelRouteModel,
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        const value = String(last?.content);
        if (last?.role === "user" && value === "fixture transient") {
          if (++attempts % 2 === 1) {
            return Promise.reject(new Error("Fixture (503): synthetic-only"));
          }
        }
        return Promise.resolve({
          content: last?.role === "tool" ? value : "fixture model answered",
          toolCalls: last?.role === "user" && value.startsWith("{")
            ? [{
              type: "function",
              id: "monitor",
              function: { name: "operator_runs", arguments: value },
            }]
            : [],
          usage: { inputTokens: 4, outputTokens: 3 },
        });
      },
    }, retryPolicy));
    registry.setDefault(profile.modelProfile);
    registry.register({
      name: "failing",
      model: "fault-test",
      supportsStreaming: false,
      complete() {
        failingAttempts++;
        return Promise.reject(
          Object.assign(new Error("synthetic-only"), { status: 401 }),
        );
      },
    });
    exerciseFailure = () =>
      assertRejects(() =>
        registry.get("failing")!.complete([], [], {
          modelUsageClassification: "RESTRICTED",
        })
      ).then(() => {});
    return createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        targetClassification,
        getSessionTaint: () => inputClassification,
        providerRegistry: registry,
        hookRunner: {
          ...policy,
          evaluateHook(hook, context) {
            if (
              hook === "PRE_TOOL_CALL" && denyRollup &&
              (context.input.tool_call as { args?: { action?: string } })
                  ?.args?.action === "tool_usage_totals"
            ) {
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            if (
              hook === "PRE_TOOL_CALL" && holds &&
              (context.input.tool_call as
                  | { args?: { action?: string } }
                  | undefined)?.args?.action === "set_model_retry_policy"
            ) {
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            if (
              hook === "POST_TOOL_RESPONSE" &&
              context.input.tool_name === "operator_runs"
            ) classified++;
            if (
              hook === "PRE_OUTPUT" && holdOutput &&
              typeof context.input.content === "string" &&
              (context.input.content.includes('"retryPolicy"') ||
                context.input.content.includes('"totals"'))
            ) {
              blockedOutput++;
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            return policy.evaluateHook(hook, context);
          },
        },
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir,
          confirm: () => {
            reviews++;
            if (revokeOnReview) holds = true;
            return Promise.resolve(true);
          },
        }),
      }),
    });
  }
  let gateway = makeGateway("RESTRICTED");
  async function connect() {
    const { port } = await gateway.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
  }
  async function turn(input: string | Record<string, unknown>) {
    assert(socket);
    const ws = socket;
    const done = Promise.withResolvers<string>();
    let result = "";
    let response = "";
    const listen = ({ data }: MessageEvent) => {
      const event = JSON.parse(data);
      if (event.type === "tool_result") result = String(event.result);
      if (event.type === "response") response += String(event.text);
      if (event.type === "error") result ||= String(event.message);
      if (event.type === "turn_end" || event.type === "error") {
        done.resolve(result || response);
      }
    };
    const timer = setTimeout(
      () => done.reject(new Error("No gateway response")),
      4000,
    );
    ws.addEventListener("message", listen);
    try {
      ws.send(JSON.stringify({
        type: "message",
        content: typeof input === "string" ? input : JSON.stringify(input),
      }));
      return await done.promise;
    } finally {
      clearTimeout(timer);
      ws.removeEventListener("message", listen);
    }
  }
  try {
    await connect();
    const mutation = {
      action: "set_model_retry_policy",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      modelRetryCount: 1,
      modelRetryDelayMs: 0,
    };
    revokeOnReview = true;
    assertStringIncludes(await turn(mutation), "unavailable");
    assertEquals(reviews, 1);
    holds = false;
    revokeOnReview = false;
    const edit = JSON.parse(await turn(mutation));
    assertEquals(edit._classification, "INTERNAL");
    assertEquals(edit.retryPolicy.version, 1);
    assertEquals(JSON.parse(await turn(mutation)), edit);
    assertEquals(reviews, 2);
    await turn("fixture transient");
    assertEquals(attempts, 2);
    holdOutput = true;
    assert(
      !(await turn({ action: "model_retry_policy" })).includes('"retryPolicy"'),
    );
    assert(blockedOutput > 0);
    holdOutput = false;
    await exerciseFailure();
    const failing = {
      modelProfile: "failing",
      modelRouteModel: "fault-test",
      modelRouteClassification: "RESTRICTED",
    };
    const health = { action: "model_health", ...failing };
    const cooling = JSON.parse(await turn(health)).health;
    assertEquals(cooling.failures, 1);
    assert(cooling.openUntil > Date.now());
    await exerciseFailure();
    assertEquals(failingAttempts, 1);
    const { days } = JSON.parse(
      await turn({ action: "model_usage", ...profile }),
    );
    assert(days[0].inputTokens >= 4);
    const usageRollup = { action: "model_usage_totals" };
    const globalUsage = JSON.parse(await turn(usageRollup));
    const model = globalUsage.profiles.find(
      (entry: { provider: string }) => entry.provider === profile.modelProfile,
    );
    assert(model.inputTokens >= days[0].inputTokens);
    assert(
      !globalUsage.profiles.some((entry: { provider: string }) =>
        entry.provider === failing.modelProfile
      ),
    );
    const restrictedUsage = JSON.parse(
      await turn({
        ...usageRollup,
        modelRouteClassification: "RESTRICTED",
      }),
    );
    assertEquals(restrictedUsage.profiles[0].failures, 1);
    assertEquals(restrictedUsage.daily[0].calls, 1);

    const fixtureTraces = openExecutionTraces(
      join(baseDir, "execution-traces.db"),
    );
    try {
      const scoped = crypto.randomUUID();
      const ownerScope: ExecutionTraceScope = {
        role: "owner_chat",
        sessionId: session.id,
        sourceId: scoped,
        runId: assignmentRecoveryKey(session.id, scoped),
      };
      const add = (
        scope: ExecutionTraceScope,
        tool: string,
        classification: "INTERNAL" | "RESTRICTED",
        outcome: "returned" | "failed" | "blocked" = "returned",
      ) => {
        assert(fixtureTraces.admit(scope));
        assert(
          fixtureTraces.appendNext(scope, { tool, outcome, classification }),
        );
      };
      add(ownerScope, "fixture_controls", "INTERNAL");
      add(ownerScope, "fixture_controls", "INTERNAL", "blocked");
      add(
        {
          role: "delegated",
          runId: "authorized-delegated",
          sessionId: "worker-session",
          sourceId: session.id,
        },
        "fixture_controls",
        "INTERNAL",
        "failed",
      );
      add(
        {
          role: "delegated",
          runId: "other-delegated",
          sessionId: "other-session",
          sourceId: crypto.randomUUID(),
        },
        "foreign_tool",
        "INTERNAL",
      );
      add(
        {
          role: "delegated",
          runId: "unbound-delegated",
          sessionId: "other-session",
        },
        "unbound_tool",
        "INTERNAL",
      );
      add(
        {
          role: "scheduled",
          runId: "scheduled-test",
          sessionId: "scheduled-session",
        },
        "fixture_controls",
        "INTERNAL",
      );
      add(
        {
          role: "scheduled",
          runId: "restricted-run",
          sessionId: "restricted-session",
        },
        "restricted_tool",
        "RESTRICTED",
      );
    } finally {
      fixtureTraces.close();
    }
    const toolRollup = { action: "tool_usage_totals" };
    denyRollup = true;
    assertStringIncludes(await turn(toolRollup), "blocked");
    denyRollup = false;
    holdOutput = true;
    assert(!(await turn(toolRollup)).includes("fixture_controls"));
    holdOutput = false;
    const toolTotals = JSON.parse(await turn(toolRollup)).totals;
    assertEquals(toolTotals, [
      {
        tool: "fixture_controls",
        role: "delegated",
        calls: 1,
        failed: 1,
        blocked: 0,
      },
      {
        tool: "fixture_controls",
        role: "owner_chat",
        calls: 1,
        failed: 0,
        blocked: 1,
      },
      {
        tool: "fixture_controls",
        role: "scheduled",
        calls: 1,
        failed: 0,
        blocked: 0,
      },
    ]);
    const classifiedTools = JSON.parse(
      await turn({
        ...toolRollup,
        modelRouteClassification: "RESTRICTED",
      }),
    );
    assertEquals(
      classifiedTools.totals.map(({ tool }: { tool: string }) => tool),
      [
        "restricted_tool",
      ],
    );
    const { records } = JSON.parse(
      await turn({ action: "model_call_records", ...profile }),
    );
    assert(records.length > 0);
    assertEquals(Object.keys(records[0]).sort(), [
      "classification",
      "elapsed",
      "id",
      "inputTokens",
      "model",
      "outcome",
      "outputTokens",
      "provider",
      "recordedAt",
    ]);
    const modelRecordId = records[0].id;
    const read = { action: "model_call_record", ...profile, modelRecordId };
    assertEquals(JSON.parse(await turn(read)).record, records[0]);
    socket?.close();
    await gateway.stop();
    gateway = makeGateway("INTERNAL");
    await connect();
    assertEquals(JSON.parse(await turn(toolRollup)).totals, toolTotals);
    for (const args of [usageRollup, toolRollup]) {
      assertStringIncludes(
        await turn({ ...args, modelRouteClassification: "RESTRICTED" }),
        "unavailable",
      );
    }
    assertStringIncludes(
      await turn({ ...read, modelRouteClassification: "RESTRICTED" }),
      "unavailable",
    );
    assertEquals(JSON.parse(await turn(read)).record, records[0]);
    socket?.close();
    await gateway.stop();
    gateway = makeGateway("RESTRICTED");
    await connect();
    assertEquals(JSON.parse(await turn(health)).health, cooling);
    await exerciseFailure();
    assertEquals(failingAttempts, 1);
    assertEquals(
      JSON.parse(
        await turn({
          action: "reset_model_health",
          ...failing,
          expectedVersion: cooling.version,
        }),
      ).version,
      2,
    );
    assertEquals(JSON.parse(await turn(health)).health, {
      failures: 0,
      version: 2,
      openUntil: 0,
    });
    await exerciseFailure();
    assertEquals(failingAttempts, 2);
    assertEquals(
      JSON.parse(await turn({ action: "model_retry_policy" })),
      edit,
    );
    assertEquals(JSON.parse(await turn(read)).record, records[0]);
    assertEquals(
      JSON.parse(
        await turn({
          action: "delete_model_call_record",
          ...profile,
          modelRecordId,
        }),
      ).deleted,
      modelRecordId,
    );
    assertStringIncludes(await turn(read), "unavailable");
    assert(classified > 5);
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
