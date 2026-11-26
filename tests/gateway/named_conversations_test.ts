import { assert } from "@std/assert";
import { liveProviderRouteSettings } from "../../src/agent/providers/live_routes.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";
import { join } from "@std/path";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("Named conversations retain isolated turns and reviewed lifecycle across gateway restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const token = crypto.randomUUID();
  let args: Record<string, unknown> | undefined;
  let toolResult = "";
  let allow = true;
  let reviews = 0;
  const started = Promise.withResolvers<AbortSignal>();
  let interruptions = 0;
  const registry = createProviderRegistry();
  registry.register({
    name: "named-conversation-fixture",
    supportsStreaming: false,
    complete(history, _tools, options) {
      const usage = { inputTokens: 1, outputTokens: 1 };
      const last = history.at(-1);
      if (last?.role === "tool") {
        toolResult = String(last.content);
        return Promise.resolve({ content: "Updated.", usage, toolCalls: [] });
      }
      if (args) {
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }],
        });
      }
      if (last?.content === "Wait for the reviewed deletion.") {
        const signal = options.signal as AbortSignal;
        started.resolve(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            interruptions++;
            reject(signal.reason);
          }, { once: true });
        });
      }
      const content = history.filter(({ role }) => role === "user").map(
        ({ content }) => String(content),
      ).join(" | ");
      return Promise.resolve({ content, usage, toolCalls: [] });
    },
  });
  let pinnedCalls = 0;
  const allowlists: { INTERNAL: string[] } = {
    INTERNAL: ["named-profile-fixture"],
  };
  registry.register({
    name: "named-profile-fixture",
    model: "named-route",
    supportsStreaming: false,
    complete(history, tools) {
      pinnedCalls++;
      assert(!JSON.stringify(tools).includes("fixture_profile_only"));
      assert(!JSON.stringify(history).includes("Prompt for other run types."));
      const context = history.filter(({ role }) => role === "user").map(
        ({ content }) => String(content),
      ).join(" | ");
      return Promise.resolve({
        content: `Pinned model: ${context}`,
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: [],
      });
    },
  });
  registry.setDefault("named-conversation-fixture");
  const open = (messages: ReturnType<typeof createMessageStore>) =>
    createGatewayServer({
      token,
      port: 0,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "named-conversations-fixture" as ChannelId,
        }),
        customToolsBaseDir: baseDir,
        providerRegistry: registry,
        agentModelProfileAllowlists: allowlists,
        messageStore: messages,
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
          liveModelRoutes: liveProviderRouteSettings(
            registry,
            baseDir,
            allowlists,
          ),
          confirm: () => {
            reviews++;
            return Promise.resolve(allow);
          },
        }),
      }),
    });
  async function withGateway<T>(
    exercise: (
      turn: (text: string) => Promise<{ text: string; tool: string }>,
      manage: (action: Record<string, unknown>) => Promise<string>,
    ) => Promise<T>,
  ) {
    const storage = createSqliteStorage(join(baseDir, "messages.db"));
    const gateway = open(createMessageStore(storage));
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const turn = (content: string) =>
        new Promise<{ text: string; tool: string }>((resolve, reject) => {
          toolResult = "";
          let text = "";
          const listener = ({ data }: MessageEvent) => {
            const frame = JSON.parse(String(data));
            if (frame.type === "response") text = frame.text;
            if (frame.type === "error") text = frame.message;
            if (frame.type !== "turn_end") return;
            clearTimeout(timer);
            socket.removeEventListener("message", listener);
            resolve({ text, tool: toolResult });
          };
          const timer = setTimeout(() => {
            socket.removeEventListener("message", listener);
            reject(new Error("Named conversation turn did not finish"));
          }, 5000);
          socket.addEventListener("message", listener);
          socket.send(JSON.stringify({ type: "message", content }));
        });
      return await exercise(turn, async (action) => {
        args = action;
        try {
          return (await turn("Manage the selected conversation.")).tool;
        } finally {
          args = undefined;
        }
      });
    } finally {
      socket.close();
      await gateway.stop();
      await storage.close();
    }
  }

  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const create = (id: string, displayName: string) => ({
    action: "set_named_conversation",
    id,
    displayName,
    expectedVersion: 0,
    requestId: crypto.randomUUID(),
  });
  const profile = {
    action: "set_agent_profile",
    id: "named-profile",
    expectedVersion: 0,
    requestId: crypto.randomUUID(),
    profileSettings: {
      name: "Reviewed named profile",
      description: "Model-only association for a named conversation.",
      role: "assistant",
      prompt: "Prompt for other run types.",
      tools: ["fixture_profile_only"],
      modelProfile: { provider: "named-profile-fixture", model: "named-route" },
    },
  };
  try {
    await withGateway(async (turn, manage) => {
      assertEquals(JSON.parse(await manage(profile)).profile.version, 1);
      const add = {
        ...create(first, "First"),
        conversationAgentProfile: { id: profile.id, version: 1 },
      };
      const before = reviews;
      assertStringIncludes(
        await manage({
          ...add,
          requestId: crypto.randomUUID(),
          conversationAgentProfile: { id: profile.id, version: 2 },
        }),
        "unavailable",
      );
      allow = false;
      assertStringIncludes(await manage(add), "declined");
      allow = true;
      assertEquals(JSON.parse(await manage(add)).records[0].version, 1);
      assertEquals(JSON.parse(await manage(add)).records[0].version, 1);
      assertEquals(reviews, before + 2);
      await manage(create(second, "Second"));
      const pin = {
        ...create(first, "Pinned first"),
        expectedVersion: 1,
        pinned: true,
      };
      assertEquals(
        JSON.parse(await manage(pin)).records[0].name,
        "Pinned first",
      );
      assertStringIncludes(
        await manage({ ...pin, requestId: crypto.randomUUID() }),
        "unavailable",
      );
      assertEquals(
        (await turn(`/conversation ${first} First private context.`)).text,
        "Pinned model: First private context.",
      );
      assertEquals(
        (await turn(`/conversation ${second} Second isolated context.`)).text,
        "Second isolated context.",
      );
    });

    await withGateway(async (turn, manage) => {
      const { conversations } = JSON.parse(
        await manage({ action: "named_conversations" }),
      );
      assertEquals(conversations.map(({ id }: { id: string }) => id), [
        first,
        second,
      ]);
      assertEquals(
        (await turn(`/conversation ${first} Continue first.`)).text,
        "Pinned model: First private context. | Continue first.",
      );
      assertEquals(conversations[0].agentProfile, {
        id: profile.id,
        version: 1,
      });
      const verifiedCalls = pinnedCalls;
      assertEquals(
        JSON.parse(
          await manage({
            ...profile,
            expectedVersion: 1,
            requestId: crypto.randomUUID(),
          }),
        ).profile.version,
        2,
      );
      assertStringIncludes(
        (await turn(`/conversation ${first} Superseded profile.`)).text,
        "unavailable",
      );
      assertEquals(pinnedCalls, verifiedCalls);
      assertEquals(
        JSON.parse(
          await manage({
            action: "set_named_conversation",
            id: first,
            expectedVersion: 2,
            requestId: crypto.randomUUID(),
            conversationAgentProfile: { id: profile.id, version: 2 },
          }),
        ).records[0].version,
        3,
      );
      allowlists.INTERNAL = [];
      assertStringIncludes(
        (await turn(`/conversation ${first} Revoked route.`)).text,
        "unavailable",
      );
      assertEquals(pinnedCalls, verifiedCalls);
      allowlists.INTERNAL = ["named-profile-fixture"];
      assertEquals(
        (await turn(`/conversation ${first} Continue under review.`)).text,
        "Pinned model: First private context. | Continue first. | Continue under review.",
      );
      assertEquals(
        JSON.parse(
          await manage({
            action: "set_named_conversation",
            id: first,
            expectedVersion: 3,
            requestId: crypto.randomUUID(),
            conversationAgentProfile: { clear: true },
          }),
        ).records[0].agentProfile,
        null,
      );
      const remove = {
        action: "delete_named_conversations",
        requestId: crypto.randomUUID(),
        conversationTargets: [
          { id: first, expectedVersion: 4 },
          { id: second, expectedVersion: 1 },
        ],
      };
      await withGateway(async (otherTurn) => {
        const pending = otherTurn(
          `/conversation ${first} Wait for the reviewed deletion.`,
        );
        const signal = await started.promise;
        allow = false;
        assertStringIncludes(await manage(remove), "declined");
        assertEquals(signal.aborted, false);
        allow = true;
        const saved = await manage(remove);
        assertEquals(
          JSON.parse(saved).records.map(
            ({ deleted }: { deleted: boolean }) => deleted,
          ),
          [true, true],
        );
        assertEquals(signal.aborted, true);
        assertEquals(await manage(remove), saved);
        await pending;
        assertEquals(interruptions, 1);
      });
      assertEquals(
        JSON.parse(await manage({ action: "named_conversations" }))
          .conversations,
        [],
      );
      assertStringIncludes(
        (await turn(`/conversation ${first} Reopen.`)).text,
        "unavailable",
      );
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
