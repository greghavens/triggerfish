/**
 * Triggerfish configuration loading, validation, and secret resolution.
 *
 * Provides the TriggerFishConfig interface along with loadConfig,
 * validateConfig, and loadConfigWithSecrets helpers.
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import { resolveConfigSecrets } from "./secrets/resolver.ts";
import type { SecretStore } from "./secrets/keychain.ts";

/** Triggerfish YAML configuration shape. */
export interface TriggerFishConfig {
  readonly models: {
    readonly primary: { readonly provider: string; readonly model: string };
    readonly vision?: string;
    /** Optional per-classification provider/model overrides. */
    readonly classification?: Readonly<Record<string, {
      readonly provider: string;
      readonly model?: string;
    }>>;
    readonly providers: Readonly<
      Record<string, { readonly model?: string; readonly apiKey?: string }>
    >;
  };
  readonly channels: Readonly<Record<string, unknown>>;
  readonly classification: {
    readonly mode: string;
  };
  readonly web?: {
    readonly search?: {
      readonly provider?: string;
      readonly api_key?: string;
      readonly max_results?: number;
      readonly safe_search?: string;
      readonly rate_limit?: number;
    };
    readonly fetch?: {
      readonly rate_limit?: number;
      readonly max_content_length?: number;
      readonly timeout?: number;
      readonly default_mode?: string;
    };
    readonly domains?: {
      readonly denylist?: readonly string[];
      readonly allowlist?: readonly string[];
      readonly classifications?: readonly {
        readonly pattern: string;
        readonly classification: string;
      }[];
    };
  };
  readonly google?: {
    readonly classification?: string;
  };
  readonly github?: {
    readonly token?: string;
    readonly base_url?: string;
    readonly classification?: string;
    readonly classification_overrides?: Readonly<Record<string, string>>;
  };
  readonly scheduler?: {
    readonly trigger?: {
      readonly enabled?: boolean;
      readonly interval_minutes?: number;
      readonly quiet_hours?: {
        readonly start?: number;
        readonly end?: number;
      };
      /**
       * Classification ceiling for trigger sessions.
       * Integration tools classified above this level are blocked.
       * Defaults to "CONFIDENTIAL" when not set — triggers routinely need
       * access to CONFIDENTIAL integrations such as Gmail.
       * Set to "INTERNAL" explicitly to restrict trigger access.
       */
      readonly classification_ceiling?: string;
    };
    readonly webhooks?: {
      readonly enabled?: boolean;
      readonly sources?: Readonly<
        Record<string, {
          readonly secret: string;
          readonly classification: string;
        }>
      >;
    };
  };
  readonly plugins?: {
    readonly obsidian?: {
      readonly enabled?: boolean;
      readonly vault_path?: string;
      readonly classification?: string;
      readonly daily_notes?: {
        readonly folder?: string;
        readonly date_format?: string;
        readonly template?: string;
      };
      readonly exclude_folders?: readonly string[];
      readonly folder_classifications?: Readonly<Record<string, string>>;
    };
  };
  readonly filesystem?: {
    readonly default?: string;
    readonly paths?: Readonly<Record<string, string>>;
  };
  readonly tools?: {
    readonly floors?: Readonly<Record<string, string>>;
  };
  readonly mcp_servers?: Readonly<Record<string, {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
    readonly classification?: string;
    readonly enabled?: boolean;
  }>>;
  readonly logging?: {
    /** Log level: "quiet" | "normal" | "verbose" | "debug". Default: "normal". */
    readonly level?: string;
  };
  readonly debug?: boolean;
}

/** Success result. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failure result. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Discriminated union result type. */
export type Result<T, E> = Ok<T> | Err<E>;

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

    const validation = validateConfig(parsed as Record<string, unknown>);
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
export function validateConfig(
  obj: Record<string, unknown>,
): Result<void, string> {
  // models must exist and have a primary field
  if (typeof obj.models !== "object" || obj.models === null) {
    return { ok: false, error: "Missing required field: models" };
  }

  const models = obj.models as Record<string, unknown>;
  // Accept both legacy string format (primary: "model-name") and
  // structured format (primary: { provider: "...", model: "..." })
  if (typeof models.primary === "string") {
    // Legacy format — valid as long as it's non-empty
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

  // Validate models.classification if present
  const classification = models.classification as Record<string, unknown> | undefined;
  if (classification !== undefined && classification !== null) {
    const validLevels = new Set(["RESTRICTED", "CONFIDENTIAL", "INTERNAL", "PUBLIC"]);
    const providerNames = new Set(
      Object.keys((models.providers as Record<string, unknown> | undefined) ?? {})
    );
    for (const [level, ref] of Object.entries(classification)) {
      if (!validLevels.has(level)) {
        return {
          ok: false,
          error: `models.classification: unknown level "${level}"`,
        };
      }
      const r = ref as Record<string, unknown>;
      if (typeof r.provider !== "string" || r.provider.length === 0) {
        return {
          ok: false,
          error: `models.classification.${level}: missing provider`,
        };
      }
      if (!providerNames.has(r.provider)) {
        return {
          ok: false,
          error: `models.classification.${level}: provider "${r.provider}" not in models.providers`,
        };
      }
    }
  }

  return { ok: true, value: undefined };
}

/**
 * Load and parse a triggerfish YAML configuration file, resolving all
 * `secret:<key>` references from the OS keychain.
 *
 * Unlike the synchronous `loadConfig()`, this function performs async
 * secret resolution after parsing the YAML. If any `secret:` reference
 * cannot be found in the keychain, the function returns an error rather
 * than starting with an empty or null value (fail-fast behavior).
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

  // Re-validate after secret resolution (resolved values could affect structure)
  const validation = validateConfig(resolved.value as Record<string, unknown>);
  if (!validation.ok) {
    return validation as Err<string>;
  }

  return { ok: true, value: resolved.value as TriggerFishConfig };
}
