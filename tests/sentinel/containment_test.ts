/// <reference path="../../src/core/sqlite_types.d.ts" />

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import {
  checkSentinelContainment,
  normalizeSentinelContainmentTarget,
  openSentinelContainment,
  readSentinelContainmentOverview,
} from "../../src/sentinel/containment.ts";

Deno.test("Sentinel containment persists normalized quarantines with expiry and release audit", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "containment.db");
  const start = Date.UTC(2026, 0, 1);
  let now = start;
  try {
    assertThrows(
      () => readSentinelContainmentOverview(path, now),
      Deno.errors.NotFound,
    );
    assertThrows(() => Deno.statSync(path), Deno.errors.NotFound);
    const policy = openSentinelContainment(path, () => now);
    try {
      const rule = policy.block({
        target: "APP.EXAMPLE.",
        reason: "investigate suspicious traffic",
        ttlSeconds: 60,
      });
      assertEquals(rule, {
        target: "app.example",
        reason: "investigate suspicious traffic",
        blockedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:01:00.000Z",
      });
      assertEquals(policy.list(), [rule]);
      const overview = readSentinelContainmentOverview(path, now);
      assertEquals(overview.total, 1);
      assertEquals(overview.active, [{ ...rule, revision: "1" }]);
      assertEquals(overview.audit.map(({ action }) => action), ["block"]);
      assertEquals(
        readSentinelContainmentOverview(path, now + 60_000).active,
        [],
      );
      assertEquals(checkSentinelContainment(path, "App.Example.", now), {
        target: "app.example",
        decision: "deny",
        block: rule,
      });
      assertEquals(policy.check("sub.app.example").decision, "allow");
    } finally {
      policy.close();
    }

    const reopened = openSentinelContainment(path, () => now);
    try {
      assertEquals(reopened.check("app.example").decision, "deny");
      assertEquals(
        reopened.release({
          target: "app.example",
          reason: "stale fixture",
          expectedRevision: "0",
        }).released,
        false,
      );
      assertEquals(reopened.check("app.example").decision, "deny");
      now += 60_000;
      assertEquals(reopened.check("app.example").decision, "allow");
      assertEquals(reopened.list(), []);
      assertEquals(
        reopened.release({ target: "app.example", reason: "reviewed" }),
        {
          target: "app.example",
          released: true,
        },
      );
      assertEquals(
        reopened.release({ target: "app.example", reason: "retry" }),
        {
          target: "app.example",
          released: false,
        },
      );
      assertEquals(
        reopened.audit().map((event) => [event.action, event.reason]),
        [
          ["release", "reviewed"],
          ["block", "investigate suspicious traffic"],
        ],
      );
      assertEquals(reopened.audit(1).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Sentinel containment matches equivalent IPv6 and IPv4-mapped spellings", () => {
  assertEquals(
    normalizeSentinelContainmentTarget("[2001:0db8:0:0:0:0:0:1]"),
    "2001:db8::1",
  );
  assertEquals(
    normalizeSentinelContainmentTarget("::ffff:192.0.2.1"),
    "192.0.2.1",
  );
  for (
    const invalid of [
      "https://app.example",
      "*.app.example",
      "app.example:443",
      "127.1",
      "0x7f000001",
      "127.000.0.1",
      "192.0.2.0/24",
      "fe80::1%eth0",
      "app.example..",
    ]
  ) {
    assertThrows(() => normalizeSentinelContainmentTarget(invalid), Error);
  }
});

Deno.test("Sentinel read-only enforcement fails on missing or invalid databases", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "missing.db");
  try {
    assertThrows(
      () => checkSentinelContainment(path, "app.example"),
      Deno.errors.NotFound,
    );
    assertEquals([...Deno.readDirSync(directory)], []);
    Deno.writeTextFileSync(path, "", { mode: 0o600 });
    assertThrows(
      () => checkSentinelContainment(path, "app.example"),
      Error,
      "Invalid Sentinel containment database",
    );
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test({
  name: "Sentinel rejects symlinked and shared quarantine database files",
  ignore: Deno.build.os === "windows",
  fn() {
    const directory = Deno.makeTempDirSync();
    const path = join(directory, "containment.db");
    const link = join(directory, "link.db");
    try {
      openSentinelContainment(path).close();
      Deno.symlinkSync(path, link);
      assertThrows(
        () => openSentinelContainment(link),
        Error,
        "regular private file",
      );
      assertThrows(
        () => checkSentinelContainment(link, "app.example"),
        Error,
        "regular private file",
      );
      Deno.chmodSync(path, 0o644);
      assertThrows(
        () => checkSentinelContainment(path, "app.example"),
        Error,
        "only to its owner",
      );
    } finally {
      Deno.removeSync(directory, { recursive: true });
    }
  },
});

Deno.test("Sentinel validates block requests before mutating state", () => {
  const directory = Deno.makeTempDirSync();
  try {
    const policy = openSentinelContainment(join(directory, "containment.db"));
    try {
      assertThrows(
        () =>
          policy.block({
            target: "app.example",
            reason: "reviewed",
            ttlSeconds: 0,
          }),
        Error,
        "duration",
      );
      assertThrows(
        () =>
          policy.block({ target: "app.example", reason: " ", ttlSeconds: 10 }),
        Error,
        "reason",
      );
      assertEquals(policy.list(), []);
      assertEquals(policy.audit(), []);
    } finally {
      policy.close();
    }
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Sentinel rolls back a block when the accompanying audit write fails", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "containment.db");
  try {
    const policy = openSentinelContainment(path);
    try {
      const db = new DatabaseSync(path);
      try {
        db.exec(`
          CREATE TRIGGER simulate_audit_failure BEFORE INSERT ON containment_audit
          BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END;
        `);
      } finally {
        db.close();
      }

      assertThrows(
        () =>
          policy.block({
            target: "app.example",
            reason: "review",
            ttlSeconds: 10,
          }),
        Error,
        "simulated audit failure",
      );
      assertEquals(policy.check("app.example").decision, "allow");
    } finally {
      policy.close();
    }
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
});

Deno.test("Sentinel rejects a stale release after replacing a quarantine in the same millisecond", () => {
  const directory = Deno.makeTempDirSync();
  const path = join(directory, "containment.db");
  const now = () => Date.UTC(2026, 0, 1);
  const policy = openSentinelContainment(path, now);
  const target = "app.example";
  try {
    const first = policy.block({ target, reason: "first", ttlSeconds: 60 });
    const original = readSentinelContainmentOverview(path, now()).active[0];
    const second = policy.block({ target, reason: "second", ttlSeconds: 60 });
    const current = readSentinelContainmentOverview(path, now()).active[0];
    assertEquals(first.blockedAt, second.blockedAt);
    assertEquals(
      policy.release({
        target,
        reason: "stale approval",
        expectedRevision: original.revision ?? "",
      }).released,
      false,
    );
    assertEquals(policy.check(target).decision, "deny");
    assertEquals(
      policy.release({
        target,
        reason: "current approval",
        expectedRevision: current.revision ?? "",
      }).released,
      true,
    );
    assertEquals(policy.audit().map(({ reason }) => reason), [
      "current approval",
      "second",
      "first",
    ]);
  } finally {
    policy.close();
    Deno.removeSync(directory, { recursive: true });
  }
});
