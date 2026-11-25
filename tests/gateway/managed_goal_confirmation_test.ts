import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import type { Orchestrator } from "../../src/core/types/orchestrator.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildDelegatedGoalCompletion } from "../../src/gateway/startup/factory/delegated_goal_completion.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { reportSchedulerGoalEvidence } from "../../src/scheduler/service_goal_completion.ts";

Deno.test("Owner gateway confirms only exact scoped scheduler and delegated decisions", async () => {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  try {
    const tool = "read_release";
    const output = "The release record passed review.";
    const criterion = {
      id: "release",
      description: "Verify the saved release record",
      tool,
      result_sha256: await computeContentHash(output),
    };
    const definition = {
      scope: "same-name",
      goal: "Verify release readiness",
      policy: "operator" as const,
    };
    const scheduler = buildSchedulerGoalCompletion(
      {
        scheduler: {
          goal_completion: [{
            ...definition,
            criteria: [{ ...criterion, kind: "trigger", source_id: "trigger" }],
          }],
        },
      },
      directory,
      messages,
    )!;
    const delegated = buildDelegatedGoalCompletion(directory, [{
      ...definition,
      criteria: [{ ...criterion, kind: "subagent" }],
    }], messages)!;
    const publisher = (session_id: string) =>
      messages.append({
        session_id,
        role: "tool_call",
        classification: "INTERNAL",
        tool_name: tool,
        content: output,
      });
    const schedulerSession = crypto.randomUUID();
    await publisher(schedulerSession);
    await reportSchedulerGoalEvidence(scheduler, {
      kind: "trigger",
      sourceId: "trigger",
      sessionId: schedulerSession,
      classification: "INTERNAL",
    });
    const agent = createSession({
      userId: "child" as UserId,
      channelId: "delegated" as ChannelId,
    });
    const orchestrator: Orchestrator = {
      async executeAgentTurn({ session }) {
        await publisher(session.id);
        return {
          ok: true,
          value: {
            response: "Saved a release record.",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      },
      getHistory: () => [],
      clearHistory: () => {},
      compactHistory: () =>
        Promise.resolve({
          messagesBefore: 0,
          messagesAfter: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          summary: "",
        }),
    };
    await delegated.wrap(orchestrator, "subagent", agent.id).executeAgentTurn({
      session: agent,
      message: "Review the release.",
      targetClassification: "INTERNAL",
    });
    const registry = createProviderRegistry();
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    let taint: ClassificationLevel = "PUBLIC";
    const withGateway = async <T>(
      run: (turn: (content: string) => Promise<string>) => Promise<T>,
    ): Promise<T> => {
      const chatSession = createChatSession({
        session: owner,
        providerRegistry: registry,
        hookRunner: createHookRunner(createPolicyEngine()),
        tools: [],
        toolExecutor: () => Promise.resolve("No fixture tools"),
        messageStore: messages,
        goalCompletionPath: join(directory, "goal-completion.db"),
        getSessionTaint: () => taint,
        targetClassification: "INTERNAL",
        async runManagedGoalCommand(command, ceiling) {
          return await scheduler.runCommand(command, ceiling) ??
            await delegated.runCommand(command, ceiling);
        },
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
            3_000,
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
    const roles = ["scheduler", "delegated"] as const;
    const status = (role: string) => `/goal ${role} status same-name`;
    const confirm = (role: string, digest: string) =>
      `/goal ${role} confirm same-name ${digest}`;
    const receipts = await withGateway(async (turn) => {
      for (const role of roles) {
        await assertRejects(
          () => turn(status(role)),
          Error,
          "unavailable at this classification",
        );
      }
      taint = "INTERNAL";
      const decisions = [];
      for (const role of roles) {
        const record = JSON.parse(await turn(status(role)));
        assertEquals(record.status, "awaiting_confirmation");
        assertEquals(record.confirmation.scope, "same-name");
        assertEquals(
          record.observations[0].evidence[0].classification,
          "INTERNAL",
        );
        decisions.push(record.confirmation.decisionSha256 as string);
        await assertRejects(
          () => turn(`/goal ${role} confirm same-name`),
          Error,
          "requires the exact decision digest",
        );
      }
      assert(decisions[0] !== decisions[1]);
      for (const [index, role] of roles.entries()) {
        await assertRejects(
          () => turn(confirm(role, decisions[1 - index])),
          Error,
          "confirmation decision has changed",
        );
        assertEquals(
          JSON.parse(await turn(status(role))).status,
          "awaiting_confirmation",
        );
      }
      const completed = [];
      for (const [index, role] of roles.entries()) {
        const command = confirm(role, decisions[index]);
        const record = JSON.parse(await turn(command));
        assertEquals(record.status, "completed");
        completed.push({ command, record });
      }
      return completed;
    });
    const retention = await messages.applyRetention(
      { maxAgeDays: 0 },
      new Date(Date.now() + 1_000),
    );
    assert(retention.ok && retention.value === roles.length);
    taint = "PUBLIC";
    await withGateway(async (turn) => {
      for (const { command } of receipts) {
        await assertRejects(
          () => turn(command),
          Error,
          "unavailable at this classification",
        );
      }
      taint = "INTERNAL";
      for (const { command, record } of receipts) {
        assertEquals(JSON.parse(await turn(command)), record);
      }
    });
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
