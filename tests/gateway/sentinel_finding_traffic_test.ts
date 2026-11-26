import { sentinelFindingTrafficEvidenceVersion } from "../../src/sentinel/finding_traffic_links.ts";
import { recordOperatorSentinelRunHint } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import {
  advanceAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  recordSentinelOperatingConstraints,
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  importSentinelHar,
  parseReviewedHarRoute,
} from "../../src/sentinel/har.ts";
import { readSentinelChatSnapshot } from "../../src/sentinel/chat_mode.ts";
import { sentinelTrafficPath } from "../../src/sentinel/paths.ts";
import {
  readSentinelTrafficReceiptPage,
} from "../../src/sentinel/traffic_receipts.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

const caseId = "reviewed-finding-traffic";
const search = "sentinel_traffic_search";
const get = "sentinel_traffic_get";
const report = "sentinel_report_finding";
const attach = "sentinel_attach_finding_traffic";
const links = "sentinel_finding_traffic_links";
const recheckContext = "sentinel_finding_recheck_context";
const recordRecheck = "sentinel_record_finding_recheck";
const amend = "sentinel_update_finding_report";
const assigned = "sentinel_assigned_target";
const caseHints = "sentinel_case_hints";
const reviewedBody = "🙂".repeat(520) + "reviewed fixture";
const rawSecret = "unretained-finding-traffic-fixture";
const call = (name: string, args: Record<string, unknown> = {}) => ({
  name,
  args,
});

function createLease(
  path: string,
  state: ReturnType<typeof startSentinelAssessment>,
  assetId: string,
) {
  advanceAdaptiveSentinel(path, state);
  const revision = adaptiveRevision(state);
  const store = openSentinelAdaptiveStore(
    join(dirname(path), "sentinel-adaptive.db"),
  );
  try {
    store.sync(revision, [{
      kind: "impact",
      nodeId: assetId,
      reason: MODEL_ASSIGNMENT_REASON,
    }], revision);
    advanceAdaptiveSentinel(path, state);
    const lease = store.claimModelReview(
      revision,
      MODEL_ASSIGNMENT_REASON,
      (task) => task.kind === "impact" && task.nodeId === assetId,
    );
    assert(lease);
    return {
      assessmentRevision: state.revision,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
    };
  } finally {
    store.close();
  }
}

async function runWorker(
  path: string,
  lease: ReturnType<typeof createLease>,
  batches: readonly (readonly ReturnType<typeof call>[])[],
  deny?: "attach" | "get" | "payload-before" | "payload-after" | "output",
) {
  const offered = new Set<string>();
  const responses: string[][] = [];
  const checks: string[] = [];
  const events: ChatEvent[] = [];
  const hookRunner: HookRunner = {
    evaluateHook(hook, { session, input, auditInput }) {
      const name = String(
        input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name,
      );
      if ([search, get, attach, links].includes(name)) {
        assertEquals(session.taint, "INTERNAL");
        checks.push(`${hook}:${name}`);
        if (hook === "POST_TOOL_RESPONSE") {
          assert(typeof input.tool_response === "string");
          assert(!input.tool_response.includes(rawSecret));
          assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
        }
      }
      if (hook === "PRE_OUTPUT") {
        checks.push(hook);
        assertEquals(input.target_classification, "INTERNAL");
      }
      const allowed =
        !(hook === "PRE_TOOL_CALL" && deny === "attach" && name === attach) &&
        !(hook === "POST_TOOL_RESPONSE" && deny === "get" && name === get) &&
        !(name === links && hook === "PRE_TOOL_CALL" &&
          deny === "payload-before") &&
        !(name === links && hook === "POST_TOOL_RESPONSE" &&
          deny === "payload-after") &&
        !(hook === "PRE_OUTPUT" && deny === "output");
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        duration: 0,
        ruleId: null,
      });
    },
  };
  const providerRegistry = createProviderRegistry();
  let iteration = 0;
  providerRegistry.register({
    name: "traffic-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const definition of tools ?? []) {
        const named = definition as {
          name?: string;
          function?: { name?: string };
        };
        const name = named.function?.name ?? named.name;
        if (name) offered.add(name);
      }
      if (iteration) {
        const delivered = messages.filter(({ role }) => role === "tool");
        const length = batches[iteration - 1].length;
        responses.push(
          delivered.slice(-length).map(({ content }) => String(content)),
        );
      }
      const batch = batches[iteration++];
      return Promise.resolve({
        content: batch
          ? ""
          : '{"summary":"Reviewed retained traffic evidence.","followUps":[]}',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: batch?.map(({ name, args }, index) => ({
          id: `traffic-${iteration}-${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })) ?? [],
      });
    },
  });
  providerRegistry.setDefault("traffic-fixture");
  const worker = createSentinelSubagent({
    snapshotPath: path,
    providerRegistry,
    hookRunner,
    allowModelAccess: true,
    ...lease,
  });
  try {
    await worker.execute(
      "Review corroborating metadata for the assigned asset.",
      (event) => events.push(event),
    );
    assertEquals(responses.length, batches.length);
    return { responses, offered, checks, events };
  } finally {
    worker.clear();
  }
}

async function exportThroughTidepool(baseDir: string, revision: number) {
  const key = crypto.randomUUID();
  const handler = createTidepoolSentinelHandler(
    {
      baseDir,
      config: { sentinel: { allow_model_access: true } },
    } as BootstrapResult,
  );
  const host: A2UIHostState = {
    clients: new Set(),
    server: null,
    currentTree: null,
    resolvedPort: 0,
    cachedHtml: null,
    sessionKey: key,
    lastMcpConnected: -1,
    lastMcpConfigured: -1,
    topicHandlers: {
      sentinel: (message, socket) => void handler(message, socket),
    },
    socketCleanupCallbacks: [],
    canvasRenders: [],
  };
  const service = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => routeHostRequest(request, host, undefined),
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:${service.addr.port}/?key=${key}`,
  );
  const closed = Promise.withResolvers<void>();
  socket.addEventListener("close", () => closed.resolve(), { once: true });
  const response = Promise.withResolvers<Record<string, unknown>>();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.topic === "sentinel" && message.requestId === 1) {
      response.resolve(message);
    }
  });
  const timer = setTimeout(
    () => response.reject(new Error("No Tidepool provenance export")),
    3000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        topic: "sentinel",
        type: "export",
        format: "provenance",
        caseId,
        revision,
        requestId: 1,
      }),
    );
    const exported = await response.promise;
    assert(typeof exported.content === "string");
    assert(!exported.content.includes(rawSecret));
    return JSON.parse(exported.content);
  } finally {
    clearTimeout(timer);
    socket.close();
    await closed.promise;
    await service.shutdown();
  }
}

