/**
 * Tests for the plugin Reef registry client.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { createPluginReefRegistry } from "../../src/plugin/reef.ts";
import type { ReefPluginCatalog } from "../../src/plugin/reef.ts";

/** Create a mock catalog. */
function mockCatalog(): ReefPluginCatalog {
  return {
    entries: [
      {
        name: "weather",
        version: "1.0.0",
        description: "Weather forecast plugin",
        author: "test-author",
        classification: "PUBLIC",
        trust: "sandboxed",
        tags: ["weather", "forecast"],
        checksum: "abc123",
        publishedAt: "2026-01-01T00:00:00Z",
        declaredEndpoints: ["https://api.weather.com"],
      },
      {
        name: "database",
        version: "2.1.0",
        description: "Database query tools",
        author: "test-author",
        classification: "CONFIDENTIAL",
        trust: "trusted",
        tags: ["db", "sql"],
        checksum: "def456",
        publishedAt: "2026-02-01T00:00:00Z",
        declaredEndpoints: [],
      },
    ],
    generatedAt: "2026-03-01T00:00:00Z",
  };
}

/** Create a mock fetch that serves the catalog. */
function createMockFetch(
  catalog: ReefPluginCatalog,
): typeof fetch {
  // deno-lint-ignore require-await
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("catalog.json")) {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

Deno.test("PluginReef search: finds plugins by name", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const result = await registry.search("weather");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].name, "weather");
  }
});

Deno.test("PluginReef search: finds plugins by tag", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const result = await registry.search("sql");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0].name, "database");
  }
});

Deno.test("PluginReef search: returns empty for no match", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const result = await registry.search("nonexistent");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("PluginReef checkUpdates: identifies updatable plugins", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const result = await registry.checkUpdates([
    { name: "weather", version: "0.9.0" },
    { name: "database", version: "2.1.0" },
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 1);
    assertEquals(result.value[0], "weather");
  }
});

Deno.test("PluginReef checkUpdates: all up to date", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const result = await registry.checkUpdates([
    { name: "weather", version: "1.0.0" },
    { name: "database", version: "2.1.0" },
  ]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("PluginReef install: fails for unknown plugin", async () => {
  const registry = createPluginReefRegistry({
    fetchFn: createMockFetch(mockCatalog()),
  });
  const dir = await Deno.makeTempDir({ prefix: "reef-install-test-" });
  try {
    const result = await registry.install("nonexistent", dir);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.includes("not found"), true);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PluginReef search: handles catalog fetch failure", async () => {
  const registry = createPluginReefRegistry({
    // deno-lint-ignore require-await
    fetchFn: (async () =>
      new Response("Server error", { status: 500 })) as typeof fetch,
  });
  const result = await registry.search("test");
  assertEquals(result.ok, false);
});

// --- SSRF-checked default fetch (MCP-PLUGIN-6) ---

Deno.test("PluginReef: default fetch blocks catalog fetch to a private host", async () => {
  // No fetchFn injected — the registry defaults to the SSRF-checked fetch,
  // which rejects loopback/private targets before any connection is made.
  const registry = createPluginReefRegistry({
    baseUrl: "https://127.0.0.1",
  });

  const result = await registry.search("weather");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("Outbound fetch blocked"),
      true,
      `expected SSRF block, got: ${result.error}`,
    );
  }
});

Deno.test("PluginReef: default fetch blocks install from an RFC1918 host", async () => {
  const registry = createPluginReefRegistry({
    baseUrl: "https://10.0.0.5",
  });

  const result = await registry.install("weather", "/tmp/unused-target");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.includes("Outbound fetch blocked"),
      true,
      `expected SSRF block, got: ${result.error}`,
    );
  }
});
