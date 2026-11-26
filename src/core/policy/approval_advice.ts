/// <reference path="../sqlite_types.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../model_profile_selection.ts";
import type { LlmProviderRegistry } from "../types/llm.ts";

interface AdvisorSetting {
  readonly version: number;
  readonly profile: SelectedModelProfile | null;
}

export interface PendingApprovalAdvice {
  readonly id: string;
  readonly tool: string;
  readonly scoped: boolean;
  readonly ruleId: string | null;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly authorize: (
    profile: SelectedModelProfile,
    content: string,
  ) => Promise<boolean>;
}

export function approvalAdviceStore(baseDir: string) {
  const path = join(baseDir, "approval-advice.db");
  function use<T>(write: boolean, empty: T, read: (db: DatabaseSync) => T): T {
    if (!write) {
      try {
        Deno.statSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return empty;
        throw error;
      }
    }
    const db = new DatabaseSync(path, { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      if (write) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS settings (version INTEGER PRIMARY KEY, profile TEXT, requestId TEXT UNIQUE);
          CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY, version INTEGER NOT NULL, verdict TEXT NOT NULL, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL
          );
        `);
      }
      return read(db);
    } finally {
      db.close();
    }
  }
  function setting(db: DatabaseSync): AdvisorSetting {
    const value = db.prepare(
      "SELECT version,profile FROM settings ORDER BY version DESC LIMIT 1",
    ).get();
    return value
      ? {
        version: Number(value.version),
        profile: value.profile && JSON.parse(String(value.profile)),
      }
      : { version: 0, profile: null };
  }
  const encode = (profile: SelectedModelProfile | null) =>
    profile &&
    JSON.stringify({
      provider: profile.provider,
      ...(profile.model && { model: profile.model }),
    });
  return {
    setting() {
      return use(
        false,
        { version: 0, profile: null } as AdvisorSetting,
        setting,
      );
    },
    receipt(
      id: string,
      expectedVersion: number,
      profile: SelectedModelProfile | null,
    ) {
      return use(false, undefined as AdvisorSetting | undefined, (db) => {
        const row = db.prepare(
          "SELECT version,profile FROM settings WHERE requestId=?",
        ).get(id);
        return row && row.version === expectedVersion + 1 &&
            row.profile === encode(profile)
          ? { version: expectedVersion + 1, profile }
          : undefined;
      });
    },
    set(
      id: string,
      expectedVersion: number,
      profile: SelectedModelProfile | null,
    ) {
      return use(true, undefined as AdvisorSetting | undefined, (db) => {
        const result = db.prepare(`
          INSERT INTO settings (requestId,version,profile)
          SELECT ?,?,? WHERE COALESCE((SELECT MAX(version) FROM settings),0)=?
          ON CONFLICT DO NOTHING
        `).run(id, expectedVersion + 1, encode(profile), expectedVersion);
        return result.changes
          ? { version: expectedVersion + 1, profile }
          : undefined;
      });
    },
    begin(id: string, version: number) {
      return use(
        true,
        false,
        (db) =>
          db.prepare("INSERT OR IGNORE INTO reviews VALUES (?,?,'pending',0,0)")
            .run(id, version).changes > 0,
      );
    },
    finish(
      id: string,
      verdict: "consider" | "caution" | "unavailable",
      inputTokens: number,
      outputTokens: number,
    ) {
      use(true, undefined, (db) => {
        db.prepare(
          "UPDATE reviews SET verdict=?,inputTokens=?,outputTokens=? WHERE id=? AND verdict='pending'",
        )
          .run(verdict, inputTokens, outputTokens, id);
      });
    },
    read(id: string) {
      return use(
        false,
        undefined as Record<string, unknown> | undefined,
        (db) =>
          db.prepare(
            "SELECT id,version,verdict,inputTokens,outputTokens FROM reviews WHERE id=?",
          ).get(id),
      );
    },
    usage() {
      return use(
        false,
        [] as Record<string, unknown>[],
        (db) =>
          db.prepare(
            `SELECT reviews.version,settings.profile,COUNT(*) AS requests,
          SUM(inputTokens) AS inputTokens,SUM(outputTokens) AS outputTokens
          FROM reviews JOIN settings USING(version)
          WHERE verdict <> 'pending' GROUP BY reviews.version
          ORDER BY reviews.version DESC LIMIT 30`,
          ).all().map(({ profile, ...row }) => ({
            ...row,
            profile: profile && JSON.parse(String(profile)),
          })),
      );
    },
  };
}

/** Advisory metadata only. The live owner decision still controls dispatch. */
export function createApprovalAdvisor(
  baseDir: string,
  registry: LlmProviderRegistry,
  allowlists?: ModelProfileAllowlists,
) {
  const store = approvalAdviceStore(baseDir);
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= 1_000_000
      ? value
      : 0;
  return async (input: PendingApprovalAdvice) => {
    if (
      input.ruleId?.startsWith("reviewed-tool-rule:") || !input.isCurrent() ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.tool)
    ) return;
    const { version, profile } = store.setting();
    const provider = profile &&
      selectedModelProvider(registry, profile, "INTERNAL", allowlists);
    if (!profile || !provider) return;
    const content = JSON.stringify({
      tool: input.tool,
      assignmentScoped: input.scoped,
    });
    if (
      !await input.authorize(profile, content) || !input.isCurrent() ||
      store.setting().version !== version ||
      !store.begin(input.id, version)
    ) return;
    let verdict: "consider" | "caution" | "unavailable" = "unavailable";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(5_000),
      ]);
      const result = await provider.complete(
        [
          {
            role: "system",
            content:
              "You advise a human reviewing a tool request. Return exactly caution or consider. No decision changes the approval gate. Prefer caution if context is insufficient.",
          },
          {
            role: "user",
            content,
          },
        ],
        [],
        { signal, maxTokens: 16 },
      );
      inputTokens = count(result.usage.inputTokens);
      outputTokens = count(result.usage.outputTokens);
      const advice = result.content.trim();
      if (
        !signal.aborted && input.isCurrent() &&
        store.setting().version === version &&
        !result.toolCalls.length &&
        (advice === "consider" || advice === "caution")
      ) verdict = advice;
    } catch {
      // Provider exceptions may contain classified data.
    } finally {
      store.finish(input.id, verdict, inputTokens, outputTokens);
    }
  };
}
