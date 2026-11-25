import { assert, assertEquals, assertExists } from "@std/assert";
import { dirname } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { decideSentinelAssetDiscovery } from "../../src/gateway/sentinel_asset_discoveries.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import {
  readSentinelAssessmentRevision,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { digestSentinelSnapshot } from "../../src/sentinel/shared_inventory.ts";

const tool = "operator_runs";
const host = "safe.example";
const sourceId = "withdraw-source";
const peerId = "withdraw-peer";
const material = "Unpublished operational material must not be returned";
const fixtureGraph = {
  version: 1,
  nodes: [
    { id: host, kind: "asset", label: "Exact source host" },
    { id: "safe.example.evil", kind: "asset", label: "Different hostname" },
    { id: "obs-a", kind: "evidence", label: material },
    { id: "obs-b", kind: "evidence", label: "Additional approved evidence" },
    { id: "obs-prefix", kind: "evidence", label: "Prefix-only graph neighbor" },
  ],
  edges: [
    { from: "obs-a", to: host, relation: "observed_on" },
    { from: "obs-b", to: host, relation: "observed_on" },
    { from: "obs-prefix", to: "safe.example.evil", relation: "observed_on" },
  ],
};

Deno.test("authenticated root withdrawal rechecks exact host preview and preserves immutable source receipts", async () => {
  const baseDir = await Deno.makeTempDir();
  let pendingInput: Record<string, unknown>;
  let toolResult: string | undefined;
  let denyPreTool = false;
  let onConfirm: () => Promise<void> = () => Promise.resolve();
  let confirmations = 0;
  const registry = createProviderRegistry();
  registry.register({
    name: "withdrawal-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        toolResult = String(last.content);
        return Promise.resolve({
          usage,
          content: "The requested check finished.",
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
  registry.setDefault("withdrawal-fixture");

  async function gateway<T>(
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
      hookRunner: {
        evaluateHook(hook, { input }) {
          const blocked = denyPreTool && hook === "PRE_TOOL_CALL" &&
            (input.tool_call as { name?: string })?.name === tool;
          return Promise.resolve({
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            ruleId: null,
            duration: 0,
          });
        },
      },
      enableStreaming: false,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        async confirm() {
          ++confirmations;
          await onConfirm();
          return true;
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
          if (JSON.parse(data).type === "turn_end") result.resolve();
        };
        socket.addEventListener("message", listener);
        socket.send(
          JSON.stringify({
            type: "message",
            content: "Run the requested withdrawal fixture.",
          }),
        );
        try {
          await result.promise;
          assertExists(toolResult);
          assert(!String(toolResult).includes(material));
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
  }

  const paths = [sourceId, peerId].map((id) =>
    resolveSentinelCasePath(baseDir, id)
  );
  const store = (() => {
    Deno.mkdirSync(dirname(paths[0]), { recursive: true, mode: 0o700 });
    return openSentinelAssetDiscoveryStore(baseDir);
  })();
  try {
    for (const path of paths) {
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(path, JSON.stringify(fixtureGraph), {
        mode: 0o600,
      });
    }
    const [source, peer] = paths.map((path) => startSentinelAssessment(path));
    const seed = (
      caseId: string,
      revision: number,
      path: string,
      assetId: string,
      evidenceId: string,
    ) => {
      const snapshot = readSentinelAssessmentRevision(path, revision)?.result
        .sharedGraph.snapshot;
      assertExists(snapshot);
      return store.propose({
        sourceCaseId: caseId,
        taskId: "adaptive:" + (evidenceId === "obs-b" ? "b" : "a").repeat(64),
        evidenceRevision: revision,
        sourceDigest: digestSentinelSnapshot(snapshot),
        claim: { kind: "asset", assetId, evidenceId },
      });
    };
    const first = seed(sourceId, source.revision, paths[0], host, "obs-a");
    const late = seed(sourceId, source.revision, paths[0], host, "obs-b");
    const prefix = seed(
      sourceId,
      source.revision,
      paths[0],
      "safe.example.evil",
      "obs-prefix",
    );
    const other = seed(peerId, peer.revision, paths[1], host, "obs-a");
    for (const record of [first, prefix, other]) {
      assert(
        await decideSentinelAssetDiscovery(
          baseDir,
          record.sourceCaseId,
          record.id,
          record.version,
          "approve",
        ),
      );
    }
    const selector = { kind: "sentinel", id: sourceId, host };
    const preview = { action: "preview_discovery_withdrawal", ...selector };
    const mutation = { action: "withdraw_discoveries", ...selector };
    const requestId = crypto.randomUUID();
    let approvedDigest = "";
    let durableResult: unknown;
    await gateway(async (turn) => {
      const payload = JSON.parse(await turn(preview));
      const firstPreview = payload.preview ?? payload;
      assertEquals(firstPreview.discoveries, [{ id: first.id, version: 2 }]);
      const initialDigest = firstPreview.previewDigest;
      assert(/^[a-f0-9]{64}$/.test(initialDigest));
      denyPreTool = true;
      const denied = await turn({
        ...mutation,
        requestId,
        previewDigest: initialDigest,
      });
      assert(!denied.startsWith("{"));
      assertEquals(confirmations, 0);
      denyPreTool = false;

      onConfirm = async () => {
        assert(
          await decideSentinelAssetDiscovery(
            baseDir,
            sourceId,
            late.id,
            late.version,
            "approve",
          ),
        );
      };
      const stale = await turn({
        ...mutation,
        requestId,
        previewDigest: initialDigest,
      });
      assert(stale.startsWith("Error:"));
      assertEquals(confirmations, 1);
      for (const record of [first, late, prefix, other]) {
        assertEquals(store.get(record.id)?.status, "approved");
      }

      onConfirm = () => Promise.resolve();
      const latestPayload = JSON.parse(await turn(preview));
      const latest = latestPayload.preview ?? latestPayload;
      assertEquals(
        latest.discoveries.map(({ id }: { id: string }) => id).sort(),
        [first.id, late.id].sort(),
      );
      approvedDigest = latest.previewDigest;
      assert(approvedDigest !== initialDigest);
      const wrongCase = await turn({
        ...mutation,
        id: peerId,
        requestId: crypto.randomUUID(),
        previewDigest: approvedDigest,
      });
      assert(wrongCase.startsWith("Error:"));
      durableResult = JSON.parse(
        await turn({ ...mutation, requestId, previewDigest: approvedDigest }),
      );
      const withdrawal =
        (durableResult as { receipt?: unknown; withdrawal?: unknown })
          .receipt ??
          (durableResult as { withdrawal?: unknown }).withdrawal ??
          durableResult;
      assertEquals(
        (withdrawal as { withdrawn: { id: string }[] }).withdrawn.map((
          { id },
        ) => id).sort(),
        [first.id, late.id].sort(),
      );
      for (const row of [first, late]) {
        const retained = store.get(row.id);
        assertEquals(retained?.status, "withdrawn");
        assertEquals(retained?.version, 3);
        assertEquals(retained?.sourceDigest, row.sourceDigest);
        assertEquals(retained?.claim, row.claim);
      }
      assertEquals(store.get(prefix.id)?.status, "approved");
      assertEquals(store.get(other.id)?.status, "approved");
    });
    const approvedCount = confirmations;
    await gateway(async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({ ...mutation, requestId, previewDigest: approvedDigest }),
        ),
        durableResult,
      );
      assertEquals(confirmations, approvedCount);
      assertEquals(store.get(first.id)?.version, 3);
      assertEquals(store.get(late.id)?.version, 3);
      assert(
        (await turn({ ...mutation, requestId, previewDigest: "b".repeat(64) }))
          .startsWith("Error:"),
      );
    });
  } finally {
    store.close();
    await Deno.remove(baseDir, { recursive: true });
  }
});