async function readTrafficThroughGateway(
  baseDir: string,
  requests: readonly Record<string, unknown>[],
  policy?: (hook: string) => boolean,
  approve = false,
) {
  const registry = createProviderRegistry();
  let result = "";
  let selected: Record<string, unknown> = {};
  registry.register({
    name: "recheck-traffic-operator",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") result = String(last.content);
      return Promise.resolve({
        content: last?.role === "tool" ? "Checked traffic." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: last?.role === "tool" ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(selected),
          },
        }],
      });
    },
  });
  registry.setDefault("recheck-traffic-operator");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "traffic-recheck" as ChannelId,
      }),
      providerRegistry: registry,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => Promise.resolve(approve),
      }),
      hookRunner: {
        evaluateHook: (hook) => {
          const allowed = policy?.(hook) ?? true;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            ruleId: null,
            duration: 0,
          });
        },
      },
    }),
  });
  const { port } = await gateway.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const results: string[] = [];
    for (const request of requests) {
      selected = request;
      const done = Promise.withResolvers<void>();
      const timeout = setTimeout(
        () => done.reject(new Error("Traffic read timed out")),
        3000,
      );
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "response") done.resolve();
        if (event.type === "error") done.reject(new Error(event.message));
      };
      ws.addEventListener("message", receive);
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            content: "Inspect the selected retained traffic.",
          }),
        );
        await done.promise;
        results.push(result);
      } finally {
        clearTimeout(timeout);
        ws.removeEventListener("message", receive);
      }
    }
    return results;
  } finally {
    ws.close();
    await gateway.stop();
  }
}

