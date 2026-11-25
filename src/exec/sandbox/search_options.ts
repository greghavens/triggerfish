/** Shared validation and argument construction for workspace content search. */
import type { Result } from "../../core/types/classification.ts";

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
  const { file_glob, ignore_case, line_numbers, context } = input;
  if (
    (file_glob !== undefined &&
      (typeof file_glob !== "string" || !file_glob ||
        file_glob.includes("\0"))) ||
    (ignore_case !== undefined && typeof ignore_case !== "boolean") ||
    (line_numbers !== undefined && typeof line_numbers !== "boolean") ||
    (context !== undefined &&
      (mode !== "content" || typeof context !== "number" ||
        !Number.isSafeInteger(context) || context < 0 || context > 20))
  ) {
    return { ok: false, error: "Invalid content search options." };
  }

  const args = ["-rH"];
  if (mode === "files_with_matches") args.push("-l");
  if (mode === "content" && line_numbers !== false) args.push("-n");
  if (mode === "count") args.push("-c");
  if (ignore_case === true) args.push("-i");
  if (typeof context === "number") args.push("-C", String(context));
  if (typeof file_glob === "string") args.push(`--include=${file_glob}`);
  args.push("--", pattern, path);
  return { ok: true, value: args };
}
