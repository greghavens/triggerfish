import { createHash } from "node:crypto";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { openSentinelEvidenceDigests } from "../../src/sentinel/evidence_digests.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";

const allowHooks = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW" as const,
      duration: 0,
      ruleId: null,
    }),
};

function completion(content: string, name?: string, args?: object) {
  return {
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
    toolCalls: name
      ? [{
        type: "function",
        id: name,
        function: { name, arguments: JSON.stringify(args) },
      }]
      : [],
  };
}

interface PlannerInput {
  readonly inventory: readonly { id: string; kind: string }[];
  readonly coldDigests: readonly { id: string; memberCount: number }[];
}

Deno.test("adaptive planner archives omitted inventory in exact evidence digests and records the presented IDs", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-inventory";
  const path = resolveSentinelCasePath(directory, caseId);
  const evidence = Array.from({ length: 44 }, (_, index) => ({
    id: `record-${String(index).padStart(2, "0")}`,
    kind: "evidence",
    label: `Committed evidence ${index}`,
  }));
  let calls = 0;
  const received = Promise.withResolvers<PlannerInput>();
  const makePlanner = () =>
    createSentinelModelPlanner(path, (_state, taskId) => ({
      execute(content, send) {
        assertEquals(taskId, undefined);
        calls++;
        const prompt = String(content);
        received.resolve(
          JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)),
        );
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    }));
  const first = makePlanner();
  const reopened = makePlanner();
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "service", kind: "asset", label: "Assigned service" },
          ...evidence,
        ],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    advanceAdaptiveSentinel(path, state);
    first.advance(state);
    const timeout = setTimeout(
      () => received.reject(new Error("Planner did not dispatch")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timeout));
    assert(prompt.inventory.length <= 30);
    assert(prompt.coldDigests.length >= 1);
    const inline = new Set(prompt.inventory.map(({ id }) => id));
    const omitted = evidence.filter(({ id }) => !inline.has(id)).map(({ id }) =>
      "evidence:" + id
    ).sort();
    assert(omitted.length >= 14);
    const digests = openSentinelEvidenceDigests(directory);
    try {
      const refs: string[] = [];
      for (const digest of prompt.coldDigests) {
        const page = digests.expand(scope, digest.id, 30);
        assertExists(page);
        const members = [...page.members];
        let cursor = page.nextCursor;
        while (cursor) {
          const next = digests.expand(scope, digest.id, 30, cursor);
          assertExists(next);
          members.push(...next.members);
          cursor = next.nextCursor;
        }
        assertEquals(members.length, digest.memberCount);
        refs.push(
          ...members.filter(({ kind }) => kind === "evidence").map(({ id }) =>
            id
          ),
        );
      }
      assertEquals(refs.sort(), omitted);
      assertEquals(
        digests.list(scope)?.digests.map(({ id }) => id).sort(),
        prompt.coldDigests.map(({ id }) => id).sort(),
      );
    } finally {
      digests.close();
    }
    const deadline = Date.now() + 2000;
    while (
      readAdaptiveSentinel(path, state)?.modelPlanner?.status !==
        "no_new_assignments" && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = readAdaptiveSentinel(path, state);
    assertEquals(latest?.modelPlanner?.status, "no_new_assignments");
    assertEquals(
      latest?.modelPlannerHistory.at(-1)?.inputManifest?.coldDigestIds,
      prompt.coldDigests.map(({ id }) => id),
    );
    first.stop();
    reopened.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(calls, 1);
    const journal = openSentinelEvidenceDigests(directory);
    try {
      assertEquals(
        journal.list(scope)?.digests.length,
        prompt.coldDigests.length,
      );
    } finally {
      journal.close();
    }
  } finally {
    first.stop();
    reopened.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

interface HistoryPlannerInput extends PlannerInput {
  readonly coldHistoryDigests: readonly { id: string; memberCount: number }[];
  readonly currentInvestigations: readonly { id: string }[];
  readonly workerObservations: readonly {
    taskId: string;
    observation?: unknown;
    reviewSummary?: string;
  }[];
}

Deno.test("planner history digests retain omitted completed assignments and both observation kinds", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-committed-history";
  const path = resolveSentinelCasePath(directory, caseId);
  const count = 44;
  const assets = Array.from({ length: count }, (_, index) => ({
    id: `asset-${String(index).padStart(2, "0")}`,
    kind: "asset",
    label: `Committed application ${index}`,
  }));
  const received = Promise.withResolvers<HistoryPlannerInput>();
  const planner = createSentinelModelPlanner(path, (_state, taskId) => ({
    execute(content, send) {
      assertEquals(taskId, undefined);
      const prompt = String(content);
      received.resolve(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)));
      send({ type: "response", text: "[]", taint: "INTERNAL" });
      return Promise.resolve();
    },
    clear() {},
  }));
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: assets, edges: [] }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    assertExists(state.plan.runId);
    const scope = {
      caseId,
      runId: state.plan.runId,
      evidenceRevision: state.revision,
    };
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    const completed = new Set<string>();
    const incomplete = new Set<string>();
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
          reason: MODEL_ASSIGNMENT_REASON,
        })),
        null,
        {
          number: state.revision,
          goal: {
            id: state.plan.runId,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      for (let index = 0; index < count - 2; index++) {
        const next = store.claim(revision);
        assertExists(next);
        const { id, nodeId } = next.task;
        assert(store.complete({
          taskId: id,
          leaseToken: next.leaseToken,
          observation: {
            relatedNodeIds: [nodeId],
            summary: `Committed worker result ${index} ` +
              "details ".repeat(30),
          },
        }));
        const review = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.id === id,
        );
        assertExists(review);
        assert(store.finishModelReview(revision, id, review.token, {
          note: `Committed model review ${index} ` + "analysis ".repeat(40),
          steps: [],
        }));
        completed.add(id);
      }
      const running = store.claim(revision);
      assertExists(running);
      const pending = store.list(revision).filter(({ status }) =>
        status === "queued" || status === "running"
      );
      assertEquals(pending.map(({ status }) => status).sort(), [
        "queued",
        "running",
      ]);
      for (const { id } of pending) incomplete.add(id);
    } finally {
      store.close();
    }
    planner.advance(state);
    const timer = setTimeout(
      () => received.reject(new Error("Planner did not dispatch with history")),
      2000,
    );
    const prompt = await received.promise.finally(() => clearTimeout(timer));
    assert(prompt.coldHistoryDigests.length > 0);
    const journal = openSentinelEvidenceDigests(directory);
    const cold = new Set<string>();
    try {
      for (const { id, memberCount } of prompt.coldHistoryDigests) {
        let seen = 0;
        let cursor: string | undefined;
        do {
          const page = journal.expand(scope, id, 12, cursor);
          assertExists(page);
          for (const item of page.members) {
            assert(!cold.has(item.id));
            cold.add(item.id);
            seen++;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        assertEquals(seen, memberCount);
      }
    } finally {
      journal.close();
    }
    const taskIds = new Set(prompt.currentInvestigations.map(({ id }) => id));
    const inline = new Map(
      prompt.workerObservations.map((record) => [record.taskId, record]),
    );
    assert(
      [...completed].some((id) =>
        !taskIds.has(id) && cold.has(`task:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.observation && cold.has(`observation:adaptive:${id}`)
      ),
    );
    assert(
      [...completed].some((id) =>
        !inline.get(id)?.reviewSummary &&
        cold.has(`observation:adaptive:review:${id}`)
      ),
    );
    for (const id of incomplete) {
      assert(!cold.has(`task:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:${id}`));
      assert(!cold.has(`observation:adaptive:review:${id}`));
    }
    const deadline = Date.now() + 2000;
    const lastAttempt = () =>
      readAdaptiveSentinel(path, state)?.modelPlannerHistory.at(-1);
    while (!lastAttempt()?.finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = lastAttempt();
    assertEquals(latest?.outcome, "no_new_assignments");
    assertEquals(
      latest?.inputManifest?.coldDigestIds?.toSorted(),
      [...(prompt.coldDigests ?? []), ...prompt.coldHistoryDigests].map((
        { id },
      ) => id).sort(),
    );
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("planner expands older committed intermediate evidence and gateway reopens the digest after restore", async () => {
  const directory = await Deno.makeTempDir();
  const caseId = "cold-intermediate";
  const path = resolveSentinelCasePath(directory, caseId);
  const assets = Array.from({ length: 5 }, (_, index) => ({
    id: `application-${index}`,
    kind: "asset",
    label: `Application ${index}`,
  }));
  const opened = Promise.withResolvers<string>();
  const registry = createProviderRegistry();
  registry.register({
    name: "intermediate-digest-planner",
    supportsStreaming: false,
    complete(messages) {
      const reply = messages.findLast(({ role }) => role === "tool");
      if (reply) {
        opened.resolve(String(reply.content));
        return Promise.resolve(completion("[]"));
      }
      const user = String(
        messages.findLast(({ role }) => role === "user")?.content,
      );
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      assertEquals(input.committedObservations.length, 4);
      const [digest] = input.coldHistoryDigests;
      return Promise.resolve(completion("", "sentinel_expand_evidence_digest", {
        revision: input.coldDigestRevision,
        digestId: digest.id,
        limit: 10,
      }));
    },
  });
  registry.setDefault("intermediate-digest-planner");
  const planner = createSentinelModelPlanner(path, (state, taskId) => {
    assertEquals(taskId, undefined);
    return createSentinelSubagent({
      snapshotPath: path,
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
      sharedInventoryBaseDir: directory,
      allowModelAccess: true,
      providerRegistry: registry,
      hookRunner: allowHooks,
    });
  });
  const confirm = () => Promise.resolve(true);
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: assets,
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let oldest: string | undefined;
    let oldestTaskId: string | undefined;
    let oldestTargetId: string | undefined;
    try {
      store.sync(
        revision,
        assets.map(({ id }) => ({
          kind: "trace",
          nodeId: id,
          reason: "Retain intermediate evidence without a final review",
        })),
        null,
        {
          number: state.revision,
          goal: { id: runId, label: "Review committed defensive observations" },
        },
      );
      for (let index = 0; index < assets.length; index++) {
        const lease = store.claim(revision);
        assert(lease);
        const taskId = lease.task.id;
        assert(
          store.complete({
            taskId,
            leaseToken: lease.leaseToken,
            observation: {},
          }),
        );
        const review = store.claimModelReview(
          revision,
          "Retain intermediate evidence without a final review",
          ({ id }) => id === taskId,
        );
        assert(review);
        const runs = [{
          id: index + 1,
          status: "completed",
          conclusion: "success",
        }];
        assert(
          store.recordLeasedGitHubWorkflowResult(
            revision,
            taskId,
            review.token,
            state.revision,
            {
              repository: "owner/application",
              workflowId: 42,
              connectorId: "github-actions",
              observedAt: new Date(Date.now() + index).toISOString(),
              resultSha256: createHash("sha256").update(JSON.stringify(runs))
                .digest("hex"),
              evidenceRevision: state.revision,
              runs,
            },
          ),
        );
        const receipt = store.commitLeasedWorkflowObservation(
          revision,
          taskId,
          review.token,
          state.revision,
          0,
        );
        assert(receipt);
        oldest ??= receipt.id;
        oldestTaskId ??= taskId;
        oldestTargetId ??= receipt.targetId;
        assert(
          store.recordModelReviewProgress(revision, taskId, review.token, [{
            tool: "sentinel_publish_workflow_observation",
            target: receipt.id,
            outcome: "returned",
          }]),
        );
        assert(
          store.finishModelReview(
            revision,
            taskId,
            review.token,
            "interrupted",
          ),
        );
      }
      assertEquals(store.modelReviewNotes(revision), []);
      assert(
        store.modelReviewStates(revision).every(({ status }) =>
          status !== "completed"
        ),
      );
    } finally {
      store.close();
    }
    planner.advance(state);
    const timeout = setTimeout(
      () => opened.reject(new Error("Planner digest did not expand")),
      2500,
    );
    const liveText = await opened.promise.finally(() => clearTimeout(timeout));
    const memberId = `observation:adaptive:${oldest}`;
    assertEquals(
      JSON.parse(liveText).page.members.find(({ id }: { id: string }) =>
        id === memberId
      ),
      {
        id: memberId,
        kind: "observation",
        label: "Intermediate workflow observation",
        status: "committed",
      },
    );
    assert(
      !JSON.parse(liveText).page.members.some(({ id }: { id: string }) =>
        id === `observation:adaptive:review:${oldestTaskId}`
      ),
    );
    const deadline = Date.now() + 2000;
    while (planner.hasInFlightWork() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(!planner.hasInFlightWork());
    const round = readAdaptiveSentinel(path, state)?.modelPlannerHistory.find((
      { reads },
    ) => reads?.some(({ tool }) => tool === "sentinel_expand_evidence_digest"));
    assert(round);
    const plannerIdentity = round.identity;
    assert(stopSentinelAssessment(path));
    const ref = {
      kind: "sentinel" as const,
      id: caseId,
      revision: state.revision,
    };
    const archiveId = crypto.randomUUID();
    const archive = await executeOperatorRunArchive(directory, ref, {
      ...ref,
      action: "archive",
      requestId: archiveId,
      runId,
    }, confirm);
    assert(typeof archive !== "string");
    assertEquals((archive.receipt as { status: string }).status, "succeeded");
    await Deno.rename(dirname(path), join(directory, "previous-case"));
    await Deno.remove(join(directory, "data", "sentinel-evidence-digests.db"));
    const restored = await executeOperatorRunArchive(directory, ref, {
      ...ref,
      action: "restore",
      requestId: crypto.randomUUID(),
      archiveId,
      runId,
    }, confirm);
    assert(typeof restored !== "string");
    assertEquals((restored.receipt as { status: string }).status, "succeeded");
    const scope = readAdaptiveSentinel(path, state, "revision");
    assert(scope);
    assert(scope.workflowObservations.some(({ id }) => id === oldest));
    assert(!scope.modelReviews.some(({ taskId }) => taskId === oldestTaskId));

    let selected = {
      action: "planner_reads",
      ...ref,
      plannerIdentity,
      attempt: round.attempt,
      ordinal: 1,
      includeResult: true,
    };
    let readout: string | undefined;
    let deny = false;
    const chatProvider = createProviderRegistry();
    chatProvider.register({
      name: "archived-digest-owner",
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        if (last?.role === "tool") {
          readout = String(last.content);
          return Promise.resolve(completion("Checked archived history."));
        }
        return Promise.resolve(completion("", "operator_runs", selected));
      },
    });
    chatProvider.setDefault("archived-digest-owner");
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "cold-digest" as ChannelId,
        }),
        providerRegistry: chatProvider,
        operatorRunExecutor: createOperatorRunToolExecutor({
          baseDir: directory,
          confirm,
        }),
        hookRunner: {
          evaluateHook(hook, { input }) {
            const allowed = !(deny && hook === "POST_TOOL_RESPONSE" &&
              input.tool_name === "sentinel_expand_evidence_digest");
            return Promise.resolve({
              allowed,
              action: allowed ? "ALLOW" : "BLOCK",
              ruleId: null,
              duration: 0,
            });
          },
        },
      }),
    });
    const { port } = await gateway.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      for (
        const refusal of [false, "hook", "constraint", "revision"] as const
      ) {
        deny = refusal === "hook";
        if (refusal === "constraint") {
          const allowed = assets.filter(({ id }) => id !== oldestTargetId).map((
            { id },
          ) => id);
          assert(recordSentinelOperatingConstraints(path, {
            runId,
            evidenceRevision: state.revision,
            expectedVersion: 0,
            requestId: crypto.randomUUID(),
            operatorScope: "planner-digest-fixture",
            constraints: { allowedAssetIds: allowed, deniedKinds: [] },
          }));
        }
        if (refusal === "revision") {
          selected = { ...selected, revision: state.revision + 1 };
        }
        const done = Promise.withResolvers<void>();
        const timer = setTimeout(
          () => done.reject(new Error("Owner digest read timed out")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const event = JSON.parse(data);
          if (event.type === "response") done.resolve();
          if (event.type === "error") done.reject(new Error(event.message));
        };
        ws.addEventListener("message", receive);
        try {
          ws.send(
            JSON.stringify({
              type: "message",
              content: "Open the exact archived planner result.",
            }),
          );
          await done.promise;
        } finally {
          clearTimeout(timer);
          ws.removeEventListener("message", receive);
        }
        if (refusal) assert(readout?.includes("unavailable"));
        else {assertEquals(
            JSON.parse(readout ?? "").result,
            JSON.parse(liveText),
          );}
      }
    } finally {
      ws.close();
      await gateway.stop();
    }
  } finally {
    planner.stop();
    await Deno.remove(directory, { recursive: true });
  }
});
