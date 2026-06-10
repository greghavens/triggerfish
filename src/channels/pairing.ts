/**
 * Channel pairing service for linking messaging platforms to owner identity.
 *
 * Generates one-time 6-digit pairing codes with 5-minute expiry.
 * Codes are stored in the StorageProvider under the `pairing:` namespace.
 * Once verified, a code is marked as used and cannot be reused.
 *
 * Verification enforces an always-on per-sender attempt cap: after
 * `MAX_PAIRING_ATTEMPTS` failed attempts within one TTL window, further
 * attempts from that sender are rejected without consulting the live code.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { StorageProvider } from "../core/storage/provider.ts";
import { createLogger } from "../core/logger/mod.ts";

const log = createLogger("pairing");

/** A one-time pairing code for linking a channel to an identity. */
export interface PairingCode {
  readonly code: string;
  readonly channelType: string;
  readonly expiresAt: Date;
  readonly used: boolean;
}

/** Result of a successful pairing verification. */
export interface PairingResult {
  readonly channelType: string;
  readonly platformUserId: string;
  readonly linkedAt: Date;
}

/** Service for generating and verifying channel pairing codes. */
export interface PairingService {
  /**
   * Generate a 6-digit pairing code for the given channel type.
   * The code expires after 5 minutes and is stored in the StorageProvider.
   */
  generateCode(channelType: string): Promise<PairingCode>;

  /**
   * Verify a pairing code and link the platform user identity.
   * Returns an error if the code is invalid, expired, already used,
   * or does not match the given channel type. A sender that fails
   * `MAX_PAIRING_ATTEMPTS` times within one TTL window is locked out
   * for the remainder of that window without the live code being checked.
   */
  verifyCode(
    code: string,
    channelType: string,
    platformUserId: string,
  ): Promise<Result<PairingResult, string>>;

  /**
   * Get the pending (unused, unexpired) pairing code for a channel type.
   * Returns null if no valid pending code exists.
   */
  getPending(channelType: string): Promise<PairingCode | null>;

  /** List all platform user IDs that have been linked via pairing for a channel type. */
  getLinkedUsers(channelType: string): Promise<string[]>;
}

/** Default pairing code TTL: 5 minutes in milliseconds. */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** Storage key prefix for pairing codes. */
const PAIRING_PREFIX = "pairing:";

/** Storage key prefix for linked pairings. */
const LINKED_PREFIX = "pairing:linked:";

/** Storage key prefix for per-sender failed verification counters. */
const ATTEMPTS_PREFIX = "pairing:attempts:";

/**
 * Maximum failed verification attempts per sender within one TTL window.
 * Always on — independent of any optional channel rate limit.
 */
export const MAX_PAIRING_ATTEMPTS = 5;

/** Optional clock injection for testability. Defaults to Date.now. */
export interface PairingOptions {
  readonly now?: () => number;
}

/**
 * Generate a cryptographically random 6-digit code.
 * Uses crypto.getRandomValues for secure randomness.
 */
function generateSixDigitCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Modulo 1_000_000 gives a number in [0, 999999], then pad to 6 digits.
  const code = (array[0] % 1_000_000).toString().padStart(6, "0");
  return code;
}

/** Serialize a PairingCode to a JSON string for storage. */
function serializePairingCode(pc: PairingCode): string {
  return JSON.stringify({
    code: pc.code,
    channelType: pc.channelType,
    expiresAt: pc.expiresAt.toISOString(),
    used: pc.used,
  });
}

/** Deserialize a PairingCode from a JSON string. */
function deserializePairingCode(raw: string): PairingCode {
  const parsed = JSON.parse(raw) as {
    code: string;
    channelType: string;
    expiresAt: string;
    used: boolean;
  };
  return {
    code: parsed.code,
    channelType: parsed.channelType,
    expiresAt: new Date(parsed.expiresAt),
    used: parsed.used,
  };
}

/** Persisted per-sender failed-attempt window. */
interface PairingAttemptRecord {
  readonly count: number;
  readonly windowStartMs: number;
}

