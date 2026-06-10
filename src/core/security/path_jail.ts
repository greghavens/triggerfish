/**
 * Path jail utilities — enforce filesystem containment boundaries.
 *
 * Fixes the startsWith prefix-ambiguity bug present in both workspace.ts and
 * filesystem/server.ts: `path.startsWith("/jail/foo")` incorrectly accepts
 * "/jail/foomalicious". The separator-aware check ensures only true path
 * descendants are accepted.
 *
 * @module
 */

import { basename, dirname, resolve } from "@std/path";
import type { Result } from "../types/classification.ts";
import { createLogger } from "../logger/logger.ts";

const log = createLogger("security");

/**
 * Check whether resolvedPath is strictly within jailDir.
 *
 * Prevents prefix-ambiguity: "/workspaces/foomalicious" passes a naive
 * `startsWith("/workspaces/foo")` check but is NOT within that jail.
 * This function requires a path separator after the jail root or an exact match.
 *
 * @example
 * isWithinJail("/jail/child", "/jail")      → true
 * isWithinJail("/jail",       "/jail")      → true
 * isWithinJail("/jailbreak",  "/jail")      → false
 * isWithinJail("/other/path", "/jail")      → false
 */
export function isWithinJail(resolvedPath: string, jailDir: string): boolean {
  return resolvedPath === jailDir || resolvedPath.startsWith(jailDir + "/");
}

/**
 * Resolve a user-supplied relative path against base and assert it stays within jailDir.
 *
 * Handles `../` traversal and absolute path injection — both produce a resolved
 * path outside the jail, which is rejected.
 *
 * @param base     - Absolute base directory for resolution
 * @param relative - User-supplied path segment (may contain ../)
 * @param jailDir  - Absolute jail root (defaults to base)
 */
export function resolveWithinJail(
  base: string,
  relative: string,
  jailDir?: string,
): Result<string, string> {
  const jail = jailDir ?? base;
  const resolved = resolve(base, relative);
  if (!isWithinJail(resolved, jail)) {
    return {
      ok: false,
      error: `Path traversal blocked: "${relative}" escapes jail "${jail}"`,
    };
  }
  return { ok: true, value: resolved };
}

/** Real-path a single existing path, or null when it does not exist or fails. */
function resolveExistingRealPath(path: string): string | null {
  try {
    return Deno.realPathSync(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      log.debug("Real path resolution failed during jail check", {
        path,
        err,
      });
    }
    return null;
  }
}

/**
 * Walk up from a lexically-resolved path to its deepest EXISTING ancestor
 * and return that ancestor's real (symlink-resolved) path plus the
 * not-yet-existing suffix segments below it. Null when nothing resolves.
 */
function realPathDeepestExistingAncestor(
  resolvedPath: string,
): { readonly realPath: string; readonly missingSuffix: string[] } | null {
  let current = resolvedPath;
  const missingSuffix: string[] = [];
  while (true) {
    const real = resolveExistingRealPath(current);
    if (real !== null) return { realPath: real, missingSuffix };
    const parent = dirname(current);
    if (parent === current) return null;
    missingSuffix.unshift(basename(current));
    current = parent;
  }
}

/**
 * Check that targetPath stays within jailDir on the REAL filesystem.
 *
 * isWithinJail is lexical-only: a symlink inside the jail pointing outside
 * passes the lexical check while the OS follows the link out. This check
 * re-validates containment after resolving symlinks. Because the target may
 * not exist yet (e.g. a write creating a new file), the deepest existing
 * ancestor is real-pathed and the not-yet-existing suffix must contain no
 * ".." segment. The jail itself is also real-pathed (it may legitimately
 * live behind a symlinked base directory); fails closed when it cannot be.
 */
export function isRealPathWithinJail(
  targetPath: string,
  jailDir: string,
): boolean {
  const realJail = resolveExistingRealPath(jailDir);
  if (realJail === null) {
    log.warn("Path jail check failed: jail directory cannot be real-pathed", {
      jailDir,
    });
    return false;
  }
  const ancestor = realPathDeepestExistingAncestor(resolve(targetPath));
  if (ancestor === null || ancestor.missingSuffix.includes("..")) return false;
  const within = isWithinJail(ancestor.realPath, realJail);
  if (!within) {
    log.warn("Path jail escape blocked after symlink resolution", {
      targetPath,
      realPath: ancestor.realPath,
      jailDir: realJail,
    });
  }
  return within;
}
