/** Match across physical lines in one authorized file. */
import { contentSearchArgs } from "./search_options.ts";

const MAX_MULTILINE_BYTES = 512 * 1024;
const MAX_MULTILINE_RESULTS = 1000;

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

  // PCRE grep's null-delimited matches include their byte offset even when a
  // match spans several newlines. Feed the same immutable bytes we render.
  const child = new Deno.Command("grep", {
    args: [
      "-Pzob",
      "-h",
      ...(input.ignore_case === true ? ["-i"] : []),
      "--",
      `(?s)${pattern}`,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(2000),
  }).spawn();
  const [output] = await Promise.all([
    child.output(),
    new Blob([bytes]).stream().pipeTo(child.stdin).catch(() => undefined),
  ]);
  if (output.code === 1) return "No matches found.";
  if (!output.success) {
    return "Error: Multiline search requires PCRE grep and a valid pattern.";
  }

  const decode = new TextDecoder();
  const starts = [0];
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (bytes[index] === 10) starts.push(index + 1);
  }
  const hits = new Set<number>();
  let line = 0;
  for (let cursor = 0; cursor < output.stdout.length;) {
    const separator = output.stdout.indexOf(58, cursor);
    const end = output.stdout.indexOf(0, separator + 1);
    if (separator < 0 || end < 0) {
      return "Error: Invalid multiline search response.";
    }
    const start = Number(
      decode.decode(output.stdout.subarray(cursor, separator)),
    );
    const stop = start + end - separator - 1;
    while (starts[line + 1] <= start) line++;
    for (
      let index = line;
      index < starts.length && starts[index] < stop;
      index++
    ) {
      hits.add(index);
    }
    cursor = end + 1;
  }
  if (!hits.size) return "No matches found.";
  if (input.output_mode === "count") return `${label}:${hits.size}`;
  if (input.output_mode !== "content") return label;

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
    const end = starts[index + 1] ?? length;
    const text = decode.decode(bytes.subarray(
      starts[index],
      bytes[end - 1] === 10 ? end - 1 : end,
    ));
    lines.push(`${label}${separator}${number}${text}`);
    previous = index;
  }
  return lines.join("\n");
}
