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
  readSentinelOperatingConstraints,
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Selected Sentinel initializes reviewed membership and restricts coverage to exact organization assets", async () => {
  const baseDir = await Deno.makeTempDir();
  const id = "membership-review";
  const other = "other-membership";
  const path = resolveSentinelCasePath(baseDir, id);
  const token = crypto.randomUUID();
  let request: Record<string, unknown> | undefined;
  let result = "";
  let confirm = true;
  let revokeDuringReview = false;
  let denyBeforeCall = false;
  let denyPreviewResponse = false;
  let supersedeOnResponse = false;
  let superseded = false;
  const approvals: string[] = [];
  const preCalls: string[] = [];
  const registry = createProviderRegistry();
  registry.register({
    name: "selected-membership-fixture",
    supportsStreaming: false,
    complete(messages) {
      const last = messages.at(-1);
      if (last?.role === "tool") result = String(last.content);
      return Promise.resolve({
        content: last?.role === "tool" ? "Checked membership." : "",
        usage: { inputTokens: 1, outputTokens: 1 },
        toolCalls: last?.role === "tool" || request === undefined ? [] : [{
          type: "function",
          id: crypto.randomUUID(),
          function: {
            name: "operator_runs",
            arguments: JSON.stringify(request),
          },
        }],
      });
    },
  });
  registry.setDefault("selected-membership-fixture");
  const gateway = createGatewayServer({
    token,
    port: 0,
    chatSession: createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "membership" as ChannelId,
      }),
      providerRegistry: registry,
      sentinelSnapshotPath: resolveSentinelCasePath(baseDir),
      allowSentinelModelAccess: true,
      resolveSentinelChatCase: (caseId) =>
        [id, other].includes(caseId)
          ? resolveSentinelCasePath(baseDir, caseId)
          : undefined,
      operatorRunExecutor: createOperatorRunToolExecutor({
        baseDir,
        confirm: (prompt) => {
          approvals.push(prompt);
          if (revokeDuringReview) denyBeforeCall = true;
          return Promise.resolve(confirm);
        },
      }),
      hookRunner: {
        evaluateHook(hook, { input, auditInput }) {
          const call = input.tool_call as
            | { args?: Record<string, unknown> }
            | undefined;
          const action = call?.args?.action;
          const preview = action === "preview_membership";
          const set = action === "set_case_membership";
          if (hook === "PRE_TOOL_CALL" && (preview || set)) {
            assertEquals(input.case_id, call?.args?.id);
            assertEquals(input.evidence_revision, call?.args?.revision);
            assertEquals(input.operation_type, preview ? "read" : "write");
            assert(!JSON.stringify(auditInput).includes('"organizationId"'));
            preCalls.push(String(action));
          }
          if (
            supersedeOnResponse && hook === "POST_TOOL_RESPONSE" &&
            typeof input.tool_response === "string" &&
            input.tool_response.includes('"sourceDigest"')
          ) {
            supersedeOnResponse = false;
            const otherPath = resolveSentinelCasePath(baseDir, other);
            const saved = readSentinelOperatingConstraints(otherPath);
            assert(saved?.membership);
            assert(recordSentinelOperatingConstraints(otherPath, {
              runId: saved.runId,
              evidenceRevision: saved.evidenceRevision,
              expectedVersion: saved.version,
              operatorScope: "concurrent-owner",
              requestId: crypto.randomUUID(),
              constraints: saved.constraints,
              membership: saved.membership,
            }));
            superseded = true;
          }
          const blocked = (set && hook === "PRE_TOOL_CALL" && denyBeforeCall) ||
            (hook === "POST_TOOL_RESPONSE" && denyPreviewResponse &&
              String(input.tool_response).includes("Ordinary Operations"));
          return Promise.resolve({
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            duration: 0,
            ruleId: null,
          });
        },
      },
    }),
  });
  let socket: WebSocket | undefined;
  try {
    const build = async (caseId: string) => {
      const selected = resolveSentinelCasePath(baseDir, caseId);
      await Deno.mkdir(dirname(selected), { recursive: true });
      await Deno.writeTextFile(
        selected,
        JSON.stringify({
          version: 1,
          nodes: [
            {
              id: "app",
              kind: "asset",
              label: "Approved application",
              assetType: "service",
              organization: { id: "ops", label: "Ordinary Operations" },
            },
            {
              id: "api",
              kind: "asset",
              label: "Approved API",
              assetType: "service",
              organization: { id: "ops", label: "Ordinary Operations" },
            },
            {
              id: "unrelated",
              kind: "asset",
              label: "Outside proposed organization",
              organization: { id: "external", label: "External team" },
            },
          ],
          edges: [],
        }),
      );
      return startSentinelAssessment(selected);
    };
    const state = await build(id);
    const unrelated = await build(other);
    assert(state.plan.runId && unrelated.plan.runId);
    const { port } = await gateway.start();
    const authorized = socket = new WebSocket(
      `ws://127.0.0.1:${port}/chat?token=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      authorized.addEventListener("open", () => resolve(), { once: true });
      authorized.addEventListener("error", reject, { once: true });
    });
    const turn = async (input: string | Record<string, unknown>) => {
      request = typeof input === "string" ? undefined : input;
      result = "";
      const done = Promise.withResolvers<void>();
      const timer = setTimeout(
        () => done.reject(new Error("Membership gateway timed out")),
        3500,
      );
      const receive = ({ data }: MessageEvent) => {
        const event = JSON.parse(data);
        if (event.type === "turn_end") done.resolve();
        if (event.type === "error") {
          if (
            (denyPreviewResponse || superseded) &&
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
          content: typeof input === "string"
            ? input
            : "Review the exact case membership.",
        }));
        await done.promise;
        return result;
      } finally {
        clearTimeout(timer);
        authorized.removeEventListener("message", receive);
      }
    };
    await turn("/sentinel on");
    await turn(`/sentinel case ${id}`);
    const ref = { kind: "sentinel", id, revision: state.revision };
    const run = { ...ref, runId: state.plan.runId };
    const preview = {
      ...run,
      action: "preview_membership",
      organizationId: "ops",
    };
    const set = {
      ...preview,
      action: "set_case_membership",
      expectedVersion: 0,
      requestId: crypto.randomUUID(),
    };
    assertStringIncludes(
      await turn({ ...preview, id: other, runId: unrelated.plan.runId }),
      "unavailable",
    );
    assertStringIncludes(
      await turn({ ...set, revision: state.revision + 1 }),
      "unavailable",
    );
    assertStringIncludes(
      await turn({ ...set, organizationId: "missing" }),
      "unavailable",
    );
    denyBeforeCall = true;
    assertStringIncludes(await turn(set), "policy");
    denyBeforeCall = false;
    assertEquals(approvals.length, 0);
    assertEquals(readSentinelOperatingConstraints(path), undefined);
    denyPreviewResponse = true;
    assert(!((await turn(preview)).includes("Ordinary Operations")));
    denyPreviewResponse = false;
    const reviewed = JSON.parse(await turn(preview));
    assertEquals(reviewed.version, 0);
    assertEquals(reviewed.membership.assetIds, ["api", "app"]);
    assertEquals(reviewed.membership.selector, {
      kind: "organization",
      organizationId: "ops",
    });
    const byAsset = JSON.parse(
      await turn({
        ...preview,
        organizationId: undefined,
        allowedAssetIds: ["app"],
      }),
    );
    assertEquals(byAsset.membership.assetIds, ["app"]);
    confirm = false;
    assertStringIncludes(await turn(set), "operator declined");
    confirm = true;
    revokeDuringReview = true;
    assertStringIncludes(await turn(set), "unavailable");
    revokeDuringReview = false;
    denyBeforeCall = false;
    assertEquals(readSentinelOperatingConstraints(path), undefined);
    const saved = JSON.parse(await turn(set));
    assertEquals(saved.version, 1);
    assertEquals(saved.sourceDigest, reviewed.membership.snapshotDigest);
    const constraints = readSentinelOperatingConstraints(path);
    assertEquals(constraints?.digest, saved.digest);
    assertEquals(constraints?.membership, reviewed.membership);
    assertEquals(JSON.parse(await turn(set)), saved);
    assertEquals(approvals.length, 3);
    assert(
      approvals.every((approval) =>
        approval.includes(reviewed.membership.snapshotDigest)
      ),
    );
    assert(preCalls.includes("preview_membership"));
    assertStringIncludes(
      await turn({
        ...set,
        requestId: crypto.randomUUID(),
        expectedVersion: 1,
      }),
      "unavailable",
    );
    assertStringIncludes(
      await turn({ ...preview, organizationId: "external" }),
      "unavailable",
    );
    const coverage = JSON.parse(
      await turn({
        ...ref,
        action: "inventory",
        view: "coverage",
        scope: "membership",
        coverageGap: "unreviewed",
        includeCoverageTotals: true,
      }),
    ).page;
    assertEquals(coverage.coverageTotals.assets, 2);
    assertEquals(
      coverage.assets.map(({ asset }: { asset: { id: string } }) => asset.id)
        .sort(),
      ["api", "app"],
    );
    assertEquals(coverage.membership.version, 1);

    await turn("/sentinel off");
    const archiveId = crypto.randomUUID();
    assertEquals(
      JSON.parse(await turn({ ...run, action: "cancel" })).run.status,
      "stopped",
    );
    assertEquals(
      JSON.parse(
        await turn({ ...run, action: "archive", requestId: archiveId }),
      ).receipt.status,
      "succeeded",
    );
    await Deno.rename(
      dirname(path),
      join(baseDir, "before-membership-restore"),
    );
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
    assertEquals(readSentinelOperatingConstraints(path), constraints);
    await turn("/sentinel on");
    await turn(`/sentinel case ${id}`);
    const retained = JSON.parse(
      await turn({
        ...ref,
        action: "inventory",
        view: "coverage",
        scope: "membership",
        includeCoverageTotals: true,
      }),
    ).page;
    assertEquals(retained.membership.version, 1);
    assertEquals(retained.coverageTotals.assets, 2);

    await turn(`/sentinel case ${other}`);
    supersedeOnResponse = true;
    const raced = await turn({
      ...set,
      id: other,
      runId: unrelated.plan.runId,
      revision: unrelated.revision,
      requestId: crypto.randomUUID(),
    });
    assert(superseded);
    assert(!raced.includes('"sourceDigest"'));
    assertEquals(
      readSentinelOperatingConstraints(resolveSentinelCasePath(baseDir, other))
        ?.version,
      2,
    );
  } finally {
    socket?.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
