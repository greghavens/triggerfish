/**
 * Healthcheck tool — introspects Triggerfish platform runtime.
 *
 * Reports status of providers, storage, skills, and config.
 * Output is classified INTERNAL minimum — it reveals system internals.
 *
 * @module
 */

import type { ToolDefinition } from "../core/types/tool.ts";
import type { LlmProviderRegistry } from "../core/types/llm.ts";
import type { StorageProvider } from "../core/storage/provider.ts";
import type { SkillLoader } from "./skills/loader.ts";

/** Dependencies for the healthcheck executor. All optional — missing deps result in degraded/error status. */
export interface HealthcheckDeps {
  readonly providerRegistry?: LlmProviderRegistry;
  readonly storageProvider?: StorageProvider;
  readonly skillLoader?: SkillLoader;
}

/** Health status for a single component. */
interface ComponentHealth {
  readonly name: string;
  readonly status: "healthy" | "degraded" | "error";
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** Valid component names for the healthcheck tool. */
type HealthcheckComponent =
  | "providers"
  | "storage"
  | "skills"
  | "config"
  | "all";

/** Tool definitions for the healthcheck tool. */
export function buildHealthcheckToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "healthcheck",
      description:
        "Check the health status of Triggerfish components. Returns status per " +
        "component: healthy, degraded, or error. Overall status is the worst " +
        "of all checked components.",
      parameters: {
        components: {
          type: "array",
          description:
            "Components to check: providers, storage, skills, config, all. Default: all.",
          required: false,
          items: { type: "string" },
        },
      },
    },
  ];
}

/** Platform-level system prompt section for the healthcheck tool. */
export const HEALTHCHECK_SYSTEM_PROMPT = `## Healthcheck Tool

The healthcheck tool inspects Triggerfish's own runtime health.
Use it when the user asks "is everything working?", "check status", or diagnoses issues.
Components: providers, storage, skills, config, all.`;

/** Check provider health. */
function checkProviders(registry?: LlmProviderRegistry): ComponentHealth {
  if (!registry) {
    return {
      name: "providers",
      status: "error",
      message: "No provider registry available",
    };
  }
  const defaultProvider = registry.getDefault();
  if (!defaultProvider) {
    return {
      name: "providers",
      status: "degraded",
      message: "Provider registry exists but no default provider set",
    };
  }
  return {
    name: "providers",
    status: "healthy",
    message: `Default provider: ${defaultProvider.name}`,
    details: { defaultProvider: defaultProvider.name },
  };
}

/** Execute a storage round-trip test: write, read-back, delete. */
async function executeStorageRoundTrip(
  storage: StorageProvider,
): Promise<ComponentHealth> {
  const testKey = "healthcheck:test";
  const testValue = `healthcheck-${Date.now()}`;
  await storage.set(testKey, testValue);
  const read = await storage.get(testKey);
  await storage.delete(testKey);
  if (read !== testValue) {
    return {
      name: "storage",
      status: "degraded",
      message: "Storage read/write mismatch",
      details: { expected: testValue, got: read },
    };
  }
  return {
    name: "storage",
    status: "healthy",
    message: "Read/write/delete round-trip OK",
  };
}

/** Check storage health via read/write/delete round-trip. */
async function checkStorage(
  storage?: StorageProvider,
): Promise<ComponentHealth> {
  if (!storage) {
    return {
      name: "storage",
      status: "error",
      message: "No storage provider available",
    };
  }
  try {
    return await executeStorageRoundTrip(storage);
  } catch (err) {
    return {
      name: "storage",
      status: "error",
      message: `Storage error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Discover skills and build a health result from the discovery. */
async function discoverSkillHealth(
  loader: SkillLoader,
): Promise<ComponentHealth> {
  const skills = await loader.discover();
  const bySource: Record<string, number> = {};
  for (const skill of skills) {
    bySource[skill.source] = (bySource[skill.source] ?? 0) + 1;
  }
  return {
    name: "skills",
    status: "healthy",
    message: `${skills.length} skills discovered`,
    details: { total: skills.length, bySource },
  };
}

/** Check skill loader health. */
async function checkSkills(loader?: SkillLoader): Promise<ComponentHealth> {
  if (!loader) {
    return {
      name: "skills",
      status: "error",
      message: "No skill loader available",
    };
  }
  try {
    return await discoverSkillHealth(loader);
  } catch (err) {
    return {
      name: "skills",
      status: "error",
      message: `Skill discovery failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Check config health (basic validation). */
function checkConfig(): ComponentHealth {
  return {
    name: "config",
    status: "healthy",
    message: "Configuration loaded",
  };
}

/** Format component health results as a structured text report. */
function formatReport(results: readonly ComponentHealth[]): string {
  const lines: string[] = ["# Healthcheck Report", ""];
  for (const r of results) {
    const icon = r.status === "healthy"
      ? "OK"
      : r.status === "degraded"
      ? "WARN"
      : "ERR";
    lines.push(`[${icon}] ${r.name}: ${r.message}`);
    if (r.details) {
      lines.push(`     ${JSON.stringify(r.details)}`);
    }
  }
  const hasError = results.some((r) => r.status === "error");
  const hasDegraded = results.some((r) => r.status === "degraded");
  const overall = hasError ? "ERROR" : hasDegraded ? "DEGRADED" : "HEALTHY";
  lines.push("", `Overall: ${overall}`);
  return lines.join("\n");
}

/**
 * Create a tool executor for the healthcheck tool.
 *
 * Returns null for unrecognized tool names (chain pattern).
 */
export function createHealthcheckToolExecutor(
  deps: HealthcheckDeps,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "healthcheck") return null;

    const rawComponents = input.components;
    const requested: readonly HealthcheckComponent[] =
      Array.isArray(rawComponents) && rawComponents.length > 0
        ? rawComponents.filter((c): c is HealthcheckComponent =>
          typeof c === "string" &&
          ["providers", "storage", "skills", "config", "all"].includes(c)
        )
        : ["all"];

    const checkAll = requested.includes("all");
    const results: ComponentHealth[] = [];

    if (checkAll || requested.includes("providers")) {
      results.push(checkProviders(deps.providerRegistry));
    }
    if (checkAll || requested.includes("storage")) {
      results.push(await checkStorage(deps.storageProvider));
    }
    if (checkAll || requested.includes("skills")) {
      results.push(await checkSkills(deps.skillLoader));
    }
    if (checkAll || requested.includes("config")) {
      results.push(checkConfig());
    }

    return formatReport(results);
  };
}

/** @deprecated Use buildHealthcheckToolDefinitions instead */
export const getHealthcheckToolDefinitions = buildHealthcheckToolDefinitions;
