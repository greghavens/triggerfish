import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { SENTINEL_SHARED_WORKER_REVIEW } from "../../src/sentinel/worker_goal_recovery.ts";

const sourceCase = "review-source";
const targetCase = "review-recipient";
const asset = "app";
const summary = "The retained application inventory was reviewed.";
const finished = "Reopened the exact approved cross-case review.";
const allow = {
  evaluateHook: () =>
    Promise.resolve({
      allowed: true,
      action: "ALLOW" as const,
      duration: 0,
      ruleId: null,
    }),
};
const usage = { inputTokens: 1, outputTokens: 1 };
const completion = (content: string, name?: string, args = {}) => ({
  content,
  usage,
  toolCalls: name
    ? [{
      id: crypto.randomUUID(),
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    }]
    : [],
});
const noop = () => ({ execute: () => Promise.resolve(), clear() {} });
function provider(
  complete: Parameters<
    ReturnType<typeof createProviderRegistry>["register"]
  >[0]["complete"],
) {
  const registry = createProviderRegistry();
  registry.register({
    name: "review-restart-fixture",
    supportsStreaming: false,
    complete,
  });
  registry.setDefault("review-restart-fixture");
  return registry;
}

function assessmentPath(base: string, id: string) {
  return resolveSentinelCasePath(base, id);
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  advance = () => {},
) {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    advance();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Shared review fixture did not reach the expected checkpoint.",
  );
}

function hookScope(base: string, version: number, allowedAssetIds: string[]) {
  const path = assessmentPath(base, sourceCase);
  const state = readSentinelAssessment(path);
  assert(state?.plan.runId);
  return recordSentinelOperatingConstraints(path, {
    runId: state.plan.runId,
    evidenceRevision: state.revision,
    expectedVersion: version,
    requestId: crypto.randomUUID(),
    operatorScope: "owner",
    constraints: { deniedKinds: [], allowedAssetIds },
  });
}

