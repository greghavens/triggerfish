/**
 * Tests for memory screen types.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import type {
  MemoryBrowserEntry,
  MemorySearchFilter,
} from "../../../src/tools/tidepool/screens/memory.ts";

Deno.test("MemoryBrowserEntry type is assignable", () => {
  const entry: MemoryBrowserEntry = {
    id: "mem-1",
    content: "test content",
    classification: "PUBLIC",
    tags: ["test"],
    createdAt: "2026-03-08T12:00:00Z",
    updatedAt: "2026-03-08T12:00:00Z",
  };
  assertEquals(entry.id, "mem-1");
  assertEquals(entry.classification, "PUBLIC");
});

Deno.test("MemorySearchFilter supports all fields", () => {
  const filter: MemorySearchFilter = {
    query: "test",
    classification: "INTERNAL",
    tags: ["tag1", "tag2"],
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
  };
  assertEquals(filter.query, "test");
  assertEquals(filter.classification, "INTERNAL");
  assertEquals(filter.tags?.length, 2);
});

Deno.test("buildTidepoolHtml includes memory screen", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();
  assertEquals(html.includes("memory-screen"), true);
  assertEquals(html.includes("memory-toolbar"), true);
  assertEquals(html.includes("memory-results"), true);
});