/** Parse a persisted attempt record, or an error when malformed. */
function parsePairingAttemptRecord(
  raw: string,
): Result<PairingAttemptRecord, string> {
  try {
    const rec = JSON.parse(raw) as Partial<PairingAttemptRecord>;
    if (
      typeof rec.count === "number" && typeof rec.windowStartMs === "number"
    ) {
      return {
        ok: true,
        value: { count: rec.count, windowStartMs: rec.windowStartMs },
      };
    }
    return { ok: false, error: "Pairing attempt record missing fields" };
  } catch {
    return { ok: false, error: "Pairing attempt record is not valid JSON" };
  }
}

/** Load the live failed-attempt window for a sender, resetting expired ones. */
async function loadPairingAttemptRecord(
  storage: StorageProvider,
  key: string,
  nowMs: number,
): Promise<PairingAttemptRecord> {
  const raw = await storage.get(key);
  if (raw === null) return { count: 0, windowStartMs: nowMs };
  const parsed = parsePairingAttemptRecord(raw);
  if (!parsed.ok) {
    // Fail closed: a corrupt counter locks the sender for one fresh window.
    log.warn("Pairing attempt record unreadable; locking sender for window", {
      operation: "loadPairingAttemptRecord",
      key,
      error: parsed.error,
    });
    const locked = { count: MAX_PAIRING_ATTEMPTS, windowStartMs: nowMs };
    await storage.set(key, JSON.stringify(locked));
    return locked;
  }
  if (nowMs - parsed.value.windowStartMs >= PAIRING_CODE_TTL_MS) {
    return { count: 0, windowStartMs: nowMs };
  }
  return parsed.value;
}

/** Build the lockout rejection, logging the denial at WARN. */
function rejectLockedOutPairingAttempt(opts: {
  readonly channelType: string;
  readonly platformUserId: string;
  readonly failedAttempts: number;
}): Result<PairingResult, string> {
  log.warn("Pairing verification locked out: attempt cap reached", {
    operation: "verifyCode",
    channelType: opts.channelType,
    platformUserId: opts.platformUserId,
    failedAttempts: opts.failedAttempts,
    maxAttempts: MAX_PAIRING_ATTEMPTS,
  });
  return {
    ok: false,
    error: "Pairing attempts exceeded — try again later",
  };
}

/** Record a failed attempt and warn with the sender identity. */
async function recordFailedPairingAttempt(opts: {
  readonly storage: StorageProvider;
  readonly attemptsKey: string;
  readonly attempts: PairingAttemptRecord;
  readonly channelType: string;
  readonly platformUserId: string;
  readonly error: string;
}): Promise<void> {
  const next: PairingAttemptRecord = {
    count: opts.attempts.count + 1,
    windowStartMs: opts.attempts.windowStartMs,
  };
  await opts.storage.set(opts.attemptsKey, JSON.stringify(next));
  log.warn("Pairing code verification failed", {
    operation: "verifyCode",
    channelType: opts.channelType,
    platformUserId: opts.platformUserId,
    error: opts.error,
    failedAttempts: next.count,
    maxAttempts: MAX_PAIRING_ATTEMPTS,
  });
}

/** Look up and validate a submitted code without consuming it. */
async function checkSubmittedPairingCode(opts: {
  readonly storage: StorageProvider;
  readonly code: string;
  readonly channelType: string;
  readonly nowMs: number;
}): Promise<Result<PairingCode, string>> {
  const raw = await opts.storage.get(
    `${PAIRING_PREFIX}${opts.channelType}:${opts.code}`,
  );
  if (raw === null) return { ok: false, error: "Invalid pairing code" };
  const pairingCode = deserializePairingCode(raw);
  if (pairingCode.channelType !== opts.channelType) {
    return { ok: false, error: "Channel type mismatch" };
  }
  if (pairingCode.used) {
    return { ok: false, error: "Pairing code already used" };
  }
  if (pairingCode.expiresAt.getTime() <= opts.nowMs) {
    return { ok: false, error: "Pairing code expired" };
  }
  return { ok: true, value: pairingCode };
}

/** Persist the linked pairing identity for a sender. */
async function persistLinkedPairing(
  storage: StorageProvider,
  result: PairingResult,
): Promise<void> {
  await storage.set(
    `${LINKED_PREFIX}${result.channelType}:${result.platformUserId}`,
    JSON.stringify({
      channelType: result.channelType,
      platformUserId: result.platformUserId,
      linkedAt: result.linkedAt.toISOString(),
    }),
  );
}

