import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { DatabaseSync } from "node:sqlite";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import {
  withVerifiedRunArchive,
  writeRunArchive,
} from "../../src/core/run_archive.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import type { ChatSession } from "../../src/gateway/chat_session_interface.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createA2UIHost } from "../../src/tools/tidepool/host/host.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
  updateSentinelWorkerLimit,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { readAdaptiveWorkerNarrative } from "../../src/sentinel/adaptive_store.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";
import {
  permittedSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
} from "../../src/sentinel/sentinel_archive_restore.ts";

const usage = { inputTokens: 1, outputTokens: 1 };

function complete(
  content: string,
  name?: string,
  args: Record<string, unknown> = {},
) {
  return {
    content,
    usage,
    toolCalls: name
      ? [{
        type: "function" as const,
        id: crypto.randomUUID(),
        function: { name, arguments: JSON.stringify(args) },
      }]
      : [],
  };
}

async function waitFor(label: string, condition: () => boolean) {
  const deadline = performance.now() + 4_000;
  while (!condition() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(condition(), label);
}

async function ownerGateway(
  baseDir: string,
  hooks: HookRunner,
  run: (
    turn: (args: Record<string, unknown>) => Promise<string>,
    session: ChatSession,
  ) => Promise<void>,
) {
  const registry = createProviderRegistry();
  let args: Record<string, unknown>;
  let seen: string;
  registry.register({
    name: "traffic-narrative-owner",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") {
        seen = String(last.content);
        return Promise.resolve(complete("Finished the request."));
      }
      return Promise.resolve(complete("", "operator_runs", args));
    },
  });
  registry.setDefault("traffic-narrative-owner");
  const session = createChatSession({
    session: createSession({
      userId: "owner" as UserId,
      channelId: "test" as ChannelId,
    }),
    providerRegistry: registry,
    enableStreaming: false,
    hookRunner: hooks,
    resolveSentinelChatCase: (caseId) =>
      resolveSentinelCasePath(baseDir, caseId),
    operatorRunExecutor: createOperatorRunToolExecutor({
      baseDir,
      confirm: () => Promise.resolve(true),
    }),
  });
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({ token, port: 0, chatSession: session });
  const { port } = await gateway.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    await run(async (input) => {
      args = input;
      seen = "";
      const finished = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => finished.reject(new Error("No owner reply")),
        3_000,
      );
      const receive = ({ data }: MessageEvent) => {
        const frame = JSON.parse(data);
        if (frame.type === "response") finished.resolve();
        if (frame.type === "error") finished.reject(new Error(frame.message));
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Inspect the exact retained observation.",
          }),
        );
        await finished.promise;
        return seen;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
      }
    }, session);
  } finally {
    socket.close();
    await closed.promise;
    await gateway.stop();
  }
}

