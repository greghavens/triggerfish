/**
 * Tests for TidepoolChat component types, taint badge, and status dot.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import {
  resolveTaintBadgeClass,
  TAINT_BADGE_MAP,
} from "../../../src/tools/tidepool/components/taint_badge.ts";
import {
  resolveStatusLevel,
} from "../../../src/tools/tidepool/components/status_dot.ts";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";

// ---------------------------------------------------------------------------
// Taint badge
// ---------------------------------------------------------------------------

Deno.test("TAINT_BADGE_MAP has all 4 classification levels", () => {
  const levels: ClassificationLevel[] = [
    "PUBLIC",
    "INTERNAL",
    "CONFIDENTIAL",
    "RESTRICTED",
  ];
  for (const level of levels) {
    const entry = TAINT_BADGE_MAP[level];
    assertEquals(typeof entry.background, "string");
    assertEquals(typeof entry.foreground, "string");
    assertEquals(typeof entry.cssClass, "string");
  }
});

Deno.test("resolveTaintBadgeClass returns correct class", () => {
  assertEquals(resolveTaintBadgeClass("PUBLIC"), "public");
  assertEquals(resolveTaintBadgeClass("INTERNAL"), "internal");
  assertEquals(resolveTaintBadgeClass("CONFIDENTIAL"), "confidential");
  assertEquals(resolveTaintBadgeClass("RESTRICTED"), "restricted");
});

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

Deno.test("resolveStatusLevel maps active states to green", () => {
  assertEquals(resolveStatusLevel("active"), "green");
  assertEquals(resolveStatusLevel("running"), "green");
  assertEquals(resolveStatusLevel("connected"), "green");
  assertEquals(resolveStatusLevel("healthy"), "green");
});

Deno.test("resolveStatusLevel maps idle states to yellow", () => {
  assertEquals(resolveStatusLevel("idle"), "yellow");
  assertEquals(resolveStatusLevel("waiting"), "yellow");
  assertEquals(resolveStatusLevel("degraded"), "yellow");
  assertEquals(resolveStatusLevel("connecting"), "yellow");
});

Deno.test("resolveStatusLevel maps error states to red", () => {
  assertEquals(resolveStatusLevel("error"), "red");
  assertEquals(resolveStatusLevel("failed"), "red");
  assertEquals(resolveStatusLevel("critical"), "red");
  assertEquals(resolveStatusLevel("disconnected"), "red");
});

Deno.test("resolveStatusLevel defaults to gray", () => {
  assertEquals(resolveStatusLevel("unknown"), "gray");
  assertEquals(resolveStatusLevel(""), "gray");
  assertEquals(resolveStatusLevel("something"), "gray");
});

// ---------------------------------------------------------------------------
// HTML output includes TidepoolChat class
// ---------------------------------------------------------------------------

Deno.test("buildTidepoolHtml includes compiled chat and components", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();

  assertEquals(html.includes("chat-screen"), true);
  assertEquals(html.includes("taint-badge"), true);
  assertEquals(html.includes("status-dot"), true);
  assertEquals(html.includes("input-area"), true);
});
