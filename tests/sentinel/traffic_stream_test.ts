import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "../../src/gateway/sentinel_adaptive_runtime.ts";
import { validateWinlogbeatPrivilegedGroups } from "../../src/sentinel/identity_adapters.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createLiveSentinelAlertPublisher,
  publishSentinelAlerts,
} from "../../src/cli/commands/sentinel_publish.ts";
import { ingestSentinelTelemetry } from "../../src/cli/commands/sentinel_telemetry.ts";
import { ingestSentinelTraffic } from "../../src/cli/commands/sentinel_traffic.ts";
import {
  refreshSentinelAssessment,
  startSentinelAssessment,
} from "../../src/sentinel/assessment_store.ts";
import { buildSentinelProvenance } from "../../src/sentinel/provenance.ts";
import { loadSentinelGraph } from "../../src/sentinel/graph.ts";
import {
  sentinelAlertsPath,
  sentinelDnsPath,
  sentinelTrafficPath,
} from "../../src/sentinel/paths.ts";

Deno.test("Live HTTP observations refresh the case without replacing its inventory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const original = JSON.stringify({
      version: 1,
      nodes: [{ id: "app", kind: "asset", label: "Application" }],
      edges: [],
    });
    await Deno.writeTextFile(path, original);
    const baseline = startSentinelAssessment(path);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          startedDateTime: "2026-01-01T00:00:00Z",
          request: {
            url: "https://example.test/private?token=secret",
            method: "GET",
          },
          response: { status: 200 },
        })));
        controller.close();
      },
    });
    await ingestSentinelTraffic(stream, "sensor", path);
    const updated = refreshSentinelAssessment(path);
    assertEquals(updated?.revision, baseline.revision + 1);
    assert(
      updated?.result?.sharedGraph.snapshot?.edges.some(({ relation }) =>
        relation === "observed_on"
      ),
    );
    assertEquals(await Deno.readTextFile(path), original);
    const published = await Deno.readTextFile(sentinelTrafficPath(path));
    assert(!published.includes("secret"));
    assert(!published.includes("/private"));
    const dns = [
      {
        hostname: "EXAMPLE.test.",
        addresses: ["192.0.2.8"],
        timestamp: "2026-01-01T00:00:01Z",
      },
      {
        hostname: "other.test",
        addresses: ["192.0.2.9"],
        timestamp: "2026-01-01T00:00:01Z",
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    await ingestSentinelTraffic(
      new Blob([dns]).stream(),
      "resolver",
      path,
      "dns",
    );
    const enriched = refreshSentinelAssessment(path);
    assertEquals(enriched?.revision, baseline.revision + 2);
    const enrichedSnapshot = enriched?.result?.sharedGraph.snapshot;
    assert(enrichedSnapshot);
    const origin = enrichedSnapshot.nodes.find(({ label }) =>
      label === "https://example.test"
    );
    assert(origin);
    const trace = loadSentinelGraph(enrichedSnapshot).trace(origin.id, 2);
    assertEquals(
      trace.edges.filter(({ relation }) => relation === "uses_hostname").length,
      1,
    );
    assert(trace.nodes.some(({ label }) => label === "192.0.2.8"));
    assert(!trace.nodes.some(({ label }) => label === "192.0.2.9"));
    assertEquals(await Deno.readTextFile(path), original);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("DNS collector observations enrich a case with normalized addresses and evidence", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const baseline = startSentinelAssessment(path);
    const raw = [
      {
        hostname: "Example.TEST.",
        addresses: ["bad"],
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        hostname: "Example.TEST.",
        addresses: ["192.0.2.8", "2001:0db8::8", "2001:db8::8"],
        timestamp: "2026-01-01T00:00:00Z",
      },
    ].map((item) => JSON.stringify(item)).join("\n");
    const stream = new Blob([raw]).stream();
    await ingestSentinelTraffic(stream, "collector", path, "dns");
    const updated = refreshSentinelAssessment(path);
    assertEquals(updated?.revision, baseline.revision + 1);
    const graph = updated?.result?.sharedGraph.snapshot;
    assertEquals(
      graph?.nodes.filter(({ kind }) => kind === "asset").map(({ label }) =>
        label
      ).sort(),
      ["192.0.2.8", "2001:db8::8", "example.test"],
    );
    assertEquals(
      graph?.edges.filter(({ relation }) => relation === "resolved_to").length,
      2,
    );
    assertEquals(
      graph?.edges.filter(({ relation }) => relation === "observed_on").length,
      3,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Zeek DNS responses enrich the case graph with passive address evidence", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const baseline = startSentinelAssessment(path);
    const base = {
      ts: Date.parse("2026-01-01T00:00:00.123Z") / 1000,
      query: "Example.TEST.",
      qtype: 28,
      qclass: 1,
      rcode: 0,
      answers: [
        "alias.example.test",
        "2001:0db8::8",
        "2001:db8::8",
        "192.0.2.99",
      ],
      rejected: false,
    };
    const records = [
      { ...base, query: "nxdomain.test", rcode: 3 },
      { ...base, query: "truncated.test", TC: true },
      { ...base, query: "rejected.test", rejected: true },
      { ...base, query: "reverse.test", qtype: 12 },
      { ...base, query: "query-only.test", answers: undefined },
      base,
      { ...base, qtype: 1, answers: ["192.0.2.8"] },
    ];
    await ingestSentinelTraffic(
      new Blob([records.map((record) => JSON.stringify(record)).join("\n")])
        .stream(),
      "mirror-sensor",
      path,
      "zeek-dns",
    );
    const updated = refreshSentinelAssessment(path);
    assertEquals(updated?.revision, baseline.revision + 1);
    const snapshot = updated?.result?.sharedGraph.snapshot;
    assert(snapshot);
    assertEquals(
      snapshot.nodes.filter(({ kind }) => kind === "asset").map(({ label }) =>
        label
      ).sort(),
      ["192.0.2.8", "2001:db8::8", "example.test"],
    );
    assertEquals(
      snapshot.edges.filter(({ relation }) => relation === "resolved_to")
        .length,
      2,
    );
    assertEquals(
      snapshot.nodes.filter(({ kind }) => kind === "evidence").length,
      2,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Zeek HTTP transactions link to passive DNS without retaining request payloads", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const stream = (items: unknown[]) =>
      new Blob([
        items.map((item) => JSON.stringify(item)).join("\n"),
      ]).stream();
    const base = {
      ts: Date.parse("2026-01-01T00:00:00Z") / 1000,
      uid: "C0test",
      trans_depth: 1,
      method: "GET",
      host: "Example.test:8080",
      status_code: 403,
      uri: "/private?token=secret",
      user_agent: "private-agent",
      password: "private-password",
    };
    await ingestSentinelTraffic(
      stream([
        base,
        { ...base, trans_depth: 2 },
        { ...base, method: "CONNECT" },
      ]),
      "mirror-sensor",
      path,
      "zeek-http",
    );
    await ingestSentinelTraffic(
      stream([{
        ts: base.ts,
        query: "example.test",
        qtype: 1,
        rcode: 0,
        answers: ["192.0.2.8"],
      }]),
      "mirror-sensor",
      path,
      "zeek-dns",
    );
    const state = startSentinelAssessment(path);
    const snapshot = state.result?.sharedGraph.snapshot;
    assert(snapshot);
    assertEquals(
      snapshot.nodes.filter(({ label }) =>
        label.startsWith("Zeek HTTP GET http://example.test:8080 (HTTP 403)")
      ).length,
      2,
    );
    assertEquals(
      snapshot.edges.filter(({ relation }) => relation === "uses_hostname")
        .length,
      1,
    );
    const stored = await Deno.readTextFile(sentinelTrafficPath(path));
    assertEquals(stored.includes("private"), false);
    assertEquals(stored.includes("secret"), false);
    assertEquals(stored.includes("C0test"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Suricata DNS resolves recorded aliases and excludes unrelated or incomplete answers", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const dns = {
      version: 3,
      type: "answer",
      rcode: "NOERROR",
      flags: "8180",
      queries: [{ rrname: "web.test", rrtype: "A" }, {
        rrname: "second.test",
        rrtype: "AAAA",
      }],
      answers: [
        { rrname: "web.test", rrtype: "CNAME", rdata: "backing.test" },
        { rrname: "backing.test", rrtype: "A", rdata: "192.0.2.8" },
        { rrname: "unrelated.test", rrtype: "A", rdata: "192.0.2.99" },
        { rrname: "second.test", rrtype: "AAAA", rdata: "2001:0db8::8" },
      ],
    };
    const event = {
      event_type: "dns",
      timestamp: "2026-01-01T00:00:00.123456-0700",
      dns,
    };
    const legacy = {
      ...event,
      dns: {
        ...dns,
        version: 2,
        queries: undefined,
        rrname: "legacy.test",
        rrtype: "A",
        answers: [{ rrname: "legacy.test", rrtype: "A", rdata: "192.0.2.10" }],
      },
    };
    await ingestSentinelTraffic(
      new Blob([
        [event, legacy, { ...event, dns: { ...dns, flags: "8380" } }]
          .map((record) => JSON.stringify(record)).join("\n"),
      ]).stream(),
      "suricata",
      path,
      "suricata-dns",
    );
    const snapshot = startSentinelAssessment(path).result?.sharedGraph.snapshot;
    assert(snapshot);
    const labels = new Map(snapshot.nodes.map(({ id, label }) => [id, label]));
    assertEquals(
      snapshot.edges.filter(({ relation }) => relation === "resolved_to")
        .map(({ from, to }) => `${labels.get(from)} → ${labels.get(to)}`)
        .sort(),
      [
        "legacy.test → 192.0.2.10",
        "second.test → 2001:db8::8",
        "web.test → 192.0.2.8",
      ],
    );
    assertEquals(
      snapshot.nodes.filter(({ kind }) => kind === "evidence").length,
      3,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Suricata HTTP and Zeek HTTP share the case graph and keep distinct transaction evidence", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const stream = (items: unknown[]) =>
      new Blob([
        items.map((item) => JSON.stringify(item)).join("\n"),
      ]).stream();
    const event = {
      event_type: "http",
      timestamp: "2026-01-01T00:00:00.123456-0700",
      flow_id: "18446744073709551615",
      tx_id: 0,
      http: {
        hostname: "shared.test",
        http_port: 8080,
        http_method: "POST",
        status: 204,
        url: "/path?private=1",
        request_headers: [{ name: "Authorization", value: "private" }],
      },
    };
    await Promise.all([
      ingestSentinelTraffic(
        stream([event, { ...event, tx_id: 1 }]),
        "mirror",
        path,
        "suricata-http",
      ),
      ingestSentinelTraffic(
        stream([{
          ts: Date.parse("2026-01-01T07:00:00.123Z") / 1000,
          host: "shared.test:8080",
          uid: "A1",
          trans_depth: 1,
          method: "GET",
          status_code: 204,
        }]),
        "mirror",
        path,
        "zeek-http",
      ),
    ]);
    const stored = await Deno.readTextFile(sentinelTrafficPath(path));
    const snapshot = loadSentinelGraph(JSON.parse(stored)).snapshot();
    assertEquals(
      snapshot.nodes.filter(({ kind }) => kind === "asset").map(({ label }) =>
        label
      ),
      ["http://shared.test:8080"],
    );
    assertEquals(
      snapshot.nodes.filter(({ label }) =>
        label.startsWith("Suricata HTTP POST")
      ).length,
      2,
    );
    assertEquals(
      snapshot.nodes.filter(({ label }) => label.startsWith("Zeek HTTP GET"))
        .length,
      1,
    );
    assertEquals(snapshot.edges.length, 3);
    assertEquals(stored.includes("private"), false);
    assertEquals(stored.includes(event.flow_id), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Concurrent DNS feeds share a bounded durable publication window", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const stream = (items: unknown[]) =>
      new Blob([items.map((item) => JSON.stringify(item)).join("\n")]).stream();
    const observation = (hostname: string, ip: string, index: number) => ({
      hostname,
      addresses: [ip],
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
    await ingestSentinelTraffic(
      stream([observation("first.test", "192.0.2.1", 0)]),
      "resolver",
      path,
      "dns",
    );
    const other = observation("other.test", "192.0.2.1", 1);
    const zeek = {
      ts: Date.UTC(2026, 0, 1, 0, 2) / 1000,
      query: "mirror.test",
      qtype: 1,
      rcode: 0,
      answers: ["192.0.2.9"],
    };
    await Promise.all([
      ingestSentinelTraffic(stream([other]), "resolver", path, "dns"),
      ingestSentinelTraffic(stream([zeek]), "mirror", path, "zeek-dns"),
    ]);
    await ingestSentinelTraffic(
      stream(
        Array.from(
          { length: 48 },
          (_, i) => observation("first.test", "192.0.2.2", i + 3),
        ),
      ),
      "resolver",
      path,
      "dns",
    );
    const publishedPath = sentinelDnsPath(path);
    const published = await Deno.readTextFile(publishedPath);
    const graph = loadSentinelGraph(JSON.parse(published)).snapshot();
    const nodes = new Map(graph.nodes.map(({ id, label }) => [id, label]));
    assertEquals(
      graph.nodes.filter(({ kind }) => kind === "evidence").length,
      50,
    );
    assertEquals(
      graph.edges.filter(({ relation }) => relation === "resolved_to").map((
        { from, to },
      ) => `${nodes.get(from)} → ${nodes.get(to)}`).sort(),
      [
        "first.test → 192.0.2.2",
        "mirror.test → 192.0.2.9",
        "other.test → 192.0.2.1",
      ],
    );
    await ingestSentinelTraffic(stream([other]), "resolver", path, "dns");
    assertEquals(await Deno.readTextFile(publishedPath), published);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Reversed Kubernetes audit batches are correlated and replayed alerts are deduplicated", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const alertsPath = sentinelAlertsPath(path);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{ id: "cluster-a", kind: "asset", label: "Cluster A" }],
        edges: [],
      }),
    );
    const baseline = startSentinelAssessment(path);
    const items = Array.from({ length: 5 }, (_, index) => ({
      auditID: `663f497a-e026-4058-9ff5-cb3a05254fa${index}`,
      stage: "ResponseComplete",
      stageTimestamp: `2026-01-01T00:00:0${index}Z`,
      responseStatus: { code: 403 },
      user: { username: "example-user" },
    })).reverse();
    const batch = JSON.stringify({
      apiVersion: "audit.k8s.io/v1",
      kind: "EventList",
      items,
    });
    const stream = () =>
      new Blob([`${batch}
${batch}
`]).stream();
    const emitted: string[] = [];
    const log = console.log;
    console.log = (value: string) => emitted.push(value);
    try {
      await ingestSentinelTelemetry(
        stream(),
        "kubernetes-audit",
        "cluster-a",
        undefined,
        alertsPath,
      );
      await ingestSentinelTelemetry(
        stream(),
        "kubernetes-audit",
        "cluster-a",
        undefined,
        alertsPath,
      );
    } finally {
      console.log = log;
    }
    assertEquals(emitted.length, 1);
    const alerts = JSON.parse(await Deno.readTextFile(alertsPath));
    assertEquals(alerts.length, 1);
    assertEquals(alerts[0].asset, "cluster-a");
    assertEquals(alerts[0].type, "authorization_denial_burst");
    const updated = refreshSentinelAssessment(path)!;
    assertEquals(updated.revision, baseline.revision + 1);
    const provenance = buildSentinelProvenance(updated.result).snapshot();
    const alertNode = provenance.nodes.find((node) =>
      node.label === "authorization denial burst"
    );
    assert(alertNode && "alert" in alertNode);
    assertEquals(alertNode.alert, alerts[0]);
    assert(provenance.edges.some((edge) =>
      edge.from === alertNode.id &&
      edge.to === "asset:cluster-a" && edge.relation === "observed_on"
    ));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live alert publishers merge concurrent writes to the same case", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const [first, second] = await Promise.all([
      createLiveSentinelAlertPublisher(path),
      createLiveSentinelAlertPublisher(path),
    ]);
    const alert = {
      type: "integrity_change" as const,
      severity: "high" as const,
      asset: "shared",
      subject: "service",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceIds: ["one"],
    };
    assert(first.append(alert));
    assert(second.append({ ...alert, evidenceIds: ["two"] }));
    await Promise.all([first.finish(), second.finish()]);
    const alerts = JSON.parse(
      await Deno.readTextFile(sentinelAlertsPath(path)),
    );
    assertEquals(
      alerts.flatMap((item: typeof alert) => item.evidenceIds).sort(),
      ["one", "two"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live publishers merge sensor severity escalations without duplicating the alert", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const [initial, replay] = await Promise.all([
      createLiveSentinelAlertPublisher(path),
      createLiveSentinelAlertPublisher(path),
    ]);
    const alert = {
      type: "security_sensor_alert" as const,
      severity: "medium" as const,
      asset: "worker",
      subject: "Sensor alert",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceIds: ["stable-id"],
    };
    assert(replay.append(alert));
    assert(initial.append({ ...alert, severity: "critical" }));
    await initial.finish();
    await replay.finish();
    const later = await createLiveSentinelAlertPublisher(path);
    assertEquals(later.append(alert), false);
    await later.finish();
    const saved = JSON.parse(await Deno.readTextFile(sentinelAlertsPath(path)));
    assertEquals(saved, [{ ...alert, severity: "critical" }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live alert publishing retries a failed write even without a new alert", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const output = sentinelAlertsPath(path);
  const publisher = await createLiveSentinelAlertPublisher(path);
  try {
    await Deno.mkdir(output + ".lock");
    publisher.append({
      type: "integrity_change",
      severity: "high",
      asset: "app",
      subject: "service",
      observedAt: "2026-01-01T00:00:00.000Z",
      evidenceIds: ["pending"],
    });
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assertEquals(await Deno.stat(output).then(() => true, () => false), false);
    await Deno.remove(output + ".lock");
    const deadline = Date.now() + 5_000;
    let saved: string | undefined;
    while (!saved && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      saved = await Deno.readTextFile(output).catch(() => undefined);
    }
    assert(saved);
    assertEquals(JSON.parse(saved)[0].evidenceIds, ["pending"]);
  } finally {
    try {
      await publisher.finish();
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("CloudTrail gzip archives bypass the line limit and publish normalized alerts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const archive = JSON.stringify(
      {
        Records: [{
          eventVersion: "1.11",
          eventTime: "2026-01-01T00:00:00Z",
          eventID: "policy-change",
          eventName: "AttachRolePolicy",
          eventSource: "iam.amazonaws.com",
          userIdentity: { principalId: "principal" },
          requestParameters: { ignored: "x".repeat(70_000) },
        }],
      },
      null,
      2,
    );
    const zipped = new Blob([archive]).stream().pipeThrough(
      new CompressionStream("gzip"),
    );
    await ingestSentinelTelemetry(
      zipped,
      "cloudtrail",
      "account-a",
      undefined,
      path,
      "gzip",
    );
    const saved = await Deno.readTextFile(sentinelAlertsPath(path));
    assertEquals(
      JSON.parse(saved).map((
        { type, asset }: { type: string; asset: string },
      ) => ({ type, asset })),
      [
        { type: "integrity_change", asset: "account-a" },
      ],
    );
    await ingestSentinelTelemetry(
      new Blob([archive.replace("policy-change", "plain-policy-change")])
        .stream(),
      "cloudtrail",
      "account-a",
      undefined,
      path,
      "json",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(sentinelAlertsPath(path))).length,
      2,
    );
    assertEquals(
      JSON.parse(saved)[0].triggeringAction,
      "iam.amazonaws.com:AttachRolePolicy",
    );
    assert(!saved.includes("ignored"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Published Winlogbeat signals produce a case-scoped incident and adaptive review", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "sentinel.json");
    const sid = "S-1-5-21-1-2-3-2100";
    const source = "dc.example";
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        nodes: [{
          id: "identity",
          kind: "asset",
          label: "Identity server",
          aliases: [source],
        }],
        edges: [],
      }),
    );
    const initial = startSentinelAssessment(path);
    const timestamp = "2026-11-24T12:00:00.000Z";
    const windowsRecord = (
      event_id: number,
      provider_name: string,
      event_data?: Record<string, string>,
    ) =>
      JSON.stringify({
        "@timestamp": timestamp,
        winlog: {
          event_id,
          record_id: event_id,
          computer_name: source,
          channel: "ForwardedEvents",
          provider_name,
          event_data,
        },
      });
    const events = [
      windowsRecord(4728, "Microsoft-Windows-Security-Auditing", {
        TargetSid: sid,
      }),
      windowsRecord(1126, "Microsoft-Windows-Windows Defender"),
      windowsRecord(1125, "Microsoft-Windows-Windows Defender"),
    ];
    const publish = (records: string[]) =>
      ingestSentinelTelemetry(
        new Blob([records.join("\n")]).stream(),
        "winlogbeat",
        undefined,
        undefined,
        path,
        undefined,
        { privilegedGroups: validateWinlogbeatPrivilegedGroups([sid]) },
      );
    await publish(events.slice(0, 1));
    const isolated = refreshSentinelAssessment(path);
    assert(isolated?.result);
    advanceAdaptiveSentinel(path, isolated);
    const isolatedAdaptive = readAdaptiveSentinel(path, isolated);
    const impact = isolatedAdaptive?.tasks.find((task) =>
      task.kind === "impact" && task.nodeId === "identity"
    );
    assert(impact);
    const isolatedGraph = buildSentinelProvenance(
      isolated.result,
      isolatedAdaptive ?? undefined,
    ).snapshot();
    const alertNode = isolatedGraph.nodes.find((node) =>
      "alert" in node && node.alert
    );
    const taskNode = isolatedGraph.nodes.find((node) =>
      node.kind === "task" && node.sourceId === impact.id
    );
    assert(alertNode && taskNode);
    assert(
      isolatedGraph.edges.some(({ from, to, relation }) =>
        from === alertNode.id && to === taskNode.id && relation === "prompted"
      ),
    );
    await publish(events.slice(1));
    const state = refreshSentinelAssessment(path);
    assert(state?.result);
    assertEquals(state.revision, initial.revision + 2);
    advanceAdaptiveSentinel(path, state);
    const adaptive = readAdaptiveSentinel(path, state);
    const graph = buildSentinelProvenance(state.result, adaptive ?? undefined)
      .snapshot();
    const incident = graph.nodes.find((node) =>
      "incident" in node && node.incident
    );
    assert(incident && "incident" in incident);
    assertEquals(incident.incident?.asset, "identity");
    assertEquals(incident.incident?.reportedAssets, [source]);
    assert(
      graph.edges.some(({ from, to, relation }) =>
        from === incident.id && to === "asset:identity" &&
        relation === "references"
      ),
    );
    const linkedAlertTypes = graph.nodes.flatMap((node) =>
      "alert" in node && node.alert &&
        graph.edges.some(({ from, to, relation }) =>
          from === incident.id && to === node.id && relation === "references"
        )
        ? [node.alert.type]
        : []
    ).sort();
    assertEquals(linkedAlertTypes, [
      "network_security_alert",
      "unexpected_privilege_grant",
    ]);
    assertEquals(incident.incident?.evidenceIds.toSorted(), [
      `winlog:1126:1126:${timestamp}`,
      `winlog:4728:4728:${timestamp}`,
    ]);
    assert(
      adaptive?.tasks.some((task) =>
        task.kind === "review_incident" && task.nodeId === incident.sourceId
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Malformed and oversized collector records do not discard surrounding valid alerts", async () => {
  const directory = await Deno.makeTempDir();
  const path = join(directory, "sentinel.json");
  const encoder = new TextEncoder();
  const event = (signature: number) =>
    JSON.stringify({
      event_type: "alert",
      timestamp: "2026-11-24T12:00:00.000Z",
      src_ip: "192.0.2.10",
      dest_ip: "192.0.2.80",
      alert: { signature_id: signature },
    });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(event(9100001) + "\n{invalid\n"));
      controller.enqueue(encoder.encode("x".repeat(64 * 1024)));
      controller.enqueue(encoder.encode("x\n" + event(9100002)));
      controller.close();
    },
  });
  try {
    await ingestSentinelTelemetry(
      stream,
      "suricata",
      undefined,
      undefined,
      path,
    );
    const alerts = JSON.parse(
      await Deno.readTextFile(sentinelAlertsPath(path)),
    );
    assertEquals(
      alerts.map(({ subject }: { subject: string }) => subject),
      ["Suricata 1:9100001", "Suricata 1:9100002"],
    );
    const previous = alerts.map((
      { triggeringAction: _, ...alert }: typeof alerts[number],
    ) => alert);
    await publishSentinelAlerts(previous, path);
    await ingestSentinelTelemetry(
      new Blob([event(9100001)]).stream(),
      "suricata",
      undefined,
      undefined,
      path,
    );
    const enriched = JSON.parse(
      await Deno.readTextFile(sentinelAlertsPath(path)),
    );
    assertEquals(enriched, [alerts[0], previous[1]]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("A full alert replacement waits for the live publisher lock", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const output = sentinelAlertsPath(path);
  const lock = await Deno.open(output + ".lock", { create: true, write: true });
  const alert = {
    type: "integrity_change",
    severity: "high",
    asset: "fixture",
    subject: "Fixture alert",
    observedAt: "2026-11-24T12:00:00.000Z",
    evidenceIds: ["fixture-record"],
  };
  try {
    await lock.lock(true);
    const replacement = publishSentinelAlerts([alert], path);
    try {
      const result = await Promise.race([
        replacement.then(() => "published"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      assertEquals(result, "waiting");
    } finally {
      await lock.unlock();
      await replacement;
    }
    assertEquals(JSON.parse(await Deno.readTextFile(output)), [alert]);
  } finally {
    lock.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live publishing reports overflow in unpublished alerts without logging their contents", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const messages: unknown[] = [];
  const original = console.error;
  console.error = (message: unknown) => messages.push(message);
  try {
    const publisher = await createLiveSentinelAlertPublisher(path);
    for (let index = 0; index < 514; index++) {
      assert(publisher.append({
        type: "integrity_change",
        severity: "high",
        asset: "fixture",
        subject: "Private fixture",
        observedAt: "2026-11-24T12:00:00.000Z",
        evidenceIds: [`record-${index}`],
      }));
    }
    await publisher.finish();
    assertEquals(messages, [JSON.stringify({
      type: "alert_publish_overflow",
      dropped: 2,
    })]);
    const saved = JSON.parse(await Deno.readTextFile(sentinelAlertsPath(path)));
    assertEquals(saved.length, 512);
    assertEquals(saved[0].evidenceIds, ["record-2"]);
  } finally {
    console.error = original;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Collector ingest flushes a full healthy batch before accepting more alerts", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const log = console.log;
  const error = console.error;
  const diagnostics: unknown[] = [];
  console.log = () => {};
  console.error = (message: unknown) => diagnostics.push(message);
  try {
    const records = Array.from({ length: 514 }, (_, index) =>
      JSON.stringify({
        event_type: "alert",
        timestamp: "2026-11-24T12:00:00.000Z",
        src_ip: "192.0.2.10",
        dest_ip: "192.0.2.80",
        alert: { signature_id: 9100000 + index },
      }));
    await ingestSentinelTelemetry(
      new Blob([records.join("\n")]).stream(),
      "suricata",
      undefined,
      undefined,
      path,
    );
    assertEquals(diagnostics, []);
    const saved = JSON.parse(await Deno.readTextFile(sentinelAlertsPath(path)));
    assertEquals(saved.length, 512);
    assertEquals(saved[0].subject, "Suricata 1:9100002");
  } finally {
    console.log = log;
    console.error = error;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Live publishing reports incoming alerts that exceed the snapshot byte limit", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "sentinel.json");
  const original = console.error;
  const diagnostics: unknown[] = [];
  console.error = (message: unknown) => diagnostics.push(message);
  try {
    const publisher = await createLiveSentinelAlertPublisher(path);
    for (let index = 0; index < 300; index++) {
      assert(publisher.append({
        type: "integrity_change",
        severity: "high",
        asset: "fixture",
        subject: "例".repeat(256),
        observedAt: "2026-11-24T12:00:00.000Z",
        evidenceIds: Array.from(
          { length: 6 },
          (_, part) => `${index}-${part}-` + "証".repeat(240),
        ),
      }));
    }
    await publisher.finish();
    const output = sentinelAlertsPath(path);
    assert((await Deno.stat(output)).size <= 1024 * 1024);
    const saved = JSON.parse(await Deno.readTextFile(output));
    assert(saved.length < 300);
    assertEquals(diagnostics, [JSON.stringify({
      type: "alert_publish_size_limit",
      dropped: 300 - saved.length,
    })]);
    assert(saved.at(-1).evidenceIds[0].startsWith("299-"));
  } finally {
    console.error = original;
    await Deno.remove(dir, { recursive: true });
  }
});
