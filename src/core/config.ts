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
import {
  scheduledObservationGrantSource,
  selectSentinelDelegatedObservationRead,
  selectSentinelScheduledObservationRead,
  selectSentinelTeamObservationRead,
  sentinelOutputLanguages,
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

  const sentinel = obj.sentinel as Record<string, unknown> | undefined;
  const allowModelAccess = sentinel?.allow_model_access;
  if (allowModelAccess !== undefined && typeof allowModelAccess !== "boolean") {
    return {
      ok: false,
      error: "sentinel.allow_model_access must be a boolean",
    };
  }

  const outputLanguage = sentinel?.output_language;
  const notifyIncidentIncreases = sentinel?.notify_incident_increases;
  if (
    notifyIncidentIncreases !== undefined &&
    typeof notifyIncidentIncreases !== "boolean"
  ) {
    return {
      ok: false,
      error: "sentinel.notify_incident_increases must be a boolean",
    };
  }

  if (
    outputLanguage !== undefined &&
    !sentinelOutputLanguages.some((language) => language === outputLanguage)
  ) {
    return {
      ok: false,
      error: "sentinel.output_language must be en, es, ko, zh, or ja",
    };
  }

  const modelWorkerLimit = sentinel?.model_worker_limit;
  if (
    modelWorkerLimit !== undefined &&
    (typeof modelWorkerLimit !== "number" ||
      !Number.isSafeInteger(modelWorkerLimit) || modelWorkerLimit < 1)
  ) {
    return {
      ok: false,
      error: "sentinel.model_worker_limit must be a positive safe integer",
    };
  }
  const plannerHeartbeat = sentinel?.planner_heartbeat_seconds;
  if (
    plannerHeartbeat !== undefined &&
    (typeof plannerHeartbeat !== "number" ||
      !Number.isSafeInteger(plannerHeartbeat) || plannerHeartbeat < 600 ||
      plannerHeartbeat > 86_400)
  ) {
    return {
      ok: false,
      error:
        "sentinel.planner_heartbeat_seconds must be an integer from 600 to 86400",
    };
  }
  const workflowReads = sentinel?.github_workflow_reads;
  if (
    workflowReads !== undefined && !validSentinelWorkflowReads(workflowReads)
  ) {
    return {
      ok: false,
      error:
        "sentinel.github_workflow_reads must contain unique case and asset mappings to exact GitHub repository workflows",
    };
  }

  const observationReads = sentinel?.scheduled_observation_reads;
  if (
    observationReads !== undefined &&
    (!Array.isArray(observationReads) || observationReads.length > 64 ||
      !observationReads.every((grant) => {
        const source = scheduledObservationGrantSource(grant);
        return source &&
          selectSentinelScheduledObservationRead(observationReads, source);
      }))
  ) {
    return {
      ok: false,
      error:
        "sentinel.scheduled_observation_reads must contain unique cron, trigger, or webhook source grants to exact saved observations",
    };
  }

  const delegatedReads = sentinel?.delegated_observation_reads;
  if (
    delegatedReads !== undefined &&
    (!Array.isArray(delegatedReads) || delegatedReads.length > 64 ||
      !delegatedReads.every((grant) =>
        selectSentinelDelegatedObservationRead(delegatedReads, {
          parentSessionId: grant?.parent_session_id,
          executionId: grant?.execution_id,
        })
      ))
  ) {
    return {
      ok: false,
      error:
        "sentinel.delegated_observation_reads must contain unique parent session and execution UUID grants to exact saved observations",
    };
  }

  const teamReads = sentinel?.team_observation_reads;
  if (
    teamReads !== undefined &&
    (!Array.isArray(teamReads) || teamReads.length > 64 ||
      !teamReads.every((grant) =>
        selectSentinelTeamObservationRead(teamReads, {
          ownerSessionId: grant?.owner_session_id,
          teamId: grant?.team_id,
          memberSessionId: grant?.member_session_id,
          deliveryId: grant?.delivery_id,
        })
      ))
  ) {
    return {
      ok: false,
      error:
        "sentinel.team_observation_reads must contain unique owner, team, member and delivery UUID grants to exact saved observations",
    };
  }

  const web = obj.web as Record<string, unknown> | undefined;
  const domains = web?.domains as Record<string, unknown> | undefined;
  const containment = domains?.sentinel_containment;
  if (containment !== undefined && typeof containment !== "boolean") {
    return {
      ok: false,
      error: "web.domains.sentinel_containment must be a boolean",
    };
  }

  return { ok: true, value: undefined };
}

function validSentinelWorkflowReads(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  const scopes = new Set<string>();
  for (const record of value) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return false;
    }
    const { case: caseId, asset, owner, repo, workflow_id } = record;
    if (
      Object.keys(record).length !== 5 ||
      typeof caseId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(caseId) ||
      typeof asset !== "string" || !asset.trim() || asset.length > 4096 ||
      asset.includes("\x00") ||
      typeof owner !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
      typeof repo !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
      repo === "." || repo === ".." ||
      !Number.isSafeInteger(workflow_id) || workflow_id < 1
    ) return false;
    const scope = JSON.stringify([caseId, asset]);
    if (scopes.has(scope)) return false;
    scopes.add(scope);
  }
  return true;
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
    // The Triggerfish Gateway selects models internally; the agent does not
    // send a model field. All other providers require an explicit model.
    if (primary.provider !== "triggerfish") {
      if (typeof primary.model !== "string" || primary.model.length === 0) {
        return {
          ok: false,
          error: "Missing required field: models.primary.model",
        };
      }
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
