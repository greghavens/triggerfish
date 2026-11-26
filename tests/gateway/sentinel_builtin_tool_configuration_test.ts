import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import {
  parseSentinelToolConfigurationUpdate,
  sentinelToolConfigurations,
} from "../../src/gateway/sentinel_tool_configuration.ts";
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";

const name = "sentinel_provenance_search";

function provider(
  requested: () => { name: string; args: Record<string, unknown> },
  result: (text: string) => void,
  advertised: (definitions: readonly unknown[]) => void,
) {
  const registry = createProviderRegistry();
  registry.register({
    name: "sentinel-settings-fixture",
    supportsStreaming: false,
    complete(messages, definitions) {
      advertised(definitions ?? []);
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        result(String(last.content));
        return Promise.resolve({ content: "Checked.", usage, toolCalls: [] });
      }
      const call = requested();
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: [{
          id: crypto.randomUUID(),
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        }],
      });
    },
  });
  registry.setDefault("sentinel-settings-fixture");
  return registry;
}

Deno.test("Reviewed Sentinel built-in settings restrict roles and apply safe defaults before dispatch", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  let requested = {
    name: "operator_runs",
    args: {} as Record<string, unknown>,
  };
  let result = "";
  let tools: readonly unknown[] = [];
  let confirmed = 0;
  let denyNextApproval = false;
  let disableDuringPre = false;
  let classifiedSearches = 0;
  let sharedProjection: unknown;
  const calls: Record<string, unknown>[] = [];
  const hooks: string[] = [];
  const registry = provider(
    () => requested,
    (text) => result = text,
    (definitions) => tools = definitions,
  );
  const hookRunner = {
    evaluateHook(hook: string, { input }: { input: Record<string, unknown> }) {
      const call = input.tool_call as
        | { name: string; args: Record<string, unknown> }
        | undefined;
      if (hook === "PRE_TOOL_CALL" && call?.name === name) {
        calls.push(call.args);
        if (disableDuringPre && call.args.query === "Race") {
          disableDuringPre = false;
          const update = parseSentinelToolConfigurationUpdate(
            name,
            { enabled: false, roles: [] },
            1,
            crypto.randomUUID(),
          );
          assert(
            update &&
              sentinelToolConfigurations(baseDir).commit(
                update,
                crypto.randomUUID(),
              ),
          );
        }
      }
      if (
        hook === "POST_TOOL_RESPONSE" && input.tool_name === name &&
        String(input.tool_response).includes("Race fixture")
      ) {
        classifiedSearches++;
      }
      if (
        hook === "PRE_TOOL_CALL" && call?.name === "sentinel_shared_asset_links"
      ) {
        sharedProjection = call.args.includeFindings;
      }
      hooks.push(hook);
      return Promise.resolve({
        allowed: true,
        action: "ALLOW" as const,
        duration: 0,
        ruleId: null,
      });
    },
  };
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "sentinel-settings-fixture" as ChannelId,
      }),
      providerRegistry: registry,
      sentinelSnapshotPath: path,
      sentinelSharedInventoryBaseDir: baseDir,
      allowSentinelModelAccess: true,
      hookRunner,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => {
          confirmed++;
          return Promise.resolve(!denyNextApproval);
        },
      }),
    }),
  });
  let socket: WebSocket | undefined;
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { kind: "asset", id: "reviewed", label: "Review fixture" },
          { kind: "asset", id: "neighbor", label: "Other service" },
          { kind: "asset", id: "race", label: "Race fixture" },
        ],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    const { port } = await gateway.start();
    socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string) => {
      result = "";
      const done = Promise.withResolvers<void>();
      const timeout = setTimeout(
        () => done.reject(new Error("No turn end")),
        4_000,
      );
      const receive = ({ data }: MessageEvent) => {
        if (JSON.parse(String(data)).type === "turn_end") done.resolve();
      };
      ws.addEventListener("message", receive);
      try {
        ws.send(JSON.stringify({ type: "message", content }));
        await done.promise;
        return result;
      } finally {
        clearTimeout(timeout);
        ws.removeEventListener("message", receive);
      }
    };
    const manage = async (args: Record<string, unknown>) => {
      requested = {
        name: "operator_runs",
        args: { builtinTool: name, ...args },
      };
      return await turn("Review the exact Sentinel settings.");
    };
    const version = () => manage({ action: "sentinel_tool_configuration" });
    assertEquals(JSON.parse(await version()).version, 0);
    const mutation = {
      action: "set_sentinel_tool_configuration",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      builtinSettings: {
        enabled: true,
        roles: ["chat"],
        description: "Reviewed retained graph node lookup.",
        parameters: {
          query: {
            description: "Approved short search text.",
            default: "Review",
          },
          limit: { default: 1 },
        },
      },
    };
    denyNextApproval = true;
    assertStringIncludes(await manage(mutation), "unavailable");
    assertEquals(JSON.parse(await version()).version, 0);
    denyNextApproval = false;
    const committed = await manage(mutation);
    assertEquals(JSON.parse(committed).settingsReceipt.version, 1);
    assertEquals(await manage(mutation), committed);
    assertEquals(confirmed, 2);
    assertStringIncludes(
      await manage({
        ...mutation,
        expectedVersion: 1,
        requestId: crypto.randomUUID(),
        builtinSettings: {
          ...mutation.builtinSettings,
          parameters: { revision: { default: 1 } },
        },
      }),
      "unavailable",
    );
    assertEquals(confirmed, 2);
    const shared = await manage({
      ...mutation,
      builtinTool: "sentinel_shared_asset_links",
      requestId: crypto.randomUUID(),
      builtinSettings: {
        enabled: true,
        roles: ["chat"],
        parameters: { includeFindings: { default: false } },
      },
    });
    assertEquals(JSON.parse(shared).settingsReceipt.version, 1);
    await turn("/sentinel on");
    requested = { name, args: {} };
    const checked = await turn("Find the default node.");
    assertStringIncludes(checked, "Review fixture");
    assert(!checked.includes("Other service"));
    assertEquals(calls.at(-1), { query: "Review", limit: 1 });
    const modelSettings = JSON.stringify(tools);
    assertStringIncludes(modelSettings, "Reviewed retained graph node lookup.");
    assertStringIncludes(modelSettings, "Approved short search text.");
    assertStringIncludes(modelSettings, '"default":"Review"');
    requested = { name, args: { query: "Other", limit: 2 } };
    assertStringIncludes(
      await turn("Use the explicit search."),
      "Other service",
    );
    assertEquals(calls.at(-1), { query: "Other", limit: 2 });
    requested = {
      name: "sentinel_shared_asset_links",
      args: { asset: "reviewed" },
    };
    await turn("Read the default shared projection.");
    assertEquals(sharedProjection, false);
    assert(hooks.includes("POST_TOOL_RESPONSE"));
    assert(hooks.includes("PRE_OUTPUT"));

    const restricted = async (
      options: Partial<Parameters<typeof createSentinelSubagent>[0]>,
    ) => {
      let toolResult = "";
      let offered: readonly unknown[] = [];
      const reader = createSentinelSubagent({
        snapshotPath: path,
        sharedInventoryBaseDir: baseDir,
        providerRegistry: provider(
          () => ({ name, args: {} }),
          (text) => toolResult = text,
          (definitions) => offered = definitions,
        ),
        allowModelAccess: true,
        hookRunner,
        ...options,
      });
      try {
        await reader.execute("Review the authorized case.", () => {});
        assert(offered.length > 0 && !JSON.stringify(offered).includes(name));
        assertStringIncludes(toolResult, "unavailable");
      } finally {
        reader.clear();
      }
    };
    await restricted({});
    assert(state.plan.runId);
    await restricted({
      assessmentRevision: state.revision,
      plannerExecutionEvidenceRunId: state.plan.runId,
    });
    advanceAdaptiveSentinel(path, state);
    const revision = adaptiveRevision(state);
    const store = openSentinelAdaptiveStore(
      join(dirname(path), "sentinel-adaptive.db"),
    );
    let lease;
    try {
      store.sync(revision, [{
        kind: "impact",
        nodeId: "reviewed",
        reason: MODEL_ASSIGNMENT_REASON,
      }], revision);
      advanceAdaptiveSentinel(path, state);
      lease = store.claimModelReview(
        revision,
        MODEL_ASSIGNMENT_REASON,
        (task) => task.kind === "impact" && task.nodeId === "reviewed",
      );
      assert(lease);
    } finally {
      store.close();
    }
    await restricted({
      assessmentRevision: state.revision,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
    });
    disableDuringPre = true;
    const before = classifiedSearches;
    requested = { name, args: { query: "Race" } };
    assertStringIncludes(
      await turn("Evaluate a replaced settings revision."),
      "unavailable",
    );
    assert(!disableDuringPre);
    assertEquals(classifiedSearches, before);
    await turn("/sentinel off");
    const reset = await manage({
      action: "reset_sentinel_tool_configuration",
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
    });
    assertEquals(JSON.parse(reset).settingsReceipt.version, 3);
    assertEquals(JSON.parse(await version()).settings.description, undefined);
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
