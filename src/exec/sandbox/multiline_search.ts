/** Match across physical lines in one authorized file. */
import { contentSearchArgs } from "./search_options.ts";
import { RE2JS } from "re2js";

const MAX_MULTILINE_BYTES = 512 * 1024;
const MAX_MULTILINE_RESULTS = 1000;
const MAX_REGEX_PROGRAM_SIZE = 8192;

export async function searchMultilineFile(
  input: Readonly<Record<string, unknown>>,
  pattern: string,
  path: string,
  label: string,
): Promise<string> {
  const validation = contentSearchArgs(input, pattern, path);
  if (!validation.ok) return `Error: ${validation.error}`;
  if (pattern.includes("\0") || pattern.length > 4096) {
    return "Error: Invalid multiline search pattern.";
  }
  if (input.file_glob !== undefined) {
    return "Error: Use file_glob only with recursive multiline search.";
  }
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(
      pattern,
      RE2JS.DOTALL | (input.ignore_case === true ? RE2JS.CASE_INSENSITIVE : 0),
    );
  } catch {
    return "Error: Invalid RE2 multiline search pattern.";
  }
  if (regex.programSize() > MAX_REGEX_PROGRAM_SIZE) {
    return "Error: Multiline search pattern is too complex.";
  }
  const raw = new Uint8Array(MAX_MULTILINE_BYTES + 1);
  let length = 0;
  using file = await Deno.open(path, { read: true });
  while (length < raw.length) {
    const count = await file.read(raw.subarray(length));
    if (count === null) break;
    length += count;
  }
  if (length > MAX_MULTILINE_BYTES) {
    return "Error: Multiline search requires files of at most 512 KiB.";
  }
  const bytes = raw.subarray(0, length);
  if (bytes.includes(0)) return "No matches found.";

  const content = new TextDecoder().decode(bytes);
  if (input.output_mode !== "content" && input.output_mode !== "count") {
    return regex.test(content) ? label : "No matches found.";
  }
  const starts = [0];
  for (let index = 0; index + 1 < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const hits = new Set<number>();
  let line = 0;
  const match = regex.matcher(content);
  while (match.find()) {
    const start = match.start();
    const stop = match.end();
    if (stop <= start) continue;
    while (starts[line + 1] <= start) line++;
    for (
      let index = line;
      index < starts.length && starts[index] < stop;
      index++
    ) {
      hits.add(index);
    }
  }
  if (!hits.size) return "No matches found.";
  if (input.output_mode === "count") return `${label}:${hits.size}`;

  const before = Number(input.context ?? input.before ?? 0);
  const after = Number(input.context ?? input.after ?? 0);
  const selected = new Set<number>();
  for (const index of hits) {
    const start = Math.max(0, index - before);
    const end = Math.min(starts.length - 1, index + after);
    for (let i = start; i <= end; i++) selected.add(i);
    if (selected.size > MAX_MULTILINE_RESULTS) {
      return "Error: Too many multiline matches. Use a narrower pattern.";
    }
  }
  const lines = [];
  let previous = -1;
  for (const index of selected) {
    if ((before || after) && previous >= 0 && index !== previous + 1) {
      lines.push("--");
    }
    const separator = hits.has(index) ? ":" : "-";
    const number = input.line_numbers === false
      ? ""
      : `${index + 1}${separator}`;
    const end = starts[index + 1] ?? content.length;
    const text = content.slice(
      starts[index],
      content.charCodeAt(end - 1) === 10 ? end - 1 : end,
    );
    lines.push(`${label}${separator}${number}${text}`);
    previous = index;
  }
  return lines.join("\n");
}
