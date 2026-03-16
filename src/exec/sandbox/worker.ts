/**
 * Sandboxed filesystem worker — runs inside a permission-restricted Deno Worker.
 *
 * Permissions are restricted at the Worker level by the parent:
 *   read: [workspacePath], write: [workspacePath], run: ["grep", "find"]
 *   net: false, env: false, ffi: false
 *
 * Receives SandboxRequest messages via postMessage, dispatches by operation,
 * returns SandboxResponse messages via postMessage.
 *
 * @module
 */

import { parentDir, resolveSafePath, toRelativePath } from "./worker_paths.ts";

// ─── Inline types (must match protocol.ts) ──────────────────────────────────

interface SandboxRequest {
  readonly id: string;
  readonly op: "read" | "write" | "list" | "search" | "edit";
  readonly args: Readonly<Record<string, unknown>>;
}

interface SandboxResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: string;
  readonly error?: string;
}

// ─── Workspace root ─────────────────────────────────────────────────────────

let workspaceRoot = "";

// ─── Operation handlers ─────────────────────────────────────────────────────

async function handleRead(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = args.path;
  if (typeof path !== "string" || path.length === 0) {
    return formatError("read_file requires a 'path' argument (string)");
  }
  const resolved = resolveSafePath(path, workspaceRoot);
  if (!resolved.ok) return formatError(resolved.error);
  return await Deno.readTextFile(resolved.path);
}

async function handleWrite(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || path.length === 0) {
    return formatError("write_file requires a 'path' argument (string)");
  }
  if (typeof content !== "string") {
    return formatError("write_file requires a 'content' argument (string)");
  }
  const resolved = resolveSafePath(path, workspaceRoot);
  if (!resolved.ok) return formatError(resolved.error);

  await Deno.mkdir(parentDir(resolved.path), { recursive: true });
  await Deno.writeTextFile(resolved.path, content);
  const info = await Deno.stat(resolved.path);
  return `Wrote ${info.size} bytes to ${
    toRelativePath(resolved.path, workspaceRoot)
  }`;
}

async function handleList(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = args.path;
  if (typeof path !== "string" || path.length === 0) {
    return formatError("list_directory requires a 'path' argument (string)");
  }
  const resolved = resolveSafePath(path, workspaceRoot);
  if (!resolved.ok) return formatError(resolved.error);

  const relDir = toRelativePath(resolved.path, workspaceRoot);
  const prefix = relDir === "." ? "" : relDir.replace(/\/?$/, "/");
  const entries: string[] = [];
  for await (const entry of Deno.readDir(resolved.path)) {
    const suffix = entry.isDirectory ? "/" : "";
    entries.push(`${prefix}${entry.name}${suffix}`);
  }
  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

async function handleSearch(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = args.path;
  const pattern = args.pattern;
  if (typeof path !== "string" || path.length === 0) {
    return formatError("search_files requires a 'path' argument (string)");
  }
  if (typeof pattern !== "string" || pattern.length === 0) {
    return formatError("search_files requires a 'pattern' argument (string)");
  }
  const resolved = resolveSafePath(path, workspaceRoot);
  if (!resolved.ok) return formatError(resolved.error);

  const isContentSearch = args.content_search === true;
  const cmd = isContentSearch ? "grep" : "find";
  const cmdArgs = isContentSearch
    ? ["-rl", pattern, resolved.path]
    : [resolved.path, "-name", pattern, "-type", "f"];

  const proc = new Deno.Command(cmd, {
    args: cmdArgs,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  if (stdout.length === 0) {
    return isContentSearch
      ? "No matches found."
      : "No files found matching pattern.";
  }
  return stdout.split("\n").map((line) => toRelativePath(line, workspaceRoot))
    .join("\n");
}

async function handleEdit(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = args.path;
  const oldText = args.old_text;
  const newText = args.new_text;
  if (typeof path !== "string" || path.length === 0) {
    return formatError("edit_file requires a 'path' argument (string)");
  }
  if (typeof oldText !== "string" || oldText.length === 0) {
    return formatError(
      "edit_file requires a non-empty 'old_text' argument (string)",
    );
  }
  if (typeof newText !== "string") {
    return formatError("edit_file requires a 'new_text' argument (string)");
  }
  const resolved = resolveSafePath(path, workspaceRoot);
  if (!resolved.ok) return formatError(resolved.error);

  const content = await Deno.readTextFile(resolved.path);
  const count = content.split(oldText).length - 1;
  if (count === 0) {
    return formatError("old_text not found in file");
  }
  if (count > 1) {
    return formatError(
      `old_text appears ${count} times (must be exactly 1). Provide a larger unique snippet.`,
    );
  }
  const updated = content.replace(oldText, newText);
  await Deno.writeTextFile(resolved.path, updated);
  return `Edited ${
    toRelativePath(resolved.path, workspaceRoot)
  } (${updated.length} bytes written)`;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

function formatError(msg: string): string {
  return `Error: ${msg}`;
}

async function dispatch(
  req: SandboxRequest,
): Promise<SandboxResponse> {
  try {
    let result: string;
    switch (req.op) {
      case "read":
        result = await handleRead(req.args);
        break;
      case "write":
        result = await handleWrite(req.args);
        break;
      case "list":
        result = await handleList(req.args);
        break;
      case "search":
        result = await handleSearch(req.args);
        break;
      case "edit":
        result = await handleEdit(req.args);
        break;
      default:
        return { id: req.id, ok: false, error: `Unknown operation: ${req.op}` };
    }
    const isError = result.startsWith("Error: ");
    return isError
      ? { id: req.id, ok: false, error: result }
      : { id: req.id, ok: true, result };
  } catch (err) {
    if (err instanceof Deno.errors.PermissionDenied) {
      return {
        id: req.id,
        ok: false,
        error: `Permission denied: ${err.message}`,
      };
    }
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Worker scope (typed for compile-time checking) ─────────────────────────

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
};

// ─── Message handler ────────────────────────────────────────────────────────

workerScope.onmessage = async (event: MessageEvent) => {
  const data = event.data;

  if (data?.type === "init") {
    if (!workspaceRoot) {
      if (
        typeof data.workspacePath !== "string" ||
        data.workspacePath.length === 0
      ) {
        workerScope.postMessage({
          id: "unknown",
          ok: false,
          error:
            "Sandbox init failed: workspacePath must be a non-empty string",
        });
        return;
      }
      workspaceRoot = data.workspacePath;
    }
    workerScope.postMessage({ type: "ready" });
    return;
  }

  if (!workspaceRoot) {
    workerScope.postMessage({
      id: data?.id ?? "unknown",
      ok: false,
      error: "Sandbox worker not initialized (missing init message)",
    });
    return;
  }

  const req = data as SandboxRequest;
  const resp = await dispatch(req);
  workerScope.postMessage(resp);
};