/** Mark a verified code as used and persist the linked identity. */
async function consumeVerifiedPairingCode(opts: {
  readonly storage: StorageProvider;
  readonly pairingCode: PairingCode;
  readonly platformUserId: string;
  readonly nowMs: number;
}): Promise<PairingResult> {
  const { storage, pairingCode } = opts;
  const channelType = pairingCode.channelType;
  const usedCode: PairingCode = { ...pairingCode, used: true };
  await storage.set(
    `${PAIRING_PREFIX}${channelType}:${pairingCode.code}`,
    serializePairingCode(usedCode),
  );
  await storage.set(
    `${PAIRING_PREFIX}pending:${channelType}`,
    serializePairingCode(usedCode),
  );
  const result: PairingResult = {
    channelType,
    platformUserId: opts.platformUserId,
    linkedAt: new Date(opts.nowMs),
  };
  await persistLinkedPairing(storage, result);
  return result;
}

/**
 * Create a PairingService backed by the given StorageProvider.
 *
 * @param storage - The storage provider to persist pairing codes.
 * @param options - Optional configuration (e.g. clock injection for tests).
 * @returns A PairingService instance.
 */
export function createPairingService(
  storage: StorageProvider,
  options?: PairingOptions,
): PairingService {
  const now = options?.now ?? (() => Date.now());

  return {
    async generateCode(channelType: string): Promise<PairingCode> {
      const code = generateSixDigitCode();
      const expiresAt = new Date(now() + PAIRING_CODE_TTL_MS);
      const pairingCode: PairingCode = {
        code,
        channelType,
        expiresAt,
        used: false,
      };

      // Store under pairing:<channelType>:<code> for lookup by code,
      // and pairing:pending:<channelType> for lookup by channel type.
      const codeKey = `${PAIRING_PREFIX}${channelType}:${code}`;
      const pendingKey = `${PAIRING_PREFIX}pending:${channelType}`;

      await storage.set(codeKey, serializePairingCode(pairingCode));
      await storage.set(pendingKey, serializePairingCode(pairingCode));

      return pairingCode;
    },

    async verifyCode(
      code: string,
      channelType: string,
      platformUserId: string,
    ): Promise<Result<PairingResult, string>> {
      const attemptsKey = `${ATTEMPTS_PREFIX}${channelType}:${platformUserId}`;
      const nowMs = now();
      const attempts = await loadPairingAttemptRecord(
        storage,
        attemptsKey,
        nowMs,
      );
      if (attempts.count >= MAX_PAIRING_ATTEMPTS) {
        return rejectLockedOutPairingAttempt({
          channelType,
          platformUserId,
          failedAttempts: attempts.count,
        });
      }
      const checked = await checkSubmittedPairingCode({
        storage,
        code,
        channelType,
        nowMs,
      });
      if (!checked.ok) {
        await recordFailedPairingAttempt({
          storage,
          attemptsKey,
          attempts,
          channelType,
          platformUserId,
          error: checked.error,
        });
        return checked;
      }
      const value = await consumeVerifiedPairingCode({
        storage,
        pairingCode: checked.value,
        platformUserId,
        nowMs,
      });
      await storage.delete(attemptsKey);
      return { ok: true, value };
    },

    async getLinkedUsers(channelType: string): Promise<string[]> {
      const prefix = `${LINKED_PREFIX}${channelType}:`;
      const keys = await storage.list(prefix);
      return keys.map((key) => key.slice(prefix.length)).filter((id) =>
        id.length > 0
      );
    },

    async getPending(channelType: string): Promise<PairingCode | null> {
      const pendingKey = `${PAIRING_PREFIX}pending:${channelType}`;
      const raw = await storage.get(pendingKey);

      if (raw === null) {
        return null;
      }

      const pairingCode = deserializePairingCode(raw);

      // Return null if the code is used or expired.
      if (pairingCode.used) {
        return null;
      }

      if (pairingCode.expiresAt.getTime() <= now()) {
        return null;
      }

      return pairingCode;
    },
  };
}
