/**
 * Tests for Tidepool shell: nav items, screen routing, topic dispatch.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { assertExists } from "@std/assert";
import {
  createEmptyBadgeState,
  DEFAULT_SCREEN,
  isValidScreen,
  isValidTopic,
  NAV_ITEMS,
  resolveMessageTopic,
  resolveScreenFromHash,
  SCREEN_IDS,
  SHELL_TOPICS,
} from "../../../src/tools/tidepool/shell/mod.ts";

// ---------------------------------------------------------------------------
// Screen routing
// ---------------------------------------------------------------------------

Deno.test("resolveScreenFromHash returns default for empty hash", () => {
  assertEquals(resolveScreenFromHash(""), DEFAULT_SCREEN);
});

Deno.test("resolveScreenFromHash returns default for invalid hash", () => {
  assertEquals(resolveScreenFromHash("#invalid"), DEFAULT_SCREEN);
  assertEquals(resolveScreenFromHash("#"), DEFAULT_SCREEN);
  assertEquals(resolveScreenFromHash("nonsense"), DEFAULT_SCREEN);
});

Deno.test("resolveScreenFromHash resolves valid screens", () => {
  assertEquals(resolveScreenFromHash("#chat"), "chat");
  assertEquals(resolveScreenFromHash("#agents"), "agents");
  assertEquals(resolveScreenFromHash("#health"), "health");
  assertEquals(resolveScreenFromHash("#settings"), "settings");
  assertEquals(resolveScreenFromHash("#logs"), "logs");
  assertEquals(resolveScreenFromHash("#memory"), "memory");
});

Deno.test("resolveScreenFromHash handles hash without #", () => {
  assertEquals(resolveScreenFromHash("chat"), "chat");
  assertEquals(resolveScreenFromHash("agents"), "agents");
});

Deno.test("isValidScreen returns true for valid screen IDs", () => {
  for (const id of SCREEN_IDS) {
    assertEquals(isValidScreen(id), true, `${id} should be valid`);
  }
});

Deno.test("isValidScreen returns false for invalid IDs", () => {
  assertEquals(isValidScreen("invalid"), false);
  assertEquals(isValidScreen(""), false);
  assertEquals(isValidScreen("Chat"), false);
});

Deno.test("SCREEN_IDS contains all 7 screens", () => {
  assertEquals(SCREEN_IDS.length, 7);
  assertEquals(SCREEN_IDS.includes("chat"), true);
  assertEquals(SCREEN_IDS.includes("agents"), true);
  assertEquals(SCREEN_IDS.includes("health"), true);
  assertEquals(SCREEN_IDS.includes("settings"), true);
  assertEquals(SCREEN_IDS.includes("logs"), true);
  assertEquals(SCREEN_IDS.includes("memory"), true);
});

Deno.test("DEFAULT_SCREEN is chat", () => {
  assertEquals(DEFAULT_SCREEN, "chat");
});

// ---------------------------------------------------------------------------
// Topic dispatch
// ---------------------------------------------------------------------------

Deno.test("resolveMessageTopic defaults to chat for missing topic", () => {
  assertEquals(resolveMessageTopic({}), "chat");
  assertEquals(resolveMessageTopic({ type: "message" }), "chat");
});

Deno.test("resolveMessageTopic returns valid topic", () => {
  assertEquals(resolveMessageTopic({ topic: "logs" }), "logs");
  assertEquals(resolveMessageTopic({ topic: "agents" }), "agents");
  assertEquals(resolveMessageTopic({ topic: "health" }), "health");
  assertEquals(resolveMessageTopic({ topic: "memory" }), "memory");
  assertEquals(resolveMessageTopic({ topic: "settings" }), "settings");
  assertEquals(resolveMessageTopic({ topic: "chat" }), "chat");
});

Deno.test("resolveMessageTopic defaults to chat for invalid topic", () => {
  assertEquals(
    resolveMessageTopic({ topic: "invalid" as "chat" }),
    "chat",
  );
});

Deno.test("isValidTopic returns true for valid topics", () => {
  for (const topic of SHELL_TOPICS) {
    assertEquals(isValidTopic(topic), true, `${topic} should be valid`);
  }
});

Deno.test("isValidTopic returns false for invalid topics", () => {
  assertEquals(isValidTopic("invalid"), false);
  assertEquals(isValidTopic(""), false);
});

Deno.test("SHELL_TOPICS matches SCREEN_IDS", () => {
  assertEquals(SHELL_TOPICS.length, SCREEN_IDS.length);
  for (const topic of SHELL_TOPICS) {
    assertEquals(
      SCREEN_IDS.includes(topic),
      true,
      `${topic} should be in SCREEN_IDS`,
    );
  }
});

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

Deno.test("NAV_ITEMS has one item per screen", () => {
  assertEquals(NAV_ITEMS.length, SCREEN_IDS.length);
  for (const item of NAV_ITEMS) {
    assertEquals(
      SCREEN_IDS.includes(item.id),
      true,
      `Nav item ${item.id} should be a valid screen`,
    );
    assertExists(item.label, `Nav item ${item.id} should have a label`);
    assertExists(item.icon, `Nav item ${item.id} should have an icon`);
    assertExists(item.title, `Nav item ${item.id} should have a title`);
  }
});

Deno.test("NAV_ITEMS has unique screen IDs", () => {
  const ids = NAV_ITEMS.map((item) => item.id);
  const unique = new Set(ids);
  assertEquals(unique.size, ids.length);
});

// ---------------------------------------------------------------------------
// Badge state
// ---------------------------------------------------------------------------

Deno.test("createEmptyBadgeState returns all undefined badges", () => {
  const state = createEmptyBadgeState();
  for (const id of SCREEN_IDS) {
    assertEquals(state[id], undefined);
  }
});

// ---------------------------------------------------------------------------
// HTML compositor includes shell template
// ---------------------------------------------------------------------------

Deno.test("buildTidepoolHtml includes nav bar and screen containers", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();

  // Nav bar present
  assertEquals(html.includes("nav-bar"), true);

  // All seven compiled screen components are included
  for (const id of SCREEN_IDS) {
    assertEquals(
      html.includes(`${id}-screen`),
      true,
      `Screen container for ${id} should exist`,
    );
  }

  // Shell script present
  assertEquals(html.includes("nav-items"), true);
  assertEquals(html.includes("nav-badge-wrap"), true);

  // Chat panel still present
  assertEquals(html.includes("chat-main"), true);

  // Canvas panel still present
  assertEquals(html.includes("canvas-panel"), true);
});
