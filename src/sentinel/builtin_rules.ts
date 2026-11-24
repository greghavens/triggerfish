/** Sigma correlation pack for normalized Sentinel telemetry. */
import { sentinelUpstreamChecks } from "./defense_coverage.ts";
import { stringify } from "@std/yaml";
import {
  AUTH_FAILURE_LIMIT,
  AUTH_FANOUT_LIMIT,
  AUTH_WINDOW_MS,
  DENIAL_LIMIT,
  DENIAL_WINDOW_MS,
  WEB_SEQUENCE_WINDOW_MS,
  WEB_STAGES,
} from "./telemetry.ts";

const bursts = [
  {
    kind: "auth_failure",
    title: "Authentication failure burst",
    baseId: "7ba84aa2-e193-4f42-ad3e-65890aededbf",
    correlationId: "fee32c2a-7d89-48b2-9b82-bbf54f96cc71",
    threshold: AUTH_FAILURE_LIMIT,
    window: AUTH_WINDOW_MS,
    falsePositive: "Repeated legitimate authentication retries",
  },
  {
    kind: "egress_denied",
    title: "Egress denial burst",
    baseId: "1f598422-fe6d-4d4c-938a-f96ecbb6a1a9",
    correlationId: "7172ceeb-3be0-470b-9dc2-e605cabfef74",
    threshold: DENIAL_LIMIT,
    window: DENIAL_WINDOW_MS,
    falsePositive: "An application retrying a connection blocked by policy",
  },
  {
    kind: "authorization_denied",
    title: "Authorization denial burst",
    baseId: "eca39488-7983-48e2-9f6b-8384df4df7b3",
    correlationId: "bade4ccf-63ed-4662-9335-245147bf6dd8",
    threshold: DENIAL_LIMIT,
    window: DENIAL_WINDOW_MS,
    falsePositive: "A client retrying an operation with outdated permissions",
  },
] as const;

function sourceRule(id: string, kind: string, title: string) {
  return {
    title,
    id,
    logsource: {
      product: "sentinel",
      service: "telemetry",
      definition:
        "Index normalized Sentinel event fields with timestamp as the event time.",
    },
    detection: { selection: { version: 1, kind }, condition: "selection" },
  };
}

const orderedFailureBurst = "4895caeb-d9c8-4d46-ab7b-d9d41cca394f";
const successfulLogin = "db450961-a9eb-4195-ad79-bd3ef46298bb";
const scopedAuthenticationFailure = "20927512-e55a-49f6-ac46-e65bfa42ef9e";
const webStageRuleIds = [
  "756c81bf-d1f0-4f2e-ac92-f903808694c5",
  "f3bed995-3223-4f86-963f-4b6313f3f662",
  "e7f881e5-1fcb-4c6e-84d8-6f4acdac7941",
];

