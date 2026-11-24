/**
 * Tests for health screen types and handler.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import {
  HEALTH_CARD_IDS,
  resolveHealthStatusLevel,
} from "../../../src/tools/tidepool/screens/health.ts";
import { createTidepoolHealthHandler } from "../../../src/tools/tidepool/host/host_health.ts";

Deno.test("HEALTH_CARD_IDS contains 13 cards", () => {
  assertEquals(HEALTH_CARD_IDS.length, 13);
  assertEquals(HEALTH_CARD_IDS.includes("gateway"), true);
  assertEquals(HEALTH_CARD_IDS.includes("channels"), true);
  assertEquals(HEALTH_CARD_IDS.includes("sessions"), true);
  assertEquals(HEALTH_CARD_IDS.includes("llm"), true);
  assertEquals(HEALTH_CARD_IDS.includes("policy"), true);
  assertEquals(HEALTH_CARD_IDS.includes("skills"), true);
  assertEquals(HEALTH_CARD_IDS.includes("secrets"), true);
  assertEquals(HEALTH_CARD_IDS.includes("security"), true);
  assertEquals(HEALTH_CARD_IDS.includes("cron"), true);
});

Deno.test("resolveHealthStatusLevel maps correctly", () => {
  assertEquals(resolveHealthStatusLevel("HEALTHY"), "green");
  assertEquals(resolveHealthStatusLevel("WARNING"), "yellow");
  assertEquals(resolveHealthStatusLevel("CRITICAL"), "red");
});

Deno.test("TidepoolHealthHandler returns default snapshot", async () => {
  const handler = createTidepoolHealthHandler();
  const snapshot = await handler.snapshot();
  assertEquals(snapshot.overall, "HEALTHY");
  assertEquals(snapshot.cards.length, 0);
  assertEquals(typeof snapshot.timestamp, "string");
});

Deno.test("TidepoolHealthHandler uses custom snapshot provider", async () => {
  const handler = createTidepoolHealthHandler();
  // deno-lint-ignore require-await
  handler.setSnapshotProvider(async () => ({
    overall: "WARNING",
    cards: [{
      id: "gateway",
      label: "Gateway",
      status: "yellow",
      value: "degraded",
    }],
    timestamp: "2026-03-08T12:00:00Z",
  }));
  const snapshot = await handler.snapshot();
  assertEquals(snapshot.overall, "WARNING");
  assertEquals(snapshot.cards.length, 1);
});

Deno.test("buildTidepoolHtml includes health screen", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();
  assertEquals(html.includes("health-screen"), true);
  assertEquals(html.includes("health-cards"), true);
  assertEquals(html.includes("health-status-bar"), true);
});
