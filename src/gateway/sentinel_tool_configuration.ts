/** Reviewed Sentinel built-in settings. Runtime role bindings remain authoritative. */
/// <reference path="../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { redactCredentialText } from "../core/logger/redactor.ts";
import type { ToolDefinition } from "../core/types/tool.ts";

export const sentinelToolConfigurationRoles = [
  "chat",
  "planner",
  "worker",
  "delegate",
] as const;
export type SentinelToolConfigurationRole =
  typeof sentinelToolConfigurationRoles[number];

type Scalar = string | number | boolean;

interface ParameterOverride {
  readonly description?: string;
  readonly default?: Scalar;
}

interface Settings {
  readonly enabled: boolean;
  readonly roles: readonly SentinelToolConfigurationRole[];
  readonly description?: string;
  readonly parameters?: Readonly<
    Record<string, ParameterOverride>
  >;
}

interface SettingReceipt {
  readonly name: string;
  readonly version: number;
  readonly settings: Settings;
  readonly requestId: string;
  readonly operatorSessionId: string;
  readonly recordedAt: string;
}

const parameterName = /^[A-Za-z][A-Za-z0-9_]{0,95}$/;
const requestIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const pagingDefaults: Readonly<Record<string, number>> = {
  sentinel_traffic_search: 10,
  sentinel_provenance_search: 10,
};