async function tidepoolNarrative(
  baseDir: string,
  session: ChatSession,
  caseId: string,
  revision: number,
  focusId: string,
) {
  const key = crypto.randomUUID();
  const host = createA2UIHost({ sessionKey: key });
  host.registerTopicHandler(
    "sentinel",
    createTidepoolSentinelHandler(
      {
        baseDir,
        config: { sentinel: { allow_model_access: true } },
      } as BootstrapResult,
      undefined,
      undefined,
      undefined,
      session.readSentinelWorkerNarrative,
    ),
  );
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = probe.addr as Deno.NetAddr;
  probe.close();
  await host.start(port);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?key=${key}`);
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const reply = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(
      () => reply.reject(new Error("No Tidepool reply")),
      3000,
    );
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.requestId === 1) reply.resolve(message);
    });
    socket.send(
      JSON.stringify({
        topic: "sentinel",
        type: "revision",
        caseId,
        revision,
        focusId,
        requestId: 1,
      }),
    );
    return await reply.promise.finally(() => clearTimeout(timer));
  } finally {
    socket.close();
    await closed.promise;
    await host.stop();
  }
}

Deno.test("Leased traffic observations wake the planner and retain exact peer evidence", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "traffic-narrative";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const publication = Promise.withResolvers<void>();
  const finishSource = Promise.withResolvers<void>();
  let allowTraffic = true;
  let sourceWaiting = false;
  let sourceFinished = false;
  let sourceTask: string | undefined;
  let created: Record<string, unknown> | undefined;
  let publicationResult: string | undefined;
  let planned: string | undefined;
  let peerRead: string | undefined;
  let scopeDenials = 0;
  let wakeOffset = 0;
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  const hooks: HookRunner = {
    evaluateHook(hook, { input }) {
      const denied = !allowTraffic && hook === "PRE_TOOL_CALL" &&
        input.tool_name === "sentinel_traffic_get";
      if (denied) scopeDenials++;
      return Promise.resolve({
        allowed: !denied,
        action: denied ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const commit = "sentinel_publish_worker_narrative";
  const open = "sentinel_worker_narrative";
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, nodes: [], edges: [] }),
      { mode: 0o600 },
    );
    await ingestSentinelTraffic(
      new Blob([JSON.stringify({
        startedDateTime: "2026-06-01T00:00:00.000Z",
        request: {
          url: "https://traffic.example/private?signature=private-query",
          method: "GET",
        },
        response: { status: 200, content: { text: "retained private body" } },
      })]).stream(),
      "reviewed traffic fixture",
      path,
      "har",
      true,
    );
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const page = readSentinelTrafficReceiptPage(path, state.revision, {
      limit: 1,
    });
    const retained = page?.receipts[0];
    assert(retained);
    const { evidenceId, digest: trafficDigest } = retained;
    const asset = retained.assetIds[0];
    assert(asset);
    assert(
      updateSentinelWorkerLimit(path, {
        runId,
        revision: state.revision,
        expected: null,
      }, 2),
    );
    const sourceModel = createProviderRegistry();
    let sourceDigest: string | undefined;
    sourceModel.register({
      name: "traffic-narrative-source",
      supportsStreaming: false,
      async complete(messages) {
        const results = messages.filter(({ role }) => role === "tool");
        if (!results.length) {
          return complete("", "sentinel_traffic_get", {
            evidenceId,
            digest: trafficDigest,
            revision: state.revision,
          });
        }
        if (results.length === 1) {
          const source = String(results[0].content);
          assert(source.startsWith("{"), source);
          assert(
            !source.includes("retained private body") &&
              !source.includes("private-query"),
          );
          sourceDigest = createHash("sha256").update(source).digest("hex");
          sourceWaiting = true;
          await publication.promise;
          return complete("", commit, {
            summary: "The retained application request returned HTTP 200.",
            confidence: "observed",
            evidenceId,
            trafficDigest,
          });
        }
        publicationResult = String(results[1].content);
        created = JSON.parse(publicationResult);
        assertEquals(created?.receipt, {
          summary: "The retained application request returned HTTP 200.",
          confidence: "observed",
          sourceSha256: sourceDigest,
          evidenceId,
          trafficDigest,
        });
        await finishSource.promise;
        sourceFinished = true;
        return complete(
          '{"summary":"Observed approved traffic.","followUps":[]}',
        );
      },
    });
    sourceModel.setDefault("traffic-narrative-source");

    const plannerModel = createProviderRegistry();
    plannerModel.register({
      name: "traffic-narrative-planner",
      supportsStreaming: false,
      complete(messages) {
        const prompt = String(
          messages.findLast(({ role }) => role === "user")?.content,
        );
        const id = JSON.parse(prompt.split("\n").at(-1)!).workerNarratives?.[0]
          ?.id;
        if (!id) {
          wakeOffset = 58_750;
          return Promise.resolve(
            complete(JSON.stringify([{ kind: "impact", nodeId: asset }])),
          );
        }
        const result = messages.findLast(({ role }) => role === "tool");
        if (!result) return Promise.resolve(complete("", open, { id }));
        planned = String(result.content);
        if (!planned.startsWith("{")) return Promise.resolve(complete("[]"));
        return Promise.resolve(complete(JSON.stringify([{
          kind: "trace",
          nodeId: asset,
          depth: 1,
          workerNarrativeId: id,
        }])));
      },
    });
    plannerModel.setDefault("traffic-narrative-planner");

    const peerModel = createProviderRegistry();
    peerModel.register({
      name: "traffic-narrative-peer",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (!result) {
          return Promise.resolve(complete("", open, { id: created?.id }));
        }
        peerRead = String(result.content);
        return Promise.resolve(
          complete(
            '{"summary":"Reviewed the retained traffic narrative.","followUps":[]}',
          ),
        );
      },
    });
    peerModel.setDefault("traffic-narrative-peer");

    planner = createSentinelModelPlanner(
      path,
      (current, taskId, lease) => {
        if (taskId) sourceTask ??= taskId;
        return createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          ...(taskId
            ? { assignedTaskId: taskId, assignedTaskLeaseToken: lease }
            : { plannerExecutionEvidenceRunId: runId }),
          providerRegistry: taskId
            ? (taskId === sourceTask ? sourceModel : peerModel)
            : plannerModel,
          hookRunner: hooks,
          allowModelAccess: true,
        });
      },
      () => () => {},
      () => Date.now() + wakeOffset,
    );
    coordinator = startSentinelAssessmentCoordinator({
      snapshotPath: path,
      advanceAdaptive(current) {
        advanceAdaptiveSentinel(path, current);
        planner!.advance(current);
      },
      stopAdaptive: () => planner!.stop(),
    });
    const adaptive = () => readAdaptiveSentinel(path, state, "revision");
    await waitFor(
      "source prepared and initial plan settled",
      () => sourceWaiting && !!adaptive()?.modelPlannerHistory[0]?.finished,
    );
    publication.resolve();
    await waitFor(
      "worker received publication result",
      () => !!publicationResult,
    );
    assert(publicationResult?.startsWith("{"), publicationResult);
    await waitFor(
      "planner reopened exact published traffic narrative",
      () => !!planned,
    );
    assertEquals(JSON.parse(planned!), created);
    const id = created!.id as string;
    await waitFor(
      "same-asset follow-up retains the narrative reference",
      () =>
        !!adaptive()?.tasks.some(({ plannerRound }) =>
          plannerRound?.workerNarrativeId === id
        ),
    );
    assertEquals(sourceFinished, false);
    const saved = readAdaptiveWorkerNarrative(
      join(dirname(path), "sentinel-adaptive.db"),
      runId,
      state.revision,
      { id },
    );
    assertEquals(saved?.receipt, created?.receipt);
    assertEquals(saved?.stepIndex, 0);
    await waitFor(
      "leased peer reopened the exact narrative while producer was active",
      () => !!peerRead,
    );
    assertEquals(JSON.parse(peerRead!), created);
    assertEquals(sourceFinished, false);
    assertEquals(scopeDenials, 0);
    const selected = { kind: "sentinel", id: caseId, revision: state.revision };
    const selection = {
      ...selected,
      action: "node",
      node: `observation:adaptive:${id}`,
    };
    const archiveId = crypto.randomUUID();
    await coordinator.stop();
    finishSource.resolve();
    await waitFor(
      "producer interrupted cleanly before archive",
      () => !planner?.hasInFlightWork(),
    );
    await ownerGateway(baseDir, hooks, async (turn) => {
      const opened = await turn(selection);
      assert(
        opened.startsWith("{"),
        JSON.stringify({
          opened,
          run: await turn({ ...selected, action: "inspect" }),
        }),
      );
      assertEquals(
        JSON.parse(opened).page.node.workerNarrative,
        saved,
      );
      allowTraffic = false;
      assertStringIncludes(await turn(selection), "unavailable");
      assert(scopeDenials > 0);
      allowTraffic = true;
      assertEquals(
        JSON.parse(await turn({ ...selected, action: "cancel", runId })).run
          .status,
        "stopped",
      );
      const archive = await turn({
        ...selected,
        action: "archive",
        runId,
        requestId: archiveId,
      });
      assertEquals(JSON.parse(archive).receipt.status, "succeeded");
    });
    await Deno.rename(dirname(path), join(baseDir, "before-restore"));
    const directory = join(baseDir, "data", "run-archives", archiveId);
    const manifest = JSON.parse(
      await Deno.readTextFile(join(directory, "manifest.json")),
    );
    const altered = join(baseDir, "altered-traffic.db");
    const trafficName = "sentinel-traffic-receipts.db";
    await Deno.copyFile(join(directory, trafficName), altered);
    const journal = new DatabaseSync(altered);
    try {
      journal.exec("DELETE FROM traffic_receipts_v1");
    } finally {
      journal.close();
    }
    const damaged = join(baseDir, "traffic-archive-missing-source");
    await writeRunArchive(
      damaged,
      manifest.identity,
      manifest.artifacts.map(({ name }: { name: string }) => ({
        name,
        sourcePath: name === trafficName ? altered : join(directory, name),
      })),
      permittedSentinelRestoreArtifacts,
    );
    await assertRejects(
      () =>
        withVerifiedRunArchive(damaged, baseDir, {
          expectedKind: "sentinel",
          permittedNames: permittedSentinelRestoreArtifacts,
        }, (archive) => restoreVerifiedSentinelCaseArchive(baseDir, archive)),
      Error,
      "Invalid archived Sentinel worker observation",
    );
    await assertRejects(() => Deno.lstat(dirname(path)), Deno.errors.NotFound);
    await ownerGateway(baseDir, hooks, async (turn, session) => {
      const restored = await turn({
        ...selected,
        action: "restore",
        runId,
        archiveId,
        requestId: crypto.randomUUID(),
      });
      assert(restored.startsWith("{"), restored);
      assertEquals(JSON.parse(restored).receipt.status, "succeeded");
      assertEquals(
        JSON.parse(await turn(selection)).page.node.workerNarrative,
        saved,
      );
      const pool = () =>
        tidepoolNarrative(
          baseDir,
          session,
          caseId,
          state.revision,
          selection.node,
        );
      const visible = await pool();
      assertEquals(visible.type, "sentinel_revision", JSON.stringify(visible));
      assertStringIncludes(JSON.stringify(visible), id);
      allowTraffic = false;
      assertStringIncludes(await turn(selection), "unavailable");
      const denied = await pool();
      assert(denied.type !== "sentinel_revision");
      assert(!JSON.stringify(denied).includes(id));
    });
  } finally {
    finishSource.resolve();
    publication.resolve();
    await coordinator?.stop();
    planner?.stop();
    await waitFor(
      "traffic fixture shuts down",
      () => !planner?.hasInFlightWork(),
    );
    await Deno.remove(baseDir, { recursive: true });
  }
});
