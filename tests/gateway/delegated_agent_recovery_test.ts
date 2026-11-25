import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createOrchestrator } from "../../src/agent/orchestrator/orchestrator.ts";
import { openExecutionTraces } from "../../src/core/execution_traces.ts";
import { AgentRecoveryStore } from "../../src/core/agent_recovery_store.ts";
import { computeContentHash } from "../../src/core/session/lineage_serde.ts";
import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import { createHookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
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
import { delegatedSubagentIdentity } from "../../src/gateway/startup/factory/delegated_agent_recovery.ts";
import { buildOwnerSubagentRecoveryCommand } from "../../src/gateway/startup/factory/owner_subagent_recovery.ts";
import { createWorkflowRecoveryPolicy } from "../../src/gateway/workflow_recovery_policy.ts";
import {
  buildSendMessage,
  createSessionRegistry,
} from "../../src/gateway/startup/factory/team_session_registry.ts";
import type { EnhancedSessionManager } from "../../src/gateway/sessions.ts";
import { buildTeamManager } from "../../src/gateway/startup/factory/team_executor.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const userId = "owner" as UserId;

Deno.test("Delegated recovery reuses approved Actions history", () =>
  checkDelegatedStatusRecovery("actions"));
Deno.test("Delegated recovery retains the exact workflow run and attempt in execution history", () =>
  checkDelegatedStatusRecovery("exact_run"));
Deno.test("Delegated recovery reuses approved repository metadata history", () =>
  checkDelegatedStatusRecovery("repository"));

Deno.test("Delegated GitHub pull status recovers its typed projection without a repeated read", () =>
  checkDelegatedStatusRecovery("pull"));

Deno.test("Delegated GitHub release status replays published metadata only", () =>
  checkDelegatedStatusRecovery("release"));

Deno.test("Delegated branch protection replays only explicitly approved branch identities", () =>
  checkDelegatedStatusRecovery("branch"));

async function checkDelegatedStatusRecovery(
  family:
    | "actions"
    | "exact_run"
    | "repository"
    | "pull"
    | "release"
    | "branch",
) {
  const exactRun = family === "exact_run";
  const metadata = family === "repository";
  const pull = family === "pull";
  const release = family === "release";
  const branch = family === "branch";
  const directory = await Deno.makeTempDir();
  const recoveryPath = join(directory, "agent-recovery.db");
  const restoredPath = join(directory, "restored-recovery.db");
  const tracePath = join(directory, "execution-traces.db");
  const parent = createSession({ userId, channelId: "owner" as ChannelId });
  const prompt = "Review the approved Actions result.";
  const rawSecret = "synthetic-connector-secret-47f375a8";
  const runs = [{
    id: 1234,
    status: "completed",
    conclusion: "success",
    created_at: "2025-01-01T00:00:00.000Z",
  }];
  const repo = "acme/security";
  const workflow = "build.yml";
  const tool = pull
    ? "github_pulls"
    : metadata || release || branch
    ? "github_repos"
    : "github_actions";
  const args = branch
    ? { action: "list_branches", repo, per_page: 10 }
    : release
    ? { action: "list_releases", repo, per_page: 10 }
    : pull
    ? { action: "get", repo, pr_number: 12 }
    : metadata
    ? { action: "get", repo }
    : exactRun
    ? { action: "get_run", repo, run_id: 42, attempt: 2 }
    : { action: "list_runs", repo, workflow, per_page: 10 };
  const pullResult = {
    number: 12,
    repositoryId: 72451,
    state: "open",
    mergeable: null,
  } as const;
  const releaseResult = {
    repositoryId: 72451,
    releases: [{
      id: 21,
      prerelease: false,
      published_at: "2025-01-01T00:00:00Z",
    }],
  };
  const branchResult = {
    repositoryId: 72451,
    protectedCount: 1,
    unprotectedCount: 1,
    approvedBranches: [{ name: "main", protected: true }],
  };
  const exactResult = {
    id: 42,
    repositoryId: 72451,
    attempt: 2,
    status: "completed",
    conclusion: "cancelled",
  };
  const result = branch
    ? branchResult
    : release
    ? releaseResult
    : pull
    ? pullResult
    : metadata
    ? { name: repo, repositoryId: 72451, visibility: "private" }
    : exactRun
    ? exactResult
    : { runs, repositoryId: 72451 };
  const authorized: string[] = [];
  const received: string[] = [];
  let reads = 0;
  let interrupt = true;
  let permitted = true;
  let currentRepositoryId = 72451;
  let retainBranchNames = true;
  const policy = () =>
    createWorkflowRecoveryPolicy({
      repositories: [repo],
      runStatus: exactRun,
      repositoryStatus: metadata,
      pullStatus: pull,
      releaseStatus: release,
      branchProtection: branch,
      branchNames: branch && retainBranchNames
        ? { [repo]: ["main"] }
        : undefined,
      classification: () => "INTERNAL",
      authorizeRepository: (
        name,
        classification,
        workflowId,
        repositoryId,
        metadataOnly,
        pullAccess,
        contentsProbe,
      ) => {
        authorized.push(JSON.stringify([name, classification, workflowId]));
        return Promise.resolve(
          permitted && name === repo &&
            workflowId ===
              (metadata || pull || release || branch || exactRun
                ? undefined
                : workflow) &&
            metadataOnly === metadata && pullAccess === pull &&
            contentsProbe ===
              (release ? "branches" : branch ? "commits" : undefined) &&
            repositoryId === currentRepositoryId,
        );
      },
    });
  let currentRecoveryPath = recoveryPath;
  const run: AgentRecoveryExecutor = (id, orchestrator, options, control) =>
    runRecoverableAgentTurn(
      currentRecoveryPath,
      id,
      policy(),
      orchestrator,
      options,
      control,
    );
  const factory: OrchestratorFactory = {
    create(channelId, options) {
      const session = restoreSession({
        id: options!.recoverySessionId!,
        userId,
        channelId: channelId as ChannelId,
      });
      let taint: ClassificationLevel = "PUBLIC";
      const providerRegistry = createProviderRegistry();
      providerRegistry.register({
        name: "delegated-recovery-fixture",
        supportsStreaming: false,
        complete(messages) {
          const response = messages.findLast(({ role }) => role === "tool");
          if (response) {
            received.push(String(response.content));
            if (interrupt) {
              throw new Error("Fixture model unavailable after tool batch.");
            }
            return Promise.resolve({
              content: "Approved status reviewed.",
              toolCalls: [],
              usage,
            });
          }
          return Promise.resolve({
            content: "",
            toolCalls: [{
              id: "fixture-approved-call",
              type: "function",
              function: {
                name: tool,
                arguments: JSON.stringify(args),
              },
            }],
            usage,
          });
        },
      });
      providerRegistry.setDefault("delegated-recovery-fixture");
      const toolExecutor = (name: string) => {
        assertEquals(name, tool);
        reads++;
        return Promise.resolve(JSON.stringify({
          _classification: "INTERNAL",
          ...result,
          ...(tool === "github_actions" && {
            runs: runs.map((run) => ({
              ...run,
              created_at: run.created_at.replace(".000Z", "Z"),
            })),
          }),
          ...(branch && {
            branches: [
              { name: "main", protected: true },
              { name: rawSecret, protected: false },
            ],
          }),
          ...(release && {
            releases: [
              { ...releaseResult.releases[0], draft: false, body: rawSecret },
              { ...releaseResult.releases[0], id: 22, draft: true },
            ],
          }),
          rawCredential: rawSecret,
        }));
      };
      const getSessionTaint = () => taint;
      const orchestrator = createOrchestrator({
        providerRegistry,
        hookRunner: createHookRunner(createPolicyEngine()),
        enableStreaming: false,
        tools: [{
          name: tool,
          description: "Approved status",
          parameters: {},
        }],
        toolExecutor,
        getSessionTaint,
        escalateTaint: (level) => {
          taint = level;
        },
      });
      return Promise.resolve({
        orchestrator,
        session,
        toolExecutor,
        getSessionTaint,
      });
    },
  };
  try {
    const executionId = crypto.randomUUID();
    const command = `/recover-subagent ${executionId} ${prompt}`;
    const ownerCommand = () =>
      buildOwnerSubagentRecoveryCommand(
        buildSubagentFactory(factory, { executionTracePath: tracePath }),
        run,
      );
    const first = await ownerCommand()(
      command,
      parent,
      undefined,
      "INTERNAL",
    );
    assertEquals(first, "Durable subagent execution failed.");
    assertEquals(reads, 1);
    const identity = await delegatedSubagentIdentity(parent.id, executionId);
    const key = await computeContentHash(
      JSON.stringify([identity.sessionId, identity.executionId]),
    );
    const original = new AgentRecoveryStore(recoveryPath);
    const restored = new AgentRecoveryStore(restoredPath);
    try {
      const record = original.read(key);
      assert(record?.status === "ready" && record.checkpoint);
      assert(restored.restorePaused(record));
      assertEquals(restored.read(key)?.status, "paused");
      assertEquals(restored.restorePaused(record), false);
      assertEquals(restored.beginBatch(key, record.binding, 2, 1), false);
    } finally {
      restored.close();
      original.close();
    }
    currentRecoveryPath = restoredPath;
    interrupt = false;
    assertStringIncludes(
      (await ownerCommand()(command, parent, undefined, "INTERNAL")) ?? "",
      "paused",
    );
    const resume = `/recover-subagent --resume-paused ${executionId} ${prompt}`;
    assertStringIncludes(
      (await ownerCommand()(
        `${resume} Different request.`,
        parent,
        undefined,
        "INTERNAL",
      )) ?? "",
      "scope changed",
    );
    if (branch) {
      retainBranchNames = false;
      assertStringIncludes(
        (await ownerCommand()(resume, parent, undefined, "INTERNAL")) ?? "",
        "no longer authorized",
      );
      assertEquals(reads, 1);
      retainBranchNames = true;
    }
    permitted = false;
    assertStringIncludes(
      (await ownerCommand()(resume, parent, undefined, "INTERNAL")) ?? "",
      "no longer authorized",
    );
    const pausedAfterDenial = new AgentRecoveryStore(restoredPath);
    try {
      assertEquals(pausedAfterDenial.read(key)?.status, "paused");
    } finally {
      pausedAfterDenial.close();
    }
    permitted = true;
    currentRepositoryId++;
    assertStringIncludes(
      (await ownerCommand()(resume, parent, undefined, "INTERNAL")) ?? "",
      "no longer authorized",
    );
    assertEquals(reads, 1);
    currentRepositoryId--;
    assertEquals(
      await ownerCommand()(resume, parent, undefined, "INTERNAL"),
      "Approved status reviewed.",
    );
    assertEquals(reads, 1);
    assertEquals(
      authorized,
      Array(3).fill(
        JSON.stringify([
          repo,
          "INTERNAL",
          metadata || pull || release || branch || exactRun
            ? undefined
            : workflow,
        ]),
      ),
    );
    assertEquals(
      received,
      Array(2).fill(JSON.stringify(result)),
    );

    const trace = openExecutionTraces(tracePath);
    try {
      const records =
        trace.listRuns({ role: "delegated", ceiling: "INTERNAL" })?.runs ??
          [];
      assertEquals(records.length, 1);
      const [record] = records;
      assertEquals(record.scope.sourceId, parent.id);
      assertEquals(record.status, "completed");
      const steps = trace.list(record.scope, { ceiling: "INTERNAL" })?.steps ??
        [];
      assertEquals(steps.map(({ tool, outcome }) => ({ tool, outcome })), [
        { tool, outcome: "returned" },
      ]);
      assertEquals(
        trace.readApprovedPayload(record.scope, 1, "PUBLIC"),
        undefined,
      );
      assertEquals(
        trace.readApprovedPayload(record.scope, 1, "INTERNAL"),
        branch
          ? {
            kind: "github_branch_protection",
            repo,
            perPage: 10,
            ...branchResult,
          }
          : release
          ? {
            kind: "github_release_status",
            repo,
            perPage: 10,
            ...releaseResult,
          }
          : pull
          ? { kind: "github_pull_status", repo, ...pullResult }
          : metadata
          ? {
            kind: "github_repository_status",
            repo,
            repositoryId: 72451,
            visibility: "private",
          }
          : exactRun
          ? {
            kind: "github_actions_run_status",
            repo,
            ...exactResult,
          }
          : {
            kind: "github_actions_status",
            repo,
            repositoryId: 72451,
            workflow,
            perPage: 10,
            runs,
          },
      );
      assert(!JSON.stringify(steps).includes(repo));
    } finally {
      trace.close();
    }
    for (const path of [tracePath, recoveryPath, restoredPath]) {
      assert(
        !new TextDecoder().decode(await Deno.readFile(path)).includes(
          rawSecret,
        ),
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

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
  const tracePath = join(directory, "execution-traces.db");
  const parent = createSession({ userId, channelId: "owner" as ChannelId });
  const childSessions: SessionId[] = [];
  const prompt = "Check the recorded defensive control.";
  let reads = 0;
  const run: AgentRecoveryExecutor = (id, orchestrator, options, control) =>
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
      control,
    );
  const createFactory = (
    failBeforeCheckpoint = false,
    beforeCommit?: () => Promise<void>,
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
        await beforeCommit?.();
        try {
          await turn.onToolBatchCheckpoint?.({
            history: [{ role: "user", content: prompt }],
            completedIterations: 1,
            tokenUsage: usage,
            nudgeCount: 0,
            eosRetries: 0,
            toolCallCounts: [],
          });
        } catch {
          return { ok: false, error: "Checkpoint boundary interrupted." };
        }
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

    const operatorExecutionId = crypto.randomUUID();
    const traced = () =>
      buildSubagentFactory(createFactory(), {
        executionTracePath: tracePath,
      });
    assertStringIncludes(
      await buildOwnerSubagentRecoveryCommand(traced(), run)(
        `/recover-subagent ${operatorExecutionId} ${prompt}`,
        parent,
        undefined,
        "INTERNAL",
      ) ?? "",
      "Interrupted after checkpoint",
    );
    assertEquals(reads, 3);
    const identity = await delegatedSubagentIdentity(
      parent.id,
      operatorExecutionId,
    );
    const pausedKey = await computeContentHash(
      JSON.stringify([identity.sessionId, identity.executionId]),
    );
    const orphaned = new AgentRecoveryStore(path);
    try {
      const saved = orphaned.read(pausedKey);
      assert(saved?.status === "ready" && saved.checkpoint);
      assert(orphaned.beginBatch(pausedKey, saved.binding, 2, 1, true));
      assert(orphaned.requestPause(pausedKey));
      assertEquals(orphaned.read(pausedKey)?.status, "pending");
    } finally {
      orphaned.close();
    }
    const ref = { kind: "delegated", id: identity.executionId };
    const providerRegistry = createProviderRegistry();
    let call: Record<string, unknown> | undefined;
    let result = "";
    providerRegistry.register({
      name: "owner-delegated-resume-fixture",
      supportsStreaming: false,
      complete(messages) {
        const next = call;
        call = undefined;
        if (!next) {
          result = String(
            messages.findLast(({ role }) => role === "tool")?.content,
          );
        }
        return Promise.resolve({
          usage,
          content: next ? "" : "Checked delegated run.",
          toolCalls: next
            ? [{
              type: "function",
              id: crypto.randomUUID(),
              function: {
                name: "operator_runs",
                arguments: JSON.stringify(next),
              },
            }]
            : [],
        });
      },
    });
    providerRegistry.setDefault("owner-delegated-resume-fixture");
    const chat = () =>
      createChatSession({
        session: parent,
        targetClassification: "INTERNAL",
        providerRegistry,
        enableStreaming: false,
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
          baseDir: directory,
          confirm: () => Promise.resolve(true),
        }),
        runSubagentRecoveryCommand: buildOwnerSubagentRecoveryCommand(
          traced(),
          run,
        ),
      });
    const turn = async (
      chat: ReturnType<typeof createChatSession>,
      args: Record<string, unknown>,
    ) => {
      call = args;
      result = "";
      await chat.executeAgentTurn("Control the delegated run.", () => {});
      return result;
    };
    assertEquals(
      JSON.parse(await turn(chat(), { ...ref, action: "pause" })).run.status,
      "paused",
    );
    const restarted = chat();
    const resume = {
      ...ref,
      action: "resume",
      executionId: operatorExecutionId,
      originalTask: prompt,
    };
    assertStringIncludes(
      await turn(restarted, { ...resume, originalTask: "Changed request" }),
      "unavailable",
    );
    assertStringIncludes(
      await turn(restarted, { ...resume, executionId: crypto.randomUUID() }),
      "unavailable",
    );
    assertEquals(
      JSON.parse(await turn(restarted, { ...ref, action: "inspect" })).run
        .status,
      "paused",
    );
    assertEquals(
      JSON.parse(await turn(restarted, resume)).run.status,
      "completed",
    );
    assertStringIncludes(await turn(restarted, resume), "unavailable");
    const activeId = crypto.randomUUID();
    const activeIdentity = await delegatedSubagentIdentity(parent.id, activeId);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = buildOwnerSubagentRecoveryCommand(
      buildSubagentFactory(
        createFactory(false, () => {
          entered.resolve();
          return release.promise;
        }),
        { executionTracePath: tracePath },
      ),
      run,
    )(`/recover-subagent ${activeId} ${prompt}`, parent, undefined, "INTERNAL");
    const activeRef = { kind: "delegated", id: activeIdentity.executionId };
    try {
      await entered.promise;
      const requested = JSON.parse(
        await turn(restarted, { ...activeRef, action: "pause" }),
      );
      assertEquals(requested.pauseRequested, true);
      assertEquals(requested.run.status, "running");
    } finally {
      release.resolve();
      await active;
    }
    assertEquals(
      JSON.parse(await turn(restarted, { ...activeRef, action: "inspect" })).run
        .status,
      "paused",
    );
    assertEquals(
      JSON.parse(
        await turn(restarted, {
          ...activeRef,
          action: "resume",
          executionId: activeId,
          originalTask: prompt,
        }),
      ).run.status,
      "completed",
    );
    assertEquals(reads, 4);
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
