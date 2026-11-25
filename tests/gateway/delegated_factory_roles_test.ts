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
      orchestrator.clearHistory();
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
