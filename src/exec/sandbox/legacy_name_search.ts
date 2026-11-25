/** Enumerate legacy find-name matches for caller-side authorization. */
import { isWithinWorkspace, toRelativePath } from "./worker_paths.ts";

const MAX_NAMES = 2000;
const MAX_ENUMERATION_CHARS = 512 * 1024;

export async function enumerateLegacyNames(
  workspace: string,
  canonicalPath: string,
  pattern: string,
): Promise<string> {
  const child = new Deno.Command("find", {
    args: [canonicalPath, "-name", pattern, "-type", "f", "-print0"],
    stdout: "piped",
    stderr: "null",
    signal: AbortSignal.timeout(5000),
  }).spawn();
  const names: string[] = [];
  let buffer = "";
  let size = 0;
  try {
    for await (
      const chunk of child.stdout.pipeThrough(new TextDecoderStream())
    ) {
      size += chunk.length;
      if (size > MAX_ENUMERATION_CHARS) {
        return "Error: Filename search matched too many paths.";
      }
      buffer += chunk;
      const parts = buffer.split("\0");
      buffer = parts.pop() ?? "";
      for (const path of parts) {
        if (!isWithinWorkspace(path, workspace)) continue;
        if (await Deno.realPath(path).catch(() => null) !== path) continue;
        names.push(toRelativePath(path, workspace));
        if (names.length > MAX_NAMES) {
          return "Error: Filename search matched too many paths.";
        }
      }
    }
    const status = await child.status;
    if (!status.success || buffer) return "Error: Filename enumeration failed.";
    return JSON.stringify(names);
  } finally {
    try {
      child.kill();
    } catch {
      // The child already exited.
    }
    await child.status;
  }
}
