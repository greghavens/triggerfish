/**
 * Built-in filesystem tool handlers — read, write, list, search, edit.
 *
 * Each handler validates its input and returns a result string.
 * When a FilesystemSandbox is provided, operations are routed through
 * the sandboxed Deno subprocess for OS-level permission enforcement.
 * Otherwise, handlers fall back to direct Deno API calls.
 *
 * @module
 */

import { basename, resolve } from "@std/path";
import {
  applyFileEdits,
  parseFileEdits,
} from "../../../exec/sandbox/file_edits.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import type { SandboxResponse } from "../../../exec/sandbox/mod.ts";
import type { ToolExecutorOptions } from "./executor_types.ts";
import type { ToolExecutionContext } from "../../../core/types/tool.ts";
import { searchWorkspaceContents } from "./executor_recursive_search.ts";
import { executeLogRead } from "../../../tools/log_reader_tool.ts";
import { contentSearchArgs } from "../../../exec/sandbox/search_options.ts";
import { WRITE_PROTECTED_BASENAMES } from "../../../core/security/constants.ts";

/** Format an error from a filesystem operation. */
function formatFsError(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

/** Unpack a sandbox response into a result string. */
function unpackSandboxResponse(resp: SandboxResponse): string {
  return resp.ok
    ? (resp.result ?? "")
    : (resp.error ?? "Unknown sandbox error");
}

/** Handle read_file tool call. */
export async function loadFileContent(
  input: Record<string, unknown>,
  sandbox?: FilesystemSandbox,
): Promise<string> {
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) {
    return "Error: read_file requires a 'path' argument (string).";
  }
  const configRedirect = checkConfigManaged(path);
  if (configRedirect) return configRedirect;
  if (sandbox) {
    const resp = await sandbox.request({
      id: "",
      op: "read",
      args: { path },
    });
    return unpackSandboxResponse(resp);
  }
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    return formatFsError("Error reading file", err);
  }
}

/**
 * Basenames managed exclusively by dedicated tools, not filesystem tools.
 * triggerfish.yaml → config_manage / mcp_manage
 * TRIGGER.md → trigger_manage
 */
const CONFIG_MANAGED_BASENAMES: ReadonlyMap<string, string> = new Map([
  ["triggerfish.yaml", "config_manage or mcp_manage"],
  ["triggerfish.yml", "config_manage or mcp_manage"],
  ["SPINE.md", "spine_manage"],
  ["skill-approvals.db", "inspect_skill_draft or approve_skill"],
]);

/**
 * Check if a path targets a config-managed file. Returns redirect message or null.
 * These files must ONLY be accessed through their dedicated tools.
 */
export function checkConfigManaged(path: string): string | null {
  const name = basename(path);
  const tool = CONFIG_MANAGED_BASENAMES.get(name);
  if (tool) {
    return `Error: ${name} is managed exclusively by the ${tool} tool. ` +
      `Do not use read_file, write_file, edit_file, or run_command on this file. ` +
      `Use the ${tool} tool instead.`;
  }
  return null;
}

/** Check if a path targets a write-protected file. */
function isWriteProtected(path: string): boolean {
  return WRITE_PROTECTED_BASENAMES.has(basename(path));
}

/** Handle write_file tool call via sandbox or ExecTools. */
export async function persistFileContent(
  input: Record<string, unknown>,
  execTools: ToolExecutorOptions["execTools"],
  sandbox?: FilesystemSandbox,
): Promise<string> {
  const path = input.path;
  const content = input.content;
  if (typeof path !== "string" || path.length === 0) {
    return "Error: write_file requires a 'path' argument (string).";
  }
  if (typeof content !== "string") {
    return "Error: write_file requires a 'content' argument (string).";
  }
  const configRedirect = checkConfigManaged(path);
  if (configRedirect) return configRedirect;
  if (isWriteProtected(path)) {
    return `Error: ${
      basename(path)
    } is write-protected. Use the trigger_manage tool to update trigger instructions.`;
  }
  if (sandbox) {
    const resp = await sandbox.request({
      id: "",
      op: "write",
      args: { path, content },
    });
    return unpackSandboxResponse(resp);
  }
  const result = await execTools.write(path, content);
  return result.ok
    ? `Wrote ${result.value.bytesWritten} bytes to ${path}`
    : `Error: ${result.error}`;
}

/** Handle list_directory tool call. */
export async function enumerateDirectoryContents(
  input: Record<string, unknown>,
  sandbox?: FilesystemSandbox,
): Promise<string> {
  const path = input.path;
  if (typeof path !== "string" || path.length === 0) {
    return "Error: list_directory requires a 'path' argument (string).";
  }
  if (sandbox) {
    const resp = await sandbox.request({
      id: "",
      op: "list",
      args: { path },
    });
    return unpackSandboxResponse(resp);
  }
  try {
    const prefix = path === "." || path === "./"
      ? ""
      : path.replace(/\/?$/, "/");
    const entries: string[] = [];
    for await (const entry of Deno.readDir(path)) {
      const suffix = entry.isDirectory ? "/" : "";
      entries.push(`${prefix}${entry.name}${suffix}`);
    }
    return entries.length > 0 ? entries.join("\n") : "(empty directory)";
  } catch (err) {
    return formatFsError("Error listing directory", err);
  }
}

