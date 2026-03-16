/**
 * Browser profile watermark — tracks highest classification at which
 * an agent's browser profile has been used.
 *
 * Watermarks only escalate. A lower-tainted session cannot use a profile
 * that has previously been used at a higher classification level.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import {
  canFlowTo,
  maxClassification,
} from "../../../core/types/classification.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("security");

/** Persistent watermark state for a browser profile. */
export interface ProfileWatermark {
  /** The agent whose profile this watermark tracks. */
  readonly agentId: string;
  /** The highest classification level at which this profile has been used. */
  readonly level: ClassificationLevel;
}

/**
 * Derive the storage key for a given agent's browser profile watermark.
 */
export function watermarkKey(agentId: string): string {
  return `browser:profile:${agentId}:watermark`;
}

/**
 * Read the current watermark for an agent's browser profile.
 *
 * @returns The current classification watermark, or null for a fresh profile.
 */
export async function retrieveWatermark(
  storage: StorageProvider,
  agentId: string,
): Promise<ClassificationLevel | null> {
  const raw = await storage.get(watermarkKey(agentId));
  if (raw === null) return null;
  return raw as ClassificationLevel;
}

/**
 * Escalate a profile's watermark to at least `sessionTaint`.
 *
 * If the profile has no watermark yet, it is set to `sessionTaint`.
 * If the existing watermark is already >= `sessionTaint`, this is a no-op.
 *
 * @returns The effective (post-escalation) watermark level.
 */
export async function escalateWatermark(
  storage: StorageProvider,
  agentId: string,
  sessionTaint: ClassificationLevel,
): Promise<ClassificationLevel> {
  const current = await retrieveWatermark(storage, agentId);
  const effective = current === null
    ? sessionTaint
    : maxClassification(current, sessionTaint);

  if (current !== null && effective !== current) {
    log.warn("Browser profile watermark escalated", {
      agentId,
      from: current,
      to: effective,
    });
  }

  await storage.set(watermarkKey(agentId), effective);
  return effective;
}

/**
 * Check whether a session at `sessionTaint` may use a profile
 * with the given `profileWatermark`.
 *
 * The profile watermark must be able to flow to the session's taint
 * (i.e. session taint >= profile watermark).
 */
export function canAccessProfile(
  profileWatermark: ClassificationLevel,
  sessionTaint: ClassificationLevel,
): boolean {
  return canFlowTo(profileWatermark, sessionTaint);
}

/** @deprecated Use retrieveWatermark instead */
export const getWatermark = retrieveWatermark;
