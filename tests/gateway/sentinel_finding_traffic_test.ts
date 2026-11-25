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
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { importSentinelHar } from "../../src/sentinel/har.ts";
import {
  readSentinelTrafficReceiptPage,
} from "../../src/sentinel/traffic_receipts.ts";
import { routeHostRequest } from "../../src/tools/tidepool/host/host_server.ts";
import type { A2UIHostState } from "../../src/tools/tidepool/host/host_types.ts";

const search = "sentinel_traffic_search";
const get = "sentinel_traffic_get";
const report = "sentinel_report_finding";
const attach = "sentinel_attach_finding_traffic";
const links = "sentinel_finding_traffic_links";
const amend = "sentinel_update_finding_report";
const assigned = "sentinel_assigned_target";
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
        caseId: "main",
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

Deno.test("Leased workers attach only exact saved traffic and authenticated Tidepool reopens historical links", async () => {
  const baseDir = await Deno.makeTempDir();
  const path = resolveSentinelCasePath(baseDir);
  try {
    const startedDateTime = new Date(Date.now() - 60_000).toISOString();
    const entries = ["service", "neighbor"].map((host) => ({
      startedDateTime,
      request: {
        url: `https://${host}.example/private?token=${rawSecret}`,
        method: "GET",
      },
      response: { status: 403, content: { text: reviewedBody } },
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
    const mutation = {
      ...exact,
      findingId,
      reportVersion: 1,
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
        call(search, { revision, limit: 1, status: 403 }),
        call(get, neighbor),
        call(attach, mutation),
      ],
      [call(get, exact)],
      [
        call(attach, mutation),
        call(attach, mutation),
        call(links, { revision, findingId }),
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
    assertEquals(record.reportVersion, 1);
    assertEquals(record.trafficDigest, exact.digest);
    assertEquals(record.authority, {
      kind: "assignment",
      taskId: lease.assignedTaskId,
    });
    assert(attached.checks.includes(`POST_TOOL_RESPONSE:${attach}`));
    assert(attached.checks.includes("PRE_OUTPUT"));
    assert(attached.events.some(({ type }) => type === "error"));
    assert(!attached.events.some(({ type }) => type === "response"));

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
      [[call(links, linkedPayload)]],
    );
    assert(otherAsset.responses[0][0].startsWith("Error:"));

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
  } finally {
    await Deno.remove(baseDir, { recursive: true });
  }
});
