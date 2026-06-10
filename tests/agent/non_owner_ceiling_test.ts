/**
 * enforceNonOwnerToolCeiling default-deny tests (M7).
 *
 * A non-owner session with a ceiling but no classification map must not
 * be allowed to call every tool — it must fall through to default-deny.
 */
import { assert, assertEquals } from "@std/assert";
import { enforceNonOwnerToolCeiling } from "../../src/agent/dispatch/access_control.ts";
import type { ClassificationLevel } from "../../src/core/types/classification.ts";

Deno.test("enforceNonOwnerToolCeiling: denies when no classification map and no floor", () => {
  const err = enforceNonOwnerToolCeiling(
    "run_command",
    "INTERNAL",
    undefined,
    undefined,
  );
  assert(err !== null);
  assert(err.includes("not available"));
});

Deno.test("enforceNonOwnerToolCeiling: allows a tool classified within the ceiling", () => {
  const map = new Map<string, ClassificationLevel>([["web_", "PUBLIC"]]);
  const err = enforceNonOwnerToolCeiling(
    "web_fetch",
    "INTERNAL",
    map,
    undefined,
  );
  assertEquals(err, null);
});

Deno.test("enforceNonOwnerToolCeiling: denies when ceiling is null", () => {
  const err = enforceNonOwnerToolCeiling(
    "web_fetch",
    null,
    undefined,
    undefined,
  );
  assert(err !== null);
});
