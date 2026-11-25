/** Bounded, symlink-free enumeration for filesystem metadata reads. */

import { resolveSafePath, toRelativePath } from "./worker_paths.ts";
import { RE2JS } from "re2js";

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

type PathSegment = "**" | ((name: string) => boolean);

const literal = (value: string) => `\\x{${value.codePointAt(0)!.toString(16)}}`;

/** Compile a single glob segment into a bounded, anchored RE2 matcher. */
function compileSegment(segment: string): PathSegment {
  if (segment === "**") return segment;
  const points = Array.from(segment);
  let expression = "";
  for (let i = 0; i < points.length; i++) {
    const value = points[i];
    if (value === "*") expression += ".*";
    else if (value === "?") expression += ".";
    else if (value === "[") {
      let first = i + 1;
      const negated = points[first] === "!" || points[first] === "^";
      if (negated) first++;
      const end = points.indexOf("]", first + 1);
      if (end <= first) {
        throw new WorkspaceGlobError("Invalid glob character class.");
      }
      const contents = points.slice(first, end).map((point, index, list) =>
        point === "-" && index > 0 && index < list.length - 1
          ? "-"
          : literal(point)
      ).join("");
      expression += `[${negated ? "^" : ""}${contents}]`;
      i = end;
    } else expression += literal(value);
  }
  try {
    const matcher = RE2JS.compile(expression, RE2JS.DOTALL);
    return (name) =>
      (!name.startsWith(".") || segment.startsWith(".")) &&
      matcher.matches(name);
  } catch {
    throw new WorkspaceGlobError("Invalid glob character class.");
  }
}

function includeZeroSegments(
  states: Set<number>,
  pattern: readonly PathSegment[],
  state: number,
): void {
  states.add(state);
  while (pattern[state] === "**") states.add(++state);
}

function advance(
  pattern: readonly PathSegment[],
  states: ReadonlySet<number>,
  name: string,
): Set<number> {
  const next = new Set<number>();
  for (const index of states) {
    const segment = pattern[index];
    if (segment === "**" && !name.startsWith(".")) {
      includeZeroSegments(next, pattern, index);
    } else if (typeof segment === "function" && segment(name)) {
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
  const segments = globSegments(pattern).map(compileSegment);
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
