/**
 * Core secrets management module.
 *
 * Provides OS keychain integration for secure secret storage
 * with Linux (libsecret), macOS (Keychain), and in-memory fallback.
 * Also supports environment variable and file-backed stores for
 * Docker and headless environments.
 *
 * @module
 */

// keychain/ — OS keychain integration
export {
  createKeychain,
  createLinuxKeychain,
  createMacKeychain,
  invokeCommand,
  parseLinuxSecretSearchOutput,
  resolveDockerKeyPath,
  runCommand,
} from "./keychain/mod.ts";

// validation/ — Docker security checks
export {
  isPermissionSecure,
  parseMountPoints,
  verifyKeyFilePermissions,
  verifyMountPoint,
} from "./validation/mod.ts";
export type {
  MountCheckResult,
  PermissionCheckError,
  PermissionCheckResult,
} from "./validation/mod.ts";

// backends/ — storage backends and interfaces
export {
  createFileSecretStore,
  createMemorySecretStore,
  isExternalProvider,
  loadOrCreateMachineKey,
  resolvePermissionStrictness,
  SECRET_SERVICE_NAME,
} from "./backends/mod.ts";
export type {
  ExternalSecretProvider,
  FileSecretStoreOptions,
  HealthStatus,
  MachineKeyOptions,
  PermissionStrictness,
  SecretMetadata,
  SecretStore,
} from "./backends/mod.ts";

// cache/ — LRU cache for external providers
export { createSecretCache } from "./cache/mod.ts";
export type {
  CacheStats,
  SecretCache,
  SecretCacheOptions,
} from "./cache/mod.ts";

// composite store — multi-backend dispatcher
export { createCompositeSecretStore } from "./composite_store.ts";
export type { CompositeSecretStoreOptions } from "./composite_store.ts";

// vault/ — HashiCorp Vault integration
export {
  createVaultAuth,
  createVaultClient,
  createVaultProvider,
} from "./vault/mod.ts";
export type {
  VaultAuth,
  VaultAuthMethod,
  VaultClient,
  VaultClientOptions,
  VaultProviderConfig,
  VaultProviderOptions,
} from "./vault/mod.ts";

// classification/ — path-to-classification mapping and access control
export {
  createGatedKeychain,
  createSecretAccessGate,
  createSecretClassifier,
} from "./classification/mod.ts";
export type {
  ClassificationMapping,
  GatedKeychainOptions,
  SecretAccessGate,
  SecretAccessGateOptions,
  SecretAccessHookInput,
  SecretAccessHookResult,
  SecretClassifier,
  SecretClassifierConfig,
} from "./classification/mod.ts";

// encrypted/ — AES-256-GCM encrypted file store
export { createEncryptedFileSecretStore } from "./encrypted/mod.ts";
export type { EncryptedFileSecretStoreOptions } from "./encrypted/mod.ts";

// resolver — secret reference resolution
export {
  findSecretRefs,
  resolveConfigSecrets,
  resolveSecretRef,
  resolveSecretRefs,
} from "./resolver.ts";
export type { ResolveResult } from "./resolver.ts";
