import { createPolicyEngine } from "../../src/core/policy/engine.ts";
import {
  createDefaultRules,
  createToolApprovalRules,
} from "../../src/core/policy/hooks/hooks.ts";
import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { openApprovalInbox } from "../../src/core/approval_inbox.ts";

const scope = "owner:workspace";
const binding = "a".repeat(64);

function request(expiresAt = 9000) {
  return {
    id: crypto.randomUUID(),
    scope,
    sessionId: "session-fixture",
    runId: "run-fixture",
    assignmentId: "adaptive:case-fixture",
    tool: "fixture_reader",
    binding,
    expiresAt,
  };
}

Deno.test("Approval inbox claims approved dispatch exactly once across independent handles", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "inbox.db");
  let at = 4000;
  const first = openApprovalInbox(path, () => at);
  const second = openApprovalInbox(path, () => at);
  try {
    const input = request();
    const receipt = first.submit({ ...input });
    assertExists(receipt);
    assertEquals(receipt, {
      id: input.id,
      scope,
      sessionId: input.sessionId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      tool: input.tool,
      description: "Approval required for tool fixture_reader.",
      status: "pending",
      createdAt: at,
      updatedAt: at,
      expiresAt: input.expiresAt,
    });
    assertEquals(second.submit(input), receipt);
    assertEquals(
      second.submit({ ...input, binding: "b".repeat(64) }),
      undefined,
    );
    assertEquals(second.submit({ ...input, scope: "unrelated" }), undefined);
    assertEquals(second.read("unrelated", input.id), undefined);
    assertEquals(second.decide("unrelated", input.id, "approved"), undefined);
    assertEquals(second.claim(scope, input.id, binding), undefined);
    at++;
    assertEquals(first.decide(scope, input.id, "approved")?.status, "approved");
    assertEquals(second.decide(scope, input.id, "approved")?.updatedAt, at);
    assertEquals(second.decide(scope, input.id, "denied"), undefined);
    assertEquals(second.claim(scope, input.id, "b".repeat(64)), undefined);
    assertEquals(second.claim("unrelated", input.id, binding), undefined);
    const claim = second.claim(scope, input.id, binding);
    assertExists(claim);
    assertEquals(claim.record.status, "claimed");
    assertEquals(claim.record.decision, "approved");
    assertEquals(Object.hasOwn(claim.record, "token"), false);
    assertEquals(first.claim(scope, input.id, binding), undefined);
    assertEquals(first.stale(scope, input.id, binding), undefined);
    assertEquals(
      first.complete(scope, input.id, crypto.randomUUID()),
      undefined,
    );
    const completed = first.complete(scope, input.id, claim.token, "blocked");
    assertEquals(completed?.status, "completed");
    assertEquals(completed?.dispatchOutcome, "blocked");
    assertEquals(completed?.decision, "approved");
    assertEquals(second.complete(scope, input.id, claim.token), undefined);
    assertEquals(first.claim(scope, input.id, binding), undefined);
  } finally {
    second.close();
    first.close();
    const restarted = openApprovalInbox(path, () => at);
    try {
      assertEquals(
        restarted.list(scope).records.map((
          { status, decision, dispatchOutcome },
        ) => [status, decision, dispatchOutcome]),
        [
          ["completed", "approved", "blocked"],
        ],
      );
    } finally {
      restarted.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Approval expiration and denial persist without permitting re-dispatch", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "inbox.db");
  let at = 3000;
  const inbox = openApprovalInbox(path, () => at);
  try {
    const expires = request(5000);
    const denied = request();
    const changed = request();
    for (const input of [expires, denied, changed]) {
      assertExists(inbox.submit(input));
    }
    assertEquals(
      inbox.decide(scope, expires.id, "approved")?.status,
      "approved",
    );
    assertEquals(inbox.decide(scope, denied.id, "denied")?.status, "denied");
    assertEquals(inbox.stale(scope, changed.id, "b".repeat(64)), undefined);
    assertEquals(inbox.stale(scope, changed.id, binding)?.status, "stale");
    at = 5000;
    assertEquals(inbox.claim(scope, expires.id, binding), undefined);
    assertEquals(inbox.read(scope, expires.id)?.status, "stale");
    assertEquals(inbox.read(scope, expires.id)?.decision, "approved");
    assertEquals(inbox.read(scope, expires.id)?.dispatchOutcome, undefined);
    assertEquals(inbox.read(scope, denied.id)?.decision, "denied");
    assertEquals(inbox.read(scope, changed.id)?.decision, undefined);
    assertEquals(inbox.decide(scope, expires.id, "approved"), undefined);
    assertEquals(inbox.decide(scope, denied.id, "approved"), undefined);
    assertEquals(inbox.claim(scope, denied.id, binding), undefined);
    assertEquals(inbox.submit(request(5000)), undefined);
    const page = inbox.list(scope, 2);
    assertEquals(page.records.map(({ id }) => id), [changed.id, denied.id]);
    assertExists(page.nextBefore);
    assertEquals(
      inbox.list(scope, 2, page.nextBefore).records.map(({ id }) => id),
      [expires.id],
    );
    assertEquals(inbox.list("unrelated", 2, page.nextBefore).records, []);
  } finally {
    inbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Approval inbox rejects a symbolic link instead of opening a different database", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const original = join(dir, "target.db");
    openApprovalInbox(original).close();
    const alias = join(dir, "alias.db");
    await Deno.symlink(original, alias);
    assertThrows(
      () => openApprovalInbox(alias),
      Error,
      "private regular database",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Approval inbox upgrades old decisions without guessing historical dispatch details", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "previous.db");
  try {
    const approved = request();
    const denied = request();
    const stale = request();
    const inbox = openApprovalInbox(path, () => 1000);
    try {
      for (const input of [approved, denied, stale]) {
        assertExists(inbox.submit(input));
      }
      assertExists(inbox.decide(scope, approved.id, "approved"));
      assertExists(inbox.decide(scope, denied.id, "denied"));
      assertExists(inbox.stale(scope, stale.id, binding));
      const claim = inbox.claim(scope, approved.id, binding);
      assertExists(claim);
      assertEquals(
        inbox.complete(scope, approved.id, claim.token)?.dispatchOutcome,
        "returned",
      );
    } finally {
      inbox.close();
    }
    const previous = new DatabaseSync(path);
    try {
      previous.exec(`
        ALTER TABLE approval_requests DROP COLUMN decision;
        ALTER TABLE approval_requests DROP COLUMN dispatchOutcome;
        ALTER TABLE approval_requests DROP COLUMN handlerReturnedAt;
        PRAGMA user_version = 1;
      `);
    } finally {
      previous.close();
    }
    const reopened = openApprovalInbox(path, () => 1000);
    try {
      assertEquals(reopened.read(scope, approved.id)?.decision, "approved");
      assertEquals(
        reopened.read(scope, approved.id)?.dispatchOutcome,
        undefined,
      );
      assertEquals(reopened.read(scope, denied.id)?.decision, "denied");
      assertEquals(reopened.read(scope, stale.id)?.decision, undefined);
      assertEquals(reopened.claim(scope, approved.id, binding), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("configured exact tool approval remains below mandatory classification denial", () => {
  const policy = createPolicyEngine();
  for (
    const rule of [
      ...createDefaultRules(),
      ...createToolApprovalRules(["fixture_tool"]),
    ]
  ) {
    policy.addRule(rule);
  }
  assertEquals(
    policy.evaluate("PRE_TOOL_CALL", { tool_name: "fixture_tool" }).action,
    "REQUIRE_APPROVAL",
  );
  assertEquals(
    policy.evaluate("PRE_TOOL_CALL", { tool_name: "fixture_other" }).action,
    "ALLOW",
  );
  assertEquals(
    policy.evaluate("PRE_TOOL_CALL", {
      tool_name: "fixture_tool",
      resource_write_down_violation: "true",
    }).action,
    "BLOCK",
  );
});
