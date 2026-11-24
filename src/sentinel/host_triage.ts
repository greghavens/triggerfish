/// <reference path="./sqlite_types.d.ts" />

/** Read Linux process and TCP listener metadata for exact indicator matching. */
import { isAbsolute, resolve, toFileUrl } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createSentinelIndicatorDetector,
  isSentinelPostgresTable,
  parseSentinelIndicatorCatalog,
  type SentinelIndicatorAlert,
} from "./indicators.ts";

function hasControlCharacters(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

const MAX_SOCKET_TABLE_BYTES = 512 * 1024;

async function readLocalTcpListeners() {
  const ports = new Set<number>();
  const unavailable: string[] = [];
  let truncated = false;
  for (const family of ["tcp", "tcp6"]) {
    try {
      using file = await Deno.open(`/proc/net/${family}`, { read: true });
      const buffer = new Uint8Array(MAX_SOCKET_TABLE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const size = await file.read(buffer.subarray(length));
        if (size === null) break;
        length += size;
      }
      if (length > MAX_SOCKET_TABLE_BYTES) truncated = true;
      const text = new TextDecoder().decode(
        buffer.subarray(0, Math.min(length, MAX_SOCKET_TABLE_BYTES)),
      );
      // Drop an incomplete final record when the table exceeded the byte budget.
      for (const line of text.slice(0, text.lastIndexOf("\n")).split("\n")) {
        const [, local, , state] = line.trim().split(/\s+/);
        if (state !== "0A") continue;
        const port = /:([0-9a-f]{4})$/i.exec(local)?.[1];
        if (port && port !== "0000") ports.add(Number.parseInt(port, 16));
      }
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.PermissionDenied)
      ) throw error;
      unavailable.push(family);
    }
  }
  return { ports, unavailable, truncated };
}

const MAX_SCHEMA_NAMES = 4096;

