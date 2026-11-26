import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import { createGatewayServer } from "../../../src/gateway/server/server.ts";
import { createChatSession } from "../../../src/gateway/chat.ts";
import { createSession } from "../../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../../src/core/types/session.ts";
import {
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../../src/gateway/sentinel_agent.ts";
import { readSentinelAssessment } from "../../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../../src/sentinel/cases.ts";
import { assert, assertEquals } from "@std/assert";

const [baseDir, phase] = Deno.args;
const path = resolveSentinelCasePath(baseDir, "retained-finding");
const state = readSentinelAssessment(path);
assert(state);
const { taskId, input, traffic } = JSON.parse(
  await Deno.readTextFile(join(baseDir, "traffic-finding-fixture.json")),
);
const trafficReads: { revision: number; evidenceId: string; digest: string }[] =
  traffic;
const resultPath = join(baseDir, "traffic-finding-result.json");
function record(event: string) {
  Deno.writeTextFileSync(
    join(baseDir, "traffic-finding-events.log"),
    `${phase}:${event}\n`,
    { append: true, create: true },
  );
}
const registry = createProviderRegistry();
registry.register({
  name: "traffic-finding-process",
  supportsStreaming: false,
  complete(messages) {
    const results = messages.filter(({ role }) => role === "tool");
    if (phase === "resume") {
      assertEquals(results.length, trafficReads.length + 2);
      assertEquals(JSON.parse(String(results[0].content)).taskId, taskId);
      assertEquals(
        results.slice(1, -1).map(({ content }) =>
          JSON.parse(String(content)).receipt.digest
        ),
        trafficReads.map(({ digest }) => digest),
      );
      const committed = JSON.parse(String(results.at(-1)?.content));
      const links = committed.link ? [committed.link] : committed.links;
      assertEquals(
        links.map(({ findingId }: { findingId: string }) => findingId),
        trafficReads.map(() => committed.record.id),
      );
      Deno.writeTextFileSync(resultPath, JSON.stringify(committed));
    } else {
      assertEquals(phase, "interrupt");
    }
    const calls = results.length === 0
      ? [{ name: "sentinel_assigned_target", args: {} }]
      : results.length === 1
      ? trafficReads.map((args) => ({ name: "sentinel_traffic_get", args }))
      : results.length === trafficReads.length + 1
      ? [{ name: "sentinel_report_finding", args: input }]
      : [];
    return Promise.resolve({
      content: calls.length
        ? ""
        : '{"summary":"Reviewed the committed finding.","followUps":[]}',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolCalls: calls.map(({ name, args }, index) => ({
        id: `traffic-finding-${results.length}-${index}`,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      })),
    });
  },
});
registry.setDefault("traffic-finding-process");
const chatSession = createChatSession({
  session: createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  }),
  providerRegistry: registry,
  enableStreaming: false,
  hookRunner: {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        duration: 0,
        ruleId: null,
      }),
  },
});
const gateway = createGatewayServer({
  token: crypto.randomUUID(),
  port: 0,
  chatSession,
});
await gateway.start();
let sawRevocation = false;
const planner = createSentinelModelPlanner(path, (current, id, token) => {
  if (id !== taskId) {
    return {
      execute(_message, send) {
        send({ type: "response", text: "[]", taint: "INTERNAL" });
        return Promise.resolve();
      },
      clear() {},
    };
  }
  const worker = createSentinelSubagent({
    snapshotPath: path,
    assessmentRevision: current.revision,
    assignedTaskId: id,
    assignedTaskLeaseToken: token,
    allowModelAccess: true,
    providerRegistry: registry,
    hookRunner: {
      evaluateHook(hook, { input }) {
        const name = input.tool_name;
        if (hook === "PRE_TOOL_CALL" && name === "sentinel_traffic_get") {
          record("traffic-pre");
          if (phase === "reclaim-crash") Deno.exit(0);
          if (
            phase === "revoked" &&
            (input.tool_call as { args?: { evidenceId?: string } } | undefined)
                ?.args?.evidenceId === trafficReads.at(-1)?.evidenceId
          ) {
            sawRevocation = true;
            return Promise.resolve({
              allowed: false,
              action: "BLOCK",
              duration: 0,
              ruleId: null,
            });
          }
        }
        if (hook === "PRE_TOOL_CALL" && name === "sentinel_report_finding") {
          record("report-pre");
        }
        if (
          hook === "POST_TOOL_RESPONSE" && name === "sentinel_report_finding" &&
          typeof input.tool_response === "string" &&
          input.tool_response.startsWith("Error:") &&
          phase === "interrupt"
        ) {
          record("interrupted");
          Deno.exit(0);
        }
        if (
          hook === "POST_TOOL_RESPONSE" && name === "sentinel_report_finding" &&
          typeof input.tool_response === "string" &&
          input.tool_response.startsWith("{")
        ) {
          record("report-post");
        }
        return Promise.resolve({
          allowed: true,
          action: "ALLOW",
          duration: 0,
          ruleId: null,
        });
      },
    },
  });
  const execute: typeof worker.execute = (
    message,
    send,
    signal,
    trace,
    digests,
    checkpoint,
  ) =>
    worker.execute(
      message,
      send,
      signal,
      (step) => {
        if (
          step.tool === "sentinel_traffic_get" && step.outcome === "returned"
        ) {
          record("traffic-result");
        }
        trace?.(step);
      },
      digests,
      checkpoint,
    );
  return { execute, clear: () => worker.clear() };
});
try {
  const deadline = Date.now() + (phase === "stale" ? 300 : 5000);
  while (Date.now() < deadline) {
    planner.advance(state);
    const review = readAdaptiveSentinel(path, state)?.modelReviewStates.find((
      { taskId: id },
    ) => id === taskId);
    if (phase === "resume" && review?.status === "completed") break;
    if (phase === "revoked" && sawRevocation && !planner.hasInFlightWork()) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(
    phase !== "interrupt",
    "did not interrupt at the durable journal fault",
  );
  const events = await Deno.readTextFile(
    join(baseDir, "traffic-finding-events.log"),
  );
  if (phase === "stale") {
    assert(
      !events.includes("stale:traffic-pre") &&
        !events.includes("stale:report-pre"),
    );
  } else {
    assert(events.includes(`${phase}:traffic-pre`));
  }
  if (phase === "resume") assert(events.includes("resume:report-pre"));
  if (phase === "revoked") {
    assert(sawRevocation, "The exact selected saved source was not denied");
    assert(!events.includes("revoked:report-pre"));
  }
} finally {
  planner.stop();
  await gateway.stop();
}
