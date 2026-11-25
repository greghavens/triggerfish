import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";
import {
  computeTimestampedHmac,
  createSchedulerService,
} from "../../src/scheduler/mod.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const note = "Review the verified configuration before any other action.";

async function waitForStep(step: Promise<void>, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      step,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function session(channelId: string) {
  return updateTaint(
    createSession({
      userId: "fixture" as UserId,
      channelId: channelId as ChannelId,
    }),
    "INTERNAL",
    "Fixture scope",
  );
}

Deno.test("Owner gateway steers and cancels a live scheduled model at real tool boundaries", async () => {
  const baseDir = await Deno.makeTempDir();
  const entered = Promise.withResolvers<void>();
  const initial = Promise.withResolvers<void>();
  const afterRead = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const effects: string[] = [];
  let scheduledSteps = 0;
  let confirmations = 0;
  let deny = false;
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const allowed = !(deny && hook === "PRE_TOOL_CALL" &&
        input.tool_name === "operator_runs");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const scheduler = createSchedulerService({
    executionTracePath: join(baseDir, "execution-traces.db"),
    triggerMdPath: "/unused",
    trigger: {
      enabled: false,
      intervalMinutes: 30,
      classificationCeiling: "INTERNAL",
    },
    webhooks: {
      enabled: true,
      sources: {
        control: {
          secret: "fixture-shared-webhook-key",
          classification: "INTERNAL",
        },
      },
    },
    orchestratorFactory: {
      create(channelId) {
        const worker = session(channelId);
        const providers = createProviderRegistry();
        providers.register({
          name: "live-scheduled-control",
          supportsStreaming: false,
          async complete(messages) {
            const step = ++scheduledSteps;
            if (step === 1) {
              entered.resolve();
              await initial.promise;
            } else if (step === 2) {
              assertStringIncludes(JSON.stringify(messages), note);
            } else {
              assertStringIncludes(
                JSON.stringify(messages),
                "Verified configuration is current.",
              );
              afterRead.resolve();
              await finish.promise;
            }
            return {
              usage,
              content: "",
              toolCalls: [{
                id: "step-" + step,
                type: "function",
                function: {
                  name: "check_controls",
                  arguments: JSON.stringify({ step }),
                },
              }],
            };
          },
        });
        providers.setDefault("live-scheduled-control");
        const toolExecutor = (
          _name: string,
          { step }: Record<string, unknown>,
        ) => {
          effects.push(String(step));
          return Promise.resolve("Verified configuration is current.");
        };
        return Promise.resolve({
          session: worker,
          getSessionTaint: () => worker.taint,
          toolExecutor,
          orchestrator: createOrchestrator({
            tools: [{
              name: "check_controls",
              description: "Inspect fixture controls",
              parameters: {},
            }],
            providerRegistry: providers,
            hookRunner: hooks,
            toolExecutor,
          }),
        });
      },
    },
  });
  const operator = createProviderRegistry();
  operator.register({
    name: "live-control-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") {
        return Promise.resolve({
          content: "Fixture result: " + last.content,
          usage,
          toolCalls: [],
        });
      }
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name: "operator_runs", arguments: String(last?.content) },
        }],
      });
    },
  });
  operator.setDefault("live-control-owner");
  const owner = session("owner");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    schedulerService: scheduler,
    chatSession: createChatSession({
      session: owner,
      providerRegistry: operator,
      targetClassification: "INTERNAL",
      hookRunner: hooks,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => {
          confirmations++;
          return Promise.resolve(true);
        },
      }),
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  let delivery: Promise<Response> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const body = '{"event":"defensive.review"}';
    const timestamp = String(Date.now());
    const signature = await computeTimestampedHmac(
      timestamp,
      body,
      "fixture-shared-webhook-key",
    );
    const { id } = schedulerExecutionIdentity("webhook", "control", signature);
    const deliveryUrl = `http://127.0.0.1:${port}/webhooks/control`;
    const request = {
      method: "POST",
      body,
      headers: { "x-timestamp": timestamp, "x-signature": signature },
    };
    delivery = fetch(deliveryUrl, request);
    const turn = async (args: Record<string, unknown>) => {
      const complete = Promise.withResolvers<string>();
      const timer = setTimeout(
        () => complete.reject(new Error("Missing owner control response")),
        3500,
      );
      let text = "";
      const receive = ({ data }: MessageEvent) => {
        const frame = JSON.parse(data);
        if (frame.type === "response") text = frame.text;
        if (frame.type === "error") text = frame.message;
        if (frame.type === "turn_end") {
          complete.resolve(text.replace(/^Fixture result: /, ""));
        }
      };
      socket.addEventListener("message", receive);
      socket.send(
        JSON.stringify({ type: "message", content: JSON.stringify(args) }),
      );
      try {
        return await complete.promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };
    const ref = { id, kind: "scheduled" };
    const requestId = crypto.randomUUID();
    const steer = { action: "steer", ...ref, requestId, note };
    const controls = async () =>
      JSON.parse(
        await turn({ action: "execution_traces", traceRole: "scheduled", id }),
      ).controls;
    await waitForStep(entered.promise, "the scheduled model's first turn");
    deny = true;
    await turn(steer);
    assertEquals(confirmations, 0);
    assertEquals(effects, []);
    deny = false;
    const accepted = JSON.parse(await turn(steer)).receipt;
    assertEquals(accepted.requestId, requestId);
    assertEquals(JSON.parse(await turn(steer)).receipt, accepted);
    assertEquals(confirmations, 1);

    initial.resolve();
    await waitForStep(afterRead.promise, "the steered model's next tool call");
    assertEquals(effects, ["2"]);
    const directed = await controls();
    assertEquals(directed.stopped, false);
    const applied = directed.steering.find((row: { requestId: string }) =>
      row.requestId === requestId
    );
    assert(applied?.appliedAt);
    assertEquals(applied.note, note);
    assertEquals(
      JSON.parse(await turn({ action: "cancel", ...ref })).run.status,
      "cancelled",
    );
    assertEquals(confirmations, 2);
    finish.resolve();
    await (await delivery).body?.cancel();
    assertEquals(effects, ["2"]);
    assertEquals((await controls()).stopped, true);
    assertEquals(
      JSON.parse(await turn({ action: "cancel", ...ref })).run.status,
      "cancelled",
    );
    assertEquals(confirmations, 2);
    const replay = await fetch(deliveryUrl, request);
    assertEquals(replay.status, 409);
    await replay.body?.cancel();
    assertEquals(scheduledSteps, 3);

    const savedControls = await controls();
    const archiveId = crypto.randomUUID();
    const archived = JSON.parse(
      await turn({ action: "archive", ...ref, requestId: archiveId }),
    );
    assertEquals(archived.receipt.status, "succeeded");
    await Deno.rename(
      join(baseDir, "execution-traces.db"),
      join(baseDir, "original-execution-traces.db"),
    );
    const restore = {
      action: "restore",
      ...ref,
      archiveId,
      requestId: crypto.randomUUID(),
    };
    const restored = JSON.parse(await turn(restore));
    assertEquals(restored.receipt.status, "succeeded");
    assertEquals(JSON.parse(await turn(restore)), restored);
    assertEquals(await controls(), savedControls);
    assertEquals(effects, ["2"]);
  } finally {
    initial.resolve();
    finish.resolve();
    await (await delivery?.catch(() => undefined))?.body?.cancel().catch(
      () => {},
    );
    socket.close();
    await closed.promise;
    scheduler.stop();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
