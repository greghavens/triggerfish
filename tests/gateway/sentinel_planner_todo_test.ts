import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { createProviderRegistry } from "../../src/agent/llm.ts";
import type { ChatEvent } from "../../src/core/types/chat_event.ts";
import { advanceAdaptiveSentinel } from "../../src/gateway/sentinel_adaptive_runtime.ts";
import {
  createSentinelAgent,
  createSentinelSubagent,
  type SentinelAgentOptions,
} from "../../src/gateway/sentinel_agent.ts";
import { MODEL_ASSIGNMENT_REASON } from "../../src/sentinel/adaptive_planner.ts";
import { openSentinelAdaptiveStore } from "../../src/sentinel/adaptive_store.ts";
import {
  readSentinelAssessment,
  refreshSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { captureStoppedSentinelCaseArtifacts } from "../../src/sentinel/case_archive_capture.ts";
import { resolveSentinelCasePath } from "../../src/sentinel/cases.ts";

const todo = {
  id: "review-control",
  content: "Review the saved control evidence.",
  status: "in_progress",
  priority: "high",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

async function runTodoTurn(
  options: Omit<
    SentinelAgentOptions,
    "providerRegistry" | "hookRunner" | "allowModelAccess"
  >,
  action: "todo_read" | "todo_write" | undefined,
  flags: {
    readonly interactive?: boolean;
    readonly blockWrite?: boolean;
    readonly blockResult?: boolean;
    readonly blockOutput?: boolean;
  } = {},
) {
  const registry = createProviderRegistry();
  const hooks: string[] = [];
  const offered = new Set<string>();
  const frames: string[] = [];
  const events: ChatEvent[] = [];
  let emitted = false;
  registry.register({
    name: "sentinel-todo-fixture",
    supportsStreaming: false,
    complete(messages, tools) {
      for (const item of tools) {
        const name = (item as { function?: { name?: string } }).function?.name;
        if (name) offered.add(name);
      }
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (!emitted && action) {
        emitted = true;
        return Promise.resolve({
          content: "",
          usage,
          toolCalls: [{
            id: crypto.randomUUID(),
            type: "function",
            function: {
              name: action,
              arguments: JSON.stringify(
                action === "todo_write" ? { todos: [todo] } : {},
              ),
            },
          }],
        });
      }
      frames.push(
        ...messages.filter(({ role }) => role === "tool").map(({ content }) =>
          String(content)
        ),
      );
      return Promise.resolve({
        content: "The planner's checklist response.",
        usage,
        toolCalls: [],
      });
    },
  });
  registry.setDefault("sentinel-todo-fixture");
  const factory = flags.interactive
    ? createSentinelAgent
    : createSentinelSubagent;
  const agent = factory({
    ...options,
    providerRegistry: registry,
    allowModelAccess: true,
    hookRunner: {
      evaluateHook(hook, { input, auditInput, session }) {
        const tool = input.tool_name ??
          (input.tool_call as { name?: string } | undefined)?.name;
        if (tool === action && action) {
          assertEquals(session.taint, "INTERNAL");
          assertEquals(input.evidence_revision, options.assessmentRevision);
          assertEquals(input.resource_classification, "INTERNAL");
          assertEquals(
            input.operation_type,
            action === "todo_write" ? "write" : "read",
          );
          assert(typeof input.case_id === "string");
          assert(!JSON.stringify(auditInput).includes(todo.content));
          hooks.push(hook);
        } else if (hook === "PRE_OUTPUT") hooks.push(hook);
        const allowed = !(
          (hook === "PRE_TOOL_CALL" && tool === "todo_write" &&
            flags.blockWrite) ||
          (hook === "POST_TOOL_RESPONSE" && tool === action &&
            flags.blockResult) ||
          (hook === "PRE_OUTPUT" && flags.blockOutput)
        );
        return Promise.resolve({
          allowed,
          action: allowed ? "ALLOW" : "BLOCK",
          duration: 0,
          ruleId: null,
        });
      },
    },
  });
  try {
    await agent.execute(
      "Use the Sentinel planner checklist.",
      (event) => events.push(event),
    );
    return { offered, frames, hooks, events };
  } finally {
    agent.clear();
  }
}

Deno.test("Sentinel planner todos persist through root policy and remain scoped to case and evidence revision", async () => {
  const base = await Deno.makeTempDir();
  try {
    const startCase = async (id: string) => {
      const path = resolveSentinelCasePath(base, id);
      await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          version: 1,
          nodes: [{ id: "app", kind: "asset", label: "Application" }],
          edges: [],
        }),
        { mode: 0o600 },
      );
      const state = startSentinelAssessment(path);
      assert(state.plan.runId);
      advanceAdaptiveSentinel(path, state);
      return {
        snapshotPath: path,
        assessmentRevision: state.revision,
        plannerExecutionEvidenceRunId: state.plan.runId,
      };
    };

    const first = await startCase("planner-todo-main");
    const other = await startCase("planner-todo-other");
    const denied = await runTodoTurn(first, "todo_write", { blockWrite: true });
    assertEquals(denied.hooks, ["PRE_TOOL_CALL", "PRE_OUTPUT"]);
    const empty = await runTodoTurn(first, "todo_read");
    assertEquals(JSON.parse(empty.frames[0]).todos, []);

    const written = await runTodoTurn(first, "todo_write");
    assert(
      written.offered.has("todo_write") && written.offered.has("todo_read"),
    );
    assertEquals(written.hooks, [
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_OUTPUT",
    ]);
    assertEquals(JSON.parse(written.frames[0]), {
      _classification: "INTERNAL",
      todos: [todo],
    });
    const reopened = await runTodoTurn(first, "todo_read");
    assertEquals(JSON.parse(reopened.frames[0]).todos, [todo]);
    const withheld = await runTodoTurn(first, "todo_read", {
      blockResult: true,
      blockOutput: true,
    });
    assertEquals(withheld.hooks, [
      "PRE_TOOL_CALL",
      "POST_TOOL_RESPONSE",
      "PRE_OUTPUT",
    ]);
    assertStringIncludes(withheld.frames[0], "withheld by policy");
    assert(!withheld.events.some((event) => event.type === "response"));
    assertEquals(
      JSON.parse((await runTodoTurn(other, "todo_read")).frames[0]).todos,
      [],
    );

    const interactive = await runTodoTurn(first, undefined, {
      interactive: true,
    });
    assert(
      !interactive.offered.has("todo_write") &&
        !interactive.offered.has("todo_read"),
    );
    const unassigned = await runTodoTurn({
      snapshotPath: first.snapshotPath,
      assessmentRevision: first.assessmentRevision,
    }, undefined);
    assert(
      !unassigned.offered.has("todo_write") &&
        !unassigned.offered.has("todo_read"),
    );
    const store = openSentinelAdaptiveStore(
      join(dirname(first.snapshotPath), "sentinel-adaptive.db"),
    );
    const lease = (() => {
      try {
        const revision = store.activeRevision();
        assert(revision);
        store.sync(revision, [{
          kind: "impact",
          nodeId: "app",
          reason: MODEL_ASSIGNMENT_REASON,
        }], revision);
        advanceAdaptiveSentinel(
          first.snapshotPath,
          readSentinelAssessment(first.snapshotPath)!,
        );
        return store.claimModelReview(revision, MODEL_ASSIGNMENT_REASON);
      } finally {
        store.close();
      }
    })();
    assert(lease);
    const worker = await runTodoTurn({
      ...first,
      assignedTaskId: lease.task.id,
      assignedTaskLeaseToken: lease.token,
    }, undefined);
    assert(worker.offered.has("sentinel_assigned_target"));
    assert(
      !worker.offered.has("todo_read") && !worker.offered.has("todo_write"),
    );

    await Deno.writeTextFile(
      first.snapshotPath,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "app", kind: "asset", label: "Updated application" }],
        edges: [],
      }),
    );
    const refreshed = refreshSentinelAssessment(first.snapshotPath);
    assert(refreshed && refreshed.revision > first.assessmentRevision);
    advanceAdaptiveSentinel(first.snapshotPath, refreshed);
    const current = await runTodoTurn({
      ...first,
      assessmentRevision: refreshed.revision,
    }, "todo_read");
    assertEquals(JSON.parse(current.frames[0]).todos, []);
    const stale = await runTodoTurn(first, "todo_write");
    assert(!stale.frames.join("").includes(todo.content));
    const afterStale = await runTodoTurn({
      ...first,
      assessmentRevision: refreshed.revision,
    }, "todo_read");
    assertEquals(JSON.parse(afterStale.frames[0]).todos, []);

    assert(stopSentinelAssessment(first.snapshotPath));
    const staging = await Deno.makeTempDir({ dir: base });
    const staged = captureStoppedSentinelCaseArtifacts(base, {
      caseId: "planner-todo-main",
      runId: first.plannerExecutionEvidenceRunId,
      evidenceRevision: refreshed.revision,
    }, staging);
    const archive = new DatabaseSync(
      join(staged.directory, "sentinel-adaptive.db"),
      { readOnly: true },
    );
    try {
      const stored = archive.prepare(`SELECT todos FROM adaptive_planner_todos
        WHERE evidenceRevision = ? AND runId = ?`).get(
        first.assessmentRevision,
        first.plannerExecutionEvidenceRunId,
      );
      assertEquals(JSON.parse(String(stored?.todos)), [todo]);
    } finally {
      archive.close();
    }
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
