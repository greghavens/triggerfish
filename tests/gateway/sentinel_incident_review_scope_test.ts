import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  readSentinelIncidentReviews,
  readSentinelOperatingConstraints,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { readSavedSentinelIncidentCandidates } from "../../src/sentinel/incident_archive.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { createA2UIHost } from "../../src/tools/tidepool/host/host.ts";

async function waitFor(label: string, ready: () => boolean) {
  const deadline = performance.now() + 4_000;
  while (!ready() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(ready(), label);
}

Deno.test("Selected Sentinel incident reviews recheck every member and wake planning exactly once", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "scoped-incident-reviews";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const graph = {
    version: 1,
    nodes: [
      { id: "app", kind: "asset", label: "Application" },
      { id: "proxy", kind: "asset", label: "Proxy" },
      { id: "private", kind: "asset", label: "Private dependency" },
    ],
    edges: [{ from: "proxy", to: "private", relation: "depends_on" }],
  };
  const alert = (
    type: string,
    asset: string,
    hour: string,
    evidenceId: string,
  ) => ({
    type,
    asset,
    subject: "Fixture operator",
    observedAt: `2026-01-01T${hour}:00:00.000Z`,
    evidenceIds: [evidenceId],
    severity: type === "authentication_failure_burst" ? "medium" : "high",
  });
  let planner: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let coordinator:
    | ReturnType<typeof startSentinelAssessmentCoordinator>
    | undefined;
  let request: Record<string, unknown> | undefined;
  let result = "";
  let revokeDuringApproval = false;
  let approvalCount = 0;
  let wakeOffset = 0;
  let planRounds = 0;
  let scopedWriteCalls = 0;
  const confirmations: string[] = [];
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(graph), { mode: 0o600 });
    await Deno.writeTextFile(
      sentinelAlertsPath(path),
      JSON.stringify([
        alert("network_security_alert", "app", "00", "app-network"),
        alert("authentication_failure_burst", "app", "00", "app-auth"),
        alert("network_security_alert", "proxy", "01", "proxy-network"),
        alert("authentication_failure_burst", "private", "01", "private-auth"),
      ]),
      { mode: 0o600 },
    );
    let state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const incidents = readSavedSentinelIncidentCandidates(path, state.revision);
    const allowed = incidents.find(({ asset }) => asset === "app");
    const mixed = incidents.find(({ id }) => id !== allowed?.id);
    assert(typeof allowed?.id === "string" && typeof mixed?.id === "string");
    const setAssets = (allowedAssetIds: string[]) => {
      assert(recordSentinelOperatingConstraints(path, {
        runId,
        evidenceRevision: state.revision,
        expectedVersion:
          readSentinelOperatingConstraints(path, runId)?.version ?? 0,
        requestId: crypto.randomUUID(),
        operatorScope: "fixture-owner",
        constraints: { allowedAssetIds, deniedKinds: [] },
      }));
    };
    const reviews = () =>
      readSentinelIncidentReviews(path, state.revision, { fullHistory: true });
    const registry = createProviderRegistry();
    registry.register({
      name: "scoped-incident-owner",
      supportsStreaming: false,
      complete(messages, tools) {
        const last = messages.at(-1);
        if (last?.role === "tool") result = String(last.content);
        if (request && last?.role !== "tool") {
          const offered = tools.find((definition) =>
            (definition as { function?: { name?: string } }).function?.name ===
              "operator_runs"
          );
          assert(offered);
        }
        return Promise.resolve({
          content: last?.role === "tool" ? "Reviewed the decision." : "",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: last?.role === "tool" || !request ? [] : [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(request),
            },
          }],
        });
      },
    });
    registry.setDefault("scoped-incident-owner");
    const connect = async (
      body: (
        turn: (input: string | Record<string, unknown>) => Promise<string>,
      ) => Promise<void>,
    ) => {
      const token = crypto.randomUUID();
      const gateway = createGatewayServer({
        token,
        port: 0,
        chatSession: createChatSession({
          session: createSession({
            userId: "owner" as UserId,
            channelId: "fixture" as ChannelId,
          }),
          providerRegistry: registry,
          allowSentinelModelAccess: true,
          sentinelSnapshotPath: resolveSentinelCasePath(baseDir),
          resolveSentinelChatCase: (id) => id === caseId ? path : undefined,
          operatorRunExecutor: createOperatorRunToolExecutor({
            baseDir,
            confirm(prompt) {
              approvalCount++;
              confirmations.push(prompt);
              if (revokeDuringApproval) {
                revokeDuringApproval = false;
                setAssets(["app", "proxy"]);
              }
              return Promise.resolve(true);
            },
          }),
          hookRunner: {
            evaluateHook(hook, { input }) {
              const call = input.tool_call as
                | { args?: Record<string, unknown> }
                | undefined;
              if (
                hook === "PRE_TOOL_CALL" &&
                call?.args?.action === "review_incident" &&
                input.case_id !== undefined
              ) {
                assertEquals(input.case_id, caseId);
                assertEquals(input.evidence_revision, call.args.revision);
                assertEquals(input.operation_type, "write");
                scopedWriteCalls++;
              }
              return Promise.resolve({
                allowed: true,
                action: "ALLOW",
                ruleId: null,
                duration: 0,
              });
            },
          },
        }),
      });
      const { port } = await gateway.start();
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/chat?token=${token}`,
      );
      const closed = Promise.withResolvers<void>();
      socket.addEventListener("close", () => closed.resolve(), { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        await body(async (input) => {
          request = typeof input === "string" ? undefined : input;
          result = "";
          const done = Promise.withResolvers<void>();
          const timer = setTimeout(
            () => done.reject(new Error("No incident review reply")),
            3_000,
          );
          const receive = ({ data }: MessageEvent) => {
            const frame = JSON.parse(data);
            if (
              frame.type === "turn_end" || frame.type === "response" ||
              frame.type === "error"
            ) {
              done.resolve();
            }
          };
          socket.addEventListener("message", receive);
          try {
            socket.send(
              JSON.stringify({
                type: "message",
                content: typeof input === "string"
                  ? input
                  : "Review the exact incident.",
              }),
            );
            await done.promise;
            return result;
          } finally {
            clearTimeout(timer);
            socket.removeEventListener("message", receive);
          }
        });
      } finally {
        socket.close();
        await closed.promise;
        await gateway.stop();
      }
    };
    planner = createSentinelModelPlanner(
      path,
      (_current, taskId) => ({
        execute(_prompt, send) {
          if (!taskId) {
            planRounds++;
            wakeOffset = 58_750;
            send({ type: "response", text: "[]", taint: "INTERNAL" });
          }
          return Promise.resolve();
        },
        clear() {},
      }),
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
    const runtime = () => readAdaptiveSentinel(path, state, "revision");
    await waitFor(
      "initial planner round settles",
      () => !!runtime()?.modelPlannerHistory[0]?.finished,
    );
    const ref = { kind: "sentinel", id: caseId, revision: state.revision };
    const mixedReview = {
      ...ref,
      runId,
      action: "review_incident",
      incidentId: mixed.id,
      disposition: "investigating",
      note: "Review the exact mixed incident.",
      requestId: crypto.randomUUID(),
    };
    const allowedReview = {
      ...mixedReview,
      incidentId: allowed.id,
      disposition: "resolved",
      note: "The exact approved cohort was reviewed.",
      requestId: crypto.randomUUID(),
    };
    let saved: unknown;
    await connect(async (turn) => {
      // Ordinary owner route must apply the same exact scope after confirmation.
      revokeDuringApproval = true;
      assertStringIncludes(await turn(mixedReview), "unavailable");
      assertEquals(approvalCount, 1);
      assert(confirmations[0]?.includes('"assetIds":["private","proxy"]'));
      assertEquals(reviews(), []);
      assertStringIncludes(await turn(mixedReview), "unavailable");
      assertEquals(approvalCount, 1);

      await turn("/sentinel on");
      await turn(`/sentinel case ${caseId}`);
      assertStringIncludes(await turn(mixedReview), "unavailable");
      assertEquals(approvalCount, 1);
      const response = await turn(allowedReview);
      assert(response.startsWith("{"), response);
      saved = JSON.parse(response).review;
      assertEquals(reviews(), [saved]);
      assertEquals(approvalCount, 2);
      assert(scopedWriteCalls > 0);
      assert(confirmations.at(-1)?.includes('"assetIds":["app"]'));
      const replay = await turn(allowedReview);
      assert(replay.startsWith("{"), replay);
      assertEquals(JSON.parse(replay).review, saved);
      assertEquals(approvalCount, 2);
    });
    await waitFor(
      "committed decision wakes the planner with its saved review ID",
      () => {
        const review = reviews()[0];
        return !!review &&
          runtime()?.modelPlannerHistory.some(({ inputManifest }) =>
              inputManifest?.incidentReviewIds?.includes(review.id)
            ) === true;
      },
    );
    assert(planRounds >= 2);
    const reviewId = reviews()[0].id;
    assertEquals(
      runtime()?.modelPlannerHistory.filter(({ inputManifest }) =>
        inputManifest?.incidentReviewIds?.includes(reviewId)
      ).length,
      1,
    );
    await connect(async (turn) => {
      const reopened = await turn(allowedReview);
      assert(reopened.startsWith("{"), reopened);
      assertEquals(JSON.parse(reopened).review, saved);
      assertEquals(approvalCount, 2);
      setAssets(["proxy"]);
      assertStringIncludes(await turn(allowedReview), "unavailable");
      assertStringIncludes(
        await turn({
          ...ref,
          action: "decision_history",
          incidentId: allowed.id,
        }),
        "unavailable",
      );
      assertEquals(reviews(), [saved]);
    });

    // The native authenticated Tidepool review route must protect the same write.
    const key = crypto.randomUUID();
    const host = createA2UIHost({ sessionKey: key });
    host.registerTopicHandler(
      "sentinel",
      createTidepoolSentinelHandler({
        baseDir,
        config: { sentinel: { allow_model_access: true } },
      } as BootstrapResult),
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
      const pending = Promise.withResolvers<Record<string, unknown>>();
      const timer = setTimeout(
        () => pending.reject(new Error("No Tidepool denial")),
        3_000,
      );
      socket.addEventListener("message", ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.requestId === 1) pending.resolve(frame);
      });
      socket.send(JSON.stringify({
        topic: "sentinel",
        type: "review_incident",
        requestId: 1,
        caseId,
        revision: state.revision,
        incidentId: allowed.id,
        disposition: "dismissed",
        note: "A revoked incident cannot be reviewed.",
      }));
      const denied = await pending.promise.finally(() => clearTimeout(timer));
      assertStringIncludes(JSON.stringify(denied), "current revision");
      assertEquals(reviews(), [saved]);
    } finally {
      socket.close();
      await closed.promise;
      await host.stop();
    }
    await coordinator.stop();
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...graph,
        nodes: [...graph.nodes, {
          id: "rollover",
          kind: "asset",
          label: "Later",
        }],
      }),
    );
    const updated = refreshSentinelAssessment(path);
    assert(updated && updated.revision > state.revision);
    state = updated;
    await connect(async (turn) => {
      assertStringIncludes(
        await turn({ ...mixedReview, requestId: crypto.randomUUID() }),
        "unavailable",
      );
      assertStringIncludes(await turn(allowedReview), "unavailable");
      assertEquals(approvalCount, 2);
    });
  } finally {
    await coordinator?.stop();
    planner?.stop();
    await waitFor("planner shuts down", () => !planner?.hasInFlightWork());
    await Deno.remove(baseDir, { recursive: true });
  }
});
