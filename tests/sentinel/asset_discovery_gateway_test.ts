import { createChatSession } from "../../src/gateway/chat.ts";
import { createOperatorRunToolExecutor } from "../../src/gateway/operator_run_tool.ts";
import {
  type ChannelId,
  createSession,
  type UserId,
} from "../../src/core/types/session.ts";
import { sentinelArchivedDiscoveriesFile } from "../../src/sentinel/archive_asset_discoveries.ts";
import { executeOperatorRunArchive } from "../../src/gateway/operator_run_archive.ts";
import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import {
  readSentinelSharedAssetDiscoveries,
  submitSentinelAssetDiscovery,
} from "../../src/gateway/sentinel_asset_discoveries.ts";
import { createTidepoolSentinelHandler } from "../../src/gateway/startup/services/tidepool_sentinel.ts";
import type { BootstrapResult } from "../../src/gateway/startup/bootstrap.ts";
import { openSentinelAssetDiscoveryStore } from "../../src/sentinel/asset_discovery_store.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

Deno.test("Gateway workers share an approved discovery with exact cross-case provenance", async () => {
  const baseDir = await Deno.makeTempDir();
  const sourcePath = resolveSentinelCasePath(baseDir, "main");
  const consumerPath = resolveSentinelCasePath(baseDir, "consumer");
  const usage = { inputTokens: 1, outputTokens: 1 };
  const discoveryRequestId = crypto.randomUUID();
  let consumedResponse: string | undefined;
  const hooks: HookRunner = {
    evaluateHook: () =>
      Promise.resolve({
        allowed: true,
        action: "ALLOW",
        ruleId: null,
        duration: 0,
      }),
  };
  const graph = {
    version: 1,
    nodes: [
      { id: "canonical-a", kind: "asset", label: "Application" },
      { id: "canonical-b", kind: "asset", label: "Dependency" },
      { id: "record", kind: "evidence", label: "Exact observed topology" },
    ],
    edges: [
      { from: "canonical-a", to: "canonical-b", relation: "depends_on" },
      { from: "record", to: "canonical-a", relation: "observed_on" },
      { from: "record", to: "canonical-b", relation: "observed_on" },
    ],
  };
  const consumer = {
    version: 1,
    nodes: [
      {
        id: "local-a",
        kind: "asset",
        label: "Local application",
        aliases: ["canonical-a"],
      },
      {
        id: "local-b",
        kind: "asset",
        label: "Local dependency",
        aliases: ["canonical-b"],
      },
    ],
    edges: [],
  };
  const planners: ReturnType<typeof createSentinelModelPlanner>[] = [];
  function call(name: string, args: object, sequence = 0) {
    return {
      content: "",
      usage,
      toolCalls: [{
        type: "function",
        id: name + sequence,
        function: { name, arguments: JSON.stringify(args) },
      }],
    };
  }
  function summary(text: string, followUps: object[] = []) {
    return {
      content: JSON.stringify({ summary: text, followUps }),
      usage,
      toolCalls: [],
    };
  }
  function plannerFor(
    path: string,
    target: string,
    producer: boolean,
    expected?: string,
  ) {
    const registry = createProviderRegistry();
    registry.register({
      name: "asset-discovery-fixture",
      supportsStreaming: false,
      complete(messages) {
        const results = messages.filter(({ role }) => role === "tool");
        const child = messages.some(({ content }) =>
          typeof content === "string" && content.includes('"kind":"trace"')
        );
        if (child) {
          return Promise.resolve(summary("Follow-up read the case graph."));
        }
        if (producer) {
          const claim = {
            requestId: discoveryRequestId,
            kind: "relationship",
            evidenceId: "record",
            to: "canonical-b",
            relation: "depends_on",
          };
          if (!results.length) {
            return Promise.resolve(call("sentinel_assigned_target", {}));
          }
          if (results.length <= 2) {
            return Promise.resolve(
              call("sentinel_submit_asset_discovery", claim, results.length),
            );
          }
          const first = String(results[1].content).match(
            /asset-discovery:[a-f0-9]{64}/,
          )?.[0];
          const second = String(results[2].content).match(
            /asset-discovery:[a-f0-9]{64}/,
          )?.[0];
          assert(first);
          assertEquals(first, second);
          return Promise.resolve(
            summary("Proposed exact source relationship."),
          );
        }
        if (!results.length) {
          return Promise.resolve(call("sentinel_shared_asset_discoveries", {}));
        }
        if (results.length === 1) {
          const list = String(results[0].content);
          if (!expected) {
            assert(!list.includes("asset-discovery:"));
            return Promise.resolve(
              summary("No unambiguously mapped discovery."),
            );
          }
          assert(list.includes(expected));
          const page = JSON.parse(list);
          assertEquals(page.discoveries.length, 5);
          assertEquals(page.nextAfter, page.discoveries.at(-1).id);
          return Promise.resolve(
            call(
              "sentinel_shared_asset_discoveries",
              { after: page.nextAfter },
              1,
            ),
          );
        }
        if (results.length === 2) {
          const first = JSON.parse(String(results[0].content));
          const next = JSON.parse(String(results[1].content));
          assertEquals(next.discoveries.length, 2);
          assertEquals(next.truncated, false);
          assertEquals(
            new Set(
              [...first.discoveries, ...next.discoveries].map(({ id }) => id),
            ).size,
            7,
          );
          return Promise.resolve(
            call("sentinel_shared_asset_discoveries", { id: expected }),
          );
        }
        const exact = String(results[2].content);
        consumedResponse = exact;
        assert(
          exact.includes("canonical-b") && exact.includes("local-b") &&
            exact.includes(expected!),
        );
        return Promise.resolve(
          summary("Reused the approved source topology.", [{
            kind: "trace",
            nodeId: target,
          }]),
        );
      },
    });
    registry.setDefault("asset-discovery-fixture");
    const planner = createSentinelModelPlanner(path, (state, taskId, token) => {
      if (!taskId || !token) {
        return {
          execute(_message, send) {
            send({
              type: "response",
              taint: "INTERNAL",
              text: JSON.stringify([{ kind: "impact", nodeId: target }]),
            });
            return Promise.resolve();
          },
          clear() {},
        };
      }
      return createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: state.revision,
        assignedTaskId: taskId,
        assignedTaskLeaseToken: token,
        providerRegistry: registry,
        hookRunner: hooks,
        allowModelAccess: true,
        submitAssetDiscovery: ({ evidenceRevision, claim, requestId }) =>
          Promise.resolve(
            submitSentinelAssetDiscovery(
              path,
              {
                taskId,
                token,
                evidenceRevision,
              },
              claim,
              requestId,
            ),
          ),
        readSharedAssetDiscoveries: ({ evidenceRevision, signal, id, after }) =>
          readSentinelSharedAssetDiscoveries(
            path,
            { taskId, token, evidenceRevision },
            id,
            signal,
            after,
          ),
      });
    });
    planners.push(planner);
    return planner;
  }
  async function waitFor(condition: () => boolean) {
    for (let i = 0; i < 150 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(condition());
  }
  try {
    await Deno.mkdir(dirname(consumerPath), { recursive: true });
    await Deno.writeTextFile(sourcePath, JSON.stringify(graph));
    await Deno.writeTextFile(consumerPath, JSON.stringify(consumer));
    const source = startSentinelAssessment(sourcePath);
    advanceAdaptiveSentinel(sourcePath, source);
    const unrelated = openSentinelAssetDiscoveryStore(baseDir);
    try {
      for (let index = 0; index < 31; index++) {
        const row = unrelated.propose({
          sourceCaseId: "unrelated",
          taskId: "adaptive:" + "a".repeat(64),
          evidenceRevision: 1,
          sourceDigest: "b".repeat(64),
          claim: {
            kind: "asset",
            assetId: "unrelated-" + index,
            evidenceId: "record",
          },
        });
        assert(unrelated.approve(row.id, row.version));
      }
    } finally {
      unrelated.close();
    }
    plannerFor(sourcePath, "canonical-a", true).advance(source);
    await waitFor(() =>
      !!readAdaptiveSentinel(sourcePath, source)?.modelReviews.some((
        { summary },
      ) => summary === "Proposed exact source relationship.")
    );

    const sourceReview = readAdaptiveSentinel(sourcePath, source)?.modelReviews
      .find(({ summary }) => summary === "Proposed exact source relationship.");
    const publications = sourceReview?.steps.filter(({ tool }) =>
      tool === "sentinel_submit_asset_discovery"
    );
    assertEquals(
      publications?.map(({ assetDiscoveryRequestId }) =>
        assetDiscoveryRequestId
      ),
      [discoveryRequestId, discoveryRequestId],
    );

    const handler = createTidepoolSentinelHandler(
      { baseDir, config: {} } as BootstrapResult,
    );
    const output: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (value: string) => output.push(JSON.parse(value)),
    } as unknown as WebSocket;
    await handler(
      { type: "asset_discovery_proposals", caseId: "main" },
      socket,
    );
    const proposals = output.find(({ type }) =>
      type === "sentinel_asset_discovery_proposals"
    )?.proposals as { id: string; version: number }[];
    assertEquals(proposals.length, 1);
    const [proposal] = proposals;
    await handler({
      type: "asset_discovery_decision",
      caseId: "main",
      action: "approve",
      id: proposal.id,
      version: proposal.version,
    }, socket);
    assert(
      output.some(({ type }) => type === "sentinel_asset_discovery_decision"),
    );

    const additional = openSentinelAssetDiscoveryStore(baseDir);
    try {
      const original = additional.get(proposal.id);
      assert(original);
      for (let index = 0; index < 6; index++) {
        const extra = additional.propose({
          ...original,
          taskId: "adaptive:" + String(index).repeat(64),
        });
        assert(additional.approve(extra.id, extra.version));
      }
    } finally {
      additional.close();
    }

    const destination = startSentinelAssessment(consumerPath);
    advanceAdaptiveSentinel(consumerPath, destination);
    plannerFor(consumerPath, "local-a", false, proposal.id).advance(
      destination,
    );
    await waitFor(() =>
      !!readAdaptiveSentinel(consumerPath, destination)?.tasks.some((
        { kind, reviewedFrom },
      ) => kind === "trace" && !!reviewedFrom)
    );
    const view = readAdaptiveSentinel(consumerPath, destination)!;
    const followUp = view.tasks.find(({ kind, reviewedFrom }) =>
      kind === "trace" && reviewedFrom
    )!;
    assertEquals(followUp.prerequisites, [followUp.reviewedFrom!]);
    const approved = view.assetDiscoveries.find(({ id }) => id === proposal.id);
    assert(approved);
    assertEquals(approved.status, "approved");
    const citation = view.modelReviews.find(({ taskId }) =>
      taskId === followUp.reviewedFrom
    )
      ?.steps.find(({ sharedAssetDiscovery }) =>
        sharedAssetDiscovery?.id === proposal.id
      )
      ?.sharedAssetDiscovery;
    assertEquals(citation, {
      id: approved.id,
      version: approved.version,
      sourceCaseId: approved.sourceCaseId,
      taskId: approved.taskId,
      evidenceRevision: approved.evidenceRevision,
      sourceDigest: approved.sourceDigest,
      evidenceId: approved.claim.evidenceId,
    });

    const assertUnavailable = () => {
      const state = refreshSentinelAssessment(consumerPath)!;
      const revision = adaptiveRevision(state);
      advanceAdaptiveSentinel(consumerPath, state);
      const store = openSentinelAdaptiveStore(
        dirname(consumerPath) + "/sentinel-adaptive.db",
      );
      return (async () => {
        try {
          store.sync(revision, [{
            kind: "impact",
            nodeId: "local-a",
            reason: MODEL_ASSIGNMENT_REASON,
          }], revision);
          advanceAdaptiveSentinel(consumerPath, state);
          const lease = store.claimModelReview(
            revision,
            MODEL_ASSIGNMENT_REASON,
            (task) => task.nodeId === "local-a",
          );
          assert(lease);
          assertEquals(
            await readSentinelSharedAssetDiscoveries(consumerPath, {
              taskId: lease.task.id,
              token: lease.token,
              evidenceRevision: state.revision,
            }, proposal.id),
            [],
          );
        } finally {
          store.close();
        }
      })();
    };
    await Deno.writeTextFile(
      consumerPath,
      JSON.stringify({
        ...consumer,
        nodes: [...consumer.nodes, {
          id: "ambiguous",
          kind: "asset",
          label: "Conflicting application",
          aliases: ["canonical-a"],
        }],
      }),
    );
    await assertUnavailable();

    // A newly added source alias is outside the approved source snapshot.
    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === "canonical-a"
            ? { ...node, aliases: ["new-source-alias"] }
            : node
        ),
      }),
    );
    refreshSentinelAssessment(sourcePath);
    await Deno.writeTextFile(
      consumerPath,
      JSON.stringify({
        ...consumer,
        nodes: consumer.nodes.map((node) =>
          node.id === "local-a"
            ? { ...node, aliases: ["new-source-alias"] }
            : node
        ),
      }),
    );
    await assertUnavailable();

    await Deno.writeTextFile(
      sourcePath,
      JSON.stringify({ ...graph, edges: graph.edges.slice(1) }),
    );
    refreshSentinelAssessment(sourcePath);
    await Deno.writeTextFile(
      consumerPath,
      JSON.stringify({
        ...consumer,
        nodes: [...consumer.nodes, {
          id: "fixed",
          kind: "asset",
          label: "Updated inventory",
        }],
      }),
    );
    await assertUnavailable();
    const store = openSentinelAssetDiscoveryStore(baseDir);
    try {
      const record = store.get(proposal.id)!;
      await handler({
        type: "asset_discovery_decision",
        caseId: "main",
        id: record.id,
        version: record.version,
        action: "withdraw",
      }, socket);
    } finally {
      store.close();
    }
    await Deno.writeTextFile(
      consumerPath,
      JSON.stringify({
        ...consumer,
        nodes: [...consumer.nodes, {
          id: "extra",
          kind: "asset",
          label: "New asset",
        }],
      }),
    );
    const next = refreshSentinelAssessment(consumerPath)!;
    assert(next.revision > destination.revision);
    await handler({
      type: "export",
      caseId: "consumer",
      format: "provenance",
      revision: destination.revision,
    }, socket);
    const archived = JSON.parse(String(
      output.find(({ type }) => type === "export")?.content,
    )).provenance;
    const discovery = archived.nodes.find((node: { sourceId: string }) =>
      node.sourceId === proposal.id
    );
    assert(discovery);
    assertEquals(discovery.assetDiscovery, approved);
    assertEquals(discovery.assetDiscovery.sourceCaseId, "main");
    assertEquals(discovery.assetDiscovery.claim.evidenceId, "record");
    const confirm = () => Promise.resolve(true);
    assert(consumedResponse);
    const index = view.modelReviews.find(({ taskId }) =>
      taskId === followUp.reviewedFrom
    )
      ?.steps.findIndex(({ sharedAssetDiscovery }) =>
        sharedAssetDiscovery?.id === proposal.id
      );
    assert(index !== undefined && index >= 0);
    const registry = createProviderRegistry();
    let reopened: string | undefined;
    registry.register({
      name: "discovery-trace-fixture",
      supportsStreaming: false,
      complete(messages) {
        const last = messages.at(-1);
        if (last?.role === "tool") {
          reopened = String(last.content);
          return Promise.resolve({
            content: "Review finished.",
            usage,
            toolCalls: [],
          });
        }
        return Promise.resolve(call("operator_runs", {
          action: "worker_trace_result",
          kind: "sentinel",
          id: "consumer",
          revision: destination.revision,
          taskId: followUp.reviewedFrom,
          stepIndices: [index],
        }));
      },
    });
    registry.setDefault("discovery-trace-fixture");
    let deny = false;
    const chat = createChatSession({
      session: createSession({
        userId: "owner" as UserId,
        channelId: "discovery-trace" as ChannelId,
        bumpersEnabled: false,
      }),
      providerRegistry: registry,
      operatorRunExecutor: createOperatorRunToolExecutor({ baseDir, confirm }),
      hookRunner: {
        evaluateHook(hook, { input }) {
          const allowed = !(deny && hook === "POST_TOOL_RESPONSE" &&
            input.tool_name === "sentinel_shared_asset_discoveries");
          return Promise.resolve({
            allowed,
            action: allowed ? "ALLOW" : "BLOCK",
            duration: 0,
            ruleId: null,
          });
        },
      },
    });
    await chat.executeAgentTurn("Open the saved discovery.", () => {});
    assertEquals(
      JSON.parse(reopened ?? "").result,
      JSON.parse(consumedResponse),
    );
    deny = true;
    await chat.executeAgentTurn("Reopen the saved discovery.", () => {});
    assert(reopened?.includes("unavailable"));
    assert(stopSentinelAssessment(consumerPath));
    const ref = {
      kind: "sentinel" as const,
      id: "consumer",
      revision: next.revision,
    };
    const archiveId = crypto.randomUUID();
    const archiveArgs = {
      ...ref,
      runId: next.plan.runId,
      requestId: archiveId,
    };
    const archivedRun = await executeOperatorRunArchive(baseDir, ref, {
      action: "archive",
      ...archiveArgs,
    }, confirm);
    assert(typeof archivedRun !== "string");
    assertEquals(
      (archivedRun.receipt as { status: string }).status,
      "succeeded",
    );
    await Deno.rename(dirname(consumerPath), join(baseDir, "old-consumer"));
    await Deno.remove(join(baseDir, "data", "sentinel-asset-discoveries.db"));
    await Deno.rename(sourcePath, join(baseDir, "old-source-snapshot.json"));
    await Deno.rename(
      join(dirname(sourcePath), "sentinel-assessment.db"),
      join(baseDir, "old-source-assessment.db"),
    );
    const artifact = join(
      baseDir,
      "data",
      "run-archives",
      archiveId,
      sentinelArchivedDiscoveriesFile,
    );
    const hiddenArtifact = join(baseDir, "old-discovery-bundle.json");
    await Deno.rename(artifact, hiddenArtifact);
    const incomplete = await executeOperatorRunArchive(baseDir, ref, {
      action: "restore",
      ...archiveArgs,
      requestId: crypto.randomUUID(),
      archiveId,
    }, confirm);
    assert(typeof incomplete !== "string");
    assertEquals((incomplete.receipt as { status: string }).status, "failed");
    await Deno.rename(hiddenArtifact, artifact);
    const restoredRun = await executeOperatorRunArchive(baseDir, ref, {
      action: "restore",
      ...archiveArgs,
      requestId: crypto.randomUUID(),
      archiveId,
    }, confirm);
    assert(typeof restoredRun !== "string");
    assertEquals(
      (restoredRun.receipt as { status: string }).status,
      "succeeded",
    );
    const restored = readAdaptiveSentinel(
      consumerPath,
      destination,
      "revision",
    );
    assertEquals(restored?.assetDiscoveries, [approved]);
    output.length = 0;
    await handler({
      type: "export",
      caseId: "consumer",
      format: "provenance",
      revision: destination.revision,
    }, socket);
    const restoredProvenance = JSON.parse(String(
      output.find(({ type }) => type === "export")?.content,
    )).provenance;
    assertEquals(
      restoredProvenance.nodes.find((node: { sourceId: string }) =>
        node.sourceId === proposal.id
      ),
      discovery,
    );
    deny = false;
    await chat.executeAgentTurn("Open the restored discovery.", () => {});
    assertEquals(
      JSON.parse(reopened ?? "").result,
      JSON.parse(consumedResponse),
    );
    assert(
      archived.edges.some((edge: { to: string; relation: string }) =>
        edge.to === discovery.id && edge.relation === "references"
      ),
    );
  } finally {
    for (const planner of planners) planner.stop();
    await waitFor(() =>
      planners.every((planner) => !planner.hasInFlightWork())
    );
    await Deno.remove(baseDir, { recursive: true });
  }
});
