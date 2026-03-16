/**
 * DPAPI encrypt/decrypt operations via PowerShell subprocess.
 *
 * Low-level helpers that shell out to `powershell.exe` to protect and
 * unprotect secret values using `System.Security.Cryptography.ProtectedData`.
 *
 * @module
 */

import type { Result } from "../../types/classification.ts";
import { invokeCommand } from "./command_runner.ts";

/** PowerShell command to DPAPI-protect a value piped via stdin. */
const PROTECT_SCRIPT = `Add-Type -AssemblyName System.Security; ` +
  `$bytes = [System.Text.Encoding]::UTF8.GetBytes($input); ` +
  `$enc = [System.Security.Cryptography.ProtectedData]::Protect(` +
  `$bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[Convert]::ToBase64String($enc)`;

/** PowerShell command to DPAPI-unprotect a base64 blob piped via stdin. */
const UNPROTECT_SCRIPT = `Add-Type -AssemblyName System.Security; ` +
  `$enc = [Convert]::FromBase64String($input); ` +
  `$dec = [System.Security.Cryptography.ProtectedData]::Unprotect(` +
  `$enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  `[System.Text.Encoding]::UTF8.GetString($dec)`;

/** Probe whether DPAPI is available by running a trivial protect/unprotect cycle. */
export async function probeWindowsDpapi(): Promise<boolean> {
  const protectResult = await invokeCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROTECT_SCRIPT],
    "dpapi-probe-test",
  );
  if (!protectResult.ok) return false;

  const unprotectResult = await invokeCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT],
    protectResult.value,
  );
  if (!unprotectResult.ok) return false;

  return unprotectResult.value === "dpapi-probe-test";
}

/** DPAPI-encrypt a secret value via PowerShell. */
export async function protectSecret(
  value: string,
): Promise<Result<string, string>> {
  const result = await invokeCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROTECT_SCRIPT],
    value,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: `DPAPI protect failed: ${result.error}`,
    };
  }
  return { ok: true, value: result.value };
}

/** DPAPI-decrypt a base64 ciphertext blob via PowerShell. */
export async function unprotectSecret(
  base64Ciphertext: string,
): Promise<Result<string, string>> {
  const result = await invokeCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT],
    base64Ciphertext,
  );
  if (!result.ok) {
    return {
      ok: false,
      error: `DPAPI unprotect failed: ${result.error}`,
    };
  }
  return { ok: true, value: result.value };
}
