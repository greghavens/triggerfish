/// <reference path="../sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import type { HookRunner } from "./hooks/hook_types.ts";

export interface ReviewedToolRule {
  readonly effect: "ask" | "block";
  readonly enabled: boolean;
  readonly tool?: string;
  readonly caseId?: string;
  readonly runId?: string;
  readonly assetId?: string;
  readonly destinationHost?: string;
}

export interface ReviewedRuleChange {
  readonly id: string;
  readonly expectedVersion: number;
  readonly rule: ReviewedToolRule | null;
}

const exactName = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
export const reviewedRuleId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const reviewedRuleActions = [
  "reviewed_tool_rules",
  "set_reviewed_tool_rule",
  "delete_reviewed_tool_rule",
  "reviewed_tool_reviewer",
  "set_reviewed_tool_reviewer",
  "reviewed_tool_advice",
] as const;
const fields = ["tool", "caseId", "runId", "assetId"] as const;
const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function reviewedDestinationHostname(value: string): string | undefined {
  const hostname = value.toLowerCase().replace(/\.$/, "");
  if (
    hostname.length <= 253 && hostname.includes(".") &&
    hostname.split(".").every((label) => hostnameLabel.test(label))
  ) return hostname;
}

export function parseReviewedToolRule(
  value: unknown,
): ReviewedToolRule | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rule = value as Record<string, unknown>;
  if (
    Object.keys(rule).some((key) =>
      !["effect", "enabled", "destinationHost", ...fields].includes(key)
    ) || (rule.effect !== "ask" && rule.effect !== "block") ||
    typeof rule.enabled !== "boolean"
  ) return;
  const scope: Partial<Record<(typeof fields)[number], string>> = {};
  for (const field of fields) {
    const selector = rule[field];
    if (selector === undefined) continue;
    if (typeof selector !== "string" || !exactName.test(selector)) return;
    scope[field] = selector;
  }
  if ((scope.assetId || scope.runId) && !scope.caseId) return;
  const destinationHost = typeof rule.destinationHost === "string"
    ? reviewedDestinationHostname(rule.destinationHost)
    : undefined;
  if (
    rule.destinationHost !== undefined &&
    (!destinationHost || rule.effect !== "block")
  ) return;
  return {
    effect: rule.effect,
    enabled: rule.enabled,
    ...scope,
    ...(destinationHost && { destinationHost }),
  };
}

interface RuleRecord extends ReviewedRuleChange {
  readonly version: number;
}

