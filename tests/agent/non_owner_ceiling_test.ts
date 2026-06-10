/**
 * enforceNonOwnerToolCeiling default-deny tests (M7).
 *
 * A non-owner session with a ceiling but no classification map must not
 * be allowed to call every tool — it must fall through to default-deny.
 */
import { assert, assertEquals } from "@std/assert";
import { enforceNonOwnerToolCeiling } from "../../src/agent/dispatch/access_control.ts";
import { createToolFloorRegistry } from "../../src/core/security/tool_floors.ts";
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

Deno.test("enforceNonOwnerToolCeiling: non-owner cannot reach plugin_install (RESTRICTED floor)", () => {
  const floors = createToolFloorRegistry();
  for (const ceiling of ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] as const) {
    for (const tool of ["plugin_install", "plugin_reload", "plugin_scan"]) {
      const err = enforceNonOwnerToolCeiling(tool, ceiling, undefined, floors);
      assert(
        err !== null && err.includes("exceeds session ceiling"),
        `${tool} must be denied at ceiling ${ceiling}`,
      );
    }
  }
});

Deno.test("enforceNonOwnerToolCeiling: PUBLIC ceiling denied log_read and healthcheck (INTERNAL floor)", () => {
  const floors = createToolFloorRegistry();
  for (const tool of ["log_read", "healthcheck"]) {
    const err = enforceNonOwnerToolCeiling(tool, "PUBLIC", undefined, floors);
    assert(
      err !== null && err.includes("exceeds session ceiling"),
      `${tool} must be denied at PUBLIC ceiling`,
    );
  }
});

Deno.test("enforceNonOwnerToolCeiling: INTERNAL+ ceiling allows log_read and healthcheck", () => {
  const floors = createToolFloorRegistry();
  for (const ceiling of ["INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const) {
    for (const tool of ["log_read", "healthcheck"]) {
      const err = enforceNonOwnerToolCeiling(tool, ceiling, undefined, floors);
      assertEquals(
        err,
        null,
        `${tool} must be allowed at ceiling ${ceiling}`,
      );
    }
  }
});
