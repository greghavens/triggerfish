import { authorizeManagedTranscript } from "../../src/gateway/startup/factory/managed_transcript_authorization.ts";
import {
  buildTeamToolDefinitions,
  createTeamToolExecutor,
} from "../../src/agent/team/tools.ts";
import type { TeamId } from "../../src/agent/team/types.ts";
import type { SessionId } from "../../src/core/types/session.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { join } from "@std/path";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { buildAgentInlineDefinitions } from "../../src/gateway/tools/defs/agent_tool_defs.ts";
import { dispatchSubagentTask } from "../../src/gateway/tools/executor/executor_handlers.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import type { TriggerFishConfig } from "../../src/core/config_types.ts";
import { createOrchestratorFactory } from "../../src/gateway/startup/factory/orchestrator_factory.ts";

Deno.test("Production factory binds delegated agents to their own tool profile", async () => {
  const dir = await Deno.makeTempDir();
  const calls: { tools: string[]; reply?: string }[] = [];
  let requestedTool = "cron";
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response(null, { status: 404 });
    }
    const body = await request.json();
    const reply = calls.length
      ? body.messages.findLast(
        ({ role }: { role: string }) => role === "tool",
      )?.content
      : undefined;
    const tools = body.tools.map(
      ({ function: { name } }: { function: { name: string } }) => name,
    );
    calls.push({ tools, reply });
    const message = reply
      ? { role: "assistant", content: "Role review complete." }
      : {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "role-check",
          type: "function",
          function: {
            name: requestedTool,
            arguments: requestedTool === "cron" ? '{"action":"list"}' : "{}",
          },
        }],
      };
    if (body.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{ message }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  const localProvider = {
    model: "role-fixture",
    endpoint: `http://127.0.0.1:${server.addr.port}`,
  };
  const config = {
    models: {
      primary: { provider: "ollama", model: "role-fixture" },
      providers: { ollama: localProvider },
    },
    channels: {},
    classification: { mode: "strict" },
  } satisfies TriggerFishConfig;
  const storage = createMemoryStorage();
  try {
    const factory = createOrchestratorFactory(
      config,
      dir,
      undefined,
      storage,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        google: false,
        github: false,
        caldav: false,
        notion: false,
        x: false,
        obsidian: false,
        signal: false,
        telegram: false,
        discord: false,
        whatsapp: false,
      },
    );
    for (const role of ["subagent", "team", "scheduled"] as const) {
      calls.length = 0;
      requestedTool = "cron";
      const { orchestrator, session } = await factory.create(
        role,
        role === "scheduled" ? {} : { delegatedKind: role },
      );
      const result = await orchestrator.executeAgentTurn({
        session,
        message: "Review the current task role.",
        targetClassification: "INTERNAL",
      });
      assert(result.ok, JSON.stringify(result));
      assertEquals(calls[0].tools.includes("cron"), role === "scheduled");
      assert(calls[0].tools.includes("todo_read"));
      assertEquals(calls.length, 2);
      if (role !== "scheduled") {
        assertStringIncludes(
          calls[1].reply ?? "",
          "outside the delegated role",
        );
      }
      calls.length = 0;
      requestedTool = "todo_read";
      orchestrator.clearHistory(session.id);
      const checklist = await orchestrator.executeAgentTurn({
        session,
        message: "Read the current checklist.",
        targetClassification: "INTERNAL",
      });
      assert(checklist.ok, JSON.stringify(checklist));
      assertStringIncludes(calls[1].reply ?? "", "No todos.");
    }
  } finally {
    await storage.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

async function testDelegatedGoalReport(
  requiresApproval: boolean,
  role: "subagent" | "team" = "subagent",
) {
  const dir = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const expected =
    "No todos. Use todo_write to create your task list. Revision: empty";
  const criterion = role === "team" ? "team" : "child";
  const otherCriterion = role === "team" ? "child" : "team";
  const reviewed = Promise.withResolvers<string>();
  const finish = Promise.withResolvers<void>();
  const report = (criterion: string) => ({
    name: "delegated_goal_report",
    arguments: JSON.stringify({ scope: "review", criterion }),
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    if (new URL(request.url).pathname !== "/v1/chat/completions") {
      return new Response(null, { status: 404 });
    }
    const body = await request.json();
    const tools = (body.tools ?? []).map((
      { function: { name } }: { function: { name: string } },
    ) => name);
    assert(tools.includes("delegated_goal_report"));
    assert(tools.includes("background_goal_state"));
    const prior = body.messages.filter(({ role }: { role: string }) =>
      role === "tool"
    ).map(({ content }: { content: string }) => content);
    let call: { name: string; arguments: string } | undefined;
    if (!prior.length) call = report(criterion);
    else if (prior.length === 1) {
      assertStringIncludes(
        prior[0],
        requiresApproval ? "approval" : "unavailable",
      );
      call = { name: "todo_read", arguments: "{}" };
    } else if (prior.length === 2) {
      assertEquals(prior[1], expected);
      call = report(otherCriterion);
    } else if (prior.length === 3) {
      assertStringIncludes(
        prior[2],
        requiresApproval ? "approval" : "unavailable",
      );
      call = report(role === "team" ? "wrong-result" : criterion);
    } else if (role === "team" && prior.length === 4) {
      assertStringIncludes(
        prior[3],
        requiresApproval ? "approval" : "unavailable",
      );
      call = report(criterion);
    } else if (prior.length === (role === "team" ? 5 : 4)) {
      call = {
        name: "background_goal_state",
        arguments: JSON.stringify({ scope: "review" }),
      };
    } else {
      const response = prior.at(-2)!;
      const status = JSON.parse(prior.at(-1)!);
      assertEquals(status.satisfied, requiresApproval ? [] : [criterion]);
      assertEquals(status.open, [
        ...(requiresApproval ? [criterion] : []),
        ...(role === "team" ? ["wrong-result"] : []),
      ]);
      assertEquals(status._classification, "PUBLIC");
      if (!requiresApproval) {
        assertEquals(
          status.criteria[0].evidence.reference,
          JSON.parse(response).evidenceReference,
        );
      }
      reviewed.resolve(response);
      await finish.promise;
    }
    const message = call
      ? {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: call,
        }],
      }
      : { role: "assistant", content: "Public delegated review finished." };
    if (body.stream) {
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      choices: [{ message }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  try {
    const resultSha256 = await computeContentHash(expected);
    const provider = {
      model: "report-fixture",
      endpoint: `http://127.0.0.1:${server.addr.port}`,
    };
    const config: TriggerFishConfig = {
      models: {
        primary: { provider: "ollama", model: "report-fixture" },
        providers: { ollama: provider },
      },
      channels: {},
      classification: { mode: "strict" },
      ...(requiresApproval && { tool_approval: ["delegated_goal_report"] }),
      delegated_goal_completion: [{
        scope: "review",
        goal: "Complete two independent reports.",
        policy: "operator",
        criteria: [
          ...(["subagent", "team"] as const).map((kind) => ({
            id: kind === "subagent" ? "child" : "team",
            description: "Verify the classified checklist result.",
            kind,
            tool: "todo_read",
            result_sha256: resultSha256,
          })),
          ...(role === "team"
            ? [{
              id: "wrong-result",
              description:
                "Only an explicitly different committed result can satisfy this criterion.",
              kind: "team" as const,
              tool: "todo_read",
              result_sha256: "0".repeat(64),
            }]
            : []),
        ],
      }],
    };
    const factory = createOrchestratorFactory(config, dir, undefined, storage);
    const owner = createSession({
      userId: "owner" as UserId,
      channelId: "owner" as ChannelId,
    });
    const team = role === "team"
      ? buildTeamManager({
        storage,
        orchestratorFactory: factory,
        callerSessionId: owner.id,
        sessionManager: {
          get: (id: SessionId) =>
            Promise.resolve(id === owner.id ? owner : null),
        } as unknown as EnhancedSessionManager,
        recovery: {
          path: join(dir, "team-recovery.db"),
          profileBinding: "a".repeat(64),
        },
      })
      : undefined;
    const executeTeam = team && createTeamToolExecutor({
      teamManager: team,
      callerSessionId: owner.id,
      getCallerTaint: () => "PUBLIC",
    });
    let teamId: TeamId | undefined;
    const task = "Review and report the current goal evidence.";
    const agentCall = role === "team"
      ? {
        name: "team_create",
        arguments: JSON.stringify({
          name: "Delegated review",
          task,
          members: [{
            role: "reviewer",
            description: "Review the evidence.",
            is_lead: true,
            classification_ceiling: "PUBLIC",
            initial_task: task,
          }],
        }),
      }
      : { name: "subagent", arguments: JSON.stringify({ task }) };
    const registry = createProviderRegistry();
    registry.register({
      name: "owner-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (result && team) {
          teamId = JSON.parse(String(result.content)).team_id;
          assert(teamId);
          team.stopLifecycleMonitor(teamId);
        }
        return Promise.resolve({
          content: result ? String(result.content) : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: result ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: agentCall,
          }],
        });
      },
    });
    registry.setDefault("owner-fixture");
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: owner,
        providerRegistry: registry,
        hookRunner: createHookRunner(createPolicyEngine()),
        tools:
          (team ? buildTeamToolDefinitions() : buildAgentInlineDefinitions())
            .filter(({ name }) => name === agentCall.name),
        async toolExecutor(name, args) {
          if (name === "subagent") {
            return await dispatchSubagentTask(
              args,
              buildSubagentFactory(factory),
            );
          }
          return await executeTeam?.(name, args) ?? "Unavailable";
        },
      }),
    });
    const { port } = await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const ended = Promise.withResolvers<void>();
    void ended.promise.catch(() => {});
    const inbox = createToolApprovalService(join(dir, "tool-approvals.db"));
    const denialTimer = requiresApproval
      ? setInterval(() => {
        for (const pending of inbox.list().records) {
          if (
            pending.tool === "delegated_goal_report" &&
            pending.status === "pending"
          ) {
            inbox.decide(pending.id, "denied");
          }
        }
      }, 5)
      : undefined;
    const timer = setTimeout(() => {
      const error = new Error("Delegated goal gateway did not finish");
      reviewed.reject(error);
      ended.reject(error);
    }, 4000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "message",
          content: "Delegate the goal review.",
        }),
      );
    socket.onmessage = ({ data }) => {
      if (JSON.parse(data).type === "turn_end") ended.resolve();
    };
    try {
      const response = await reviewed.promise;
      const observation = requiresApproval ? undefined : JSON.parse(response);
      if (requiresApproval) assertStringIncludes(response, "approval");
      else {
        assertEquals(observation.verified, true);
        assertEquals(observation._classification, "PUBLIC");
      }
      const fixturePolicy = {
        hookRunner: createHookRunner(createPolicyEngine()),
        providerRegistry: registry,
      };
      const proofAccess = {
        ownerSessionId: owner.id,
        current: () => true,
        reopen: () => Promise.resolve(""),
        authorizeTranscript: (
          source: string,
          row: Parameters<typeof authorizeManagedTranscript>[4],
        ) =>
          authorizeManagedTranscript(
            fixturePolicy,
            () => true,
            "PUBLIC",
            source,
            row,
          ),
      };
      const check = await factory.runDelegatedGoalCommand!(
        "/goal delegated status review",
        "PUBLIC",
        proofAccess,
      );
      const whileRunning = JSON.parse(check!);
      assertEquals(whileRunning.status, "open");
      assertEquals(whileRunning.satisfied, requiresApproval ? [] : [criterion]);
      assertEquals(
        whileRunning.open,
        [
          ...(requiresApproval ? ["child", "team"] : [otherCriterion]),
          ...(role === "team" ? ["wrong-result"] : []),
        ],
      );
      if (observation) {
        assertEquals(
          whileRunning.observations[0].evidence[0].reference,
          observation.evidenceReference,
        );
      }
      finish.resolve();
      await ended.promise;
      if (team && teamId) {
        const deadline = Date.now() + 2000;
        let settled = false;
        while (!settled && Date.now() < deadline) {
          const active = await team.fetchTeamStatus(teamId);
          settled = active.ok &&
            active.value.members[0].lastOutput ===
              "Public delegated review finished.";
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert(settled);
      }
      const reopened = createOrchestratorFactory(
        config,
        dir,
        undefined,
        storage,
      );
      const saved = JSON.parse(
        (await reopened.runDelegatedGoalCommand!(
          "/goal delegated status review",
          "PUBLIC",
          proofAccess,
        ))!,
      );
      if (requiresApproval) {
        // Normal post-turn reporting remains independent of the denied call.
        assertEquals(saved.satisfied, [criterion]);
      } else assertEquals(saved, whileRunning);
    } finally {
      finish.resolve();
      clearTimeout(timer);
      clearInterval(denialTimer);
      socket.close();
      await gateway.stop();
    }
  } finally {
    await storage.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Owner gateway subagent reports exact delegated goal evidence during its turn", () =>
  testDelegatedGoalReport(false));
Deno.test("Root policy can prevent an in-turn delegated goal report", () =>
  testDelegatedGoalReport(true));

Deno.test("Ordinary gateway team member reports only matching evidence with recovery registration enabled", () =>
  testDelegatedGoalReport(false, "team"));
Deno.test("Root policy can prevent an ordinary team member's in-turn goal report", () =>
  testDelegatedGoalReport(true, "team"));