export function reviewedToolRules(baseDir: string) {
  const path = join(baseDir, "reviewed-tool-rules.db");
  function use<T>(write: boolean, empty: T, fn: (db: DatabaseSync) => T): T {
    try {
      if (!write) Deno.statSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return empty;
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      if (write) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, version INTEGER NOT NULL, rule TEXT);
          CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, change TEXT NOT NULL, result TEXT NOT NULL);
        `);
      }
      return fn(db);
    } finally {
      db.close();
    }
  }
  const lookup = (db: DatabaseSync, id: string) =>
    db.prepare("SELECT version FROM rules WHERE id=?").get(id)?.version;
  function replay(
    db: DatabaseSync,
    requestId: string,
    change: ReviewedRuleChange,
  ) {
    const prior = db.prepare("SELECT change,result FROM requests WHERE id=?")
      .get(requestId);
    return prior?.change === JSON.stringify(change)
      ? JSON.parse(String(prior.result)) as RuleRecord
      : undefined;
  }
  return {
    list(limit = 30, offset = 0) {
      return use(
        false,
        [] as RuleRecord[],
        (db) =>
          db.prepare(
            "SELECT id,version,rule FROM rules WHERE rule IS NOT NULL ORDER BY id LIMIT ? OFFSET ?",
          )
            .all(limit, offset).map(({ id, version, rule }) => {
              const parsed = parseReviewedToolRule(JSON.parse(String(rule)));
              if (!parsed) throw new Error("Invalid stored tool rule");
              return {
                id: String(id),
                version: Number(version),
                expectedVersion: Number(version) - 1,
                rule: parsed,
              };
            }),
      );
    },
    version(id: string) {
      return use(false, 0, (db) => Number(lookup(db, id) ?? 0));
    },
    receipt(requestId: string, change: ReviewedRuleChange) {
      return use(
        false,
        undefined as RuleRecord | undefined,
        (db) => replay(db, requestId, change),
      );
    },
    apply(requestId: string, change: ReviewedRuleChange) {
      return use(true, undefined as RuleRecord | undefined, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const prior = replay(db, requestId, change);
          if (prior) {
            db.exec("COMMIT");
            return prior;
          }
          const version = Number(lookup(db, change.id) ?? 0);
          if (
            db.prepare("SELECT id FROM requests WHERE id=?").get(requestId) ||
            version !== change.expectedVersion ||
            (version === 0 && (change.rule === null ||
              Number(
                  db.prepare("SELECT COUNT(*) AS count FROM rules").get()
                    ?.count,
                ) >= 256))
          ) {
            db.exec("ROLLBACK");
            return;
          }
          const result = { ...change, version: version + 1 };
          db.prepare(`INSERT INTO rules VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET version=excluded.version,rule=excluded.rule`)
            .run(
              change.id,
              result.version,
              change.rule && JSON.stringify(change.rule),
            );
          db.prepare("INSERT INTO requests VALUES (?,?,?)")
            .run(requestId, JSON.stringify(change), JSON.stringify(result));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}

export function withReviewedToolRules(
  hooks: HookRunner,
  baseDir: string,
): HookRunner {
  const store = reviewedToolRules(baseDir);
  return applyReviewedRules(hooks, () => store.list(256));
}

/** Overlay reviewed rules pinned to a run. The caller verifies run identity. */
export function withPinnedReviewedToolRules(
  hooks: HookRunner,
  read: () => {
    readonly runId: string;
    readonly rules: readonly ReviewedToolRule[];
  } | undefined,
): HookRunner {
  return applyReviewedRules(hooks, () => {
    const pinned = read();
    if (!pinned) return [];
    if (pinned.rules.length > 32 || !exactName.test(pinned.runId)) {
      throw new Error("Invalid pinned tool rules");
    }
    return pinned.rules.map((value, index) => {
      const rule = parseReviewedToolRule(value);
      if (!rule) throw new Error("Invalid pinned tool rule");
      return { id: `pinned:${pinned.runId}:${index}`, version: 1, rule };
    });
  });
}

function applyReviewedRules(
  hooks: HookRunner,
  read: () => readonly {
    readonly id: string;
    readonly version: number;
    readonly rule: ReviewedToolRule | null;
  }[],
): HookRunner {
  return {
    ...hooks,
    async evaluateHook(hook, context) {
      const base = await hooks.evaluateHook(hook, context);
      if (
        hook !== "PRE_TOOL_CALL" ||
        (base.action !== "ALLOW" && base.action !== "REQUIRE_APPROVAL")
      ) return base;
      const {
        tool_name: tool,
        case_id: caseId,
        run_id: runId,
        asset_id: assetId,
        reviewed_destination_host: destinationHost,
      } = context.input;
      const call = context.input.tool_call as
        | { args?: Record<string, unknown> }
        | undefined;
      if (
        tool === "operator_runs" && context.input.is_owner === true &&
        reviewedRuleActions.some((action) => action === call?.args?.action)
      ) return base;
      const input = { tool, caseId, runId, assetId };
      try {
        const visible = read().filter(({ rule }) =>
          rule?.enabled &&
          (rule.destinationHost === undefined ||
            rule.destinationHost === destinationHost) &&
          fields.every((field) =>
            rule[field] === undefined || rule[field] === input[field]
          )
        );
        const match = visible.find(({ rule }) => rule?.effect === "block") ??
          (base.allowed
            ? visible.find(({ rule }) => rule?.effect === "ask")
            : undefined);
        if (!match) return base;
        return {
          ...base,
          allowed: false,
          action: match.rule?.effect === "block" ? "BLOCK" : "REQUIRE_APPROVAL",
          ruleId: `reviewed-tool-rule:${match.id}:${match.version}`,
        };
      } catch {
        return { ...base, allowed: false, action: "BLOCK", ruleId: null };
      }
    },
  };
}
