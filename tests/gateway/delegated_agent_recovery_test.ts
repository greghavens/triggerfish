import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type ChannelId,
  createSession,
  restoreSession,
  type SessionId,
  updateTaint,
  type UserId,
} from "../../src/core/types/session.ts";
import type { Orchestrator } from "../../src/core/types/orchestrator.ts";
import type { OrchestratorFactory } from "../../src/scheduler/service_types.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import {
  type AgentRecoveryExecutor,
  runRecoverableAgentTurn,
} from "../../src/gateway/agent_recovery.ts";
import { buildSubagentFactory } from "../../src/gateway/startup/factory/subagent.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import {
  buildSendMessage,
  createSessionRegistry,
} from "../../src/gateway/startup/factory/team_session_registry.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const userId = "owner" as UserId;

function orchestratorWith(
  executeAgentTurn: Orchestrator["executeAgentTurn"],
): Orchestrator {
  return {
    executeAgentTurn,
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
}

Deno.test("Normal subagent factory reopens a trusted scoped execution without repeating its approved read", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "agent-recovery.db");
  const parent = createSession({ userId, channelId: "owner" as ChannelId });
  const childSessions: SessionId[] = [];
  const prompt = "Check the recorded defensive control.";
  let reads = 0;
  const run: AgentRecoveryExecutor = (id, orchestrator, options) =>
    runRecoverableAgentTurn(
      path,
      id,
      {
        version: "fixture-read:1",
        classification: () => "PUBLIC",
        projectCall: (call) =>
          call.name === "read_control" && call.args.target === "fixture"
            ? { target: "fixture" }
            : undefined,
        projectResult: (_call, result) =>
          result === "verified" ? result : undefined,
        authorize: (receipt) =>
          Promise.resolve(
            receipt.name === "read_control" &&
              receipt.args.target === "fixture",
          ),
      },
      orchestrator,
      options,
    );
  const createFactory = (
    failBeforeCheckpoint = false,
  ): OrchestratorFactory => ({
    create(channelId, options) {
      const sessionOptions = { userId, channelId: channelId as ChannelId };
      const session = options?.recoverySessionId
        ? restoreSession({ ...sessionOptions, id: options.recoverySessionId })
        : createSession(sessionOptions);
      childSessions.push(session.id);
      const orchestrator = orchestratorWith(async (turn) => {
        if (!turn.beforeToolBatch) {
          return {
            ok: true,
            value: { response: "ordinary", tokenUsage: usage },
          };
        }
        if (turn.resume) {
          assertEquals(turn.resume.history[0]?.content, prompt);
          assertEquals(
            turn.resume.history.find(({ role }) => role === "tool")?.content,
            "verified",
          );
          return {
            ok: true,
            value: { response: "Resumed review.", tokenUsage: usage },
          };
        }
        const call = {
          name: "read_control",
          id: "provider-call",
          args: { target: "fixture" },
        };
        await turn.beforeToolBatch(1, [call]);
        reads++;
        if (failBeforeCheckpoint) {
          return { ok: false, error: "Interrupted before commit." };
        }
        turn.toolPersistence?.projectResult(call, {
          text: "verified",
          blocked: false,
        });
        await turn.onToolBatchCheckpoint?.({
          history: [{ role: "user", content: prompt }],
          completedIterations: 1,
          tokenUsage: usage,
          nudgeCount: 0,
          eosRetries: 0,
          toolCallCounts: [],
        });
        return { ok: false, error: "Interrupted after checkpoint." };
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor: () => Promise.resolve(""),
        getSessionTaint: () => session.taint,
      });
    },
  });
  try {
    const trusted = {
      recovery: { executionId: "parent:1:0", parentSessionId: parent.id, run },
    };
    const executionId = crypto.randomUUID();
    const command = (task: string) =>
      `/recover-subagent ${executionId} ${task}`;
    const first = buildSubagentFactory(createFactory());
    const ownerCommand = buildOwnerSubagentRecoveryCommand(first, run);
    assertEquals(await ownerCommand("ordinary request", parent), undefined);
    assertStringIncludes(
      await ownerCommand("/recover-subagent bogus", parent) ?? "",
      "Usage",
    );
    const cancel = new AbortController();
    cancel.abort();
    assertEquals(
      await ownerCommand(command(prompt), parent, cancel.signal),
      "Operation cancelled by user.",
    );
    assertEquals(
      await buildOwnerSubagentRecoveryCommand(first)(command(prompt), parent),
      "Durable subagent execution is unavailable.",
    );
    assertStringIncludes(
      await ownerCommand(command(prompt), parent) ?? "",
      "Interrupted after checkpoint",
    );
    const recreated = buildSubagentFactory(createFactory());
    const replay = buildOwnerSubagentRecoveryCommand(recreated, run);
    assertStringIncludes(
      await replay(command("Changed request"), parent) ?? "",
      "scope changed",
    );
    assertEquals(
      await replay(command(prompt), parent),
      "Resumed review.",
    );
    assertStringIncludes(
      await replay(command(prompt), parent) ?? "",
      "already finished",
    );
    assertEquals(reads, 1);
    assertEquals(new Set(childSessions.slice(0, 4)).size, 1);

    const uncertain = {
      recovery: { ...trusted.recovery, executionId: "parent:1:1" },
    };
    const interrupted = buildSubagentFactory(createFactory(true));
    assertStringIncludes(
      await interrupted(prompt, undefined, uncertain),
      "Interrupted before commit",
    );
    assertStringIncludes(
      await recreated(prompt, undefined, uncertain),
      "uncertain outcome",
    );
    assertEquals(reads, 2);
    assert(childSessions[4] !== childSessions[0]);

    assertEquals(await recreated(prompt), "ordinary");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Trusted team delivery uses the admitted recipient and denies recovery for unavailable members", async () => {
  const registry = createSessionRegistry();
  const storage = createMemoryStorage();
  const sender = createSession({ userId, channelId: "sender" as ChannelId });
  const recipient = createSession({
    userId,
    channelId: "team-member" as ChannelId,
  });
  const ordinary = orchestratorWith(() =>
    Promise.resolve({
      ok: true,
      value: { response: "ordinary", tokenUsage: usage },
    })
  );
  registry.register(sender.id, ordinary, sender);
  registry.register(recipient.id, ordinary, recipient);
  const manager = {} as EnhancedSessionManager;
  const deliver = buildSendMessage(registry, manager, storage);
  const ids: string[] = [];
  const recovering: AgentRecoveryExecutor = async (
    id,
    orchestrator,
    options,
  ) => {
    ids.push(id);
    assertEquals(options.session.id, recipient.id);
    return await orchestrator.executeAgentTurn(options);
  };
  try {
    const recovery = { deliveryId: "trusted-message", run: recovering };
    assert(
      (await deliver(sender.id, recipient.id, "exact message", recovery)).ok,
    );
    assert(
      (await deliver(sender.id, recipient.id, "exact message", recovery)).ok,
    );
    assertEquals(ids[0], ids[1]);
    registry.remove(recipient.id);
    const unavailable = await deliver(
      sender.id,
      recipient.id,
      "exact message",
      recovery,
    );
    assert(!unavailable.ok);
    assertStringIncludes(unavailable.error, "target is not active");
  } finally {
    await storage.close();
  }
});

