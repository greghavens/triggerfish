import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openAgentEventSchedule } from "../../src/scheduler/agent_events.ts";

Deno.test("Agent event cursors merge compatible queued work and preserve concurrency across reopen", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "events.db");
  let now = 300_000;
  let schedule = openAgentEventSchedule(path, () => now);
  try {
    assert(
      schedule.publish({
        kind: "finding",
        receipt: "historical",
        caseId: "main",
      }),
    );
    const spec = {
      id: "alerts",
      agent: "review",
      kinds: ["finding"],
      merge: "by_case",
      maxConcurrent: 1,
      enabled: true,
    };
    assertEquals(schedule.set(spec, 0)?.version, 1);
    assertEquals(schedule.claim(), undefined);
    now++;
    assert(
      schedule.publish({ kind: "finding", receipt: "first", caseId: "main" }),
    );
    assert(
      !schedule.publish({ kind: "finding", receipt: "first", caseId: "main" }),
    );
    const running = schedule.claim();
    assert(running);
    assertEquals(running.events.map(({ receipt }) => receipt), ["first"]);
    assert(
      schedule.publish({ kind: "finding", receipt: "second", caseId: "main" }),
    );
    assert(
      schedule.publish({ kind: "finding", receipt: "other", caseId: "peer" }),
    );
    assertEquals(schedule.claim(), undefined);
    assert(
      schedule.publish({ kind: "finding", receipt: "third", caseId: "main" }),
    );
    assertEquals(schedule.claim(), undefined);
    schedule.close();
    schedule = openAgentEventSchedule(path, () => now);
    assertEquals(schedule.claim(), undefined);
    assert(schedule.finish(running, "completed"));
    const merged = schedule.claim();
    assert(merged);
    assertEquals(merged.events.map(({ receipt }) => receipt), [
      "second",
      "third",
    ]);
    assertEquals(schedule.set({ ...spec, enabled: false }, 0), undefined);
    assertEquals(schedule.set({ ...spec, enabled: false }, 1)?.version, 2);
    assert(!schedule.current(merged));
    assert(!schedule.finish(merged, "completed"));
    assert(schedule.finish(merged, "denied"));
    assertEquals(schedule.claim(), undefined);
    assertEquals(schedule.deliveries().map(({ state }) => state), [
      "revoked",
      "denied",
      "completed",
    ]);
  } finally {
    schedule.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("Agent event intervals persist due times and do not reclaim expired execution", async () => {
  const directory = await Deno.makeTempDir();
  let now = 300_000;
  const schedule = openAgentEventSchedule(
    join(directory, "events.db"),
    () => now,
  );
  try {
    assert(schedule.set({
      id: "heartbeat",
      agent: "review",
      kinds: ["interval"],
      intervalMs: 60_000,
      merge: "none",
      maxConcurrent: 1,
      enabled: true,
    }, 0));
    assertEquals(schedule.claim(), undefined);
    now += 60_000;
    const first = schedule.claim();
    assert(first);
    assertEquals(first.events[0].receipt, String(now));
    assertEquals(schedule.claim(), undefined);
    now += 5 * 60_000 + 1;
    const next = schedule.claim();
    assert(next);
    assert(next.id !== first.id);
    assert(!schedule.current(first));
    assert(!schedule.finish(first, "completed"));
    assertEquals(schedule.deliveries().map(({ state }) => state), [
      "running",
      "interrupted",
    ]);
  } finally {
    schedule.close();
    await Deno.remove(directory, { recursive: true });
  }
});
