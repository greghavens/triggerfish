/** Search exact authorized files from a sandbox-generated directory snapshot. */

import { compareClassification } from "../../../core/types/classification.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import { contentSearchArgs } from "../../../exec/sandbox/search_options.ts";
import { isSearchFileType } from "../../../exec/sandbox/search_file_types.ts";
import type { WorkspaceFileMatch } from "../../../exec/sandbox/workspace_glob.ts";

const MAX_SEARCH_FILES = 128;
const MAX_RESULT_CHARS = 24_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_OFFSET = 10_000;

function hasControlCharacters(path: string): boolean {
  // Search output has one record per line.
  // deno-lint-ignore no-control-regex
  return /[\u0000-\u001f\u007f]/u.test(path);
}

/** Preserve the legacy line format after admitting exact filename matches. */
export async function searchWorkspaceNames(
  input: Readonly<Record<string, unknown>>,
  sandbox: FilesystemSandbox,
  authorize: NonNullable<ToolExecutionContext["authorizeRecursiveSearchFile"]>,
  classify: NonNullable<
    ToolExecutionContext["classifyRecursiveSearchResponse"]
  >,
  isManagedPath: (path: string) => boolean,
): Promise<string> {
  const response = await sandbox.request({
    id: "",
    op: "search",
    args: { path: input.path, pattern: input.pattern, enumerate_names: true },
  });
  if (!response.ok || !response.result) {
    return "Error: Could not enumerate the requested workspace path.";
  }
  const names: string[] = [];
  let classification: ClassificationLevel = "PUBLIC";
  for (const path of JSON.parse(response.result) as string[]) {
    if (hasControlCharacters(path) || isManagedPath(path)) continue;
    const match = await authorize(path);
    if (!match) continue;
    names.push(path);
    if (compareClassification(match.classification, classification) > 0) {
      classification = match.classification;
    }
  }
  classify(classification);
  return names.length ? names.join("\n") : "No files found matching pattern.";
}

/** Scans only admitted paths and paginates the authorized result entries. */
export async function searchWorkspaceContents(
  input: Record<string, unknown>,
  sandbox: FilesystemSandbox,
  authorize: NonNullable<ToolExecutionContext["authorizeRecursiveSearchFile"]>,
  isManagedPath: (path: string) => boolean,
  classifyLegacyResponse?:
    ToolExecutionContext["classifyRecursiveSearchResponse"],
): Promise<string> {
  const validation = contentSearchArgs(input, input.pattern as string, ".");
  if (!validation.ok) return `Error: ${validation.error}`;
  const { offset = 0, limit = DEFAULT_PAGE_SIZE, file_glob = "*", file_type } =
    input;
  if (
    typeof offset !== "number" || !Number.isSafeInteger(offset) ||
    offset < 0 || offset > MAX_OFFSET ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > DEFAULT_PAGE_SIZE ||
    typeof file_glob !== "string" || file_glob.includes("/") ||
    file_glob.includes("\\") ||
    (file_type !== undefined && !isSearchFileType(file_type))
  ) return "Error: Invalid recursive search filter or page.";

  const listing = await sandbox.request({
    id: "",
    op: "glob",
    args: { path: input.path, pattern: `**/${file_glob}`, file_type },
  });
  if (!listing.ok || !listing.result) {
    return "Error: Could not enumerate the requested workspace directory.";
  }
  const files = (JSON.parse(listing.result) as WorkspaceFileMatch[]).sort(
    (left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  let classification: ClassificationLevel = "PUBLIC";
  let seen = 0;
  let chars = 0;
  let scanned = 0;
  const page: string[] = [];
  const pack = (nextOffset?: number) => {
    if (classifyLegacyResponse) {
      classifyLegacyResponse(classification);
      if (!page.length) return "No matches found.";
      if (nextOffset !== undefined) {
        page.push(
          `More matches. Continue with recursive: true and offset: ${nextOffset}.`,
        );
      }
      return page.join("\n");
    }
    return JSON.stringify({
      matches: page,
      ...(nextOffset !== undefined && { nextOffset }),
      _classification: classification,
    });
  };
  for (const { path } of files) {
    if (hasControlCharacters(path) || isManagedPath(path)) continue;
    const file = await authorize(path);
    if (!file) continue;
    if (++scanned > MAX_SEARCH_FILES) {
      return "Error: Too many permitted files. Choose a narrower search.";
    }
    const result = await sandbox.request({
      id: "",
      op: "search",
      args: {
        ...input,
        file_glob: undefined,
        exact_file: true,
        path: file.path,
      },
    });
    if (!result.ok) {
      return input.multiline === true
        ? "Error: Could not run multiline search on an authorized file. Check the RE2 pattern and file size."
        : "Error: Could not search an authorized workspace file.";
    }
    if (!result.result || result.result === "No matches found.") {
      continue;
    }
    if (compareClassification(file.classification, classification) > 0) {
      classification = file.classification;
    }
    for (const line of result.result.split("\n")) {
      if (seen++ < offset) continue;
      if (page.length >= limit || chars + line.length > MAX_RESULT_CHARS) {
        if (!page.length) {
          return "Error: A matching line exceeds the page limit.";
        }
        return pack(seen - 1);
      }
      page.push(line);
      chars += line.length + 1;
    }
  }
  return pack();
}
