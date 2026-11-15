/**
 * SSH argument builders — construct CLI args and env vars for SSH commands.
 *
 * Separated from session management so one-shot execution and interactive
 * sessions share the same argument construction logic.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import type {
  ResolvedSshCredentials,
  SshCredentials,
} from "./ssh_credentials.ts";

/** Options for opening a new SSH session. */
export interface SshSessionOpenOptions extends SshCredentials {
  readonly host: string;
  readonly port?: number;
}

/** True when the string contains whitespace, C0 controls, or DEL. */
function containsControlOrWhitespace(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7F) return true;
  }
  return false;
}

/**
 * Validate an SSH destination of the shape `[user@]hostname`.
 *
 * Rejects destinations that begin with `-`: OpenSSH parses such an
 * argument as a command-line option, so a host like
 * `-oProxyCommand=...` would execute an attacker-chosen local command.
 * Also rejects a `-`-leading hostname after `user@` and any whitespace
 * or control characters. IPv6 literals and `user@host` forms pass.
 *
 * @returns Ok with the trimmed destination, or Err describing the rejection
 */
export function validateSshHost(host: string): Result<string, string> {
  const trimmed = host.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "SSH host must not be empty" };
  }
  if (trimmed.startsWith("-")) {
    return {
      ok: false,
      error: `SSH host must not begin with '-' (option injection): ${trimmed}`,
    };
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex !== -1 && trimmed.slice(atIndex + 1).startsWith("-")) {
    return {
      ok: false,
      error:
        `SSH hostname must not begin with '-' (option injection): ${trimmed}`,
    };
  }
  if (containsControlOrWhitespace(trimmed)) {
    return {
      ok: false,
      error: "SSH host must not contain whitespace or control characters",
    };
  }
  return { ok: true, value: trimmed };
}

/** Build base SSH args shared by session and one-shot modes. */
export function buildBaseArgs(
  opts: { readonly port?: number },
  resolved: ResolvedSshCredentials,
): string[] {
  const args: string[] = [];

  // When using askpass for password/passphrase, disable BatchMode.
  // Otherwise enable it to prevent hanging on unexpected prompts.
  if (resolved.tempAskpassPath) {
    args.push("-o", "BatchMode=no");
  } else {
    args.push("-o", "BatchMode=yes");
  }

  args.push("-o", "StrictHostKeyChecking=accept-new");
  // Defense in depth against option injection: even if an option-shaped
  // argument slips through, LocalCommand must never execute.
  args.push("-o", "PermitLocalCommand=no");

  if (opts.port !== undefined) {
    args.push("-p", String(opts.port));
  }
  if (resolved.tempKeyPath) {
    args.push("-i", resolved.tempKeyPath);
  }

  return args;
}

/** Build env vars for SSH_ASKPASS-based credential passing. */
export function buildAskpassEnv(
  resolved: ResolvedSshCredentials,
): Record<string, string> {
  if (!resolved.tempAskpassPath) return {};
  return {
    SSH_ASKPASS: resolved.tempAskpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
  };
}

/** Build the ssh command arguments for an interactive session. */
export function buildSessionArgs(
  opts: SshSessionOpenOptions,
  resolved: ResolvedSshCredentials,
): string[] {
  const args = buildBaseArgs(opts, resolved);
  args.push(
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-tt",
  );
  args.push(opts.host);
  return args;
}

/** Build the ssh command arguments for a one-shot command. */
export function buildExecuteArgs(
  host: string,
  command: string,
  opts: { readonly port?: number },
  resolved: ResolvedSshCredentials,
): string[] {
  const args = buildBaseArgs(opts, resolved);
  args.push(host, "--", command);
  return args;
}
