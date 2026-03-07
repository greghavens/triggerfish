/**
 * Per-session skill context tracker.
 *
 * Tracks the currently active skill for a session, enabling runtime
 * enforcement of skill capability declarations (requires_tools,
 * network_domains, classification_ceiling).
 *
 * @module
 */

import type { Skill } from "./loader.ts";

/** Tracks the currently active skill for a session. */
export interface SkillContextTracker {
  /** Set the currently active skill, or null to deactivate. */
  setActive(skill: Skill | null): void;
  /** Get the currently active skill, or null if none. */
  getActive(): Skill | null;
}

/**
 * Create a per-session skill context tracker.
 *
 * Each orchestrator/session instance should have its own tracker.
 * The tracker is a simple closure-based mutable state holder.
 */
export function createSkillContextTracker(): SkillContextTracker {
  let activeSkill: Skill | null = null;
  return {
    setActive(skill: Skill | null): void {
      activeSkill = skill;
    },
    getActive(): Skill | null {
      return activeSkill;
    },
  };
}
