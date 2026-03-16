/**
 * Execution tools for the agent workspace.
 *
 * Provides file I/O and workspace listing within the agent's
 * isolated workspace directory. All file operations are sandboxed
 * to the workspace — path traversal is blocked.
 *
 * Command execution lives in `command.ts`.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";
import type { Workspace } from "./workspace.ts";
import { join, resolve } from "@std/path";
import { isWithinJail } from "../core/security/path_jail.ts";
import { createLogger } from "../core/logger/logger.ts";
import { invokeShellCommand } from "./command.ts";

const log = createLogger("exec");

/** Result of writing a file. */
export interface WriteResult {
  /** Absolute path of the written file. */
  readonly path: string;
  /** Number of bytes written. */
  readonly bytesWritten: number;
}

/** Result of running a command. */
export interface RunResult {
  /** Standard output. */
  readonly stdout: string;
  /** Standard error. */
  readonly stderr: string;
  /** Process exit code. */
  readonly exitCode: number;
  /** Execution duration in milliseconds. */
  readonly duration: number;
}

/** A file entry returned by ls. */
export interface FileEntry {
  /** File name relative to the listed directory. */
  readonly name: string;
  /** File size in bytes. */
  readonly size: number;
  /** Whether this entry is a directory. */
  readonly isDirectory: boolean;
}

/** Options for creating execution tools. */
export interface ExecToolsOptions {
  /** Override CWD for command execution (e.g., session-taint workspace dir). */
  readonly cwdOverride?: string | (() => string);
}

/** Execution tools bound to a workspace. */
export interface ExecTools {
  /** Write a file to the workspace. Path is relative to workspace root. */
  write(path: string, content: string): Promise<Result<WriteResult, string>>;
  /** Read a file from the workspace. Path is relative to workspace root. */
  read(path: string): Promise<Result<string, string>>;
  /** Run a shell command in the workspace directory. */
  runCommand(command: string, cwd?: string): Promise<Result<RunResult, string>>;
  /** List files in the workspace (or a subdirectory). */
  ls(path?: string): Promise<Result<readonly FileEntry[], string>>;
}

/**
 * Resolve a relative path within the workspace, blocking path traversal.
 *
 * @returns The resolved absolute path, or null if it escapes the workspace.
 */
function resolveWorkspacePath(
  workspace: Workspace,
  relativePath: string,
): string | null {
  const resolved = resolve(join(workspace.path, relativePath));
  if (!isWithinJail(resolved, workspace.path)) {
    return null;
  }
  return resolved;
}

async function writeFile(
  workspace: Workspace,
  path: string,
  content: string,
): Promise<Result<WriteResult, string>> {
  const resolved = resolveWorkspacePath(workspace, path);
  if (resolved === null) {
    return {
      ok: false,
      error: `Path "${path}" escapes the workspace directory`,
    };
  }

  try {
    const parentDir = resolve(resolved, "..");
    await Deno.mkdir(parentDir, { recursive: true });
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    await Deno.writeFile(resolved, bytes);
    return {
      ok: true,
      value: { path: resolved, bytesWritten: bytes.byteLength },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write "${path}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function readFile(
  workspace: Workspace,
  path: string,
): Promise<Result<string, string>> {
  const resolved = resolveWorkspacePath(workspace, path);
  if (resolved === null) {
    return {
      ok: false,
      error: `Path "${path}" escapes the workspace directory`,
    };
  }

  try {
    const content = await Deno.readTextFile(resolved);
    return { ok: true, value: content };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read "${path}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function listDirectory(
  workspace: Workspace,
  path?: string,
): Promise<Result<readonly FileEntry[], string>> {
  const targetPath = path
    ? resolveWorkspacePath(workspace, path)
    : workspace.path;

  if (targetPath === null) {
    return {
      ok: false,
      error: `Path "${path}" escapes the workspace directory`,
    };
  }

  try {
    const entries: FileEntry[] = [];
    for await (const entry of Deno.readDir(targetPath)) {
      let size = 0;
      try {
        const stat = await Deno.stat(join(targetPath, entry.name));
        size = stat.size ?? 0;
      } catch (err) {
        log.debug("Workspace file stat failed, reporting size 0", {
          file: entry.name,
          err,
        });
      }
      entries.push({ name: entry.name, size, isDirectory: entry.isDirectory });
    }
    return { ok: true, value: entries };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to list "${path ?? "."}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Create execution tools bound to a workspace.
 *
 * All file operations are sandboxed to the workspace directory.
 * Path traversal attempts (e.g. `../../etc/passwd`) are blocked.
 *
 * @param workspace - The workspace to bind tools to
 * @param options - Optional overrides (e.g., cwdOverride for taint-aware CWD)
 */
export function createExecTools(
  workspace: Workspace,
  options?: ExecToolsOptions,
): ExecTools {
  return {
    write: (path, content) => writeFile(workspace, path, content),
    read: (path) => readFile(workspace, path),
    runCommand: (command, cwd) =>
      invokeShellCommand(workspace, command, options, cwd),
    ls: (path) => listDirectory(workspace, path),
  };
}
