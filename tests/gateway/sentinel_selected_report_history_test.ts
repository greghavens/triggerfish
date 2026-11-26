import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
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
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { sentinelFindingTrafficEvidenceVersion } from "../../src/sentinel/finding_traffic_links.ts";

Deno.test("Selected Sentinel owner opens exact finding reports and paged history under current case authorization", async () => {
  const baseDir = await Deno.makeTempDir();
  const id = "report-review";
  const other = "another-report";
  const path = resolveSentinelCasePath(baseDir, id);
  const original = "Initial exact control report";
  const amendment = "Reviewed amended control report";
  type Hook = "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT";
  let blocked: Hook | undefined;
  const effects = new Set<string>();
  const output: string[] = [];
  let request: Record<string, unknown> | undefined;
  let result = "";
  let olderModelText = "";
  let echo = false;
  const registry = createProviderRegistry();
  registry.register({
    name: "finding-report-history-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (last?.role === "tool") {
        result = String(last.content);
        return Promise.resolve({
          content: echo ? result : "Checked report.",
          usage,
          toolCalls: [],
        });
      }
      olderModelText = JSON.stringify(messages);
      return Promise.resolve({
        content: "",
        usage,
        toolCalls: request
          ? [{
            type: "function",
            id: crypto.randomUUID(),
            function: {
              name: "operator_runs",
              arguments: JSON.stringify(request),
            },
          }]
          : [],
      });
    },
  });
  registry.setDefault("finding-report-history-fixture");
  const token = crypto.randomUUID();
  const gateway = createGatewayServer({
    port: 0,
    token,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "case-reports" as ChannelId,
      }),
      providerRegistry: registry,
      sentinelSnapshotPath: resolveSentinelCasePath(baseDir),
      sentinelSharedInventoryBaseDir: baseDir,
      resolveSentinelChatCase: (caseId) =>
        [id, other].includes(caseId)
          ? resolveSentinelCasePath(baseDir, caseId)
          : undefined,
      allowSentinelModelAccess: true,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: () => Promise.resolve(true),
      }),
      hookRunner: {
        evaluateHook(hook, { input }) {
          const call = input.tool_call as
            | { args?: Record<string, unknown> }
            | undefined;
          const matches = hook === "PRE_TOOL_CALL"
            ? call?.args?.action === "finding_report"
            : hook === "POST_TOOL_RESPONSE"
            ? String(input.tool_response).includes(amendment)
            : hook === "PRE_OUTPUT" &&
              String(input.content).includes(amendment);
          if (matches) effects.add(hook);
          const allowed = !matches || hook !== blocked;
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            duration: 0,
            ruleId: null,
          });
        },
      },
    }),
  });
  let socket: WebSocket | undefined;
  try {
    const observedAt = new Date(Date.now() - 60000).toISOString();
    const validUntil = new Date(Date.now() + 3600000).toISOString();
    const snapshot = {
      version: 1,
      nodes: [
        { id: "app", kind: "asset", label: "Primary application" },
        { id: "control", kind: "control", label: "Required control" },
        { id: "gap", kind: "finding", label: "Control gap", severity: "high" },
        {
          id: "proof",
          kind: "evidence",
          label: "Approved local evidence",
          controlVerification: { outcome: "fail", observedAt, validUntil },
        },
      ],
      edges: [
        { from: "proof", to: "app", relation: "observed_on" },
        { from: "proof", to: "control", relation: "verifies" },
        { from: "gap", to: "app", relation: "affects" },
        { from: "control", to: "gap", relation: "mitigates" },
      ],
    };
    for (const caseId of [id, other]) {
      const selectedPath = resolveSentinelCasePath(baseDir, caseId);
      await Deno.mkdir(dirname(selectedPath), { recursive: true });
      await Deno.writeTextFile(selectedPath, JSON.stringify(snapshot));
      startSentinelAssessment(selectedPath);
    }
    const state = readSentinelAssessment(path);
    assert(state?.plan.runId);
    const ref = { kind: "sentinel", id, revision: state.revision };
    const run = { ...ref, runId: state.plan.runId };
    const { port } = await gateway.start();
    const authorized = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      authorized.addEventListener("open", () => resolve(), { once: true });
      authorized.addEventListener("error", reject, { once: true });
    });
    const turn = async (selector: string | Record<string, unknown>) => {
      request = typeof selector === "string" ? undefined : selector;
      result = "";
      output.length = 0;
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("Report gateway timed out")),
        3500,
      );
      const receive = ({ data }: MessageEvent) => {
        output.push(String(data));
        const event = JSON.parse(data);
        if (event.type === "turn_end") done.resolve();
        if (event.type === "error") {
          if (
            blocked === "PRE_OUTPUT" &&
            event.message === "Output blocked by policy"
          ) {
            done.resolve();
          } else {
            done.reject(new Error(event.message));
          }
        }
      };
      authorized.addEventListener("message", receive);
      try {
        authorized.send(JSON.stringify({
          type: "message",
          content: typeof selector === "string"
            ? selector
            : "Open the exact report record.",
        }));
        await done.promise;
        return result;
      } finally {
        clearTimeout(timer);
        authorized.removeEventListener("message", receive);
      }
    };
    const created = await turn({
      ...run,
      action: "record_analyst_finding",
      targetId: "app",
      findingId: "gap",
      controlId: "control",
      evidenceId: "proof",
      title: original,
      summary: "The control did not pass the saved evidence check.",
      requestId: crypto.randomUUID(),
    });
    assert(created.startsWith("{"), created);
    const receiptId = JSON.parse(created).receipt.id;
    const amended = await turn({
      ...ref,
      action: "amend_finding_report",
      receiptId,
      reportVersion: 1,
      evidenceVersion:
        sentinelFindingTrafficEvidenceVersion(path, state.revision, receiptId)
          .digest,
      requestId: crypto.randomUUID(),
      title: amendment,
      summary: "Second version preserves the original local evidence.",
    });
    assert(amended.startsWith("{"), amended);
    assertEquals(JSON.parse(amended).amendment.version, 2);
    const report = {
      ...ref,
      action: "finding_report",
      includeReportEvidence: true,
      receiptId,
    };
    const history = {
      ...ref,
      action: "finding_report_history",
      receiptId,
      limit: 1,
    };
    const first = { ...report, reportVersion: 1 };
    const currentReport = await turn(report);
    const originalReport = await turn(first);
    assertEquals(JSON.parse(currentReport).report.title, amendment);
    assertEquals(JSON.parse(originalReport).report.title, original);

    await turn("/sentinel on");
    await turn(`/sentinel case ${id}`);
    assertEquals(await turn(report), currentReport);
    assertEquals(await turn(first), originalReport);
    const page = JSON.parse(await turn(history)).page;
    assertEquals(
      page.versions.map(({ version }: { version: number }) => version),
      [2],
    );
    assert(page.nextCursor);
    const next =
      JSON.parse(await turn({ ...history, cursor: page.nextCursor })).page;
    assertEquals(
      next.versions.map(({ version }: { version: number }) => version),
      [1],
    );
    assertEquals(next.nextCursor, null);
    assertStringIncludes(await turn({ ...report, id: other }), "unavailable");
    assertStringIncludes(await turn({ ...history, id: other }), "unavailable");
    assertStringIncludes(
      await turn({ ...report, reportVersion: 999 }),
      "unavailable",
    );

    for (
      const hook of [
        "PRE_TOOL_CALL",
        "POST_TOOL_RESPONSE",
        "PRE_OUTPUT",
      ] as const
    ) {
      effects.clear();
      blocked = hook;
      echo = hook === "PRE_OUTPUT";
      await turn(report);
      assert(effects.has(hook));
      if (hook !== "PRE_OUTPUT") assert(!result.includes(amendment));
      assert(!output.join("\n").includes(amendment));
    }
    blocked = undefined;
    echo = false;

    await turn("/sentinel off");
    const archiveId = crypto.randomUUID();
    assertEquals(
      JSON.parse(await turn({ ...run, action: "cancel" })).run.status,
      "stopped",
    );
    assertEquals(
      JSON.parse(
        await turn({
          ...run,
          action: "archive",
          requestId: archiveId,
        }),
      ).receipt.status,
      "succeeded",
    );
    await Deno.rename(dirname(path), join(baseDir, "before-report-restore"));
    assertEquals(
      JSON.parse(
        await turn({
          ...run,
          action: "restore",
          archiveId,
          requestId: crypto.randomUUID(),
        }),
      ).receipt.status,
      "succeeded",
    );
    await turn("/sentinel on");
    await turn(`/sentinel case ${id}`);
    assertEquals(await turn(report), currentReport);
    assertEquals(await turn(first), originalReport);
    assertEquals(JSON.parse(await turn(history)).page, page);
    assert(recordSentinelOperatingConstraints(path, {
      runId: run.runId,
      evidenceRevision: ref.revision,
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
      operatorScope: "owner",
      constraints: { deniedKinds: [], allowedAssetIds: [] },
    }));
    assertStringIncludes(await turn(report), "unavailable");
    assert(!olderModelText.includes(amendment));
    assertStringIncludes(await turn(history), "unavailable");
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
