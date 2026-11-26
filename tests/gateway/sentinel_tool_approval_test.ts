import { assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  withVerifiedRunArchive,
  writeRunArchive,
} from "../../src/core/run_archive.ts";
import { captureStoppedSentinelCaseArtifacts } from "../../src/sentinel/case_archive_capture.ts";
import {
  permittedSentinelRestoreArtifacts,
  requiredSentinelRestoreArtifacts,
  restoreVerifiedSentinelCaseArchive,
} from "../../src/sentinel/sentinel_archive_restore.ts";
import { sentinelIncidentRecommendationToolName } from "../../src/core/sentinel_incident_review_intent.ts";
import { startSentinelAssessmentCoordinator } from "../../src/gateway/sentinel_assessment_service.ts";
import { readSavedSentinelIncidentCandidates } from "../../src/sentinel/incident_archive.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { sentinelPlannerFindingToolName } from "../../src/core/sentinel_finding_review_intent.ts";
import { readSentinelWorkerFindingHistory } from "../../src/sentinel/worker_finding_store.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { ApprovalInboxRecord } from "../../src/core/approval_inbox.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { createToolApprovalService } from "../../src/core/tool_approval_service.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
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
  readSentinelDecisionHistory,
  readSentinelIncidentReviews,
  readSentinelOperatorReviewRequest,
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { listSentinelPlannerGraphFacts } from "../../src/sentinel/worker_graph_facts.ts";

const assigned = "sentinel_assigned_target";
const publish = "sentinel_publish_graph_fact";
const relationship = {
  from: "fixture-evidence",
  to: "service",
  relation: "observed_on",
};

async function connect(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  async function request(input: Record<string, unknown>) {
    const requestId = crypto.randomUUID();
    const ready = Promise.withResolvers<Record<string, unknown>>();
    const deadline = setTimeout(
      () => ready.reject(new Error("No approval inbox socket reply")),
      2000,
    );
    function receive({ data }: MessageEvent) {
      const message = JSON.parse(data);
      if (
        message.type === "approval_inbox_result" &&
        message.requestId === requestId
      ) {
        ready.resolve(message);
      }
    }
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ ...input, requestId }));
    try {
      return await ready.promise;
    } finally {
      clearTimeout(deadline);
      socket.removeEventListener("message", receive);
    }
  }
  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener(
        "close",
        () => resolve(),
        { once: true },
      )
    );
    socket.close();
    await closed;
  }
  return { request, close };
}

