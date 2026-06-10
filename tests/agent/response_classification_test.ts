/**
 * escalateResponseClassification validation tests (M1).
 *
 * Untrusted tool output must not drive session taint with an arbitrary
 * string: only a valid lattice level may escalate.
 */
import { assertEquals } from "@std/assert";
import { escalateResponseClassification } from "../../src/agent/dispatch/access_control.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

Deno.test("escalateResponseClassification: valid _classification escalates taint", () => {
  const calls: ClassificationLevel[] = [];
  escalateResponseClassification(
    JSON.stringify({ data: "x", _classification: "CONFIDENTIAL" }),
    (level) => calls.push(level),
    "memory_search",
  );
  assertEquals(calls, ["CONFIDENTIAL"]);
});

Deno.test("escalateResponseClassification: invalid _classification is ignored", () => {
  const calls: ClassificationLevel[] = [];
  escalateResponseClassification(
    JSON.stringify({ _classification: "GARBAGE" }),
    (level) => calls.push(level),
    "web_fetch",
  );
  assertEquals(calls, []);
});

Deno.test("escalateResponseClassification: non-JSON result does not escalate", () => {
  const calls: ClassificationLevel[] = [];
  escalateResponseClassification(
    "not json at all",
    (level) => calls.push(level),
    "run_command",
  );
  assertEquals(calls, []);
});