export function renderSentinelBuiltinSigma(): string {
  const burstRules = bursts.flatMap((rule) => [
    sourceRule(rule.baseId, rule.kind, `Sentinel ${rule.title} source event`),
    {
      title: `Sentinel ${rule.title}`,
      id: rule.correlationId,
      status: "experimental",
      description: `Counts ${rule.kind} events for each asset and subject.`,
      correlation: {
        type: "event_count",
        rules: [rule.baseId],
        "group-by": ["asset", "subject"],
        timespan: `${rule.window / 1000}s`,
        condition: { gte: rule.threshold },
      },
      falsepositives: [rule.falsePositive],
      level: "medium",
    },
  ]);
  return [
    ...burstRules,
    {
      title: "Sentinel failure burst for ordered authentication correlation",
      id: orderedFailureBurst,
      correlation: {
        type: "event_count",
        rules: [bursts[0].baseId],
        "group-by": ["asset", "subject"],
        timespan: `${AUTH_WINDOW_MS / 1000}s`,
        condition: { gte: AUTH_FAILURE_LIMIT },
      },
    },
    sourceRule(
      successfulLogin,
      "auth_success",
      "Sentinel successful authentication source event",
    ),
    {
      title: "Sentinel authentication success after a failure burst",
      id: "cbe03aa9-c078-463b-b5f3-01ba2ed07a35",
      status: "experimental",
      correlation: {
        type: "temporal_ordered",
        rules: [orderedFailureBurst, successfulLogin],
        "group-by": ["asset", "subject"],
        timespan: `${AUTH_WINDOW_MS / 1000}s`,
        condition: { gte: 2 },
      },
      falsepositives: ["A user signs in after correcting a mistyped password"],
      level: "high",
    },
    {
      ...sourceRule(
        scopedAuthenticationFailure,
        "auth_failure",
        "Sentinel authentication failure with a source reference",
      ),
      detection: {
        selection: {
          version: 1,
          kind: "auth_failure",
          "sourceReference|re": "^source:[a-f0-9]{64}$",
        },
        condition: "selection",
      },
    },
    {
      title: "Sentinel authentication failures across accounts from one source",
      id: "a7c92ea2-be2c-4feb-873b-2bc8ac10d63d",
      status: "experimental",
      description:
        "Counts distinct account subjects in normalized authentication failures from a trusted source reference. Index one case per stream and verify timing and suppression in the backend.",
      correlation: {
        type: "value_count",
        rules: [scopedAuthenticationFailure],
        "group-by": ["asset", "sourceReference"],
        timespan: `${AUTH_WINDOW_MS / 1000}s`,
        condition: { field: "subject", gte: AUTH_FANOUT_LIMIT },
      },
      falsepositives: [
        "Legitimate failovers or retries from a shared identity client",
      ],
      level: "medium",
    },
    ...WEB_STAGES.map((kind, index) => ({
      ...sourceRule(
        webStageRuleIds[index],
        kind,
        `Sentinel ${kind.replaceAll("_", " ")}`,
      ),
      detection: {
        selection: {
          version: 1,
          kind,
          "sessionReference|re": "^session:[a-f0-9]{64}$",
        },
        condition: "selection",
      },
    })),
    {
      title: "Sentinel ordered web activity",
      id: "862f293f-a0da-43d6-862e-814f3eecc4c3",
      status: "experimental",
      description:
        "Correlates normalized web activity labels from an authorized collector. Index one case per stream and verify ordering, deduplication, and suppression in the backend.",
      correlation: {
        type: "temporal_ordered",
        rules: webStageRuleIds,
        "group-by": ["asset", "sessionReference"],
        timespan: `${WEB_SEQUENCE_WINDOW_MS / 1000}s`,
        condition: { gte: 3 },
      },
      falsepositives: [
        "Authorized testing or administration reported under the same session",
      ],
      level: "medium",
    },
  ].map((rule) => stringify(rule).trimEnd()).join("\n---\n");
}

/** Match already correlated alerts when the backend cannot reproduce native timing. */
export function renderSentinelAlertSigma(): string {
  const alerts = [
    [
      "authentication_failure_burst",
      "Authentication failure burst",
      "medium",
      "3d4641f1-dbed-4cd4-a130-aee82a7ff4c1",
    ],
    [
      "authentication_failure_fanout",
      "Authentication failures across accounts from one source",
      "medium",
      "bb2ab2ff-907e-4a47-99f2-6df0798385b0",
    ],
    [
      "authentication_success_after_failures",
      "Authentication success after a failure burst",
      "high",
      "5192a871-e179-4710-add3-fec6ba786006",
    ],
    [
      "authentication_success_after_fanout",
      "Authentication success after failures across accounts from one source",
      "high",
      "1d15779e-e6e0-4738-9a46-373212b3eb0f",
    ],
    [
      "authorization_denial_burst",
      "Authorization denial burst",
      "medium",
      "66944bf6-bb69-49cb-aceb-ec8492e98de9",
    ],
    [
      "egress_denied_burst",
      "Egress denial burst",
      "medium",
      "564bd1ef-cb73-4c95-b9be-00bdd5049df9",
    ],
    [
      "web_multistage_activity",
      "Ordered web activity",
      "medium",
      "a441b04c-1f0c-4708-9a48-6ce5aa601422",
    ],
  ] as const;
  return alerts.map(([type, title, level, id]) =>
    stringify({
      title: `Sentinel native alert – ${title}`,
      id,
      status: "experimental",
      logsource: {
        product: "sentinel",
        service: "alerts",
        definition:
          "Index the JSONL output of Sentinel detect with observedAt as event time.",
      },
      detection: { selection: { type: type }, condition: "selection" },
      level,
    }).trimEnd()
  ).join("\n---\n");
}

/** Export exact source-action checks from the same catalog as the coverage report. */
export function renderSentinelUpstreamAlertSigma(): string {
  return sentinelUpstreamChecks.map((check) =>
    stringify({
      title: `Sentinel upstream alert – ${check.id.replaceAll("_", " ")}`,
      id: check.sigmaId,
      status: "experimental",
      description: check.limitation,
      logsource: { product: "sentinel", service: "alerts" },
      detection: {
        selection: { type: check.type, triggeringAction: check.actions },
        condition: "selection",
      },
    }).trimEnd()
  ).join("\n---\n");
}
