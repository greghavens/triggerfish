/**
 * Linux secret store using `secret-tool` (libsecret / GNOME Keyring).
 *
 * Secrets are stored with attributes: service=triggerfish, key=<name>.
 *
 * @module
 */

import type { Result } from "../../types/classification.ts";
import type { SecretStore } from "../backends/secret_store.ts";
import { SECRET_SERVICE_NAME } from "../backends/secret_store.ts";
import { invokeCommand } from "./command_runner.ts";

/** Lookup a secret from Linux libsecret. */
async function lookupLinuxSecret(
  name: string,
): Promise<Result<string, string>> {
  const result = await invokeCommand("secret-tool", [
    "lookup",
    "service",
    SECRET_SERVICE_NAME,
    "key",
    name,
  ]);
  if (!result.ok) {
    return { ok: false, error: `Secret '${name}' not found: ${result.error}` };
  }
  if (result.value === "") {
    return { ok: false, error: `Secret '${name}' not found` };
  }
  return { ok: true, value: result.value };
}

/** Store a secret in Linux libsecret. */
async function storeLinuxSecret(
  name: string,
  value: string,
): Promise<Result<true, string>> {
  const result = await invokeCommand(
    "secret-tool",
    [
      "store",
      "--label",
      `triggerfish:${name}`,
      "service",
      SECRET_SERVICE_NAME,
      "key",
      name,
    ],
    value,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: `Failed to store secret '${name}': ${result.error}`,
    };
  }
  return { ok: true, value: true };
}

/** Delete a secret from Linux libsecret. */
async function deleteLinuxSecret(
  name: string,
): Promise<Result<true, string>> {
  const result = await invokeCommand("secret-tool", [
    "clear",
    "service",
    SECRET_SERVICE_NAME,
    "key",
    name,
  ]);
  if (!result.ok) {
    return {
      ok: false,
      error: `Failed to delete secret '${name}': ${result.error}`,
    };
  }
  return { ok: true, value: true };
}

/**
 * Parse secret-tool search stdout for secret names.
 *
 * `secret-tool search` emits attribute metadata to stderr and structured
 * fields (label, secret, created, modified) to stdout. We parse the
 * `label = triggerfish:<name>` lines from stdout to extract secret names,
 * since the `attribute.key` lines are on stderr and not captured by
 * runCommand.
 */
export function parseLinuxSecretSearchOutput(output: string): string[] {
  const prefix = `${SECRET_SERVICE_NAME}:`;
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^label\s*=\s*(.+)$/);
    if (!match) continue;
    const label = match[1].trim();
    if (label.startsWith(prefix)) {
      names.push(label.slice(prefix.length));
    }
  }
  return names;
}

/** List all secrets from Linux libsecret. */
async function listLinuxSecrets(): Promise<Result<string[], string>> {
  const result = await invokeCommand("secret-tool", [
    "search",
    "--all",
    "service",
    SECRET_SERVICE_NAME,
  ]);
  if (!result.ok) return { ok: true, value: [] };
  return { ok: true, value: parseLinuxSecretSearchOutput(result.value) };
}

/**
 * Create a Linux secret store using `secret-tool` (libsecret / GNOME Keyring).
 *
 * Secrets are stored with attributes: service=triggerfish, key=<name>
 */
export function createLinuxKeychain(): SecretStore {
  return {
    getSecret: lookupLinuxSecret,
    setSecret: storeLinuxSecret,
    deleteSecret: deleteLinuxSecret,
    listSecrets: listLinuxSecrets,
  };
}
