/** Resolve named Sentinel data paths under an operator-owned directory. */

import { basename, dirname, join, resolve } from "@std/path";
import { sentinelSnapshotPath } from "./paths.ts";

const MAX_DIRECTORY_ENTRIES = 1024;
export const MAX_SENTINEL_NAMED_CASES = 128;
const CASE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export function isSentinelCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID.test(value) &&
    !WINDOWS_RESERVED.test(value);
}

function statIfPresent(path: string): Deno.FileInfo | undefined {
  try {
    return Deno.lstatSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

function isOperatorDirectory(info: Deno.FileInfo): boolean {
  return info.isDirectory && !info.isSymlink &&
    (info.mode === null || (info.mode & 0o022) === 0);
}

function assertOperatorDirectory(path: string): boolean {
  const info = statIfPresent(path);
  if (!info) return false;
  if (!isOperatorDirectory(info)) {
    throw new Error(
      "Sentinel named case requires an operator-controlled directory",
    );
  }
  return true;
}

function casesRoot(baseDir: string): string {
  const data = join(baseDir, "data");
  assertOperatorDirectory(data);
  const root = join(data, "sentinel-cases");
  assertOperatorDirectory(root);
  return root;
}

/** Keep named cases isolated alongside the existing main snapshot. */
export function resolveSentinelCasePath(
  baseDir: string,
  caseId = "main",
): string {
  if (caseId === "main") return sentinelSnapshotPath(baseDir);
  if (!isSentinelCaseId(caseId)) throw new Error("Invalid Sentinel case ID");
  const directory = join(casesRoot(baseDir), caseId);
  assertOperatorDirectory(directory);
  const snapshot = join(directory, "sentinel.json");
  const existing = statIfPresent(snapshot);
  if (
    existing &&
    (!existing.isFile || existing.isSymlink || (existing.nlink ?? 1) !== 1)
  ) {
    throw new Error("Sentinel named case snapshot must be a regular file");
  }
  return snapshot;
}

/** Identify canonical case paths for features that consult the shared archive. */
export function locateSentinelCase(snapshotPath: string) {
  const path = resolve(snapshotPath);
  if (basename(path) !== "sentinel.json") return undefined;
  const directory = dirname(path);
  const parent = dirname(directory);
  if (basename(directory) === "data") {
    return { baseDir: parent, caseId: "main" };
  }
  const caseId = basename(directory);
  if (
    basename(parent) !== "sentinel-cases" ||
    basename(dirname(parent)) !== "data" || !isSentinelCaseId(caseId) ||
    caseId === "main"
  ) return undefined;
  const baseDir = dirname(dirname(parent));
  return resolveSentinelCasePath(baseDir, caseId) === path
    ? { baseDir, caseId }
    : undefined;
}

/** List well-formed directories only. A case can exist before evidence arrives. */
export function listSentinelCaseIds(baseDir: string): string[] {
  const root = casesRoot(baseDir);
  const found = [];
  let scanned = 0;
  try {
    for (const entry of Deno.readDirSync(root)) {
      if (++scanned > MAX_DIRECTORY_ENTRIES) {
        throw new Error("Sentinel case directory scan limit exceeded");
      }
      if (
        entry.name === "main" || !isSentinelCaseId(entry.name) ||
        !entry.isDirectory || entry.isSymlink
      ) {
        continue;
      }
      const directory = statIfPresent(join(root, entry.name));
      if (!directory || !isOperatorDirectory(directory)) continue;
      if (found.length >= MAX_SENTINEL_NAMED_CASES) {
        throw new Error("Sentinel named case limit exceeded");
      }
      found.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found.sort();
}
