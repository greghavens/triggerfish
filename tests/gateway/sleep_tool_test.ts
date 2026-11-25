import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { filterToolsForRole } from "../../src/gateway/tools/defs/role_filter.ts";
import { resolveToolsForProfile } from "../../src/gateway/tools/agent_tools.ts";
import {
  computeTimestampedHmac,
  createSchedulerService,
} from "../../src/scheduler/mod.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";

import { join } from "@std/path";
import { runRecoverableAgentTurn } from "../../src/core/agent_recovery.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { assignmentRecoveryKey } from "../../src/core/durable_assignment.ts";

const complete = "The requested wait ended.";
const modelSteps = { inputTokens: 1, outputTokens: 1 };

function waitFixture() {
  const hooks: string[] = [];
  const delivered: string[] = [];
  let denial: "pre" | "post" | "output" | undefined;
  let seconds = 1;
  let stopAfterTool = false;
  let entered = Promise.withResolvers<void>();
  const hookRunner: HookRunner = {
    evaluateHook(hook, { input }) {
      if (input.tool_name === "sleep") {
        hooks.push(hook);
        if (hook === "PRE_TOOL_CALL") entered.resolve();
      }
      const output = hook === "PRE_OUTPUT" && input.content === complete;
      if (output) hooks.push(hook);
      const denied = output && denial === "output" ||
        input.tool_name === "sleep" &&
          (hook === "PRE_TOOL_CALL" && denial === "pre" ||
            hook === "POST_TOOL_RESPONSE" && denial === "post");
      return Promise.resolve({
        allowed: !denied,
        action: denied ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  function providers() {
    const registry = createProviderRegistry();
    registry.register({
      name: "sleep-fixture",
      supportsStreaming: false,
      complete(messages, tools) {
        assert(
          tools?.some((definition) =>
            (definition as { function?: { name: string } }).function?.name ===
              "sleep"
          ),
        );
        const result = messages.findLast(({ role }) => role === "tool")
          ?.content;
        if (result) {
          delivered.push(String(result));
          if (stopAfterTool) {
            throw new Error("Worker stopped after the committed wait.");
          }
        }
        return Promise.resolve({
          usage: modelSteps,
          content: result ? complete : "",
          toolCalls: result ? [] : [{
            id: "wait-tool",
            type: "function",
            function: { name: "sleep", arguments: JSON.stringify({ seconds }) },
          }],
        });
      },
    });
    registry.setDefault("sleep-fixture");
    return registry;
  }
  return {
    hooks,
    delivered,
    hookRunner,
    providers,
    reset(next: typeof denial, duration = 1, interrupt = false) {
      hooks.length = 0;
      delivered.length = 0;
      denial = next;
      seconds = duration;
      stopAfterTool = interrupt;
      entered = Promise.withResolvers<void>();
      return entered.promise;
    },
  };
}

async function gatewayTurn(
  config: Parameters<typeof createChatSession>[0],
  message: string,
  during?: (socket: WebSocket) => Promise<void>,
) {
  const token = crypto.randomUUID();
  const server = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession(config),
  });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const frames: { type: string; text?: string; message?: string }[] = [];
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    frames.push(frame);
    if (frame.type === "turn_end") ended.resolve();
  });
  const timer = setTimeout(
    () => ended.reject(new Error("Gateway sleep turn timed out")),
    3500,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({ type: "message", content: message }));
    if (during) await Promise.race([during(socket), ended.promise]);
    await ended.promise;
    return frames;
  } finally {
    clearTimeout(timer);
    socket.close();
    await closed.promise;
    await server.stop();
  }
}

function ownerSession() {
  return createSession({
    userId: "owner" as UserId,
    channelId: "owner" as ChannelId,
  });
}