function input(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function description(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= 800 && value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && redactCredentialText(value) === value;
}

function settingsFor(name: string, value: unknown): Settings | undefined {
  const request = input(value);
  if (
    !request ||
    Object.keys(request).some((key) =>
      !["enabled", "roles", "description", "parameters"].includes(key)
    )
  ) return;
  const { enabled, roles, description: text, parameters } = request;
  if (
    typeof enabled !== "boolean" || !Array.isArray(roles) ||
    roles.length > sentinelToolConfigurationRoles.length ||
    new Set(roles).size !== roles.length ||
    roles.some((role) =>
      !sentinelToolConfigurationRoles.some((allowed) => role === allowed)
    ) || (text !== undefined && !description(text))
  ) return;
  const entries = parameters === undefined ? {} : input(parameters);
  if (!entries || Object.keys(entries).length > 12) return;
  const supplied: Record<string, ParameterOverride> = {};
  for (const [param, raw] of Object.entries(entries).sort()) {
    const item = input(raw);
    if (
      !parameterName.test(param) || !item || !Object.keys(item).length ||
      Object.keys(item).some((key) => !["description", "default"].includes(key))
    ) return;
    const { description: paramText, default: fallback } = item;
    const approvedDefault =
      (param === "limit" && Object.hasOwn(pagingDefaults, name) &&
        typeof fallback === "number" && Number.isSafeInteger(fallback) &&
        fallback >= 1 && fallback <= pagingDefaults[name]) ||
      (param === "query" && name === "sentinel_provenance_search" &&
        description(fallback) && fallback.length <= 64) ||
      (param === "includeFindings" && name === "sentinel_shared_asset_links" &&
        typeof fallback === "boolean");
    if (
      (paramText !== undefined && !description(paramText)) ||
      (fallback !== undefined && !approvedDefault)
    ) return;
    supplied[param] = {
      ...(paramText !== undefined && { description: paramText }),
      ...(fallback !== undefined && { default: fallback as Scalar }),
    };
  }
  return {
    enabled,
    roles: sentinelToolConfigurationRoles.filter((role) =>
      roles.includes(role)
    ),
    ...(text !== undefined && { description: text }),
    ...(Object.keys(supplied).length && { parameters: supplied }),
  };
}

export function parseSentinelToolConfigurationUpdate(
  name: unknown,
  value: unknown,
  expectedVersion: unknown,
  requestId: unknown,
) {
  if (
    typeof name !== "string" || !/^sentinel_[a-z0-9_]{1,80}$/.test(name) ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
    typeof requestId !== "string" || !requestIdPattern.test(requestId)
  ) return;
  const settings = settingsFor(name, value);
  return settings && { name, settings, expectedVersion, requestId };
}

type Update = NonNullable<
  ReturnType<typeof parseSentinelToolConfigurationUpdate>
>;

/** Read and update the exact durable settings store while keeping the registry immutable. */
export function sentinelToolConfigurations(baseDir: string) {
  const path = join(baseDir, "sentinel-tool-configuration.db");
  function ensurePrivateStore() {
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const file = Deno.lstatSync(path);
    if (
      !file.isFile || file.isSymlink || (file.nlink ?? 1) !== 1 ||
      ((file.mode ?? 0) & 0o077) !== 0
    ) throw new Error("Sentinel tool configuration store is unavailable.");
  }
  const withStore = <T>(run: (db: DatabaseSync) => T) => {
    ensurePrivateStore();
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        PRAGMA busy_timeout = 3000;
        CREATE TABLE IF NOT EXISTS sentinel_tool_settings (
          name TEXT PRIMARY KEY, version INTEGER NOT NULL, receipt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sentinel_tool_setting_receipts (
          id TEXT PRIMARY KEY, receipt TEXT NOT NULL
        );
      `);
      return run(db);
    } finally {
      db.close();
    }
  };
  function decode(row: Record<string, unknown> | undefined) {
    if (!row) return;
    return JSON.parse(String(row.receipt)) as SettingReceipt;
  }
  function read(name: string) {
    try {
      Deno.statSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    return withStore((db) =>
      decode(
        db.prepare("SELECT receipt FROM sentinel_tool_settings WHERE name = ?")
          .get(name),
      )
    );
  }
  return {
    read,
    receipt(update: Update) {
      const current = read(update.name);
      if (
        current?.requestId === update.requestId &&
        current.version === update.expectedVersion + 1 &&
        JSON.stringify(current.settings) === JSON.stringify(update.settings)
      ) {
        return current;
      }
    },
    commit(update: Update, operatorSessionId: string) {
      if (!requestIdPattern.test(operatorSessionId)) return;
      return withStore((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const { name, expectedVersion, settings, requestId } = update;
          const current = decode(
            db.prepare(
              "SELECT receipt FROM sentinel_tool_settings WHERE name = ?",
            ).get(name),
          );
          const receipt = {
            name,
            version: expectedVersion + 1,
            settings,
            requestId,
            operatorSessionId,
            recordedAt: new Date().toISOString(),
          };
          const existing = decode(
            db.prepare(
              "SELECT receipt FROM sentinel_tool_setting_receipts WHERE id = ?",
            ).get(requestId),
          );
          if (existing || (current?.version ?? 0) !== expectedVersion) {
            db.exec("ROLLBACK");
            return;
          }
          const serialized = JSON.stringify(receipt);
          db.prepare("INSERT INTO sentinel_tool_setting_receipts VALUES (?, ?)")
            .run(requestId, serialized);
          db.prepare(`INSERT INTO sentinel_tool_settings VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET version=excluded.version, receipt=excluded.receipt`)
            .run(name, receipt.version, serialized);
          db.exec("COMMIT");
          return receipt;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}

export function configureSentinelToolDefinition(
  definition: ToolDefinition,
  role: SentinelToolConfigurationRole,
  receipt: SettingReceipt | undefined,
) {
  if (!receipt) return definition;
  const { settings } = receipt;
  if (!settings.enabled || !settings.roles.includes(role)) return;
  return {
    ...definition,
    ...(settings.description !== undefined &&
      { description: settings.description }),
    parameters: Object.fromEntries(
      Object.entries(definition.parameters).map(([name, parameter]) => {
        const override = settings.parameters?.[name];
        return [name, {
          ...parameter,
          ...(override?.description !== undefined &&
            { description: override.description }),
          ...(override?.default !== undefined &&
            { default: override.default, required: false }),
        }];
      }),
    ),
  } satisfies ToolDefinition;
}
