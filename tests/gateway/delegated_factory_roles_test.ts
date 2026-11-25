import { join } from "@std/path";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { buildAgentInlineDefinitions } from "../../src/gateway/tools/defs/agent_tool_defs.ts";
import { dispatchSubagentTask } from "../../src/gateway/tools/executor/executor_handlers.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createOrchestratorFactory } from "../../src/gateway/startup/factory/orchestrator_factory.ts";

Deno.test("Production factory binds delegated agents to their own tool profile", async () => {
  const dir = await Deno.makeTempDir();
  const calls: { tools: string[]; reply?: string }[] = [];
  let requestedTool = "cron";
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response(null, { status: 404 });
    }
    const body = await request.json();
    const reply = calls.length
      ? body.messages.findLast(
        ({ role }: { role: string }) => role === "tool",
      )?.content
      : undefined;
    const tools = body.tools.map(
      ({ function: { name } }: { function: { name: string } }) => name,
    );
    calls.push({ tools, reply });
    const message = reply
      ? { role: "assistant", content: "Role review complete." }
      : {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "role-check",
          type: "function",
          function: {
            name: requestedTool,
            arguments: requestedTool === "cron" ? '{"action":"list"}' : "{}",
          },
        }],
      };
    if (body.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{ message }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  const localProvider = {
    model: "role-fixture",
    endpoint: `http://127.0.0.1:${server.addr.port}`,
  };
  const config = {
    models: {
      primary: { provider: "ollama", model: "role-fixture" },
      providers: { ollama: localProvider },
    },
    channels: {},
    classification: { mode: "strict" },
  } satisfies TriggerFishConfig;
  const storage = createMemoryStorage();
  try {
    const factory = createOrchestratorFactory(
      config,
      dir,
      undefined,
      storage,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        google: false,
        github: false,
        caldav: false,
        notion: false,
        x: false,
        obsidian: false,
        signal: false,
        telegram: false,
        discord: false,
        whatsapp: false,
      },
    );
    for (const role of ["subagent", "team", "scheduled"] as const) {
      calls.length = 0;
      requestedTool = "cron";
      const { orchestrator, session } = await factory.create(
        role,
        role === "scheduled" ? {} : { delegatedKind: role },
      );
      const result = await orchestrator.executeAgentTurn({
        session,
        message: "Review the current task role.",
        targetClassification: "INTERNAL",
      });
      assert(result.ok, JSON.stringify(result));
      assertEquals(calls[0].tools.includes("cron"), role === "scheduled");
      assert(calls[0].tools.includes("todo_read"));
      assertEquals(calls.length, 2);
      if (role !== "scheduled") {
        assertStringIncludes(
          calls[1].reply ?? "",
          "outside the delegated role",
        );
      }
      calls.length = 0;
      requestedTool = "todo_read";
      orchestrator.clearHistory(session.id);
      const checklist = await orchestrator.executeAgentTurn({
        session,
        message: "Read the current checklist.",
        targetClassification: "INTERNAL",
      });
      assert(checklist.ok, JSON.stringify(checklist));
      assertStringIncludes(calls[1].reply ?? "", "No todos.");
    }
  } finally {
    await storage.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

async function testSubagentGoalReport(requiresApproval: boolean) {
  const dir = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const expected =
    "No todos. Use todo_write to create your task list. Revision: empty";
  const reviewed = Promise.withResolvers<string>();
  const finish = Promise.withResolvers<void>();
  const report = (criterion: string) => ({
    name: "delegated_goal_report",
    arguments: JSON.stringify({ scope: "review", criterion }),
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response(null, { status: 404 });
    }
    const body = await request.json();
    const tools = (body.tools ?? []).map((
      { function: { name } }: { function: { name: string } },
    ) => name);
    assert(tools.includes("delegated_goal_report"));
    const prior = body.messages.filter(({ role }: { role: string }) =>
      role === "tool"
    ).map(({ content }: { content: string }) => content);
    let call: { name: string; arguments: string } | undefined;
    if (!prior.length) call = report("child");
    else if (prior.length === 1) {
      assertStringIncludes(
        prior[0],
        requiresApproval ? "approval" : "unavailable",
      );
      call = { name: "todo_read", arguments: "{}" };
    } else if (prior.length === 2) {
      assertEquals(prior[1], expected);
      call = report("team");
    } else if (prior.length === 3) {
      assertStringIncludes(
        prior[2],
        requiresApproval ? "approval" : "unavailable",
      );
      call = report("child");
    } else {
      reviewed.resolve(prior[3]);
      await finish.promise;
    }
    const message = call
      ? {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: call,
        }],
      }
      : { role: "assistant", content: "Public delegated review finished." };
    if (body.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{ message }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  try {
    const resultSha256 = await computeContentHash(expected);
    const provider = {
      model: "report-fixture",
      endpoint: `http://127.0.0.1:${server.addr.port}`,
    };
    const config: TriggerFishConfig = {
      models: {
        primary: { provider: "ollama", model: "report-fixture" },
        providers: { ollama: provider },
      },
      channels: {},
      classification: { mode: "strict" },
      ...(requiresApproval && { tool_approval: ["delegated_goal_report"] }),
      delegated_goal_completion: [{
        scope: "review",
        goal: "Complete two independent reports.",
        policy: "operator",
        criteria: (["subagent", "team"] as const).map((kind) => ({
          id: kind === "subagent" ? "child" : "team",
          description: "Verify the classified checklist result.",
          kind,
          tool: "todo_read",
          result_sha256: resultSha256,
        })),
      }],
    };
    const factory = createOrchestratorFactory(config, dir, undefined, storage);
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    const registry = createProviderRegistry();
    registry.register({
      name: "owner-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        return Promise.resolve({
          content: result ? String(result.content) : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: result ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "subagent",
              arguments: JSON.stringify({
                task: "Review and report the current goal evidence.",
              }),
            },
          }],
        });
      },
    });
    registry.setDefault("owner-fixture");
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: registry,
        hookRunner: createHookRunner(createPolicyEngine()),
        tools: buildAgentInlineDefinitions().filter(({ name }) =>
          name === "subagent"
        ),
        toolExecutor: (name, args) =>
          name === "subagent"
            ? dispatchSubagentTask(args, buildSubagentFactory(factory))
            : Promise.resolve("Unavailable"),
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const ended = Promise.withResolvers<void>();
    void ended.promise.catch(() => {});
    const inbox = createToolApprovalService(join(dir, "tool-approvals.db"));
    const denialTimer = requiresApproval
      ? setInterval(() => {
        for (const pending of inbox.list().records) {
          if (
            pending.tool === "delegated_goal_report" &&
            pending.status === "pending"
          ) {
            inbox.decide(pending.id, "denied");
          }
        }
      }, 5)
      : undefined;
    const timer = setTimeout(() => {
      const error = new Error("Delegated goal gateway did not finish");
      reviewed.reject(error);
      ended.reject(error);
    }, 4000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "message",
          content: "Delegate the goal review.",
        }),
      );
    socket.onmessage = ({ data }) => {
      if (JSON.parse(data).type === "turn_end") ended.resolve();
    };
    try {
      const response = await reviewed.promise;
      const observation = requiresApproval ? undefined : JSON.parse(response);
      if (requiresApproval) assertStringIncludes(response, "approval");
      else {
        assertEquals(observation.verified, true);
        assertEquals(observation._classification, "PUBLIC");
      }
      const check = await factory.runDelegatedGoalCommand!(
        "/goal delegated status review",
        "PUBLIC",
      );
      const whileRunning = JSON.parse(check!);
      assertEquals(whileRunning.status, "open");
      assertEquals(whileRunning.satisfied, requiresApproval ? [] : ["child"]);
      assertEquals(
        whileRunning.open,
        requiresApproval ? ["child", "team"] : ["team"],
      );
      if (observation) {
        assertEquals(
          whileRunning.observations[0].evidence[0].reference,
          observation.evidenceReference,
        );
      }
      finish.resolve();
      await ended.promise;
      const reopened = createOrchestratorFactory(
        config,
        dir,
        undefined,
        storage,
      );
      const saved = JSON.parse(
        (await reopened.runDelegatedGoalCommand!(
          "/goal delegated status review",
          "PUBLIC",
        ))!,
      );
      if (requiresApproval) {
        // Normal post-turn reporting remains independent of the denied call.
        assertEquals(saved.satisfied, ["child"]);
      } else assertEquals(saved, whileRunning);
    } finally {
      finish.resolve();
      clearTimeout(timer);
      clearInterval(denialTimer);
      socket.close();
      await gateway.stop();
    }
  } finally {
    await storage.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Owner gateway subagent reports exact delegated goal evidence during its turn", () =>
  testSubagentGoalReport(false));
Deno.test("Root policy can prevent an in-turn delegated goal report", () =>
  testSubagentGoalReport(true));
