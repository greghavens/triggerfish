import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import { readConfigYaml } from "../../../src/core/config_io.ts";
import type { HookType } from "../../../src/core/policy/rules.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../../src/core/types/session.ts";
import { createChatSession } from "../../../src/gateway/chat.ts";
import { createGatewayServer } from "../../../src/gateway/server/server.ts";
import { getMcpManageToolDefinitions } from "../../../src/gateway/tools/defs/mcp_manage_defs.ts";
import { filterToolsForRole } from "../../../src/gateway/tools/defs/role_filter.ts";
import { createMcpManageExecutor } from "../../../src/gateway/tools/executor/executor_mcp_manage.ts";

Deno.test("Owner gateway approves exact MCP settings and validates root hooks", async () => {
  const dir = await Deno.makeTempDir();
  const previousDataDir = Deno.env.get("TRIGGERFISH_DATA_DIR");
  Deno.env.set("TRIGGERFISH_DATA_DIR", dir);
  const configPath = join(dir, "triggerfish.yaml");
  const original = `mcp_servers:
  inventory:
    command: npx
    args:
      - fixture
    classification: CONFIDENTIAL
    env:
      API_TOKEN: secret:inventory-api
  dashboards:
    enabled: false
    url: https://example.invalid/stream
`;
  await Deno.writeTextFile(configPath, original);
  const registry = createProviderRegistry();
  const tools = getMcpManageToolDefinitions();
  assertEquals(filterToolsForRole(tools, false), []);
  const proposed = {
    action: "update",
    server_id: "inventory",
    tool_call_timeout_ms: 15_000,
    max_retries: 3,
  };
  let arguments_: Record<string, unknown> = proposed;
  let received = "";
  registry.register({
    name: "mcp-update-fixture",
    supportsStreaming: false,
    complete(messages, definitions) {
      assert(
        definitions?.some((definition) =>
          (definition as { function?: { name: string } }).function?.name ===
            "mcp_manage"
        ),
      );
      const last = messages.at(-1);
      const done = last?.role === "tool";
      if (done) received = String(last.content);
      return Promise.resolve({
        content: done ? "Updated the configured connector." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: done ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "mcp_manage",
            arguments: JSON.stringify(arguments_),
          },
        }],
      });
    },
  });
  registry.setDefault("mcp-update-fixture");
  let denyHook: HookType | undefined;
  let approved = false;
  let changeDuringApproval = false;
  const prompts: string[] = [];
  const hooks: string[] = [];
  const execute = createMcpManageExecutor({
    configPath,
    getConfirmPrompt: () => async (prompt) => {
      prompts.push(prompt);
      if (changeDuringApproval) {
        await Deno.writeTextFile(
          configPath,
          original.replace("fixture", "different"),
        );
      }
      return approved;
    },
  });
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "owner-chat" as ChannelId,
    }),
    providerRegistry: registry,
    tools,
    async toolExecutor(name, args, context) {
      return await execute(name, args, context) ?? "Error: Unknown tool.";
    },
    targetClassification: "CONFIDENTIAL",
    enableStreaming: false,
    hookRunner: {
      evaluateHook(hook, { input }) {
        hooks.push(hook);
        if (
          hook === "POST_TOOL_RESPONSE" &&
          typeof input.tool_response === "string" &&
          input.tool_response.includes('"changed":true')
        ) {
          assertEquals(
            JSON.parse(input.tool_response)._classification,
            "INTERNAL",
          );
        }
        const allowed = hook !== denyHook;
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    },
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async () => {
      const events: string[] = [];
      hooks.length = 0;
      received = "";
      const ended = Promise.withResolvers<void>();
      const timer = setTimeout(
        () =>
          ended.reject(
            new Error("Owner MCP update gateway turn did not finish."),
          ),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        const { type } = JSON.parse(data);
        events.push(type);
        if (type === "turn_end") ended.resolve();
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({
          type: "message",
          content: "Apply the exact connector runtime settings.",
        }));
        await ended.promise;
        assert(received);
        return events;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    };

    denyHook = "PRE_TOOL_CALL";
    await turn();
    assertEquals(prompts, []);
    assertEquals(await Deno.readTextFile(configPath), original);

    denyHook = undefined;
    await turn();
    assertStringIncludes(received, "cancelled");
    assertEquals(prompts.length, 1);
    assertEquals(await Deno.readTextFile(configPath), original);

    approved = true;
    changeDuringApproval = true;
    await turn();
    assertStringIncludes(received, "changed before");
    assertEquals(
      await Deno.readTextFile(configPath),
      original.replace("fixture", "different"),
    );
    changeDuringApproval = false;
    await Deno.writeTextFile(configPath, original);

    arguments_ = { ...proposed, url: "https://example.invalid/other" };
    await turn();
    assertStringIncludes(received, "only timeout or retry settings");
    assertEquals(prompts.length, 2);
    assertEquals(await Deno.readTextFile(configPath), original);

    arguments_ = proposed;
    denyHook = "POST_TOOL_RESPONSE";
    await turn();
    assertEquals(received, "Tool response withheld by policy.");
    assertEquals(
      prompts,
      Array(3).fill(
        "Update MCP server 'inventory' with tool_call_timeout_ms = 15000, max_retries = 3? Changes apply on daemon restart.",
      ),
    );
    const config = readConfigYaml(configPath);
    assert(config.ok);
    assertEquals(config.value.mcp_servers, {
      inventory: {
        command: "npx",
        args: ["fixture"],
        classification: "CONFIDENTIAL",
        env: { API_TOKEN: "secret:inventory-api" },
        tool_call_timeout_ms: 15_000,
        max_retries: 3,
      },
      dashboards: { enabled: false, url: "https://example.invalid/stream" },
    });

    denyHook = "PRE_OUTPUT";
    const output = await turn();
    assert(hooks.includes("PRE_OUTPUT"));
    assert(!output.includes("response"));
    assertEquals(JSON.parse(received).changed, false);
    assertEquals(prompts.length, 3);
    assert(!received.includes("inventory-api"));

    denyHook = undefined;
    arguments_ = { action: "status", server_id: "inventory" };
    await turn();
    assertEquals(JSON.parse(received).tool_call_timeout_ms, 15_000);
    assertEquals(JSON.parse(received).max_retries, 3);
    assert(!received.includes("inventory-api"));
  } finally {
    if (socket.readyState < WebSocket.CLOSING) {
      const closed = Promise.withResolvers<void>();
      socket.addEventListener("close", () => closed.resolve(), { once: true });
      socket.close();
      await closed.promise;
    }
    await gateway.stop();
    if (previousDataDir === undefined) Deno.env.delete("TRIGGERFISH_DATA_DIR");
    else Deno.env.set("TRIGGERFISH_DATA_DIR", previousDataDir);
    await Deno.remove(dir, { recursive: true });
  }
});
