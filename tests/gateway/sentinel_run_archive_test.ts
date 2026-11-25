import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { readAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { adaptiveRevision } from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  applySentinelFormalGoals,
  readSentinelAssessment,
  readSentinelFindingReviews,
  recordSentinelFindingReview,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  digestSentinelGoalProposal,
  type SentinelFormalGoal,
} from "../../src/sentinel/formal_goals.ts";

async function withGateway(
  baseDir: string,
  run: (
    request: (args: Record<string, unknown>) => Promise<string>,
    approvals: string[],
    policy: { denyArchive: boolean },
  ) => Promise<void>,
) {
  const approvals: string[] = [];
  const policy = { denyArchive: false };
  const registry = createProviderRegistry();
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const call = input.tool_call as
        | { args?: { action?: string } }
        | undefined;
      const allowed = !(policy.denyArchive && hook === "PRE_TOOL_CALL" &&
        call?.args?.action === "archive");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  let next: Record<string, unknown> | undefined;
  let result = "";
  registry.register({
    name: "archive-fixture",
    supportsStreaming: false,
    complete(messages) {
      const args = next;
      next = undefined;
      if (!args) {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        content: args ? "" : "Finished archive request.",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: args
          ? [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(args),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("archive-fixture");
  const chatSession = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "archive-fixture" as ChannelId,
      bumpersEnabled: false,
    }),
    providerRegistry: registry,
    hookRunner: hooks,
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      confirm(text) {
        approvals.push(text);
        return Promise.resolve(true);
      },
    }),
  });
  const token = crypto.randomUUID();
  const server = createGatewayServer({ port: 0, token, chatSession });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((done, fail) => {
      socket.addEventListener("open", () => done(), { once: true });
      socket.addEventListener("error", fail, { once: true });
    });
    await run(
      (args) => {
        next = args;
        result = "";
        const done = Promise.withResolvers<string>();
        const timer = setTimeout(
          () => done.reject(new Error("No archive turn")),
          5000,
        );
        const onMessage = ({ data }: MessageEvent) => {
          if (JSON.parse(String(data)).type === "turn_end") {
            done.resolve(result);
          }
        };
        socket.addEventListener("message", onMessage);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Use the approved operator run action.",
          }),
        );
        return done.promise.finally(() => {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
        });
      },
      approvals,
      policy,
    );
  } finally {
    socket.close();
    await server.stop();
  }
}