/** Format command execution output into a result string. */
function formatCommandOutput(out: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly duration: number;
}): string {
  const parts: string[] = [];
  if (out.stdout) parts.push(out.stdout);
  if (out.stderr) parts.push(`[stderr] ${out.stderr}`);
  parts.push(`[exit code: ${out.exitCode}, ${Math.round(out.duration)}ms]`);
  return parts.join("\n");
}

/** Handle run_command tool call via ExecTools sandbox. */
export async function invokeShellCommand(
  input: Record<string, unknown>,
  execTools: ToolExecutorOptions["execTools"],
): Promise<string> {
  const command = input.command ?? input.cmd;
  if (typeof command !== "string" || command.length === 0) {
    return "Error: run_command requires a 'command' argument (string).";
  }
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0
    ? input.cwd
    : undefined;
  const result = await execTools.runCommand(command, cwd);
  if (!result.ok) return `Error: ${result.error}`;
  return formatCommandOutput(result.value);
}

/** Run a search command and return stdout or a fallback message. */
async function runSearchCommand(
  cmd: string,
  args: string[],
  emptyMessage: string,
): Promise<string> {
  const proc = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  return stdout.length > 0 ? stdout : emptyMessage;
}

/** Validate search_files input and return error message or null. */
function validateSearchInput(
  input: Record<string, unknown>,
): string | null {
  if (typeof input.path !== "string" || input.path.length === 0) {
    return "Error: search_files requires a 'path' argument (string).";
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return "Error: search_files requires a 'pattern' argument (string).";
  }
  return null;
}

/** Handle search_files tool call (glob or content search). */
export async function queryFilesystem(
  input: Record<string, unknown>,
  sandbox?: FilesystemSandbox,
  authorizeFile?: ToolExecutionContext["authorizeRecursiveSearchFile"],
): Promise<string> {
  const validationError = validateSearchInput(input);
  if (validationError) return validationError;
  if (input.recursive === true && input.content_search === true) {
    if (!sandbox || !authorizeFile) {
      return "Error: Recursive workspace search authorization is unavailable.";
    }
    return await searchWorkspaceContents(
      input,
      sandbox,
      authorizeFile,
      (path) => checkConfigManaged(path) !== null,
    );
  }
  const searchPath = input.path as string;
  const readsDetails = input.content_search === true &&
    (input.output_mode === "content" || input.output_mode === "count");
  if (readsDetails) {
    const redirect = checkConfigManaged(searchPath);
    if (redirect) return redirect;
  }
  if (sandbox) {
    const resp = await sandbox.request({
      id: "",
      op: "search",
      args: {
        path: input.path,
        pattern: input.pattern,
        content_search: input.content_search,
        output_mode: input.output_mode,
        file_glob: input.file_glob,
        ignore_case: input.ignore_case,
        line_numbers: input.line_numbers,
        context: input.context,
        before: input.before,
        after: input.after,
      },
    });
    return unpackSandboxResponse(resp);
  }
  const pattern = input.pattern as string;
  try {
    if (
      readsDetails &&
      (await Deno.realPath(searchPath) !== resolve(searchPath) ||
        !(await Deno.stat(searchPath)).isFile)
    ) return "Error: Content detail requires one exact workspace file.";
    if (input.content_search === true) {
      const args = contentSearchArgs(input, pattern, searchPath);
      if (!args.ok) return `Error: ${args.error}`;
      return await runSearchCommand("grep", args.value, "No matches found.");
    }
    return await runSearchCommand(
      "find",
      [searchPath, "-name", pattern, "-type", "f"],
      "No files found matching pattern.",
    );
  } catch (err) {
    return formatFsError("Error searching", err);
  }
}

/** Handle log_read tool call — provenance-aware log reader for LLM context. */
export { executeLogRead };

/** Apply one or more unique replacements to a file. */
export async function modifyFileContent(
  input: Record<string, unknown>,
  sandbox?: FilesystemSandbox,
): Promise<string> {
  const path = input.path;
  if (typeof path !== "string" || !path.length) {
    return "Error: edit_file requires a 'path' argument (string).";
  }
  const edits = parseFileEdits(input);
  if (!edits.ok) return `Error: ${edits.error}`;
  const configRedirect = checkConfigManaged(path);
  if (configRedirect) return configRedirect;
  if (isWriteProtected(path)) {
    return `Error: ${
      basename(path)
    } is write-protected. Use the trigger_manage tool to update trigger instructions.`;
  }
  if (sandbox) {
    const resp = await sandbox.request({
      id: "",
      op: "edit",
      args: { path, edits: edits.value },
    });
    return unpackSandboxResponse(resp);
  }
  try {
    const content = await Deno.readTextFile(path);
    const updated = applyFileEdits(content, edits.value);
    if (!updated.ok) return `Error: ${updated.error}`;
    await Deno.writeTextFile(path, updated.value);
    return `Edited ${path} (${updated.value.length} bytes written)`;
  } catch (err) {
    return formatFsError("Error editing file", err);
  }
}

/** @deprecated Use loadFileContent instead */
export const executeReadFile = loadFileContent;

/** @deprecated Use persistFileContent instead */
export const executeWriteFile = persistFileContent;

/** @deprecated Use enumerateDirectoryContents instead */
export const executeListDirectory = enumerateDirectoryContents;

/** @deprecated Use invokeShellCommand instead */
export const executeRunCommand = invokeShellCommand;

/** @deprecated Use queryFilesystem instead */
export const executeSearchFiles = queryFilesystem;

/** @deprecated Use modifyFileContent instead */
export const executeEditFile = modifyFileContent;
