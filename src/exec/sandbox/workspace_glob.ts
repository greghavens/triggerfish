/** Bounded, symlink-free enumeration for filesystem metadata reads. */

import { resolveSafePath, toRelativePath } from "./worker_paths.ts";

export interface WorkspaceFileMatch {
  readonly path: string;
  readonly modifiedAt: number | null;
}

const maxVisitedEntries = 10_000;
const maxMatches = 2_000;

export class WorkspaceGlobError extends Error {}

function globSegments(pattern: string): readonly string[] {
  const clean = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  if (
    !clean || clean.length > 256 || clean.startsWith("/") ||
    /^[A-Za-z]:/.test(clean) || clean.includes("\\") || clean.includes("\0")
  ) throw new WorkspaceGlobError("Supply a relative workspace glob pattern.");
  const segments = clean.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) {
    throw new WorkspaceGlobError(
      "Supply a relative workspace glob pattern without dot or parent segments.",
    );
  }
  if (segments.some((part) => part !== "**" && part.includes("**"))) {
    throw new WorkspaceGlobError(
      "Globstar must occupy a complete path segment.",
    );
  }
  return segments;
}

/** Match one path segment, using bounded backtracking over one star at a time. */
function matchesSegment(pattern: string, name: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  let patternIndex = 0;
  let nameIndex = 0;
  let star = -1;
  let consumedAtStar = 0;
  while (nameIndex < name.length) {
    if (pattern[patternIndex] === "*") {
      star = patternIndex++;
      consumedAtStar = nameIndex;
    } else if (
      pattern[patternIndex] === "?" || pattern[patternIndex] === name[nameIndex]
    ) {
      patternIndex++;
      nameIndex++;
    } else if (star >= 0) {
      patternIndex = star + 1;
      nameIndex = ++consumedAtStar;
    } else return false;
  }
  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

function includeZeroSegments(
  states: Set<number>,
  pattern: readonly string[],
  state: number,
): void {
  states.add(state);
  while (pattern[state] === "**") states.add(++state);
}

function advance(
  pattern: readonly string[],
  states: ReadonlySet<number>,
  name: string,
): Set<number> {
  const next = new Set<number>();
  for (const index of states) {
    const segment = pattern[index];
    if (segment === "**" && !name.startsWith(".")) {
      includeZeroSegments(next, pattern, index);
    } else if (segment && matchesSegment(segment, name)) {
      includeZeroSegments(next, pattern, index + 1);
    }
  }
  return next;
}

export async function enumerateWorkspaceFiles(
  workspaceRoot: string,
  root: string,
  pattern: string,
  extensions?: readonly string[],
): Promise<readonly WorkspaceFileMatch[]> {
  const segments = globSegments(pattern);
  const requested = resolveSafePath(root, workspaceRoot);
  if (!requested.ok) {
    throw new WorkspaceGlobError("Glob directory is outside the workspace.");
  }
  const realWorkspace = await Deno.realPath(workspaceRoot);
  const relativeRoot = toRelativePath(requested.path, workspaceRoot);
  const expectedRoot = relativeRoot === "."
    ? realWorkspace
    : `${realWorkspace}/${relativeRoot}`;
  if (
    await Deno.realPath(requested.path) !== expectedRoot ||
    !(await Deno.lstat(expectedRoot)).isDirectory
  ) {
    throw new WorkspaceGlobError(
      "Glob requires a canonical workspace directory.",
    );
  }

  const matches: WorkspaceFileMatch[] = [];
  const initial = new Set<number>();
  includeZeroSegments(initial, segments, 0);
  const pending = [{ directory: expectedRoot, states: initial }];
  let visited = 0;
  for (const { directory, states } of pending) {
    if (await Deno.realPath(directory) !== directory) continue;
    for await (const entry of Deno.readDir(directory)) {
      if (++visited > maxVisitedEntries) {
        throw new WorkspaceGlobError(
          "Glob scan exceeded its limit. Choose a narrower directory or pattern.",
        );
      }
      if (entry.isSymlink) continue;
      const next = advance(segments, states, entry.name);
      if (!next.size) continue;
      const path = `${directory}/${entry.name}`;
      if (
        entry.isDirectory && [...next].some((state) => state < segments.length)
      ) {
        pending.push({ directory: path, states: next });
      }
      if (!entry.isFile || !next.has(segments.length)) continue;
      if (extensions) {
        const name = entry.name.toLowerCase();
        if (!extensions.some((extension) => name.endsWith(`.${extension}`))) {
          continue;
        }
      }
      const info = await Deno.lstat(path);
      if (!info.isFile || await Deno.realPath(path) !== path) continue;
      matches.push({
        path: toRelativePath(path, realWorkspace),
        modifiedAt: info.mtime?.getTime() ?? null,
      });
      if (matches.length > maxMatches) {
        throw new WorkspaceGlobError(
          "Glob matched too many files. Choose a narrower pattern.",
        );
      }
    }
  }
  return matches.sort((left, right) =>
    (right.modifiedAt ?? -Infinity) - (left.modifiedAt ?? -Infinity) ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}
