/** Classified routing stays in the provider registry. This ledger accepts model-call metadata only. */
/// <reference path="./sqlite_types.d.ts" />
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import type { ClassificationLevel } from "./types/classification.ts";
import type { LlmUsage } from "./types/llm.ts";

const retainRecords = 10_000;
const cooldowns = [60_000, 300_000, 1_800_000];

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 100_000_000
    ? value
    : 0;
}

export function modelMonitor(baseDir: string) {
  const path = join(baseDir, "model-monitor.db");
  function ensureFile() {
    const dir = Deno.lstatSync(baseDir);
    if (
      !dir.isDirectory || dir.isSymlink ||
      (dir.mode !== null && (dir.mode & 0o022))
    ) {
      throw new Error("Invalid model monitor directory");
    }
    for (;;) {
      try {
        const file = Deno.lstatSync(path);
        if (
          !file.isFile || file.isSymlink || (file.nlink ?? 1) !== 1 ||
          (file.mode !== null && (file.mode & 0o077))
        ) {
          throw new Error("Invalid model monitor database");
        }
        return;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        try {
          Deno.openSync(path, { write: true, createNew: true, mode: 0o600 })
            .close();
          return;
        } catch (cause) {
          if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
        }
      }
    }
  }
  function access<T>(action: (db: DatabaseSync) => T): T {
    ensureFile();
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS model_retry_edits(
          version INTEGER PRIMARY KEY, requestId TEXT NOT NULL UNIQUE,
          retries INTEGER NOT NULL, delayMs INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_record_sequences(
          classification TEXT PRIMARY KEY, id INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_calls(
          classification TEXT NOT NULL, id INTEGER NOT NULL, provider TEXT NOT NULL,
          model TEXT NOT NULL, outcome TEXT NOT NULL, elapsed INTEGER NOT NULL,
          inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL,
          recordedAt INTEGER NOT NULL, PRIMARY KEY(classification, id)
        );
        CREATE TABLE IF NOT EXISTS model_health(
          classification TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, failures INTEGER NOT NULL,
          version INTEGER NOT NULL, PRIMARY KEY(classification, provider, model)
        );
        CREATE TABLE IF NOT EXISTS model_cooldowns(
          classification TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
          failures INTEGER NOT NULL, trips INTEGER NOT NULL, openUntil INTEGER NOT NULL,
          PRIMARY KEY(classification, provider, model)
        );
        CREATE TABLE IF NOT EXISTS model_daily_usage(
          classification TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, day TEXT NOT NULL,
          calls INTEGER NOT NULL, failures INTEGER NOT NULL, inputTokens INTEGER NOT NULL,
          outputTokens INTEGER NOT NULL, PRIMARY KEY(classification, provider, model, day)
        );
      `);
      return action(db);
    } finally {
      db.close();
    }
  }

  function transaction<T>(action: (db: DatabaseSync) => T): T {
    return access((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = action(db);
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  return {
    retryPolicy() {
      return access((db) =>
        db.prepare(
          "SELECT * FROM model_retry_edits ORDER BY version DESC LIMIT 1",
        ).get() ?? { version: 0, retries: 2, delayMs: 1000 }
      );
    },
    setRetry(
      version: number,
      requestId: string,
      retries: number,
      delayMs: number,
    ) {
      return transaction((db) => {
        const prior = db.prepare(
          "SELECT * FROM model_retry_edits WHERE requestId=?",
        ).get(requestId);
        if (prior) {
          return prior.version === version + 1 && prior.retries === retries &&
              prior.delayMs === delayMs
            ? prior
            : undefined;
        }
        const current = db.prepare(
          "SELECT max(version) AS version FROM model_retry_edits",
        ).get();
        if ((current?.version ?? 0) !== version) return;
        db.prepare("INSERT INTO model_retry_edits VALUES (?,?,?,?)")
          .run(version + 1, requestId, retries, delayMs);
        return { version: version + 1, requestId, retries, delayMs };
      });
    },
    record(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      outcome: "success" | "failed" | "cancelled",
      elapsed: number,
      usage?: LlmUsage,
      availability?: "transient" | "hard",
    ) {
      const time = Date.now();
      const input = count(usage?.inputTokens);
      const output = count(usage?.outputTokens);
      const day = new Date(time).toISOString().slice(0, 10);
      transaction((db) => {
        const id = Number(
          db.prepare(`
          INSERT INTO model_record_sequences VALUES (?,1)
          ON CONFLICT(classification) DO UPDATE SET id=id+1 RETURNING id
        `).get(classification)?.id,
        );
        db.prepare("INSERT INTO model_calls VALUES (?,?,?,?,?,?,?,?,?)")
          .run(
            classification,
            id,
            provider,
            model,
            outcome,
            count(elapsed),
            input,
            output,
            time,
          );
        db.prepare("DELETE FROM model_calls WHERE classification=? AND id <= ?")
          .run(classification, id - retainRecords);
        db.prepare(`
          INSERT INTO model_daily_usage VALUES (?,?,?,?,1,?,?,?)
          ON CONFLICT(classification,provider,model,day) DO UPDATE SET
            calls=calls+1, failures=failures+excluded.failures,
            inputTokens=inputTokens+excluded.inputTokens,
            outputTokens=outputTokens+excluded.outputTokens
        `).run(
          classification,
          provider,
          model,
          day,
          Number(outcome === "failed"),
          input,
          output,
        );
        if (outcome === "cancelled") return;
        if (outcome === "success") {
          db.prepare(`DELETE FROM model_cooldowns
            WHERE classification=? AND provider=? AND model=?`)
            .run(classification, provider, model);
        } else if (availability) {
          const prior = db.prepare(`SELECT failures,trips,openUntil
            FROM model_cooldowns WHERE classification=? AND provider=? AND model=?`)
            .get(classification, provider, model);
          if (Number(prior?.openUntil ?? 0) <= time) {
            const failures = Number(prior?.failures ?? 0) + 1;
            const trip = availability === "hard" || failures >= 3;
            const trips = Number(prior?.trips ?? 0) + Number(trip);
            const openUntil = trip
              ? time + cooldowns[Math.min(trips, cooldowns.length) - 1]
              : 0;
            db.prepare(`INSERT INTO model_cooldowns VALUES (?,?,?,?,?,?)
              ON CONFLICT(classification,provider,model) DO UPDATE SET
              failures=excluded.failures, trips=excluded.trips, openUntil=excluded.openUntil`)
              .run(
                classification,
                provider,
                model,
                trip ? 0 : failures,
                trips,
                openUntil,
              );
          }
        }
        db.prepare(`
          INSERT INTO model_health VALUES (?,?,?,?,1)
          ON CONFLICT(classification,provider,model) DO UPDATE SET
            failures=CASE WHEN excluded.failures=0 THEN 0 ELSE failures+1 END,
            version=version+1
          WHERE excluded.failures != 0 OR failures != 0
        `).run(classification, provider, model, Number(outcome === "failed"));
      });
    },
    health(
      classification: ClassificationLevel,
      provider: string,
      model: string,
    ) {
      return access((db) =>
        db.prepare(`
        SELECT h.failures,h.version,coalesce(c.openUntil,0) AS openUntil
        FROM model_health h LEFT JOIN model_cooldowns c USING(classification,provider,model)
        WHERE h.classification=? AND h.provider=? AND h.model=?
      `).get(classification, provider, model) ??
          { failures: 0, version: 0, openUntil: 0 }
      );
    },
    reset(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      version: number,
    ) {
      return transaction((db) => {
        const updated = db.prepare(`
        UPDATE model_health SET failures=0, version=version+1
        WHERE classification=? AND provider=? AND model=? AND version=?
      `).run(classification, provider, model, version).changes === 1;
        if (updated) {
          db.prepare(`DELETE FROM model_cooldowns
            WHERE classification=? AND provider=? AND model=?`)
            .run(classification, provider, model);
        }
        return updated;
      });
    },
    page(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      before: number,
      limit: number,
    ) {
      return access((db) =>
        db.prepare(`
        SELECT * FROM model_calls WHERE classification=? AND provider=? AND model=? AND id<?
        ORDER BY id DESC LIMIT ?
      `).all(classification, provider, model, before, limit)
      );
    },
    usage(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      since: string,
    ) {
      return access((db) =>
        db.prepare(`
        SELECT day,calls,failures,inputTokens,outputTokens FROM model_daily_usage
        WHERE classification=? AND provider=? AND model=? AND day>=? ORDER BY day DESC
      `).all(classification, provider, model, since)
      );
    },
    usageTotals(
      classification: ClassificationLevel,
      since: string,
      afterProvider: string,
      afterModel: string,
    ) {
      return access((db) => {
        const profiles = db.prepare(`
          SELECT provider, model, SUM(calls) AS calls, SUM(failures) AS failures,
            SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens
          FROM model_daily_usage WHERE classification = ?
            AND (provider, model) > (?, ?)
          GROUP BY provider, model ORDER BY provider, model LIMIT 9
        `).all(classification, afterProvider, afterModel);
        const daily = db.prepare(`
          SELECT day, SUM(calls) AS calls, SUM(failures) AS failures,
            SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens
          FROM model_daily_usage WHERE classification = ? AND day >= ?
          GROUP BY day ORDER BY day DESC
        `).all(classification, since);
        return { profiles, daily };
      });
    },
    get(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      id: number,
    ) {
      return access((db) =>
        db.prepare(
          "SELECT * FROM model_calls WHERE classification=? AND provider=? AND model=? AND id=?",
        ).get(classification, provider, model, id)
      );
    },
    remove(
      classification: ClassificationLevel,
      provider: string,
      model: string,
      id: number,
    ) {
      return access((db) =>
        db.prepare(
          "DELETE FROM model_calls WHERE classification=? AND provider=? AND model=? AND id=?",
        ).run(classification, provider, model, id).changes === 1
      );
    },
  };
}
