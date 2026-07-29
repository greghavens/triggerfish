/**
 * Production wiring tests for the gated secret store in the tool
 * executor enforcement wrapper (issue #404).
 *
 * Verifies that `{{secret:name}}` resolution in tool arguments goes
 * through the classification access gate: session taint escalates on
 * secret access, and denied secrets never reach the tool executor.
 */
import { assert, assertEquals } from "@std/assert";
import { wrapToolExecutorWithEnforcement } from "../../src/agent/dispatch/access_control.ts";
import type { OrchestratorConfig } from "../../src/agent/orchestrator/orchestrator_types.ts";
import type { SecretStore } from "../../src/core/secrets/backends/secret_store.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

/** Secret store with one known secret. */
function createTestStore(): SecretStore {
  return {
    getSecret: (name: string) =>
      Promise.resolve(
        name === "api-key"
          ? { ok: true as const, value: "s3cret" }
          : { ok: false as const, error: `Secret not found: ${name}` },
      ),
    setSecret: () => Promise.resolve({ ok: true as const, value: true as const }),
    deleteSecret: () =>
      Promise.resolve({ ok: true as const, value: true as const }),
    listSecrets: () => Promise.resolve({ ok: true as const, value: [] }),
  };
}

Deno.test("secret gate wiring: resolving a secret escalates session taint", async () => {
  let taint: ClassificationLevel = "PUBLIC";
  const seen: Record<string, unknown>[] = [];
  const config = {
    secretStore: createTestStore(),
    getSessionTaint: () => taint,
    escalateTaint: (level: ClassificationLevel) => {
      taint = level;
    },
  } as unknown as OrchestratorConfig;

  const executor = wrapToolExecutorWithEnforcement(
    (_name, input) => {
      seen.push(input);
      return Promise.resolve("ok");
    },
    config,
  );

  const result = await executor("web_fetch", { token: "{{secret:api-key}}" });
  assertEquals(result, "ok");
  assertEquals(seen[0].token, "s3cret");
  // Unmapped secrets classify at the gate's default level (INTERNAL).
  assertEquals(taint, "INTERNAL");
});

Deno.test("secret gate wiring: no escalation when session is already at level", async () => {
  let escalated = false;
  const config = {
    secretStore: createTestStore(),
    getSessionTaint: () => "CONFIDENTIAL" as ClassificationLevel,
    escalateTaint: () => {
      escalated = true;
    },
  } as unknown as OrchestratorConfig;

  const executor = wrapToolExecutorWithEnforcement(
    () => Promise.resolve("ok"),
    config,
  );

  await executor("web_fetch", { token: "{{secret:api-key}}" });
  assertEquals(escalated, false);
});

Deno.test("secret gate wiring: missing secret reports error, executor not called", async () => {
  let called = false;
  const config = {
    secretStore: createTestStore(),
    getSessionTaint: () => "CONFIDENTIAL" as ClassificationLevel,
  } as unknown as OrchestratorConfig;

  const executor = wrapToolExecutorWithEnforcement(
    () => {
      called = true;
      return Promise.resolve("ok");
    },
    config,
  );

  const result = await executor("web_fetch", { token: "{{secret:nope}}" });
  assert(result.includes("'nope'"));
  assertEquals(called, false);
});
