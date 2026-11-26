import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { ApprovalInboxRecord } from "../../src/core/approval_inbox.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { sentinelIncidentRecommendationToolName } from "../../src/core/sentinel_incident_review_intent.ts";
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
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  readSentinelAssessment,
  readSentinelIncidentReviews,
  readSentinelOperatorReviewRequest,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { readSavedSentinelIncidentCandidates } from "../../src/sentinel/incident_archive.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { SENTINEL_INCIDENT_ALERTS_READ } from "../../src/sentinel/worker_goal_recovery.ts";

const caseId = "incident-restart";
const mark = "Retained restart-sensitive alert subject";
const secret = "synthetic-secret-incident-7533";
const complete = (content: string, name?: string, args = {}) => ({
  content,
  usage: { inputTokens: 1, outputTokens: 1 },
  toolCalls: name
    ? [{
      id: crypto.randomUUID(),
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    }]
    : [],
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Incident restart fixture did not settle");
}

async function review(
  port: number,
  token: string,
): Promise<ApprovalInboxRecord> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const request = (input: Record<string, unknown>) => {
    const requestId = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve) => {
      const handler = ({ data }: MessageEvent) => {
        const reply = JSON.parse(data);
        if (
          reply.type !== "approval_inbox_result" ||
          reply.requestId !== requestId
        ) return;
        socket.removeEventListener("message", handler);
        assertEquals(reply.ok, true);
        resolve(reply.result);
      };
      socket.addEventListener("message", handler);
      socket.send(JSON.stringify({ ...input, requestId }));
    });
  };
  try {
    let pending: ApprovalInboxRecord | undefined;
    await waitFor(async () => {
      const page = await request({ type: "approval_inbox_list" });
      pending = (page.records as ApprovalInboxRecord[]).find(({ status }) =>
        status === "pending"
      );
      return !!pending;
    });
    assert(pending);
    assertEquals(pending.tool, sentinelIncidentRecommendationToolName);
    await request({
      type: "approval_inbox_decide",
      approvalId: pending.id,
      approved: true,
    });
    return pending;
  } finally {
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true })
    );
    socket.close();
    await closed;
  }
}

async function runChild(base: string, phase: string) {
  const path = resolveSentinelCasePath(base, caseId);
  const state = readSentinelAssessment(path);
  assert(state?.active);
  const incident = readSavedSentinelIncidentCandidates(path, state.revision)[0];
  assert(incident);
  const token = crypto.randomUUID();
  const inbox = createToolApprovalService(join(base, "approvals.db"));
  let replayDenials = 0;
  const hooks: HookRunner = {
    toolApprovalInbox: inbox,
    evaluateHook(hook, { input }) {
      const tool = input.tool_call as { name?: string } | undefined;
      const denied = phase === "revoked" && hook === "PRE_TOOL_CALL" &&
        tool?.name === SENTINEL_INCIDENT_ALERTS_READ;
      if (denied) replayDenials++;
      return Promise.resolve({
        allowed: !denied,
        action: denied ? "BLOCK" : "ALLOW",
        duration: 0,
        ruleId: denied ? "fixture-revoked-incident" : null,
      });
    },
  };
  const registry = createProviderRegistry();
  registry.register({
    name: "incident-restart-fixture",
    supportsStreaming: false,
    async complete(messages) {
      if (phase === "revoked") {
        await Deno.writeTextFile(
          join(base, "revoked-model-called"),
          "unexpected",
        );
        throw new Error("Revoked checkpoint reached the model");
      }
      const result = messages.findLast(({ role }) => role === "tool");
      if (!result) {
        assertEquals(
          phase,
          "interrupt",
          "Completed cohort read was offered again",
        );
        await Deno.writeTextFile(join(base, "page-offers"), "read\n", {
          append: true,
          create: true,
        });
        return complete("", SENTINEL_INCIDENT_ALERTS_READ, {
          incidentId: incident.id,
        });
      }
      const exact = String(result.content);
      const value = JSON.parse(exact);
      if (value.review) {
        return complete(
          '{"summary":"The reviewed cohort was recorded.","followUps":[]}',
        );
      }
      assertEquals(value.incidentId, incident.id);
      if (phase === "interrupt") {
        await Deno.writeTextFile(join(base, "checkpoint-ready"), exact);
        return await new Promise<never>(() => {});
      }
      assertEquals(
        exact,
        await Deno.readTextFile(join(base, "checkpoint-ready")),
      );
      return complete("", sentinelIncidentRecommendationToolName, {
        incidentId: incident.id,
        disposition: "investigating",
        note: "Continue investigation of the exact retained cohort.",
      });
    },
  });
  registry.setDefault("incident-restart-fixture");
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
    }),
  });
  const planner = createSentinelModelPlanner(
    path,
    (current, id, lease) =>
      id
        ? createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: current.revision,
          assignedTaskId: id,
          assignedTaskLeaseToken: lease,
          providerRegistry: registry,
          hookRunner: hooks,
          allowModelAccess: true,
        })
        : { execute: () => Promise.resolve(), clear() {} },
  );
  const { port } = await gateway.start();
  try {
    advanceAdaptiveSentinel(path, state);
    planner.advance(state);
    if (phase === "interrupt") await new Promise<never>(() => {});
    if (phase === "revoked") {
      await waitFor(() => replayDenials === 1 && !planner.hasInFlightWork());
      assertEquals(inbox.list().records, []);
    } else {
      const approved = await review(port, token);
      await waitFor(() =>
        !!readSentinelOperatorReviewRequest(path, "incident", approved.id)
      );
      assertEquals(readSentinelIncidentReviews(path, state.revision).length, 1);
      await Deno.writeTextFile(join(base, "approved-id"), approved.id);
    }
  } finally {
    planner.stop();
    await gateway.stop();
  }
}

