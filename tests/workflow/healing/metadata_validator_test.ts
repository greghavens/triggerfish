import { assertEquals } from "@std/assert";
import {
  enforceStepMetadataRequirements,
  parseSelfHealingConfig,
  validateStepMetadata,
} from "../../../src/workflow/healing/metadata_validator.ts";
import type { WorkflowTaskEntry } from "../../../src/workflow/types.ts";

// --- parseSelfHealingConfig ---

Deno.test("parseSelfHealingConfig: valid config with defaults", () => {
  const result = parseSelfHealingConfig({ enabled: true });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.enabled, true);
  assertEquals(result.value.pause_on_intervention, "blocking_only");
  assertEquals(result.value.pause_timeout_seconds, 300);
  assertEquals(result.value.pause_timeout_policy, "escalate_and_halt");
  assertEquals(result.value.retry_budget, 3);
  assertEquals(result.value.approval_required, true);
  assertEquals(result.value.run_history_window, 10);
  assertEquals(result.value.soft_signals, undefined);
});

Deno.test("parseSelfHealingConfig: full config with overrides", () => {
  const result = parseSelfHealingConfig({
    enabled: true,
    pause_on_intervention: "always",
    pause_timeout_seconds: 600,
    pause_timeout_policy: "escalate_and_skip",
    retry_budget: 5,
    approval_required: false,
    notify_on: ["intervention", "escalation"],
    run_history_window: 20,
    soft_signals: { duration_multiplier_threshold: 5, schema_drift: true },
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.pause_on_intervention, "always");
  assertEquals(result.value.pause_timeout_seconds, 600);
  assertEquals(result.value.retry_budget, 5);
  assertEquals(result.value.soft_signals?.duration_multiplier_threshold, 5);
});

Deno.test("parseSelfHealingConfig: non-object rejected", () => {
  assertEquals(parseSelfHealingConfig("not-object").ok, false);
});

Deno.test("parseSelfHealingConfig: missing enabled rejected", () => {
  assertEquals(
    parseSelfHealingConfig({ pause_on_intervention: "always" }).ok,
    false,
  );
});

Deno.test("parseSelfHealingConfig: invalid pause_timeout_policy rejected", () => {
  const r = parseSelfHealingConfig({
    enabled: true,
    pause_timeout_policy: "bad",
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("pause_timeout_policy"), true);
});

Deno.test("parseSelfHealingConfig: invalid pause_on_intervention rejected", () => {
  assertEquals(
    parseSelfHealingConfig({ enabled: true, pause_on_intervention: "bad" }).ok,
    false,
  );
});

Deno.test("parseSelfHealingConfig: boolean pause_on_intervention maps correctly", () => {
  const t = parseSelfHealingConfig({
    enabled: true,
    pause_on_intervention: true,
  });
  assertEquals(t.ok, true);
  if (t.ok) assertEquals(t.value.pause_on_intervention, "always");

  const f = parseSelfHealingConfig({
    enabled: true,
    pause_on_intervention: false,
  });
  assertEquals(f.ok, true);
  if (f.ok) assertEquals(f.value.pause_on_intervention, "never");
});

Deno.test("parseSelfHealingConfig: invalid notify_on rejected", () => {
  assertEquals(
    parseSelfHealingConfig({ enabled: true, notify_on: ["bad"] }).ok,
    false,
  );
});

// --- validateStepMetadata ---

function makeTaskEntry(
  name: string,
  metadata?: Record<string, unknown>,
): WorkflowTaskEntry {
  return { name, task: { type: "call", call: "http", metadata } };
}

Deno.test("validateStepMetadata: valid metadata passes", () => {
  const r = validateStepMetadata(makeTaskEntry("a", {
    description: "d",
    expects: "e",
    produces: "p",
  }));
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value.description, "d");
});

Deno.test("validateStepMetadata: missing metadata rejected", () => {
  const r = validateStepMetadata(makeTaskEntry("a"));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("a"), true);
});

Deno.test("validateStepMetadata: empty field rejected", () => {
  const r = validateStepMetadata(makeTaskEntry("a", {
    description: "",
    expects: "e",
    produces: "p",
  }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("description"), true);
});

Deno.test("validateStepMetadata: missing expects rejected", () => {
  const r = validateStepMetadata(makeTaskEntry("a", {
    description: "d",
    produces: "p",
  }));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("expects"), true);
});

// --- enforceStepMetadataRequirements ---

Deno.test("enforceStepMetadataRequirements: passes when all valid", () => {
  const tasks = [
    makeTaskEntry("a", {
      description: "d",
      intent: "i",
      expects: "e",
      produces: "p",
    }),
    makeTaskEntry("b", {
      description: "d",
      intent: "i",
      expects: "e",
      produces: "p",
    }),
  ];
  assertEquals(enforceStepMetadataRequirements(tasks).ok, true);
});

Deno.test("enforceStepMetadataRequirements: fails on first invalid", () => {
  const tasks = [
    makeTaskEntry("good", {
      description: "d",
      intent: "i",
      expects: "e",
      produces: "p",
    }),
    makeTaskEntry("bad"),
  ];
  const r = enforceStepMetadataRequirements(tasks);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("bad"), true);
});
