import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  type ExecutionTraceScope,
  openExecutionTraces,
} from "../../src/core/execution_traces.ts";

const scope: ExecutionTraceScope = {
  role: "delegated",
  runId: "delegated:trusted-run",
  sessionId: "child-session",
  sourceId: "parent-session",
  classification: "INTERNAL",
};
const tool = {
  tool: "fixture_read",
  classification: "INTERNAL",
  outcome: "returned",
} as const;

Deno.test("Trace journal admits exact scoped roles and reopens metadata-only steps across handles", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "execution-traces.db");
  let at = 1000;
  const first = openExecutionTraces(path, () => at);
  const other = openExecutionTraces(path, () => at);
  try {
    assertEquals(first.appendNext(scope, tool), undefined);
    const run = first.admit(scope);
    assert(run);
    assertEquals(run.status, "running");
    assertEquals(other.admit(scope), run);
    assertEquals(other.admit({ ...scope, sessionId: "unrelated" }), undefined);
    const offered = {
      ...tool,
      ordinal: 1,
      args: { secret: "dropped" },
      result: "also dropped",
    };
    const initial = first.append(scope, offered);
    assert(initial);
    assertEquals(other.append(scope, offered), initial);
    assertEquals(
      other.append(scope, { ...offered, outcome: "blocked" }),
      undefined,
    );
    assertEquals(
      other.appendNext({ ...scope, sourceId: "unrelated" }, tool),
      undefined,
    );
    const next = other.appendNext(scope, { ...tool, outcome: "blocked" });
    assert(next);
    assertEquals(next.ordinal, 2);
    assertEquals(next.outcome, "blocked");
    assertEquals(Object.keys(initial).sort(), [
      "classification",
      "id",
      "ordinal",
      "outcome",
      "recordedAt",
      "scope",
      "tool",
    ]);
    assertEquals(first.inspect(scope, 1, "PUBLIC"), undefined);
    assertEquals(first.inspect(scope, 1, "INTERNAL"), initial);
    const page = first.list(scope, { ceiling: "INTERNAL", limit: 1 });
    assert(page?.nextCursor);
    assertEquals(page.steps, [initial]);
    assertEquals(
      first.list(scope, { ceiling: "INTERNAL", cursor: page.nextCursor })
        ?.steps,
      [next],
    );
    const peer = {
      ...scope,
      role: "scheduled" as const,
      sessionId: "scheduler-session",
      sourceId: "cron:job",
    };
    assert(first.admit(peer));
    assertEquals(
      first.list(peer, { ceiling: "INTERNAL", cursor: page.nextCursor }),
      undefined,
    );
    assertEquals(
      first.list(scope, { ceiling: "INTERNAL", limit: 51 }),
      undefined,
    );
    at++;
    const finished = first.finish(scope, "completed");
    assert(finished);
    assertEquals(finished.status, "completed");
    assertEquals(finished.finishedAt, new Date(at).toISOString());
    assertEquals(other.finish(scope, "completed"), finished);
    assertEquals(other.finish(scope, "failed"), undefined);
    assertEquals(other.appendNext(scope, tool), undefined);
    assertEquals(other.append(scope, offered), initial);
    assertEquals(other.readRun(scope.role, scope.runId, "INTERNAL"), finished);
  } finally {
    other.close();
    first.close();
    const reopened = openExecutionTraces(path, () => at);
    try {
      assertEquals(
        reopened.readRun(scope.role, scope.runId, "INTERNAL")?.status,
        "completed",
      );
      assertEquals(
        reopened.list(scope, { ceiling: "INTERNAL" })?.steps.map((
          { ordinal },
        ) => ordinal),
        [1, 2],
      );
    } finally {
      reopened.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Trace reads enforce whole-run classification and keep discovery scope bounded", async () => {
  const dir = await Deno.makeTempDir();
  const store = openExecutionTraces(join(dir, "execution-traces.db"));
  try {
    const hidden = { ...scope, runId: "confidential-run" };
    assert(store.admit(hidden));
    assert(store.appendNext(hidden, tool));
    assert(
      store.appendNext(hidden, { ...tool, classification: "CONFIDENTIAL" }),
    );
    const visible = {
      ...scope,
      role: "scheduled" as const,
      runId: "scheduled-visible",
    };
    const newest = { ...visible, runId: "scheduled-newest" };
    assert(store.admit(visible));
    assert(store.admit(newest));
    assertEquals(
      store.readRun(hidden.role, hidden.runId, "INTERNAL"),
      undefined,
    );
    assertEquals(store.list(hidden, { ceiling: "INTERNAL" }), undefined);
    assertEquals(store.inspect(hidden, 1, "INTERNAL"), undefined);
    assertEquals(
      store.list(hidden, { ceiling: "CONFIDENTIAL" })?.steps.length,
      2,
    );
    const page = store.listRuns({
      role: "scheduled",
      ceiling: "INTERNAL",
      limit: 1,
    });
    assert(page?.nextCursor);
    assertEquals(page.runs[0].scope, newest);
    assertEquals(
      store.listRuns({
        role: "scheduled",
        ceiling: "INTERNAL",
        cursor: page.nextCursor,
      })?.runs.map(({ scope }) => scope),
      [visible],
    );
    assertEquals(
      store.listRuns({
        role: "delegated",
        ceiling: "INTERNAL",
        cursor: page.nextCursor,
      }),
      undefined,
    );
    assertEquals(
      store.listRuns({ role: "delegated", ceiling: "INTERNAL" })?.runs,
      [],
    );
    assertEquals(
      store.finish(visible, "failed", "RESTRICTED")?.classification,
      "RESTRICTED",
    );
    assertEquals(
      store.readRun(visible.role, visible.runId, "CONFIDENTIAL"),
      undefined,
    );
    assertEquals(
      store.readRun(visible.role, visible.runId, "RESTRICTED")?.status,
      "failed",
    );
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Approved workflow projection is isolated, exact, and migrates legacy receipts", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "execution-traces.db");
  try {
    const first = openExecutionTraces(path);
    assert(first.admit(scope));
    const legacy = first.appendNext(scope, tool);
    assert(legacy);
    first.close();

    const previous = new DatabaseSync(path);
    previous.exec(
      "DROP TABLE execution_trace_approved_payloads; PRAGMA user_version = 1;",
    );
    previous.close();

    const trace = openExecutionTraces(path);
    try {
      assertEquals(trace.inspect(scope, 1, "INTERNAL"), legacy);
      assertEquals(trace.readApprovedPayload(scope, 1, "INTERNAL"), undefined);
      const payload = {
        kind: "github_actions_status",
        repo: "acme/approved",
        repositoryId: 72451,
        workflow: "build.yml",
        perPage: 10,
        runs: [{ id: 17, status: "completed", conclusion: "success" }],
      } as const;
      const step = { ...tool, tool: "github_actions", ordinal: 2 } as const;
      assertEquals(
        trace.append(scope, { ...step, outcome: "blocked" }, payload),
        undefined,
      );
      assertEquals(
        trace.append(scope, { ...step, tool: "other" }, payload),
        undefined,
      );
      const malformed = { ...payload, raw: "unexpected raw text" };
      assertEquals(trace.append(scope, step, malformed), undefined);
      assertEquals(
        trace.append(scope, step, { ...payload, repositoryId: 0 }),
        undefined,
      );
      assertEquals(
        trace.append(scope, step, { ...payload, perPage: 101 }),
        undefined,
      );
      const accepted = trace.append(scope, step, payload);
      assert(accepted);
      assertEquals(trace.append(scope, step, payload), accepted);
      assertEquals(
        trace.append(scope, step, { ...payload, repositoryId: 72452 }),
        undefined,
      );
      assertEquals(
        trace.append(scope, step, { ...payload, workflow: "other.yml" }),
        undefined,
      );
      assertEquals(trace.append(scope, step), undefined);
      assertEquals(trace.readApprovedPayload(scope, 2, "INTERNAL"), payload);
      assertEquals(trace.readApprovedPayload(scope, 2, "PUBLIC"), undefined);
      assertEquals(
        trace.readApprovedPayload(
          { ...scope, sessionId: "unrelated" },
          2,
          "INTERNAL",
        ),
        undefined,
      );
      assertEquals(trace.readApprovedPayload(scope, 3, "INTERNAL"), undefined);
      assertEquals(trace.inspect(scope, 2, "INTERNAL"), accepted);
      const page = trace.list(scope, { ceiling: "INTERNAL" });
      assert(!JSON.stringify(page).includes(payload.repo));
      assert(!JSON.stringify(accepted).includes(payload.repo));
    } finally {
      trace.close();
    }
    const tamper = new DatabaseSync(path);
    tamper.exec(
      "UPDATE execution_trace_approved_payloads SET payload = replace(payload, 'acme/approved', 'acme/changed')",
    );
    tamper.close();
    const reopened = openExecutionTraces(path);
    try {
      assertEquals(
        reopened.readApprovedPayload(scope, 2, "INTERNAL"),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