async function approvedRecipient(base: string) {
  const source = assessmentPath(base, sourceCase);
  for (const path of [source, assessmentPath(base, targetCase)]) {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: asset,
          kind: "asset",
          label: "Application",
          aliases: ["app.example"],
        }],
        edges: [],
      }),
    );
  }
  const state = startSentinelAssessment(source);
  assert(hookScope(base, 0, [asset]));
  advanceAdaptiveSentinel(source, state);
  const identity = adaptiveRevision(state);
  const store = openSentinelAdaptiveStore(
    join(dirname(source), "sentinel-adaptive.db"),
  );
  let taskId: string;
  try {
    const task = store.sync(identity, [{
      kind: "trace",
      nodeId: asset,
      depth: 7,
      reason: MODEL_ASSIGNMENT_REASON,
    }], identity).find(({ kind, depth }) => kind === "trace" && depth === 7);
    assert(task);
    taskId = task.id;
  } finally {
    store.close();
  }
  advanceAdaptiveSentinel(source, state);
  const sourceModel = provider((messages) =>
    Promise.resolve(
      messages.some(({ role }) => role === "tool")
        ? completion(JSON.stringify({ summary, followUps: [] }))
        : completion("", "sentinel_assigned_target"),
    )
  );
  const worker = createSentinelModelPlanner(
    source,
    (current, id, lease) =>
      id === taskId
        ? createSentinelSubagent({
          snapshotPath: source,
          assessmentRevision: current.revision,
          assignedTaskId: id,
          assignedTaskLeaseToken: lease,
          providerRegistry: sourceModel,
          hookRunner: allow,
          allowModelAccess: true,
        })
        : noop(),
  );
  try {
    await waitFor(() =>
      readAdaptiveSentinel(source, state)?.modelReviews.some(
        (review) => review.taskId === taskId && review.summary === summary,
      ) === true, () => worker.advance(state));
  } finally {
    worker.stop();
  }

  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "review-fixture" as ChannelId,
      }),
      providerRegistry: provider((messages) =>
        Promise.resolve(
          messages.at(-1)?.role === "tool"
            ? completion("Approved the exact reviewed source.")
            : completion("", "operator_runs", {
              kind: "sentinel",
              id: sourceCase,
              revision: state.revision,
              action: "spawn",
              targetKind: "sentinel",
              targetId: targetCase,
              sourceCases: [{
                caseId: sourceCase,
                revision: state.revision,
                workerReviewTaskIds: [taskId],
              }],
              requestId: crypto.randomUUID(),
            }),
        )
      ),
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir: base,
        confirm: () => Promise.resolve(true),
      }),
      hookRunner: allow,
    }),
  });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        type: "message",
        content: "Approve this linked review.",
      }),
    );
    await waitFor(() =>
      readSentinelAssessment(assessmentPath(base, targetCase))?.active === true
    );
  } finally {
    socket.close();
    await gateway.stop();
  }

  const path = assessmentPath(base, targetCase);
  const target = readSentinelAssessment(path);
  assert(target?.plan.runId);
  const selector = { asset, sourceCase, taskId };
  const targetModel = provider((messages) => {
    const result = messages.findLast(({ role }) => role === "tool");
    if (!result) {
      return Promise.resolve(
        completion("", SENTINEL_SHARED_WORKER_REVIEW, selector),
      );
    }
    const opened = JSON.parse(String(result.content));
    assertEquals(opened.summary, summary);
    return Promise.resolve(completion(JSON.stringify({
      prioritize: [],
      assignments: [{
        kind: "trace",
        depth: 1,
        nodeId: asset,
        peerWorkerReview: opened.reference,
      }],
    })));
  });
  const followUp = () =>
    readAdaptiveSentinel(path, target, "revision")?.tasks.find(
      ({ plannerRound }) =>
        plannerRound?.peerWorkerReview?.sourceTaskId === taskId,
    );
  const planner = createSentinelModelPlanner(
    path,
    (current, id) =>
      id ? noop() : createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: current.revision,
        plannerExecutionEvidenceRunId: current.plan.runId,
        sharedInventoryBaseDir: base,
        providerRegistry: targetModel,
        hookRunner: allow,
        allowModelAccess: true,
      }),
    () => followUp() ? undefined : () => {},
  );
  try {
    await waitFor(
      () => !!followUp() && !planner.hasInFlightWork(),
      () => planner.advance(target),
    );
  } finally {
    planner.stop();
  }
  await Deno.writeTextFile(
    join(base, "assignment.json"),
    JSON.stringify({
      selector,
      taskId: followUp()!.id,
    }),
  );
}

async function runChild(base: string, phase: string) {
  const { selector, taskId } = JSON.parse(
    await Deno.readTextFile(join(base, "assignment.json")),
  );
  const path = assessmentPath(base, targetCase);
  const state = readSentinelAssessment(path);
  assert(state?.active);
  const marker = (name: string) => join(base, name);
  const model = provider(async (messages) => {
    if (phase === "revoked") {
      await Deno.writeTextFile(marker("unauthorized-model-call"), "called");
      throw new Error("Revoked source delivered model context");
    }
    const received = messages.findLast(({ role }) => role === "tool");
    if (!received) {
      assertEquals(
        phase,
        "interrupt",
        "Completed source read was offered again",
      );
      await Deno.writeTextFile(marker("tool-offer"), "offered\n", {
        append: true,
        create: true,
      });
      return completion("", SENTINEL_SHARED_WORKER_REVIEW, selector);
    }
    const exact = String(received.content);
    assertEquals(JSON.parse(exact).summary, summary);
    await Deno.writeTextFile(
      marker(phase === "interrupt" ? "checkpoint-ready" : "replayed"),
      exact,
    );
    if (phase === "interrupt") return await new Promise<never>(() => {});
    return completion(JSON.stringify({ summary: finished, followUps: [] }));
  });
  const app = createGatewayServer({
    port: 0,
    token: crypto.randomUUID(),
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "review-fixture" as ChannelId,
      }),
      providerRegistry: model,
      hookRunner: allow,
    }),
  });
  const planner = createSentinelModelPlanner(
    path,
    (current, id, lease) =>
      id === taskId
        ? createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          assignedTaskId: id,
          assignedTaskLeaseToken: lease,
          sharedInventoryBaseDir: base,
          providerRegistry: model,
          hookRunner: allow,
          allowModelAccess: true,
        })
        : noop(),
  );
  const advance = () => {
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
  };
  await app.start();
  try {
    if (phase === "interrupt") {
      await waitFor(async () => {
        try {
          await Deno.stat(marker("checkpoint-ready"));
          return true;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          return false;
        }
      }, advance);
      await new Promise<never>(() => {});
    } else {
      advance();
      await waitFor(() => {
        const result = readAdaptiveSentinel(path, state, "revision");
        const attempt = result?.modelReviewStates.find((item) =>
          item.taskId === taskId
        );
        return !planner.hasInFlightWork() &&
          (phase === "revoked"
            ? attempt?.attempts === 1 &&
              attempt.status === "held_by_analyst_decision"
            : result?.modelReviews.some((review) =>
              review.taskId === taskId && review.summary === finished
            ) === true);
      }, advance);
      Deno.exit(0);
    }
  } finally {
    planner.stop();
    await app.stop();
  }
}