Deno.test("Owner sleep uses root call, response and output policy and cancels through the socket", async () => {
  const fixture = waitFixture();
  assert(
    !filterToolsForRole(resolveToolsForProfile("cli"), false).some(({ name }) =>
      name === "sleep"
    ),
  );
  const turn = (during?: (socket: WebSocket) => Promise<void>) =>
    gatewayTurn(
      {
        session: ownerSession(),
        tools: resolveToolsForProfile("cli").filter(({ name }) =>
          name === "sleep"
        ),
        providerRegistry: fixture.providers(),
        hookRunner: fixture.hookRunner,
        enableStreaming: false,
        toolExecutor: () =>
          Promise.reject(new Error("Unexpected callback outside root sleep")),
      },
      "Wait for the requested interval.",
      during,
    );

  fixture.reset("pre", 3600);
  await turn();
  assertEquals(fixture.hooks, ["PRE_TOOL_CALL", "PRE_OUTPUT"]);
  assertStringIncludes(fixture.delivered[0], "blocked");

  fixture.reset("post");
  await turn();
  assertEquals(fixture.hooks, [
    "PRE_TOOL_CALL",
    "POST_TOOL_RESPONSE",
    "PRE_OUTPUT",
  ]);
  assertStringIncludes(fixture.delivered[0], "withheld");

  fixture.reset("output");
  const blocked = await turn();
  assertEquals(fixture.delivered, ["Waited 1 second(s)."]);
  assert(
    !blocked.some(({ type, text }) => type === "response" && text === complete),
  );
  assert(
    blocked.some(({ type, message }) =>
      type === "error" && message?.includes("blocked")
    ),
  );

  fixture.reset(undefined, 3601);
  await turn();
  assertStringIncludes(fixture.delivered[0], "integer seconds");

  const entered = fixture.reset(undefined, 3600);
  let cancelSent = false;
  const cancelled = await turn(async (socket) => {
    await entered;
    socket.send(JSON.stringify({ type: "cancel" }));
    cancelSent = true;
  });
  assertEquals(fixture.delivered, []);
  assert(
    !cancelled.some(({ type, text }) =>
      type === "response" && text === complete
    ),
  );
});

Deno.test("Delegated and signed scheduled models can call the configured shared sleep tool", async () => {
  for (const role of ["subagent", "cronJob"] as const) {
    const fixture = waitFixture();
    const factory: OrchestratorFactory = {
      create(channelId, options) {
        if (role === "subagent") {
          assertEquals(options?.delegatedKind, "subagent");
        }
        const session = createSession({
          userId: "machine" as UserId,
          channelId: channelId as ChannelId,
        });
        const toolExecutor = () =>
          Promise.reject(
            new Error("Unexpected machine callback outside root sleep"),
          );
        return Promise.resolve({
          session,
          toolExecutor,
          getSessionTaint: () => "PUBLIC",
          orchestrator: createOrchestrator({
            tools: resolveToolsForProfile(role).filter(({ name }) =>
              name === "sleep"
            ),
            providerRegistry: fixture.providers(),
            hookRunner: fixture.hookRunner,
            ...(role === "cronJob" &&
              {
                isTriggerSession: () => true,
                getNonOwnerCeiling: () => "PUBLIC",
              }),
            toolExecutor,
          }),
        });
      },
    };
    if (role === "subagent") {
      const run = buildSubagentFactory(factory);
      const owner = createProviderRegistry();
      owner.register({
        name: "delegate-sleep-fixture",
        supportsStreaming: false,
        complete(messages) {
          const result = messages.findLast(({ role }) => role === "tool")
            ?.content;
          return Promise.resolve({
            usage: modelSteps,
            content: result ? String(result) : "",
            toolCalls: result ? [] : [{
              id: "delegate-wait",
              type: "function",
              function: { name: "subagent", arguments: "{}" },
            }],
          });
        },
      });
      owner.setDefault("delegate-sleep-fixture");
      const frames = await gatewayTurn({
        session: ownerSession(),
        tools: resolveToolsForProfile("cli").filter(({ name }) =>
          name === "subagent"
        ),
        providerRegistry: owner,
        hookRunner: fixture.hookRunner,
        toolExecutor: (name) => {
          assertEquals(name, "subagent");
          return run("Wait before continuing this delegated run.");
        },
      }, "Wait in a delegated run.");
      assert(
        frames.some(({ type, text }) =>
          type === "response" && text?.includes(complete)
        ),
      );
    } else {
      const secret = "fixture-signed-sleep";
      const scheduler = createSchedulerService({
        orchestratorFactory: factory,
        triggerMdPath: "/unused",
        trigger: {
          enabled: false,
          intervalMinutes: 30,
          classificationCeiling: "PUBLIC",
        },
        webhooks: {
          enabled: true,
          sources: { fixture: { secret, classification: "PUBLIC" } },
        },
      });
      const server = createGatewayServer({
        port: 0,
        schedulerService: scheduler,
      });
      const { port } = await server.start();
      try {
        const body = '{"event":"poll.wait"}';
        const timestamp = String(Date.now());
        const response = await fetch(
          `http://127.0.0.1:${port}/webhooks/fixture`,
          {
            method: "POST",
            body,
            headers: {
              "x-timestamp": timestamp,
              "x-signature": await computeTimestampedHmac(
                timestamp,
                body,
                secret,
              ),
            },
          },
        );
        assertEquals(response.status, 200);
        await response.body?.cancel();
      } finally {
        scheduler.stop();
        await server.stop();
      }
    }
    assertEquals(fixture.delivered, ["Waited 1 second(s)."]);
    assert(fixture.hooks.includes("PRE_TOOL_CALL"));
    assert(fixture.hooks.includes("POST_TOOL_RESPONSE"));
    assert(fixture.hooks.includes("PRE_OUTPUT"));
  }
});

