/**
 * In-memory StorageProvider implementation.
 *
 * Backed by a plain `Map<string, string>`. Suitable for tests and
 * short-lived processes where persistence across restarts is not required.
 *
 * @module
 */

import type { StorageProvider } from "./provider.ts";

/** Filter map keys by an optional prefix. */
function filterKeysByPrefix(
  data: Map<string, string>,
  prefix?: string,
): string[] {
  if (prefix === undefined) return [...data.keys()];
  return [...data.keys()].filter((k) => k.startsWith(prefix));
}

/** Build the StorageProvider methods backed by an in-memory Map. */
function buildMemoryStorageMethods(
  data: Map<string, string>,
): StorageProvider {
  return {
    // deno-lint-ignore require-await
    async set(key: string, value: string): Promise<void> {
      data.set(key, value);
    },
    // deno-lint-ignore require-await
    async get(key: string): Promise<string | null> {
      return data.get(key) ?? null;
    },
    // deno-lint-ignore require-await
    async compareAndSet(key, expected, value) {
      if ((data.get(key) ?? null) !== expected) return false;
      data.set(key, value);
      return true;
    },
    // deno-lint-ignore require-await
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
    // deno-lint-ignore require-await
    async list(prefix?: string): Promise<string[]> {
      return filterKeysByPrefix(data, prefix);
    },
    // deno-lint-ignore require-await
    async close(): Promise<void> {
      data.clear();
    },
  };
}

/** Create an in-memory StorageProvider. */
export function createMemoryStorage(): StorageProvider {
  return buildMemoryStorageMethods(new Map<string, string>());
}