function readSqliteTableNames(input: string) {
  const path = resolve(input);
  if (!Deno.lstatSync(path).isFile) {
    throw new Error("Supply a regular SQLite snapshot file");
  }
  for (const suffix of ["-wal", "-journal"]) {
    try {
      Deno.lstatSync(path + suffix);
      throw new Error(
        "Supply a standalone SQLite snapshot without journal files",
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const url = toFileUrl(path);
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url.href, { readOnly: true });
  try {
    return db.prepare(`SELECT name FROM sqlite_schema
      WHERE type = 'table' AND NOT name GLOB 'sqlite_*'
      ORDER BY name LIMIT ?`).all(MAX_SCHEMA_NAMES + 1).map(({ name }) =>
      String(name)
    );
  } finally {
    db.close();
  }
}

function postgresTableNames(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_SCHEMA_NAMES) {
    throw new Error(
      "Supply a JSON array of at most 4096 PostgreSQL schema.table names",
    );
  }
  return [
    ...new Set(input.map((name) => {
      if (!isSentinelPostgresTable(name)) {
        throw new Error(
          "Invalid PostgreSQL schema.table name in Sentinel metadata",
        );
      }
      return name;
    })),
  ];
}

async function readLocalPostgresTables(
  database: string,
  socket: string,
  port: string,
) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(database)) {
    throw new Error(
      "Supply a PostgreSQL database name, not a connection string",
    );
  }
  if (
    !isAbsolute(socket) || hasControlCharacters(socket) || socket.includes(",")
  ) {
    throw new Error("Supply one absolute PostgreSQL Unix socket directory");
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error("Supply a PostgreSQL socket port from 1 to 65535");
  }
  const sql = `SELECT table_schema || '.' || table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema <> 'information_schema'
      AND pg_catalog.left(table_schema, 3) <> 'pg_'
      AND table_schema ~ '^[a-z_][a-z0-9_]{0,62}$'
      AND table_name ~ '^[a-z_][a-z0-9_]{0,62}$'
    ORDER BY table_schema, table_name
    LIMIT ${MAX_SCHEMA_NAMES + 1}`;
  let result: Deno.CommandOutput;
  try {
    result = await new Deno.Command("psql", {
      args: [
        "--no-psqlrc",
        "--no-password",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--host",
        socket,
        "--port",
        port,
        "--dbname",
        database,
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        sql,
      ],
      clearEnv: true,
      env: {
        PGCONNECT_TIMEOUT: "3",
        PGPASSFILE: "/dev/null",
        PGOPTIONS:
          "-c default_transaction_read_only=on -c statement_timeout=3000 -c search_path=",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(6000),
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error("Local PostgreSQL metadata collection requires psql");
    }
    throw new Error("Local PostgreSQL metadata collection could not run");
  }
  if (!result.success) {
    throw new Error(
      "Local PostgreSQL metadata collection failed for the current operating-system user",
    );
  }
  const names = new TextDecoder().decode(result.stdout).split("\n").filter(
    Boolean,
  );
  if (
    names.length > MAX_SCHEMA_NAMES + 1 ||
    names.some((name) => !isSentinelPostgresTable(name))
  ) {
    throw new Error("Unexpected local PostgreSQL metadata output");
  }
  return {
    names: names.slice(0, MAX_SCHEMA_NAMES),
    truncated: names.length > MAX_SCHEMA_NAMES,
  };
}

export async function triageLocalSentinelHost(
  rules: unknown,
  asset: string,
  evidence?: {
    readonly sqliteSnapshot?: string;
    readonly postgresTables?: unknown;
    readonly postgresLocalDb?: string;
    readonly postgresSocket?: string;
    readonly postgresPort?: string;
  },
): Promise<{
  inspected: number;
  inaccessible: number;
  truncated: boolean;
  alerts: SentinelIndicatorAlert[];
  databaseSchema?: {
    sqlite?: { inspected: number; truncated: boolean };
    postgres?: { inspected: number; truncated?: boolean };
  };
  tcpListeners?: {
    inspected: number;
    unavailable: string[];
    truncated: boolean;
  };
}> {
  if (Deno.build.os !== "linux") {
    throw new Error("Sentinel local process triage requires Linux /proc");
  }
  if (
    !asset.trim() || asset.length > 256 || hasControlCharacters(asset)
  ) {
    throw new Error("Supply a valid local host asset ID");
  }
  if (
    evidence?.postgresLocalDb !== undefined &&
    evidence.postgresTables !== undefined
  ) {
    throw new Error(
      "Choose either a PostgreSQL metadata export or a local database",
    );
  }
  if (
    (evidence?.postgresSocket !== undefined ||
      evidence?.postgresPort !== undefined) &&
    evidence.postgresLocalDb === undefined
  ) {
    throw new Error(
      "PostgreSQL socket settings require a local database name",
    );
  }
  const detector = createSentinelIndicatorDetector(rules);
  const now = new Date().toISOString();
  const alerts: SentinelIndicatorAlert[] = [];
  let tcpListeners: {
    inspected: number;
    unavailable: string[];
    truncated: boolean;
  } | undefined;
  if (
    parseSentinelIndicatorCatalog(rules).some((rule) =>
      rule.field === "tcpListenPort" &&
      (rule.asset === undefined || rule.asset === asset)
    )
  ) {
    const { ports, ...status } = await readLocalTcpListeners();
    tcpListeners = { inspected: ports.size, ...status };
    for (const port of ports) {
      const id = createHash("sha256").update(JSON.stringify([asset, port, now]))
        .digest("hex");
      alerts.push(...detector.ingest({
        version: 1,
        id: `local-tcp-listener:${id}`,
        timestamp: now,
        asset,
        kind: "host",
        fields: { tcpListenPort: String(port) },
      }));
    }
  }
  const databaseSchema: {
    sqlite?: { inspected: number; truncated: boolean };
    postgres?: { inspected: number; truncated?: boolean };
  } = {};
  function matchTables(
    field: "sqliteTable" | "postgresTable",
    names: readonly string[],
  ) {
    for (const name of names) {
      if (!name.trim() || name.length > 2048 || hasControlCharacters(name)) {
        continue;
      }
      const id = createHash("sha256").update(
        JSON.stringify([asset, field, name, now]),
      ).digest("hex");
      alerts.push(...detector.ingest({
        version: 1,
        id: `local-schema:${id}`,
        timestamp: now,
        asset,
        kind: "host",
        fields: { [field]: name },
      }));
    }
  }
  if (evidence?.sqliteSnapshot !== undefined) {
    const names = readSqliteTableNames(evidence.sqliteSnapshot);
    const sample = names.slice(0, MAX_SCHEMA_NAMES);
    databaseSchema.sqlite = {
      inspected: sample.length,
      truncated: names.length > MAX_SCHEMA_NAMES,
    };
    matchTables("sqliteTable", sample);
  }
  if (evidence?.postgresTables !== undefined) {
    const names = postgresTableNames(evidence.postgresTables);
    databaseSchema.postgres = { inspected: names.length };
    matchTables("postgresTable", names);
  }
  if (evidence?.postgresLocalDb !== undefined) {
    const { names, truncated } = await readLocalPostgresTables(
      evidence.postgresLocalDb,
      evidence.postgresSocket ?? "/var/run/postgresql",
      evidence.postgresPort ?? "5432",
    );
    databaseSchema.postgres = { inspected: names.length, truncated };
    matchTables("postgresTable", names);
  }
  const schemaStatus = Object.keys(databaseSchema).length
    ? { databaseSchema }
    : {};
  let inspected = 0;
  let inaccessible = 0;
  for await (const entry of Deno.readDir("/proc")) {
    if (!entry.isDirectory || !/^\d+$/.test(entry.name)) continue;
    if (inspected + inaccessible >= 4096) {
      return {
        inspected,
        inaccessible,
        truncated: true,
        alerts,
        ...(tcpListeners && { tcpListeners }),
        ...schemaStatus,
      };
    }
    let processName: string;
    try {
      processName = (await Deno.readTextFile(`/proc/${entry.name}/comm`))
        .trimEnd();
      if (
        !processName || hasControlCharacters(processName)
      ) {
        inaccessible++;
        continue;
      }
      inspected++;
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.PermissionDenied)
      ) throw error;
      inaccessible++;
      continue;
    }
    const id = createHash("sha256").update(
      JSON.stringify([asset, entry.name, processName, now]),
    ).digest("hex");
    alerts.push(...detector.ingest({
      version: 1,
      id: `local-process:${id}`,
      timestamp: now,
      asset,
      kind: "host",
      fields: { processName },
    }));
  }
  return {
    inspected,
    inaccessible,
    truncated: false,
    alerts,
    ...(tcpListeners && { tcpListeners }),
    ...schemaStatus,
  };
}
