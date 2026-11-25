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
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
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
  throw new Error("The leased worker did not reach approval");
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
