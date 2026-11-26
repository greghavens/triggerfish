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
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraints,
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  digestSentinelSnapshot,
  readSentinelSourceSnapshotFile,
  sentinelSourceSnapshotPath,
} from "../../src/sentinel/shared_inventory.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";

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

function operatorGateway(
  baseDir: string,
  confirm: () => Promise<boolean>,
  denyPreTool = () => false,
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
    name: "withdrawal-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        toolResult = String(last.content);
        return Promise.resolve({
          usage,
          content: probe?.echo?.()
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
  registry.setDefault("withdrawal-fixture");

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
      hookRunner: {
        evaluateHook(hook, { input }) {
          const blocked = denyPreTool() && hook === "PRE_TOOL_CALL" &&
              (input.tool_call as { name?: string })?.name === tool ||
            probe?.denyResponse?.() && hook === "POST_TOOL_RESPONSE" &&
              input.tool_name === tool ||
            probe?.denyOutput?.() && hook === "PRE_OUTPUT";
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
  };
}

Deno.test("authenticated root withdrawal rechecks exact host preview and preserves immutable source receipts", async () => {
  const baseDir = await Deno.makeTempDir();
  let denyPreTool = false;
  let onConfirm: () => Promise<void> = () => Promise.resolve();
  let confirmations = 0;
  const gateway = operatorGateway(baseDir, async () => {
    ++confirmations;
    await onConfirm();
    return true;
  }, () => denyPreTool);

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

Deno.test("authenticated root inventory withdrawal retains the exact prior snapshot and refuses stale publication", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, sourceId);
  const peerPath = resolveSentinelCasePath(baseDir, peerId);
  let confirmations = 0;
  let duringApproval: () => Promise<void> = () => Promise.resolve();
  const gateway = operatorGateway(baseDir, async () => {
    ++confirmations;
    await duringApproval();
    return true;
  });
  const sourceRef = { kind: "sentinel", id: sourceId, host };
  const preview = { action: "preview_inventory_withdrawal", ...sourceRef };
  const change = { action: "withdraw_inventory_host", ...sourceRef };
  const requestId = crypto.randomUUID();
  function digest(value: unknown) {
    return digestSentinelSnapshot(loadSentinelGraph(value).snapshot());
  }
  function source() {
    return loadSentinelGraph(JSON.parse(Deno.readTextFileSync(path)))
      .snapshot();
  }
  try {
    for (const file of [path, peerPath]) {
      await Deno.mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(file, JSON.stringify(fixtureGraph), {
        mode: 0o600,
      });
      startSentinelAssessment(file);
    }
    const updated = {
      ...fixtureGraph,
      nodes: [...fixtureGraph.nodes, {
        id: "distinct",
        kind: "asset",
        label: "Later published asset",
      }],
    };
    let chosenDigest = "";
    let durableResponse: unknown;
    await gateway(async (turn) => {
      const firstPayload = JSON.parse(await turn(preview));
      const first = firstPayload.preview ?? firstPayload;
      assertEquals(
        first.previewDigest ?? first.previousDigest,
        digest(fixtureGraph),
      );
      duringApproval = () => Deno.writeTextFile(path, JSON.stringify(updated));
      const stale = await turn({
        ...change,
        requestId,
        previewDigest: digest(fixtureGraph),
      });
      assert(stale.startsWith("Error:"));
      assertEquals(confirmations, 1);
      assertEquals(digest(source()), digest(updated));

      duringApproval = () => Promise.resolve();
      const latestPayload = JSON.parse(await turn(preview));
      const latest = latestPayload.preview ?? latestPayload;
      chosenDigest = latest.previewDigest ?? latest.previousDigest;
      assertEquals(chosenDigest, digest(updated));
      durableResponse = JSON.parse(
        await turn({ ...change, requestId, previewDigest: chosenDigest }),
      );
      assertEquals(confirmations, 2);
      const live = source();
      assertEquals(live.nodes.map(({ id }) => id), [
        "safe.example.evil",
        "obs-a",
        "obs-b",
        "obs-prefix",
        "distinct",
      ]);
      assertEquals(live.edges, [{
        from: "obs-prefix",
        to: "safe.example.evil",
        relation: "observed_on",
      }]);
      assertEquals(
        await readSentinelSourceSnapshotFile(
          sentinelSourceSnapshotPath(baseDir, sourceId, chosenDigest),
          chosenDigest,
        ),
        loadSentinelGraph(updated).snapshot(),
      );
      assertEquals(
        digest(JSON.parse(await Deno.readTextFile(peerPath))),
        digest(fixtureGraph),
      );
    });
    await gateway(async (turn) => {
      assertEquals(
        JSON.parse(
          await turn({ ...change, requestId, previewDigest: chosenDigest }),
        ),
        durableResponse,
      );
      assertEquals(confirmations, 2);
      const after = source();
      assert(!after.nodes.some(({ id }) => id === host));
      const ambiguous = {
        ...after,
        nodes: [...after.nodes, {
          id: "first-owner",
          label: "First claimant",
          kind: "asset",
          aliases: [host],
        }, {
          id: "second-owner",
          label: "Second claimant",
          kind: "asset",
          aliases: ["SAFE.example."],
        }],
      };
      await Deno.writeTextFile(path, JSON.stringify(ambiguous));
      assert((await turn(preview)).startsWith("Error:"));
      assertEquals(confirmations, 2);
      assertEquals(source(), loadSentinelGraph(ambiguous).snapshot());
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("authenticated evidence digest preserves exact historical members across gateway restart", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "digest-source";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const peerPath = resolveSentinelCasePath(baseDir, "digest-peer");
  const source = {
    version: 1,
    nodes: [
      { id: "record-a", kind: "evidence", label: "Stable evidence A" },
      { id: "record-b", kind: "evidence", label: "Stable evidence B" },
      { id: "excluded", kind: "evidence", label: "Separate entry" },
    ],
    edges: [],
  };
  let approve = false;
  let confirmations = 0;
  const gateway = operatorGateway(baseDir, () => {
    ++confirmations;
    return Promise.resolve(approve);
  });
  try {
    for (const filename of [path, peerPath]) {
      await Deno.mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(filename, JSON.stringify(source), {
        mode: 0o600,
      });
    }
    const initial = startSentinelAssessment(path);
    const peer = startSentinelAssessment(peerPath);
    const ref = { kind: "sentinel", id: caseId, revision: initial.revision };
    let digestId = "";
    let originalDigest: unknown;
    await gateway(async (turn) => {
      const save = {
        action: "save_digest",
        ...ref,
        query: "Stable evidence",
        nodeKind: "evidence",
      };
      assert((await turn(save)).startsWith("Error:"));
      assertEquals(confirmations, 1);
      const before = JSON.parse(await turn({ action: "list_digests", ...ref }));
      assertEquals(before.page.digests, []);
      approve = true;
      const saved = JSON.parse(await turn(save)).digest;
      assert(saved && typeof saved.id === "string");
      assertEquals(saved.memberCount, 2);
      digestId = saved.id;
      originalDigest = saved;
      const listed = JSON.parse(await turn({ action: "list_digests", ...ref }));
      assertEquals(listed.page.digests, [saved]);
      assertEquals(confirmations, 2);
    });

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        ...source,
        nodes: [
          { id: "record-c", kind: "evidence", label: "Stable evidence C" },
          source.nodes[2],
        ],
      }),
    );
    const changed = refreshSentinelAssessment(path);
    assert(changed && changed.revision > initial.revision);
    await gateway(async (turn) => {
      const archived = JSON.parse(
        await turn({ action: "list_digests", ...ref }),
      );
      assertEquals(archived.page.digests, [originalDigest]);
      const current = JSON.parse(
        await turn({
          action: "list_digests",
          ...ref,
          revision: changed.revision,
        }),
      );
      assertEquals(current.page.digests, []);
      const expand = { action: "expand_digest", ...ref, digestId };
      const first = JSON.parse(await turn({ ...expand, limit: 1 })).page;
      assertEquals(first.digest, originalDigest);
      assert(first.nextCursor);
      assertEquals(first.members.length, 1);
      const second = JSON.parse(
        await turn({ ...expand, limit: 1, cursor: first.nextCursor }),
      ).page;
      assertEquals(second.digest, originalDigest);
      assertEquals(second.members.length, 1);
      assertEquals(second.nextCursor, null);
      const members = [...first.members, ...second.members];
      assertEquals(
        members.map((member) => member.id).sort(),
        ["evidence:record-a", "evidence:record-b"],
      );
      assert(!JSON.stringify(members).includes("record-c"));
      assert(
        (await turn({ ...expand, cursor: first.nextCursor + "-forged" }))
          .startsWith("Error:"),
      );
      for (
        const invalid of [
          { ...expand, id: "digest-peer", revision: peer.revision },
          { ...expand, revision: changed.revision },
        ]
      ) assert((await turn(invalid)).startsWith("Error:"));
      assertEquals(confirmations, 2);
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("owner root correction confirms exact evidence, reapplies hooks and replays the durable receipt", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, sourceId);
  const branch = {
    ...fixtureGraph,
    nodes: fixtureGraph.nodes,
    edges: fixtureGraph.edges,
  };
  let deny = "";
  let confirmations = 0;
  let onConfirm: () => Promise<boolean> = () => Promise.resolve(true);
  let frames: Record<string, unknown>[] = [];
  const gateway = operatorGateway(
    baseDir,
    async () => {
      confirmations++;
      return await onConfirm();
    },
    () => deny === "pre",
    {
      denyResponse: () => deny === "response",
      denyOutput: () => deny === "output",
      echo: () => deny === "output",
      receive: (frame) => frames.push(frame),
    },
  );
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, JSON.stringify(branch), { mode: 0o600 });
    const state = startSentinelAssessment(path);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    const store = openSentinelAssetDiscoveryStore(baseDir);
    try {
      const seed = (evidenceId: string, key: string) =>
        store.propose({
          sourceCaseId: sourceId,
          evidenceRevision: state.revision,
          sourceDigest: digestSentinelSnapshot(snapshot),
          taskId: "adaptive:" + key.repeat(64),
          claim: { kind: "asset", assetId: host, evidenceId },
        });
      const first = seed("obs-a", "a");
      const replacement = seed("obs-b", "b");
      const original = await decideSentinelAssetDiscovery(
        baseDir,
        sourceId,
        first.id,
        first.version,
        "approve",
      );
      assert(original);
      const ask = {
        kind: "sentinel",
        action: "correct_discovery",
        id: sourceId,
        revision: state.revision,
        originalId: original.id,
        originalVersion: original.version,
        replacementId: replacement.id,
        replacementVersion: replacement.version,
        requestId: crypto.randomUUID(),
      };
      const unchanged = () => {
        assertEquals(store.get(original.id), original);
        assertEquals(store.get(replacement.id), replacement);
        assertEquals(
          store.readCorrection({ sourceCaseId: sourceId, ...ask }),
          undefined,
        );
      };
      await gateway(async (turn) => {
        const list = JSON.parse(
          await turn({
            kind: "sentinel",
            action: "discovery_proposals",
            id: sourceId,
            revision: state.revision,
          }),
        );
        assertEquals(list.proposals, [replacement, original]);
        deny = "pre";
        assert((await turn(ask)).includes("denied") || confirmations === 0);
        assertEquals(confirmations, 0);
        unchanged();
        deny = "";
        onConfirm = () => Promise.resolve(false);
        assert((await turn(ask)).includes("unavailable"));
        assertEquals(confirmations, 1);
        unchanged();
        onConfirm = async () => {
          await Deno.writeTextFile(
            path,
            JSON.stringify({
              ...branch,
              edges: branch.edges.filter(({ from }) => from !== "obs-b"),
            }),
          );
          return true;
        };
        assert((await turn(ask)).includes("unavailable"));
        assertEquals(confirmations, 2);
        unchanged();
        await Deno.writeTextFile(path, JSON.stringify(branch));
        onConfirm = () => Promise.resolve(true);
        deny = "response";
        assert((await turn(ask)).includes("withheld by policy"));
        assertEquals(confirmations, 3);
        assertEquals(store.get(original.id)?.status, "withdrawn");
        assertEquals(store.get(replacement.id)?.status, "approved");
        deny = "output";
        frames = [];
        const projection = await turn(ask);
        assertEquals(
          JSON.parse(projection).correction.replacement.id,
          replacement.id,
        );
        assert(frames.some(({ type }) => type === "error"));
        assert(
          !frames.some(({ type }) => type === "response" || type === "token"),
        );
        assert(!JSON.stringify(frames).includes(replacement.sourceDigest));
      });
      deny = "";
      const committed = store.readCorrection({
        sourceCaseId: sourceId,
        ...ask,
      });
      assert(committed);
      await gateway(async (turn) => {
        const result = JSON.parse(await turn(ask));
        assertEquals(result.correction, committed);
        assertEquals(confirmations, 3);
        assert(
          (await turn({ ...ask, originalVersion: original.version + 1 }))
            .includes("unavailable"),
        );
        assert(
          (await turn({ ...ask, revision: state.revision + 1 })).includes(
            "unavailable",
          ),
        );
        assertEquals(confirmations, 3);
      });
    } finally {
      store.close();
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("authenticated owner reviews exact inventory affiliation without expanding approved membership", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, sourceId);
  const input = {
    kind: "sentinel",
    id: sourceId,
    assetId: host,
    organizationId: "ops",
    evidenceId: "obs-a",
    note: "Reviewed ownership records for this exact asset.",
  };
  const graph = {
    ...fixtureGraph,
    nodes: [...fixtureGraph.nodes, {
      id: "org-anchor",
      kind: "asset",
      label: "Known organization asset",
      organization: { id: "ops", label: "Operations" },
    }],
  };
  let confirmations = 0;
  let duringReview = () => Promise.resolve();
  let denyPre = false;
  let denyResponse = false;
  let denyOutput = false;
  const frames: Record<string, unknown>[] = [];
  const gateway = operatorGateway(
    baseDir,
    async () => {
      confirmations++;
      await duringReview();
      return true;
    },
    () => denyPre,
    {
      denyResponse: () => denyResponse,
      denyOutput: () => denyOutput,
      echo: () => true,
      receive: (frame) => frames.push(frame),
    },
  );
  const read = async () =>
    loadSentinelGraph(
      JSON.parse(await Deno.readTextFile(path)),
    ).snapshot();
  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, JSON.stringify(graph), { mode: 0o600 });
    const initial = startSentinelAssessment(path);
    const runId = initial.plan.runId;
    assert(runId);
    const membership = resolveSentinelCaseMembership(
      initial.result?.sharedGraph.snapshot,
      {
        caseId: sourceId,
        evidenceRevision: initial.revision,
        selector: { kind: "assets", assetIds: ["org-anchor"] },
      },
    );
    assert(membership);
    const initialPolicy = recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: initial.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "fixture-owner",
      constraints: {
        allowedAssetIds: membership.assetIds,
        deniedKinds: ["trace"],
      },
      membership,
    });
    assert(initialPolicy);
    const added = {
      ...graph,
      nodes: [...graph.nodes, {
        id: "second-observation",
        kind: "evidence",
        label: "Later evidence",
      }],
    };
    const preview = { ...input, action: "preview_inventory_affiliation" };
    const apply = {
      ...input,
      action: "affiliate_inventory_asset",
      requestId: crypto.randomUUID(),
    };
    let exactChange: Record<string, unknown> = {};
    let committed = "";
    await gateway(async (turn) => {
      for (
        const invalid of [
          { ...preview, organizationId: "unregistered" },
          { ...preview, evidenceId: "obs-prefix" },
          { ...preview, assetId: "org-anchor" },
        ]
      ) {
        assert((await turn(invalid)).includes("unavailable"));
      }
      const earlier = JSON.parse(await turn(preview)).preview;
      assertEquals(earlier.evidenceId, input.evidenceId);
      assertEquals(earlier.organizationLabel, "Operations");
      assertEquals(
        earlier.previousDigest,
        digestSentinelSnapshot(await read()),
      );
      assert(!JSON.stringify(earlier).includes(material));
      denyPre = true;
      assert(
        !(await turn({ ...apply, previewDigest: earlier.previousDigest }))
          .includes('"receipt"'),
      );
      denyPre = false;
      assertEquals(confirmations, 0);

      duringReview = async () => {
        await Deno.writeTextFile(path, JSON.stringify(added));
      };
      assert(
        (await turn({ ...apply, previewDigest: earlier.previousDigest }))
          .includes("unavailable"),
      );
      assertEquals(confirmations, 1);
      assertEquals(await read(), loadSentinelGraph(added).snapshot());

      const fresh = JSON.parse(await turn(preview)).preview;
      exactChange = { ...apply, previewDigest: fresh.previousDigest };
      duringReview = () => {
        denyPre = true;
        return Promise.resolve();
      };
      assert((await turn(exactChange)).includes("unavailable"));
      assertEquals(confirmations, 2);
      assertEquals(await read(), loadSentinelGraph(added).snapshot());
      denyPre = false;
      duringReview = () => Promise.resolve();
      denyResponse = true;
      assertEquals(
        await turn(exactChange),
        "Tool response withheld by policy.",
      );
      assertEquals(confirmations, 3);
      denyResponse = false;
      const latest = readSentinelAssessment(path);
      assert(latest && latest.revision > initial.revision);
      assertEquals(readSentinelOperatingConstraints(path), initialPolicy);
      const newAsset = latest.result?.sharedGraph.snapshot?.nodes.find((
        { id },
      ) => id === host);
      assert(newAsset?.kind === "asset");
      assertEquals(newAsset.organization, { id: "ops", label: "Operations" });
      const scoped = JSON.parse(
        await turn({
          action: "inventory",
          kind: "sentinel",
          id: sourceId,
          revision: latest.revision,
          scope: "membership",
        }),
      ).page;
      assertEquals(scoped.assets.map(({ id }: { id: string }) => id), [
        "org-anchor",
      ]);
      const archived = await readSentinelSourceSnapshotFile(
        sentinelSourceSnapshotPath(baseDir, sourceId, fresh.previousDigest),
        fresh.previousDigest,
      );
      assertEquals(archived, loadSentinelGraph(added).snapshot());

      frames.length = 0;
      denyOutput = true;
      committed = await turn(exactChange);
      denyOutput = false;
      const { receipt } = JSON.parse(committed);
      assertEquals(receipt.requestId, apply.requestId);
      assertEquals(receipt.status, "succeeded");
      assertEquals(receipt.nextDigest, fresh.nextDigest);
      assert(
        frames.every((frame) => !JSON.stringify(frame).includes(input.note)),
      );
      assertEquals(confirmations, 3);
    });
    await gateway(async (turn) => {
      assertEquals(await turn(exactChange), committed);
      assert(
        (await turn({ ...exactChange, note: "Unreviewed replacement." }))
          .includes("unavailable"),
      );
      assertEquals(confirmations, 3);
    });
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