async function pendingInbox(socket: Awaited<ReturnType<typeof connect>>) {
  for (let index = 0; index < 75; index++) {
    const message = await socket.request({ type: "approval_inbox_list" });
    assertEquals(message.ok, true);
    const records =
      (message.result as { records: ApprovalInboxRecord[] }).records;
    const found = records.find(({ status }) => status === "pending");
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The agent did not reach approval");
}

for (
  const outcome of [
    "approve",
    "deny",
    "stale-constraints",
    "stale-lease",
  ] as const
) {
  Deno.test(`Leased Sentinel approval inbox applies exact ${outcome} on a reconnected operator socket`, async () => {
    const baseDir = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(baseDir);
    const toolApprovalInbox = createToolApprovalService(
      join(baseDir, "approvals.db"),
    );
    const token = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const rechecking = Promise.withResolvers<void>();
    const releaseRecheck = Promise.withResolvers<void>();
    let policyChecks = 0;
    const hooks: HookRunner = {
      toolApprovalInbox,
      async evaluateHook(hook, { input }) {
        const call = input.tool_call as { name?: string } | undefined;
        const requires = hook === "PRE_TOOL_CALL" && call?.name === publish;
        if (requires && ++policyChecks === 2) {
          rechecking.resolve();
          await releaseRecheck.promise;
        }
        return {
          allowed: !requires,
          action: requires ? "REQUIRE_APPROVAL" : "ALLOW",
          ruleId: requires ? "fixture-graph-approval" : null,
          duration: 0,
        };
      },
    };
    const providerRegistry = createProviderRegistry();
    let iterations = 0;
    let result = "";
    providerRegistry.register({
      name: "leased-approval-fixture",
      supportsStreaming: false,
      complete(messages) {
        const count = iterations++;
        if (count < 2) {
          return Promise.resolve({
            usage: { inputTokens: 1, outputTokens: 1 },
            content: "",
            toolCalls: [{
              id: `fixture-${count}`,
              type: "function",
              function: count === 0 ? { name: assigned, arguments: "{}" } : {
                name: publish,
                arguments: JSON.stringify({ ...relationship, requestId }),
              },
            }],
          });
        }
        assertEquals(count, 2);
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
        return Promise.resolve({
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
          content:
            '{"summary":"Finished the requested defensive review.","followUps":[]}',
        });
      },
    });
    providerRegistry.setDefault("leased-approval-fixture");
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      }),
      providerRegistry,
      hookRunner: hooks,
      enableStreaming: false,
    });
    const gateway = createGatewayServer({ port: 0, token, chatSession });
    let original: Awaited<ReturnType<typeof connect>> | undefined;
    let reopened: Awaited<ReturnType<typeof connect>> | undefined;
    let job: Promise<void> | undefined;
    let clear: (() => void) | undefined;
    try {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [
            { id: "service", kind: "asset", label: "Service" },
            {
              id: "fixture-evidence",
              kind: "evidence",
              label: "Retained expected record",
            },
          ],
          edges: [relationship],
        }),
      );
      const state = startSentinelAssessment(path);
      const { runId } = state.plan;
      assert(runId);
      const scope = { caseId: "main", runId, evidenceRevision: state.revision };
      advanceAdaptiveSentinel(path, state);
      const revision = adaptiveRevision(state);
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        store.sync(revision, [{
          kind: "impact",
          nodeId: "service",
          reason: MODEL_ASSIGNMENT_REASON,
        }], revision);
        advanceAdaptiveSentinel(path, state);
        const lease = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) => task.kind === "impact" && task.nodeId === "service",
        );
        assert(lease);
        const agent = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: lease.task.id,
          assignedTaskLeaseToken: lease.token,
          providerRegistry,
          hookRunner: hooks,
          allowModelAccess: true,
        });
        clear = () => agent.clear();
        job = agent.execute(
          "Publish the exact approved relationship.",
          () => {},
        );
        const { port } = await gateway.start();
        original = await connect(port, token);
        const entry = await pendingInbox(original);
        assertEquals(entry.runId, runId);
        assertEquals(entry.assignmentId, lease.task.id);
        assertEquals(entry.tool, publish);
        assert(!JSON.stringify(entry).includes("fixture-evidence"));
        assert(!JSON.stringify(entry).includes(requestId));
        assertEquals(listSentinelPlannerGraphFacts(path, scope), []);
        await original.close();
        reopened = await connect(port, token);
        assertEquals((await pendingInbox(reopened)).id, entry.id);
        if (outcome === "stale-constraints") {
          assert(recordSentinelOperatingConstraints(path, {
            evidenceRevision: state.revision,
            runId,
            expectedVersion: 0,
            requestId: crypto.randomUUID(),
            operatorScope: "workspace-operator",
            constraints: { deniedKinds: ["review_incident"] },
          }));
        }
        const decision = await reopened.request({
          type: "approval_inbox_decide",
          approvalId: entry.id,
          approved: outcome !== "deny",
        });
        assertEquals(decision.ok, true);
        if (outcome !== "deny") {
          await rechecking.promise;
          assertEquals(
            (await reopened.request({
              type: "approval_inbox_decide",
              approvalId: entry.id,
              approved: true,
            })).ok,
            true,
          );
          if (outcome === "stale-lease") {
            assert(store.requestModelReviewControl(
              revision,
              lease.task.id,
              crypto.randomUUID(),
              "stop",
            ));
          }
          releaseRecheck.resolve();
        }
        await job;
        const facts = listSentinelPlannerGraphFacts(path, scope);
        if (outcome === "approve") {
          assertEquals(facts.length, 1);
          assertEquals(facts[0].relationship, relationship);
          assertEquals(JSON.parse(result).id, facts[0].id);
        } else {
          assertEquals(facts, []);
          if (outcome === "deny") {
            assertStringIncludes(result.toLowerCase(), "approval");
          }
        }
        const terminal = toolApprovalInbox.list().records.find(({ id }) =>
          id === entry.id
        );
        assertEquals(
          terminal?.status,
          outcome === "approve"
            ? "completed"
            : outcome === "deny"
            ? "denied"
            : "stale",
        );
      } finally {
        store.close();
      }
    } finally {
      releaseRecheck.resolve();
      clear?.();
      await job;
      await reopened?.close();
      await original?.close();
      await gateway.stop();
      await Deno.remove(baseDir, { recursive: true });
    }
  });
}

