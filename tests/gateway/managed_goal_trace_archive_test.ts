import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createMessageStore } from "../../src/core/conversation/mod.ts";
import {
  executionTracePayloadResponse,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createMemorySecretStore } from "../../src/core/secrets/keychain/keychain.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildExecutionTracePayloadAuthorizer } from "../../src/gateway/startup/factory/agent_recovery.ts";
import { buildSchedulerGoalCompletion } from "../../src/gateway/startup/factory/scheduler_goal_completion.ts";
import { schedulerExecutionIdentity } from "../../src/scheduler/service_execution.ts";

Deno.test("Owner gateway cites a restored scheduled GitHub attempt for an exact managed goal", async () => {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const messages = createMessageStore(storage);
  try {
    const repo = "fixture-owner/fixture-project";
    const payload = {
      kind: "github_actions_run_status",
      repo,
      repositoryId: 9021,
      id: 2024,
      attempt: 3,
      status: "completed",
      conclusion: "success",
    } as const;
    const resultSha256 = await computeContentHash(
      executionTracePayloadResponse(payload),
    );
    const criterion = {
      id: "approved-attempt",
      description: "Match the exact approved release attempt",
      kind: "trigger",
      source_id: "trigger",
      tool: "github_actions",
      result_sha256: resultSha256,
    } as const;
    const scheduler = buildSchedulerGoalCompletion(
      {
        scheduler: {
          goal_completion: [
            {
              scope: "release",
              goal: "Verify the retained release attempt",
              policy: "operator",
              criteria: [criterion],
            },
            {
              scope: "wrong-result",
              goal: "Require a different result",
              policy: "operator",
              criteria: [{ ...criterion, result_sha256: "1".repeat(64) }],
            },
          ],
        },
      },
      directory,
      messages,
    );
    assert(scheduler);
    const tracePath = join(directory, "execution-traces.db");
    const saved = (sourceId: string) => {
      const repoTrace = openExecutionTraces(tracePath);
      try {
        const scope = {
          role: "scheduled",
          runId: schedulerExecutionIdentity("trigger", sourceId, "fixture").id,
          sourceId,
          sessionId: crypto.randomUUID(),
          classification: "INTERNAL",
        } as const;
        assert(repoTrace.admit(scope));
        const receipt = repoTrace.append(scope, {
          ordinal: 1,
          tool: "github_actions",
          outcome: "returned",
          classification: "INTERNAL",
        }, payload);
        assert(receipt);
        assert(repoTrace.finish(scope, "completed", "INTERNAL"));
        return receipt;
      } finally {
        repoTrace.close();
      }
    };
    const correct = saved("trigger");
    const wrong = saved("other-source");
    const keychain = createMemorySecretStore();
    assert((await keychain.setSecret("github-pat", "synthetic-goal-token")).ok);
    let permission = true;
    const probed: string[] = [];
    const checkFetch: typeof fetch = (url, options) => {
      const target = new URL(url.toString());
      assertEquals(target.origin, "https://api.github.com");
      assertEquals(options?.method ?? "GET", "GET");
      assertEquals(
        new Headers(options?.headers).get("authorization"),
        "Bearer synthetic-goal-token",
      );
      probed.push(target.pathname);
      if (target.pathname === `/repos/${repo}`) {
        return Promise.resolve(Response.json({
          id: payload.repositoryId,
          full_name: repo,
          visibility: "public",
        }));
      }
      assertEquals(target.pathname, `/repos/${repo}/actions/workflows`);
      return Promise.resolve(
        new Response("", { status: permission ? 200 : 403 }),
      );
    };
    const authorize = buildExecutionTracePayloadAuthorizer(
      {
        agent_recovery: {
          github_repositories: [repo],
          github_run_status: true,
        },
      },
      keychain,
      checkFetch,
    );
    assert(authorize);
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    const registry = createProviderRegistry();
    let operation: Record<string, unknown> | undefined;
    registry.register({
      name: "goal-trace-fixture",
      supportsStreaming: false,
      complete() {
        const read = operation;
        operation = undefined;
        return Promise.resolve({
          content: read ? "" : "Run control finished.",
          toolCalls: read
            ? [{
              id: crypto.randomUUID(),
              type: "function",
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(read),
              },
            }]
            : [],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    });
    registry.setDefault("goal-trace-fixture");
    let taint: ClassificationLevel = "INTERNAL";
    let deny: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | undefined;
    const sourceHooks: string[] = [];
    const withGateway = async <T>(
      run: (turn: (content: string) => Promise<string>) => Promise<T>,
    ): Promise<T> => {
      const hooks = createHookRunner(createPolicyEngine());
      const chat = createChatSession({
        session: owner,
        providerRegistry: registry,
        getSessionTaint: () => taint,
        targetClassification: "INTERNAL",
        goalCompletionPath: join(directory, "goal-completion.db"),
        messageStore: messages,
        tools: [{
          name: "github_actions",
          description: "Fixture GitHub Actions tool schema",
          parameters: {},
        }],
        hookRunner: {
          ...hooks,
          evaluateHook(hook, context) {
            if (
              (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE") &&
              context.input.tool_name === "github_actions"
            ) {
              sourceHooks.push(hook);
              assert(!Object.hasOwn(context.auditInput ?? {}, "tool_response"));
              if (deny === hook) {
                return Promise.resolve({
                  allowed: false,
                  action: "BLOCK",
                  ruleId: null,
                  duration: 0,
                });
              }
            }
            return hooks.evaluateHook(hook, context);
          },
        },
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir: directory,
          authorizeExecutionTracePayload: authorize,
          confirm: () => Promise.resolve(true),
        }),
        runManagedGoalCommand: scheduler.runCommand,
      });
      const token = crypto.randomUUID();
      const server = createGatewayServer({ port: 0, token, chatSession: chat });
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
          let toolResult: string | undefined;
          let error: string | undefined;
          const timer = setTimeout(
            () => done.reject(new Error("No turn_end")),
            3_000,
          );
          function receive({ data }: MessageEvent) {
            const event = JSON.parse(data);
            if (event.type === "response") response = event.text;
            if (event.type === "tool_result") toolResult = event.result;
            if (event.type === "error") error = event.message;
            if (event.type === "turn_end") {
              if (error) done.reject(new Error(error));
              else done.resolve(toolResult ?? response);
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
    const citation = (runId = correct.scope.runId, scope = "release") =>
      `/goal scheduler cite ${
        JSON.stringify({
          scope,
          criterion: criterion.id,
          runId,
          ordinal: correct.ordinal,
        })
      }`;
    const archiveId = crypto.randomUUID();
    await withGateway(async (turn) => {
      operation = {
        action: "archive",
        kind: "scheduled",
        id: correct.scope.runId,
        requestId: archiveId,
      };
      assertEquals(
        JSON.parse(await turn("Archive this completed scheduled run.")).receipt
          .status,
        "succeeded",
      );
      await assertRejects(
        () => turn(citation(wrong.scope.runId)),
        Error,
        "scheduled goal evidence is unavailable",
      );
    });
    await Deno.remove(tracePath);
    await withGateway(async (turn) => {
      await assertRejects(
        () => turn(citation()),
        Error,
        "scheduled goal evidence is unavailable",
      );
      operation = {
        action: "restore",
        kind: "scheduled",
        id: correct.scope.runId,
        archiveId,
        requestId: crypto.randomUUID(),
      };
      assertEquals(
        JSON.parse(await turn("Restore the exact saved scheduled run.")).receipt
          .status,
        "succeeded",
      );
      await assertRejects(
        () => turn(citation(correct.scope.runId, "wrong-result")),
        Error,
        "scheduled goal evidence is unavailable",
      );
      taint = "PUBLIC";
      await assertRejects(
        () => turn(citation()),
        Error,
        "scheduled goal evidence is unavailable",
      );
      taint = "INTERNAL";
      deny = "PRE_TOOL_CALL";
      const previousRequests = probed.length;
      await assertRejects(
        () => turn(citation()),
        Error,
        "scheduled goal evidence is unavailable",
      );
      assertEquals(probed.length, previousRequests);
      deny = undefined;
      const proof = JSON.parse(await turn(citation()));
      assertEquals(proof.status, "awaiting_confirmation");
      assertEquals(proof.observations[0].evidence[0], {
        source: "scheduler-trace:trigger:trigger",
        reference: `${correct.scope.runId}:1:${correct.id}`,
        detail: `trigger:trigger:github_actions:${resultSha256}`,
        classification: "INTERNAL",
      });
      assert(!JSON.stringify(proof).includes(repo));
      assertEquals(JSON.parse(await turn(citation())), proof);
      assertEquals(await messages.loadSession(correct.scope.sessionId), []);
      const confirm =
        `/goal scheduler confirm release ${proof.confirmation.decisionSha256}`;
      permission = false;
      await assertRejects(
        () => turn(confirm),
        Error,
        "evidence could not be reverified",
      );
      permission = true;
      deny = "POST_TOOL_RESPONSE";
      await assertRejects(
        () => turn(confirm),
        Error,
        "evidence could not be reverified",
      );
      deny = undefined;
      const result = JSON.parse(await turn(confirm));
      assertEquals(result.status, "completed");
      assertEquals(result.observations, proof.observations);
      assertEquals(JSON.parse(await turn(confirm)), result);
      assert(sourceHooks.includes("PRE_TOOL_CALL"));
      assert(sourceHooks.includes("POST_TOOL_RESPONSE"));
      assert(probed.length > previousRequests);
    });
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
