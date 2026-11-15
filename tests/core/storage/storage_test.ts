/**
 * Phase 4: Storage Abstraction
 * Tests MUST FAIL until storage providers are implemented.
 * Tests both InMemory and SQLite backends against the same interface.
 */
import { assert, assertEquals, assertExists } from "@std/assert";
import type { StorageProvider } from "../../src/core/storage/provider.ts";
import { createMemoryStorage } from "../../src/core/storage/memory.ts";
import { createSqliteStorage } from "../../src/core/storage/sqlite.ts";

// Run the same test suite against both backends
function storageTests(
  name: string,
  factory: () => Promise<StorageProvider> | StorageProvider,
) {
  Deno.test(`${name}: set and get a value`, async () => {
    const store = await factory();
    try {
      await store.set("key1", JSON.stringify({ data: "hello" }));
      const val = await store.get("key1");
      assertExists(val);
      assertEquals(JSON.parse(val!), { data: "hello" });
    } finally {
      await store.close();
    }
  });

  Deno.test(`${name}: get returns null for missing key`, async () => {
    const store = await factory();
    try {
      const val = await store.get("nonexistent");
      assertEquals(val, null);
    } finally {
      await store.close();
    }
  });

  Deno.test(`${name}: set overwrites existing value`, async () => {
    const store = await factory();
    try {
      await store.set("key1", "first");
      await store.set("key1", "second");
      assertEquals(await store.get("key1"), "second");
    } finally {
      await store.close();
    }
  });

  Deno.test(`${name}: delete removes value`, async () => {
    const store = await factory();
    try {
      await store.set("key1", "value");
      await store.delete("key1");
      assertEquals(await store.get("key1"), null);
    } finally {
      await store.close();
    }
  });

  Deno.test(`${name}: list returns all keys with prefix`, async () => {
    const store = await factory();
    try {
      await store.set("session:1", "a");
      await store.set("session:2", "b");
      await store.set("lineage:1", "c");
      const keys = await store.list("session:");
      assertEquals(keys.length, 2);
      assert(keys.includes("session:1"));
      assert(keys.includes("session:2"));
    } finally {
      await store.close();
    }
  });

  Deno.test(`${name}: list with no prefix returns all keys`, async () => {
    const store = await factory();
    try {
      await store.set("a", "1");
      await store.set("b", "2");
      const keys = await store.list();
      assert(keys.length >= 2);
    } finally {
      await store.close();
    }
  });
}

// Run against both backends
storageTests("InMemoryStorage", () => createMemoryStorage());
storageTests("SqliteStorage", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".db" });
  return createSqliteStorage(tmpFile);
});

// ─── list() literal-prefix conformance (memory vs sqlite) ───────────────────
//
// CORE-STATE-1: SQLite previously used `LIKE prefix || '%'`, so `%` and `_`
// inside a prefix acted as wildcards and over-broadened listings across key
// namespaces. Both providers must treat every prefix character literally.

const LIST_CONFORMANCE_KEYS = [
  "task_1",
  "task_2",
  "taskX1",
  "100%done",
  "100Xdone",
  "dir\\sub:1",
  "dirXsub:1",
  "Session:1",
  "session:1",
] as const;

const LIST_CONFORMANCE_PREFIXES = [
  "task_",
  "100%",
  "dir\\",
  "session:",
  "Session:",
] as const;

/** Seed the conformance keys and collect sorted list() results per prefix. */
async function collectListResults(
  store: StorageProvider,
): Promise<Map<string, string[]>> {
  for (const key of LIST_CONFORMANCE_KEYS) {
    await store.set(key, "v");
  }
  const results = new Map<string, string[]>();
  for (const prefix of LIST_CONFORMANCE_PREFIXES) {
    results.set(prefix, (await store.list(prefix)).sort());
  }
  return results;
}

Deno.test("StorageProvider conformance: list() treats prefix as literal (memory vs sqlite)", async () => {
  const memory = createMemoryStorage();
  const tmpFile = await Deno.makeTempFile({ suffix: ".db" });
  const sqlite = createSqliteStorage(tmpFile);
  try {
    const memResults = await collectListResults(memory);
    const sqlResults = await collectListResults(sqlite);
    for (const prefix of LIST_CONFORMANCE_PREFIXES) {
      assertEquals(
        sqlResults.get(prefix),
        memResults.get(prefix),
        `list("${prefix}") differs between sqlite and memory`,
      );
    }
    // `_` is not a single-character wildcard: taskX1 must not match.
    assertEquals(memResults.get("task_"), ["task_1", "task_2"]);
    // `%` is not a multi-character wildcard: 100Xdone must not match.
    assertEquals(memResults.get("100%"), ["100%done"]);
    // Backslash is an ordinary character, not a LIKE escape.
    assertEquals(memResults.get("dir\\"), ["dir\\sub:1"]);
    // Prefix matching is case-sensitive.
    assertEquals(memResults.get("session:"), ["session:1"]);
    assertEquals(memResults.get("Session:"), ["Session:1"]);
  } finally {
    await memory.close();
    await sqlite.close();
    await Deno.remove(tmpFile);
  }
});

// SQLite-specific: persistence across instances
Deno.test("SqliteStorage: data survives close and reopen", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".db" });
  const store1 = await createSqliteStorage(tmpFile);
  await store1.set("persist-key", "persist-value");
  await store1.close();

  const store2 = await createSqliteStorage(tmpFile);
  try {
    assertEquals(await store2.get("persist-key"), "persist-value");
  } finally {
    await store2.close();
    await Deno.remove(tmpFile);
  }
});
