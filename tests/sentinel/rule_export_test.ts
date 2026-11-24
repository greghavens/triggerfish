import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseAll } from "@std/yaml";
import {
  renderSentinelSigma,
  renderSentinelSuricata,
} from "../../src/sentinel/rule_export.ts";

const catalog = {
  version: 1,
  rules: [
    {
      id: "dns",
      kind: "dns",
      field: "query",
      value: "Example.TEST.",
      source: "test",
      severity: "medium",
    },
    {
      id: "http",
      kind: "http",
      field: "userAgent",
      value: 'A";*?',
      source: "test",
      severity: "high",
    },
    {
      id: "scoped",
      kind: "dns",
      field: "query",
      value: "example.test",
      asset: "edge",
      source: "test",
      severity: "medium",
    },
  ],
};

Deno.test("Sigma export normalizes exact fields and preserves asset scoping and wildcard literals", () => {
  const [, http, scoped] = parseAll(renderSentinelSigma(catalog)) as Array<{
    detection: { selection: Record<string, string> };
  }>;
  assertEquals(http.detection.selection["fields.userAgent|cased"], 'A";\\*\\?');
  assertEquals(
    scoped.detection.selection["fields.query|cased"],
    "example.test",
  );
  assertEquals(scoped.detection.selection["asset|cased"], "edge");
});

Deno.test("Suricata export encodes literal bytes and reports untranslatable asset scope", () => {
  const { rules, skipped } = renderSentinelSuricata(catalog, 9100020);
  assertEquals(skipped, ["scoped"]);
  assertEquals(rules.split("\n").length, 2);
  assertStringIncludes(rules, "dns.query;");
  assertStringIncludes(rules, "nocase; bsize:12; sid:9100020;");
  assertStringIncludes(
    rules,
    'http.user_agent; content:"|41 22 3b 2a 3f|"; bsize:5; sid:9100021;',
  );
});

Deno.test("Built-in Sigma correlations reference unique source rules and match Sentinel burst thresholds", async () => {
  const { renderSentinelBuiltinSigma } = await import(
    "../../src/sentinel/builtin_rules.ts"
  );
  const {
    AUTH_FAILURE_LIMIT,
    AUTH_FANOUT_LIMIT,
    AUTH_WINDOW_MS,
    DENIAL_LIMIT,
    DENIAL_WINDOW_MS,
    WEB_SEQUENCE_WINDOW_MS,
    WEB_STAGES,
  } = await import("../../src/sentinel/telemetry.ts");
  const docs = parseAll(renderSentinelBuiltinSigma()) as Array<{
    id: string;
    detection?: {
      selection: {
        version: number;
        kind: string;
        "sessionReference|re"?: string;
        "sourceReference|re"?: string;
      };
    };
    correlation?: {
      type: string;
      rules: string[];
      "group-by": string[];
      timespan: string;
      condition: { gte: number; field?: string };
    };
  }>;
  assertEquals(new Set(docs.map(({ id }) => id)).size, docs.length);
  const ordered = docs.find((doc) =>
    doc.correlation?.type === "temporal_ordered"
  )?.correlation;
  assertEquals(
    ordered?.rules.map((id) => {
      const linked = docs.find((doc) => doc.id === id);
      return linked?.correlation?.type ?? linked?.detection?.selection.kind;
    }),
    ["event_count", "auth_success"],
  );
  const fanout = docs.find(({ correlation }) =>
    correlation?.type === "value_count"
  )?.correlation;
  assertEquals(fanout?.["group-by"], ["asset", "sourceReference"]);
  assertEquals(fanout?.timespan, `${AUTH_WINDOW_MS / 1000}s`);
  assertEquals(fanout?.condition, { field: "subject", gte: AUTH_FANOUT_LIMIT });
  assertEquals(
    fanout?.rules.map((id) =>
      docs.find((doc) => doc.id === id)?.detection?.selection
    ),
    [
      {
        version: 1,
        kind: "auth_failure",
        "sourceReference|re": "^source:[a-f0-9]{64}$",
      },
    ],
  );
  assertEquals(ordered?.["group-by"], ["asset", "subject"]);
  const web = docs.find((doc) =>
    doc.correlation?.["group-by"].includes("sessionReference")
  )?.correlation;
  const webSources = web?.rules.map((id) =>
    docs.find((doc) => doc.id === id)?.detection?.selection
  );
  assertEquals(web?.type, "temporal_ordered");
  assertEquals(web?.["group-by"], ["asset", "sessionReference"]);
  assertEquals(web?.timespan, `${WEB_SEQUENCE_WINDOW_MS / 1000}s`);
  assertEquals(web?.condition.gte, WEB_STAGES.length);
  assertEquals(webSources?.map((selection) => selection?.kind), [
    ...WEB_STAGES,
  ]);
  assertEquals(
    webSources?.map((selection) => selection?.["sessionReference|re"]),
    [
      "^session:[a-f0-9]{64}$",
      "^session:[a-f0-9]{64}$",
      "^session:[a-f0-9]{64}$",
    ],
  );
  for (const doc of docs) {
    if (!doc.correlation || doc.correlation.type !== "event_count") continue;
    const source = docs.find(({ id }) => id === doc.correlation!.rules[0]);
    const auth = source?.detection?.selection.kind === "auth_failure";
    assertEquals(doc.correlation["group-by"], ["asset", "subject"]);
    assertEquals(
      doc.correlation.timespan,
      `${(auth ? AUTH_WINDOW_MS : DENIAL_WINDOW_MS) / 1000}s`,
    );
    assertEquals(
      doc.correlation.condition.gte,
      auth ? AUTH_FAILURE_LIMIT : DENIAL_LIMIT,
    );
  }
});

Deno.test("Native alert Sigma selectors cover the correlations without backend timing", async () => {
  const { renderSentinelAlertSigma, renderSentinelBuiltinSigma } = await import(
    "../../src/sentinel/builtin_rules.ts"
  );
  const eventRules = parseAll(renderSentinelBuiltinSigma()) as { id: string }[];
  const rules = parseAll(renderSentinelAlertSigma()) as Array<{
    id: string;
    logsource: { service: string };
    detection: { selection: { type: string } };
    correlation?: unknown;
  }>;
  assertEquals(
    new Set([...eventRules, ...rules].map(({ id }) => id)).size,
    eventRules.length + rules.length,
  );
  assertEquals(
    rules.map(({ detection }) => detection.selection.type),
    [
      "authentication_failure_burst",
      "authentication_failure_fanout",
      "authentication_success_after_failures",
      "authentication_success_after_fanout",
      "authorization_denial_burst",
      "egress_denied_burst",
      "web_multistage_activity",
    ],
  );
  assertEquals(
    rules.every((rule) =>
      rule.logsource.service === "alerts" && !rule.correlation
    ),
    true,
  );
});

Deno.test("Upstream Sigma selectors use the same type and action pairs as defense coverage", async () => {
  const { renderSentinelUpstreamAlertSigma } = await import(
    "../../src/sentinel/builtin_rules.ts"
  );
  const { sentinelUpstreamChecks } = await import(
    "../../src/sentinel/defense_coverage.ts"
  );
  const rules = parseAll(renderSentinelUpstreamAlertSigma()) as Array<{
    id: string;
    detection: { selection: { type: string; triggeringAction: string[] } };
  }>;
  assertEquals(
    new Set(rules.map(({ id }) => id)).size,
    sentinelUpstreamChecks.length,
  );
  assertEquals(
    rules.map(({ detection }) => detection.selection),
    sentinelUpstreamChecks.map(({ type, actions }) => ({
      type,
      triggeringAction: actions,
    })),
  );
});
