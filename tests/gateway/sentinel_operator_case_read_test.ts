import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import { createSession } from "../../src/core/types/session.ts";
import type { ChannelId, UserId } from "../../src/core/types/session.ts";
import { createChatSession } from "../../src/gateway/chat.ts";
import { subscribeCommittedEvidence } from "../../src/core/evidence_task_progression.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readSentinelCaseHints,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import { createGatewayServer } from "../../src/gateway/server/server.ts";
import {
  readSentinelOperatingConstraints,
  recordSentinelOperatingConstraints,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { resolveSentinelCaseMembership } from "../../src/sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import { sentinelAlertsPath } from "../../src/sentinel/paths.ts";
import { sentinelAlertReference } from "../../src/sentinel/telemetry.ts";

Deno.test("Authenticated Sentinel chat reads exact approved cross-case graph findings and inventory through root policy", async () => {
  const baseDir = await Deno.makeTempDir();
  const secretLabel = "Exact authorized cross-case finding";
  const hiddenLabel = "Unregistered case finding";
  const inventoryLabel = "Approved asset in exact peer inventory";
  const visibleAlert = {
    asset: "asset-a",
    type: "integrity_change" as const,
    severity: "high" as const,
    subject: "Authorized detection fixture",
    observedAt: "2026-01-01T00:00:00.000Z",
    evidenceIds: ["visible-defensive-event"],
    triggeringAction: "cloudtrail.amazonaws.com:StopLogging",
  };
  const restrictedAlert = {
    ...visibleAlert,
    asset: "asset-c",
    subject: "Outside selected inventory scope",
    evidenceIds: ["restricted-defensive-event"],
  };
  const visibleAlertId = sentinelAlertReference(visibleAlert);
  const restrictedAlertId = sentinelAlertReference(restrictedAlert);
  async function setupCase(
    id: string,
    label: string,
    inventoryCoverageEnabled?: boolean,
  ) {
    const path = resolveSentinelCasePath(baseDir, id);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { kind: "finding", id: "finding", label, severity: "low" },
          ...(id === "approved"
            ? [{
              kind: "evidence",
              id: "coverage-evidence",
              label: "Saved coverage evidence",
            }]
            : []),
          ...["a", "b", "c"].map((name) => ({
            kind: "asset",
            id: `asset-${name}`,
            label: name === "a" ? inventoryLabel : `Asset ${name}`,
            assetType: name === "c" ? "application" : "service",
            properties: {
              service: ["https"],
              port: [443],
              status: [name === "b" ? 503 : 200],
              technology: ["Reverse Proxy"],
              url: [`https://${name}.example.test/health`],
              title: ["Health status"],
              ip: [`192.0.2.${name.charCodeAt(0)}`],
              domain: [`${name}.example.test`],
            },
            aliases: [
              `${name}.example`,
              ...(id === "unregistered" ? ["hidden-only.example"] : []),
            ],
            organization: id === "unregistered"
              ? { id: "hidden-ops", label: "Hidden Group" }
              : { id: "ops", label: "Operations" },
          })),
        ],
        edges: id === "approved"
          ? [{
            from: "coverage-evidence",
            to: "asset-a",
            relation: "observed_on",
          }, {
            from: "finding",
            to: "asset-a",
            relation: "affects",
          }, {
            from: "coverage-evidence",
            to: "finding",
            relation: "supports",
          }]
          : [],
      }),
      { mode: 0o600 },
    );
    if (id === "approved") {
      await Deno.writeTextFile(
        sentinelAlertsPath(path),
        JSON.stringify(
          [visibleAlert, restrictedAlert].flatMap((alert) => [alert, {
            ...alert,
            type: "network_security_alert",
            triggeringAction: undefined,
            evidenceIds: [`${alert.asset}-network-event`],
          }]),
        ),
        { mode: 0o600 },
      );
    }
    const state = startSentinelAssessment(path, { inventoryCoverageEnabled });
    return { path, revision: state.revision, state };
  }

  const main = await setupCase("main", "Selected case finding", false);
  const approved = await setupCase("approved", secretLabel);
  const hidden = await setupCase("unregistered", hiddenLabel);
  const topologyCase = "published-topology-fixture";
  const topologyPath = resolveSentinelCasePath(baseDir, topologyCase);
  const publishedTopology = {
    version: 1,
    nodes: [
      { id: "peer-a", kind: "asset", label: "Peer A", aliases: ["a.example"] },
      { id: "peer-c", kind: "asset", label: "Peer C", aliases: ["c.example"] },
      {
        id: "peer-a-only",
        kind: "asset",
        label: "Dependency for the first asset",
      },
      {
        id: "peer-c-only",
        kind: "asset",
        label: "Dependency for the second asset",
      },
    ],
    edges: [
      { from: "peer-a", to: "peer-a-only", relation: "depends_on" },
      { from: "peer-a", to: "peer-c", relation: "depends_on" },
      { from: "peer-c", to: "peer-c-only", relation: "depends_on" },
    ],
  };
  await Deno.mkdir(dirname(topologyPath), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(topologyPath, JSON.stringify(publishedTopology), {
    mode: 0o600,
  });
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
  const restrictionNote = "Reviewed additional task-kind restriction";
  const constraintConfirmations: string[] = [];
  const hintConfirmations: string[] = [];
  const assignmentConfirmations: string[] = [];
  const membershipConfirmations: string[] = [];
  const additionNote = "Add the declared operator-reviewed organization.";
  let acceptMembership = false;
  let changeMembershipVersionDuringReview = false;
  let revokeAssignmentDuringConfirmation = false;
  let constraintsAllowed = true;
  let revokeLineageDuringResponse = false;
  let approveRestriction = false;
  let approveScopeRules = false;
  const scopeRuleReviews: string[] = [];
  let revokeDuringConfirmation = false;
  const operator = createOperatorRunToolExecutor({
    baseDir,
    confirm(message) {
      if (message.startsWith("Approve this exact Sentinel case membership?")) {
        scopeRuleReviews.push(message);
        return Promise.resolve(approveScopeRules);
      }
      if (message.startsWith("Approve adding these exact assets")) {
        membershipConfirmations.push(message);
        if (changeMembershipVersionDuringReview) {
          const previous = readSentinelOperatingConstraints(approved.path);
          assert(previous);
          assert(recordSentinelOperatingConstraints(approved.path, {
            runId: previous.runId,
            evidenceRevision: approved.revision,
            expectedVersion: previous.version,
            operatorScope: "fixture-other-review",
            requestId: crypto.randomUUID(),
            constraints: previous.constraints,
            membership: previous.membership,
          }));
        }
        return Promise.resolve(acceptMembership);
      }
      if (
        message.startsWith("Approve these exact Sentinel graph assignments?")
      ) {
        assignmentConfirmations.push(message);
        if (revokeAssignmentDuringConfirmation) constraintsAllowed = false;
        return Promise.resolve(true);
      }
      if (message.startsWith("Approve these exact Sentinel planner hints?")) {
        hintConfirmations.push(message);
        return Promise.resolve(true);
      }
      assertStringIncludes(
        message,
        "Approve these exact Sentinel task restrictions?",
      );
      const version = readSentinelOperatingConstraints(approved.path)?.version;
      assert(version === 1 || version === 4);
      constraintConfirmations.push(message);
      if (revokeDuringConfirmation) constraintsAllowed = false;
      return Promise.resolve(approveRestriction);
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
  let localInventory = false;
  let unleasedTelemetry = false;
  let nestedTelemetry = false;
  let revokeNestedParent = false;
  let denyNestedSourceAfterChild = false;
  let parentSourceBlocked = false;
  const nestedQuestion = "Inspect the selected case telemetry for the parent.";
  const nestedPrefix = "Keep this unrelated nested conversation context.";
  let localTelemetry:
    | "sentinel_defense"
    | "sentinel_incident_alerts"
    | undefined;
  let localGraph:
    | "sentinel_trace"
    | "sentinel_provenance_node"
    | "sentinel_assessment"
    | "sentinel_worker_observation"
    | "sentinel_shared_asset_links"
    | undefined;
  let revokeAssessmentDuringResponse = false;
  let forensicGraph = false;
  let rejectExecutorCeiling = false;
  let dispatched = 0;
  let reject: "PRE_TOOL_CALL" | "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  let revokeTelemetry: "POST_TOOL_RESPONSE" | "PRE_OUTPUT" | undefined;
  let telemetryRevocations = 0;
  const independentContext = "Retain this unrelated Sentinel context.";
  const revokeContextRequest =
    "Withdraw peer context before the next model call.";
  let revokeBeforeContext = false;
  let captureModelContext = false;
  let modelContext = "";
  const hooks: string[] = [];
  const constraintLabels: Record<string, unknown>[] = [];
  registry.register({
    name: "sentinel-cross-case-reader",
    supportsStreaming: false,
    complete(messages, tools) {
      if (captureModelContext) {
        modelContext = messages.map(({ content }) => String(content)).join(
          "\n",
        );
        captureModelContext = false;
      }
      const next = request;
      request = undefined;
      const definitions = tools as {
        function?: {
          name?: string;
          parameters?: { properties?: Record<string, { enum?: string[] }> };
        };
      }[] | undefined;
      const definition = definitions?.find((tool) =>
        tool.function?.name === "operator_runs"
      );
      if (
        nestedTelemetry &&
        messages.some(({ role, content }) =>
          role === "user" && String(content) === nestedQuestion
        )
      ) {
        assertEquals(definition, undefined);
        assert(
          definitions?.some((tool) =>
            tool.function?.name === "sentinel_defense"
          ),
        );
        const read = messages.findLast(({ role }) => role === "tool");
        if (read) {
          const text = String(read.content);
          assertEquals(
            JSON.parse(text).matches.map(({ alertId }: { alertId: string }) =>
              alertId
            ),
            [visibleAlertId],
          );
          return Promise.resolve({
            content:
              `Child analysis uses this exact detection evidence: ${text}`,
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        }
        return Promise.resolve({
          content: "",
          toolCalls: [{
            type: "function",
            id: "nested-defense-check",
            function: {
              name: "sentinel_defense",
              arguments: JSON.stringify({
                upstreamCheck: "cloudtrail_logging_stopped",
              }),
            },
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      }
      if (verifyWorkerBinding || localInventory) {
        const binding = definitions?.find((tool) =>
          tool.function?.name === "sentinel_case_inventory"
        );
        assertEquals(binding?.function?.parameters?.properties?.view?.enum, [
          "assets",
          "organizations",
        ]);
        assertEquals(
          binding?.function?.parameters?.properties?.coverageGap,
          undefined,
        );
      }
      if (verifyWorkerBinding) {
        assertEquals(definition, undefined);
        verifyWorkerBinding = false;
        return Promise.resolve({
          content: "Worker bindings verified.",
          usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [],
        });
      }
      if (unleasedTelemetry) {
        assertEquals(definition, undefined);
        for (const name of ["sentinel_defense", "sentinel_incident_alerts"]) {
          assert(definitions?.some((tool) => tool.function?.name === name));
        }
      }
      if (next && !localInventory && !unleasedTelemetry && !forensicGraph) {
        assert(definition);
        assertEquals(
          definition.function?.parameters?.properties?.action?.enum,
          [
            "model_route",
            "goals",
            "graph_overview",
            "graph",
            "findings",
            "node",
            "inventory",
            "preview_membership",
            "facts",
            "finding_receipts",
            "finding_receipt",
            "finding_report",
            "finding_report_history",
            "decision_history",
            "finding_lineage",
            "incidents",
            "incident_alerts",
            "case_alert",
            "defense_coverage",
            "list_digests",
            "expand_digest",
            "traces",
            "list_trace_workers",
            "worker_trace_progress",
            "worker_trace_result",
            "linked_worker_review",
            "linked_findings",
            "linked_finding",
            "analyst_observation",
            "constraints",
            "narrow_constraints",
            "steer",
            "hint_batch",
            "assign_batch",
            "append_goals",
            "withdraw_goal",
            "confirm_goal_completion",
            "set_case_membership",
            "add_case_membership",
            "record_analyst_finding",
            "amend_finding_report",
            "review_incident",
          ],
        );
      } else if (!next) {
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
              name: localInventory
                ? "sentinel_case_inventory"
                : nestedTelemetry
                ? "sentinel_subagent"
                : localTelemetry ?? localGraph ?? "operator_runs",
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
      sentinelSharedInventoryBaseDir: baseDir,
      resolveSentinelChatCase: (id) =>
        id === "approved" && constraintsAllowed ? approved.path : undefined,
      allowSentinelModelAccess: true,
      hookRunner: {
        async evaluateHook(hook, { input, auditInput }) {
          const selectsTool = input.tool_name === "operator_runs" ||
            input.tool_name === localTelemetry &&
              localTelemetry !== undefined ||
            input.tool_name === localGraph && localGraph !== undefined;
          if (
            localTelemetry && input.tool_name === localTelemetry &&
            (hook === "PRE_TOOL_CALL" || hook === "POST_TOOL_RESPONSE")
          ) {
            assertEquals(input.case_id, "approved");
            if (
              hook === "POST_TOOL_RESPONSE" &&
              typeof input.tool_response === "string" &&
              input.tool_response.includes(visibleAlert.subject)
            ) {
              assertEquals(input.evidence_revision, approved.revision);
            }
          }
          if (
            !forensicGraph && input.tool_name === "operator_runs" &&
            hook === "POST_TOOL_RESPONSE" &&
            typeof input.tool_response === "string" &&
            input.tool_response.includes(secretLabel) &&
            /"page":\s*\{/.test(input.tool_response)
          ) {
            assertEquals(input.case_id, "approved");
            assertEquals(input.evidence_revision, approved.revision);
          }
          if (
            revokeLineageDuringResponse && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "operator_runs" &&
            typeof input.tool_response === "string" &&
            input.tool_response.includes('"lineageDigest"')
          ) {
            await Promise.resolve();
            constraintsAllowed = false;
            revokeLineageDuringResponse = false;
          }
          if (
            revokeAssessmentDuringResponse && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "sentinel_assessment" &&
            typeof input.tool_response === "string" &&
            input.tool_response.includes("cloudtrail_logging_stopped")
          ) {
            await Promise.resolve();
            constraintsAllowed = false;
            revokeAssessmentDuringResponse = false;
          }
          if (selectsTool || hook === "PRE_OUTPUT") hooks.push(hook);
          if (
            selectsTool && hook === "PRE_TOOL_CALL" &&
            input.operation_type === "write"
          ) {
            constraintLabels.push(input);
            const call = input.tool_call as
              | { args?: { action?: string } }
              | undefined;
            if (call?.args?.action === "add_case_membership") {
              assert(!JSON.stringify(auditInput).includes(additionNote));
            }
          }
          const blocked = hook === reject &&
            (selectsTool || hook === "PRE_OUTPUT" &&
                typeof input.content === "string" &&
                [
                  secretLabel,
                  inventoryLabel,
                  restrictionNote,
                  additionNote,
                  visibleAlert.subject,
                ]
                  .some((label) => String(input.content).includes(label)));
          if (
            revokeBeforeContext && hook === "PRE_CONTEXT_INJECTION" &&
            input.content === revokeContextRequest
          ) {
            await Promise.resolve();
            constraintsAllowed = false;
            revokeBeforeContext = false;
          }
          if (
            denyNestedSourceAfterChild && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "sentinel_subagent"
          ) parentSourceBlocked = true;
          if (
            parentSourceBlocked && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "sentinel_defense"
          ) {
            return {
              allowed: false,
              action: "BLOCK",
              ruleId: null,
              duration: 0,
            };
          }
          if (
            revokeNestedParent && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "sentinel_subagent" &&
            typeof input.tool_response === "string" &&
            input.tool_response.includes(visibleAlert.subject)
          ) {
            await Promise.resolve();
            constraintsAllowed = false;
            revokeNestedParent = false;
          }
          if (hook === revokeTelemetry) {
            const content = hook === "POST_TOOL_RESPONSE"
              ? input.tool_response
              : input.content;
            if (
              typeof content === "string" &&
              content.includes(visibleAlert.subject)
            ) {
              revokeTelemetry = undefined;
              await Promise.resolve();
              if (hook === "POST_TOOL_RESPONSE") constraintsAllowed = false;
              else {
                const prior = readSentinelOperatingConstraints(approved.path);
                assert(prior);
                assert(recordSentinelOperatingConstraints(approved.path, {
                  runId: prior.runId,
                  evidenceRevision: approved.revision,
                  expectedVersion: prior.version,
                  operatorScope: "telemetry-race-fixture",
                  requestId: crypto.randomUUID(),
                  constraints: {
                    deniedKinds: prior.constraints.deniedKinds,
                    allowedAssetIds: ["asset-b", "asset-c"],
                  },
                }));
              }
              telemetryRevocations++;
            }
          }
          return {
            allowed: !blocked,
            action: blocked ? "BLOCK" : "ALLOW",
            ruleId: null,
            duration: 0,
          };
        },
      },
      operatorRunExecutor(args, policy) {
        dispatched++;
        assertEquals(policy?.authenticatedOwnerSessionId, ordinaryOwner.id);
        assertEquals(policy?.ceiling, "INTERNAL");
        if (forensicGraph) {
          assertEquals(policy?.authorizeSentinelCaseRead, undefined);
        } else {
          assert(
            policy?.authorizeSentinelCaseRead?.(
              "approved",
              approved.revision,
            ) ||
              args.revision !== approved.revision,
          );
          assertEquals(
            policy?.authorizeSentinelCaseRead?.(
              "unregistered",
              hidden.revision,
            ),
            false,
          );
        }
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
    assertEquals(JSON.parse(result).overview.nodesByKind.asset, 2);
    await turn("Reject the excluded exact provenance node", {
      ...exact,
      action: "node",
      node: "asset:asset-c",
    });
    assertStringIncludes(result, "unavailable");
    await turn("List authorized graph records only", {
      ...exact,
      action: "graph",
    });
    assert(
      !JSON.parse(result).page.nodes.some(({ id }: { id: string }) =>
        id === "asset:asset-c"
      ),
    );

    const lineage = {
      ...exact,
      action: "finding_lineage",
      node: "finding",
      limit: 1,
    };
    await turn("Reject lineage outside the selected case", lineage);
    assertStringIncludes(result, "unavailable");
    await turn("/sentinel case approved");
    await turn("Open the exact selected finding lineage", lineage);
    const firstLineage = JSON.parse(result).page;
    assertEquals(firstLineage.findingId, "finding");
    assertEquals(firstLineage.edges.length, 1);
    assert(typeof firstLineage.nextCursor === "string");
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    const pages = [firstLineage];
    while (pages.at(-1).nextCursor) {
      assert(pages.length < 4);
      await turn("Continue the exact selected finding lineage", {
        ...lineage,
        cursor: pages.at(-1).nextCursor,
      });
      pages.push(JSON.parse(result).page);
    }
    assertEquals(pages.map(({ edges }) => edges.length), [1, 1, 1]);
    assertEquals(
      new Set(
        pages.flatMap(({ edges }) =>
          edges.map(({ relation }: { relation: string }) => relation)
        ),
      ),
      new Set(["affects", "supports", "observed_on"]),
    );
    await turn("Reject a copied cursor on another finding", {
      ...lineage,
      node: "coverage-evidence",
      cursor: firstLineage.nextCursor,
    });
    assertStringIncludes(result, "unavailable");
    reject = "PRE_TOOL_CALL";
    await turn("Block finding lineage before dispatch", lineage);
    assert(!result.includes(secretLabel));
    reject = "PRE_OUTPUT";
    const withheldLineage = await turn(
      "Block authorized lineage at delivery",
      lineage,
    );
    assertStringIncludes(result, secretLabel);
    assert(withheldLineage.every((frame) => !frame.includes(secretLabel)));
    reject = undefined;
    revokeLineageDuringResponse = true;
    const revokedLineage = await turn(
      "Revoke case access during lineage classification",
      lineage,
    );
    assert(!revokeLineageDuringResponse);
    assert(!result.includes(secretLabel));
    assert(revokedLineage.every((frame) => !frame.includes(secretLabel)));
    constraintsAllowed = true;
    const topologyQuery = {
      asset: "asset-a",
      sourceCase: topologyCase,
      limit: 1,
    };
    localGraph = "sentinel_shared_asset_links";
    await turn("Read one authorized published dependency", topologyQuery);
    const topology = JSON.parse(result);
    assertEquals(topology.links[0].to, "peer-a-only");
    assertEquals(topology.links[0].from, "asset-a");
    assertEquals(topology.totalLinks, 1);
    assertEquals(topology.nextOffset, null);
    assertEquals(topology.caseEvidenceRevision, approved.revision);
    assertEquals(topology.sourceSnapshots[0].caseId, topologyCase);
    assert(!result.includes("peer-c"));
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    await turn("Reject a shared topology lookup for an excluded case asset", {
      ...topologyQuery,
      asset: "asset-c",
    });
    assertStringIncludes(result, "unavailable");

    captureModelContext = true;
    await turn("Use the currently published dependency in model context.");
    assertStringIncludes(modelContext, "peer-a-only");
    await Deno.writeTextFile(
      topologyPath,
      JSON.stringify({ ...publishedTopology, edges: [] }),
    );
    try {
      captureModelContext = true;
      await turn("Remove withdrawn publication contents from model context.");
      assert(!modelContext.includes("peer-a-only"));
    } finally {
      await Deno.writeTextFile(topologyPath, JSON.stringify(publishedTopology));
    }
    localGraph = "sentinel_assessment";
    await turn("Read neutral assessment task progress", {});
    assert(
      JSON.parse(result).tasks.some(({ id }: { id: string }) =>
        id === "incident_correlation"
      ),
    );
    await turn("Summarize authorized retained case evidence", { task: "case" });
    assertEquals(JSON.parse(result).observation.facts.summary.matchedAlerts, 2);
    assert(!result.includes(restrictedAlert.subject));
    await turn("Discover incidents only in authorized assessment scope", {
      task: "incident_correlation",
    });
    assertEquals(JSON.parse(result).observation.facts.summary.candidates, 1);
    assert(!result.includes(restrictedAlert.subject));
    await turn("Summarize only authorized saved detection evidence", {
      task: "defense_coverage",
    });
    const scopedAssessment = JSON.parse(result).observation.facts;
    assertEquals(
      scopedAssessment.upstreamChecks.find(({ id }: { id: string }) =>
        id === "cloudtrail_logging_stopped"
      ).matchCount,
      1,
    );
    assert(!result.includes("asset-c"));
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    revokeAssessmentDuringResponse = true;
    const withheldAssessment = await turn("Withdraw scope while summarizing", {
      task: "defense_coverage",
    });
    assert(!revokeAssessmentDuringResponse);
    assert(!result.includes("cloudtrail_logging_stopped"));
    assert(
      withheldAssessment.every((frame) =>
        !frame.includes("cloudtrail_logging_stopped")
      ),
    );
    constraintsAllowed = true;
    localGraph = "sentinel_trace";
    await turn("Use the native direct asset graph", { node: "asset-a" });
    assertStringIncludes(result, secretLabel);
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    await turn("Reject an excluded asset in the native inventory graph", {
      node: "asset-c",
    });
    assertStringIncludes(result, "unavailable");
    localGraph = "sentinel_provenance_node";
    await turn("Reject an excluded node in the native provenance graph", {
      node: "asset:asset-c",
    });
    assertStringIncludes(result, "unavailable");
    reject = "PRE_TOOL_CALL";
    await turn("Deny a native graph read before dispatch", { node: graphNode });
    assert(!result.includes(secretLabel));
    reject = "POST_TOOL_RESPONSE";
    await turn("Block a native authorized node at response classification", {
      node: graphNode,
    });
    assert(!result.includes(secretLabel));
    reject = "PRE_OUTPUT";
    const withheldGraph = await turn("Block graph content at delivery", {
      node: graphNode,
    });
    assertStringIncludes(result, secretLabel);
    assert(withheldGraph.every((frame) => !frame.includes(secretLabel)));
    reject = undefined;
    await turn("Read an authorized provenance node into context", {
      node: graphNode,
    });
    assertStringIncludes(result, secretLabel);
    localGraph = "sentinel_assessment";
    await turn("Refresh the authorized assessment rollup", {
      task: "defense_coverage",
    });
    assertStringIncludes(result, "cloudtrail_logging_stopped");
    localGraph = undefined;
    captureModelContext = true;
    await turn("Check context while graph authority remains current.");
    assertStringIncludes(modelContext, secretLabel);
    assertStringIncludes(modelContext, "cloudtrail_logging_stopped");
    captureModelContext = true;
    revokeBeforeContext = true;
    await turn(revokeContextRequest);
    assert(!modelContext.includes(secretLabel));
    assert(!modelContext.includes("cloudtrail_logging_stopped"));
    constraintsAllowed = true;

    await turn("/sentinel off");
    forensicGraph = true;
    await turn("Open the exact excluded node in the forensic owner route", {
      ...exact,
      action: "node",
      node: "asset:asset-c",
    });
    assertEquals(JSON.parse(result).page.node.id, "asset:asset-c");
    forensicGraph = false;
    await turn("/sentinel on");
    await turn("/sentinel case main");

    const coverageCheck = {
      ...exact,
      action: "defense_coverage",
      upstreamCheck: "cloudtrail_logging_stopped",
    };
    await turn("Read checked telemetry in the authorized case", coverageCheck);
    assertEquals(
      JSON.parse(result).evidence.matches.map(
        ({ alertId }: { alertId: string }) => alertId,
      ),
      [visibleAlertId],
    );
    assertEquals(JSON.parse(result).evidence.matchCount, 1);
    await turn("Discover incidents in the authorized case", {
      ...exact,
      action: "incidents",
    });
    const catalog = JSON.parse(result);
    assertEquals(catalog.total, 1);
    assertEquals(catalog.incidents[0].asset, visibleAlert.asset);
    await turn("Open scoped incident members", {
      ...exact,
      action: "incident_alerts",
      incidentId: catalog.incidents[0].id,
    });
    assertEquals(JSON.parse(result).evidence.total, 2);
    assertStringIncludes(result, visibleAlert.subject);
    assert(!result.includes(restrictedAlert.subject));
    const exactAlert = {
      ...exact,
      action: "case_alert",
      alertId: visibleAlertId,
    };
    await turn("Open the exact authorized retained alert", exactAlert);
    assertEquals(JSON.parse(result).alertId, visibleAlertId);
    assertStringIncludes(result, visibleAlert.subject);
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    for (
      const denied of [
        { ...exactAlert, alertId: restrictedAlertId },
        { ...exactAlert, id: "unregistered" },
        { ...exactAlert, revision: exact.revision + 100 },
      ]
    ) {
      await turn("Reject a non-authorized retained alert request", denied);
      assertStringIncludes(result, "unavailable");
      assert(
        !result.includes(visibleAlert.subject) &&
          !result.includes(restrictedAlert.subject),
      );
    }
    const beforeTelemetryPolicy = dispatched;
    reject = "PRE_TOOL_CALL";
    await turn("Deny exact telemetry before dispatch", exactAlert);
    assertEquals(dispatched, beforeTelemetryPolicy);
    assert(!result.includes(visibleAlert.subject));
    reject = "POST_TOOL_RESPONSE";
    await turn("Deny exact telemetry response after dispatch", exactAlert);
    assertEquals(dispatched, beforeTelemetryPolicy + 1);
    assert(!result.includes(visibleAlert.subject));
    reject = "PRE_OUTPUT";
    const withheldTelemetry = await turn("Deny telemetry output", exactAlert);
    assertStringIncludes(result, visibleAlert.subject);
    assert(
      withheldTelemetry.every((frame) => !frame.includes(visibleAlert.subject)),
    );
    reject = undefined;

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

    const batch = { ...inventory, assetIds: ["asset-b", "asset-a"], limit: 1 };
    await turn("Read exact asset IDs in current membership", batch);
    const batchPage = JSON.parse(result).page;
    assertEquals(batchPage.assets.map(({ id }: { id: string }) => id), [
      "asset-a",
    ]);
    assert(batchPage.nextCursor);
    await turn("Continue the same canonical exact set", {
      ...batch,
      assetIds: ["asset-a", "asset-b"],
      cursor: batchPage.nextCursor,
    });
    assertEquals(JSON.parse(result).page.assets[0].id, "asset-b");
    for (
      const invalid of [
        { ...batch, assetIds: ["asset-a"], cursor: batchPage.nextCursor },
        { ...batch, assetIds: ["asset-a", "asset-c"] },
        { ...batch, assetIds: ["asset-a", "foreign"] },
        { ...batch, assetId: "asset-a" },
        { ...batch, view: "organizations" },
        { ...batch, id: "unregistered" },
      ]
    ) {
      await turn(
        "Reject an invalid, unauthorized, or stale exact set",
        invalid,
      );
      assertStringIncludes(result, "unavailable");
    }

    const textSearch = { ...inventory, assetText: " EXAMPLE ", limit: 1 };
    await turn("Find visible assets by a partial label or alias", textSearch);
    const textPage = JSON.parse(result).page;
    assertEquals(textPage.assets[0].id, "asset-a");
    assert(textPage.nextCursor);
    await turn("Continue with the same normalized text", {
      ...textSearch,
      assetText: "example",
      cursor: textPage.nextCursor,
    });
    assertEquals(JSON.parse(result).page.assets[0].id, "asset-b");
    for (
      const invalid of [
        { ...textSearch, assetText: "ample", cursor: textPage.nextCursor },
        { ...textSearch, id: "unregistered" },
        { ...textSearch, view: "coverage" },
        { ...textSearch, assetIds: ["asset-a"] },
      ]
    ) {
      await turn("Reject a different query or unauthorized scope", invalid);
      assertStringIncludes(result, "unavailable");
    }
    await turn("Search for peer-only material inside this case", {
      ...textSearch,
      assetText: "hidden-only",
    });
    assertEquals(JSON.parse(result).page.assets, []);
    await turn("Treat punctuation literally", {
      ...textSearch,
      assetText: "%",
    });
    assertEquals(JSON.parse(result).page.assets, []);

    const typedSearch = {
      ...inventory,
      limit: 1,
      assetQuery: {
        and: [
          { field: "service", op: "eq", value: "HTTPS" },
          { field: "port", op: "eq", value: 443 },
          { field: "technology", op: "contains", value: "PROXY" },
          { field: "url", op: "contains", value: "/health" },
          { field: "title", op: "eq", value: "Health status" },
          { field: "ip", op: "contains", value: "192.0.2." },
          { field: "domain", op: "contains", value: ".example.test" },
          {
            or: [
              { field: "status", op: "eq", value: 200 },
              { field: "status", op: "gte", value: 500 },
            ],
          },
        ],
      },
    };
    await turn("Read a first typed asset page", typedSearch);
    const typedPage = JSON.parse(result).page;
    assertEquals(typedPage.assets.map(({ id }: { id: string }) => id), [
      "asset-a",
    ]);
    assert(typedPage.nextCursor);
    await turn("Read the second typed asset page", {
      ...typedSearch,
      cursor: typedPage.nextCursor,
    });
    assertEquals(
      JSON.parse(result).page.assets.map(({ id }: { id: string }) => id),
      ["asset-b"],
    );
    assertEquals(JSON.parse(result).page.nextCursor, null);
    await turn("Do not reveal out-of-scope property matches", {
      ...typedSearch,
      assetQuery: { field: "domain", op: "eq", value: "c.example.test" },
    });
    assertEquals(JSON.parse(result).page.assets, []);
    for (
      const bad of [
        {
          ...typedSearch,
          assetQuery: { field: "port", op: "eq", value: 443 },
          cursor: typedPage.nextCursor,
        },
        { ...typedSearch, id: "unregistered" },
        { ...typedSearch, revision: approved.revision + 1 },
        {
          ...typedSearch,
          assetQuery: { field: "port", op: "eq", value: "443" },
        },
      ]
    ) {
      await turn("Deny a bad typed inventory request", bad);
      assertStringIncludes(result, "unavailable");
    }

    await turn("List member organizations", {
      ...inventory,
      view: "organizations",
    });
    assertEquals(JSON.parse(result).page.organizations, [{
      id: "ops",
      label: "Operations",
      assetCount: 2,
    }]);

    const organizationSearch = {
      ...inventory,
      view: "organizations",
      organizationText: " PERAT ",
      limit: 1,
    };
    await turn(
      "Find authorized organizations by partial name",
      organizationSearch,
    );
    assertEquals(JSON.parse(result).page.organizations, [{
      id: "ops",
      label: "Operations",
      assetCount: 2,
    }]);
    await turn("Search for an organization from an unauthorized case", {
      ...organizationSearch,
      organizationText: "hidden",
    });
    assertEquals(JSON.parse(result).page.organizations, []);
    const memberQuery = {
      ...organizationSearch,
      organizationId: "ops",
      includeMembers: true,
    };
    await turn("Open the declared members of one organization", memberQuery);
    const memberPage = JSON.parse(result).page;
    assertEquals(memberPage.assetIds, ["asset-a"]);
    assert(memberPage.nextCursor);
    await turn("Continue the same organization member query", {
      ...memberQuery,
      organizationText: "perat",
      cursor: memberPage.nextCursor,
    });
    assertEquals(JSON.parse(result).page.assetIds, ["asset-b"]);
    for (
      const invalid of [
        { ...memberQuery, id: "unregistered" },
        { ...memberQuery, organizationId: undefined },
        {
          ...memberQuery,
          organizationText: "operations",
          cursor: memberPage.nextCursor,
        },
        { ...organizationSearch, cursor: memberPage.nextCursor },
      ]
    ) {
      await turn("Reject an unauthorized or mismatched member query", invalid);
      assertStringIncludes(result, "unavailable");
    }

    const coverage = {
      ...inventory,
      view: "coverage",
      coverageGap: "unreviewed",
      includeCoverageTotals: true,
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
    assertEquals(first.coverageTotals, {
      assets: 2,
      reviewed: 0,
      withEvidence: 1,
      matchedAssets: 2,
      byAssetType: [{
        assetType: "service",
        assets: 2,
        reviewed: 0,
        withEvidence: 1,
      }],
    });
    assertEquals(second.coverageTotals, first.coverageTotals);
    await turn("Count assets missing evidence without losing the denominator", {
      ...coverage,
      coverageGap: "missing_evidence",
    });
    const missing = JSON.parse(result).page;
    assertEquals(missing.coverageTotals, {
      ...first.coverageTotals,
      matchedAssets: 1,
    });
    assertEquals(missing.assets[0].asset.id, "asset-b");
    await turn("Reject coverage totals on an asset listing", {
      ...inventory,
      includeCoverageTotals: true,
    });
    assertStringIncludes(result, "unavailable");

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
    await turn("Pre-call denial", coverage);
    assert(!result.includes(inventoryLabel));
    assertEquals(dispatched, beforeMutation);
    reject = "POST_TOOL_RESPONSE";
    await turn("Response classification denial", coverage);
    assert(!result.includes(inventoryLabel));
    assertEquals(dispatched, beforeMutation + 1);
    reject = "PRE_OUTPUT";
    const blocked = await turn("Output denial", coverage);
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
    localInventory = true;
    await turn("Read optional local coverage", { view: "coverage" });
    assertStringIncludes(result, "Inventory coverage is disabled");
    await turn("Read the selected asset", {
      view: "assets",
      assetId: "asset-a",
    });
    assertStringIncludes(result, inventoryLabel);
    localInventory = false;
    await turn("Read the exact peer model route.", {
      action: "model_route",
      ...exact,
      runId: approved.state.plan.runId,
    });
    assertEquals(JSON.parse(result).version, 0);
    await turn("Reject an unrelated model route.", {
      action: "model_route",
      ...exact,
      runId: main.state.plan.runId,
    });
    assertStringIncludes(result, "unavailable");

    const narrow = {
      action: "narrow_constraints",
      ...exact,
      runId: approved.state.plan.runId,
      expectedVersion: 1,
      requestId: crypto.randomUUID(),
      deniedKinds: ["trace"],
      note: restrictionNote,
    };
    await turn("Try narrowing a different case", narrow);
    assertStringIncludes(result, "unavailable");
    assertEquals(constraintConfirmations, []);
    await turn("/sentinel case approved");
    const localCheck = { upstreamCheck: coverageCheck.upstreamCheck };
    unleasedTelemetry = true;
    localGraph = "sentinel_trace";
    await turn("/sentinel-agent Read the authorized asset graph.", {
      node: "asset-a",
    });
    assertStringIncludes(result, secretLabel);
    await turn("/sentinel-agent Try the excluded asset graph.", {
      node: "asset-c",
    });
    assertStringIncludes(result, "unavailable");
    localGraph = "sentinel_shared_asset_links";
    await turn(
      "/sentinel-agent Read published topology for an authorized asset",
      topologyQuery,
    );
    assertEquals(JSON.parse(result).totalLinks, 1);
    assertStringIncludes(result, "peer-a-only");
    await turn("/sentinel-agent Reject topology for an excluded asset", {
      ...topologyQuery,
      asset: "asset-c",
    });
    assertStringIncludes(result, "unavailable");
    localGraph = undefined;
    localTelemetry = "sentinel_defense";
    const intake = sentinelAlertsPath(approved.path);
    const previousIntake = await Deno.readTextFile(intake);
    await Deno.writeTextFile(intake, "[]");
    try {
      await turn(
        "/sentinel-agent Read the committed defensive check.",
        localCheck,
      );
    } finally {
      await Deno.writeTextFile(intake, previousIntake);
    }
    assertEquals(
      JSON.parse(result).matches.map(({ alertId }: { alertId: string }) =>
        alertId
      ),
      [visibleAlertId],
    );
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    await turn("/sentinel-agent Try an exact excluded alert.", {
      ...localCheck,
      alertId: restrictedAlertId,
    });
    assertStringIncludes(result, "did not match");
    localTelemetry = "sentinel_incident_alerts";
    await turn("/sentinel-agent Read scoped incident members.", {
      incidentId: catalog.incidents[0].id,
    });
    assertEquals(JSON.parse(result).total, 2);
    await turn("/sentinel-agent Try an unavailable incident revision.", {
      incidentId: catalog.incidents[0].id,
      revision: approved.revision + 1,
    });
    assertStringIncludes(result, "unavailable");
    localTelemetry = undefined;
    const beforeUnleasedControl = dispatched;
    await turn("/sentinel-agent Try to use the owner case reader.", exactAlert);
    assertEquals(dispatched, beforeUnleasedControl);
    assert(!result.includes(visibleAlert.subject));

    localTelemetry = "sentinel_defense";
    revokeTelemetry = "POST_TOOL_RESPONSE";
    const workerRevoked = await turn(
      "/sentinel-agent Check an alert as authority is revoked.",
      {
        ...localCheck,
        alertId: visibleAlertId,
      },
    );
    assertEquals(telemetryRevocations, 1);
    assert(!result.includes(visibleAlert.subject));
    assert(
      workerRevoked.every((frame) => !frame.includes(visibleAlert.subject)),
    );
    constraintsAllowed = true;
    telemetryRevocations = 0;
    unleasedTelemetry = false;
    const alertsPath = sentinelAlertsPath(approved.path);
    const uncommittedAlerts = await Deno.readTextFile(alertsPath);
    await Deno.writeTextFile(alertsPath, "[]");
    try {
      await turn(
        "Read selected-case detection through the direct tool after intake changes",
        localCheck,
      );
    } finally {
      await Deno.writeTextFile(alertsPath, uncommittedAlerts);
    }
    assertEquals(
      JSON.parse(result).matches.map(({ alertId }: { alertId: string }) =>
        alertId
      ),
      [visibleAlertId],
    );
    await turn("Reject an excluded exact alert through the direct tool", {
      ...localCheck,
      alertId: restrictedAlertId,
    });
    assertStringIncludes(result, "did not match");
    assert(!result.includes(restrictedAlert.subject));
    localTelemetry = "sentinel_incident_alerts";
    await turn("Read exact scoped incident directly", {
      incidentId: catalog.incidents[0].id,
    });
    assertEquals(JSON.parse(result).total, 2);
    await turn("Reject revision drift in direct incident reads", {
      incidentId: catalog.incidents[0].id,
      revision: approved.revision + 1,
    });
    assertStringIncludes(result, "unavailable");
    localTelemetry = undefined;

    await turn("/sentinel off");
    await turn("/sentinel on");
    await turn("/sentinel case approved");
    await turn(nestedPrefix);
    nestedTelemetry = true;
    localTelemetry = "sentinel_defense";
    await Deno.writeTextFile(alertsPath, "[]");
    try {
      await turn("Delegate a defensively scoped telemetry read.", {
        question: nestedQuestion,
      });
    } finally {
      await Deno.writeTextFile(alertsPath, uncommittedAlerts);
    }
    assertStringIncludes(result, visibleAlert.subject);
    assert(!result.includes(restrictedAlert.subject));
    captureModelContext = true;
    await turn("Use the approved child result.");
    assertStringIncludes(modelContext, visibleAlert.subject);
    assertStringIncludes(modelContext, nestedPrefix);
    captureModelContext = true;
    revokeBeforeContext = true;
    await turn(revokeContextRequest);
    assert(!revokeBeforeContext);
    assertStringIncludes(modelContext, nestedPrefix);
    assert(!modelContext.includes(visibleAlert.subject));
    constraintsAllowed = true;

    denyNestedSourceAfterChild = true;
    const childReadDispatch = dispatched;
    const sourceDenied = await turn(
      "Delegate but deny reuse of the exact child source.",
      { question: nestedQuestion },
    );
    assert(parentSourceBlocked);
    assertEquals(dispatched, childReadDispatch + 1);
    assert(!result.includes(visibleAlert.subject));
    assert(
      sourceDenied.every((frame) => !frame.includes(visibleAlert.subject)),
    );
    denyNestedSourceAfterChild = false;
    parentSourceBlocked = false;

    revokeNestedParent = true;
    const revokedDelegationFrames = await turn(
      "Delegate while parent authority changes.",
      { question: nestedQuestion },
    );
    assert(!revokeNestedParent);
    assert(!result.includes(visibleAlert.subject));
    assert(
      revokedDelegationFrames.every((frame) =>
        !frame.includes(visibleAlert.subject)
      ),
    );
    constraintsAllowed = true;
    nestedTelemetry = false;
    localTelemetry = undefined;
    await turn("Read selected case restrictions", {
      action: "constraints",
      ...exact,
      runId: narrow.runId,
    });
    assertEquals(JSON.parse(result).version, 1);
    await turn("Try an old revision", {
      ...narrow,
      revision: approved.revision + 1,
    });
    assertStringIncludes(result, "unavailable");
    await turn("Try changing asset scope", {
      ...narrow,
      allowedAssetIds: ["asset-c"],
    });
    assertStringIncludes(result, "unavailable");
    reject = "PRE_TOOL_CALL";
    await turn("Policy denies the selected change", narrow);
    reject = undefined;
    assertEquals(constraintConfirmations, []);
    assertEquals(
      readSentinelOperatingConstraints(approved.path),
      approvedScope,
    );

    await turn("Decline the reviewed change", narrow);
    assertStringIncludes(result, "operator declined");
    approveRestriction = true;
    revokeDuringConfirmation = true;
    await turn("Authorization revoked while reviewing", narrow);
    assertEquals(
      readSentinelOperatingConstraints(approved.path),
      approvedScope,
    );
    constraintsAllowed = true;
    revokeDuringConfirmation = false;
    assertEquals(constraintConfirmations.length, 2);

    reject = "POST_TOOL_RESPONSE";
    await turn("Commit a reviewed restriction with response withheld", narrow);
    assert(!result.includes(restrictionNote));
    assert(hooks.includes("POST_TOOL_RESPONSE"));
    const committedRestriction = readSentinelOperatingConstraints(
      approved.path,
    );
    assertEquals(committedRestriction?.version, 2);
    assertEquals(committedRestriction?.constraints.deniedKinds, ["trace"]);
    assertEquals(
      committedRestriction?.constraints.allowedAssetIds,
      membership.assetIds,
    );
    assertEquals(committedRestriction?.membership, membership);
    assertEquals(constraintConfirmations.length, 3);
    assert(
      constraintLabels.some((labels) =>
        labels.case_id === exact.id &&
        labels.evidence_revision === exact.revision &&
        labels.resource_classification === "INTERNAL"
      ),
    );
    reject = "PRE_OUTPUT";
    const frames = await turn("Reopen the exact restriction", narrow);
    assertStringIncludes(result, restrictionNote);
    assert(frames.every((frame) => !frame.includes(restrictionNote)));
    reject = undefined;
    await turn("Reject removing the reviewed restriction", {
      ...narrow,
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
      deniedKinds: [],
    });
    assertStringIncludes(result, "unavailable");
    assertEquals(constraintConfirmations.length, 3);
    assertEquals(
      readSentinelOperatingConstraints(approved.path),
      committedRestriction,
    );
    const guidance = {
      action: "hint_batch",
      ...exact,
      runId: narrow.runId,
      requestId: crypto.randomUUID(),
      hints: [
        { note: "Review the case summary." },
        {
          note: "Check the selected asset's existing review.",
          assetIds: ["asset-a"],
        },
      ],
    };
    const wakes: string[] = [];
    const unsubscribe = subscribeCommittedEvidence(
      exact.id,
      ({ observation_id }) => {
        wakes.push(observation_id);
      },
    );
    try {
      await turn("Reject other-case guidance", {
        ...guidance,
        id: "main",
        runId: main.state.plan.runId,
      });
      assertStringIncludes(result, "unavailable");
      reject = "PRE_TOOL_CALL";
      await turn("Deny unreviewed planner guidance", guidance);
      reject = undefined;
      assertEquals(hintConfirmations.length, 0);
      assertEquals(readSentinelCaseHints(approved.path, 10), []);
      await turn("Review the exact case guidance", guidance);
      const receipt = JSON.parse(result).receipt;
      assertEquals(receipt.requestId, guidance.requestId);
      assertEquals(hintConfirmations.length, 1);
      const saved = readSentinelCaseHints(approved.path, 10);
      assertEquals(saved.map(({ id }) => id).reverse(), receipt.hintIds);
      assertEquals(
        saved.map(({ text }) => text).reverse(),
        guidance.hints.map(({ note }) => note),
      );
      await turn("Reopen the exact planner hint receipt", guidance);
      assertEquals(JSON.parse(result).receipt, receipt);
      assertEquals(hintConfirmations.length, 1);
      assertEquals(wakes, [`operator-hint-batch:${guidance.requestId}`]);
    } finally {
      unsubscribe();
    }

    advanceAdaptiveSentinel(approved.path, approved.state);
    const adaptive = readAdaptiveSentinel(
      approved.path,
      approved.state,
      "revision",
    );
    assert(adaptive?.revision);
    const assignment = {
      action: "assign_batch",
      ...exact,
      runId: narrow.runId,
      adaptiveRevision: adaptive.revision,
      requestId: crypto.randomUUID(),
      assignments: [{ taskKind: "impact", node: "asset-a" }],
    };
    for (
      const invalid of [
        { ...assignment, id: "main", runId: main.state.plan.runId },
        {
          ...assignment,
          assignments: [{ taskKind: "trace", node: "asset-a" }],
        },
        {
          ...assignment,
          assignments: [{ taskKind: "impact", node: "asset-c" }],
        },
        { ...assignment, assignments: [{ taskKind: "exec", node: "asset-a" }] },
      ]
    ) {
      await turn("Reject an invalid graph assignment", invalid);
      assertStringIncludes(result, "unavailable");
    }
    reject = "PRE_TOOL_CALL";
    await turn("Reject an unapproved assignment", assignment);
    reject = undefined;
    assertEquals(assignmentConfirmations.length, 0);
    const readTasks = () =>
      readAdaptiveSentinel(approved.path, approved.state, "revision")?.tasks;
    const before = readTasks();
    revokeAssignmentDuringConfirmation = true;
    await turn(
      "Revoke assignment access before confirmation returns",
      assignment,
    );
    assertEquals(readTasks(), before);
    constraintsAllowed = true;
    revokeAssignmentDuringConfirmation = false;
    await turn("Assign exact reviewed graph work", assignment);
    const receipt = JSON.parse(result).receipt;
    assertEquals(receipt.requestId, assignment.requestId);
    assertEquals(receipt.receipts.length, 1);
    const accepted = readTasks()?.find(({ id }) =>
      id === receipt.receipts[0].taskId
    );
    assertEquals(accepted?.kind, "impact");
    assertEquals(accepted?.nodeId, "asset-a");
    await turn("Reopen the exact assignment receipt", assignment);
    assertEquals(JSON.parse(result).receipt, receipt);
    assertEquals(assignmentConfirmations.length, 2);

    const addition = {
      action: "add_case_membership",
      ...exact,
      runId: narrow.runId,
      expectedVersion: 2,
      requestId: crypto.randomUUID(),
      organizationId: "ops",
      note: additionNote,
    };
    for (
      const invalid of [
        { ...addition, id: "main", runId: main.state.plan.runId },
        { ...addition, revision: exact.revision + 1 },
        { ...addition, organizationId: "unregistered" },
      ]
    ) {
      await turn("Reject unrelated case membership additions", invalid);
      assertStringIncludes(result, "unavailable");
    }
    reject = "PRE_TOOL_CALL";
    await turn("Do not offer a membership change denied by policy", addition);
    reject = undefined;
    assertEquals(membershipConfirmations.length, 0);

    await turn("Decline a proposed membership addition", addition);
    assertStringIncludes(result, "operator declined");
    assertEquals(
      readSentinelOperatingConstraints(approved.path),
      committedRestriction,
    );

    acceptMembership = true;
    changeMembershipVersionDuringReview = true;
    await turn(
      "Reject a membership approval for the superseded version",
      addition,
    );
    assertStringIncludes(result, "unavailable");
    assertEquals(readSentinelOperatingConstraints(approved.path)?.version, 3);
    assertEquals(
      readSentinelOperatingConstraints(approved.path)?.membership,
      membership,
    );
    changeMembershipVersionDuringReview = false;

    const currentAddition = {
      ...addition,
      expectedVersion: 3,
      requestId: crypto.randomUUID(),
    };
    reject = "POST_TOOL_RESPONSE";
    await turn(
      "Commit the approved exact membership with response blocked",
      currentAddition,
    );
    assert(!result.includes(additionNote));
    assert(hooks.includes("POST_TOOL_RESPONSE"));
    reject = "PRE_OUTPUT";
    const reviewedFrames = await turn(
      "Inspect the exact saved membership receipt",
      currentAddition,
    );
    const added = JSON.parse(result);
    assertEquals(added.version, 4);
    assertEquals(added.membership.selector, {
      kind: "addition",
      baselineAssetIds: ["asset-a", "asset-b"],
      addition: { kind: "organization", organizationId: "ops" },
      reason: additionNote,
    });
    assertEquals(added.membership.assetIds, ["asset-a", "asset-b", "asset-c"]);
    assert(reviewedFrames.every((frame) => !frame.includes(additionNote)));
    reject = undefined;
    assertEquals(membershipConfirmations.length, 3);
    const currentConstraints = readSentinelOperatingConstraints(approved.path);
    assertEquals(currentConstraints?.constraints, {
      ...committedRestriction!.constraints,
      allowedAssetIds: added.membership.assetIds,
    });
    assertEquals(currentConstraints?.membership, added.membership);
    await turn("Reject changing the reviewed reason in a retry", {
      ...currentAddition,
      note: "Replacement reason.",
    });
    assertStringIncludes(result, "unavailable");
    assertEquals(membershipConfirmations.length, 3);
    await turn(
      "Reject an inventory cursor from before the membership addition",
      {
        ...batch,
        cursor: batchPage.nextCursor,
      },
    );
    assertStringIncludes(result, "unavailable");
    await turn("Reject text continuation after membership changed", {
      ...textSearch,
      cursor: textPage.nextCursor,
    });
    assertStringIncludes(result, "unavailable");
    await turn(
      "Read the newly enrolled asset through the same scoped inventory",
      {
        ...inventory,
        assetId: "asset-c",
      },
    );
    assertEquals(JSON.parse(result).page.assets[0].id, "asset-c");
    assertEquals(JSON.parse(result).page.membership.version, 4);
    await turn(
      "Count the newly approved type in the same membership view",
      coverage,
    );
    assertEquals(JSON.parse(result).page.coverageTotals, {
      assets: 3,
      reviewed: 0,
      withEvidence: 1,
      matchedAssets: 3,
      byAssetType: [
        { assetType: "application", assets: 1, reviewed: 0, withEvidence: 0 },
        { assetType: "service", assets: 2, reviewed: 0, withEvidence: 1 },
      ],
    });
    await turn("Reject a coverage cursor from before the reviewed addition", {
      ...coverage,
      cursor: first.nextCursor,
    });
    assertStringIncludes(result, "unavailable");
    await turn("Inspect the earlier approved membership", {
      action: "constraints",
      ...exact,
      runId: narrow.runId,
      version: 2,
    });
    assertEquals(JSON.parse(result).history[0].membership, membership);

    await turn("Preserve the membership evidence when narrowing task kinds", {
      ...narrow,
      expectedVersion: 4,
      requestId: crypto.randomUUID(),
      deniedKinds: ["trace", "review_incident"],
    });
    assertEquals(JSON.parse(result).record.version, 5);
    assertEquals(
      readSentinelOperatingConstraints(approved.path)?.membership,
      added.membership,
    );

    revokeTelemetry = "POST_TOOL_RESPONSE";
    const staleResponse = await turn(
      "Revoke selected-case authority during response classification",
      exactAlert,
    );
    assertEquals(telemetryRevocations, 1);
    assert(!result.includes(visibleAlert.subject));
    assert(
      staleResponse.every((frame) => !frame.includes(visibleAlert.subject)),
    );
    constraintsAllowed = true;

    await turn("/sentinel off");
    await turn("/sentinel on");
    await turn("/sentinel case approved");
    localTelemetry = "sentinel_defense";
    const directAlert = {
      upstreamCheck: coverageCheck.upstreamCheck,
      alertId: visibleAlertId,
    };
    await turn(independentContext);
    await turn("Read a retained alert for this investigation", directAlert);
    assertStringIncludes(result, visibleAlert.subject);
    captureModelContext = true;
    await turn("Keep using the allowed context.");
    assertStringIncludes(modelContext, independentContext);
    assertStringIncludes(modelContext, visibleAlert.subject);

    captureModelContext = true;
    reject = "POST_TOOL_RESPONSE";
    await turn("Refresh authorization on the exact saved telemetry response.");
    assert(hooks.includes("POST_TOOL_RESPONSE"));
    assertStringIncludes(modelContext, independentContext);
    assert(!modelContext.includes(visibleAlert.subject));
    reject = undefined;
    await turn("Read the authorized alert again", directAlert);
    assertStringIncludes(result, visibleAlert.subject);

    captureModelContext = true;
    revokeBeforeContext = true;
    await turn(revokeContextRequest);
    assert(!revokeBeforeContext);
    assertStringIncludes(modelContext, independentContext);
    assert(!modelContext.includes(visibleAlert.subject));
    constraintsAllowed = true;
    captureModelContext = true;
    await turn("Continue with the unaffected context.");
    assertStringIncludes(modelContext, independentContext);
    assert(!modelContext.includes(visibleAlert.subject));

    localTelemetry = undefined;
    localGraph = "sentinel_shared_asset_links";
    await turn(
      "Refresh the dependency before changing asset scope",
      { ...topologyQuery, limit: 5 },
    );
    assertEquals(JSON.parse(result).totalLinks, 2);
    assertStringIncludes(result, "peer-a-only");
    localGraph = undefined;
    const observationSearch = "Worker observation scope fixture";
    const observationResult = new Map<
      string,
      { id: string; summary: string }
    >();
    const store = openSentinelAdaptiveStore(
      join(dirname(approved.path), "sentinel-adaptive.db"),
    );
    try {
      const revision = store.activeRevision();
      assert(revision);
      const assignments = store.sync(
        revision,
        ["asset-a", "asset-c"].map(
          (nodeId) => ({
            nodeId,
            kind: "impact" as const,
            depth: 10,
            reason: observationSearch,
          }),
        ),
      ).filter(({ reason }) => reason === observationSearch);
      assertEquals(assignments.length, 2);
      for (const task of assignments) {
        const excluded = new Set(
          store.list(revision).flatMap(({ id }) => id === task.id ? [] : [id]),
        );
        const claim = store.claim(revision, 60, excluded);
        assert(claim?.task.nodeId);
        assertEquals(claim.task.id, task.id);
        const summary = `${observationSearch} for ${claim.task.nodeId}.`;
        assert(store.complete({
          taskId: task.id,
          leaseToken: claim.leaseToken,
          observation: { summary },
        }));
        observationResult.set(claim.task.nodeId, { id: task.id, summary });
      }
    } finally {
      store.close();
    }
    const withdrawnObservation = observationResult.get("asset-a");
    const allowedObservation = observationResult.get("asset-c");
    assert(withdrawnObservation && allowedObservation);
    localGraph = "sentinel_worker_observation";
    await turn("Read an authorized exact worker result", {
      task: withdrawnObservation.id,
    });
    assertEquals(JSON.parse(result).task, withdrawnObservation.id);
    assertStringIncludes(result, withdrawnObservation.summary);
    assert(
      hooks.includes("PRE_TOOL_CALL") && hooks.includes("POST_TOOL_RESPONSE") &&
        hooks.includes("PRE_OUTPUT"),
    );
    await turn("Search both currently approved observations", {
      query: observationSearch,
    });
    assertEquals(JSON.parse(result).observations.length, 2);
    localGraph = undefined;

    revokeTelemetry = "PRE_OUTPUT";
    const staleDelivery = await turn(
      "Narrow asset authority during destination review",
      exactAlert,
    );
    assertEquals(telemetryRevocations, 2);
    assert(
      staleDelivery.every((frame) => !frame.includes(visibleAlert.subject)),
    );
    await turn("Reject exact evidence after asset revocation", exactAlert);
    assertStringIncludes(result, "unavailable");
    await turn(
      "Reject finding lineage after affected asset withdrawal",
      lineage,
    );
    assertStringIncludes(result, "unavailable");
    await turn("Reject the old lineage cursor after scope withdrawal", {
      ...lineage,
      cursor: firstLineage.nextCursor,
    });
    assertStringIncludes(result, "unavailable");
    captureModelContext = true;
    await turn("Do not reuse the withdrawn worker observation.");
    assert(!modelContext.includes(withdrawnObservation.summary));
    assert(!modelContext.includes("peer-a-only"));
    localGraph = "sentinel_shared_asset_links";
    await turn(
      "Reject previously authorized shared topology after local revocation",
      topologyQuery,
    );
    assertStringIncludes(result, "unavailable");
    await turn("Keep reading the remaining approved asset topology", {
      ...topologyQuery,
      asset: "asset-c",
    });
    assertEquals(JSON.parse(result).totalLinks, 1);
    assertStringIncludes(result, "peer-c-only");

    localGraph = "sentinel_worker_observation";
    for (const unleased of [false, true]) {
      unleasedTelemetry = unleased;
      const prefix = unleased ? "/sentinel-agent " : "";
      const rejected = await turn(prefix + "Reject the withdrawn observation", {
        task: withdrawnObservation.id,
      });
      assertStringIncludes(result, "unavailable");
      assert(
        rejected.every((frame) =>
          !frame.includes(withdrawnObservation.summary)
        ),
      );
      await turn(prefix + "Search only currently approved observations", {
        query: observationSearch,
      });
      assertEquals(
        JSON.parse(result).observations.map(({ id }: { id: string }) => id),
        [allowedObservation.id],
      );
      await turn(prefix + "Read the remaining authorized observation", {
        task: allowedObservation.id,
      });
      assertEquals(JSON.parse(result).task, allowedObservation.id);
      assertStringIncludes(result, allowedObservation.summary);
    }
    localGraph = undefined;
    unleasedTelemetry = false;
    const scopeRuleBefore = readSentinelOperatingConstraints(approved.path);
    assert(scopeRuleBefore);
    const reviewRules = {
      ...exact,
      runId: scopeRuleBefore.runId,
      scopeRules: [{ kind: "keyword", value: "asset c" }],
      note: "Authorize retained assets with the designated fixture title.",
    };
    await turn("Preview keyword rules in the selected case", {
      ...reviewRules,
      action: "preview_membership",
    });
    assertEquals(JSON.parse(result).membership.assetIds, ["asset-c"]);
    await turn("Reject a scope URL containing query values", {
      ...reviewRules,
      action: "preview_membership",
      scopeRules: [{
        kind: "url",
        value: "https://example.test/status?token=fixture",
      }],
    });
    assertStringIncludes(result, "unavailable");
    const setRules = {
      ...reviewRules,
      action: "set_case_membership",
      expectedVersion: scopeRuleBefore.version,
      requestId: crypto.randomUUID(),
    };
    reject = "PRE_TOOL_CALL";
    await turn("Withhold a scope change blocked before dispatch", setRules);
    reject = undefined;
    assertEquals(scopeRuleReviews.length, 0);
    await turn("Decline case scope rules", setRules);
    assertStringIncludes(result, "operator declined");
    assertEquals(
      readSentinelOperatingConstraints(approved.path),
      scopeRuleBefore,
    );
    approveScopeRules = true;
    await turn("Approve case scope rules for this revision", setRules);
    assertEquals(JSON.parse(result).version, scopeRuleBefore.version + 1);
    assertEquals(
      readSentinelOperatingConstraints(approved.path)?.constraints
        .allowedAssetIds,
      ["asset-c"],
    );
    await turn("Reject a stale distinct scope proposal", {
      ...setRules,
      requestId: crypto.randomUUID(),
    });
    assertStringIncludes(result, "unavailable");
    assertEquals(scopeRuleReviews.length, 2);
  } finally {
    socket.close();
    await gateway.stop();
    await Deno.remove(baseDir, { recursive: true });
  }
});
