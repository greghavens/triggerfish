/**
 * Triggerfish configuration loading, validation, and secret resolution.
 *
 * Provides the TriggerFishConfig interface along with loadConfig,
 * enforceConfig, and loadConfigWithSecrets helpers.
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import { resolveConfigSecrets } from "./secrets/resolver.ts";
import type { SecretStore } from "./secrets/keychain/keychain.ts";

// Re-export all types so existing importers continue to work
export type {
  Err,
  Ok,
  PluginConfigEntry,
  Result,
  TriggerFishConfig,
} from "./config_types.ts";
import type { Err, Result, TriggerFishConfig } from "./config_types.ts";

/**
 * Load and parse a triggerfish YAML configuration file.
 *
 * @param path - Absolute path to the YAML file.
 * @returns Result with parsed config or error string.
 */
export function loadConfig(path: string): Result<TriggerFishConfig, string> {
  try {
    const raw = Deno.readTextFileSync(path);
    const parsed = parseYaml(raw);

    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, error: "Config file did not parse to an object" };
    }

    const validation = enforceConfig(parsed as Record<string, unknown>);
    if (!validation.ok) {
      return validation as Err<string>;
    }

    return { ok: true, value: parsed as unknown as TriggerFishConfig };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to load config: ${message}` };
  }
}

/**
 * Validate a parsed config object has all required fields.
 *
 * @param obj - Parsed object to validate.
 * @returns Result indicating validity or the first validation error.
 */
export function enforceConfig(
  obj: Record<string, unknown>,
): Result<void, string> {
  if (typeof obj.models !== "object" || obj.models === null) {
    return { ok: false, error: "Missing required field: models" };
  }

  const models = obj.models as Record<string, unknown>;
  const primaryResult = validatePrimaryModel(models);
  if (!primaryResult.ok) return primaryResult;

  const classResult = validateClassificationModels(models);
  if (!classResult.ok) return classResult;

  return { ok: true, value: undefined };
}

/** Validate the models.primary field (string or structured object). */
function validatePrimaryModel(
  models: Record<string, unknown>,
): Result<void, string> {
  if (typeof models.primary === "string") {
    if (models.primary.length === 0) {
      return { ok: false, error: "models.primary must not be empty" };
    }
  } else if (typeof models.primary === "object" && models.primary !== null) {
    const primary = models.primary as Record<string, unknown>;
    if (typeof primary.provider !== "string" || primary.provider.length === 0) {
      return {
        ok: false,
        error: "Missing required field: models.primary.provider",
      };
    }
    if (typeof primary.model !== "string" || primary.model.length === 0) {
      return {
        ok: false,
        error: "Missing required field: models.primary.model",
      };
    }
  } else {
    return {
      ok: false,
      error:
        "models.primary must be a string or object with provider and model",
    };
  }
  return { ok: true, value: undefined };
}

/** Validate the optional models.classification_models block. */
function validateClassificationModels(
  models: Record<string, unknown>,
): Result<void, string> {
  if (
    models.classification_models === undefined ||
    models.classification_models === null
  ) {
    return { ok: true, value: undefined };
  }

  if (typeof models.classification_models !== "object") {
    return {
      ok: false,
      error: "models.classification_models must be an object",
    };
  }
  const validLevels = new Set([
    "RESTRICTED",
    "CONFIDENTIAL",
    "INTERNAL",
    "PUBLIC",
  ]);
  const classModels = models.classification_models as Record<string, unknown>;
  for (const [level, ref] of Object.entries(classModels)) {
    if (!validLevels.has(level)) {
      return {
        ok: false,
        error:
          `models.classification_models: invalid classification level "${level}"`,
      };
    }
    if (typeof ref !== "object" || ref === null) {
      return {
        ok: false,
        error:
          `models.classification_models.${level} must be an object with provider and model`,
      };
    }
    const entry = ref as Record<string, unknown>;
    if (typeof entry.provider !== "string" || entry.provider.length === 0) {
      return {
        ok: false,
        error:
          `models.classification_models.${level}: missing required field "provider"`,
      };
    }
    if (typeof entry.model !== "string" || entry.model.length === 0) {
      return {
        ok: false,
        error:
          `models.classification_models.${level}: missing required field "model"`,
      };
    }
  }
  return { ok: true, value: undefined };
}

/** @deprecated Use enforceConfig instead */
export const validateConfig = enforceConfig;

/**
 * Load and parse a triggerfish YAML configuration file, resolving all
 * `secret:<key>` references from the OS keychain.
 *
 * @param path - Absolute path to the YAML file.
 * @param store - Secret store to resolve `secret:` references from.
 * @returns Result with parsed and secret-resolved config, or error string.
 */
export async function loadConfigWithSecrets(
  path: string,
  store: SecretStore,
): Promise<Result<TriggerFishConfig, string>> {
  const raw = loadConfig(path);
  if (!raw.ok) {
    return raw;
  }

  const resolved = await resolveConfigSecrets(raw.value, store);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  const validation = enforceConfig(resolved.value as Record<string, unknown>);
  if (!validation.ok) {
    return validation as Err<string>;
  }

  return { ok: true, value: resolved.value as TriggerFishConfig };
}