if (import.meta.main) {
  await runChild(Deno.args[0], Deno.args[1]);
} else {
  Deno.test("A restarted incident worker uses its committed cohort and requests fresh owner approval", async () => {
    const base = await Deno.makeTempDir();
    const path = resolveSentinelCasePath(base, caseId);
    const child = (phase: string) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", fromFileUrl(import.meta.url), base, phase],
        stdout: "null",
        stderr: "piped",
      }).spawn();
    const run = async (phase: string) => {
      const result = await child(phase).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
    };
    let interrupted: Deno.ChildProcess | undefined;
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
          subject: mark,
          authorization: secret,
          observedAt: "2026-01-01T00:00:00.000Z",
        }))),
      );
      const state = startSentinelAssessment(path);
      interrupted = child("interrupt");
      await waitFor(async () => {
        try {
          await Deno.stat(join(base, "checkpoint-ready"));
          return true;
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return false;
          throw err;
        }
      });
      interrupted.kill("SIGKILL");
      assert(!(await interrupted.status).success);
      await interrupted.stderr.cancel();
      interrupted = undefined;
      const db = new DatabaseSync(join(dirname(path), "sentinel-adaptive.db"));
      try {
        const checkpoint = String(
          db.prepare("SELECT checkpoint FROM adaptive_worker_checkpoints").get()
            ?.checkpoint,
        );
        assert(checkpoint.includes(SENTINEL_INCIDENT_ALERTS_READ));
        const savedTool = JSON.parse(checkpoint).history.find(
          ({ role }: { role: string }) => role === "tool",
        );
        assertEquals(
          savedTool?.content,
          await Deno.readTextFile(join(base, "checkpoint-ready")),
        );
        assert(!checkpoint.includes(secret));
        db.exec(
          "UPDATE adaptive_model_reviews SET availableAt = 0 WHERE token IS NOT NULL",
        );
      } finally {
        db.close();
      }
      // Check current policy on a full copy, then independently resume the exact original.
      const revoked = await Deno.makeTempDir();
      Deno.removeSync(revoked);
      const snapshot = await new Deno.Command("cp", {
        args: ["-a", base, revoked],
      }).output();
      assert(snapshot.success);
      try {
        const denied = await new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", fromFileUrl(import.meta.url), revoked, "revoked"],
          stdout: "null",
          stderr: "piped",
        }).output();
        assert(denied.success, new TextDecoder().decode(denied.stderr));
        assert(
          !Array.from(Deno.readDirSync(revoked)).some(({ name }) =>
            name === "revoked-model-called"
          ),
        );
      } finally {
        await Deno.remove(revoked, { recursive: true });
      }
      await run("resume");
      assertEquals(
        await Deno.readTextFile(join(base, "page-offers")),
        "read\n",
      );
      const receipt = readSentinelOperatorReviewRequest(
        path,
        "incident",
        await Deno.readTextFile(join(base, "approved-id")),
      );
      assert(receipt?.record.recommendationEvidence);
      assertEquals(receipt.record.revision, state.revision);
      assertEquals(
        receipt.record.recommendationEvidence.pages[0].sha256,
        createHash("sha256").update(
          await Deno.readTextFile(join(base, "checkpoint-ready")),
        ).digest("hex"),
      );
    } finally {
      if (interrupted) {
        interrupted.kill("SIGKILL");
        await interrupted.status;
        await interrupted.stderr.cancel();
      }
      await Deno.remove(base, { recursive: true });
    }
  });
}