for (
  const [action, outcome] of [
    ["stop", "approved"],
    ["stop", "denied"],
    ["stop", "replaced-lease"],
    ["stop", "revoked-policy"],
    ["steer", "approved"],
    ["steer", "denied"],
    ["steer", "replaced-lease"],
    ["steer", "unsafe-note"],
  ] as const
) {
  Deno.test(`Planner ${action} request honors ${outcome} through the reconnected owner approval inbox`, async () => {
    const baseDir = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(baseDir);
    const file = join(dirname(path), "sentinel-adaptive.db");
    const toolApprovalInbox = createToolApprovalService(
      join(baseDir, "approvals.db"),
    );
    const token = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const name = `sentinel_request_worker_${action}`;
    const steeringNote = outcome === "unsafe-note"
      ? "Bearer fake_fixture_credential"
      : "Summarize the service evidence already returned.";
    const activeWorker = action === "steer" && outcome === "approved";
    const hooksSeen: string[] = [];
    let policyRevoked = false;
    let withheldReceipt = false;
    const hookRunner: HookRunner = {
      toolApprovalInbox,
      evaluateHook(hook, { input, auditInput }) {
        if (input.tool_name === name) {
          hooksSeen.push(hook);
          assert(!JSON.stringify(auditInput ?? {}).includes(steeringNote));
          assertEquals(input.case_id, "main");
          assertEquals(input.resource_classification, "INTERNAL");
        }
        if (
          hook === "PRE_OUTPUT" && typeof input.content === "string" &&
          input.content.includes(requestId) &&
          input.content.includes('"receipt"')
        ) {
          assertEquals(input.target_classification, "INTERNAL");
          withheldReceipt = true;
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: "withhold-receipt",
            duration: 0,
          });
        }
        const allowed = !(policyRevoked && hook === "PRE_TOOL_CALL" &&
          input.tool_name === name);
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          ruleId: null,
          duration: 0,
        });
      },
    };
    const completed = Promise.withResolvers<string>();
    const providerRegistry = createProviderRegistry();
    let plannerOffers = 0;
    let selectedTask = "";
    providerRegistry.register({
      name: "planner-stop-fixture",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (result) {
          completed.resolve(String(result.content));
          return Promise.resolve({
            content: "[]",
            usage: { inputTokens: 1, outputTokens: 1 },
            toolCalls: [],
          });
        }
        const input = messages.findLast(({ role }) => role === "user");
        const candidates =
          JSON.parse(String(input?.content).split("\n").at(-1)!)
            .runningWorkerAttempts;
        assertEquals(candidates, [{ taskId: selectedTask, attempt: 1 }]);
        plannerOffers++;
        return Promise.resolve({
          usage: { inputTokens: 1, outputTokens: 1 },
          content: "",
          toolCalls: [{
            id: "stop-reviewed-worker",
            type: "function",
            function: {
              name,
              arguments: JSON.stringify({
                ...candidates[0],
                requestId,
                ...(action === "steer" && { note: steeringNote }),
              }),
            },
          }],
        });
      },
    });
    providerRegistry.setDefault("planner-stop-fixture");
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "test" as ChannelId,
      }),
      providerRegistry,
      hookRunner,
      enableStreaming: false,
    });
    const gateway = createGatewayServer({ port: 0, token, chatSession });
    const planner = createSentinelModelPlanner(
      path,
      (state, taskId, leaseToken, role) => {
        assertEquals(role, "planner");
        assertEquals(taskId, undefined);
        assertEquals(leaseToken, undefined);
        return createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          plannerExecutionEvidenceRunId: state.plan.runId,
          providerRegistry,
          hookRunner,
          allowModelAccess: true,
        });
      },
    );
    const reachedBoundary = Promise.withResolvers<void>();
    const releaseBoundary = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    let activeLease: { id: string; token: string } | undefined;
    let committedWorkerResult: unknown;
    const workerProvider = createProviderRegistry();
    workerProvider.register({
      name: "worker-steering",
      supportsStreaming: false,
      async complete(messages) {
        const result = messages.filter(({ role }) => role === "tool");
        const instructions = messages.filter(({ content }) =>
          String(content).includes(steeringNote)
        );
        const usage = { inputTokens: 1, outputTokens: 1 };
        const read = (id: string) => ({
          content: "",
          usage,
          toolCalls: [{
            id,
            type: "function",
            function: { name: assigned, arguments: "{}" },
          }],
        });
        if (!result.length) return read("original-record");
        assertEquals(result.length, 1);
        if (!instructions.length) {
          committedWorkerResult = result[0].content;
          reachedBoundary.resolve();
          await releaseBoundary.promise;
          return read("superseded-worker-step");
        }
        assertEquals(result[0].content, committedWorkerResult);
        assertEquals(instructions.length, 1);
        delivered.resolve();
        return {
          content: '{"summary":"Reviewed the saved evidence.","followUps":[]}',
          usage,
          toolCalls: [],
        };
      },
    });
    workerProvider.setDefault("worker-steering");
    const reviewer = activeWorker
      ? createSentinelModelPlanner(
        path,
        (state, taskId, token) => {
          if (!taskId || !token) {
            return {
              clear() {},
              execute() {
                return Promise.resolve();
              },
            };
          }
          activeLease = { id: taskId, token };
          return createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: state.revision,
            assignedTaskId: taskId,
            assignedTaskLeaseToken: token,
            providerRegistry: workerProvider,
            hookRunner,
            allowModelAccess: true,
          });
        },
      )
      : undefined;
    let initialSocket: Awaited<ReturnType<typeof connect>> | undefined;
    let reconnected: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "service", kind: "asset", label: "Service" }],
          edges: [],
        }),
      );
      const state = startSentinelAssessment(path);
      const runId = state.plan.runId;
      assert(runId);
      advanceAdaptiveSentinel(path, state);
      const revision = adaptiveRevision(state);
      const store = openSentinelAdaptiveStore(file);
      try {
        store.sync(revision, [{
          kind: "impact",
          nodeId: "service",
          reason: MODEL_ASSIGNMENT_REASON,
        }], revision);
        advanceAdaptiveSentinel(path, state);
        if (reviewer) {
          reviewer.advance(state);
          await reachedBoundary.promise;
        }
        const claimed = !reviewer && store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          ({ nodeId }) => nodeId === "service",
        );
        const lease = claimed
          ? { id: claimed.task.id, token: claimed.token }
          : activeLease;
        assert(lease);
        selectedTask = lease.id;
        const { port } = await gateway.start();
        initialSocket = await connect(port, token);
        planner.advance(state);
        if (outcome === "unsafe-note") {
          const timeout = AbortSignal.timeout(2500);
          const result = await Promise.race([
            completed.promise,
            new Promise<never>((_, reject) =>
              timeout.addEventListener("abort", () => reject(timeout.reason), {
                once: true,
              })
            ),
          ]);
          assert(!result.includes(steeringNote));
          assertEquals(
            (await initialSocket.request({ type: "approval_inbox_list" }))
              .result,
            { records: [], nextBefore: null },
          );
          assertEquals(
            store.modelReviewControls(revision, selectedTask).steering,
            [],
          );
          return;
        }

        const entry = await pendingInbox(initialSocket);
        assertEquals(entry.assignmentId, selectedTask);
        assertEquals(entry.runId, runId);
        assertEquals(entry.tool, name);
        assertStringIncludes(entry.description, selectedTask);
        assertEquals(
          toolApprovalInbox.list().records.find(({ id }) => id === entry.id)
            ?.sentinelSteeringNote,
          action === "steer" ? steeringNote : undefined,
        );
        if (action === "steer") {
          assertStringIncludes(entry.description, steeringNote);
        }
        assert(!JSON.stringify(entry).includes(lease.token));
        assertEquals(
          store.modelReviewControls(revision, selectedTask).stopped,
          false,
        );
        await initialSocket.close();
        reconnected = await connect(port, token);
        assertEquals(await pendingInbox(reconnected), entry);
        if (outcome === "replaced-lease") {
          assert(
            store.finishModelReview(
              revision,
              selectedTask,
              lease.token,
              "interrupted",
            ),
          );
          const replacement = store.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            ({ id }) => id === selectedTask,
          );
          assert(replacement && replacement.token !== lease.token);
          assertEquals(
            store.modelReviewStates(revision).find(({ taskId }) =>
              taskId === selectedTask
            )?.attempts,
            1,
          );
        }
        policyRevoked = outcome === "revoked-policy";
        const decide = {
          type: "approval_inbox_decide",
          approvalId: entry.id,
          approved: outcome !== "denied",
        };
        assertEquals((await reconnected.request(decide)).ok, true);
        const timeout = AbortSignal.timeout(2500);
        const result = await Promise.race([
          completed.promise,
          new Promise<never>((_, reject) =>
            timeout.addEventListener("abort", () => reject(timeout.reason), {
              once: true,
            })
          ),
        ]);
        assertEquals(plannerOffers, 1);
        const controls = store.modelReviewControls(revision, selectedTask);
        const terminal = toolApprovalInbox.list().records.find(({ id }) =>
          id === entry.id
        );
        if (outcome === "approved") {
          assertEquals(controls.stopped, action === "stop");
          assertEquals(JSON.parse(result).receipt.taskId, selectedTask);
          assertEquals(JSON.parse(result).receipt.requestId, requestId);
          assert(hooksSeen.includes("POST_TOOL_RESPONSE"));
          assert(withheldReceipt);
          assertEquals(terminal?.status, "completed");
          assertEquals((await reconnected.request(decide)).ok, true);
          if (action === "steer") {
            assertEquals(controls.steering.length, 1);
            assertEquals(controls.steering[0].note, steeringNote);
            assertEquals(JSON.parse(result).receipt.note, steeringNote);
            releaseBoundary.resolve();
            await delivered.promise;
            assertEquals(
              store.modelReviewControls(revision, selectedTask).steering.length,
              1,
            );
          } else {
            assert(
              store.finishModelReview(
                revision,
                selectedTask,
                lease.token,
                "interrupted",
              ),
            );
            assertEquals(
              store.claimModelReview(
                revision,
                MODEL_ASSIGNMENT_REASON,
                ({ id }) => id === selectedTask,
              ),
              null,
            );
          }
        } else {
          assertEquals(controls.stopped, false);
          assertEquals(controls.steering.length, 0);
          assertStringIncludes(result.toLowerCase(), "approval");
          assertEquals(
            terminal?.status,
            outcome === "denied" ? "denied" : "stale",
          );
        }
      } finally {
        store.close();
      }
    } finally {
      releaseBoundary.resolve();
      reviewer?.stop();
      planner.stop();
      await reconnected?.close();
      await initialSocket?.close();
      await gateway.stop();
      await Deno.remove(baseDir, { recursive: true });
    }
  });
}

