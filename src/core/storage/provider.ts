/**
 * StorageProvider — unified persistence abstraction.
 *
 * All stateful data flows through this interface. No module creates its own
 * storage. Implementations include in-memory (tests) and SQLite (personal
 * default).
 *
 * Keys are namespaced strings, e.g. `sessions:sess_123`, `taint:sess_123`.
 * Values are serialised as strings (typically JSON).
 *
 * @module
 */

/** Unified persistence interface for all Triggerfish state. */
export interface StorageProvider {
  /** Store a value under the given key. Overwrites any existing value. */
  set(key: string, value: string): Promise<void>;

  /** Retrieve a value by key. Returns `null` when the key does not exist. */
  get(key: string): Promise<string | null>;

  /** Delete a key. No-op when the key does not exist. */
  delete(key: string): Promise<void>;

  /**
   * List all keys that start with the literal prefix (every character is
   * matched verbatim — `%`, `_`, etc. are not wildcards, and matching is
   * case-sensitive). Returns all keys when no prefix is supplied.
   */
  list(prefix?: string): Promise<string[]>;

  /** Release resources held by this provider (e.g. close database handles). */
  close(): Promise<void>;
}