if (import.meta.main) {
  await runChild(Deno.args[0], Deno.args[1]);
} else {
  Deno.test("A killed gateway resumes the exact approved cross-case review and cannot replay after source scope revocation", async () => {
    const temp = await Deno.makeTempDir();
    const base = join(temp, "approved");
    let child: Deno.ChildProcess | undefined;
    const session = (directory: string, phase: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", fromFileUrl(import.meta.url), directory, phase],
        stdout: "null",
        stderr: "piped",
      }).spawn();
    const childSuccess = async (directory: string, phase: string) => {
      const result = await session(directory, phase).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    };
    try {
      await approvedRecipient(base);
      child = session(base, "interrupt");
      await waitFor(async () => {
        try {
          await Deno.stat(join(base, "checkpoint-ready"));
          return true;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          return false;
        }
      });
      child.kill("SIGKILL");
      assert(!(await child.status).success);
      child = undefined;
      const path = assessmentPath(base, targetCase);
      const db = new DatabaseSync(join(dirname(path), "sentinel-adaptive.db"));
      try {
        const checkpoint = String(
          db.prepare("SELECT checkpoint FROM adaptive_worker_checkpoints").get()
            ?.checkpoint,
        );
        assertStringIncludes(checkpoint, "sentinel-shared-worker-review:");
        assert(!checkpoint.includes(summary));
        // Advance only the crashed lease's deadline in the fixture.
        db.exec(
          "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE token IS NOT NULL",
        );
      } finally {
        db.close();
      }
      assert(hookScope(base, 1, []));
      await childSuccess(base, "revoked");
      await assertRejects(
        () => Deno.stat(join(base, "unauthorized-model-call")),
        Deno.errors.NotFound,
      );
      assertEquals(
        await Deno.readTextFile(join(base, "tool-offer")),
        "offered\n",
      );
      assert(hookScope(base, 2, [asset]));
      await childSuccess(base, "resume");
      const saved = await Deno.readTextFile(join(base, "checkpoint-ready"));
      assertEquals(await Deno.readTextFile(join(base, "replayed")), saved);
      assertEquals(
        await Deno.readTextFile(join(base, "tool-offer")),
        "offered\n",
      );
      const state = readSentinelAssessment(path);
      assert(state);
      const review = readAdaptiveSentinel(path, state, "revision")?.modelReviews
        .find(({ summary }) => summary === finished);
      assertEquals(review?.steps.length, 1);
      assertEquals(
        review?.steps[0].goalReceiptRead?.sha256,
        createHash("sha256").update(saved).digest("hex"),
      );
    } finally {
      child?.kill("SIGKILL");
      await child?.status;
      await Deno.remove(temp, { recursive: true });
    }
  });
}