for (
  const outcome of [
    "approved",
    "denied",
    "stale",
    "revoked-source",
    "without-read",
  ] as const
) {
  Deno.test(`Planner retained finding review enforces ${outcome} through the operator gateway`, async () => {
    const baseDir = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(baseDir);
    const inbox = createToolApprovalService(join(baseDir, "approvals.db"));
    const token = crypto.randomUUID();
    const selected = {
      requestId: crypto.randomUUID(),
      targetId: "app",
      graphFindingId: "gap",
      controlId: "control",
      evidenceId: "check",
      title: "Retained control gap",
      summary: "The exact retained verification reports a failed control.",
    };
    const name = sentinelPlannerFindingToolName;
    const sourceTool = "sentinel_provenance_node";
    const done = Promise.withResolvers<string>();
    let mayAsk = true;
    let denySource = false;
    let stopOutput = 0;
    const findHooks: string[] = [];
    const sourceHooks: string[] = [];
    const hookRunner: HookRunner = {
      toolApprovalInbox: inbox,
      evaluateHook(hook, { input, auditInput }) {
        const tool = input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name;
        if (tool === name) {
          findHooks.push(hook);
          assertEquals(input.resource_classification, "INTERNAL");
          assert(!JSON.stringify(auditInput).includes(selected.summary));
        }
        if (tool === sourceTool) sourceHooks.push(hook);
        const blockedOutput = hook === "PRE_OUTPUT" &&
          String(input.content).includes(selected.summary);
        if (blockedOutput) stopOutput++;
        const block = blockedOutput ||
          (denySource && hook === "PRE_TOOL_CALL" && tool === sourceTool);
        return Promise.resolve({
          allowed: !block,
          action: block ? "BLOCK" : "ALLOW",
          ruleId: null,
          duration: 0,
        });
      },
    };
    const providers = createProviderRegistry();
    providers.register({
      name: "planner-finding",
      supportsStreaming: false,
      complete(messages, tools) {
        const last = messages.findLast(({ role }) => role === "tool");
        const usage = { inputTokens: 1, outputTokens: 1 };
        const call = (tool: string, args: Record<string, unknown>) =>
          Promise.resolve({
            content: "",
            usage,
            toolCalls: [{
              id: crypto.randomUUID(),
              type: "function" as const,
              function: { name: tool, arguments: JSON.stringify(args) },
            }],
          });
        if (last) {
          const response = String(last.content);
          if (
            response.includes('"node"') && response.includes('"evidence:check"')
          ) {
            return call(name, selected);
          }
          mayAsk = false;
          done.resolve(response);
          return Promise.resolve({ content: "[]", usage, toolCalls: [] });
        }
        if (!mayAsk) {
          return Promise.resolve({ content: "[]", usage, toolCalls: [] });
        }
        assert(
          tools?.some((tool) =>
            (tool as { function?: { name?: string } }).function?.name === name
          ),
        );
        return outcome === "without-read"
          ? call(name, selected)
          : call(sourceTool, { node: "evidence:check" });
      },
    });
    providers.setDefault("planner-finding");
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "planner-finding-test" as ChannelId,
      }),
      providerRegistry: providers,
      hookRunner,
      enableStreaming: false,
    });
    const gateway = createGatewayServer({ port: 0, token, chatSession });
    const planner = createSentinelModelPlanner(
      path,
      (state, _, __, role) =>
        role === "planner"
          ? createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: state.revision,
            plannerExecutionEvidenceRunId: state.plan.runId,
            providerRegistry: providers,
            hookRunner,
            allowModelAccess: true,
          })
          : { execute: () => Promise.resolve(), clear() {} },
    );
    let first: Awaited<ReturnType<typeof connect>> | undefined;
    let reconnect: Awaited<ReturnType<typeof connect>> | undefined;
    const deadline = outcome === "approved" ? undefined : setTimeout(
      () => done.reject(new Error("No planner finding response")),
      4000,
    );
    try {
      const now = Date.now();
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [
            { id: "app", kind: "asset", label: "Application" },
            { id: "gap", kind: "finding", label: "Gap", severity: "high" },
            { id: "control", kind: "control", label: "Control" },
            {
              id: "check",
              kind: "evidence",
              label: "Retained local check",
              controlVerification: {
                outcome: "fail",
                observedAt: new Date(now - 60_000).toISOString(),
                validUntil: new Date(now + 3_600_000).toISOString(),
              },
            },
          ],
          edges: [
            { from: "check", to: "app", relation: "observed_on" },
            { from: "gap", to: "app", relation: "affects" },
            { from: "control", to: "gap", relation: "mitigates" },
            { from: "check", to: "control", relation: "verifies" },
          ],
        }),
      );
      const state = startSentinelAssessment(path);
      const runId = state.plan.runId;
      assert(runId);
      advanceAdaptiveSentinel(path, state);
      const { port } = await gateway.start();
      first = await connect(port, token);
      planner.advance(state);
      if (outcome === "without-read") {
        assertStringIncludes(await done.promise, "policy");
        assertEquals(inbox.list().records, []);
        return;
      }
      const pending = await pendingInbox(first);
      assertEquals(pending.runId, runId);
      assertEquals(pending.assignmentId, undefined);
      assertEquals(pending.sentinelFindingReview, selected);
      assertStringIncludes(pending.description, selected.evidenceId);
      assertStringIncludes(pending.description, selected.summary);
      assertEquals(readSentinelWorkerFindingHistory(path, state.revision), []);
      await first.close();
      reconnect = await connect(port, token);
      assertEquals(await pendingInbox(reconnect), pending);
      if (outcome === "stale") {
        assert(recordSentinelOperatingConstraints(path, {
          runId,
          evidenceRevision: state.revision,
          expectedVersion: 0,
          operatorScope: "owner",
          requestId: crypto.randomUUID(),
          constraints: { deniedKinds: ["review_finding"] },
        }));
      }
      denySource = outcome === "revoked-source";
      const decision = {
        type: "approval_inbox_decide",
        approvalId: pending.id,
        approved: outcome !== "denied",
      };
      assertEquals((await reconnect.request(decision)).ok, true);
      if (outcome !== "approved") {
        const output = await done.promise;
        assertStringIncludes(
          output,
          outcome === "revoked-source"
            ? "unavailable"
            : outcome === "stale"
            ? "policy"
            : "approval",
        );
        assertEquals(
          readSentinelWorkerFindingHistory(path, state.revision),
          [],
        );
        return;
      }
      // The committed finding can supersede the current planner turn before its
      // model sees a reply. The journals establish the actual dispatch outcome.
      const readDecision = () =>
        inbox.list().records.find(({ id }) => id === pending.id);
      const settledBy = Date.now() + 4000;
      while (readDecision()?.status !== "completed" && Date.now() < settledBy) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(readDecision()?.dispatchOutcome, "returned");
      const records = readSentinelWorkerFindingHistory(path, state.revision);
      const [approved] = records;
      assert(approved?.kind === "finding" && "analyst" in approved);
      assert(approved.analyst.planner);
      assertEquals(approved.taskId, undefined);
      assertEquals(approved.requestId, selected.requestId);
      assertEquals(approved.analyst.operatorScope, "owner");
      assertEquals(approved.analyst.planner.attempt, 1);
      assertEquals(approved.analyst.planner.approvalId, pending.id);
      assert(
        approved.analyst.planner.identity.startsWith(adaptiveRevision(state)),
      );
      assertEquals(approved.evidenceId, selected.evidenceId);
      assertEquals(records, [approved]);
      assert(
        findHooks.filter((hook) => hook === "PRE_TOOL_CALL").length >= 2,
      );
      assert(findHooks.includes("POST_TOOL_RESPONSE"));
      assert(
        sourceHooks.filter((hook) => hook === "PRE_TOOL_CALL").length >= 2,
      );
      assert(stopOutput > 0);
      assertEquals((await reconnect.request(decision)).ok, true);
      assertEquals(readSentinelWorkerFindingHistory(path, state.revision), [
        approved,
      ]);
    } finally {
      clearTimeout(deadline);
      planner.stop();
      await first?.close();
      await reconnect?.close();
      await gateway.stop();
      await Deno.remove(baseDir, { recursive: true });
    }
  });
}

