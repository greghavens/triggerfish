/**
 * CWD tracking for the tool executor dispatch layer.
 *
 * When the agent runs `cd <dir>` via run_command, this module detects
 * the directory change and adjusts subsequent file tool paths so they
 * resolve relative to the agent's mental working directory — not the
 * workspace root.
 *
 * All functions are pure (except syncCwdAfterCommand which mutates
 * the tracker). No imports outside this file.
 *
 * @module
 */

// ─── Tracker state ───────────────────────────────────────────────────────────

/** Mutable CWD state — one per tool executor instance. */
export interface CwdTracker {
  /** Workspace-relative working directory. `"."` means workspace root. */
  workingDir: string;
}

/** Create a fresh CWD tracker at the workspace root. */
export function createCwdTracker(): CwdTracker {
  return { workingDir: "." };
}

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Normalize a workspace-relative POSIX path — resolve `.` and `..` segments.
 *
 * Returns `"."` for the root, never a leading `/` or trailing `/`.
 * Returns `null` if the path escapes the workspace root (too many `..`).
 */
export function normalizePosixRelative(path: string): string | null {
  const segments = path.split("/");
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.length === 0 ? "." : stack.join("/");
}

/**
 * Prepend the tracked CWD to a relative path.
 *
 * - Path starts with `/` → return unchanged (workspace-absolute).
 * - Tracker is `"."` → return unchanged (at root, no-op).
 * - Otherwise → normalize `tracker.workingDir + "/" + path`.
 */
export function resolveAgainstCwd(
  tracker: CwdTracker,
  path: string,
): string {
  if (path.startsWith("/")) return path;
  if (tracker.workingDir === ".") return path;
  const combined = tracker.workingDir + "/" + path;
  return normalizePosixRelative(combined) ?? path;
}

// ─── cd detection ────────────────────────────────────────────────────────────

/**
 * Parse a leading `cd <dir>` from a shell command string.
 *
 * Only detects `cd` at the **start** of the command (conservative).
 * Returns the target directory string, or `null` if no cd detected.
 */
export function extractCdTarget(command: string): string | null {
  const match = command.match(/^cd\s+(\S+)\s*(?:$|&&|;)/);
  return match ? match[1] : null;
}

/**
 * Compute the new CWD after a `cd <target>` relative to the current CWD.
 *
 * - `~` or `~/…` → `"."` (home = workspace root)
 * - Absolute (`/foo`) → strip leading `/`, treat as workspace-relative
 * - Relative → join with currentCwd, normalize
 *
 * Returns `null` if the result would escape the workspace root.
 */
export function computeNewCwd(
  currentCwd: string,
  cdTarget: string,
): string | null {
  if (cdTarget === "~" || cdTarget === "~/") return ".";
  if (cdTarget.startsWith("~/")) {
    return normalizePosixRelative(cdTarget.slice(2));
  }
  if (cdTarget.startsWith("/")) {
    const stripped = cdTarget.slice(1);
    return stripped.length === 0 ? "." : normalizePosixRelative(stripped);
  }
  const base = currentCwd === "." ? cdTarget : currentCwd + "/" + cdTarget;
  return normalizePosixRelative(base);
}

// ─── Tracker update ──────────────────────────────────────────────────────────

/**
 * Update the CWD tracker after a run_command completes.
 *
 * Only updates if the command started with `cd`, the command succeeded
 * (exit code 0), and the resulting path stays within the workspace.
 */
export function syncCwdAfterCommand(
  tracker: CwdTracker,
  command: string,
  exitCode: number,
): void {
  if (exitCode !== 0) return;
  const target = extractCdTarget(command);
  if (target === null) return;
  const newCwd = computeNewCwd(tracker.workingDir, target);
  if (newCwd === null) return;
  tracker.workingDir = newCwd;
}

/** @deprecated Use syncCwdAfterCommand instead */
export const updateCwdAfterCommand = syncCwdAfterCommand;
