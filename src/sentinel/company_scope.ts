/** Reviewed shared asset attribution, independent of case authorization. */
/// <reference path="../core/sqlite_types.d.ts" />

import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { assetText, canonicalAssetUrl } from "./asset_properties.ts";
import {
  parseSentinelScopeRules,
  type SentinelScopeRule,
} from "./scope_rules.ts";
import {
  assertOperatorSourceDirectoryInfo,
  assertOperatorSourceSnapshotInfo,
} from "./source_snapshot_lock.ts";

const requestIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const maxCompanies = 128;

interface CompanyScope {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly logoUrl?: string;
  readonly deleted?: true;
  readonly reason: string;
  readonly rules: readonly SentinelScopeRule[];
}
interface CompanyScopeEdit extends CompanyScope {
  readonly version: number;
  readonly requestId: string;
  readonly approvedAt: string;
}
interface CompanyScopeUpdate extends CompanyScope {
  readonly expectedVersion: number;
  readonly requestId: string;
}

function open(baseDir: string, write = false) {
  const directory = join(baseDir, "data");
  const path = join(directory, "sentinel-company-scope.db");
  try {
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
    assertOperatorSourceSnapshotInfo(Deno.lstatSync(path));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (!write) return;
    Deno.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertOperatorSourceDirectoryInfo(Deno.lstatSync(directory));
    try {
      Deno.openSync(path, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
      assertOperatorSourceSnapshotInfo(Deno.lstatSync(path));
    }
  }
  const db = new DatabaseSync(path, { readOnly: !write });
  if (write) {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS company_scope_edits (
        version INTEGER PRIMARY KEY,
        requestId TEXT NOT NULL UNIQUE,
        organizationId TEXT NOT NULL,
        nameKey TEXT NOT NULL,
        edit TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS company_scope_edits_by_organization
        ON company_scope_edits (organizationId, version DESC)`);
  }
  return db;
}

function parseScope(
  raw: Record<string, unknown>,
): CompanyScope | undefined {
  const organizationId = assetText(raw.organizationId, 256);
  const organizationName = assetText(raw.organizationName, 256);
  const reason = assetText(raw.reason, 512);
  const rules = Array.isArray(raw.rules) && !raw.rules.length
    ? []
    : parseSentinelScopeRules(raw.rules);
  const logo = assetText(raw.logoUrl);
  const href = logo && canonicalAssetUrl(logo);
  const logoUrl = href && href.length <= 384 ? href : undefined;
  if (
    organizationId && organizationName && reason && rules &&
    (raw.logoUrl === undefined || logoUrl) &&
    (raw.deleted === undefined || (raw.deleted === true && rules.length === 0))
  ) {
    return {
      organizationId,
      organizationName,
      reason,
      rules,
      ...(logoUrl && { logoUrl }),
      ...(raw.deleted === true && { deleted: true as const }),
    };
  }
}

export function parseSentinelCompanyScopeUpdate(
  raw: Record<string, unknown>,
): CompanyScopeUpdate | undefined {
  const scope = parseScope(raw);
  const { requestId, expectedVersion } = raw;
  if (
    scope && typeof requestId === "string" &&
    requestIdPattern.test(requestId) &&
    typeof expectedVersion === "number" &&
    Number.isSafeInteger(expectedVersion) &&
    expectedVersion >= 0 && expectedVersion < Number.MAX_SAFE_INTEGER
  ) return { ...scope, requestId, expectedVersion };
}

function decode(row: Record<string, unknown>): CompanyScopeEdit {
  const raw = typeof row.edit === "string" && JSON.parse(row.edit);
  const scope = raw && parseScope(raw);
  const value = scope && {
    ...scope,
    version: raw.version,
    requestId: raw.requestId,
    approvedAt: raw.approvedAt,
  };
  if (
    !value || value.version !== row.version ||
    !Number.isSafeInteger(value.version) || value.version < 1 ||
    value.requestId !== row.requestId ||
    !requestIdPattern.test(value.requestId) ||
    value.organizationId !== row.organizationId ||
    value.organizationName.toLowerCase() !== row.nameKey ||
    typeof value.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    JSON.stringify(value) !== row.edit
  ) throw new Error("Invalid saved Sentinel company scope");
  return value;
}

function state(db: DatabaseSync) {
  const companies = db.prepare(`
    SELECT e.* FROM company_scope_edits AS e
    WHERE e.version = (
      SELECT MAX(prior.version) FROM company_scope_edits AS prior
      WHERE prior.organizationId = e.organizationId
    )
    AND json_extract(e.edit, '$.deleted') IS NULL
    ORDER BY e.organizationId LIMIT ?
  `).all(maxCompanies + 1).map(decode);
  if (companies.length > maxCompanies) {
    throw new Error("Sentinel company scope limit exceeded");
  }
  return {
    version: Number(
      db.prepare("SELECT MAX(version) AS version FROM company_scope_edits")
        .get()?.version ?? 0,
    ),
    companies,
  };
}

export function readSentinelCompanyScopes(baseDir: string) {
  const db = open(baseDir);
  try {
    if (!db) return { version: 0, companies: [] as CompanyScopeEdit[] };
    db.exec("BEGIN");
    const result = db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'company_scope_edits'",
      ).get()
      ? state(db)
      : { version: 0, companies: [] as CompanyScopeEdit[] };
    db.exec("COMMIT");
    return result;
  } finally {
    db?.close();
  }
}

/** Read the company state that an exact reviewed edit was based on. */
export function readSentinelCompanyAtVersion(
  baseDir: string,
  organizationId: string,
  version: number,
): CompanyScopeEdit | undefined {
  const db = open(baseDir);
  try {
    const row = db?.prepare(
      "SELECT * FROM company_scope_edits WHERE organizationId = ? AND version <= ? ORDER BY version DESC LIMIT 1",
    ).get(organizationId, version);
    const company = row && decode(row);
    return company?.deleted ? undefined : company;
  } finally {
    db?.close();
  }
}

/** Versioned compare-and-set, with exact request retry and no scope grants. */
export function recordSentinelCompanyScope(
  baseDir: string,
  raw: CompanyScopeUpdate,
): CompanyScopeEdit | undefined {
  const update = parseSentinelCompanyScopeUpdate(
    raw as unknown as Record<string, unknown>,
  );
  if (!update) return;
  const { expectedVersion, requestId, ...scope } = update;
  const db = open(baseDir, true)!;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = db.prepare(
        "SELECT * FROM company_scope_edits WHERE requestId = ?",
      ).get(requestId);
      let saved: CompanyScopeEdit | undefined;
      if (prior) {
        const duplicate = decode(prior);
        if (
          duplicate.version === expectedVersion + 1 &&
          JSON.stringify(parseScope({ ...duplicate })) === JSON.stringify(scope)
        ) saved = duplicate;
      } else {
        const before = state(db);
        const priorCompany = before.companies.find(
          ({ organizationId }) => organizationId === scope.organizationId,
        );
        const nameKey = scope.organizationName.toLowerCase();
        if (
          before.version === expectedVersion &&
          (scope.deleted
            ? priorCompany?.organizationName === scope.organizationName &&
              priorCompany.logoUrl === scope.logoUrl
            : !!priorCompany || before.companies.length < maxCompanies) &&
          !before.companies.some((company) =>
            company.organizationId !== scope.organizationId &&
            company.organizationName.toLowerCase() === nameKey
          )
        ) {
          saved = {
            ...scope,
            version: expectedVersion + 1,
            requestId,
            approvedAt: new Date().toISOString(),
          };
          db.prepare("INSERT INTO company_scope_edits VALUES (?, ?, ?, ?, ?)")
            .run(
              saved.version,
              requestId,
              scope.organizationId,
              nameKey,
              JSON.stringify(saved),
            );
        }
      }
      db.exec("COMMIT");
      return saved;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
