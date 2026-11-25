import { createGatewayServer } from "../../src/gateway/server/server.ts";
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
  recordSentinelOperatingConstraints,
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
  let consumedPages: string[] = [];
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
        consumedPages = results.slice(0, 2).map(({ content }) =>
          String(content)
        );
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

    let interruptedDiscoveryId: string | undefined;
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
        interruptedDiscoveryId ??= extra.id;
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

    const plannerIdentity = `${
      adaptiveRevision(destination)
    }:obs:discovery-archive`;
    let originalPlannerResults: string[] = [];
    const plannerRegistry = createProviderRegistry();
    plannerRegistry.register({
      name: "planner-discovery-fixture",
      supportsStreaming: false,
      complete(messages) {
        originalPlannerResults = messages.filter(({ role }) => role === "tool")
          .map(({ content }) => String(content));
        switch (originalPlannerResults.length) {
          case 0:
            return Promise.resolve(
              call("sentinel_shared_asset_discoveries", { id: proposal.id }),
            );
          case 1:
            return Promise.resolve(
              call("sentinel_shared_asset_discoveries", {}),
            );
          case 2: {
            const { nextAfter } = JSON.parse(originalPlannerResults[1]);
            assert(nextAfter);
            return Promise.resolve(
              call("sentinel_shared_asset_discoveries", { after: nextAfter }),
            );
          }
          default:
            return Promise.resolve({ content: "[]", usage, toolCalls: [] });
        }
      },
    });
    plannerRegistry.setDefault("planner-discovery-fixture");
    const plannerReader = createSentinelSubagent({
      providerRegistry: plannerRegistry,
      snapshotPath: consumerPath,
      assessmentRevision: destination.revision,
      plannerExecutionEvidenceRunId: destination.plan.runId,
      sharedInventoryBaseDir: baseDir,
      allowModelAccess: true,
      hookRunner: {
        evaluateHook: () =>
          Promise.resolve({
            allowed: true,
            action: "ALLOW",
            duration: 0,
            ruleId: null,
          }),
      },
    });
    const plannerJournal = openSentinelAdaptiveStore(
      join(dirname(consumerPath), "sentinel-adaptive.db"),
      () => Date.now() + 120_000,
    );
    try {
      assertEquals(plannerJournal.claimModelPlan(plannerIdentity), 1);
      assert(plannerJournal.recordModelPlanInputManifest(plannerIdentity, 1, {
        promptSha256: "a".repeat(64),
        hintIds: [],
        findingReviewIds: [],
        incidentReviewIds: [],
        incidentCandidateIds: [],
        investigationIds: [],
        inventoryNodeIds: [],
        workerObservations: [],
      }));
      await plannerReader.execute(
        "Read the approved peer discovery.",
        () => {},
        undefined,
        (step) => {
          assert(
            (step.sharedAssetDiscovery || step.discoveryPage) &&
              step.goalReceiptRead,
          );
          assert(plannerJournal.recordModelPlanRead(plannerIdentity, 1, step));
        },
      );
      plannerJournal.completeModelPlan(
        plannerIdentity,
        1,
        "no_new_assignments",
      );
    } finally {
      plannerJournal.close();
    }
    assertEquals(originalPlannerResults.length, 3);
    assertEquals(
      JSON.parse(originalPlannerResults[0]).discovery.id,
      proposal.id,
    );
    assertEquals(JSON.parse(originalPlannerResults[1]).discoveries.length, 5);
    assert(JSON.parse(originalPlannerResults[2]).discoveries.length > 0);

    // This approval is opened only by an interrupted worker, so an archive
    // built from completed reviews cannot accidentally include its source.
    assert(interruptedDiscoveryId && interruptedDiscoveryId !== proposal.id);
    const interruptedReason = "Reopen the approval before interruption";
    const interruptedJournal = openSentinelAdaptiveStore(
      join(dirname(consumerPath), "sentinel-adaptive.db"),
    );
    const revision = adaptiveRevision(destination);
    let interruptedTaskId: string;
    let interruptedResult: string | undefined;
    try {
      const queued = interruptedJournal.sync(revision, [{
        kind: "trace",
        nodeId: "local-a",
        depth: 7,
        reason: interruptedReason,
      }], revision).find(({ reason }) => reason === interruptedReason);
      assert(queued);
      const skipped = new Set(
        interruptedJournal.list(revision).filter(({ id }) => id !== queued.id)
          .map(({ id }) => id),
      );
      const claim = interruptedJournal.claim(revision, 60, skipped);
      assert(claim && claim.task.id === queued.id);
      assert(interruptedJournal.complete({
        taskId: queued.id,
        leaseToken: claim.leaseToken,
        observation: {},
      }));
      const lease = interruptedJournal.claimModelReview(
        revision,
        interruptedReason,
        ({ id }) => id === queued.id,
      );
      assert(lease);
      interruptedTaskId = lease.task.id;
      const registry = createProviderRegistry();
      registry.register({
        name: "interrupted-discovery",
        supportsStreaming: false,
        complete(messages) {
          const result = messages.findLast(({ role }) => role === "tool");
          if (!result) {
            return Promise.resolve(call("sentinel_shared_asset_discoveries", {
              id: interruptedDiscoveryId,
            }));
          }
          interruptedResult = String(result.content);
          throw new Error("Interrupt before recording a final worker response");
        },
      });
      registry.setDefault("interrupted-discovery");
      const worker = createSentinelSubagent({
        snapshotPath: consumerPath,
        assessmentRevision: destination.revision,
        assignedTaskId: interruptedTaskId,
        assignedTaskLeaseToken: lease.token,
        providerRegistry: registry,
        hookRunner: hooks,
        allowModelAccess: true,
        readSharedAssetDiscoveries: ({ evidenceRevision, signal, id, after }) =>
          readSentinelSharedAssetDiscoveries(
            consumerPath,
            { taskId: interruptedTaskId, token: lease.token, evidenceRevision },
            id,
            signal,
            after,
          ),
      });
      await worker.execute(
        "Reopen the approved topology.",
        () => {},
        undefined,
        (step) => {
          assertEquals(step.sharedAssetDiscovery?.id, interruptedDiscoveryId);
          assert(step.goalReceiptRead);
          assert(interruptedJournal.recordModelReviewProgress(
            revision,
            interruptedTaskId,
            lease.token,
            [step],
          ));
        },
        undefined,
        { workerBoundary: () => Promise.resolve({}) },
      );
      assertEquals(
        JSON.parse(interruptedResult ?? "").discovery.id,
        interruptedDiscoveryId,
      );
      assert(
        !interruptedJournal.modelReviewNotes(revision).some(
          ({ taskId }) => taskId === interruptedTaskId,
        ),
      );
    } finally {
      interruptedJournal.close();
    }

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
    const nextRunId = next.plan.runId;
    assert(nextRunId);
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
    let selectedStep = index;
    let selectedTask = followUp.reviewedFrom;
    let selectedSource: {
      sourceCase: string;
      snapshotDigest: string;
      evidenceId: string;
    } | undefined;
    let selectPlanner = 0;
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
        if (selectPlanner) {
          return Promise.resolve(call("operator_runs", {
            action: "planner_reads",
            kind: "sentinel",
            id: "consumer",
            revision: destination.revision,
            plannerIdentity,
            attempt: 1,
            ordinal: selectPlanner,
            includeResult: true,
          }));
        }
        return Promise.resolve(call("operator_runs", {
          action: selectedSource
            ? "worker_trace_source"
            : "worker_trace_result",
          kind: "sentinel",
          id: "consumer",
          revision: destination.revision,
          taskId: selectedTask,
          stepIndices: [selectedStep],
          ...selectedSource,
        }));
      },
    });
    registry.setDefault("discovery-trace-fixture");
    let deny: boolean | "pre" = false;
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
          const deniedHook = deny === "pre"
            ? "PRE_TOOL_CALL"
            : "POST_TOOL_RESPONSE";
          const allowed = !(deny && hook === deniedHook &&
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
    assertEquals(consumedPages.length, 2);
    const pageSteps = view.modelReviews.find(({ taskId }) =>
      taskId === followUp.reviewedFrom
    )!
      .steps.flatMap((step, index) => step.discoveryPage ? [index] : []);
    assertEquals(pageSteps.length, 2);
    for (const [position, step] of pageSteps.entries()) {
      selectedStep = step;
      await chat.executeAgentTurn("Open an original discovery page.", () => {});
      assertEquals(
        JSON.parse(reopened ?? "").result,
        JSON.parse(consumedPages[position]),
      );
    }
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
      runId: nextRunId,
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
    selectedStep = index;
    await chat.executeAgentTurn("Open the restored discovery.", () => {});
    assertEquals(
      JSON.parse(reopened ?? "").result,
      JSON.parse(consumedResponse),
    );
    for (const [position, step] of pageSteps.entries()) {
      selectedStep = step;
      await chat.executeAgentTurn(
        "Open a page from the restored worker trace.",
        () => {},
      );
      assertEquals(
        JSON.parse(reopened ?? "").result,
        JSON.parse(consumedPages[position]),
      );
    }
    for (const [index, result] of originalPlannerResults.entries()) {
      selectPlanner = index + 1;
      await chat.executeAgentTurn(
        "Open the restored planner discovery.",
        () => {},
      );
      assertEquals(JSON.stringify(JSON.parse(reopened ?? "").result), result);
      deny = true;
      await chat.executeAgentTurn(
        "Open the restored planner discovery again.",
        () => {},
      );
      assert(reopened?.includes("unavailable"));
      deny = false;
    }
    selectPlanner = 0;
    selectedTask = interruptedTaskId;
    selectedStep = 0;
    const token = crypto.randomUUID();
    const gateway = createGatewayServer({ port: 0, token, chatSession: chat });
    const { port } = await gateway.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chat?token=${token}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      const original = JSON.parse(interruptedResult ?? "");
      const source = {
        sourceCase: original.discovery.sourceCaseId,
        snapshotDigest: original.discovery.sourceDigest,
        evidenceId: original.discovery.claim.evidenceId,
      };
      for (
        const { lookup, refusal } of [
          { lookup: "result" },
          { lookup: "source" },
          { lookup: "source", refusal: "pre" },
          { lookup: "source", refusal: "response" },
          { lookup: "source", refusal: "evidence" },
          { lookup: "source", refusal: "digest" },
          { lookup: "source", refusal: "constraint" },
          { lookup: "result", refusal: "constraint" },
        ] as const
      ) {
        selectedSource = lookup === "source"
          ? {
            ...source,
            ...(refusal === "evidence" && { evidenceId: "unrelated" }),
            ...(refusal === "digest" && { snapshotDigest: "0".repeat(64) }),
          }
          : undefined;
        deny = refusal === "pre" ? "pre" : refusal === "response";
        if (refusal === "constraint" && lookup === "source") {
          const constraint = recordSentinelOperatingConstraints(consumerPath, {
            runId: nextRunId,
            evidenceRevision: next.revision,
            expectedVersion: 0,
            requestId: crypto.randomUUID(),
            operatorScope: "asset-discovery-fixture",
            constraints: { deniedKinds: [], allowedAssetIds: ["local-a"] },
          });
          assert(constraint, "Narrow the restored run to the assigned asset");
        }
        const done = Promise.withResolvers<void>();
        const timeout = setTimeout(
          () => done.reject(new Error("Archived discovery lookup timed out")),
          3000,
        );
        const receive = ({ data }: MessageEvent) => {
          const event = JSON.parse(data);
          if (event.type === "response") done.resolve();
          if (event.type === "error") done.reject(new Error(event.message));
        };
        ws.addEventListener("message", receive);
        try {
          ws.send(JSON.stringify({
            type: "message",
            content: "Open a discovery from the interrupted assignment.",
          }));
          await done.promise;
        } finally {
          clearTimeout(timeout);
          ws.removeEventListener("message", receive);
        }
        if (refusal) assert(reopened?.includes("unavailable"));
        else if (lookup === "source") {
          assertEquals(JSON.parse(reopened ?? "").source, {
            caseId: source.sourceCase,
            evidenceRevision: original.discovery.evidenceRevision,
            snapshotDigest: source.snapshotDigest,
            sourceAssignmentId: original.discovery.taskId,
            discoveryId: interruptedDiscoveryId,
            approvalVersion: original.discovery.version,
            evidence: {
              id: "record",
              kind: "evidence",
              label: "Exact observed topology",
            },
          });
        } else {
          assertEquals(JSON.parse(reopened ?? "").result, original);
        }
      }
    } finally {
      ws.close();
      await gateway.stop();
    }
    deny = false;
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