for (
  const outcome of [
    "approved",
    "denied",
    "revoked",
    "stopped",
    "source-denied",
    "unread",
  ] as const
) {
  Deno.test(`Incident worker disposition ${outcome} uses the exact owner approval inbox`, async () => {
    const baseDir = await Deno.makeTempDir();
    const caseId = "incident-disposition";
    const path = resolveSentinelCasePath(baseDir, caseId);
    const token = crypto.randomUUID();
    const recommendation = sentinelIncidentRecommendationToolName;
    const cohortRead = "sentinel_incident_alerts";
    const inbox = createToolApprovalService(join(baseDir, "approvals.db"));
    let sourceDenied = false;
    let classified = 0;
    let outputDenied = false;
    const outputs: unknown[] = [];
    const hooks: HookRunner = {
      toolApprovalInbox: inbox,
      evaluateHook(hook, { input }) {
        const call = input.tool_call as { name?: string } | undefined;
        const isReviewOutput = hook === "PRE_OUTPUT" &&
          typeof input.content === "string" &&
          input.content.includes("recommendationEvidence");
        if (isReviewOutput) outputDenied = true;
        const blocked = isReviewOutput ||
          sourceDenied && hook === "PRE_TOOL_CALL" &&
            call?.name === cohortRead;
        if (
          hook === "POST_TOOL_RESPONSE" && input.tool_name === recommendation
        ) classified++;
        return Promise.resolve({
          allowed: !blocked,
          action: blocked ? "BLOCK" : "ALLOW",
          ruleId: blocked ? "fixture-incident-source-revoke" : null,
          duration: 0,
        });
      },
    };
    const registry = createProviderRegistry();
    let incidentId = "";
    let result = "";
    const note =
      "Both retained alerts describe an authorized test. Keep investigating.";
    const expected = () => ({ incidentId, disposition: "investigating", note });
    let iterations = 0;
    registry.register({
      name: "leased-incident-recommendation",
      supportsStreaming: false,
      complete(messages) {
        const count = iterations++;
        const tools = outcome === "unread"
          ? [recommendation]
          : outcome === "approved"
          ? [cohortRead, cohortRead, recommendation]
          : [cohortRead, recommendation];
        const name = tools[count];
        if (!name) {
          result = String(
            messages.findLast(({ role }) => role === "tool")?.content,
          );
        }
        return Promise.resolve({
          usage: { inputTokens: 1, outputTokens: 1 },
          content: name
            ? ""
            : '{"summary":"Reviewed the retained alerts.","followUps":[]}',
          toolCalls: name
            ? [{
              id: `incident-${count}`,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  name === cohortRead
                    ? {
                      incidentId,
                      ...(outcome === "approved" &&
                        { offset: count, limit: 1 }),
                    }
                    : expected(),
                ),
              },
            }]
            : [],
        });
      },
    });
    registry.setDefault("leased-incident-recommendation");
    const gateway = createGatewayServer({
      port: 0,
      token,
      chatSession: createChatSession({
        session: createSession({
          userId: "owner" as UserId,
          channelId: "test" as ChannelId,
        }),
        providerRegistry: registry,
        hookRunner: hooks,
        enableStreaming: false,
      }),
    });
    let original: Awaited<ReturnType<typeof connect>> | undefined;
    let reopened: Awaited<ReturnType<typeof connect>> | undefined;
    let agent: ReturnType<typeof createSentinelSubagent> | undefined;
    let job: Promise<void> | undefined;
    let coordinator:
      | ReturnType<typeof startSentinelAssessmentCoordinator>
      | undefined;
    try {
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "app", kind: "asset", label: "Approved App" }],
          edges: [],
        }),
      );
      await Deno.writeTextFile(
        sentinelAlertsPath(path),
        JSON.stringify([
          {
            type: "network_security_alert",
            severity: "high",
            evidenceIds: ["incident-network"],
          },
          {
            type: "authentication_failure_burst",
            severity: "medium",
            evidenceIds: ["incident-auth"],
          },
        ].map((alert) => ({
          ...alert,
          asset: "app",
          subject: "Local defensive fixture",
          observedAt: "2026-01-01T00:00:00.000Z",
        }))),
      );
      const state = startSentinelAssessment(path);
      const { runId } = state.plan;
      assert(runId);
      incidentId = readSavedSentinelIncidentCandidates(path, state.revision)[0]
        ?.id;
      assert(incidentId);
      const revision = adaptiveRevision(state);
      advanceAdaptiveSentinel(path, state);
      const store = openSentinelAdaptiveStore(
        join(dirname(path), "sentinel-adaptive.db"),
      );
      try {
        const lease = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          (task) =>
            task.kind === "review_incident" && task.nodeId === incidentId,
        );
        assert(lease);
        let rounds = 0;
        let wakeOffset = 0;
        const planner = createSentinelModelPlanner(
          path,
          (_current, taskId) => ({
            execute(_prompt, send) {
              if (!taskId) {
                rounds++;
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
        if (outcome === "approved") {
          coordinator = startSentinelAssessmentCoordinator({
            snapshotPath: path,
            advanceAdaptive(current) {
              advanceAdaptiveSentinel(path, current);
              planner.advance(current);
            },
            stopAdaptive: () => planner.stop(),
          });
          const deadline = Date.now() + 3_500;
          while (
            !readAdaptiveSentinel(path, state, "revision")
              ?.modelPlannerHistory[0]?.finished &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assertEquals(rounds, 1);
        }
        agent = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: lease.task.id,
          assignedTaskLeaseToken: lease.token,
          providerRegistry: registry,
          hookRunner: hooks,
          allowModelAccess: true,
        });
        const { port } = await gateway.start();
        original = await connect(port, token);
        job = agent.execute(
          "Review the exact incident and recommend a disposition.",
          (event) => outputs.push(event),
        );
        const reviews = () =>
          readSentinelIncidentReviews(path, state.revision, {
            fullHistory: true,
          });
        if (outcome === "unread") {
          await job;
          assertEquals(inbox.list().records, []);
          assertEquals(reviews(), []);
          return;
        }
        const pending = await pendingInbox(original);
        assertEquals(pending.sentinelIncidentRecommendation, expected());
        assertEquals(pending.assignmentId, lease.task.id);
        assertEquals(pending.runId, runId);
        assert(!JSON.stringify(pending).includes("incident-network"));
        assertEquals(reviews(), []);
        await original.close();
        reopened = await connect(port, token);
        assertEquals(await pendingInbox(reopened), pending);
        if (outcome === "revoked") {
          assert(recordSentinelOperatingConstraints(path, {
            runId,
            evidenceRevision: state.revision,
            expectedVersion: 0,
            requestId: crypto.randomUUID(),
            operatorScope: "fixture-owner",
            constraints: { deniedKinds: ["review_incident"] },
          }));
        }
        if (outcome === "stopped") {
          assert(
            store.requestModelReviewControl(
              revision,
              lease.task.id,
              crypto.randomUUID(),
              "stop",
            ),
          );
        }
        if (outcome === "source-denied") sourceDenied = true;
        const invalid = outcome === "stopped" || outcome === "revoked";
        if (invalid) {
          const visible = await pendingInbox(reopened);
          assertEquals(visible.id, pending.id);
          assertEquals(visible.sentinelIncidentRecommendation, undefined);
          assert(
            !visible.description.includes(incidentId) &&
              !visible.description.includes(note),
          );
        }
        const decide = () =>
          reopened!.request({
            type: "approval_inbox_decide",
            approvalId: pending.id,
            approved: outcome !== "denied",
          });
        assertEquals((await decide()).ok, !invalid);
        await job;
        if (outcome === "approved") {
          assert(result.startsWith("{"), result);
          assertEquals(JSON.parse(result).review.id, reviews()[0]?.id);
          assertEquals((await decide()).ok, true);
          assertEquals(reviews().length, 1);
          assertEquals(
            readSentinelOperatorReviewRequest(path, "incident", pending.id)
              ?.record.id,
            reviews()[0]?.id,
          );
          assertEquals(classified, 1);
          assert(outputDenied);
          assert(!JSON.stringify(outputs).includes("recommendationEvidence"));
          const deadline = Date.now() + 3_500;
          while (rounds < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assertEquals(rounds, 2);
          const exact = readSentinelOperatorReviewRequest(
            path,
            "incident",
            pending.id,
          );
          assert(exact?.record.recommendationEvidence);
          assertEquals(exact.record.approvalId, pending.id);
          assertEquals(
            exact.record.recommendationEvidence.assignmentId,
            lease.task.id,
          );
          assertEquals(exact.record.recommendationEvidence.pages.length, 2);
          const live = readSentinelDecisionHistory(
            path,
            state.revision,
            "incident",
            incidentId,
          );
          coordinator?.stop();
          assert(stopSentinelAssessment(path));
          const staging = await Deno.makeTempDir({ dir: baseDir });
          const captured = captureStoppedSentinelCaseArtifacts(baseDir, {
            caseId,
            runId,
            evidenceRevision: state.revision,
          }, staging);
          const archive = async (name: string, destination: string) => {
            const filename = join(baseDir, name);
            await Deno.mkdir(destination, { mode: 0o700 });
            await writeRunArchive(
              filename,
              {
                kind: "sentinel",
                id: caseId,
                runId,
                revision: state.revision,
              },
              captured.artifacts.map(({ name, path }) => ({
                name,
                sourcePath: path,
              })),
              permittedSentinelRestoreArtifacts,
            );
            return withVerifiedRunArchive(
              filename,
              destination,
              {
                expectedKind: "sentinel",
                permittedNames: permittedSentinelRestoreArtifacts,
                requiredNames: requiredSentinelRestoreArtifacts,
              },
              (archive) =>
                restoreVerifiedSentinelCaseArchive(destination, archive),
            );
          };
          const destination = join(baseDir, "restored");
          await archive("case-healthy.tar", destination);
          const restored = resolveSentinelCasePath(destination, caseId);
          assertEquals(
            readSentinelDecisionHistory(
              restored,
              state.revision,
              "incident",
              incidentId,
            ),
            live,
          );
          const tampered = new DatabaseSync(
            join(captured.directory, "sentinel-assessment.db"),
          );
          try {
            const evidence = structuredClone(
              exact.record.recommendationEvidence,
            );
            tampered.prepare(
              "UPDATE assessment_incident_reviews SET recommendationEvidence = ?",
            ).run(
              JSON.stringify({
                ...evidence,
                pages: evidence.pages.map((page, i) =>
                  i ? page : { ...page, sha256: "a".repeat(64) }
                ),
              }),
            );
          } finally {
            tampered.close();
          }
          const corrupt = join(baseDir, "corrupt");
          await assertRejects(
            () => archive("case-corrupt.tar", corrupt),
            Error,
            "does not match its cohort",
          );
          await assertRejects(
            () => Deno.stat(resolveSentinelCasePath(corrupt, caseId)),
            Deno.errors.NotFound,
          );
        } else {
          assertEquals(reviews(), []);
        }
      } finally {
        store.close();
      }
    } finally {
      agent?.clear();
      await job;
      coordinator?.stop();
      await reopened?.close();
      await original?.close();
      await gateway.stop();
      await Deno.remove(baseDir, { recursive: true });
    }
  });
}