Deno.test("Owner-authorized team delivery reattaches exact newly captured member context and resumes once", async () => {
  const directory = await Deno.makeTempDir();
  const storage = createMemoryStorage();
  const parent = createSession({ userId, channelId: "owner" as ChannelId });
  const other = createSession({
    userId,
    channelId: "other-owner" as ChannelId,
  });
  const memberCreations: {
    sessionId: SessionId;
    channelId: string;
    roster: string | undefined;
  }[] = [];
  const request = "Review the recorded control for this delivery.";
  let reads = 0;
  const recovery = {
    path: join(directory, "team-recovery.db"),
    profileBinding: "a".repeat(64),
    run: ((id, orchestrator, options) =>
      runRecoverableAgentTurn(
        join(directory, "agent-recovery.db"),
        id,
        {
          version: "team-read:1",
          classification: () => "PUBLIC",
          projectCall: (call) => call.name === "read_control" ? {} : undefined,
          projectResult: (_call, result) =>
            result === "verified" ? result : undefined,
          authorize: () => Promise.resolve(true),
        },
        orchestrator,
        options,
      )) satisfies AgentRecoveryExecutor,
  };
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      const sessionInput = { userId, channelId: channelId as ChannelId };
      let session = options?.recoverySessionId
        ? restoreSession({ ...sessionInput, id: options.recoverySessionId })
        : createSession(sessionInput);
      if (options?.recoverySessionTaint !== undefined) {
        session = updateTaint(
          session,
          options.recoverySessionTaint,
          "Restore test team scope",
        );
      }
      memberCreations.push({
        sessionId: session.id,
        channelId,
        roster: options?.systemPromptSections?.[0],
      });
      const orchestrator = orchestratorWith(async (turn) => {
        if (!turn.beforeToolBatch) {
          return {
            ok: true,
            value: { response: "Initial team turn.", tokenUsage: usage },
          };
        }
        if (turn.resume) {
          assertEquals(turn.resume.history[0]?.content, request);
          assertEquals(
            turn.resume.history.find(({ role }) => role === "tool")?.content,
            "verified",
          );
          return {
            ok: true,
            value: { response: "Team review resumed.", tokenUsage: usage },
          };
        }
        const tool = { name: "read_control", id: "team-tool", args: {} };
        await turn.beforeToolBatch(1, [tool]);
        reads++;
        turn.toolPersistence?.projectResult(tool, {
          text: "verified",
          blocked: false,
        });
        await turn.onToolBatchCheckpoint?.({
          history: [{ role: "user", content: request }],
          completedIterations: 1,
          tokenUsage: usage,
          nudgeCount: 0,
          eosRetries: 0,
          toolCallCounts: [],
        });
        return { ok: false, error: "Interrupted after checkpoint." };
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor: () => Promise.resolve(""),
        getSessionTaint: () => session.taint,
      });
    },
  };
  const sessionManager = {
    get: (id: SessionId) => Promise.resolve(id === parent.id ? parent : null),
  } as unknown as EnhancedSessionManager;
  const make = (settings = recovery) =>
    buildTeamManager({
      storage,
      orchestratorFactory: factory,
      callerSessionId: parent.id,
      sessionManager,
      recovery: settings,
    });
  try {
    const first = make();
    const definition = {
      name: "Defensive review",
      task: "Review the control inventory.",
      members: [{
        role: "lead",
        description: "Review the controls.",
        isLead: true,
        classificationCeiling: "PUBLIC" as const,
      }],
    };
    const created = await first.createTeam(definition, parent.id);
    assert(created.ok);
    first.stopLifecycleMonitor(created.value.id);
    const [member] = created.value.members;
    const deliveryId = crypto.randomUUID();
    const command = (text = request) =>
      `/recover-team ${deliveryId} ${created.value.id} ${member.sessionId} ${text}`;
    assertStringIncludes(
      await first.runRecoveryCommand!(command(), other) ?? "",
      "not available",
    );
    assertStringIncludes(
      await first.runRecoveryCommand!(
        command(),
        parent,
        undefined,
        "INTERNAL",
      ) ?? "",
      "Interrupted after checkpoint",
    );
    assertEquals(reads, 1);
    assert(
      !new TextDecoder().decode(await Deno.readFile(recovery.path)).includes(
        request,
      ),
    );

    const recreated = make();
    assertStringIncludes(
      await recreated.runRecoveryCommand!(
        command("Changed request"),
        parent,
        undefined,
        "INTERNAL",
      ) ?? "",
      "scope or request changed",
    );
    assertStringIncludes(
      await make({ ...recovery, profileBinding: "b".repeat(64) })
        .runRecoveryCommand!(command(), parent, undefined, "INTERNAL") ?? "",
      "not available",
    );
    assertEquals(
      await recreated.runRecoveryCommand!(
        command(),
        parent,
        undefined,
        "INTERNAL",
      ),
      "Team delivery completed.",
    );
    assertEquals(memberCreations[0], memberCreations[1]);
    assertStringIncludes(
      await recreated.runRecoveryCommand!(
        command(),
        parent,
        undefined,
        "INTERNAL",
      ) ?? "",
      "already finished",
    );
    assertEquals(reads, 1);

    const key = `team:${created.value.id}`;
    const stored = JSON.parse((await storage.get(key))!);
    await storage.set(key, JSON.stringify({ ...stored, status: "disbanded" }));
    assertStringIncludes(
      await make().runRecoveryCommand!(command(), parent) ?? "",
      "not available",
    );
    const legacy = buildTeamManager({
      storage,
      orchestratorFactory: factory,
      callerSessionId: parent.id,
      sessionManager,
    });
    const old = await legacy.createTeam(definition, parent.id);
    assert(old.ok);
    legacy.stopLifecycleMonitor(old.value.id);
    assertStringIncludes(
      await make().runRecoveryCommand!(
        `/recover-team ${crypto.randomUUID()} ${old.value.id} ${
          old.value.members[0].sessionId
        } ${request}`,
        parent,
      ) ?? "",
      "not available",
    );
    assertEquals(reads, 1);
  } finally {
    await storage.close();
    await Deno.remove(directory, { recursive: true });
  }
});
