/**
 * Secret management: keychain CRUD and plaintext-to-keychain migration.
 * @module
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { backupConfig, resolveConfigPath } from "./paths.ts";
import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import { findSecretRefs } from "../../core/secrets/resolver.ts";
import { readNestedYamlValue, writeNestedYamlValue } from "./config.ts";
import type { SecretFieldDescriptor } from "./secrets_fields.ts";
import {
  collectProviderSecretFields,
  KNOWN_SECRET_FIELDS,
} from "./secrets_fields.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("cli.secrets");

/**
 * Store a secret in the OS keychain.
 */
export async function storeSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;
  const value = flags["secret_value"] as string | undefined;

  if (!key || value === undefined) {
    console.error("Usage: triggerfish config set-secret <key> <value>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.setSecret(key, value);
  if (result.ok) {
    console.log(`Secret "${key}" stored in keychain.`);
  } else {
    log.error("Secret store failed", {
      operation: "setSecret",
      key,
      error: result.error,
    });
    console.error(`Failed to store secret: ${result.error}`);
    Deno.exit(1);
  }
}

/**
 * Retrieve a secret from the OS keychain.
 */
export async function retrieveSecret(
  flags: Readonly<Record<string, boolean | string>>,
): Promise<void> {
  const key = flags["secret_key"] as string | undefined;

  if (!key) {
    console.error("Usage: triggerfish config get-secret <key>");
    Deno.exit(1);
  }

  const store = createKeychain();
  const result = await store.getSecret(key);
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(`Secret "${key}" not found in keychain.`);
    Deno.exit(1);
  }
}

/** Result of reading and parsing the config YAML file. */
interface ParsedConfigResult {
  readonly configPath: string;
  readonly parsed: Record<string, unknown>;
}

/**
 * Read and parse the triggerfish.yaml config file.
 *
 * Exits the process if the file cannot be read or parsed.
 */
function loadConfigYaml(): ParsedConfigResult {
  const configPath = resolveConfigPath();

  let raw: string;
  try {
    raw = Deno.readTextFileSync(configPath);
  } catch (err: unknown) {
    log.error("Configuration file read failed", {
      operation: "loadConfigYaml",
      configPath,
      err,
    });
    console.error(`Cannot read config: ${configPath}`);
    Deno.exit(1);
  }

  try {
    const p = parseYaml(raw);
    if (typeof p !== "object" || p === null) {
      log.error("Configuration file did not parse to an object", {
        operation: "loadConfigYaml",
        configPath,
      });
      console.error("Config file did not parse to an object");
      Deno.exit(1);
    }
    return { configPath, parsed: p as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Configuration parse failed", {
      operation: "loadConfigYaml",
      err,
    });
    console.error(`Failed to parse config: ${message}`);
    Deno.exit(1);
  }
}

/** Outcome of migrating secret fields to the keychain. */
interface SecretMigrationOutcome {
  readonly migrated: ReadonlyArray<{
    readonly path: string;
    readonly keychainKey: string;
  }>;
  readonly alreadyRefs: readonly string[];
}

/**
 * Iterate all secret field descriptors, store plaintext values in the keychain,
 * and rewrite config entries with `secret:` references.
 *
 * Exits the process if any keychain write fails.
 */
async function migrateSecretFieldsToKeychain(
  parsed: Record<string, unknown>,
  allFields: ReadonlyArray<SecretFieldDescriptor>,
): Promise<SecretMigrationOutcome> {
  const store = createKeychain();
  const migrated: Array<{ path: string; keychainKey: string }> = [];
  const alreadyRefs: string[] = [];

  for (const field of allFields) {
    const value = readNestedYamlValue(parsed, field.path);
    if (typeof value !== "string" || value.length === 0) continue;

    if (value.startsWith("secret:")) {
      alreadyRefs.push(field.path);
      continue;
    }

    const keychainKey = field.keychainKey(parsed);
    if (!keychainKey) continue;

    const result = await store.setSecret(keychainKey, value);
    if (!result.ok) {
      log.error("Secret migration store failed", {
        operation: "migrateSecrets",
        field: field.path,
        error: result.error,
      });
      console.error(
        `Failed to store secret for ${field.path}: ${result.error}`,
      );
      Deno.exit(1);
    }

    writeNestedYamlValue(parsed, field.path, `secret:${keychainKey}`);
    migrated.push({ path: field.path, keychainKey });
  }

  return { migrated, alreadyRefs };
}

/**
 * Write the updated config YAML back to disk after creating a backup.
 */
async function persistMigratedSecretConfig(
  configPath: string,
  parsed: Record<string, unknown>,
): Promise<void> {
  await backupConfig(configPath);
  const yaml = stringifyYaml(parsed);
  const content =
    `# Triggerfish Configuration\n# Generated by triggerfish dive\n\n${yaml}`;
  await Deno.writeTextFile(configPath, content);
}

/**
 * Print a summary of migration results to the console.
 */
function reportSecretMigrationResults(
  configPath: string,
  parsed: Record<string, unknown>,
  { migrated, alreadyRefs }: SecretMigrationOutcome,
): void {
  console.log(`\nMigrated ${migrated.length} secret(s) to OS keychain:\n`);
  for (const { path, keychainKey } of migrated) {
    console.log(`  ${path}  \u2192  secret:${keychainKey}`);
  }
  console.log(`\nBackup saved. Config updated: ${configPath}`);

  if (alreadyRefs.length > 0) {
    console.log(
      `\n${alreadyRefs.length} field(s) already used secret: references (unchanged):`,
    );
    for (const p of alreadyRefs) {
      console.log(`  ${p}`);
    }
  }

  const allRefs = findSecretRefs(parsed);
  if (allRefs.length > 0) {
    console.log(
      `\n${allRefs.length} total secret: reference(s) now in config.`,
    );
  }

  console.log();
}

/**
 * Migrate plaintext secrets in triggerfish.yaml to the OS keychain.
 *
 * Detects plaintext values in known secret fields, stores them in
 * the keychain, and rewrites the config with `secret:` references.
 * Creates a timestamped backup before modifying the file.
 */
export async function migrateSecretsToKeychain(): Promise<void> {
  const { configPath, parsed } = loadConfigYaml();
  const dynamicFields = collectProviderSecretFields(parsed);
  const allFields = [...KNOWN_SECRET_FIELDS, ...dynamicFields];

  const outcome = await migrateSecretFieldsToKeychain(parsed, allFields);

  if (outcome.migrated.length === 0) {
    if (outcome.alreadyRefs.length > 0) {
      console.log(
        `All ${outcome.alreadyRefs.length} secret field(s) already use secret: references. Nothing to migrate.`,
      );
    } else {
      console.log(
        "No plaintext secrets found in known fields. Nothing to migrate.",
      );
    }
    return;
  }

  await persistMigratedSecretConfig(configPath, parsed);
  reportSecretMigrationResults(configPath, parsed, outcome);
}

/** @deprecated Use storeSecret instead */
export const runConfigSetSecret = storeSecret;

/** @deprecated Use retrieveSecret instead */
export const runConfigGetSecret = retrieveSecret;

/** @deprecated Use migrateSecretsToKeychain instead */
export const runConfigMigrateSecrets = migrateSecretsToKeychain;
