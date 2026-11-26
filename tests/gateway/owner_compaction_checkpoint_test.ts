import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import { ownerCompactionRequested } from "../../src/gateway/chat_compaction.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("owner gateway compaction checkpoints exact sources and restores the summary with later turns", async () => {
  const directory = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".owner-compaction-",
  });
  const path = join(directory, "conversation.json");
  await Deno.writeTextFile(path, "{}");
  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const requests: string[] = [];
  const eventBodies: string[] = [];
  const hookPhases: string[] = [];
  let deny: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | null = null;
  let enabled = false;
  let modelPresentedTool = false;
  const compactPrompt = "Compact during this owner turn.";
  const toolName = "compact_owner_context";
  const baseHooks = createHookRunner(createPolicyEngine());
  const registry = createProviderRegistry();
  registry.register({
    name: "compaction-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      const trace = JSON.stringify(messages);
      requests.push(trace);
      const summary = trace.includes("You are a conversation summarizer.");
      const wantsCompaction = messages.at(-1)?.content === compactPrompt;
      const toolAvailable = JSON.stringify(tools).includes(toolName);
      if (wantsCompaction) modelPresentedTool = toolAvailable;
      return Promise.resolve({
        content: summary
          ? (enabled
            ? "Second verified summary."
            : "The verified checkpoint summary.")
          : (wantsCompaction && toolAvailable ? "" : "Owner reply."),
        toolCalls: wantsCompaction && toolAvailable
          ? [{
            id: crypto.randomUUID(),
            type: "function",
            function: { name: toolName, arguments: "{}" },
          }]
          : [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("compaction-fixture");

  async function connect(
    work: (
      turn: (input: object, completion: string) => Promise<void>,
      store: ReturnType<typeof createMessageStore>,
    ) => Promise<void>,
  ) {
    // Close and reconstruct the storage adapter from a durable snapshot on
    // every server start. The test does not reuse an in-memory history map.
    const storage = createMemoryStorage();
    const saved = JSON.parse(await Deno.readTextFile(path)) as Record<
      string,
      string
    >;
    for (const [key, value] of Object.entries(saved)) {
      await storage.set(key, value);
    }
    const store = createMessageStore(storage);
    const token = crypto.randomUUID();
    const server = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session,
        hookRunner: {
          ...baseHooks,
          evaluateHook(hook, context) {
            const input = context.input;
            const name = (input.tool_call as { name?: string } | undefined)
              ?.name;
            const compaction =
              (hook === "PRE_TOOL_CALL" && name === toolName) ||
              (hook === "POST_TOOL_RESPONSE" && input.tool_name === toolName) ||
              (hook === "PRE_OUTPUT" &&
                input.content === ownerCompactionRequested);
            if (compaction) hookPhases.push(hook);
            return compaction && hook === deny
              ? Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              })
              : baseHooks.evaluateHook(hook, context);
          },
        },
        enableOwnerContextCompaction: enabled,
        providerRegistry: registry,
        messageStore: store,
        targetClassification: "INTERNAL",
        getSessionTaint: () => "INTERNAL",
      }),
    });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      await work(async (input, completion) => {
        const complete = Promise.withResolvers<void>();
        const deadline = setTimeout(
          () => complete.reject(new Error(`Missing ${completion}`)),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          eventBodies.push(String(data));
          const event = JSON.parse(data);
          if (event.type === "error") complete.reject(new Error(event.message));
          if (event.type === completion) complete.resolve();
        };
        socket.addEventListener("message", receive);
        try {
          socket.send(JSON.stringify(input));
          await complete.promise;
        } finally {
          clearTimeout(deadline);
          socket.removeEventListener("message", receive);
        }
      }, store);
    } finally {
      socket.close();
      await server.stop();
      const rows: Record<string, string> = {};
      for (const key of await storage.list()) {
        rows[key] = (await storage.get(key))!;
      }
      await Deno.writeTextFile(path, JSON.stringify(rows));
      await storage.close();
    }
  }
  try {
    await connect(async (turn, store) => {
      await turn(
        { type: "message", content: "Earlier owner context A." },
        "turn_end",
      );
      await turn(
        { type: "message", content: "Earlier owner context B." },
        "turn_end",
      );
      const original = await store.loadSession(session.id);
      assertEquals(original.length, 4);
      const secret = "Synthetic-protected-compaction-marker";
      const trace = await store.append({
        session_id: session.id,
        role: "tool_call",
        classification: "INTERNAL",
        content: secret,
        tool_name: "fixture",
        tool_args: { raw: secret },
      });
      await turn({ type: "compact" }, "compact_complete");
      const records = await store.loadSession(session.id);
      const summary = records.find((record) =>
        record.role === "compaction_summary"
      );
      assertExists(summary);
      assertEquals(
        summary.compaction?.sourceMessageIds,
        original.map((record) => record.message_id),
      );
      assertEquals(
        summary.compaction?.throughSequence,
        original.at(-1)?.sequence,
      );
      assertEquals(summary.classification, "INTERNAL");
      assert(summary.content.includes("The verified checkpoint summary."));
      assert(!requests.at(-1)?.includes(secret));
      assertEquals(
        records.find((record) => record.message_id === trace.message_id),
        trace,
      );
      assertEquals(records.slice(0, 4), original);
      await turn({ type: "compact" }, "compact_complete");
      assertEquals(await store.loadSession(session.id), records);
      await turn(
        { type: "message", content: "Later owner context." },
        "turn_end",
      );
    });
    await connect(async (turn) => {
      await turn(
        { type: "message", content: "What do you recall?" },
        "turn_end",
      );
      const restored = requests.at(-1);
      assertExists(restored);
      assert(restored.includes("The verified checkpoint summary."));
      assert(restored.includes("Later owner context."));
      assert(!restored.includes("Earlier owner context A."));
      assert(!restored.includes("Synthetic-protected-compaction-marker"));
    });
    await connect(async (turn) => {
      await turn({ type: "message", content: compactPrompt }, "turn_end");
      assertEquals(modelPresentedTool, false);
    });
    enabled = true;
    await connect(async (turn, store) => {
      const checkpointCount = async () =>
        (await store.loadSession(session.id))
          .filter(({ role }) => role === "compaction_summary").length;
      deny = "PRE_TOOL_CALL";
      await turn({ type: "message", content: compactPrompt }, "turn_end");
      assert(modelPresentedTool);
      assertEquals(await checkpointCount(), 1);
      assertEquals(hookPhases.splice(0), ["PRE_TOOL_CALL"]);
      deny = "POST_TOOL_RESPONSE";
      await turn({ type: "message", content: compactPrompt }, "turn_end");
      assertEquals(await checkpointCount(), 1);
      assertEquals(hookPhases.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      deny = "PRE_OUTPUT";
      eventBodies.length = 0;
      const requestStart = requests.length;
      await turn({ type: "message", content: compactPrompt }, "turn_end");
      assertEquals(await checkpointCount(), 2);
      assertEquals(hookPhases.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_OUTPUT",
      ]);
      assert(
        !eventBodies.some((body) =>
          body.includes(ownerCompactionRequested) ||
          body.includes("Second verified summary.")
        ),
      );
      const [offer, summarize, next] = requests.slice(requestStart);
      assertExists(offer);
      assertExists(summarize);
      assertExists(next);
      assert(summarize.includes("You are a conversation summarizer."));
      assert(!summarize.includes(ownerCompactionRequested));
      assert(next.includes("Second verified summary."));
      assert(next.includes(compactPrompt));
      assert(next.includes(ownerCompactionRequested));
      const history = await store.loadSession(session.id);
      const checkpoint = history.findLast(({ role }) =>
        role === "compaction_summary"
      );
      const activePrompt = history.findLast(({ role, content }) =>
        role === "user" && content === compactPrompt
      );
      assertExists(checkpoint?.compaction);
      assertExists(activePrompt);
      assert(
        !checkpoint.compaction.sourceMessageIds.includes(
          activePrompt.message_id,
        ),
      );
    });
    enabled = false;
    deny = null;
    await connect(async (turn) => {
      await turn({
        type: "message",
        content: "Check the restored in-turn summary.",
      }, "turn_end");
      assert(requests.at(-1)?.includes("Second verified summary."));
      assert(requests.at(-1)?.includes(compactPrompt));
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
