import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";

Deno.test("Reviewed agent profiles persist history and restrict a selected gateway agent", async () => {
  const baseDir = await Deno.makeTempDir();
  const registry = createProviderRegistry();
  const token = crypto.randomUUID();
  let requested = {
    name: "operator_runs",
    args: {} as Record<string, unknown>,
  };
  let result = "";
  let modelPrompt = "";
  let advertised = "";
  let confirmations = 0;
  let allowed = true;
  let invoked = 0;
  registry.register({
    name: "agent-profile-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      modelPrompt = messages.filter(({ role }) => role === "system")
        .map(({ content }) => content).join("\n");
      advertised = JSON.stringify(tools ?? []);
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
            name: requested.name,
            arguments: JSON.stringify(requested.args),
          },
        }],
      });
    },
  });
  registry.setDefault("agent-profile-fixture");
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "agent-profile-fixture" as ChannelId,
      }),
      providerRegistry: registry,
      customToolsBaseDir: baseDir,
      tools: [{
        name: "fixture_read",
        description: "Read fixture.",
        parameters: {},
      }],
      toolExecutor: () => {
        invoked++;
        return Promise.resolve("Fixture result.");
      },
      hookRunner: {
        evaluateHook: () =>
          Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          }),
      },
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => {
          confirmations++;
          return Promise.resolve(allowed);
        },
      }),
    }),
  });
  let socket: WebSocket | undefined;
  try {
    const { port } = await gateway.start();
    const ws = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string) => {
      result = "";
      const done = Promise.withResolvers<void>();
      const timeout = setTimeout(
        () => done.reject(new Error("Turn timed out")),
        5000,
      );
      const receive = ({ data }: MessageEvent) => {
        if (JSON.parse(String(data)).type === "turn_end") done.resolve();
      };
      ws.addEventListener("message", receive);
      try {
        ws.send(JSON.stringify({ type: "message", content }));
        await done.promise;
        return result;
      } finally {
        clearTimeout(timeout);
        ws.removeEventListener("message", receive);
      }
    };
    const manage = (args: Record<string, unknown>) => {
      requested = { name: "operator_runs", args };
      return turn("Perform the requested agent profile operation.");
    };
    const id = "test-agent";
    const profileSettings = {
      name: "Test agent",
      description: "Read-only role.",
      role: "assistant",
      prompt: "Use careful wording for {{topic}}.",
      tools: [],
      skills: [],
      wrapupPrompt: "Summarize only evidence.",
      timeoutWrapupPrompt: "State what remained undone.",
    };
    const creation = {
      action: "set_agent_profile",
      id,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      profileSettings,
    };
    allowed = false;
    assertStringIncludes(await manage(creation), "unavailable");
    allowed = true;
    assertEquals(JSON.parse(await manage(creation)).profile.version, 1);
    assertEquals(JSON.parse(await manage(creation)).profile.version, 1);
    assertEquals(confirmations, 2);
    const preview = await manage({
      action: "preview_agent_prompt",
      id,
      promptVariables: { topic: "alerts" },
    });
    assertEquals(JSON.parse(preview).prompt, "Use careful wording for alerts.");
    const changed = await manage({
      ...creation,
      requestId: crypto.randomUUID(),
      expectedVersion: 1,
      profileSettings: {
        ...profileSettings,
        prompt: "Verified test instructions.",
      },
    });
    assertEquals(JSON.parse(changed).profile.version, 2);
    const history = await manage({ action: "agent_profile_history", id });
    assertEquals(
      JSON.parse(history).history.map((row: { version: number }) =>
        row.version
      ),
      [2, 1],
    );
    const original = await manage({ action: "agent_profile", id, version: 1 });
    assertEquals(
      JSON.parse(original).profile.definition.prompt,
      profileSettings.prompt,
    );
    await turn("/agent-profile test-agent");
    requested = { name: "fixture_read", args: {} };
    await turn("Can this agent invoke the fixture tool?");
    assert(modelPrompt.includes("Verified test instructions."));
    assert(!advertised.includes("fixture_read"));
    assertEquals(invoked, 0);
    await turn("/agent-profile off");
    const deleted = await manage({
      action: "delete_agent_profile",
      id,
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
    });
    assertEquals(JSON.parse(deleted).profile.definition, null);
    assertEquals(
      JSON.parse(await manage({ action: "agent_profiles" })).profiles,
      [],
    );
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