Deno.test("Leased workers attach only exact saved traffic and authenticated Tidepool reopens historical links", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, caseId);
  try {
    const startedDateTime = new Date(Date.now() - 60_000).toISOString();
    const entries = ["service", "neighbor"].map((host) => ({
      startedDateTime,
      request: {
        url: `https://${host}.example/private?token=${rawSecret}`,
        method: "GET",
        headers: [
          { name: "Accept", value: "application/fixture" },
          { name: "X-Unreviewed", value: "unretained-header-marker" },
        ],
      },
      response: {
        status: 403,
        content: { text: reviewedBody },
        headers: [{
          name: "Content-Type",
          value: `application/${host}-fixture`,
        }],
      },
    }));
    const { observations } = importSentinelHar({
      log: { version: "1.2", entries: entries },
    }, "fixture");
    await ingestSentinelTraffic(
      new Blob([entries.map((entry) => JSON.stringify(entry)).join("\n")])
        .stream(),
      "fixture",
      path,
      "har",
      true,
      false,
      true,
    );
    const { assetId } = observations[0];
    const observationId = "control-check";
    const snapshot = {
      version: 1,
      nodes: [
        { id: assetId, kind: "asset", label: "https://service.example" },
        {
          id: observations[1].assetId,
          kind: "asset",
          label: "https://neighbor.example",
        },
        {
          id: "case-finding",
          kind: "finding",
          label: "Control observation",
          severity: "high",
        },
        { id: "case-control", kind: "control", label: "Service control" },
        {
          id: observationId,
          kind: "evidence",
          label: "Recorded control failure",
          controlVerification: {
            outcome: "fail",
            observedAt: startedDateTime,
            validUntil: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      ],
      edges: [
        { from: "case-finding", to: assetId, relation: "affects" },
        { from: "case-control", to: "case-finding", relation: "mitigates" },
        { from: observationId, to: assetId, relation: "observed_on" },
        { from: observationId, to: "case-control", relation: "verifies" },
      ],
    };
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const revision = state.revision;
    const lease = createLease(path, state, assetId);
    const receipt = (origin: string) => {
      const selected = readSentinelTrafficReceiptPage(path, revision, {
        origin,
      })?.receipts[0];
      assert(selected);
      return {
        revision,
        evidenceId: selected.evidenceId,
        digest: selected.digest,
      };
    };
    const exact = receipt("https://service.example");
    const neighbor = receipt("https://neighbor.example");
    const hint = recordOperatorSentinelRunHint(
      path,
      revision,
      crypto.randomUUID(),
      "Review the recorded response.",
      "owner",
      [assetId],
      { evidenceId: exact.evidenceId, digest: exact.digest },
    );
    const otherHint = recordOperatorSentinelRunHint(
      path,
      revision,
      crypto.randomUUID(),
      "Review evidence on the neighboring asset.",
      "owner",
      [observations[1].assetId],
      { evidenceId: neighbor.evidenceId, digest: neighbor.digest },
    );
    assert(hint && otherHint);
    const hintView = await runWorker(path, lease, [[
      call(caseHints, { assignedTraffic: true, limit: 1 }),
      call(caseHints, {
        assignedTraffic: true,
        assetId: observations[1].assetId,
      }),
      call(caseHints),
    ]]);
    const discoveredHint = JSON.parse(hintView.responses[0][0]);
    assertEquals(discoveredHint.hints, [hint]);
    assertEquals(discoveredHint.nextBefore, null);
    assert(!JSON.stringify(discoveredHint).includes(rawSecret));
    assertStringIncludes(hintView.responses[0][1], "valid hint");
    assertEquals(JSON.parse(hintView.responses[0][2]).hints, []);

    const bodySearch = {
      action: "traffic_search",
      kind: "sentinel",
      id: caseId,
      revision,
      bodyContains: "REVIEWED FIXTURE",
      limit: 1,
    };
    const [matchingBody] = await readTrafficThroughGateway(baseDir, [
      bodySearch,
    ]);
    const firstMatch = JSON.parse(matchingBody);
    assertEquals(firstMatch.receipts.length, 1);
    assert(typeof firstMatch.nextCursor === "string");
    assert(!matchingBody.includes(reviewedBody));
    assert(!matchingBody.includes(rawSecret));
    const [continued, changedFilter, noMatch] = await readTrafficThroughGateway(
      baseDir,
      [
        { ...bodySearch, cursor: firstMatch.nextCursor },
        {
          ...bodySearch,
          bodyContains: "reviewed",
          cursor: firstMatch.nextCursor,
        },
        { ...bodySearch, bodyContains: "unretained-finding" },
      ],
    );
    const continuedBody = JSON.parse(continued);
    assertEquals(continuedBody.nextCursor, null);
    assertEquals(
      [firstMatch.receipts[0].evidenceId, continuedBody.receipts[0].evidenceId]
        .sort(),
      [exact.evidenceId, neighbor.evidenceId].sort(),
    );
    assertStringIncludes(changedFilter, "unavailable");
    assertEquals(JSON.parse(noMatch).receipts, []);
    const { bodyContains: _body, ...headerSearch } = bodySearch;
    const headerQuery = { ...headerSearch, headerContains: "CONTENT-TYPE" };
    const [headerResult] = await readTrafficThroughGateway(baseDir, [
      headerQuery,
    ]);
    const headerPage = JSON.parse(headerResult);
    assertEquals(headerPage.receipts.length, 1);
    assert(typeof headerPage.nextCursor === "string");
    assert(!headerResult.includes("application/"));
    const [headerContinued, wrongHeader, bodyCursor, unreviewed, bodyOnly] =
      await readTrafficThroughGateway(baseDir, [
        { ...headerQuery, cursor: headerPage.nextCursor },
        {
          ...headerQuery,
          headerContains: "application/fixture",
          cursor: headerPage.nextCursor,
        },
        { ...headerQuery, cursor: firstMatch.nextCursor },
        { ...headerQuery, headerContains: "unretained-header-marker" },
        { ...headerQuery, headerContains: "reviewed fixture" },
      ]);
    assertEquals(
      [
        headerPage.receipts[0].evidenceId,
        JSON.parse(headerContinued).receipts[0].evidenceId,
      ].sort(),
      [exact.evidenceId, neighbor.evidenceId].sort(),
    );
    assertStringIncludes(wrongHeader, "unavailable");
    assertStringIncludes(bodyCursor, "unavailable");
    assertEquals(JSON.parse(unreviewed).receipts, []);
    assertEquals(JSON.parse(bodyOnly).receipts, []);
    const [deniedHeader] = await readTrafficThroughGateway(
      baseDir,
      [headerQuery],
      (hook) => hook !== "PRE_TOOL_CALL",
    );
    assert(!deniedHeader.includes(exact.evidenceId));
    const scopedHeader = await runWorker(path, lease, [[
      call(search, { revision, headerContains: "application/service-fixture" }),
      call(search, {
        revision,
        headerContains: "application/neighbor-fixture",
      }),
    ]]);
    assertEquals(
      JSON.parse(scopedHeader.responses[0][0]).receipts.map(
        ({ evidenceId }: { evidenceId: string }) => evidenceId,
      ),
      [exact.evidenceId],
    );
    assertEquals(JSON.parse(scopedHeader.responses[0][1]).receipts, []);
    const submitted = await runWorker(path, lease, [
      [call(assigned)],
      [call(report, {
        graphFindingId: "case-finding",
        controlId: "case-control",
        evidenceId: observationId,
        requestId: crypto.randomUUID(),
        title: "Recorded service control gap",
        summary: "The retained control check failed.",
      })],
    ]);
    const findingId: string = JSON.parse(submitted.responses[1][0]).record.id;
    const findingHeader = {
      ...headerQuery,
      action: "finding_traffic_candidates",
      receiptId: findingId,
    };
    const [candidate, neighborCandidate] = await readTrafficThroughGateway(
      baseDir,
      [
        { ...findingHeader, headerContains: "application/service-fixture" },
        { ...findingHeader, headerContains: "application/neighbor-fixture" },
      ],
    );
    assertEquals(
      JSON.parse(candidate).page.receipts.map(
        ({ evidenceId }: { evidenceId: string }) => evidenceId,
      ),
      [exact.evidenceId],
    );
    assert(!candidate.includes("application/service-fixture"));
    assertEquals(JSON.parse(neighborCandidate).page.receipts, []);
    const mutation = {
      ...exact,
      findingId,
      reportVersion: 1,
      sourceHintId: discoveredHint.hints[0].id,
      evidenceRole: "proof",
      evidenceNote:
        "Shows the retained response at the time of the failed control check.",
      requestId: crypto.randomUUID(),
    };
    const denied = await runWorker(path, lease, [[call(get, exact)], [
      call(attach, mutation),
    ]], "attach");
    assert(denied.checks.includes(`PRE_TOOL_CALL:${attach}`));
    assert(!denied.checks.includes(`POST_TOOL_RESPONSE:${attach}`));
    const withheld = await runWorker(path, lease, [[call(get, exact)], [
      call(attach, mutation),
    ]], "get");
    assertEquals(withheld.responses[0][0], "Tool response withheld by policy.");
    assert(withheld.responses[1][0].startsWith("Error:"));
    assert(!JSON.stringify(withheld.events).includes(exact.digest));
    assertEquals(
      (await exportThroughTidepool(baseDir, revision)).findingTrafficLinks ??
        [],
      [],
    );
    const beforeAttachment = await runWorker(path, lease, [[
      call(links, { revision, findingId }),
    ]]);
    const previousEvidence = JSON.parse(beforeAttachment.responses[0][0])
      .evidenceVersion;
    const attached = await runWorker(path, lease, [
      [
        call(search, {
          revision,
          limit: 1,
          status: 403,
          bodyContains: "reviewed",
        }),
        call(get, neighbor),
        call(attach, mutation),
      ],
      [call(get, exact)],
      [
        call(attach, mutation),
        call(attach, mutation),
        call(links, { revision, findingId }),
        call(attach, { ...mutation, evidenceRole: "baseline" }),
        call(attach, {
          ...mutation,
          sourceHintId: otherHint.id,
          requestId: crypto.randomUUID(),
        }),
        call(attach, {
          ...mutation,
          sourceHintId: otherHint.id + 10,
          requestId: crypto.randomUUID(),
        }),
      ],
    ], "output");
    assert(
      [search, get, attach, links].every((name) => attached.offered.has(name)),
    );
    assertEquals(
      JSON.parse(attached.responses[0][0]).receipts.map((
        { evidenceId }: { evidenceId: string },
      ) => evidenceId),
      [exact.evidenceId],
    );
    assertStringIncludes(attached.responses[0][1], "unavailable");
    assert(attached.responses[0][2].startsWith("Error:"));
    assertEquals(
      JSON.parse(attached.responses[1][0]).receipt.digest,
      exact.digest,
    );
    const record = JSON.parse(attached.responses[2][0]).link;
    assert(record);
    assertEquals(JSON.parse(attached.responses[2][1]).link, record);
    assertEquals(JSON.parse(attached.responses[2][2]).links, [record]);
    const nodeRequest = {
      action: "node",
      kind: "sentinel",
      id: caseId,
      revision,
      node: "finding:case-finding",
    };
    const [plainNode, linkedNode, outOfScope] = await readTrafficThroughGateway(
      baseDir,
      [
        nodeRequest,
        { ...nodeRequest, includeFindingTraffic: true },
        {
          ...nodeRequest,
          node: "asset:" + assetId,
          includeFindingTraffic: true,
        },
      ],
    );
    const discovered = JSON.parse(linkedNode);
    assertEquals(discovered.page, JSON.parse(plainNode).page);
    assertEquals(discovered.findingTraffic, {
      graphFindingId: "case-finding",
      revision,
      links: [{
        findingId,
        assetId,
        trafficLinkId: record.id,
        evidenceVersion: sentinelFindingTrafficEvidenceVersion(
          path,
          revision,
          findingId,
          assetId,
        ).digest,
      }],
      nextOffset: null,
    });
    assert(!linkedNode.includes(reviewedBody));
    assert(outOfScope.startsWith("Error:"));
    assertEquals(record.reportVersion, 1);
    assertEquals(record.trafficDigest, exact.digest);
    assertEquals(record.evidenceRole, mutation.evidenceRole);
    assertEquals(record.sourceHint, { id: hint.id, runId: state.plan.runId });
    assertEquals(record.evidenceNote, mutation.evidenceNote);
    for (const deniedHint of attached.responses[2].slice(3)) {
      assertStringIncludes(deniedHint, "unavailable");
    }
    assertEquals(record.authority, {
      kind: "assignment",
      taskId: lease.assignedTaskId,
    });
    assert(attached.checks.includes(`POST_TOOL_RESPONSE:${attach}`));
    assert(attached.checks.includes("PRE_OUTPUT"));
    assert(attached.events.some(({ type }) => type === "error"));
    assert(!attached.events.some(({ type }) => type === "response"));

    const nodeLinks = { revision, graphFindingId: "case-finding" };
    const workerNodeRead = await runWorker(path, lease, [[
      call(links, nodeLinks),
      call(links, { ...nodeLinks, graphFindingId: "case-control" }),
      call(links, { ...nodeLinks, revision: revision + 1 }),
      call(links, { ...nodeLinks, findingId }),
    ]]);
    assertEquals(JSON.parse(workerNodeRead.responses[0][0]).links, [record]);
    assert(!workerNodeRead.responses[0][0].includes(reviewedBody));
    assert(workerNodeRead.checks.includes(`PRE_TOOL_CALL:${links}`));
    assert(workerNodeRead.checks.includes(`POST_TOOL_RESPONSE:${links}`));
    for (const deniedRead of workerNodeRead.responses[0].slice(1)) {
      assert(deniedRead.startsWith("Error:"));
    }

    const linkedPayload = {
      revision,
      findingId,
      trafficLinkId: record.id,
      payloadPart: "response",
    };
    const deniedRead = await runWorker(
      path,
      lease,
      [[call(links, linkedPayload)]],
      "payload-before",
    );
    assert(!deniedRead.checks.includes(`POST_TOOL_RESPONSE:${links}`));
    assert(!deniedRead.responses[0][0].includes("🙂"));
    const withheldRead = await runWorker(
      path,
      lease,
      [[call(links, linkedPayload)]],
      "payload-after",
    );
    assertEquals(
      withheldRead.responses[0][0],
      "Tool response withheld by policy.",
    );
    const opened = await runWorker(path, lease, [[
      call(links, linkedPayload),
      call(links, { ...linkedPayload, payloadOffset: 512 }),
      call(links, {
        ...linkedPayload,
        findingId: "worker-finding:" + "0".repeat(64),
      }),
    ]], "output");
    const first = JSON.parse(opened.responses[0][0]);
    const last = JSON.parse(opened.responses[0][1]);
    assertEquals(first.link, record);
    assertEquals(first.payload.nextOffset, 512);
    assertEquals(last.payload.nextOffset, null);
    assertEquals(first.payload.text + last.payload.text, reviewedBody);
    assertEquals(first.payload.responsePayload, last.payload.responsePayload);
    assertEquals(
      first.payload.responsePayload.sha256,
      createHash("sha256").update(reviewedBody).digest("hex"),
    );
    assertEquals(first._classification, "INTERNAL");
    assert(opened.responses[0][2].startsWith("Error:"));
    assert(!opened.events.some(({ type }) => type === "response"));

    const otherAsset = await runWorker(
      path,
      createLease(path, state, observations[1].assetId),
      [[call(links, linkedPayload), call(links, nodeLinks)]],
    );
    assert(
      otherAsset.responses[0].every((result) => result.startsWith("Error:")),
    );

    const evidenceVersion = JSON.parse(attached.responses[2][2])
      .evidenceVersion;
    assert(previousEvidence !== evidenceVersion);
    const reportUpdate = {
      findingId,
      expectedVersion: 1,
      title: "Traffic evidence reviewed",
      summary: "The report accounts for the attached traffic evidence.",
      requestId: crypto.randomUUID(),
    };
    const amendments = await runWorker(path, lease, [
      [call(amend, { ...reportUpdate, evidenceVersion: previousEvidence })],
      [call(amend, reportUpdate)],
      [call(amend, { ...reportUpdate, evidenceVersion })],
      [call(amend, { ...reportUpdate, evidenceVersion })],
    ]);
    assert(amendments.responses[0][0].startsWith("Error:"));
    assert(amendments.responses[1][0].startsWith("Error:"));
    const amendment = JSON.parse(amendments.responses[2][0]).amendment;
    assertEquals(amendment.version, 2);
    assertEquals(amendment.evidenceVersion, evidenceVersion);
    assertEquals(JSON.parse(amendments.responses[3][0]).amendment, amendment);

    const nextSnapshot = {
      ...snapshot,
      nodes: [...snapshot.nodes, {
        id: "new-asset",
        kind: "asset",
        label: "New attachment baseline",
      }, {
        id: "passing-control-check",
        kind: "evidence",
        label: "Verified remediation",
        controlVerification: {
          outcome: "pass",
          observedAt: new Date(Date.now() - 30_000).toISOString(),
          validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }],
      edges: [...snapshot.edges, {
        from: "passing-control-check",
        to: assetId,
        relation: "observed_on",
      }, {
        from: "passing-control-check",
        to: "case-control",
        relation: "verifies",
      }],
    };
    await Deno.writeTextFile(path, JSON.stringify(nextSnapshot));
    const newer = refreshSentinelAssessment(path);
    assert(newer && newer.revision > revision);
    const nextLease = createLease(path, newer, assetId);
    const current = { ...exact, revision: newer.revision };
    const stale = await runWorker(path, nextLease, [
      [call(amend, {
        findingId,
        expectedVersion: 2,
        title: "Version three",
        summary: "Reviewed retained evidence.",
        requestId: crypto.randomUUID(),
      })],
      [call(get, current)],
      [call(attach, {
        ...current,
        findingId,
        reportVersion: 1,
        requestId: crypto.randomUUID(),
      })],
    ]);
    const staleRead = await runWorker(path, nextLease, [[
      call(links, linkedPayload),
      call(links, { ...linkedPayload, revision: newer.revision }),
    ]]);
    assert(staleRead.responses[0].every((value) => value.startsWith("Error:")));
    assertEquals(JSON.parse(stale.responses[0][0]).amendment.version, 3);
    assert(stale.responses[2][0].startsWith("Error:"));
    assertEquals(
      (await exportThroughTidepool(baseDir, revision)).findingTrafficLinks,
      [record],
    );
    assertEquals(
      (await exportThroughTidepool(baseDir, newer.revision))
        .findingTrafficLinks ?? [],
      [],
    );
    const checked = await runWorker(path, nextLease, [
      [call(recheckContext, { findingId }), call(assigned)],
      [call(recordRecheck, {
        findingId,
        evidenceId: "passing-control-check",
        summary: "The new control observation passed.",
        requestId: crypto.randomUUID(),
      })],
      [call(links, { revision: newer.revision, findingId })],
    ]);
    const recheck = JSON.parse(checked.responses[1][0]).record;
    assertEquals(recheck.kind, "recheck");
    assertEquals(recheck.outcome, "pass");
    const beforeRecheckLink =
      JSON.parse(checked.responses[2][0]).evidenceVersion;
    const attachRecheck = {
      ...current,
      findingId,
      recheckId: recheck.id,
      reportVersion: 3,
      evidenceRole: "verification",
      evidenceNote:
        "Supporting traffic observed during the later control review.",
      requestId: crypto.randomUUID(),
    };
    const unrelated = "worker-recheck:" + "0".repeat(64);
    const staleHint = await runWorker(path, nextLease, [
      [call(get, current), call(caseHints, { assignedTraffic: true })],
      [call(attach, { ...attachRecheck, sourceHintId: hint.id })],
    ]);
    assertEquals(JSON.parse(staleHint.responses[0][1]).hints, []);
    assertStringIncludes(staleHint.responses[1][0], "unavailable");
    const bound = await runWorker(path, nextLease, [
      [call(get, current)],
      [
        call(attach, { ...attachRecheck, recheckId: unrelated }),
        call(attach, { ...attachRecheck, reportVersion: 2 }),
        call(attach, attachRecheck),
        call(attach, attachRecheck),
      ],
      [
        call(links, {
          revision: newer.revision,
          findingId,
          recheckId: recheck.id,
        }),
        call(links, {
          revision: newer.revision,
          findingId,
          recheckId: unrelated,
        }),
        call(links, { revision: newer.revision, recheckId: recheck.id }),
        call(links, { revision: newer.revision, findingId }),
      ],
    ]);
    assert(bound.responses[1][0].startsWith("Error:"));
    assert(bound.responses[1][1].startsWith("Error:"));
    const boundLink = JSON.parse(bound.responses[1][2]).link;
    assertEquals(boundLink.recheckId, recheck.id);
    assertEquals(boundLink.evidenceRevision, newer.revision);
    assertEquals(boundLink.trafficDigest, exact.digest);
    assertEquals(boundLink.evidenceRole, "verification");
    assertEquals(JSON.parse(bound.responses[1][3]).link, boundLink);
    const scopedPage = JSON.parse(bound.responses[2][0]);
    assertEquals(scopedPage.links, [boundLink]);
    assertEquals(JSON.parse(bound.responses[2][1]).links, []);
    assert(bound.responses[2][2].startsWith("Error:"));
    assertEquals(
      scopedPage.evidenceVersion,
      JSON.parse(bound.responses[2][3]).evidenceVersion,
    );
    assert(scopedPage.evidenceVersion !== beforeRecheckLink);

    const recheckPayload = {
      revision: newer.revision,
      findingId,
      recheckId: recheck.id,
      trafficLinkId: boundLink.id,
      payloadPart: "response",
    };
    const operatorPayload = {
      action: "finding_traffic",
      kind: "sentinel",
      id: caseId,
      receiptId: findingId,
      revision: newer.revision,
      recheckId: recheck.id,
      trafficLinkId: boundLink.id,
      payloadPart: "response",
    };
    const operatorPages = await readTrafficThroughGateway(baseDir, [
      operatorPayload,
      { ...operatorPayload, offset: 512 },
      { ...operatorPayload, recheckId: "worker-recheck:" + "0".repeat(64) },
    ]);
    assertEquals(JSON.parse(operatorPages[0]).link, boundLink);
    assertEquals(
      JSON.parse(operatorPages[0]).payload.text +
        JSON.parse(operatorPages[1]).payload.text,
      reviewedBody,
    );
    assert(operatorPages[2].startsWith("Error:"));
    const reopened = await runWorker(path, nextLease, [[
      call(links, recheckPayload),
      call(links, { ...recheckPayload, payloadOffset: 512 }),
      call(links, { ...recheckPayload, recheckId: unrelated }),
    ], [call(amend, {
      findingId,
      expectedVersion: 3,
      evidenceVersion: beforeRecheckLink,
      title: "Stale report",
      summary: "This version predates the recheck traffic link.",
      requestId: crypto.randomUUID(),
    })]]);
    assertEquals(
      JSON.parse(reopened.responses[0][0]).payload.text +
        JSON.parse(reopened.responses[0][1]).payload.text,
      reviewedBody,
    );
    assert(reopened.responses[0][2].startsWith("Error:"));
    assert(reopened.responses[1][0].startsWith("Error:"));
    assertEquals(
      (await exportThroughTidepool(baseDir, newer.revision))
        .findingTrafficLinks,
      [boundLink],
    );
    const runId = newer.plan.runId;
    assert(runId);
    const run = {
      kind: "sentinel",
      id: caseId,
      revision: newer.revision,
      runId,
    };
    const archiveId = crypto.randomUUID();
    const [stopped, archived] = await readTrafficThroughGateway(
      baseDir,
      [
        { ...run, action: "cancel" },
        { ...run, action: "archive", requestId: archiveId },
      ],
      undefined,
      true,
    );
    assertEquals(JSON.parse(stopped).run.status, "stopped");
    assertEquals(JSON.parse(archived).receipt.status, "succeeded");
    await Deno.rename(dirname(path), join(baseDir, "before-header-restore"));
    const [restored, restoredPage] = await readTrafficThroughGateway(
      baseDir,
      [
        {
          ...run,
          action: "restore",
          archiveId,
          requestId: crypto.randomUUID(),
        },
        { ...headerQuery, cursor: headerPage.nextCursor },
      ],
      undefined,
      true,
    );
    assertEquals(JSON.parse(restored).receipt.status, "succeeded");
    assertEquals(restoredPage, headerContinued);
    assert(recordSentinelOperatingConstraints(path, {
      runId,
      evidenceRevision: newer.revision,
      expectedVersion: 0,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      constraints: {
        deniedKinds: [],
        allowedAssetIds: [observations[1].assetId],
      },
    }));
    const [revokedHeader, revokedCandidate, revokedCursor] =
      await readTrafficThroughGateway(baseDir, [
        { ...headerQuery, headerContains: "application/service-fixture" },
        findingHeader,
        { ...headerQuery, cursor: headerPage.nextCursor },
      ]);
    assertEquals(JSON.parse(revokedHeader).receipts, []);
    assertStringIncludes(revokedCandidate, "unavailable");
    assertStringIncludes(revokedCursor, "unavailable");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Authenticated retained HTTP authority and URL searches bind cursors to scope", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, caseId);
  try {
    const origins = [
      "http://dual.example",
      "https://dual.example",
      "http://dual.example:8443",
      "https://dual.example:8443",
      "http://other.example:8443",
      "https://[2001:db8::2]:8443",
    ];
    const entries = origins.map((origin) => ({
      startedDateTime: new Date().toISOString(),
      request: { url: `${origin}/unretained`, method: "GET" },
      response: { status: 200 },
    }));
    await ingestSentinelTraffic(
      new Blob([entries.map((entry) => JSON.stringify(entry)).join("\n")])
        .stream(),
      "HTTP origin search fixture",
      path,
      "har",
    );
    const { observations, snapshot } = importSentinelHar({
      log: { version: "1.2", entries },
    }, "HTTP origin search fixture");
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const query = {
      action: "traffic_search",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      authority: "dual.example:8443",
      limit: 1,
    };
    const projectedOrigins = (page: {
      receipts: { observation: { origin: string } }[];
    }) => page.receipts.map(({ observation }) => observation.origin);
    const [first, host, http, https, ipv6, oldOrigin, dnsOnly] =
      await readTrafficThroughGateway(baseDir, [
        query,
        { ...query, authority: "DUAL.EXAMPLE", limit: 10 },
        { ...query, authority: "dual.example:80" },
        { ...query, authority: "dual.example:443" },
        { ...query, authority: "[2001:0DB8:0:0::2]:8443" },
        { ...query, authority: undefined, origin: origins[0] },
        { ...query, authority: undefined, hostname: "dual.example" },
      ]);
    const page = JSON.parse(first);
    assert(page.nextCursor);
    assertEquals(
      projectedOrigins(JSON.parse(host)).sort(),
      origins.slice(0, 4).sort(),
    );
    assertEquals(projectedOrigins(JSON.parse(http)), [origins[0]]);
    assertEquals(projectedOrigins(JSON.parse(https)), [origins[1]]);
    assertEquals(projectedOrigins(JSON.parse(ipv6)), [origins[5]]);
    assertEquals(projectedOrigins(JSON.parse(oldOrigin)), [origins[0]]);
    assertEquals(projectedOrigins(JSON.parse(dnsOnly)), []);
    const [next, ...rejected] = await readTrafficThroughGateway(baseDir, [
      { ...query, authority: "DUAL.EXAMPLE:8443", cursor: page.nextCursor },
      { ...query, authority: "dual.example", cursor: page.nextCursor },
      ...[
        "dual.example:65536",
        "dual.example/path",
        "user@dual.example",
        "https://dual.example",
        "dual.example\n",
      ].map((authority) => ({
        ...query,
        authority,
      })),
    ]);
    const continuation = JSON.parse(next);
    assertEquals(continuation.nextCursor, null);
    assertEquals(
      [...projectedOrigins(page), ...projectedOrigins(continuation)].sort(),
      origins.slice(2, 4).sort(),
    );
    for (const result of rejected) assertStringIncludes(result, "unavailable");
    const urlQuery = {
      ...query,
      authority: undefined,
      urlContains: "DUAL.EXAMPLE:8443",
    };
    const [firstUrl, pathOnly, literalPercent, malformedUrl] =
      await readTrafficThroughGateway(baseDir, [
        urlQuery,
        { ...urlQuery, urlContains: "/unretained" },
        { ...urlQuery, urlContains: "%" },
        { ...urlQuery, urlContains: "https://user@dual.example" },
      ]);
    const urlPage = JSON.parse(firstUrl);
    assert(urlPage.nextCursor);
    assertEquals(projectedOrigins(JSON.parse(pathOnly)), []);
    assertEquals(projectedOrigins(JSON.parse(literalPercent)), []);
    assertStringIncludes(malformedUrl, "unavailable");
    const [continuedUrl, wrongFilter] = await readTrafficThroughGateway(
      baseDir,
      [
        {
          ...urlQuery,
          urlContains: "dual.example:8443",
          cursor: urlPage.nextCursor,
        },
        {
          ...urlQuery,
          urlContains: "dual.example",
          cursor: urlPage.nextCursor,
        },
      ],
    );
    assertEquals(
      [
        ...projectedOrigins(urlPage),
        ...projectedOrigins(JSON.parse(continuedUrl)),
      ].sort(),
      origins.slice(2, 4).sort(),
    );
    assertStringIncludes(wrongFilter, "unavailable");
    const [blockedUrl] = await readTrafficThroughGateway(
      baseDir,
      [urlQuery],
      (hook) => hook !== "PRE_TOOL_CALL",
    );
    assert(!blockedUrl.includes("dual.example"));

    const lease = createLease(path, state, observations[3].assetId);
    const worker = await runWorker(path, lease, [[
      call(search, { revision: state.revision, authority: query.authority }),
      call(search, {
        revision: state.revision,
        authority: "other.example:8443",
      }),
      call(search, { revision: state.revision, urlContains: "DUAL.EXAMPLE" }),
      call(search, { revision: state.revision, urlContains: "other.example" }),
    ]]);
    assertEquals(projectedOrigins(JSON.parse(worker.responses[0][0])), [
      origins[3],
    ]);
    assertEquals(projectedOrigins(JSON.parse(worker.responses[0][1])), []);
    assertEquals(projectedOrigins(JSON.parse(worker.responses[0][2])), [
      origins[3],
    ]);
    assertEquals(projectedOrigins(JSON.parse(worker.responses[0][3])), []);
    for (
      const hook of [
        "PRE_TOOL_CALL:" + search,
        "POST_TOOL_RESPONSE:" + search,
        "PRE_OUTPUT",
      ]
    ) {
      assert(worker.checks.includes(hook));
    }

    assert(state.plan.runId);
    assert(recordSentinelOperatingConstraints(path, {
      runId: state.plan.runId,
      evidenceRevision: state.revision,
      expectedVersion: 0,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      constraints: {
        deniedKinds: [],
        allowedAssetIds: [observations[2].assetId],
      },
    }));
    const [narrowed, staleCursor, narrowedUrl, staleUrlCursor] =
      await readTrafficThroughGateway(baseDir, [
        query,
        { ...query, cursor: page.nextCursor },
        urlQuery,
        { ...urlQuery, cursor: urlPage.nextCursor },
      ]);
    assertEquals(projectedOrigins(JSON.parse(narrowed)), [origins[2]]);
    assertEquals(projectedOrigins(JSON.parse(narrowedUrl)), [origins[2]]);
    assertStringIncludes(staleCursor, "unavailable");
    assertStringIncludes(staleUrlCursor, "unavailable");
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});

Deno.test("Reviewed HAR routes are searchable under exact gateway scope without retaining raw segments", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir, caseId);
  try {
    const approved = "https://fixture.example:8443/public/{item}/status";
    const source = "Reviewed HAR route fixture";
    const urls = [
      "https://fixture.example:8443/public/opaque-private-value/status?key=discarded-secret",
      "https://fixture.example:8443/public/another-private-value/status",
      "http://fixture.example:8443/public/wrong-scheme/status",
      "https://other.example:8443/public/wrong-authority/status",
      "https://fixture.example:8443/private/not-approved/status",
      "https://user:password@fixture.example:8443/public/credential-url/status",
    ];
    const entries = urls.map((url, i) => ({
      startedDateTime: new Date(Date.now() - i * 1000).toISOString(),
      request: { url, method: "GET" },
      response: { status: 200 },
    }));
    await ingestSentinelTraffic(
      new Blob([entries.map((entry) => JSON.stringify(entry)).join("\n")])
        .stream(),
      source,
      path,
      "har",
      false,
      false,
      false,
      false,
      approved,
    );
    await ingestSentinelTraffic(
      new Blob([JSON.stringify({
        ...entries[0],
        request: {
          url: "https://other.example:8443/metrics?key=discarded-secret",
          method: "GET",
        },
      })]).stream(),
      source,
      path,
      "har",
      false,
      false,
      false,
      false,
      "https://other.example:8443/metrics",
    );
    const snapshot = await readSentinelChatSnapshot(sentinelTrafficPath(path));
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
    const state = startSentinelAssessment(path);
    const query = {
      action: "traffic_search",
      kind: "sentinel",
      id: caseId,
      revision: state.revision,
      authority: "fixture.example:8443",
      urlContains: "/public/{item}/",
      limit: 1,
    };
    const [first, needles, other] = await readTrafficThroughGateway(baseDir, [
      query,
      { ...query, urlContains: "opaque-private-value" },
      { ...query, authority: "other.example:8443" },
    ]);
    const page = JSON.parse(first);
    assertEquals(
      page.receipts[0].observation.reviewedRoute,
      "/public/{item}/status",
    );
    assert(page.nextCursor);
    assertEquals(JSON.parse(needles).receipts, []);
    assertEquals(JSON.parse(other).receipts, []);
    const [second, stale, exact] = await readTrafficThroughGateway(baseDir, [
      { ...query, cursor: page.nextCursor },
      { ...query, urlContains: "/status", cursor: page.nextCursor },
      {
        action: "traffic_get",
        kind: query.kind,
        id: query.id,
        revision: query.revision,
        evidenceId: page.receipts[0].evidenceId,
        digest: page.receipts[0].digest,
      },
    ]);
    assertEquals(
      JSON.parse(second).receipts[0].observation.reviewedRoute,
      "/public/{item}/status",
    );
    assertEquals(JSON.parse(second).nextCursor, null);
    assertStringIncludes(stale, "unavailable");
    assertStringIncludes(exact, "/public/{item}/status");
    for (const response of [first, second, exact]) {
      for (const secret of ["private-value", "discarded-secret", "password"]) {
        assert(!response.includes(secret));
      }
    }
    const otherAsset = JSON.parse(
      await readTrafficThroughGateway(baseDir, [
        { ...query, authority: "other.example:8443", urlContains: "/metrics" },
      ]).then(([response]) => response),
    ).receipts[0];
    assertEquals(otherAsset.observation.reviewedRoute, "/metrics");
    const lease = createLease(path, state, page.receipts[0].assetIds[0]);
    const worker = await runWorker(path, lease, [[
      call(search, {
        revision: state.revision,
        authority: query.authority,
        urlContains: query.urlContains,
      }),
      call(search, {
        revision: state.revision,
        authority: "other.example:8443",
        urlContains: "/metrics",
      }),
    ]]);
    assertEquals(JSON.parse(worker.responses[0][0]).receipts.length, 2);
    assertEquals(JSON.parse(worker.responses[0][1]).receipts, []);
    assert(worker.checks.includes(`PRE_TOOL_CALL:${search}`));
    assert(worker.checks.includes(`POST_TOOL_RESPONSE:${search}`));
    assert(worker.checks.includes("PRE_OUTPUT"));

    assert(state.plan.runId);
    assert(recordSentinelOperatingConstraints(path, {
      runId: state.plan.runId,
      evidenceRevision: state.revision,
      expectedVersion: 0,
      operatorScope: "owner",
      requestId: crypto.randomUUID(),
      constraints: {
        deniedKinds: [],
        allowedAssetIds: otherAsset.assetIds,
      },
    }));
    const [revoked] = await readTrafficThroughGateway(baseDir, [
      { ...query, cursor: page.nextCursor },
    ]);
    assertStringIncludes(revoked, "unavailable");

    const rejected = [
      "https://user:password@fixture.example/approved",
      "https://fixture.example/approved?key=value",
      "https://fixture.example/approved#part",
      "https://fixture.example/approved/%41",
    ];
    for (const input of rejected) {
      assertEquals(parseReviewedHarRoute(input), undefined);
    }
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