Deno.test("authenticated Sentinel archive survives restart, restores paused, and preserves evidence and dependencies", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, "restorable");
  const evidenceId = "saved-log";
  const findingId = "missing-control";
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Service" },
          {
            id: findingId,
            kind: "finding",
            label: "Defensive gap",
            severity: "low",
          },
          {
            id: evidenceId,
            kind: "evidence",
            label: "Committed control evidence",
          },
        ],
        edges: [
          { from: evidenceId, to: findingId, relation: "supports" },
          { from: findingId, to: "app", relation: "affects" },
        ],
      }),
    );
    const goals: SentinelFormalGoal[] = [{
      id: "review-source",
      title: "Review source evidence",
      policy: "operator",
      criteria: [{
        id: "saved-log",
        description: "Review the saved control evidence.",
        source: "graph_evidence",
        reference: evidenceId,
      }],
    }];
    const { state } = applySentinelFormalGoals(path, {
      mode: "start",
      requestId: crypto.randomUUID(),
      proposalDigest: digestSentinelGoalProposal(goals),
      goals,
      plan: { goal: "Review source evidence" },
    });
    const revision = adaptiveRevision(state);
    assert(state.plan.runId);
    assert(
      recordSentinelFindingReview(
        path,
        state.revision,
        findingId,
        "confirmed",
        "Confirmed against saved control evidence.",
      ),
    );
    const decision = readSentinelFindingReviews(path, state.revision);
    const observation = {
      relatedNodeIds: [evidenceId, findingId],
      result: "Reviewed the retained record",
    };
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let sourceTaskId: string;
    let dependentId: string;
    try {
      const [source] = store.sync(
        revision,
        [{
          kind: "trace",
          nodeId: evidenceId,
          evidenceIds: [evidenceId],
        }],
        null,
        {
          number: state.revision,
          goal: { id: state.plan.runId, label: state.plan.goal! },
        },
      );
      const lease = store.claim(revision);
      assert(lease);
      assert(
        store.complete({
          taskId: source.id,
          leaseToken: lease.leaseToken,
          observation,
        }),
      );
      sourceTaskId = source.id;
      const dependent = store.sync(revision, [{
        kind: "review_finding",
        nodeId: findingId,
        prerequisites: [source.id],
        evidenceIds: [evidenceId],
      }], revision).find(({ nodeId }) => nodeId === findingId);
      assert(dependent);
      dependentId = dependent.id;
    } finally {
      store.close();
    }
    assert(stopSentinelAssessment(path));
    const exact = {
      kind: "sentinel",
      id: "restorable",
      revision: state.revision,
      runId: state.plan.runId,
    };
    const archiveId = crypto.randomUUID();
    const request = { action: "archive", ...exact, requestId: archiveId };
    const restore = {
      action: "restore",
      ...exact,
      archiveId,
      requestId: crypto.randomUUID(),
    };
    let archiveReceipt: unknown;
    await withGateway(baseDir, async (turn, approvals, policy) => {
      policy.denyArchive = true;
      assert((await turn(request)).length);
      assertEquals(approvals, []);
      policy.denyArchive = false;
      archiveReceipt = JSON.parse(await turn(request)).receipt;
      assertEquals((archiveReceipt as { status: string }).status, "succeeded");
      assertEquals(JSON.parse(await turn(request)).receipt, archiveReceipt);
      assertEquals(approvals.length, 1);
      const collision =
        JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
          .receipt;
      assertEquals(collision.status, "failed");
      assertEquals(readSentinelFindingReviews(path, state.revision), decision);
    });

    await Deno.rename(dirname(path), join(baseDir, "original-fixture"));
    const packageFile = join(
      baseDir,
      "data",
      "run-archives",
      archiveId,
      "sentinel.json",
    );
    const content = await Deno.readTextFile(packageFile);
    await withGateway(baseDir, async (turn) => {
      await Deno.writeTextFile(packageFile, "corrupt");
      const corrupt =
        JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
          .receipt;
      assertEquals(corrupt.status, "failed");
      await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound);
      await Deno.writeTextFile(packageFile, content);
      const adaptiveArtifact = join(
        dirname(packageFile),
        "sentinel-adaptive.db",
      );
      const savedArtifact = join(baseDir, "saved-adaptive.db");
      await Deno.rename(adaptiveArtifact, savedArtifact);
      const incomplete =
        JSON.parse(await turn({ ...restore, requestId: crypto.randomUUID() }))
          .receipt;
      assertEquals(incomplete.status, "failed");
      await assertRejects(
        () => Deno.lstat(dirname(path)),
        Deno.errors.NotFound,
      );
      await Deno.rename(savedArtifact, adaptiveArtifact);
      const first = JSON.parse(await turn(restore)).receipt;
      assertEquals(first.status, "succeeded");
      assertEquals(JSON.parse(await turn(restore)).receipt, first);
      assertEquals(JSON.parse(await turn(request)).receipt, archiveReceipt);
      const restored = readSentinelAssessment(path);
      assert(restored?.paused);
      assertEquals(restored.plan.runId, state.plan.runId);
      assertEquals(restored.plan.formalGoals, goals);
      assertEquals(restored.revision, state.revision);
      assertEquals(
        readSentinelFindingReviews(path, restored.revision),
        decision,
      );
      const adaptive = readAdaptiveSentinel(path, restored, "revision");
      const source = adaptive?.tasks.find(({ id }) => id === sourceTaskId);
      const dependent = adaptive?.tasks.find(({ id }) => id === dependentId);
      assertEquals(source?.status, "completed");
      assertEquals(source?.observation, observation);
      assertEquals(dependent?.status, "queued");
      assertEquals(dependent?.prerequisites, [sourceTaskId]);
      assertEquals(dependent?.evidenceIds, [evidenceId]);
      const graph = JSON.parse(
        await turn({
          action: "node",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
          node: `evidence:${evidenceId}`,
        }),
      );
      assertEquals(graph.page.node.id, `evidence:${evidenceId}`);
      const history = JSON.parse(
        await turn({ action: "archive_history", ...exact }),
      );
      assertEquals(
        history.records.map(({ status }: { status: string }) => status),
        ["succeeded", "failed", "failed", "failed", "succeeded"],
      );
      assertStringIncludes(
        await turn({
          ...restore,
          runId: crypto.randomUUID(),
        }),
        "unavailable",
      );
      const resumed = JSON.parse(
        await turn({
          action: "resume",
          kind: "sentinel",
          id: exact.id,
          revision: exact.revision,
        }),
      ).run;
      assertEquals(resumed.status, "running");
      const active = readSentinelAssessment(path);
      assert(active?.active && !active.paused);
      const resumedTasks = readAdaptiveSentinel(path, active, "revision")
        ?.tasks;
      assertEquals(
        resumedTasks?.find(({ id }) => id === dependentId)?.prerequisites,
        [sourceTaskId],
      );
      assertEquals(
        resumedTasks?.find(({ id }) => id === dependentId)?.status,
        "completed",
      );
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
