/** Read capture metadata from an operator-supplied HTTP Archive. */

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type Node = Snapshot["nodes"][number];

const MAX_NODES = 2_000;
const MAX_URL_LENGTH = 16_384;
const methods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
] as const;
type Method = typeof methods[number] | "OTHER";

export interface SentinelHarObservation {
  readonly assetId: string;
  readonly evidenceId: string;
  readonly origin: string;
  readonly method: Method;
  /** HAR exporters can use 0 when no HTTP status was recorded. */
  readonly status: number;
  readonly startedAt?: string;
}

const timestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/;

function object(raw: unknown, field: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a HAR ${field} object`);
  }
  return raw as Record<string, unknown>;
}

function requireText(raw: unknown, field: string, limit: number): string {
  if (
    typeof raw !== "string" || !raw.trim() || raw.length > limit ||
    [...raw].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code < 160);
    })
  ) {
    throw new Error(`Invalid HAR ${field}`);
  }
  return raw;
}

function checkedOrigin(raw: unknown): string | undefined {
  const scheme = typeof raw === "string"
    ? /^[a-z][a-z\d.+-]{0,31}:/i.exec(raw)?.[0]
    : undefined;
  if (scheme === undefined) {
    throw new Error("Expected an absolute HAR request URL");
  }
  if (!/^https?:$/i.test(scheme)) return undefined;
  const url = requireText(raw, "request URL", MAX_URL_LENGTH);
  if (!/^https?:\/\/[^/?#]/i.test(url) || /\s/.test(url)) {
    throw new Error("Invalid HAR HTTP request URL");
  }

  try {
    return new URL(url).origin;
  } catch {
    throw new Error("Invalid HAR HTTP request URL");
  }
}

function checkedMethod(raw: unknown): Method {
  const method = requireText(raw, "request method", 64);
  if (!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(method)) {
    throw new Error("Invalid HAR request method");
  }
  return methods.find((supported) => supported === method) ?? "OTHER";
}

function checkedStatus(raw: unknown): number {
  if (
    typeof raw === "number" && Number.isInteger(raw) &&
    (raw === 0 || (raw >= 100 && raw <= 599))
  ) {
    return raw;
  }
  throw new Error("Invalid HAR response status");
}

function checkedTimestamp(raw: unknown): string | undefined {
  if (raw === undefined) return;
  const match = typeof raw === "string" ? timestampPattern.exec(raw) : null;
  if (!match) throw new Error("Invalid HAR request start time");
  const [, seconds, fraction = "", offset] = match;
  const wallClock = `${seconds}.${fraction.padEnd(3, "0").slice(0, 3)}`;
  const local = Date.parse(`${wallClock}Z`);
  const time = Date.parse(`${wallClock}${offset}`);
  if (
    !Number.isFinite(local) || !Number.isFinite(time) ||
    new Date(local).toISOString() !== `${wallClock}Z`
  ) {
    throw new Error("Invalid HAR request start time");
  }
  const timestamp = new Date(time).toISOString();
  if (timestamp.length !== 24) {
    throw new Error("HAR time exceeds the UTC calendar range");
  }
  return timestamp;
}

function stableId(kind: "asset" | "evidence", value: string): string {
  return `har:${kind}:${createHash("sha256").update(value).digest("hex")}`;
}

/** Produce observations and source nodes without deriving findings or graph assertions. */
export function importSentinelHar(
  raw: unknown,
  source: string,
): {
  readonly version: 1;
  readonly snapshot: Snapshot;
  readonly observations: readonly SentinelHarObservation[];
} {
  const project = requireText(source, "project namespace", 256);
  const log = object(object(raw, "document").log, "log");
  if (log.version !== "1.2" || !Array.isArray(log.entries)) {
    throw new Error("Expected HAR 1.2 with a log.entries array");
  }
  if (log.entries.length > MAX_NODES) {
    throw new Error("HAR contains more than 2000 request entries");
  }

  const nodes = new Map<string, Node>();
  const occurrences = new Map<string, number>();
  const observations: SentinelHarObservation[] = [];

  function addNode(node: Node): void {
    if (!nodes.has(node.id) && nodes.size >= MAX_NODES) {
      throw new Error("HAR observations exceed 2000 Sentinel nodes");
    }
    nodes.set(node.id, node);
  }

  for (const rawEntry of log.entries) {
    const entry = object(rawEntry, "entry");
    const request = object(entry.request, "request");
    const origin = checkedOrigin(request.url);
    if (origin === undefined) continue;
    const method = checkedMethod(request.method);
    const status = checkedStatus(object(entry.response, "response").status);
    const startedAt = checkedTimestamp(entry.startedDateTime);
    const assetId = stableId("asset", JSON.stringify([project, origin]));
    const retainedFields = JSON.stringify([
      project,
      origin,
      method,
      status,
      startedAt ?? null,
    ]);
    const occurrence = (occurrences.get(retainedFields) ?? 0) + 1;
    occurrences.set(retainedFields, occurrence);
    const evidenceId = stableId(
      "evidence",
      JSON.stringify([retainedFields, occurrence]),
    );
    addNode({ id: assetId, kind: "asset", label: origin });
    const recordedStatus = status === 0
      ? "no HTTP status recorded"
      : `HTTP ${status}`;
    addNode({
      id: evidenceId,
      kind: "evidence",
      label: `HAR ${method} ${origin} (${recordedStatus})${
        startedAt ? ` at ${startedAt}` : ""
      }`,
    });
    observations.push({
      assetId,
      evidenceId,
      origin,
      method,
      status,
      ...(startedAt !== undefined && { startedAt }),
    });
  }

  return {
    version: 1,
    snapshot: {
      version: 1,
      nodes: [...nodes.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id === b.id ? 0 : 1
      ),
      edges: observations.map(({ evidenceId, assetId }) => ({
        from: evidenceId,
        to: assetId,
        relation: "observed_on" as const,
      })),
    },
    observations,
  };
}

/** Extract a sanitized HTTP observation from Zeek's JSON http.log. */
export function importSentinelZeekHttp(raw: unknown, source: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a Zeek HTTP record");
  }
  const { host, method, status_code, uid, trans_depth, ts } = raw as Record<
    string,
    unknown
  >;
  if (host === undefined || method === undefined || method === "CONNECT") {
    return;
  }
  if (
    typeof uid !== "string" || !/^[a-z0-9]{1,128}$/i.test(uid) ||
    typeof trans_depth !== "number" || !Number.isSafeInteger(trans_depth) ||
    trans_depth < 0
  ) throw new Error("Invalid Zeek HTTP transaction identity");
  const time = typeof ts === "number" ? new Date(ts * 1000) : undefined;
  if (!time || !Number.isFinite(time.getTime())) {
    throw new Error("Invalid Zeek HTTP timestamp");
  }
  return importSensorHttp(
    host,
    method,
    status_code,
    time.toISOString(),
    source,
    "Zeek HTTP",
    ["zeek-http", uid, trans_depth],
  );
}

/** Extract sanitized HTTP metadata from standalone Suricata EVE HTTP records. */
export function importSentinelSuricataHttp(raw: unknown, source: string) {
  const event = object(raw, "Suricata EVE record");
  if (event.event_type !== "http") return;
  const http = object(event.http, "Suricata HTTP record");
  const { hostname, http_port, http_method, status } = http;
  if (
    hostname === undefined || http_method === undefined ||
    http_method === "CONNECT"
  ) return;
  if (typeof hostname !== "string") {
    throw new Error("Invalid Suricata HTTP hostname");
  }
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  if (
    http_port !== undefined &&
    (typeof http_port !== "number" || !Number.isInteger(http_port) ||
      http_port < 1 || http_port > 65535)
  ) {
    throw new Error("Invalid Suricata HTTP port");
  }
  const { flow_id, tx_id } = event;
  if (
    typeof tx_id !== "number" || !Number.isSafeInteger(tx_id) || tx_id < 0 ||
    !((typeof flow_id === "number" && Number.isInteger(flow_id) &&
      flow_id >= 0) ||
      (typeof flow_id === "string" && /^[0-9]{1,20}$/.test(flow_id)))
  ) {
    throw new Error("Invalid Suricata HTTP transaction identity");
  }
  const authority = http_port === undefined ? host : `${host}:${http_port}`;
  return importSensorHttp(
    authority,
    http_method,
    status,
    event.timestamp,
    source,
    "Suricata HTTP",
    [
      "suricata-http",
      String(flow_id),
      tx_id,
      event.src_ip,
      event.src_port,
      event.dest_ip,
      event.dest_port,
    ],
  );
}

function importSensorHttp(
  host: unknown,
  method: unknown,
  status: unknown,
  timestamp: unknown,
  source: string,
  label: string,
  identity: readonly unknown[],
) {
  if (
    typeof host !== "string" || host.length > 261 ||
    !/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?$/i.test(host)
  ) throw new Error("Invalid sensor HTTP host authority");
  if (timestamp === undefined) throw new Error("Missing sensor HTTP timestamp");
  const { snapshot, observations } = importSentinelHar({
    log: {
      version: "1.2",
      entries: [{
        startedDateTime: timestamp,
        request: { method, url: `http://${host}` },
        response: { status: status ?? 0 },
      }],
    },
  }, source);
  const [observation] = observations;
  const evidenceId = stableId(
    "evidence",
    JSON.stringify([...identity, observation.evidenceId]),
  );
  return {
    snapshot: {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === observation.evidenceId
          ? {
            ...node,
            id: evidenceId,
            label: node.label.replace(/^HAR /, `${label} `),
          }
          : node
      ),
      edges: snapshot.edges.map((edge) => ({ ...edge, from: evidenceId })),
    },
    observation: { ...observation, evidenceId },
  };
}
