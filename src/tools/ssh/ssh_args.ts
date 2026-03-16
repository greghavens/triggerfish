/**
 * SSH argument builders — construct CLI args and env vars for SSH commands.
 *
 * Separated from session management so one-shot execution and interactive
 * sessions share the same argument construction logic.
 *
 * @module
 */

import type {
  ResolvedSshCredentials,
  SshCredentials,
} from "./ssh_credentials.ts";

/** Options for opening a new SSH session. */
export interface SshSessionOpenOptions extends SshCredentials {
  readonly host: string;
  readonly port?: number;
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
