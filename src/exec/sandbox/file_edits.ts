/** Validate and apply the same file edit contract in both filesystem executors. */
import type { Result } from "../../core/types/classification.ts";

interface FileEdit {
  readonly old_text: string;
  readonly new_text: string;
}

export function parseFileEdits(
  input: Readonly<Record<string, unknown>>,
): Result<readonly FileEdit[], string> {
  const multiple = input.edits !== undefined;
  if (
    multiple && (input.old_text !== undefined || input.new_text !== undefined)
  ) {
    return {
      ok: false,
      error: "Supply either edits or old_text and new_text.",
    };
  }
  const entries = multiple ? input.edits : [input];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) {
    return { ok: false, error: "edit_file requires 1 to 32 edits." };
  }
  const edits: FileEdit[] = [];
  for (const entry of entries) {
    if (
      !entry || typeof entry !== "object" ||
      typeof entry.old_text !== "string" || entry.old_text.length === 0
    ) {
      return {
        ok: false,
        error: "edit_file requires a non-empty 'old_text' argument (string).",
      };
    }
    if (typeof entry.new_text !== "string") {
      return {
        ok: false,
        error: "edit_file requires a 'new_text' argument (string).",
      };
    }
    edits.push({ old_text: entry.old_text, new_text: entry.new_text });
  }
  return { ok: true, value: edits };
}

export function applyFileEdits(
  content: string,
  edits: readonly FileEdit[],
): Result<string, string> {
  let updated = content;
  for (const [index, { old_text, new_text }] of edits.entries()) {
    const count = updated.split(old_text).length - 1;
    const prefix = edits.length > 1 ? `Edit ${index + 1}: ` : "";
    if (count === 0) {
      return { ok: false, error: `${prefix}old_text not found in file.` };
    }
    if (count > 1) {
      return {
        ok: false,
        error:
          `${prefix}old_text appears ${count} times (must be exactly 1). Provide a larger unique snippet.`,
      };
    }
    updated = updated.replace(old_text, () => new_text);
  }
  return { ok: true, value: updated };
}
