/// <reference path="../../src/sentinel/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { triageLocalSentinelHost } from "../../src/sentinel/host_triage.ts";
import { parseSentinelIndicatorCatalog } from "../../src/sentinel/indicators.ts";

const rule = (id: string, value: string, asset = "local-fixture") => ({
  id,
  kind: "host",
  field: "tcpListenPort",
  value,
  asset,
  source: "synthetic",
  severity: "medium",
});

Deno.test("TCP listener indicators require canonical decimal ports", () => {
  for (const value of ["0", "00080", "65536", "0x50", "80/tcp"]) {
    assertThrows(
      () =>
        parseSentinelIndicatorCatalog({
          version: 1,
          rules: [rule("invalid", value)],
        }),
      Error,
      "decimal Sentinel TCP listener port",
    );
  }
});

Deno.test({
  name:
    "Linux host triage matches a listener and ignores established client sockets",
  ignore: Deno.build.os !== "linux",
  async fn() {
    using listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    using client = await Deno.connect({
      hostname: listener.addr.hostname,
      port: listener.addr.port,
    });
    using _connection = await listener.accept();
    const port = String(listener.addr.port);
    const result = await triageLocalSentinelHost({
      version: 1,
      rules: [
        rule("listener", port),
        rule("client", String(client.localAddr.port)),
        rule("other-asset", port, "different-host"),
      ],
    }, "local-fixture");
    assertEquals(result.tcpListeners?.unavailable, []);
    assertEquals(result.alerts.map(({ indicatorId }) => indicatorId), [
      "listener",
    ]);
    assertMatch(
      result.alerts[0].evidenceIds[0],
      /^local-tcp-listener:[0-9a-f]{64}$/,
    );
    assertEquals("port" in result.alerts[0], false);
  },
});

Deno.test({
  name:
    "Host triage reads schema metadata from a standalone snapshot and PostgreSQL export",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const folder = await Deno.makeTempDir();
    const path = join(folder, "snapshot #1.sqlite");
    try {
      const db = new DatabaseSync(path);
      try {
        db.exec(`CREATE TABLE evidence (private_column TEXT);
          INSERT INTO evidence VALUES ('private value');
          CREATE VIEW unrelated AS SELECT private_column FROM evidence;`);
      } finally {
        db.close();
      }
      const before = await Deno.readFile(path);
      const rules = {
        version: 1,
        rules: [
          { ...rule("sqlite", "evidence"), field: "sqliteTable" },
          { ...rule("view", "unrelated"), field: "sqliteTable" },
          { ...rule("pg", "public.inventory"), field: "postgresTable" },
          {
            ...rule("other-schema", "other.inventory"),
            field: "postgresTable",
          },
        ],
      };
      const result = await triageLocalSentinelHost(rules, "local-fixture", {
        sqliteSnapshot: path,
        postgresTables: ["public.inventory", "public.inventory"],
      });
      assertEquals(result.databaseSchema, {
        sqlite: { inspected: 1, truncated: false },
        postgres: { inspected: 1 },
      });
      assertEquals(result.alerts.map(({ indicatorId }) => indicatorId), [
        "sqlite",
        "pg",
      ]);
      assertEquals(JSON.stringify(result).includes("private"), false);
      assertEquals(await Deno.readFile(path), before);
      const entries = [];
      for await (const info of Deno.readDir(folder)) entries.push(info.name);
      assertEquals(entries, ["snapshot #1.sqlite"]);
      await Deno.writeTextFile(path + "-wal", "");
      await assertRejects(
        () =>
          triageLocalSentinelHost(rules, "local-fixture", {
            sqliteSnapshot: path,
          }),
        Error,
        "without journal files",
      );
    } finally {
      await Deno.remove(folder, { recursive: true });
    }
  },
});

Deno.test({
  name: "Host triage rejects remote and ambiguous PostgreSQL selections",
  ignore: Deno.build.os !== "linux",
  async fn() {
    const rules = { version: 1, rules: [] };
    const run = (options: Parameters<typeof triageLocalSentinelHost>[2]) =>
      triageLocalSentinelHost(rules, "local-fixture", options);
    await assertRejects(
      () =>
        run({
          postgresLocalDb: "postgresql://example.test/inventory",
        }),
      Error,
      "database name",
    );
    await assertRejects(
      () =>
        run({
          postgresLocalDb: "inventory",
          postgresSocket: "/run/postgresql,example.test",
        }),
      Error,
      "one absolute",
    );
    await assertRejects(
      () =>
        run({
          postgresLocalDb: "inventory",
          postgresTables: [],
        }),
      Error,
      "either",
    );
    await assertRejects(
      () =>
        run({
          postgresLocalDb: "inventory",
          postgresPort: "0",
        }),
      Error,
      "port from 1 to 65535",
    );
    await assertRejects(
      () =>
        run({
          postgresSocket: "/run/postgresql",
        }),
      Error,
      "require a local database",
    );
  },
});
