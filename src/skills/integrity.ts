/**
 * Skill content integrity verification.
 *
 * Computes SHA-256 hashes of SKILL.md content at install time and
 * verifies them at load time to detect tampering of marketplace skills.
 *
 * Uses the Web Crypto API (available in Deno) for hashing.
 *
 * @module
 */

import { join } from "@std/path";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("skill-integrity");

/** Skill hash record shape for persistent install-time storage. */
export interface SkillHashRecord {
  /** Name of the skill. */
  readonly skillName: string;
  /** SHA-256 hex digest of SKILL.md content. */
  readonly contentHash: string;
  /** ISO 8601 timestamp when the hash was recorded. */
  readonly recordedAt: string;
  /** Source of the skill installation. */
  readonly source: "reef" | "local";
}

/**
 * Compute SHA-256 hex digest of skill content.
 *
 * Uses the Web Crypto API for consistent cross-platform hashing.
 */
export async function computeSkillHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Record the hash of an installed skill.
 *
 * Writes .skill-hash.json alongside the skill's SKILL.md.
 * Called at install time (e.g. when downloading from The Reef).
 */
export async function recordSkillHash(
  skillDir: string,
  skillName: string,
  contentHash: string,
  source: "reef" | "local",
): Promise<void> {
  const record: SkillHashRecord = {
    skillName,
    contentHash,
    recordedAt: new Date().toISOString(),
    source,
  };
  const hashPath = join(skillDir, ".skill-hash.json");
  await Deno.writeTextFile(hashPath, JSON.stringify(record, null, 2));
  log.debug("Skill hash recorded", {
    operation: "recordSkillHash",
    skillName,
    hashPath,
  });
}

/**
 * Load stored hash record for a skill directory.
 *
 * Returns null if no hash record exists (e.g. bundled skills, pre-hash installs).
 */
export async function loadSkillHashRecord(
  skillDir: string,
): Promise<SkillHashRecord | null> {
  const hashPath = join(skillDir, ".skill-hash.json");
  try {
    const content = await Deno.readTextFile(hashPath);
    return JSON.parse(content) as SkillHashRecord;
  } catch (err: unknown) {
    log.debug("Skill hash record not loadable", {
      operation: "loadSkillHashRecord",
      hashPath,
      err,
    });
    return null;
  }
}

/**
 * Verify a skill's current content against its stored hash.
 *
 * Returns null if no hash record exists (no enforcement for un-hashed skills).
 * Returns true if hash matches, false if tampered.
 */
export async function verifySkillIntegrity(
  skillDir: string,
  currentHash: string,
): Promise<boolean | null> {
  const record = await loadSkillHashRecord(skillDir);
  if (!record) return null;

  const matches = record.contentHash === currentHash;
  if (!matches) {
    log.warn("Skill content hash mismatch detected", {
      operation: "verifySkillIntegrity",
      skillName: record.skillName,
      expectedHash: record.contentHash,
      actualHash: currentHash,
    });
  }
  return matches;
}