Deno.test("Durable gateway sleep keeps its original deadline and reuses the completed receipt", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agent-recovery.db");
  const session = ownerSession();
  const id = crypto.randomUUID();
  const key = assignmentRecoveryKey(session.id, id);
  const fixture = waitFixture();
  function state() {
    const store = new AgentRecoveryStore(path);
    try {
      const run = store.read(key);
      return {
        run,
        pending: run?.status === "pending"
          ? store.pendingCall(key, run.pendingBatch)
          : undefined,
      };
    } finally {
      store.close();
    }
  }
  const request = `/recover ${id} Wait before continuing the review.`;
  const turn = (during?: (socket: WebSocket) => Promise<void>) =>
    gatewayTurn(
      {
        session,
        tools: resolveToolsForProfile("cli").filter(({ name }) =>
          name === "sleep"
        ),
        providerRegistry: fixture.providers(),
        hookRunner: fixture.hookRunner,
        enableStreaming: false,
        toolExecutor: () =>
          Promise.reject(new Error("Unexpected callback outside root sleep")),
        recoverAgentTurn: (executionId, orchestrator, options, control) =>
          runRecoverableAgentTurn(
            path,
            executionId,
            {
              version: "sleep-only-fixture",
              classification: () => "PUBLIC",
              projectCall: () => undefined,
              projectResult: () => undefined,
              authorize: () => Promise.resolve(false),
            },
            orchestrator,
            options,
            control,
          ),
      },
      request,
      during,
    );
  try {
    const started = fixture.reset(undefined, 2);
    let deadline = 0;
    await turn(async (socket) => {
      await started;
      for (let attempt = 0; attempt < 100 && !deadline; attempt++) {
        const pending = state().pending;
        if (pending?.name === "sleep") {
          assertEquals(pending.args.seconds, 2);
          assert(typeof pending.args.deadline === "number");
          deadline = pending.args.deadline;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      assert(deadline > Date.now());
      socket.send(JSON.stringify({ type: "cancel" }));
    });
    assertEquals(state().pending?.args.deadline, deadline);
    assertEquals(state().run?.committedBatch, 0);

    fixture.reset("pre", 2);
    const denied = await turn();
    assert(
      denied.some(({ type, message }) =>
        type === "error" && message?.includes("blocked by the current policy")
      ),
    );
    assertEquals(fixture.delivered, []);
    assertEquals(state().pending?.args.deadline, deadline);

    // Reopen while the timer is pending, with less than the original delay left.
    const advance = deadline - Date.now() - 700;
    if (advance > 0) {
      await new Promise((resolve) => setTimeout(resolve, advance));
    }
    fixture.reset(undefined, 2, true);
    const resumedAt = Date.now();
    const settled = await turn();
    assert(Date.now() >= deadline);
    assert(Date.now() - resumedAt < 1700);
    assert(!settled.some(({ type }) => type === "tool_call"));
    assertEquals(fixture.delivered, ["Waited 2 second(s)."]);
    const checkpoint = state().run;
    assertEquals(checkpoint?.status, "ready");
    assertEquals(checkpoint?.committedBatch, 1);
    assert(checkpoint && "tools" in checkpoint);
    assertEquals(checkpoint.tools[0]?.args, { seconds: 2 });

    fixture.reset(undefined, 2);
    const resumed = await turn();
    assert(
      resumed.some(({ type, text }) =>
        type === "response" && text === complete
      ),
    );
    assert(!resumed.some(({ type }) => type === "tool_call"));
    assertEquals(fixture.delivered, ["Waited 2 second(s)."]);
    assertEquals(state().run?.status, "finished");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
