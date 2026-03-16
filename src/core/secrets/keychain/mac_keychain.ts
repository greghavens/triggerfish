/**
 * macOS secret store using the `security` CLI (Keychain Access).
 *
 * Secrets are stored as generic passwords with service=triggerfish, account=<name>.
 *
 * @module
 */

import type { Result } from "../../types/classification.ts";
import type { SecretStore } from "../backends/secret_store.ts";
import { SECRET_SERVICE_NAME } from "../backends/secret_store.ts";
import { invokeCommand } from "./command_runner.ts";

/** Lookup a secret from macOS Keychain. */
async function lookupMacSecret(
  name: string,
): Promise<Result<string, string>> {
  const result = await invokeCommand("security", [
    "find-generic-password",
    "-s",
    SECRET_SERVICE_NAME,
    "-a",
    name,
    "-w",
  ]);
  if (!result.ok) {
    return { ok: false, error: `Secret '${name}' not found: ${result.error}` };
  }
  return { ok: true, value: result.value };
}

/** Delete existing entry before storing (macOS requires this pattern). */
async function deleteExistingMacEntry(name: string): Promise<void> {
  await invokeCommand("security", [
    "delete-generic-password",
    "-s",
    SECRET_SERVICE_NAME,
    "-a",
    name,
  ]);
}

/** Store a secret in macOS Keychain (deletes existing entry first). */
async function storeMacSecret(
  name: string,
  value: string,
): Promise<Result<true, string>> {
  await deleteExistingMacEntry(name);
  const result = await invokeCommand("security", [
    "add-generic-password",
    "-s",
    SECRET_SERVICE_NAME,
    "-a",
    name,
    "-w",
    value,
  ]);
  if (!result.ok) {
    return {
      ok: false,
      error: `Failed to store secret '${name}': ${result.error}`,
    };
  }
  return { ok: true, value: true };
}

/** Delete a secret from macOS Keychain. */
async function deleteMacSecret(
  name: string,
): Promise<Result<true, string>> {
  const result = await invokeCommand("security", [
    "delete-generic-password",
    "-s",
    SECRET_SERVICE_NAME,
    "-a",
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

/** Parse macOS keychain dump output for triggerfish account names. */
function parseMacKeychainDump(dump: string): string[] {
  const names: string[] = [];
  let inTriggerfishEntry = false;
  for (const line of dump.split("\n")) {
    if (line.includes(`"svce"<blob>="${SECRET_SERVICE_NAME}"`)) {
      inTriggerfishEntry = true;
    }
    if (inTriggerfishEntry) {
      const match = line.match(/"acct"<blob>="([^"]+)"/);
      if (match) {
        names.push(match[1]);
        inTriggerfishEntry = false;
      }
    }
    if (line.startsWith("keychain:") || line.startsWith("class:")) {
      if (!line.includes(SECRET_SERVICE_NAME)) {
        inTriggerfishEntry = false;
      }
    }
  }
  return names;
}

/** List all secrets from macOS Keychain. */
async function listMacSecrets(): Promise<Result<string[], string>> {
  const result = await invokeCommand("security", ["dump-keychain"]);
  if (!result.ok) return { ok: true, value: [] };
  return { ok: true, value: parseMacKeychainDump(result.value) };
}

/**
 * Create a macOS secret store using the `security` CLI (Keychain Access).
 *
 * Secrets are stored as generic passwords with service=triggerfish, account=<name>.
 */
export function createMacKeychain(): SecretStore {
  return {
    getSecret: lookupMacSecret,
    setSecret: storeMacSecret,
    deleteSecret: deleteMacSecret,
    listSecrets: listMacSecrets,
  };
}
