import { startScopesentryHttpsFixture } from "./fixtures/scopesentry_https.ts";
import { fixtureInventoryCredential } from "./fixtures/scopesentry_inventory_responses.ts";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createMemorySecretStore } from "../../src/core/secrets/mod.ts";
import { createLineageStore } from "../../src/core/session/mod.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import { wireMcpServers } from "../../src/gateway/startup/infra/mcp.ts";
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
  readSentinelAssessment,
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

const tool = "operator_runs";
const connectorTool = "mcp_scopesentry_list_assets";

function operatorGateway(
  baseDir: string,
  confirm: () => Promise<boolean>,
  hookRunner: HookRunner,
  mcp: ReturnType<typeof wireMcpServers>,
  classifications: Map<string, ClassificationLevel>,
  probe?: {
    denyResponse?: () => boolean;
    denyOutput?: () => boolean;
    echo?: () => boolean;
    receive?: (frame: Record<string, unknown>) => void;
  },
) {
  let pendingInput: Record<string, unknown>;
  let toolResult: string | undefined;
  const registry = createProviderRegistry();
  registry.register({
    name: "scopesentry-test",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        toolResult = String(last.content);
        return Promise.resolve({
          usage,
          content: pendingInput.action === "scopesentry_inventory_sources"
            ? "The retained source lookup finished."
            : probe?.echo?.()
            ? toolResult
            : "The requested check finished.",
          toolCalls: [],
        });
      }
      return Promise.resolve({
        usage,
        content: "",
        toolCalls: [{
          type: "function",
          id: crypto.randomUUID(),
          function: { name: tool, arguments: JSON.stringify(pendingInput) },
        }],
      });
    },
  });
  registry.setDefault("scopesentry-test");

  return async function gateway<T>(
    test: (
      turn: (input: Record<string, unknown>) => Promise<string>,
    ) => Promise<T>,
  ) {
    const chatSession = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "daemon" as ChannelId,
      }),
      providerRegistry: registry,
      hookRunner,
      toolClassifications: classifications,
      getExtraTools: mcp.getToolDefinitions,
      enableStreaming: false,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        scopeSentryConnector: {
          lookup: () => mcp.getConnectorTools("scopesentry"),
          execute: mcp.executor!,
        },
        async confirm() {
          return await confirm();
        },
      }),
    });
    const token = crypto.randomUUID();
    const server = createGatewayServer({ port: 0, token, chatSession });
    const { port } = await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return await test(async (input) => {
        pendingInput = input;
        toolResult = undefined;
        const result = Promise.withResolvers<void>();
        const timer = setTimeout(
          () => result.reject(new Error("Gateway turn did not complete")),
          3000,
        );
        const listener = ({ data }: MessageEvent) => {
          const frame = JSON.parse(data);
          probe?.receive?.(frame);
          if (frame.type === "turn_end") result.resolve();
        };
        socket.addEventListener("message", listener);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Run the exact operator request.",
          }),
        );
        try {
          await result.promise;
          assertExists(toolResult);
          assert(!String(toolResult).includes("unrelated.example"));
          assert(!String(toolResult).includes(fixtureInventoryCredential));
          return toolResult;
        } finally {
          socket.removeEventListener("message", listener);
          clearTimeout(timer);
        }
      });
    } finally {
      if (socket.readyState < WebSocket.CLOSING) {
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true })
        );
        socket.close();
        await closed;
      }
      await server.stop();
    }
  };
}

