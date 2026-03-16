/**
 * Subprocess command execution for keychain backends.
 *
 * Provides a Result-returning wrapper around Deno.Command
 * used by platform-specific keychain implementations.
 *
 * @module
 */

import type { Result } from "../../types/classification.ts";

/** Pipe stdin data to a child process writer. */
async function pipeStdinData(
  process: Deno.ChildProcess,
  data: string,
): Promise<void> {
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(data));
  await writer.close();
}

/** Decode command output and return Result based on exit status. */
function decodeCommandOutput(
  output: Deno.CommandOutput,
  cmd: string,
): Result<string, string> {
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (output.success) return { ok: true, value: stdout };
  return {
    ok: false,
    error: stderr || `Command '${cmd}' failed with exit code ${output.code}`,
  };
}

/** Build stdin mode for Deno.Command based on whether data is provided. */
function resolveStdinMode(
  stdin: string | undefined,
): "piped" | "null" {
  return stdin !== undefined ? "piped" : "null";
}

/**
 * Run a Deno.Command and capture stdout/stderr.
 *
 * @param cmd - The command to run
 * @param args - Arguments for the command
 * @param stdin - Optional stdin data to pipe
 * @returns stdout text on success, or an error with stderr
 */
export async function invokeCommand(
  cmd: string,
  args: string[],
  stdin?: string,
): Promise<Result<string, string>> {
  try {
    const command = new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
      stdin: resolveStdinMode(stdin),
    });
    const process = command.spawn();
    if (stdin !== undefined) await pipeStdinData(process, stdin);
    const output = await process.output();
    return decodeCommandOutput(output, cmd);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to execute '${cmd}': ${message}` };
  }
}

/** @deprecated Use invokeCommand instead */
export const runCommand = invokeCommand;
