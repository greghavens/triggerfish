/**
 * SSH credential resolution — materializes secrets to temp files for SSH.
 *
 * Private keys, passwords, and passphrases arrive as resolved secret values
 * from the dispatch pipeline. This module writes them to secure temp files
 * that SSH can consume, and cleans them up afterward.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("ssh-credentials");

/** SSH credential options — all sourced from the secret store. */
export interface SshCredentials {
  /** SSH private key content (resolved from {{secret:name}}). */
  readonly key?: string;
  /** SSH password for password-based auth (resolved from {{secret:name}}). */
  readonly password?: string;
  /** Passphrase for an encrypted private key (resolved from {{secret:name}}). */
  readonly passphrase?: string;
}

/** Resolved credential paths for SSH invocation. */
export interface ResolvedSshCredentials {
  readonly tempKeyPath?: string;
  readonly tempAskpassPath?: string;
}

/**
 * Write a private key to a secure temp file (mode 0600).
 * Returns the file path. Caller is responsible for cleanup.
 */
export async function materializeKeyToTempFile(
  keyContent: string,
): Promise<string> {
  const tmpDir = Deno.env.get("TMPDIR") || "/tmp";
  const filename = `triggerfish-ssh-key-${crypto.randomUUID().slice(0, 12)}`;
  const keyPath = `${tmpDir}/${filename}`;

  // Ensure key content ends with a newline (SSH requires it).
  const normalized = keyContent.endsWith("\n") ? keyContent : keyContent + "\n";

  await Deno.writeTextFile(keyPath, normalized, { mode: 0o600 });

  log.info("Materialized SSH key to temp file", {
    operation: "materializeKeyToTempFile",
    keyPath,
  });

  return keyPath;
}

/**
 * Write an SSH_ASKPASS helper script that echoes a secret value.
 * Used for password auth and key passphrase input.
 * Returns the script path. Caller is responsible for cleanup.
 */
export async function materializeAskpassScript(
  secret: string,
): Promise<string> {
  const tmpDir = Deno.env.get("TMPDIR") || "/tmp";
  const filename = `triggerfish-ssh-askpass-${
    crypto.randomUUID().slice(0, 12)
  }`;
  const scriptPath = `${tmpDir}/${filename}`;

  // Shell script that echoes the secret. Single quotes inside the heredoc
  // prevent expansion — the secret value is embedded literally.
  const escaped = secret.replaceAll("'", "'\\''");
  const script = `#!/bin/sh\necho '${escaped}'\n`;

  await Deno.writeTextFile(scriptPath, script, { mode: 0o700 });

  log.info("Materialized SSH askpass script", {
    operation: "materializeAskpassScript",
    scriptPath,
  });

  return scriptPath;
}

/** Remove a materialized temp file (key or askpass script). */
export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await Deno.remove(filePath);
    log.info("Removed temp SSH file", {
      operation: "cleanupTempFile",
      filePath,
    });
  } catch (err) {
    log.warn("Failed to remove temp SSH file", {
      operation: "cleanupTempFile",
      filePath,
      err,
    });
  }
}

/**
 * Materialize credentials to temp files.
 * Returns paths that must be cleaned up by the caller.
 */
export async function resolveCredentials(
  creds: SshCredentials,
): Promise<ResolvedSshCredentials> {
  let tempKeyPath: string | undefined;
  let tempAskpassPath: string | undefined;

  if (creds.key) {
    tempKeyPath = await materializeKeyToTempFile(creds.key);
  }

  // Password (no key) -> askpass for password auth.
  // Passphrase (with key) -> askpass for key passphrase.
  // Password + key (no passphrase) -> askpass for password (key used via -i).
  const askpassSecret = creds.passphrase ?? creds.password;
  if (askpassSecret) {
    tempAskpassPath = await materializeAskpassScript(askpassSecret);
  }

  return { tempKeyPath, tempAskpassPath };
}

/** Clean up all temp credential files. */
export async function cleanupCredentials(
  resolved: ResolvedSshCredentials,
): Promise<void> {
  if (resolved.tempKeyPath) await cleanupTempFile(resolved.tempKeyPath);
  if (resolved.tempAskpassPath) await cleanupTempFile(resolved.tempAskpassPath);
}
