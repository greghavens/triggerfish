/** Validate, deactivate, and install a verified named Sentinel case archive. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { VerifiedRunArchive } from "../core/run_archive.ts";
import {
  isSentinelCaseId,
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "./cases.ts";
import { readSentinelChatSnapshot } from "./chat_mode.ts";
import { loadSentinelGraph } from "./graph.ts";
import { digestSentinelSnapshot } from "./shared_inventory.ts";
import {
  assertOperatorSourceDirectoryInfo,
  withSentinelSourceSnapshotLock,
} from "./source_snapshot_lock.ts";

const snapshotFile = "sentinel.json";
const assessmentFile = "sentinel-assessment.db";
const adaptiveFile = "sentinel-adaptive.db";
const adaptiveApp = 0x53414450;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const auxiliarySchemas = {
  "sentinel-goal-completion.db": {
    app: 0,
    versions: [0],
    tables: { goal_completion: ["scope", "record"] },
  },
  "sentinel-worker-findings.db": {
    app: 0x53574644,
    versions: [1, 2],
    tables: {
      receipts: ["id", "revision", "input", "recordedAt"],
      requests: ["requestId", "receiptId"],
    },
  },
  "sentinel-worker-graph-facts.db": {
    app: 0x53574746,
    versions: [1],
    tables: {
      worker_graph_facts: [
        "id",
        "request_id",
        "run_id",
        "revision",
        "target_id",
        "task_id",
        "receipt",
      ],
    },
  },
  "sentinel-traffic-receipts.db": {
    app: 0,
    versions: [0],
    tables: {
      traffic_receipts_v1: [
        "evidenceId",
        "family",
        "record",
        "proof",
        "retainedAt",
      ],
    },
  },
  "sentinel-finding-traffic-links.db": {
    app: 0x5346544c,
    versions: [1, 2],
    tables: {
      traffic_links: ["id", "request_id", "revision", "finding_id", "input"],
    },
  },
} as const;

type AuxiliaryArtifact = keyof typeof auxiliarySchemas;
const auxiliaryArtifacts = Object.keys(auxiliarySchemas) as AuxiliaryArtifact[];
export const requiredSentinelRestoreArtifacts = [
  snapshotFile,
  assessmentFile,
] as const;
export const permittedSentinelRestoreArtifacts = [
  ...requiredSentinelRestoreArtifacts,
  adaptiveFile,
  ...auxiliaryArtifacts,
] as const;

type Artifact = typeof permittedSentinelRestoreArtifacts[number];

function stagedPath(
  archive: VerifiedRunArchive,
  artifact: Artifact,
): string | undefined {
  const file = archive.artifactPath(artifact);
  if (file === undefined) return undefined;
  const expected = join(resolve(archive.directory), artifact);
  if (resolve(file) !== expected) {
    throw new Error("Invalid staged Sentinel artifact path");
  }
  const info = Deno.lstatSync(expected);
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Sentinel restore requires private regular artifacts");
  }
  return expected;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid saved Sentinel assessment");
  }
  return value as Record<string, unknown>;
}

function savedSnapshot(result: unknown) {
  const assessment = object(result);
  const graph = object(assessment.sharedGraph);
  if (!Array.isArray(assessment.tasks) || !Array.isArray(graph.observations)) {
    throw new Error("Invalid saved Sentinel assessment result");
  }
  return loadSentinelGraph(graph.snapshot).snapshot();
}

function checkedDatabase<T>(
  path: string,
  family: "assessment" | "adaptive" | AuxiliaryArtifact,
  action: (db: DatabaseSync, tables: ReadonlySet<string>) => T,
): T {
  const auxiliary = family === "assessment" || family === "adaptive"
    ? undefined
    : auxiliarySchemas[family];
  const db = new DatabaseSync(path, { readOnly: auxiliary !== undefined });
  try {
    db.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON",
    );
    const app = db.prepare("PRAGMA application_id").get()?.application_id;
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const supported = auxiliary
      ? app === auxiliary.app &&
        auxiliary.versions.some((value) => value === version)
      : family === "adaptive"
      ? app === adaptiveApp && version === 1
      : app === 0 && version === 0;
    if (!supported) {
      throw new Error("Unsupported Sentinel archive database version");
    }
    const permitted = (name: unknown) =>
      typeof name === "string" &&
      (auxiliary
        ? Object.hasOwn(auxiliary.tables, name) ||
          family === "sentinel-finding-traffic-links.db" &&
            version === 2 && name === "traffic_link_request_aliases"
        : name === family || name.startsWith(family + "_") ||
          family === "assessment" && name === "sentinel_operating_constraints");
    const tables = new Set<string>();
    for (
      const { name, type, tbl_name, sql } of db.prepare(
        "SELECT name,type,tbl_name,sql FROM sqlite_schema",
      ).all()
    ) {
      if (
        type === "table" && permitted(name) && typeof sql === "string" &&
        /^CREATE TABLE\b/i.test(sql)
      ) {
        tables.add(String(name));
      } else if (
        type !== "index" || !permitted(tbl_name) ||
        !(typeof name === "string" && (name.startsWith("sqlite_autoindex_") ||
          typeof sql === "string" && /^CREATE (?:UNIQUE )?INDEX\b/i.test(sql)))
      ) {
        throw new Error("Unexpected Sentinel archive database schema");
      }
    }
    const check = db.prepare("PRAGMA quick_check(1)").all();
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") {
      throw new Error("Invalid Sentinel archive database integrity");
    }
    return action(db, tables);
  } finally {
    db.close();
  }
}

function requireColumns(
  db: DatabaseSync,
  table: string,
  required: readonly string[],
) {
  // All table names here are literals from the restore schema.
  const found = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name),
  );
  if (!required.every((column) => found.has(column))) {
    throw new Error("Incomplete Sentinel archive database schema");
  }
  return found;
}

function transaction(db: DatabaseSync, action: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function restoreAssessment(
  path: string,
  caseId: string,
  revision: number,
  runId: string,
  snapshotDigest: string,
) {
  checkedDatabase(path, "assessment", (db, tables) => {
    requireColumns(db, "assessment", [
      "id",
      "plan",
      "active",
      "revision",
      "fingerprint",
      "updatedAt",
      "result",
    ]);
    requireColumns(db, "assessment_history", [
      "revision",
      "updatedAt",
      "result",
    ]);
    requireColumns(db, "assessment_reviews", ["claim", "analysis"]);
    requireColumns(db, "assessment_archive_identity", [
      "caseId",
      "runId",
      "evidenceRevision",
      "snapshotDigest",
    ]);
    const identity = db.prepare(
      "SELECT * FROM assessment_archive_identity LIMIT 2",
    ).all();
    if (
      identity.length !== 1 || identity[0].caseId !== caseId ||
      identity[0].runId !== runId ||
      identity[0].evidenceRevision !== revision ||
      identity[0].snapshotDigest !== snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive case identity does not match its manifest",
      );
    }
    const rows = db.prepare("SELECT * FROM assessment LIMIT 2").all();
    const [row] = rows;
    if (
      rows.length !== 1 || row.id !== 1 || row.active !== 0 ||
      row.revision !== revision || typeof row.plan !== "string" ||
      typeof row.result !== "string" || typeof row.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      object(JSON.parse(row.plan)).runId !== runId ||
      digestSentinelSnapshot(savedSnapshot(JSON.parse(row.result))) !==
        snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive does not match the exact stopped case run",
      );
    }
    const archived = db.prepare(
      "SELECT result FROM assessment_history WHERE revision = ?",
    ).get(revision);
    if (
      typeof archived?.result !== "string" ||
      digestSentinelSnapshot(savedSnapshot(JSON.parse(archived.result))) !==
        snapshotDigest
    ) {
      throw new Error(
        "Sentinel archive is missing its exact retained evidence revision",
      );
    }
    if (
      tables.has("assessment_run_revisions") && db.prepare(
          "SELECT runId FROM assessment_run_revisions WHERE revision = ?",
        ).get(revision)?.runId !== runId
    ) {
      throw new Error(
        "Sentinel archive run history does not match its manifest",
      );
    }
    transaction(db, () => {
      db.exec("DELETE FROM assessment_reviews WHERE analysis IS NULL");
      db.exec(
        "UPDATE assessment_reviews SET claim = 'restored' WHERE claim <> 'restored'",
      );
      if (tables.has("assessment_incident_notification")) {
        db.exec("DELETE FROM assessment_incident_notification");
      }
      db.exec("UPDATE assessment SET active = 2 WHERE id = 1");
    });
  });
}

function restoreAdaptive(path: string, revision: number, runId: string) {
  checkedDatabase(path, "adaptive", (db, tables) => {
    requireColumns(db, "adaptive_active", ["singleton", "revision"]);
    requireColumns(db, "adaptive_revisions", ["revision"]);
    requireColumns(db, "adaptive_evidence_revisions", [
      "revision",
      "evidenceNumber",
      "goalId",
    ]);
    const taskColumns = requireColumns(db, "adaptive_tasks", [
      "revision",
      "status",
      "leaseToken",
      "leaseExpiresAt",
    ]);
    const mapping = db.prepare(`
      SELECT mapped.revision, mapped.goalId FROM adaptive_evidence_revisions AS mapped
      JOIN adaptive_revisions AS known ON known.revision = mapped.revision
      WHERE mapped.evidenceNumber = ? ORDER BY mapped.rowid DESC LIMIT 1
    `).get(revision);
    if (mapping?.goalId !== runId) {
      throw new Error(
        "Sentinel archive adaptive state does not match the exact run and evidence revision",
      );
    }
    const active = db.prepare("SELECT revision FROM adaptive_active LIMIT 2")
      .all();
    if (
      active.length > 1 || active[0] && active[0].revision !== mapping.revision
    ) {
      throw new Error(
        "Sentinel archive contains a foreign active adaptive revision",
      );
    }
    transaction(db, () => {
      db.exec("DELETE FROM adaptive_active");
      db.prepare(`UPDATE adaptive_tasks SET
        status = CASE WHEN status = 'running' OR (status = 'queued' AND revision <> ?)
          THEN 'superseded' ELSE status END,
        leaseToken = NULL, leaseExpiresAt = NULL`).run(mapping.revision);
      if (taskColumns.has("dependencyRecommendation")) {
        db.exec("UPDATE adaptive_tasks SET dependencyRecommendation = NULL");
      }
      if (tables.has("adaptive_model_reviews")) {
        db.exec(
          "UPDATE adaptive_model_reviews SET token = NULL WHERE token IS NOT NULL",
        );
      }
      if (tables.has("adaptive_model_leases")) {
        db.exec(
          "UPDATE adaptive_model_leases SET completed = 1 WHERE completed = 0",
        );
      }
      if (tables.has("adaptive_model_history")) {
        db.prepare(
          "UPDATE adaptive_model_history SET outcome = -1, finished = ? WHERE outcome = 0",
        )
          .run(Date.now());
      }
      if (tables.has("adaptive_worker_controls")) {
        db.exec(
          "DELETE FROM adaptive_worker_controls WHERE action = 'steer' AND appliedAt IS NULL",
        );
      }
      for (
        const table of [
          "adaptive_worker_checkpoints",
          "adaptive_live_workflow_results",
          "adaptive_worker_progress",
          "adaptive_peer_verifications",
        ]
      ) {
        if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
      }
    });
  });
}

function validateAuxiliary(
  path: string,
  name: AuxiliaryArtifact,
  caseId: string,
  runId: string,
  revision: number,
) {
  checkedDatabase(path, name, (db, tables) => {
    for (
      const [table, fields] of Object.entries(auxiliarySchemas[name].tables)
    ) {
      requireColumns(db, table, fields);
    }
    if (tables.has("traffic_link_request_aliases")) {
      requireColumns(db, "traffic_link_request_aliases", [
        "request_id",
        "link_id",
      ]);
    }
    const scoped = name === "sentinel-worker-findings.db"
      ? { table: "receipts", column: "input", hasRun: true }
      : name === "sentinel-worker-graph-facts.db"
      ? { table: "worker_graph_facts", column: "receipt", hasRun: true }
      : name === "sentinel-finding-traffic-links.db"
      ? { table: "traffic_links", column: "input", hasRun: false }
      : undefined;
    if (!scoped) return;
    const { table, column, hasRun } = scoped;
    // Historical earlier runs retain their original scope; current revision must match the manifest run.
    const invalid = db.prepare(`SELECT 1 FROM ${table}
      WHERE json_type(${column}, '$.caseId') IS NOT 'text'
        OR json_extract(${column}, '$.caseId') IS NOT ?
        OR json_type(${column}, '$.evidenceRevision') IS NOT 'integer'
        OR json_extract(${column}, '$.evidenceRevision') NOT BETWEEN 1 AND ?
        ${
      hasRun
        ? `OR (json_extract(${column}, '$.evidenceRevision') = ?
          AND json_extract(${column}, '$.runId') IS NOT ?)`
        : ""
    }
      LIMIT 1`).get(caseId, revision, ...(hasRun ? [revision, runId] : []));
    if (invalid) throw new Error("Foreign Sentinel archive receipt scope");
  });
}

function rejectDuplicateRun(baseDir: string, caseId: string, runId: string) {
  for (const existing of ["main", ...listSentinelCaseIds(baseDir)]) {
    if (existing === caseId) continue;
    const path = join(
      dirname(resolveSentinelCasePath(baseDir, existing)),
      assessmentFile,
    );
    try {
      const info = Deno.lstatSync(path);
      if (
        !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
        (info.mode !== null && (info.mode & 0o077) !== 0)
      ) {
        throw new Error("Unable to verify existing Sentinel case identity");
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA trusted_schema = OFF");
      const row = db.prepare("SELECT plan FROM assessment WHERE id = 1").get();
      if (
        typeof row?.plan === "string" &&
        object(JSON.parse(row.plan)).runId === runId
      ) {
        throw new Deno.errors.AlreadyExists(
          "The Sentinel run already belongs to another case",
        );
      }
    } finally {
      db.close();
    }
  }
}

async function install(
  destination: string,
  files: readonly { name: Artifact; source: string }[],
) {
  const directory = dirname(destination);
  const parent = dirname(directory);
  await Deno.mkdir(parent, { mode: 0o700, recursive: true });
  assertOperatorSourceDirectoryInfo(await Deno.lstat(parent));
  // This exclusive directory creation is the collision gate for the exact case ID.
  await Deno.mkdir(directory, { mode: 0o700 });
  const installed: string[] = [];
  try {
    for (const { name, source } of files) {
      const target = join(directory, name);
      // Link the already complete private file without ever overwriting a destination.
      await Deno.link(source, target);
      installed.push(target);
      await Deno.remove(source);
    }
  } catch (error) {
    for (const path of installed.reverse()) {
      await Deno.remove(path).catch(() => {});
    }
    await Deno.remove(directory).catch(() => {});
    throw error;
  }
}

/** Install only a complete staged named case, paused without runnable archived authority. */
export async function restoreVerifiedSentinelCaseArchive(
  baseDir: string,
  archive: VerifiedRunArchive,
) {
  const { kind, id: caseId, runId, revision } = archive.manifest.identity;
  if (
    archive.manifest.version !== 1 || kind !== "sentinel" ||
    !isSentinelCaseId(caseId) || caseId === "main" ||
    typeof runId !== "string" || !uuid.test(runId) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) ||
    revision < 1 ||
    archive.manifest.artifacts.some(({ name }) =>
      !permittedSentinelRestoreArtifacts.some((artifact) => artifact === name)
    )
  ) throw new Error("Invalid named Sentinel archive identity or artifacts");
  const destination = resolveSentinelCasePath(baseDir, caseId);
  try {
    await Deno.lstat(dirname(destination));
    throw new Deno.errors.AlreadyExists("The Sentinel case already exists");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const snapshot = stagedPath(archive, snapshotFile);
  const assessment = stagedPath(archive, assessmentFile);
  const adaptive = stagedPath(archive, adaptiveFile);
  if (!snapshot || !assessment) {
    throw new Error("Sentinel archive is missing required artifacts");
  }
  const graph = loadSentinelGraph(await readSentinelChatSnapshot(snapshot))
    .snapshot();
  restoreAssessment(
    assessment,
    caseId,
    revision,
    runId,
    digestSentinelSnapshot(graph),
  );
  if (adaptive) restoreAdaptive(adaptive, revision, runId);
  const auxiliary = auxiliaryArtifacts.flatMap((name) => {
    const source = stagedPath(archive, name);
    if (!source) return [];
    validateAuxiliary(source, name, caseId, runId, revision);
    return [{ name, source }];
  });
  await withSentinelSourceSnapshotLock(baseDir, true, async () => {
    rejectDuplicateRun(baseDir, caseId, runId);
    await install(destination, [
      { name: assessmentFile, source: assessment },
      ...(adaptive ? [{ name: adaptiveFile, source: adaptive }] as const : []),
      ...auxiliary,
      { name: snapshotFile, source: snapshot },
    ]);
  });
  return {
    caseId,
    runId,
    evidenceRevision: revision,
    snapshotPath: destination,
  };
}
