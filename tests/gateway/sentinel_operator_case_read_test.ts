import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Authenticated Sentinel chat reads exact approved cross-case graph findings and inventory through root policy", async () => {
  const baseDir = await Deno.makeTempDir();
  const secretLabel = "Exact authorized cross-case finding";
  const hiddenLabel = "Unregistered case finding";
  const inventoryLabel = "Approved asset in exact peer inventory";
  async function setupCase(id: string, label: string) {
    const path = resolveSentinelCasePath(baseDir, id);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { kind: "finding", id: "finding", label, severity: "low" },
          ...["a", "b", "c"].map((name) => ({
            kind: "asset",
            id: `asset-${name}`,
            label: name === "a" ? inventoryLabel : `Asset ${name}`,
            assetType: "service",
            aliases: [`${name}.example`],
            organization: { id: "ops", label: "Operations" },
          })),
        ],
        edges: [],
      }),
      { mode: 0o600 },
    );
    const state = startSentinelAssessment(path);
    return { path, revision: state.revision, state };
  }

  const main = await setupCase("main", "Selected case finding");
  const approved = await setupCase("approved", secretLabel);
  const hidden = await setupCase("unregistered", hiddenLabel);
  const membership = resolveSentinelCaseMembership(
    approved.state.result?.sharedGraph.snapshot,
    {
      caseId: "approved",
      evidenceRevision: approved.revision,
      selector: { kind: "assets", assetIds: ["asset-a", "asset-b"] },
    },
  );
  assert(membership);
  const approvedScope = recordSentinelOperatingConstraints(approved.path, {
    runId: approved.state.plan.runId!,
    evidenceRevision: approved.revision,
    expectedVersion: 0,
    operatorScope: "owner",
    requestId: crypto.randomUUID(),
    constraints: { allowedAssetIds: membership.assetIds, deniedKinds: [] },
    membership,
  });
  assert(approvedScope);
  const operator = createOperatorRunToolExecutor({
    baseDir,
    confirm() {
      throw new Error("A Sentinel graph read cannot request a mutation.");
    },
  });
  const ordinaryOwner = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const registry = createProviderRegistry();
  let request: Record<string, unknown> | undefined;
  let result = "";
  let verifyWorkerBinding = false;
  let rejectExecutorCeiling = false;
  let dispatched = 0;
  let reject: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  const hooks: string[] = [];
  registry.register({
    name: "sentinel-cross-case-reader",
    supportsStreaming: false,
    complete(messages, tools) {
      const next = request;
      request = undefined;
      const definitions = tools as {
        function?: {
          name?: string;
          parameters?: { properties?: { action?: { enum?: string[] } } };
        };
      }[] | undefined;
      const definition = definitions?.find((tool) =>
        tool.function?.name === "operator_runs"
      );
      if (verifyWorkerBinding) {
        assertEquals(definition, undefined);
        verifyWorkerBinding = false;
        return Promise.resolve({
          content: "Worker bindings verified.",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      }
      if (next) {
        assert(definition);
        assertEquals(
          definition.function?.parameters?.properties?.action?.enum,
          [
            "graph_overview",
            "graph",
            "findings",
            "node",
            "inventory",
            "facts",
            "finding_receipts",
            "finding_receipt",
          ],
        );
      } else {
        result = String(
          messages.findLast(({ role }) => role === "tool")?.content,
        );
      }
      return Promise.resolve({
        content: next ? "" : result,
        toolCalls: next
          ? [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(next),
            },
          }]
          : [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    },
  });
  registry.setDefault("sentinel-cross-case-reader");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: ordinaryOwner,
      providerRegistry: registry,
      sentinelSnapshotPath: main.path,
      resolveSentinelChatCase: (id) =>
        id === "approved" ? approved.path : undefined,
      allowSentinelModelAccess: true,
      hookRunner: {
        evaluateHook(hook, { input }) {
          const selectsTool = input.tool_name === "operator_runs";
          if (selectsTool || hook === "PRE_OUTPUT") hooks.push(hook);
          const blocked = hook === reject &&
            (selectsTool || hook === "PRE_OUTPUT" &&
                typeof input.content === "string" &&
                [secretLabel, inventoryLabel].some((label) =>
                  String(input.content).includes(label)
                ));
          return Promise.resolve({
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      operatorRunExecutor(args, policy) {
        dispatched++;
        assertEquals(policy?.authenticatedOwnerSessionId, ordinaryOwner.id);
        assertEquals(policy?.ceiling, "INTERNAL");
        assert(
          policy?.authorizeSentinelCaseRead?.("approved", approved.revision) ||
            args.revision !== approved.revision,
        );
        assertEquals(
          policy?.authorizeSentinelCaseRead?.("unregistered", hidden.revision),
          false,
        );
        return operator(
          args,
          rejectExecutorCeiling && policy
            ? { ...policy, ceiling: "PUBLIC" }
            : policy,
        );
      },
    }),
  });
  const { port } = await gateway.start();
  const url = `ws://127.0.0.1:${port}/chat?token=`;
  const unauthenticated = new WebSocket(url + "wrong-owner-token");
  const socket = new WebSocket(url + token);
  try {
    await new Promise<void>((resolve, reject) => {
      unauthenticated.addEventListener(
        "open",
        () => reject(new Error("Unauthenticated client connected")),
        { once: true },
      );
      unauthenticated.addEventListener("close", () => resolve(), {
        once: true,
      });
    });
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const turn = async (content: string, call?: Record<string, unknown>) => {
      request = call;
      result = "";
      hooks.length = 0;
      const done = Promise.withResolvers<readonly string[]>();
      const frames: string[] = [];
      const timer = setTimeout(
        () => done.reject(new Error("Missing Sentinel turn end")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        frames.push(String(data));
        if (JSON.parse(data).type === "turn_end") done.resolve(frames);
      };
      socket.addEventListener("message", receive);
      try {
        socket.send(JSON.stringify({ type: "message", content }));
        return await done.promise;
      } finally {
        socket.removeEventListener("message", receive);
        clearTimeout(timer);
      }
    };
    await turn("/sentinel on");
    const exact = {
      kind: "sentinel",
      id: "approved",
      revision: approved.revision,
    };
    await turn("Read the peer finding", { action: "findings", ...exact });
    assertStringIncludes(result, secretLabel);
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    assertEquals(dispatched, 1);
    const saved = JSON.parse(result);
    const graphNode = saved.page.nodes[0].id;

    await turn("Reopen the exact node", {
      ...exact,
      action: "node",
      node: graphNode,
    });
    assertStringIncludes(result, secretLabel);
    await turn("Read the peer graph", { ...exact, action: "graph" });
    assertStringIncludes(result, secretLabel);
    await turn("Read the peer graph summary", {
      ...exact,
      action: "graph_overview",
    });
    assertEquals(JSON.parse(result).overview.revision, approved.revision);

    const inventory = {
      ...exact,
      action: "inventory",
      scope: "membership",
    };
    await turn("Find one asset by its exact alias and type", {
      ...inventory,
      alias: "a.example",
      assetType: "service",
    });
    const assetPage = JSON.parse(result).page;
    assertEquals(assetPage.assets.map(({ id }: { id: string }) => id), [
      "asset-a",
    ]);
    assertEquals(assetPage.membership.version, approvedScope.version);

    await turn("List member organizations", {
      ...inventory,
      view: "organizations",
    });
    assertEquals(JSON.parse(result).page.organizations, [{
      id: "ops",
      label: "Operations",
      assetCount: 2,
    }]);

    const coverage = {
      ...inventory,
      view: "coverage",
      coverageGap: "unreviewed",
      limit: 1,
    };
    await turn("Find missing review coverage", coverage);
    const first = JSON.parse(result).page;
    assertEquals(first.assets[0].asset.id, "asset-a");
    assertEquals(
      first.membership.sourceSnapshotDigest,
      membership.snapshotDigest,
    );
    assert(first.nextCursor);
    await turn("Find more missing review coverage", {
      ...coverage,
      cursor: first.nextCursor,
    });
    const second = JSON.parse(result).page;
    assertEquals(second.assets[0].asset.id, "asset-b");
    assertEquals(second.nextCursor, null);
    await turn("Try a membership cursor against case-wide coverage", {
      ...coverage,
      scope: "case",
      cursor: first.nextCursor,
    });
    assertStringIncludes(result, "unavailable");

    const beforeForbiddenArg = dispatched;
    await turn("Attempt to change membership with an inventory request", {
      ...inventory,
      allowedAssetIds: ["asset-c"],
    });
    assertStringIncludes(result, "unavailable");
    assertEquals(dispatched, beforeForbiddenArg);
    rejectExecutorCeiling = true;
    await turn("Independently reject a public executor ceiling", inventory);
    assertStringIncludes(result, "unavailable");
    rejectExecutorCeiling = false;

    await turn("Unknown case", {
      ...exact,
      action: "graph",
      id: "unregistered",
    });
    assertStringIncludes(result, "unavailable");
    assert(!result.includes(hiddenLabel));
    await turn("Unknown revision", {
      ...exact,
      action: "graph",
      revision: exact.revision + 100,
    });
    assertStringIncludes(result, "unavailable");
    const beforeMutation = dispatched;
    await turn("Unexpected mutation", { ...exact, action: "pause" });
    assertStringIncludes(result, "unavailable");
    assertEquals(dispatched, beforeMutation);

    reject = "PRE_TOOL_CALL";
    await turn("Pre-call denial", inventory);
    assert(!result.includes(inventoryLabel));
    assertEquals(dispatched, beforeMutation);
    reject = "POST_TOOL_RESPONSE";
    await turn("Response classification denial", inventory);
    assert(!result.includes(inventoryLabel));
    assertEquals(dispatched, beforeMutation + 1);
    reject = "PRE_OUTPUT";
    const blocked = await turn("Output denial", inventory);
    assertStringIncludes(result, inventoryLabel);
    assert(blocked.every((frame) => !frame.includes(inventoryLabel)));

    reject = undefined;
    const selectedCase = await turn("/sentinel case");
    assert(
      selectedCase.some((frame) => frame.includes("Sentinel case: main.")),
    );
    verifyWorkerBinding = true;
    const worker = await turn(
      "/sentinel-agent Check the scoped worker bindings.",
    );
    assert(worker.some((frame) => frame.includes("Worker bindings verified.")));
    assertEquals(dispatched, beforeMutation + 2);
  } finally {
    socket.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
