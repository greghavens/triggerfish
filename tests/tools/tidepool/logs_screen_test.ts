/**
 * Tests for logs screen types and log sink.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import {
  createDefaultLogFilter,
  LOG_LEVEL_COLORS,
  LOG_LEVELS,
} from "../../../src/tools/tidepool/screens/logs.ts";
import { createTidepoolLogSink } from "../../../src/tools/tidepool/host/host_logs.ts";
import type { LogEntry } from "../../../src/tools/tidepool/screens/logs.ts";

Deno.test("LOG_LEVELS contains all 4 levels", () => {
  assertEquals(LOG_LEVELS.length, 4);
  assertEquals(LOG_LEVELS.includes("DEBUG"), true);
  assertEquals(LOG_LEVELS.includes("INFO"), true);
  assertEquals(LOG_LEVELS.includes("WARN"), true);
  assertEquals(LOG_LEVELS.includes("ERROR"), true);
});

Deno.test("LOG_LEVEL_COLORS has entries for all levels", () => {
  for (const level of LOG_LEVELS) {
    assertEquals(typeof LOG_LEVEL_COLORS[level], "string");
  }
});

Deno.test("createDefaultLogFilter enables all levels", () => {
  const filter = createDefaultLogFilter();
  for (const level of LOG_LEVELS) {
    assertEquals(filter.levels.has(level), true);
  }
  assertEquals(filter.source, undefined);
  assertEquals(filter.search, undefined);
});

Deno.test("TidepoolLogSink buffers entries", () => {
  const sink = createTidepoolLogSink();
  const entry: LogEntry = {
    timestamp: "2026-03-08T12:00:00Z",
    level: "INFO",
    source: "test",
    message: "hello",
  };
  sink.write(entry);
  const lines = sink.recentLines(10);
  assertEquals(lines.length, 1);
  assertEquals(lines[0].message, "hello");
});

Deno.test("TidepoolLogSink limits buffer to 500", () => {
  const sink = createTidepoolLogSink();
  for (let i = 0; i < 600; i++) {
    sink.write({
      timestamp: "2026-03-08T12:00:00Z",
      level: "DEBUG",
      source: "test",
      message: `msg-${i}`,
    });
  }
  const lines = sink.recentLines(1000);
  assertEquals(lines.length, 500);
  assertEquals(lines[0].message, "msg-100");
});

Deno.test("buildTidepoolHtml includes logs screen", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();
  assertEquals(html.includes("logs-screen"), true);
  assertEquals(html.includes("logs-output"), true);
  assertEquals(html.includes("search-input"), true);
});
