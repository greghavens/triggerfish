/** Shared validation and argument construction for workspace content search. */
import type { Result } from "../../core/types/classification.ts";

/** Internal response requesting an individually authorized directory traversal. */
export const SEARCH_DIRECTORY_REQUIRES_AUTHORIZATION =
  "Error: Directory content search requires per-file authorization.";

export function contentSearchArgs(
  input: Readonly<Record<string, unknown>>,
  pattern: string,
  path: string,
): Result<string[], string> {
  const mode = input.output_mode ?? "files_with_matches";
  if (
    mode !== "files_with_matches" && mode !== "content" && mode !== "count"
  ) {
    return { ok: false, error: "Invalid content search output_mode." };
  }
  const { file_glob, ignore_case, line_numbers, context, before, after } =
    input;
  if (
    (file_glob !== undefined &&
      (typeof file_glob !== "string" || !file_glob ||
        file_glob.includes("\0"))) ||
    (ignore_case !== undefined && typeof ignore_case !== "boolean") ||
    (input.multiline !== undefined && typeof input.multiline !== "boolean") ||
    (line_numbers !== undefined && typeof line_numbers !== "boolean") ||
    [context, before, after].some((value) =>
      value !== undefined &&
      (mode !== "content" || typeof value !== "number" ||
        !Number.isSafeInteger(value) || value < 0 || value > 20)
    )
  ) {
    return { ok: false, error: "Invalid content search options." };
  }

  const args = ["-rH"];
  if (mode === "files_with_matches") args.push("-l");
  if (mode === "content" && line_numbers !== false) args.push("-n");
  if (mode === "count") args.push("-c");
  if (ignore_case === true) args.push("-i");
  if (typeof context === "number") {
    args.push("-C", String(context));
  } else {
    if (typeof before === "number") args.push("-B", String(before));
    if (typeof after === "number") args.push("-A", String(after));
  }
  if (typeof file_glob === "string") args.push(`--include=${file_glob}`);
  args.push("--", pattern, path);
  return { ok: true, value: args };
}
