/**
 * OS keychain integration: platform detection, Linux libsecret, macOS Keychain,
 * Windows DPAPI.
 *
 * @module
 */

export { createKeychain, resolveDockerKeyPath } from "./keychain.ts";
export {
  createLinuxKeychain,
  parseLinuxSecretSearchOutput,
} from "./linux_keychain.ts";
export { createMacKeychain } from "./mac_keychain.ts";
export { createWindowsKeychain } from "./windows_keychain.ts";
export { probeWindowsDpapi } from "./dpapi_crypto.ts";
export { buildDpapiSecretStore } from "./dpapi_store.ts";
export { migrateEncryptedFileToDpapi } from "./windows_migration.ts";
export { invokeCommand, runCommand } from "./command_runner.ts";
