import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import {
  createSentinelAgent,
  type SentinelAgentOptions,
} from "../../src/gateway/sentinel_agent.ts";
import {
  executeSentinelTrafficTool,
  sentinelTrafficGetTool,
  sentinelTrafficSearchTool,
} from "../../src/gateway/sentinel_traffic_tool.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { readSentinelTrafficReceiptPage } from "../../src/sentinel/traffic_receipts.ts";

async function withRetainedTraffic(
  run: (
    snapshotPath: string,
    state: ReturnType<typeof startSentinelAssessment>,
  ) => Promise<void>,
) {
  const directory = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(directory);
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const rows = ["first", "second"].map((host) => ({
      startedDateTime: "2026-06-01T00:00:00.000Z",
      request: {
        url: "https://username:password@" + host +
          ".example/private?secret=value",
        method: "GET",
        headers: [{ name: "authorization", value: "sensitive-token" }],
      },
      response: { status: 200, content: { text: "private raw body" } },
    }));
    await ingestSentinelTraffic(
      new Blob([rows.map((row) => JSON.stringify(row)).join("\n")]).stream(),
      "configured fixture",
      path,
    );
    await run(path, startSentinelAssessment(path));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("Sentinel main agent dispatches retained traffic with case policy and no raw network material", async () => {
  await withRetainedTraffic(async (path, state) => {
    const revision = state.revision;
    const page = readSentinelTrafficReceiptPage(path, revision, { limit: 1 });
    assertExists(page);
    const first = page.receipts[0];
    const calls = [
      [sentinelTrafficSearchTool.name, { revision, limit: 1 }],
      [sentinelTrafficGetTool.name, {
        revision,
        evidenceId: first.evidenceId,
        digest: first.digest,
      }],
    ] as const;
    const policy: {
      hook: string;
      input: Record<string, unknown>;
      audit?: Record<string, unknown>;
    }[] = [];
    const frames: string[] = [];
    const registry = createProviderRegistry();
    let iterations = 0;
    registry.register({
      name: "traffic-fixture",
      supportsStreaming: false,
      complete(messages, tools) {
        const offered = tools.map((tool) =>
          (tool as { function?: { name: string } }).function?.name
        );
        for (const [name] of calls) assert(offered.includes(name));
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (++iterations === 1) {
          return Promise.resolve({
            content: "",
            usage,
            toolCalls: calls.map(([name, args], index) => ({
              id: `traffic-read-${index}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            })),
          });
        }
        frames.push(
          ...messages.filter(({ role }) => role === "tool").map(({ content }) =>
            String(content)
          ),
        );
        return Promise.resolve({
          content: "Retained network metadata reviewed.",
          usage,
          toolCalls: [],
        });
      },
    });
    registry.setDefault("traffic-fixture");
    const options: SentinelAgentOptions = {
      snapshotPath: path,
      allowModelAccess: true,
      providerRegistry: registry,
      hookRunner: {
        evaluateHook(hook, { input, auditInput }) {
          if (
            typeof input.tool_name === "string" &&
            input.tool_name.startsWith("sentinel_traffic")
          ) {
            policy.push({ hook, input, audit: auditInput });
          }
          return Promise.resolve({
            allowed: true,
            action: "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
    };
    const agent = createSentinelAgent(options);
    try {
      await agent.execute(
        "Review retained evidence for the selected case.",
        () => {},
      );
      assertEquals(frames.length, 2);
      for (const frame of frames) {
        assertStringIncludes(frame, '"caseId":"main"');
        assertStringIncludes(frame, '"origin":"https://');
        for (
          const disallowed of [
            "username",
            "password",
            "/private",
            "secret=value",
            "sensitive-token",
            "private raw body",
          ]
        ) {
          assert(!frame.includes(disallowed));
        }
      }
      assertEquals(policy.map(({ hook }) => hook).sort(), [
        "POST_TOOL_RESPONSE",
        "POST_TOOL_RESPONSE",
        "PRE_TOOL_CALL",
        "PRE_TOOL_CALL",
      ]);
      for (const event of policy) {
        assertEquals(event.input.evidence_revision, revision);
        assertEquals(event.input.operation_type, "read");
        assertEquals(event.input.resource_classification, "INTERNAL");
        assertEquals(Object.hasOwn(event.audit ?? {}, "tool_response"), false);
      }
      assertStringIncludes(
        executeSentinelTrafficTool(
          { snapshotPath: path, snapshotOverride: {} },
          sentinelTrafficSearchTool.name,
          { revision },
        ),
        "Error:",
      );
    } finally {
      agent.clear();
    }
  });
});

Deno.test("leased traffic queries reject a different asset, digest, revision or stale lease", async () => {
  await withRetainedTraffic((path, state) => {
    const revision = state.revision;
    const page = readSentinelTrafficReceiptPage(path, revision);
    assertExists(page);
    const [first, foreign] = page.receipts;
    const assignment = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    try {
      const [task] = store.sync(
        assignment,
        [{
          kind: "trace",
          nodeId: first.assetIds[0],
          reason: MODEL_ASSIGNMENT_REASON,
        }],
        null,
        {
          number: revision,
          goal: {
            id: state.plan.runId!,
            label: "Investigate prioritized defensive findings",
          },
        },
      );
      const execution = store.claim(assignment);
      assertExists(execution);
      store.complete({
        taskId: task.id,
        leaseToken: execution.leaseToken,
        observation: {},
      });
      const lease = store.claimModelReview(assignment, MODEL_ASSIGNMENT_REASON);
      assertExists(lease);
      const scope = {
        snapshotPath: path,
        assessmentRevision: revision,
        assignedTaskId: task.id,
        assignedTaskLeaseToken: lease.token,
      };
      const query = (name: string, args: Record<string, unknown>) =>
        executeSentinelTrafficTool(scope, name, { revision, ...args });
      const search = JSON.parse(query(sentinelTrafficSearchTool.name, {}));
      assertEquals(
        search.receipts.map((entry: { evidenceId: string }) =>
          entry.evidenceId
        ),
        [first.evidenceId],
      );
      assertEquals(search.receipts[0].assetIds, [task.nodeId]);
      const get = query(sentinelTrafficGetTool.name, {
        evidenceId: first.evidenceId,
        digest: first.digest,
      });
      assertEquals(JSON.parse(get).receipt.digest, first.digest);
      for (
        const args of [
          { evidenceId: foreign.evidenceId, digest: foreign.digest },
          { evidenceId: first.evidenceId, digest: "0".repeat(64) },
          {
            evidenceId: first.evidenceId,
            digest: first.digest,
            revision: revision + 1,
          },
        ]
      ) {
        assertStringIncludes(
          query(sentinelTrafficGetTool.name, args),
          "Error:",
        );
      }
      assertStringIncludes(
        query(sentinelTrafficSearchTool.name, { assetId: foreign.assetIds[0] }),
        "Error:",
      );
      store.finishModelReview(assignment, task.id, lease.token, "interrupted");
      assertStringIncludes(query(sentinelTrafficSearchTool.name, {}), "Error:");
    } finally {
      store.close();
    }
    return Promise.resolve();
  });
});
