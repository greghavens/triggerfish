/** Search exact authorized files from a sandbox-generated directory snapshot. */

import { compareClassification } from "../../../core/types/classification.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import { contentSearchArgs } from "../../../exec/sandbox/search_options.ts";
import type { WorkspaceFileMatch } from "../../../exec/sandbox/workspace_glob.ts";

const MAX_SEARCH_FILES = 128;
const MAX_RESULT_CHARS = 24_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_OFFSET = 10_000;

/** Scans only admitted paths and paginates the authorized result entries. */
export async function searchWorkspaceContents(
  input: Record<string, unknown>,
  sandbox: FilesystemSandbox,
  authorize: NonNullable<ToolExecutionContext["authorizeRecursiveSearchFile"]>,
  isManagedPath: (path: string) => boolean,
): Promise<string> {
  const validation = contentSearchArgs(input, input.pattern as string, ".");
  if (!validation.ok) return `Error: ${validation.error}`;
  const { offset = 0, limit = DEFAULT_PAGE_SIZE, file_glob = "*" } = input;
  if (
    typeof offset !== "number" || !Number.isSafeInteger(offset) ||
    offset < 0 || offset > MAX_OFFSET ||
    typeof limit !== "number" || !Number.isSafeInteger(limit) ||
    limit < 1 || limit > DEFAULT_PAGE_SIZE ||
    typeof file_glob !== "string" || file_glob.includes("/") ||
    file_glob.includes("\\")
  ) return "Error: Invalid recursive search filter or page.";

  const listing = await sandbox.request({
    id: "",
    op: "glob",
    args: { path: input.path, pattern: `**/${file_glob}` },
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
  const pack = (nextOffset?: number) =>
    JSON.stringify({
      matches: page,
      ...(nextOffset !== undefined && { nextOffset }),
      _classification: classification,
    });
  for (const { path } of files) {
    // grep emits line-delimited records. Keep candidate names unambiguous.
    // deno-lint-ignore no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(path) || isManagedPath(path)) continue;
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
    if (!result.ok || !result.result || result.result === "No matches found.") {
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
