/**
 * Replay attack prevention for webhook requests.
 *
 * Tracks recently seen HMAC signatures. When a valid signature is
 * replayed, it is detected and rejected. Two backings:
 *
 * - In-memory bounded LRU set (default) — lost on daemon restart.
 * - StorageProvider-backed persistent set — survives restarts, so a
 *   restart within the webhook freshness window cannot reopen the
 *   replay hole. For senders that can only sign the body (no
 *   timestamp binding, e.g. GitHub-style), the persistent store is
 *   the primary replay control. Entries are TTL-pruned and
 *   size-bounded to prevent unbounded growth.
 *
 * @module
 */

import type { StorageProvider } from "../../core/storage/provider.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("scheduler.replay-guard");

/** Storage key prefix for persisted replay-guard entries. */
const REPLAY_KEY_PREFIX = "webhook:replay:";

/** Default maximum signatures retained. */
const DEFAULT_MAX_SIZE = 10_000;

/**
 * Default retention for persisted signatures (24h). Far exceeds the
 * default 5-minute webhook freshness window, so timestamped requests
 * are always covered; body-only signatures are protected for the
 * retention period.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Tracks recently seen HMAC signatures to detect replay attacks. */
export interface ReplayGuard {
  /** Atomically claim a verified signature; false rejects duplicates or storage failures. */
  claimSignature(signature: string): Promise<boolean>;
  /** Returns true if this signature was seen recently (replay detected). */
  hasSeenSignature(signature: string): Promise<boolean>;
  /**
   * Record a signature as seen.
   * Must be called only after verifying the signature is valid (HMAC passed).
   */
  recordSignature(signature: string): Promise<void>;
}

type ReplayStore = Omit<ReplayGuard, "claimSignature">;

/** Options for creating a replay guard. */
export interface ReplayGuardOptions {
  /** Maximum signatures to retain. Defaults to 10_000. */
  readonly maxSize?: number;
  /**
   * Storage provider persisting signatures across daemon restarts.
   * When absent, an in-memory bounded LRU set is used.
   */
  readonly storage?: StorageProvider;
  /** Retention for persisted signatures. Defaults to 24 hours. */
  readonly ttlMs?: number;
}

/**
 * Create a replay guard.
 *
 * With `options.storage` set, signatures persist across daemon restarts
 * (StorageProvider-backed). Otherwise an in-memory bounded LRU set is
 * used (insertion-ordered Map; the oldest entry is evicted when full).
 */
export function createReplayGuard(options?: ReplayGuardOptions): ReplayGuard {
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const store = options?.storage
    ? createPersistentReplayGuard(
      options.storage,
      maxSize,
      options.ttlMs ?? DEFAULT_TTL_MS,
    )
    : createMemoryReplayGuard(maxSize);
  return serializeReplayClaims(store);
}

/** Serialize check-and-record within this daemon so concurrent duplicates cannot pass. */
function serializeReplayClaims(store: ReplayStore): ReplayGuard {
  let pending = Promise.resolve();
  return {
    ...store,
    claimSignature(signature: string): Promise<boolean> {
      const claimed = pending.then(async () => {
        try {
          if (await store.hasSeenSignature(signature)) return false;
          await store.recordSignature(signature);
          return true;
        } catch (err) {
          log.warn("Webhook replay claim blocked: storage unavailable", {
            operation: "claimSignature",
            err,
          });
          return false;
        }
      });
      pending = claimed.then(() => undefined);
      return claimed;
    },
  };
}

/** In-memory bounded LRU replay guard (lost on restart). */
function createMemoryReplayGuard(maxSize: number): ReplayStore {
  const seen = new Map<string, true>();

  return {
    hasSeenSignature(signature: string): Promise<boolean> {
      return Promise.resolve(seen.has(signature));
    },
    recordSignature(signature: string): Promise<void> {
      if (seen.size >= maxSize) {
        seen.delete(seen.keys().next().value!);
      }
      seen.set(signature, true);
      return Promise.resolve();
    },
  };
}

/** A persisted replay entry (key + when it was recorded). */
interface ReplayEntry {
  readonly key: string;
  readonly recordedAt: number;
}

/** Load all persisted replay entries with their recorded timestamps. */
async function loadReplayEntries(
  storage: StorageProvider,
): Promise<ReplayEntry[]> {
  const keys = await storage.list(REPLAY_KEY_PREFIX);
  const entries: ReplayEntry[] = [];
  for (const key of keys) {
    const value = await storage.get(key);
    entries.push({ key, recordedAt: Number(value) });
  }
  return entries;
}

/** Delete expired entries, then evict oldest beyond maxSize. Returns live count. */
async function pruneReplayEntries(
  storage: StorageProvider,
  options: {
    readonly now: number;
    readonly maxSize: number;
    readonly ttlMs: number;
  },
): Promise<number> {
  const entries = await loadReplayEntries(storage);
  const live: ReplayEntry[] = [];
  for (const entry of entries) {
    if (
      !Number.isFinite(entry.recordedAt) ||
      options.now - entry.recordedAt > options.ttlMs
    ) {
      await storage.delete(entry.key);
    } else {
      live.push(entry);
    }
  }
  live.sort((a, b) => a.recordedAt - b.recordedAt);
  const excess = live.length - options.maxSize;
  for (let i = 0; i < excess; i++) {
    await storage.delete(live[i].key);
  }
  const liveCount = Math.min(live.length, Math.max(options.maxSize, 0));
  log.debug("Webhook replay guard pruned", {
    operation: "pruneReplayEntries",
    expired: entries.length - live.length,
    evicted: Math.max(excess, 0),
    retained: liveCount,
  });
  return liveCount;
}

/** StorageProvider-backed replay guard that survives daemon restarts. */
function createPersistentReplayGuard(
  storage: StorageProvider,
  maxSize: number,
  ttlMs: number,
): ReplayStore {
  let approxCount: number | null = null;

  async function countReplayEntries(): Promise<number> {
    if (approxCount === null) {
      approxCount = (await storage.list(REPLAY_KEY_PREFIX)).length;
    }
    return approxCount;
  }

  return {
    async hasSeenSignature(signature: string): Promise<boolean> {
      const value = await storage.get(REPLAY_KEY_PREFIX + signature);
      if (value === null) return false;
      const recordedAt = Number(value);
      // Unparseable entries fail closed: treat as seen (reject the request).
      if (!Number.isFinite(recordedAt)) return true;
      if (Date.now() - recordedAt > ttlMs) {
        await storage.delete(REPLAY_KEY_PREFIX + signature);
        if (approxCount !== null) approxCount = Math.max(0, approxCount - 1);
        return false;
      }
      return true;
    },
    async recordSignature(signature: string): Promise<void> {
      const now = Date.now();
      const count = await countReplayEntries();
      await storage.set(REPLAY_KEY_PREFIX + signature, String(now));
      approxCount = count + 1;
      if (approxCount > maxSize) {
        approxCount = await pruneReplayEntries(storage, {
          now,
          maxSize,
          ttlMs,
        });
      }
    },
  };
}
