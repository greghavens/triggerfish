import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import type { ModelCallScope } from "../../src/core/model_monitor.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  bindModelCallScope,
  monitorProviderRegistry,
} from "../../src/agent/providers/monitoring.ts";
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
  let scopeOnApproval: ModelCallScope | undefined;
  let supersedeCaseOnApproval: (() => void) | undefined;
  let recordDiagnostic: (scope?: ModelCallScope) => Promise<unknown> = () => {
    throw new Error("The diagnostic fixture provider is unavailable.");
  };
  const diagnosticsProfile = {
    modelProfile: "scoped-fixture",
    modelRouteModel: "scoped-v1",
  };

  const inputClassification = "INTERNAL";
  const providerSecret = "fixture-only-provider-error-credential";
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
          Object.assign(new Error(providerSecret), {
            status: 401,
            body: providerSecret,
            endpoint: providerSecret,
          }),
        );
      },
    });
    registry.register({
      name: diagnosticsProfile.modelProfile,
      model: diagnosticsProfile.modelRouteModel,
      supportsStreaming: false,
      complete(_messages, _tools, options) {
        assertEquals(Object.getOwnPropertySymbols(options), []);
        return Promise.resolve({
          content: "fixture diagnostic only",
          toolCalls: [],
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      },
    });
    recordDiagnostic = (scope?) =>
      (scope ? bindModelCallScope(registry, scope) : registry)
        .get(diagnosticsProfile.modelProfile)!.complete([], [], {
          modelUsageClassification: "INTERNAL",
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
                | undefined)?.args?.action?.match(
                  /^(set_model_retry_policy|delete_model_call_scope)$/,
                )
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
          confirm: async () => {
            reviews++;
            if (revokeOnReview) holds = true;
            const supersede = supersedeCaseOnApproval;
            supersedeCaseOnApproval = undefined;
            supersede?.();
            if (scopeOnApproval) {
              const captured = scopeOnApproval;
              scopeOnApproval = undefined;
              await recordDiagnostic(captured);
            }
            return true;
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
    const failedRecords = JSON.parse(
      await turn({
        action: "model_call_records",
        ...failing,
      }),
    );
    assertEquals(failedRecords.records.length, 1);
    const failed = failedRecords.records[0];
    assertEquals(failed.outcome, "failed");
    assertEquals(failed.failureReason, "hard");
    assertEquals(failed.httpStatus, 401);
    assertEquals(Object.keys(failed).sort(), [
      "classification",
      "elapsed",
      "failureReason",
      "httpStatus",
      "id",
      "inputTokens",
      "model",
      "outcome",
      "outputTokens",
      "provider",
      "recordedAt",
    ]);
    const readFailure = {
      action: "model_call_record",
      ...failing,
      modelRecordId: failed.id,
    };
    assertEquals(JSON.parse(await turn(readFailure)).record, failed);
    assert(!JSON.stringify(failedRecords).includes(providerSecret));
    assert(
      !new TextDecoder().decode(
        await Deno.readFile(join(baseDir, "model-monitor.db")),
      ).includes(providerSecret),
    );
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
    assertStringIncludes(await turn(readFailure), "unavailable");
    assertStringIncludes(
      await turn({ ...failing, action: "model_call_records" }),
      "unavailable",
    );
    socket?.close();
    await gateway.stop();
    gateway = makeGateway("RESTRICTED");
    await connect();
    assertEquals(JSON.parse(await turn(health)).health, cooling);
    assertEquals(JSON.parse(await turn(readFailure)).record, failed);
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
    const casePath = resolveSentinelCasePath(baseDir, "main");
    await Deno.mkdir(dirname(casePath), { recursive: true });
    await Deno.writeTextFile(
      casePath,
      JSON.stringify({
        version: 1,
        nodes: [
          { kind: "asset", id: "target", label: "Target" },
          { kind: "asset", id: "neighbor", label: "Neighbor" },
        ],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(casePath);
    advanceAdaptiveSentinel(casePath, state);
    const revision = readAdaptiveSentinel(casePath, state)!.revision;
    const caseStore = openSentinelAdaptiveStore(
      join(dirname(casePath), "sentinel-adaptive.db"),
    );
    let tasks;
    try {
      tasks = caseStore.sync(
        revision,
        ["target", "neighbor"].map((nodeId) => ({
          kind: "trace",
          nodeId,
          depth: 1,
        })),
        revision,
      );
    } finally {
      caseStore.close();
    }
    const assignmentId = tasks.find(({ nodeId }) => nodeId === "target")?.id;
    const otherAssignmentId = tasks.find(({ nodeId }) => nodeId === "neighbor")
      ?.id;
    assert(state.plan.runId && assignmentId && otherAssignmentId);
    const scope = {
      caseId: "main",
      runId: state.plan.runId,
      revision: state.revision,
      assignmentId,
    };
    await recordDiagnostic(scope);
    await recordDiagnostic({ ...scope, assignmentId: otherAssignmentId });
    await recordDiagnostic({ ...scope, assignmentId: undefined });
    await recordDiagnostic();
    const scopeRequest = {
      action: "model_call_scope",
      kind: "sentinel",
      id: scope.caseId,
      runId: scope.runId,
      revision: scope.revision,
      taskId: assignmentId,
    };
    const preview = JSON.parse(await turn(scopeRequest));
    assertEquals(preview.count, 1);
    const deleteScope = {
      ...scopeRequest,
      action: "delete_model_call_scope",
      requestId: crypto.randomUUID(),
      modelScopeDigest: preview.digest,
    };
    const firstReviews = reviews;
    const wrong = { ...deleteScope, runId: crypto.randomUUID() };
    assertStringIncludes(await turn(wrong), "unavailable");
    assertEquals(reviews, firstReviews);
    holds = true;
    assertStringIncludes(await turn(deleteScope), "blocked");
    assertEquals(reviews, firstReviews);
    holds = false;
    revokeOnReview = true;
    assertStringIncludes(await turn(deleteScope), "unavailable");
    assertEquals(reviews, firstReviews + 1);
    assertEquals(JSON.parse(await turn(scopeRequest)).count, 1);
    holds = false;
    revokeOnReview = false;
    scopeOnApproval = scope;
    assertStringIncludes(await turn(deleteScope), "unavailable");
    const refreshed = JSON.parse(await turn(scopeRequest));
    assertEquals(refreshed.count, 2);
    const beforeTotals = JSON.parse(
      await turn({ action: "model_usage", ...diagnosticsProfile }),
    );
    const mutationScope = {
      ...deleteScope,
      requestId: crypto.randomUUID(),
      modelScopeDigest: refreshed.digest,
    };
    const removal = JSON.parse(await turn(mutationScope));
    assertEquals(removal.deleted, 2);
    assertEquals(JSON.parse(await turn(scopeRequest)).count, 0);
    assertEquals(
      JSON.parse(await turn({ ...scopeRequest, taskId: otherAssignmentId }))
        .count,
      1,
    );
    const { taskId: _task, ...runOnly } = scopeRequest;
    assertEquals(JSON.parse(await turn(runOnly)).count, 1);
    assertEquals(
      JSON.parse(await turn({ action: "model_usage", ...diagnosticsProfile })),
      beforeTotals,
    );
    const retained = JSON.parse(
      await turn({ action: "model_call_records", ...diagnosticsProfile }),
    );
    assertEquals(retained.records.length, 3);
    socket?.close();
    await gateway.stop();
    gateway = makeGateway("RESTRICTED");
    await connect();
    await recordDiagnostic(scope);
    const reviewsBeforeReplay = reviews;
    assertEquals(JSON.parse(await turn(mutationScope)), removal);
    assertEquals(reviews, reviewsBeforeReplay);
    assertEquals(JSON.parse(await turn(scopeRequest)).count, 1);
    assertStringIncludes(
      await turn({ ...mutationScope, taskId: otherAssignmentId }),
      "unavailable",
    );
    const historical = JSON.parse(await turn(scopeRequest));
    const deleteAfterRestart = {
      ...mutationScope,
      requestId: crypto.randomUUID(),
      modelScopeDigest: historical.digest,
    };
    supersedeCaseOnApproval = () => {
      const replacement = startSentinelAssessment(casePath);
      assert(replacement.revision > scope.revision);
      assert(replacement.plan.runId !== scope.runId);
    };
    assertStringIncludes(await turn(deleteAfterRestart), "unavailable");
    assertEquals(reviews, reviewsBeforeReplay + 1);
    assertEquals(JSON.parse(await turn(scopeRequest)), historical);
    assertEquals(JSON.parse(await turn(deleteAfterRestart)).deleted, 1);
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
