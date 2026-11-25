import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import {
  bindLiveExecution,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { teamDeliveryTraceSource } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import {
  type ChannelId,
  createSession,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";

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

Deno.test("Owner gateway steers and cancels a live delegated model at real tool boundaries", async () => {
  const baseDir = await Deno.makeTempDir();
  const entered = Promise.withResolvers<void>();
  const initial = Promise.withResolvers<void>();
  const afterRead = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const effects: string[] = [];
  let delegateSteps = 0;
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
  const spawn = buildSubagentFactory({
    create(channelId) {
      const worker = session(channelId);
      const providers = createProviderRegistry();
      providers.register({
        name: "live-delegated-control",
        supportsStreaming: false,
        async complete(messages) {
          const step = ++delegateSteps;
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
      providers.setDefault("live-delegated-control");
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
  }, { executionTracePath: join(baseDir, "execution-traces.db") });
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
  let running: Promise<string> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    running = spawn("Check the existing defensive configuration.");
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
    await waitForStep(entered.promise, "the delegated model's first turn");
    const listed = JSON.parse(
      await turn({ action: "list", kind: "delegated" }),
    );
    assertEquals(listed.runs.length, 1);
    const { ref } = listed.runs[0];
    assertEquals(ref.kind, "delegated");
    const { id } = ref;
    const requestId = crypto.randomUUID();
    const steer = { action: "steer", ...ref, requestId, note };
    const controls = async () =>
      JSON.parse(
        await turn({ action: "execution_traces", traceRole: "delegated", id }),
      ).controls;
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
    deny = true;
    await turn({ action: "cancel", ...ref });
    deny = false;
    assertEquals((await controls()).stopped, false);
    assertEquals(confirmations, 1);
    assertEquals(
      JSON.parse(await turn({ action: "cancel", ...ref })).run.status,
      "cancelled",
    );
    assertEquals(confirmations, 2);
    finish.resolve();
    assertEquals(await running, "Sub-agent error: Run cancelled by operator.");
    assertEquals(effects, ["2"]);
    assertEquals((await controls()).stopped, true);
    assertEquals(
      JSON.parse(await turn({ action: "cancel", ...ref })).run.status,
      "cancelled",
    );
    assertEquals(confirmations, 2);
    assertEquals(delegateSteps, 3);

    const teamRun = {
      role: "delegated" as const,
      runId: "unrelated-team-delivery",
      sessionId: session("team-worker").id,
      sourceId: teamDeliveryTraceSource(
        session("different-owner").id,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ),
    };
    const path = join(baseDir, "execution-traces.db");
    const trace = openExecutionTraces(path);
    const handle = bindLiveExecution(path, teamRun, undefined, "INTERNAL");
    try {
      assert(trace.admit(teamRun));
      const teamRequest = crypto.randomUUID();
      assert(
        trace.steerRun(
          "delegated",
          teamRun.runId,
          "INTERNAL",
          teamRequest,
          note,
          true,
        ),
      );
      assertStringIncludes(
        await turn({
          action: "steer",
          kind: "delegated",
          id: teamRun.runId,
          requestId: teamRequest,
          note,
        }),
        "unavailable",
      );
      assertStringIncludes(
        await turn({ action: "cancel", kind: "delegated", id: teamRun.runId }),
        "unavailable",
      );
      assertEquals(confirmations, 2);
      assert(!handle.signal.aborted);
    } finally {
      handle.release();
      trace.close();
    }
  } finally {
    initial.resolve();
    finish.resolve();
    await running?.catch(() => undefined);
    socket.close();
    await closed.promise;
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
