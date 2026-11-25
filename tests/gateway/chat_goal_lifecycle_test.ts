import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";

Deno.test("Successive owner goals archive decisions and require fresh evidence through gateway restart", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const session = createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
    });
    const registry = createProviderRegistry();
    const messages = createMessageStore(createMemoryStorage());
    let taint: ClassificationLevel = "PUBLIC";
    const tool = "check_service";
    const output = "fixture reports service available";
    let scriptedCall:
      | { name: string; args: Record<string, unknown> }
      | undefined;
    registry.register({
      name: "stub",
      supportsStreaming: false,
      complete: () => {
        const call = scriptedCall;
        scriptedCall = undefined;
        return Promise.resolve({
          content: call ? "" : "Turn finished.",
          toolCalls: call
            ? [{
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            }]
            : [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("stub");
    const withGateway = async <T>(
      run: (turn: (content: string) => Promise<string>) => Promise<T>,
    ): Promise<T> => {
      const chatSession = createChatSession({
        session,
        goalCompletionPath: join(dir, "goals.db"),
        messageStore: messages,
        providerRegistry: registry,
        getSessionTaint: () => taint,
        targetClassification: "INTERNAL",
        hookRunner: createHookRunner(createPolicyEngine()),
        enableStreaming: false,
        tools: [{ name: tool, description: "Check service", parameters: {} }],
        toolExecutor: (name) =>
          Promise.resolve(name === tool ? output : "unknown"),
      });
      const token = crypto.randomUUID();
      const server = createGatewayServer({ port: 0, token, chatSession });
      const { port } = await server.start();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        return await run((content) => {
          const done = Promise.withResolvers<string>();
          let response = "";
          let error: string | undefined;
          const timer = setTimeout(
            () => done.reject(new Error("No turn_end")),
            3000,
          );
          function receive({ data }: MessageEvent) {
            const event = JSON.parse(data);
            if (event.type === "response") response = event.text;
            if (event.type === "error") error = event.message;
            if (event.type === "turn_end") {
              if (error) done.reject(new Error(error));
              else done.resolve(response);
            }
          }
          socket.addEventListener("message", receive);
          socket.send(JSON.stringify({ type: "message", content }));
          return done.promise.finally(() => {
            clearTimeout(timer);
            socket.removeEventListener("message", receive);
          });
        });
      } finally {
        socket.close();
        await server.stop();
      }
    };

    const initial = {
      goal: "Check service health",
      policy: "automatic",
      criteria: [{
        id: "service",
        description: "Service responds with the expected status",
        tool,
        resultSha256: await computeContentHash(output),
      }],
    };
    const requestId = crypto.randomUUID();
    const successor = {
      ...initial,
      goal: "Recheck service health for the new review",
      policy: "operator",
      requestId,
    };
    const register = (input: object) =>
      `/goal register ${JSON.stringify(input)}`;
    const report = { name: "goal_report", args: { criterion: "service" } };
    const completed = await withGateway(async (turn) => {
      assertEquals(JSON.parse(await turn(register(initial))).status, "open");
      await assertRejects(
        () => turn(register(successor)),
        Error,
        "Complete the current goal",
      );
      scriptedCall = { name: tool, args: {} };
      await turn("Check the service.");
      scriptedCall = report;
      await turn("Report the criterion.");
      const result = JSON.parse(await turn("/goal status"));
      assertEquals(result.status, "completed");
      assert(result.observations[0]?.evidence[0]?.reference);
      return result;
    });

    const pending = await withGateway(async (turn) => {
      assertEquals(JSON.parse(await turn("/goal status")), completed);
      const open = JSON.parse(await turn(register(successor)));
      assertEquals(open.status, "open");
      assertEquals(JSON.parse(await turn(register(initial))), completed);
      assertEquals(JSON.parse(await turn("/goal status")), open);
      assertEquals(JSON.parse(await turn(register(successor))), open);
      await assertRejects(
        () => turn(register({ ...successor, goal: "Conflicting replacement" })),
        Error,
        "already registered",
      );
      scriptedCall = report;
      await turn("Try the old matching result for the new goal.");
      assertEquals(JSON.parse(await turn("/goal status")), open);
      taint = "INTERNAL";
      scriptedCall = { name: tool, args: {} };
      await turn("Check service again.");
      scriptedCall = report;
      await turn("Report the newly committed result.");
      const result = JSON.parse(await turn("/goal status"));
      assertEquals(result.status, "awaiting_confirmation");
      assert(
        result.observations[0]?.evidence[0]?.reference !==
          completed.observations[0].evidence[0].reference,
      );
      return result;
    });

    taint = "PUBLIC";
    await withGateway(async (turn) => {
      await assertRejects(
        () => turn("/goal status"),
        Error,
        "unavailable at this classification",
      );
      await assertRejects(
        () => turn("/goal history"),
        Error,
        "unavailable at this classification",
      );
      await assertRejects(
        () => turn(register(successor)),
        Error,
        "unavailable at this classification",
      );
      assertEquals(JSON.parse(await turn("/goal status legacy")), completed);
      taint = "INTERNAL";
      assertEquals(JSON.parse(await turn("/goal status")), pending);
      assertEquals(JSON.parse(await turn("/goal status legacy")), completed);
      const second = JSON.parse(await turn("/goal confirm"));
      assertEquals(second.status, "completed");
      assertEquals(second.observations, pending.observations);
      assertEquals(JSON.parse(await turn(`/goal status ${requestId}`)), second);
      assertEquals(JSON.parse(await turn(register(successor))), second);
      const history = JSON.parse(await turn("/goal history"));
      assertEquals(
        history.registrations.map((item: {
          requestId: string;
          status: string;
        }) => [item.requestId, item.status]),
        [
          [requestId, "completed"],
          ["legacy", "completed"],
        ],
      );
      assertEquals(history.nextBefore, null);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