async function verifyInventoryImport(transport: "stdio" | "native HTTPS") {
  const baseDir = await Deno.makeTempDir();
  const caseId = "approved-source";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const callsPath = join(baseDir, "connector-calls.jsonl");
  const https = transport === "native HTTPS"
    ? await startScopesentryHttpsFixture(callsPath)
    : undefined;
  const calls = async () =>
    (await Deno.readTextFile(callsPath)).split("\n").filter(Boolean).map((
      line,
    ) => JSON.parse(line));

  const session = createSession({
    userId: "owner" as UserId,
    channelId: "fixture" as ChannelId,
  });
  const secretStore = createMemorySecretStore();
  await secretStore.setSecret(
    "scopesentry-fixture",
    fixtureInventoryCredential,
  );
  let deny = "";
  let classificationsSeen = 0;
  let mcpInvocations = 0;
  const projectTool = "mcp_scopesentry_list_projects_data";
  const hookRunner: HookRunner = {
    evaluateHook(hook, context) {
      const call = context.input.tool_call as { name?: string } | undefined;
      if (
        hook === "POST_TOOL_RESPONSE" &&
        context.input.tool_name === connectorTool
      ) {
        assertEquals(context.session.taint, "INTERNAL");
        classificationsSeen++;
      }
      if (hook === "MCP_TOOL_CALL") mcpInvocations++;
      const blocked = deny === "pre" && hook === "PRE_TOOL_CALL" &&
          (call?.name === connectorTool || call?.name === projectTool) ||
        deny === "response" && hook === "POST_TOOL_RESPONSE" &&
          (context.input.tool_name === connectorTool ||
            context.input.tool_name === projectTool) ||
        deny === "output" && hook === "PRE_OUTPUT";
      return Promise.resolve({
        allowed: !blocked,
        action: blocked ? "BLOCK" : "ALLOW",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const classifications = new Map<string, ClassificationLevel>();
  const mcp = wireMcpServers(
    {
      scopesentry: https
        ? {
          url: https.url,
          api_key_ref: "keychain:scopesentry-fixture",
          classification: "INTERNAL",
        }
        : {
          command: Deno.execPath(),
          args: [
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            new URL("./fixtures/scopesentry_connector.ts", import.meta.url)
              .pathname,
            callsPath,
          ],
          env: { CONNECTOR_CREDENTIAL: "keychain:scopesentry-fixture" },
          classification: "INTERNAL",
        },
    },
    hookRunner,
    () => session,
    classifications,
    new Map(),
    {
      chatSession: null,
      gatewayServer: null,
      tidepoolHost: null,
    },
    secretStore,
    createLineageStore(createMemoryStorage()),
  );

  try {
    const deadline = Date.now() + 3000;
    while (
      !mcp.getConnectorTools("scopesentry")?.tools.includes(connectorTool)
    ) {
      assert(Date.now() < deadline, "The local connector did not connect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (https) {
      assertEquals(https.operations, [
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
    }
    await Deno.writeTextFile(callsPath, "");
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const initial = JSON.stringify({
      version: 1,
      nodes: [{ id: "safe.example", label: "safe.example", kind: "asset" }],
      edges: [],
    });
    await Deno.writeTextFile(path, initial, { mode: 0o600 });
    const state = startSentinelAssessment(path);
    const runId = state.plan.runId;
    assert(runId);
    const membership = resolveSentinelCaseMembership(
      state.result?.sharedGraph.snapshot,
      {
        caseId,
        evidenceRevision: state.revision,
        selector: {
          kind: "rules",
          rules: [
            { kind: "domain", value: "safe.example" },
            { kind: "registrationId", value: "fixture-registration" },
          ],
          reason: "Reviewed inventory scope.",
        },
      },
    );
    assert(membership);
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: state.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "fixture-owner",
      constraints: { allowedAssetIds: membership.assetIds, deniedKinds: [] },
      membership,
    }));
    const request = {
      action: "import_scopesentry_inventory",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      sourceDimension: "project",
      sourceSelection: "0123456789abcdef01234567",
      requestId: crypto.randomUUID(),
    };
    let confirmations = 0;
    let revoke = false;
    const frames: Record<string, unknown>[] = [];
    const gateway = operatorGateway(
      baseDir,
      async () => {
        confirmations++;
        if (revoke && confirmations % 2 === 0) {
          await mcp.withdrawConnectorTools("scopesentry");
        }
        return true;
      },
      hookRunner,
      mcp,
      classifications,
      { echo: () => true, receive: (frame) => frames.push(frame) },
    );

    await gateway(async (turn) => {
      const sources = {
        action: "scopesentry_inventory_sources",
        kind: request.kind,
        id: request.id,
        revision: request.revision,
        sourceDimension: "project",
        query: "Fiber",
      };
      if (https) {
        https.resolveToLoopback(true);
        assertStringIncludes(await turn(sources), "unavailable");
        https.resolveToLoopback(false);
        await secretStore.deleteSecret("scopesentry-fixture");
        assertStringIncludes(await turn(sources), "unavailable");
        await secretStore.setSecret(
          "scopesentry-fixture",
          fixtureInventoryCredential,
        );
        assertEquals(https.operations.length, 3);
        assertEquals(await calls(), []);
      }
      deny = "pre";
      assertStringIncludes(await turn(sources), "unavailable");
      assertEquals(await calls(), []);
      deny = "response";
      assertStringIncludes(await turn(sources), "unavailable");
      assertEquals((await calls()).length, 1, "project response denial");
      deny = "";
      const projects = JSON.parse(await turn(sources));
      assertEquals((await calls()).length, 2, "authorized project query");
      assertEquals(projects.sources, [{
        id: request.sourceSelection,
        name: "Fiber",
      }]);
      const tasks = JSON.parse(
        await turn({
          ...sources,
          sourceDimension: "task",
        }),
      );
      assertEquals(tasks.sources, [{
        id: "Fiber verification",
        name: "Fiber verification",
      }]);
      assertEquals(
        await calls(),
        Array(3).fill({
          pageIndex: 1,
          pageSize: 50,
          search: "Fiber",
        }),
      );
      assertStringIncludes(
        await turn({ ...sources, revision: state.revision + 1 }),
        "unavailable",
      );
      assertEquals((await calls()).length, 3);
      deny = "output";
      frames.length = 0;
      assertEquals(JSON.parse(await turn(sources)), projects);
      assert(
        !frames.some(({ type }) => type === "response" || type === "token"),
      );
      assertEquals((await calls()).length, 4);
      deny = "";
      await Deno.writeTextFile(callsPath, "");
      mcpInvocations = 0;
      classificationsSeen = 0;
      assert(
        (await turn({ ...request, sourceSelection: "*" })).includes(
          "unavailable",
        ),
      );
      deny = "pre";
      assert((await turn(request)).includes("unavailable"));
      assertEquals(await calls(), []);
      deny = "response";
      assert((await turn(request)).includes("unavailable"));
      assertEquals((await calls()).length, 1);
      assertEquals(await Deno.readTextFile(path), initial);
      deny = "";
      const result = JSON.parse(await turn(request));
      assertEquals(result.imported, 3);
      assertEquals(result.receipt.status, "succeeded");
      assert(readSentinelAssessment(path)!.revision > state.revision);
      const saved = await Deno.readTextFile(path);
      for (
        const expected of [
          "public.safe.example",
          "api.safe.example",
          "Fiber client",
          "ScopeSentry project",
        ]
      ) {
        assert(saved.includes(expected), expected);
      }
      assert(!saved.includes("unrelated.example"));
      assert(!saved.includes("synthetic-inventory-fixture"));
      const assetMetadata = JSON.parse(saved).nodes.map(
        ({ properties }: { properties?: Record<string, string[]> }) =>
          properties,
      );
      assert(assetMetadata.some(
        (properties: Record<string, string[]> | undefined) =>
          properties?.recordType?.[0] === "A",
      ));
      assert(assetMetadata.some(
        (properties: Record<string, string[]> | undefined) =>
          properties?.appName?.[0] === "Fiber client" &&
          properties.category?.[0] === "operator application" &&
          properties.appRegistrationId?.[0] === "fixture-registration",
      ));
      assertEquals((await calls()).length, 4);
      assertEquals(mcpInvocations, 4);
      assertEquals(classificationsSeen, 4);
      assertEquals((await calls()).at(-1).filter, {
        project: [request.sourceSelection],
      });
      deny = "output";
      frames.length = 0;
      assertEquals(JSON.parse(await turn(request)).receipt, result.receipt);
      assert(
        !frames.some(({ type }) => type === "response" || type === "token"),
      );
      assertEquals((await calls()).length, 4);
    });
    deny = "";
    await gateway(async (turn) => {
      assertEquals(
        JSON.parse(await turn(request)).receipt.status,
        "succeeded",
      );
      assertEquals((await calls()).length, 4);
      const latest = readSentinelAssessment(path)!;
      assert(
        (await turn({ ...request, requestId: crypto.randomUUID() })).includes(
          "unavailable",
        ),
      );
      assertEquals((await calls()).length, 4);
      const saved = await Deno.readTextFile(path);
      revoke = true;
      confirmations = 0;
      assert((await turn({
        ...request,
        revision: latest.revision,
        sourceDimension: "task",
        sourceSelection: "Fiber verification",
        requestId: crypto.randomUUID(),
      })).includes("unavailable"));
      assertEquals((await calls()).length, 7);
      assertEquals((await calls()).at(-1).filter, {
        task: ["Fiber verification"],
      });
      assertEquals(await Deno.readTextFile(path), saved);
      assert((await turn(request)).includes("unavailable"));
      assertStringIncludes(
        await turn({
          action: "scopesentry_inventory_sources",
          kind: "sentinel",
          id: caseId,
          revision: latest.revision,
          sourceDimension: "project",
        }),
        "unavailable",
      );
      assertEquals((await calls()).length, 7);
    });
  } finally {
    try {
      await mcp.manager.disconnectAll();
    } finally {
      await https?.close();
      await Deno.remove(baseDir, { recursive: true });
    }
  }
}

for (const transport of ["stdio", "native HTTPS"] as const) {
  Deno.test(
    `gateway imports exact retained connector inventory over ${transport} with live policy, scope and idempotent receipt`,
    () => verifyInventoryImport(transport),
  );
}
