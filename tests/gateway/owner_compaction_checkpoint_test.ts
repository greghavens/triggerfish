import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
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
  const registry = createProviderRegistry();
  registry.register({
    name: "compaction-fixture",
    supportsStreaming: false,
    complete(messages) {
      const trace = JSON.stringify(messages);
      requests.push(trace);
      const summary = trace.includes("You are a conversation summarizer.");
      return Promise.resolve({
        content: summary ? "The verified checkpoint summary." : "Owner reply.",
        toolCalls: [],
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
        hookRunner: createHookRunner(createPolicyEngine()),
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
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
