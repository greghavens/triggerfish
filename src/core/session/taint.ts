/**
 * Taint propagation logic.
 *
 * Updates session taint to `max(current, dataClassification)`.
 * Taint can only escalate, never decrease within a session.
 * Taint history is preserved for audit.
 *
 * @module
 */

import type { ClassificationLevel } from "../types/classification.ts";
import type { SessionState } from "../types/session.ts";
import { escalateTaint } from "../types/session.ts";

/**
 * Propagate taint from a data access into the session.
 *
 * Sets session taint to `max(current, dataClassification)`.
 * Returns a new session — the original is not mutated.
 */
export function propagateTaint(
  session: SessionState,
  dataClassification: ClassificationLevel,
  reason: string,
): SessionState {
  return escalateTaint(session, dataClassification, reason);
}
