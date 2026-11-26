import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { HookRunner } from "../../src/core/policy/hooks/hooks.ts";
import {
  addSentinelCaseHint,
  advanceAdaptiveSentinel,
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../src/gateway/sentinel_agent.ts";
import { createSentinelRepositoryVisibilityReader } from "../../src/gateway/sentinel_repository_visibility.ts";
import {
  adaptiveRevision,
  MODEL_ASSIGNMENT_REASON,
} from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import { startSentinelAssessment } from "../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";
import {
  projectRepositoryVisibility,
  SENTINEL_LIVE_REPOSITORY_VISIBILITY,
  SENTINEL_SAVED_REPOSITORY_VISIBILITY,
} from "../../src/sentinel/github_repository_visibility.ts";

const usage = { inputTokens: 1, outputTokens: 1 };
const tool = SENTINEL_LIVE_REPOSITORY_VISIBILITY;
const callTool = () => ({
  usage,
  content: "",
  toolCalls: [{
    type: "function" as const,
    id: "visibility-call",
    function: { name: tool, arguments: "{}" },
  }],
});
const completed = {
  usage,
  content:
    '{"summary":"Checked the approved repository visibility.","followUps":[]}',
  toolCalls: [],
};

async function waitFor(
  condition: () => boolean,
  label: string,
  timeout = 5_000,
  advance?: () => void,
) {
  const deadline = performance.now() + timeout;
  while (!condition() && performance.now() < deadline) {
    advance?.();
    await new Promise((resolve) => setTimeout(resolve, advance ? 100 : 10));
  }
  assert(condition(), label);
}

Deno.test("Leased Sentinel repository visibility uses exact destination hooks and resumes the saved result", async () => {
  const baseDir = await Deno.makeTempDir();
  const caseId = "repository-visibility-fixture";
  const path = resolveSentinelCasePath(baseDir, caseId);
  const databasePath = join(dirname(path), "sentinel-adaptive.db");
  const repository = "fixture/approved";
  const repositoryId = 127;
  const credentialRef = crypto.randomUUID();
  const token = "synthetic-repository-credential-never-persisted";
  const publishedAt = "2026-05-01T04:03:02.001Z";
  let initial: string | undefined;
  const releaseFirst = Promise.withResolvers<void>();
  let active: ReturnType<typeof createSentinelModelPlanner> | undefined;
  let fetches = 0;
  let secretLookups = 0;
  let availableCredential = true;
  let denyDestination = false;
  let denyResponse = false;
  let denyEgress = false;
  const initialFrames: string[] = [];
  let requests = 0;
  let modelResumed: string | undefined;
  let phase: "initial" | "revoked" | "resume" = "initial";
  const stages: string[] = [];
  const expectedRefs: (string | undefined)[] = [];
  const hooks: HookRunner = {
    evaluateHook(hook, { input, auditInput }) {
      if (
        hook === "PRE_OUTPUT" &&
        typeof input.content === "string" && input.content.includes(repository)
      ) {
        assertEquals(input.target_classification, "INTERNAL");
        assert(!Object.hasOwn(auditInput ?? {}, "content"));
        stages.push("output");
        if (denyEgress) {
          return Promise.resolve({
            allowed: false,
            action: "BLOCK",
            ruleId: null,
            duration: 0,
          });
        }
      }
      const name = input.tool_name ??
        (input.tool_call as { name?: string } | undefined)?.name;
      if (name !== tool) {
        return Promise.resolve({
          allowed: true,
          action: "ALLOW",
          ruleId: null,
          duration: 0,
        });
      }
      const destination = hook === "PRE_TOOL_CALL" &&
        typeof input.url === "string";
      if (destination) {
        assertStringIncludes(String(input.url), "/repos/fixture/approved");
        assertEquals(input.sentinel_case_id, caseId);
        assertEquals(input.repository_id, repositoryId);
        stages.push("destination");
      } else if (hook === "PRE_TOOL_CALL") {
        stages.push("pre");
      }
      if (hook === "POST_TOOL_RESPONSE") {
        assert(!Object.hasOwn(auditInput ?? {}, "tool_response"));
        if (String(input.tool_response).startsWith("{")) {
          const result = JSON.parse(String(input.tool_response));
          assertEquals(result._classification, "INTERNAL");
          assert(!String(input.tool_response).includes(credentialRef));
          stages.push("post");
        }
      }
      const allowed = !(destination && denyDestination) &&
        !(hook === "POST_TOOL_RESPONSE" && denyResponse);
      return Promise.resolve({
        allowed,
        action: allowed ? "ALLOW" : "BLOCK",
        ruleId: null,
        duration: 0,
      });
    },
  };
  const reader = createSentinelRepositoryVisibilityReader({
    scopes: [{
      case: caseId,
      asset: "app",
      owner: "fixture",
      repo: "approved",
      repository_id: repositoryId,
    }],
    resolveCredential(expectedRef) {
      secretLookups++;
      expectedRefs.push(expectedRef);
      return Promise.resolve(
        availableCredential ? { token, ref: credentialRef } : undefined,
      );
    },
    ssrfChecker: () => Promise.resolve({ ok: true, value: "192.0.2.1" }),
    readVisibility(request, options) {
      assertEquals({
        ...request,
        owner: request.owner.toLowerCase(),
        repo: request.repo.toLowerCase(),
      }, {
        owner: "fixture",
        repo: "approved",
        repositoryId,
      });
      assertEquals(options.token, token);
      fetches++;
      return Promise.resolve("public");
    },
    now: () => new Date(publishedAt),
  });

  try {
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [
          { id: "app", kind: "asset", label: "Approved application" },
          { id: "other", kind: "asset", label: "Unapproved application" },
        ],
        edges: [],
      }),
    );
    const state = startSentinelAssessment(path);
    const revision = adaptiveRevision(state);
    const seed = (asset: string, depth: number) => {
      advanceAdaptiveSentinel(path, state);
      const store = openSentinelAdaptiveStore(databasePath);
      try {
        const task = store.sync(revision, [{
          kind: "trace",
          nodeId: asset,
          depth,
          reason: MODEL_ASSIGNMENT_REASON,
        }], revision).find((task) =>
          task.nodeId === asset && task.depth === depth
        );
        assert(task);
        return task.id;
      } finally {
        store.close();
      }
    };
    const suppressedTurn = async (asset: string, depth: number) => {
      const taskId = seed(asset, depth);
      advanceAdaptiveSentinel(path, state);
      const store = openSentinelAdaptiveStore(databasePath);
      try {
        const lease = store.claimModelReview(
          revision,
          MODEL_ASSIGNMENT_REASON,
          ({ id }) => id === taskId,
        );
        assert(lease);
        const model = createProviderRegistry();
        let result: string | undefined;
        model.register({
          name: "suppressed-visibility",
          supportsStreaming: false,
          complete(messages) {
            result = messages.findLast(({ role }) => role === "tool")
              ?.content as string | undefined;
            return Promise.resolve(
              result === undefined ? callTool() : completed,
            );
          },
        });
        model.setDefault("suppressed-visibility");
        const worker = createSentinelSubagent({
          snapshotPath: path,
          assessmentRevision: state.revision,
          assignedTaskId: taskId,
          assignedTaskLeaseToken: lease.token,
          providerRegistry: model,
          hookRunner: hooks,
          readRepositoryVisibility: reader,
          allowModelAccess: true,
        });
        try {
          await worker.execute(
            "Read the assigned repository visibility.",
            () => {},
          );
        } finally {
          worker.clear();
        }
        assert(typeof result === "string");
        assertStringIncludes(result, denyResponse ? "withheld" : "Error:");
        assert(!result.includes(repository));
        assert(
          store.finishModelReview(
            revision,
            taskId,
            lease.token,
            { note: "Policy result retained.", steps: [] },
          ),
        );
      } finally {
        store.close();
      }
    };
    await suppressedTurn("other", 1);
    assertEquals(secretLookups, 0);
    assertEquals(fetches, 0);
    assert(!stages.includes("destination"));
    denyDestination = true;
    await suppressedTurn("app", 2);
    denyDestination = false;
    assert(stages.includes("destination"));
    assertEquals(secretLookups, 0);
    assertEquals(fetches, 0);
    denyResponse = true;
    await suppressedTurn("app", 3);
    denyResponse = false;
    assertEquals(fetches, 1);
    assert(stages.includes("post"));
    stages.length = 0;
    expectedRefs.length = 0;
    secretLookups = 0;
    fetches = 0;

    const taskId = seed("app", 4);
    advanceAdaptiveSentinel(path, state);
    const model = createProviderRegistry();
    model.register({
      name: "durable-repository-visibility",
      supportsStreaming: false,
      async complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (!result) {
          if (phase !== "initial") return completed;
          requests++;
          return callTool();
        }
        assertEquals(phase !== "revoked", true);
        if (phase === "initial") {
          initial = String(result.content);
          await releaseFirst.promise;
        } else {
          modelResumed = String(result.content);
        }
        return completed;
      },
    });
    model.setDefault("durable-repository-visibility");
    const startWorker = () => {
      const coordinator = createSentinelModelPlanner(
        path,
        (current, assignment, lease) => {
          if (assignment !== taskId) {
            return { execute: () => Promise.resolve(), clear() {} };
          }
          const worker = createSentinelSubagent({
            snapshotPath: path,
            assessmentRevision: current.revision,
            assignedTaskId: assignment,
            assignedTaskLeaseToken: lease,
            providerRegistry: model,
            hookRunner: hooks,
            readRepositoryVisibility: reader,
            allowModelAccess: true,
          });
          return {
            ...worker,
            execute(prompt, send, ...options) {
              return worker.execute(prompt, (event) => {
                if (phase === "initial") {
                  initialFrames.push(JSON.stringify(event));
                }
                return send(event);
              }, ...options);
            },
          };
        },
        () => () => {},
      );
      coordinator.advance(state);
      return coordinator;
    };
    const retained = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return db.prepare(
          "SELECT revision, evidenceRevision, receipt FROM adaptive_repository_visibility_results WHERE taskId = ?",
        ).get(taskId);
      } finally {
        db.close();
      }
    };
    denyEgress = true;
    active = startWorker();
    await waitFor(
      () => initial !== undefined,
      "initial model must receive the result",
    );
    assert(initial);
    const row = retained();
    assert(row);
    assertEquals(row.revision, revision);
    assertEquals(row.evidenceRevision, state.revision);
    const receipt = {
      repository,
      repositoryId,
      visibility: "public" as const,
      observedAt: publishedAt,
      evidenceRevision: state.revision,
      credentialRef,
    };
    assertEquals(JSON.parse(String(row.receipt)), receipt);
    assertEquals(
      JSON.parse(initial),
      projectRepositoryVisibility(receipt, taskId, "app"),
    );
    assert(
      !new TextDecoder().decode(await Deno.readFile(databasePath)).includes(
        token,
      ),
    );
    assertEquals(fetches, 1);
    assertEquals(requests, 1);
    assert(stages.indexOf("pre") < stages.indexOf("destination"));
    assert(stages.indexOf("destination") < stages.indexOf("post"));
    assert(stages.indexOf("post") < stages.indexOf("output"));
    assert(initialFrames.some((frame) => frame.includes("llm_start")));
    assert(initialFrames.every((frame) => !frame.includes(repository)));
    denyEgress = false;

    active.stop();
    releaseFirst.resolve();
    await waitFor(() => !active?.hasInFlightWork(), "old worker must be gone");
    phase = "revoked";
    availableCredential = false;
    const secretChecksBeforeRevocation = secretLookups;
    active = startWorker();
    await waitFor(
      () => secretLookups > secretChecksBeforeRevocation,
      "restarted worker must recheck the retained credential",
      20_000,
    );
    await waitFor(
      () => !active?.hasInFlightWork(),
      "revoked worker must release",
    );
    assertEquals(modelResumed, undefined);
    assertEquals(fetches, 1);
    assertEquals(expectedRefs.at(-1), credentialRef);
    active.stop();
    phase = "resume";
    availableCredential = true;
    active = startWorker();
    await waitFor(
      () => modelResumed !== undefined,
      "authorized restarted worker must receive the exact saved result",
      20_000,
      () => active?.advance(state),
    );
    assertEquals(modelResumed, initial);
    assertEquals(fetches, 1);
    assertEquals(requests, 1);
    assertEquals(retained(), row);
    await waitFor(
      () =>
        !!readAdaptiveSentinel(path, state, "revision")?.modelReviews.some((
          { taskId: id },
        ) => id === taskId),
      "resumed model review must commit",
    );
    active.stop();
    await waitFor(
      () => !active?.hasInFlightWork(),
      "source coordinator must stop",
    );
    let denySavedResponse = true;
    let plannerOpened: string | undefined;
    const runId = state.plan.runId;
    assert(runId);
    const planner = createProviderRegistry();
    planner.register({
      name: "saved-repository-visibility",
      supportsStreaming: false,
      complete(messages) {
        const result = messages.findLast(({ role }) => role === "tool");
        if (!result) {
          const prompt = String(
            messages.findLast(({ role }) => role === "user")?.content,
          );
          const inputs = JSON.parse(prompt.split("\n").at(-1)!);
          assert(
            inputs.repositoryVisibility.some((
              source: { taskId: string; assetId: string },
            ) => source.taskId === taskId && source.assetId === "app"),
          );
          return Promise.resolve({
            usage,
            content: "",
            toolCalls: [{
              type: "function",
              id: "open-saved-repository-visibility",
              function: {
                name: SENTINEL_SAVED_REPOSITORY_VISIBILITY,
                arguments: JSON.stringify({ taskId, asset: "app" }),
              },
            }],
          });
        }
        plannerOpened = String(result.content);
        return Promise.resolve({
          usage,
          content: JSON.stringify([{
            kind: "trace",
            nodeId: "app",
            depth: 1,
            repositoryVisibilityTaskId: taskId,
          }]),
          toolCalls: [],
        });
      },
    });
    planner.setDefault("saved-repository-visibility");
    let planningClock = Date.now() + 65_000;
    const readPlanner = () =>
      createSentinelModelPlanner(
        path,
        (current, assignment) =>
          assignment
            ? { execute: () => Promise.resolve(), clear() {} }
            : createSentinelSubagent({
              snapshotPath: path,
              assessmentRevision: current.revision,
              plannerExecutionEvidenceRunId: runId,
              providerRegistry: planner,
              hookRunner: {
                evaluateHook(hook, context) {
                  if (
                    denySavedResponse && hook === "POST_TOOL_RESPONSE" &&
                    context.input.tool_name ===
                      SENTINEL_SAVED_REPOSITORY_VISIBILITY
                  ) {
                    return Promise.resolve({
                      allowed: false,
                      action: "BLOCK",
                      ruleId: null,
                      duration: 0,
                    });
                  }
                  return hooks.evaluateHook(hook, context);
                },
              },
              readRepositoryVisibility: reader,
              allowModelAccess: true,
            }),
        undefined,
        () => planningClock,
      );
    const followup = () =>
      readAdaptiveSentinel(path, state, "revision")?.tasks
        .find(({ plannerRound }) =>
          plannerRound?.repositoryVisibility?.taskId === taskId
        );
    addSentinelCaseHint(path, "Review the exact saved repository status.");
    active = readPlanner();
    active.advance(state);
    await waitFor(
      () => !!plannerOpened && !active?.hasInFlightWork(),
      "planner must receive the saved response policy denial",
    );
    assertStringIncludes(plannerOpened!, "withheld");
    assertEquals(followup(), undefined);
    assertEquals(fetches, 1);
    active.stop();

    denySavedResponse = false;
    plannerOpened = undefined;
    planningClock += 65_000;
    addSentinelCaseHint(
      path,
      "Reconsider the exact retained repository receipt.",
    );
    active = readPlanner();
    active.advance(state);
    await waitFor(
      () => !!followup(),
      "authorized planner must schedule a citable follow-up",
    );
    const reference = {
      taskId,
      sourceStepIndex: 0,
      resultSha256: createHash("sha256").update(initial).digest("hex"),
    };
    assertEquals(JSON.parse(plannerOpened!), {
      ...JSON.parse(initial),
      reference,
    });
    assertEquals(followup()?.nodeId, "app");
    assertEquals(followup()?.plannerRound?.repositoryVisibility, reference);
    assertEquals(fetches, 1);
  } finally {
    active?.stop();
    releaseFirst.resolve();
    await waitFor(() => !active?.hasInFlightWork(), "worker must close");
    await Deno.remove(baseDir, { recursive: true });
  }
});
