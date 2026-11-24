import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { dispatchApprovedToolCall } from "../../src/agent/dispatch/security_pipeline.ts";
import type { SecurityContext } from "../../src/agent/dispatch/security_context.ts";
import type {
  OrchestratorConfig,
  ParsedToolCall,
} from "../../src/agent/orchestrator/orchestrator_types.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";
import { createWebToolExecutor } from "../../src/tools/web/tools.ts";
import { createWebFetcher } from "../../src/tools/web/fetch.ts";
import { createDomainPolicy } from "../../src/tools/web/policy.ts";
import {
  publishSentinelWebCapture,
  sentinelCaptureOrigins,
} from "../../src/sentinel/native_capture.ts";
import {
  sentinelNativeCapturePath,
  sentinelSnapshotPath,
} from "../../src/sentinel/paths.ts";
import { readSentinelProvenance } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { buildWebTools } from "../../src/gateway/startup/factory/web_tools.ts";
import type { TriggerFishConfig } from "../../src/core/config.ts";

Deno.test("Only approved owner web dispatch carries the Sentinel capture capability", async () => {
  const allowed: boolean[] = [];
  const executor = createWebToolExecutor({
    webFetcher: {
      fetch(_url, opts) {
        allowed.push(opts?.captureForSentinel === true);
        return Promise.resolve({ ok: false, error: "test" });
      },
    },
  });
  const call = {
    name: "web_fetch",
    args: { url: "https://example.test", captureForSentinel: true },
  } as ParsedToolCall;
  const context: SecurityContext = {
    toolName: call.name,
    toolFloor: null,
    resourceClassification: "PUBLIC",
    operationType: "read",
    isOwner: true,
    isTrigger: false,
    nonOwnerCeiling: null,
    resourceParam: "url",
    isOutboundRequest: true,
  };
  const run = (
    owner: boolean,
    taint: ClassificationLevel,
    sec: SecurityContext,
  ) =>
    dispatchApprovedToolCall(
      call,
      {
        isOwnerSession: () => owner,
        getSessionTaint: () => taint,
      } as unknown as OrchestratorConfig,
      sec,
      async (name, args, trust) =>
        await executor(name, args, trust) ?? "unknown",
    );
  await run(true, "INTERNAL", context);
  await run(true, "CONFIDENTIAL", context);
  await run(false, "PUBLIC", { ...context, isOwner: false });
  await run(true, "PUBLIC", { ...context, isTrigger: true });
  await run(true, "PUBLIC", {
    ...context,
    resourceClassification: "RESTRICTED",
  });
  assertEquals(allowed, [true, false, false, false, false]);
});

Deno.test("Native fetch metadata marks responses reached through redirects", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      new URL(request.url).pathname === "/redirect"
        ? new Response(null, { status: 302, headers: { Location: "/final" } })
        : new Response("test"),
  );
  try {
    const fetcher = createWebFetcher({
      domainPolicy: createDomainPolicy({
        allowlist: [],
        denylist: [],
        classificationMap: [],
      }),
      dnsChecker: () => Promise.resolve({ ok: true, value: "127.0.0.1" }),
    });
    for (
      const [route, direct] of [["final", true], ["redirect", false]] as const
    ) {
      const fetched = await fetcher.fetch(
        `http://127.0.0.1:${server.addr.port}/${route}`,
        { captureForSentinel: true },
      );
      assert(fetched.ok);
      assertEquals(fetched.value.directResponse, direct);
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("Native captures populate the main case's independent feed", async () => {
  assertThrows(() => sentinelCaptureOrigins(["https://example.test/path"]));
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const capture = sentinelNativeCapturePath(path);
    await Promise.all([
      publishSentinelWebCapture(
        capture,
        "https://fixture-user:fixture-password@example.test/fixture-path?token=fixture-query#fixture-fragment",
        200,
        "2026-01-01T00:00:00Z",
      ),
      publishSentinelWebCapture(
        capture,
        "https://example.test",
        201,
        "2026-01-01T00:00:01Z",
      ),
    ]);
    const published = await Deno.readTextFile(capture);
    assert(!published.includes("fixture-"));
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(capture)).mode! & 0o077, 0);
    }
    const state = startSentinelAssessment(path);
    assertEquals(
      state.result?.sharedGraph.snapshot?.edges.filter(({ relation }) =>
        relation === "observed_on"
      ).length,
      2,
    );
    const evidence = state.result?.sharedGraph.snapshot?.nodes.find(
      ({ kind, label }) => kind === "evidence" && label.includes("(HTTP 200)"),
    );
    assert(evidence);
    const exact = readSentinelProvenance(path, state.revision)?.graph.inspect(
      `evidence:${evidence.id}`,
    );
    assertEquals(exact?.node.label, evidence.label);
    assert(
      exact?.connections.some((edge) =>
        edge.kind === "edge" && edge.relation === "observed_on"
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Configured normal web dispatch publishes isolated evidence for the next case revision", async () => {
  const dir = await Deno.makeTempDir();
  const path = sentinelSnapshotPath(dir);
  const capturePath = sentinelNativeCapturePath(path);
  const origin = "https://93.184.215.14";
  const url = origin + "/private-path?token=private-query";
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (input) => {
    fetches++;
    assertEquals(input, url);
    const response = new Response("private-body", {
      status: 201,
      headers: { "set-cookie": "private-cookie" },
    });
    Object.defineProperty(response, "url", { value: url });
    return Promise.resolve(response);
  };
  try {
    const before = startSentinelAssessment(path);
    const { webFetcher } = buildWebTools(
      {
        sentinel: { capture_origins: [origin] },
      } as unknown as TriggerFishConfig,
      dir,
    );
    const executor = createWebToolExecutor({ webFetcher });
    const call: ParsedToolCall = { name: "web_fetch", args: { url } };
    const dispatch = (owner: boolean) =>
      dispatchApprovedToolCall(
        call,
        {
          isOwnerSession: () => owner,
          getSessionTaint: () => "INTERNAL",
        } as unknown as OrchestratorConfig,
        {
          toolName: call.name,
          toolFloor: null,
          resourceClassification: "PUBLIC",
          operationType: "read",
          isOwner: owner,
          isTrigger: false,
          nonOwnerCeiling: null,
          resourceParam: "url",
          isOutboundRequest: true,
        },
        async (name, args, trust) => await executor(name, args, trust) ?? "",
      );
    await dispatch(false);
    assertEquals(fetches, 1);
    try {
      await Deno.stat(capturePath);
      throw new Error("Non-owner dispatch unexpectedly published a capture");
    } catch (err) {
      assert(err instanceof Deno.errors.NotFound);
    }
    await dispatch(true);
    assertEquals(fetches, 2);
    const capture = await Deno.readTextFile(capturePath);
    assert(!capture.includes("private-"));
    const after = refreshSentinelAssessment(path)!;
    assert(after.revision > before.revision);
    const evidence = after.result?.sharedGraph.snapshot?.nodes.find(
      ({ kind, label }) => kind === "evidence" && label.includes("(HTTP 201)"),
    );
    assert(evidence);
    const ref = `evidence:${evidence.id}`;
    assertEquals(
      readSentinelProvenance(path, before.revision)?.graph.inspect(ref),
      undefined,
    );
    assertEquals(
      readSentinelProvenance(path, after.revision)?.graph.inspect(ref)?.node
        .label,
      evidence.label,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(dir, { recursive: true });
  }
});
