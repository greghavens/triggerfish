import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import type { GoalCompletionRecord } from "../../src/core/goal_completion.ts";

const output = "fixture reports service available";
const tool = "check_service";

function toolCall(name: string, input: Record<string, unknown>) {
  return {
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

Deno.test("gateway owner chat reports evidence, leaves unmet goals open, and restores policy decisions", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const policy of ["automatic", "operator"] as const) {
      const session = createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      });
      const goalCompletionPath = join(dir, "goals.db");
      const registry = createProviderRegistry();
      let nextTools: readonly unknown[] = [];
      let denyGoalOutput = false;
      let deniedGoalOutputs = 0;
      let managedReads = 0;
      registry.register({
        name: "stub",
        supportsStreaming: false,
        complete: () => {
          const toolCalls = nextTools;
          nextTools = [];
          return Promise.resolve({
            content: toolCalls.length ? "" : "Turn finished.",
            toolCalls,
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      });
      registry.setDefault("stub");
      const withGateway = async <T>(
        run: (turn: (content: string) => Promise<string>) => Promise<T>,
        publicDestination = false,
      ): Promise<T> => {
        const storage = createMemoryStorage();
        const hooks = createHookRunner(createPolicyEngine());
        const chatSession = createChatSession({
          session,
          ...(publicDestination && {
            getSessionTaint: () => "INTERNAL" as const,
            targetClassification: "PUBLIC" as const,
          }),
          goalCompletionPath,
          messageStore: createMessageStore(storage),
          providerRegistry: registry,
          hookRunner: {
            ...hooks,
            evaluateHook(hook, context) {
              if (hook === "PRE_OUTPUT" && denyGoalOutput) {
                assertEquals(context.input.target_classification, "INTERNAL");
                assert(!Object.hasOwn(context.auditInput ?? {}, "content"));
                deniedGoalOutputs++;
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  message: "Sensitive denied goal text",
                  duration: 0,
                });
              }
              return hooks.evaluateHook(hook, context);
            },
          },
          runManagedGoalCommand: (command) => {
            if (command === "/goal scheduler status") {
              managedReads++;
              return Promise.resolve("managed goal fixture");
            }
            return Promise.resolve(undefined);
          },
          enableStreaming: false,
          tools: [{
            name: tool,
            description: "Check the service",
            parameters: {},
          }],
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
          await storage.close();
        }
      };

      const completed = await withGateway(async (turn) => {
        const register = {
          goal: "Check service health",
          policy,
          criteria: [{
            id: "service",
            description: "Service responds with the expected status",
            tool,
            resultSha256: await computeContentHash(output),
          }],
        };
        assertEquals(
          JSON.parse(await turn(`/goal register ${JSON.stringify(register)}`))
            .status,
          "open",
        );
        nextTools = [toolCall("goal_report", { criterion: "service" })];
        await turn("Try to satisfy the criterion before any check runs.");
        assertEquals(JSON.parse(await turn("/goal status")).status, "open");
        nextTools = [toolCall(tool, {})];
        await turn("Check the service.");
        assertEquals(JSON.parse(await turn("/goal status")).status, "open");
        nextTools = [toolCall("goal_report", { criterion: "service" })];
        await turn("Report the criterion.");
        if (policy === "operator") {
          assertEquals(
            JSON.parse(await turn("/goal status")).status,
            "awaiting_confirmation",
          );
          await turn("/goal confirm");
        }
        const record: GoalCompletionRecord = JSON.parse(
          await turn("/goal status"),
        );
        assertEquals(record.status, "completed");
        assertEquals(JSON.parse(await turn("/goal status")).criterionStatus, {
          open: [],
          satisfied: ["service"],
        });
        assert(record.observations[0]?.evidence[0]?.reference);
        assertEquals(
          record.observations[0]?.evidence[0]?.source,
          "chat_tool_result",
        );
        assertEquals(JSON.parse(await turn("/goal confirm")), record);
        return record;
      });

      await withGateway(async (turn) => {
        assertEquals(JSON.parse(await turn("/goal status")), completed);
        denyGoalOutput = true;
        for (const command of ["/goal status", "/goal scheduler status"]) {
          await assertRejects(
            () => turn(command),
            Error,
            "Output blocked by policy",
          );
        }
        assertEquals(deniedGoalOutputs, 2);
        denyGoalOutput = false;
        assertEquals(
          await turn("/goal scheduler status"),
          "managed goal fixture",
        );
        assertEquals(managedReads, 2);
        assertEquals(JSON.parse(await turn("/goal status")), completed);
      });
      await withGateway(async (turn) => {
        for (const command of ["/goal status", "/goal scheduler status"]) {
          await assertRejects(
            () => turn(command),
            Error,
            "Output blocked by policy",
          );
        }
        assertEquals(managedReads, 2);
      }, true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
