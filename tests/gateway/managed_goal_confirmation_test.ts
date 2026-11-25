import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import { GoalCompletionStore } from "../../src/core/goal_completion.ts";
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

Deno.test("Owner gateway discovers visible managed goal scopes and confirms exact decisions", async () => {
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
    const schedulerScopes = Array.from(
      { length: 22 },
      (_, index) => `scheduled-${String(index).padStart(2, "0")}`,
    );
    const scheduler = buildSchedulerGoalCompletion(
      {
        scheduler: {
          goal_completion: [
            {
              ...definition,
              criteria: [{
                ...criterion,
                kind: "trigger",
                source_id: "trigger",
              }],
            },
            ...schedulerScopes.map((scope) => ({
              ...definition,
              scope,
              goal: "Review the next scheduled release",
              criteria: [{
                ...criterion,
                kind: "trigger" as const,
                source_id: "trigger",
                tool: "unavailable_tool",
              }],
            })),
          ],
        },
      },
      directory,
      messages,
    )!;
    const delegated = buildDelegatedGoalCompletion(directory, [
      {
        ...definition,
        criteria: [{ ...criterion, kind: "subagent" }],
      },
      {
        ...definition,
        scope: "visible-delegated",
        goal: "Review the next delegated release",
        criteria: [{
          ...criterion,
          kind: "subagent",
          tool: "unavailable_tool",
        }],
      },
    ], messages)!;
    const old = new GoalCompletionStore(join(directory, "goal-completion.db"));
    try {
      old.register(
        "scheduler:unconfigured",
        "Retired",
        [criterion],
        "automatic",
      );
      old.register(
        "delegated:unconfigured",
        "Retired",
        [criterion],
        "automatic",
      );
    } finally {
      old.close();
    }
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
    let scriptedRead: Record<string, unknown> | undefined;
    let modelToolText = "";
    const offered = new Set<string>();
    registry.register({
      name: "managed-goal-fixture",
      supportsStreaming: false,
      complete(messages, tools) {
        for (const schema of tools ?? []) {
          const tool = (schema as { function?: { name?: string } }).function
            ?.name;
          if (tool) offered.add(tool);
        }
        const request = scriptedRead;
        scriptedRead = undefined;
        modelToolText = String(
          messages.filter(({ role }) => role === "tool").at(-1)?.content ?? "",
        );
        return Promise.resolve({
          content: request ? "" : "Goal read complete.",
          toolCalls: request
            ? [{
              id: crypto.randomUUID(),
              type: "function",
              function: {
                name: "managed_goal_state",
                arguments: JSON.stringify(request),
              },
            }]
            : [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("managed-goal-fixture");
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    let taint: ClassificationLevel = "PUBLIC";
    let denyListOutput = false;
    let denyModelHook: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
    let downgradeModelPost = false;
    let managedInvocations = 0;
    const modelHooks: string[] = [];
    let checkedNonOwner = false;
    const withGateway = async <T>(
      run: (turn: (content: string) => Promise<string>) => Promise<T>,
    ): Promise<T> => {
      const hooks = createHookRunner(createPolicyEngine());
      const chatSession = createChatSession({
        session: owner,
        providerRegistry: registry,
        hookRunner: {
          ...hooks,
          evaluateHook(hook, context) {
            if (
              (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE") &&
              context.input.tool_name === "managed_goal_state"
            ) {
              modelHooks.push(hook);
              assertEquals(context.input.operation_type, "read");
              assertEquals(context.input.resource_classification, taint);
              assert(!Object.hasOwn(context.auditInput ?? {}, "tool_response"));
              if (downgradeModelPost && hook === "POST_TOOL_RESPONSE") {
                taint = "PUBLIC";
              }
              if (denyModelHook === hook) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
            }
            if (
              denyListOutput && hook === "PRE_OUTPUT" &&
              typeof context.input.content === "string" &&
              context.input.content.startsWith('{"goals":')
            ) {
              assertEquals(context.input.target_classification, "INTERNAL");
              assert(!Object.hasOwn(context.auditInput ?? {}, "content"));
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                ruleId: null,
                duration: 0,
              });
            }
            return hooks.evaluateHook(hook, context);
          },
        },
        tools: [],
        toolExecutor: () => Promise.resolve("No fixture tools"),
        messageStore: messages,
        goalCompletionPath: join(directory, "goal-completion.db"),
        getSessionTaint: () => taint,
        targetClassification: "INTERNAL",
        async runManagedGoalCommand(command, ceiling) {
          managedInvocations++;
          return await scheduler.runCommand(command, ceiling) ??
            await delegated.runCommand(command, ceiling);
        },
      });
      if (!checkedNonOwner) {
        checkedNonOwner = true;
        await chatSession.registerChannel("fixture", {
          adapter: {
            classification: "PUBLIC",
            isOwner: false,
            connect: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
            send: () => Promise.resolve(),
            onMessage: () => {},
            status: () => ({ connected: true, channelType: "fixture" }),
          },
          channelName: "Fixture",
          classification: "PUBLIC",
          respondToUnclassified: true,
        });
        scriptedRead = { role: "scheduler", action: "list" };
        const calls = managedInvocations;
        await chatSession.handleChannelMessage({
          content: "Try to discover managed goals without owner access.",
          sessionId: "fixture-guest",
          senderId: "guest",
          isOwner: false,
        }, "fixture");
        assert(!offered.has("managed_goal_state"));
        assertEquals(managedInvocations, calls);
        scriptedRead = undefined;
        modelHooks.length = 0;
      }
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
    const list = (role: string, after?: string) =>
      `/goal ${role} list${after ? ` ${after}` : ""}`;
    const status = (role: string) => `/goal ${role} status same-name`;
    const confirm = (role: string, digest: string) =>
      `/goal ${role} confirm same-name ${digest}`;
    const receipts = await withGateway(async (turn) => {
      denyListOutput = true;
      await assertRejects(
        () => turn(list("scheduler")),
        Error,
        "Output blocked",
      );
      denyListOutput = false;
      const first = JSON.parse(await turn(list("scheduler")));
      assertEquals(
        first.goals.map(({ scope }: { scope: string }) => scope),
        schedulerScopes.slice(0, 20),
      );
      assertEquals(first.nextAfterScope, schedulerScopes[19]);
      const second = JSON.parse(
        await turn(list("scheduler", first.nextAfterScope)),
      );
      assertEquals(
        second.goals.map(({ scope }: { scope: string }) => scope),
        schedulerScopes.slice(20),
      );
      assertEquals(second.nextAfterScope, null);
      const delegatedList = JSON.parse(await turn(list("delegated")));
      assertEquals(delegatedList, {
        goals: [{
          scope: "visible-delegated",
          goalPreview: "Review the next delegated release",
          policy: "operator",
          status: "open",
        }],
        nextAfterScope: null,
      });
      for (const role of roles) {
        await assertRejects(
          () => turn(status(role)),
          Error,
          "unavailable at this classification",
        );
        await assertRejects(
          () => turn(`/goal ${role} status unconfigured`),
          Error,
          "Unknown configured",
        );
      }
      taint = "INTERNAL";
      const decisions = [];
      for (const role of roles) {
        const visible = JSON.parse(await turn(list(role)));
        assertEquals(visible.goals[0], {
          scope: "same-name",
          goalPreview: "Verify release readiness",
          policy: "operator",
          status: "awaiting_confirmation",
        });
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
      scriptedRead = {
        role: "scheduler",
        action: "status",
        scope: "same-name",
      };
      denyModelHook = "PRE_TOOL_CALL";
      let calls = managedInvocations;
      await turn("Try to read the scheduled decision.");
      assertEquals(managedInvocations, calls);
      assertEquals(modelHooks.splice(0), ["PRE_TOOL_CALL"]);
      assert(!modelToolText.includes(decisions[0]));
      scriptedRead = {
        role: "scheduler",
        action: "status",
        scope: "same-name",
      };
      denyModelHook = "POST_TOOL_RESPONSE";
      await turn("Read the decision with the response gate active.");
      assertEquals(managedInvocations, ++calls);
      assertEquals(modelHooks.splice(0), [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
      ]);
      assert(!modelToolText.includes(decisions[0]));
      denyModelHook = undefined;
      scriptedRead = {
        role: "scheduler",
        action: "status",
        scope: "same-name",
      };
      downgradeModelPost = true;
      await turn(
        "Read while the owner classification changes at the policy hook.",
      );
      assert(!modelToolText.includes(decisions[0]));
      downgradeModelPost = false;
      taint = "INTERNAL";
      for (const [index, role] of roles.entries()) {
        scriptedRead = { role, action: "status", scope: "same-name" };
        await turn(`Read the ${role} decision.`);
        assert(offered.has("managed_goal_state"));
        const result = JSON.parse(modelToolText);
        assertEquals(result.scope, `${role}:same-name`);
        assertEquals(result.confirmation.decisionSha256, decisions[index]);
        assertEquals(result._classification, "INTERNAL");
      }
      scriptedRead = {
        role: "delegated",
        action: "confirm",
        scope: "same-name",
      };
      calls = managedInvocations;
      await turn("Try to confirm the goal through its read tool.");
      assertEquals(managedInvocations, calls);
      assert(modelToolText.startsWith("Error:"));
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
    assert(retention.ok && retention.value >= roles.length);
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
