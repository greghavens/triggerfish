/** Retained sanitized traffic receipts and exact archived assessment scope. */
/// <reference path="./sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readSentinelAssessmentRevision } from "./assessment_store.ts";
import type { loadSentinelGraph } from "./graph.ts";
import type { SentinelHarObservation } from "./har.ts";

export const sentinelTrafficSources = [
  "har",
  "dns",
  "zeek-dns",
  "zeek-http",
  "suricata-dns",
  "suricata-http",
] as const;
export type SentinelTrafficSource = typeof sentinelTrafficSources[number];

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;
type DnsObservation = {
  readonly evidenceId: string;
  readonly hostname: string;
  readonly addresses: readonly string[];
  readonly timestamp: string;
};
type TrafficObservation = SentinelHarObservation | DnsObservation;

export interface SentinelTrafficReceipt {
  readonly digest: string;
  readonly family: SentinelTrafficSource;
  readonly evidenceId: string;
  readonly assetIds: readonly string[];
  readonly observation: TrafficObservation;
}

export interface SentinelTrafficReceiptQuery {
  readonly assetId?: string;
  readonly family?: SentinelTrafficSource;
  readonly evidenceId?: string;
  readonly origin?: string;
  readonly hostname?: string;
  readonly method?: string;
  readonly status?: number;
  readonly from?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

const EVIDENCE_ID = /^(?:har|dns):evidence:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ASSET_ID = /^(?:har:asset|dns:(?:name|address)):[a-f0-9]{64}$/;
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
  "OTHER",
]);
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MAX_PAGE = 20;

function hash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return false;
  const time = new Date(value);
  return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}

function httpOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const url = URL.parse(value);
  return !!url && (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value;
}

function safeObservation(
  family: SentinelTrafficSource,
  observation: TrafficObservation,
): TrafficObservation | undefined {
  const { evidenceId } = observation;
  if (!EVIDENCE_ID.test(evidenceId)) return undefined;
  if (
    family === "har" || family === "zeek-http" || family === "suricata-http"
  ) {
    if (!evidenceId.startsWith("har:") || !("origin" in observation)) {
      return undefined;
    }
    const { assetId, origin, method, status, startedAt } = observation;
    if (
      !ASSET_ID.test(assetId) || !assetId.startsWith("har:") ||
      !httpOrigin(origin) ||
      !METHODS.has(method) || !Number.isInteger(status) ||
      (status !== 0 && (status < 100 || status > 599)) ||
      (startedAt !== undefined && !timestamp(startedAt))
    ) return undefined;
    return {
      assetId,
      evidenceId,
      origin,
      method,
      status,
      ...(startedAt && { startedAt }),
    };
  }
  if (!evidenceId.startsWith("dns:") || !("hostname" in observation)) {
    return undefined;
  }
  const { hostname, addresses, timestamp: at } = observation;
  if (
    typeof hostname !== "string" || !HOST.test(hostname) || !timestamp(at) ||
    !Array.isArray(addresses) || !addresses.length || addresses.length > 16 ||
    addresses.some((ip) =>
      typeof ip !== "string" || ip.includes("%") || !isIP(ip)
    )
  ) return undefined;
  return {
    evidenceId,
    hostname,
    addresses: [...new Set(addresses)].sort(),
    timestamp: at,
  };
}

function openJournal(path: string, create: boolean) {
  const absolute = join(dirname(path), "sentinel-traffic-receipts.db");
  if (create) {
    const directory = Deno.lstatSync(dirname(absolute));
    if (
      !directory.isDirectory || directory.isSymlink ||
      ((directory.mode ?? 0) & 0o022) !== 0
    ) {
      throw new Error("Sentinel traffic receipts require a trusted directory.");
    }
    try {
      Deno.openSync(absolute, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(absolute);
  } catch (error) {
    if (!create && error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error(
      "Sentinel traffic receipts require a private regular database.",
    );
  }
  const db = new DatabaseSync(absolute, { readOnly: !create });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (create) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_receipts_v1 (
        evidenceId TEXT NOT NULL, family TEXT NOT NULL, record TEXT NOT NULL,
        proof TEXT NOT NULL, retainedAt TEXT NOT NULL,
        PRIMARY KEY (evidenceId, family)
      )
    `);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function observedLinks(snapshot: Snapshot, evidenceId: string) {
  return snapshot.edges.filter(({ relation, from }) =>
    relation === "observed_on" && from === evidenceId
  )
    .map(({ to }) => to).sort();
}

function graphProof(
  snapshot: Snapshot,
  evidenceId: string,
  assetIds: readonly string[],
) {
  const evidence = snapshot.nodes.find(({ id, kind }) =>
    id === evidenceId && kind === "evidence"
  );
  if (!evidence || !assetIds.length) return undefined;
  return hash([evidence, assetIds]);
}

/** Record the sanitized output of the selected ingestion adapter before publishing its graph. */
export function recordSentinelTrafficReceipt(
  path: string,
  family: SentinelTrafficSource,
  snapshot: Snapshot,
  raw: TrafficObservation,
) {
  const observation = safeObservation(family, raw);
  if (!observation) throw new Error("Invalid trusted traffic observation.");
  const { evidenceId } = observation;
  const assetIds = observedLinks(snapshot, evidenceId);
  const valid = "assetId" in observation
    ? assetIds.length === 1 && assetIds[0] === observation.assetId
    : assetIds.length === observation.addresses.length + 1 &&
      assetIds.filter((id) => id.startsWith("dns:name:")).length === 1;
  const proof = graphProof(snapshot, evidenceId, assetIds);
  if (!valid || !proof || assetIds.some((id) => !ASSET_ID.test(id))) {
    throw new Error("Traffic evidence does not match its collector graph.");
  }
  const payload = { family, evidenceId, assetIds, observation };
  const receipt: SentinelTrafficReceipt = {
    digest: hash([1, payload, proof]),
    ...payload,
  };
  const record = JSON.stringify(receipt);
  const db = openJournal(path, true)!;
  try {
    db.prepare(`
      INSERT INTO traffic_receipts_v1 VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(evidenceId, family) DO NOTHING
    `).run(evidenceId, family, record, proof, new Date().toISOString());
    if (
      db.prepare(
        "SELECT record FROM traffic_receipts_v1 WHERE evidenceId = ? AND family = ?",
      )
        .get(evidenceId, family)?.record !== record
    ) {
      throw new Error(
        "Traffic evidence ID already has a different source receipt.",
      );
    }
  } finally {
    db.close();
  }
  return receipt;
}

function receiptsAtRevision(path: string, revision: number, exactId?: string) {
  if (!Number.isSafeInteger(revision) || revision <= 0) return;
  const saved = readSentinelAssessmentRevision(path, revision);
  const snapshot = saved?.result.sharedGraph.snapshot;
  if (!snapshot || !timestamp(saved.updatedAt)) return;
  const candidates = exactId
    ? [exactId]
    : snapshot.nodes.flatMap(({ id, kind }) =>
      kind === "evidence" && EVIDENCE_ID.test(id) ? [id] : []
    );
  if (!candidates.length) return [];
  const db = openJournal(path, false);
  if (!db) return [];
  try {
    const nodes = new Map(
      snapshot.nodes.filter(({ kind }) => kind === "evidence").map((
        node,
      ) => [node.id, node]),
    );
    const links = new Map<string, string[]>();
    for (const edge of snapshot.edges) {
      if (edge.relation !== "observed_on") continue;
      const assets = links.get(edge.from) ?? [];
      assets.push(edge.to);
      links.set(edge.from, assets);
    }
    const rows = db.prepare(`
      SELECT record, proof FROM traffic_receipts_v1 WHERE retainedAt <= ? AND evidenceId IN (${
      candidates.map(() => "?").join(",")
    })
    `).all(saved.updatedAt, ...candidates);
    return rows.flatMap(({ record, proof }) => {
      const receipt = JSON.parse(String(record)) as SentinelTrafficReceipt;
      const { digest, ...payload } = receipt;
      const evidence = nodes.get(receipt.evidenceId);
      const assetIds = links.get(receipt.evidenceId)?.sort();
      return evidence && assetIds && proof === hash([evidence, assetIds]) &&
          digest === hash([1, payload, proof])
        ? [receipt]
        : [];
    }).sort((a, b) =>
      a.evidenceId.localeCompare(b.evidenceId) ||
      a.family.localeCompare(b.family)
    );
  } finally {
    db.close();
  }
}

/** Read an exact immutable receipt only when the archived case graph proves its links. */
export function readSentinelTrafficReceipt(
  path: string,
  revision: number,
  exact: { readonly evidenceId: string; readonly digest: string },
  exactAssetId?: string,
) {
  if (!EVIDENCE_ID.test(exact.evidenceId) || !DIGEST.test(exact.digest)) {
    return undefined;
  }
  return receiptsAtRevision(path, revision, exact.evidenceId)?.find((
    { evidenceId, digest, assetIds },
  ) =>
    evidenceId === exact.evidenceId && digest === exact.digest &&
    (exactAssetId === undefined || assetIds.includes(exactAssetId))
  );
}

/** Page scoped case history by immutable evidence ID and filter-bound cursor. */
export function readSentinelTrafficReceiptPage(
  path: string,
  revision: number,
  query: SentinelTrafficReceiptQuery = {},
) {
  const {
    family,
    assetId,
    evidenceId,
    hostname,
    origin,
    method,
    status,
    from,
    until,
    limit = 10,
    cursor,
  } = query;
  if (
    (family !== undefined && !sentinelTrafficSources.includes(family)) ||
    (assetId !== undefined && !ASSET_ID.test(assetId)) ||
    (evidenceId !== undefined && !EVIDENCE_ID.test(evidenceId)) ||
    (hostname !== undefined &&
      (typeof hostname !== "string" || !HOST.test(hostname))) ||
    (origin !== undefined && !httpOrigin(origin)) ||
    (method !== undefined && !METHODS.has(method)) ||
    (status !== undefined &&
      (!Number.isInteger(status) ||
        (status !== 0 && (status < 100 || status > 599)))) ||
    (from !== undefined && !timestamp(from)) ||
    (until !== undefined && !timestamp(until)) ||
    (from !== undefined && until !== undefined && from >= until) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
  ) return undefined;
  const available = receiptsAtRevision(path, revision, evidenceId);
  if (!available) return undefined;
  const results = available.filter(
    ({ family: source, assetIds, observation }) => {
      const http = "origin" in observation;
      const at = http ? observation.startedAt : observation.timestamp;
      return (family === undefined || source === family) &&
        (assetId === undefined || assetIds.includes(assetId)) &&
        (hostname === undefined ||
          (!http && observation.hostname === hostname)) &&
        (origin === undefined || (http && observation.origin === origin)) &&
        (method === undefined || (http && observation.method === method)) &&
        (status === undefined || (http && observation.status === status)) &&
        (from === undefined || (at !== undefined && at >= from)) &&
        (until === undefined || (at !== undefined && at < until));
    },
  );
  const binding = hash([
    1,
    resolve(path),
    revision,
    family,
    assetId,
    evidenceId,
    hostname,
    origin,
    method,
    status,
    from,
    until,
    results.map(({ digest }) => digest),
  ]);
  const offset = cursor === undefined
    ? 0
    : results.findIndex(({ digest }) =>
      typeof cursor === "string" && cursor === `${binding}.${digest}`
    ) + 1;
  if (cursor !== undefined && offset === 0) return undefined;
  const receipts = results.slice(offset, offset + limit);
  return {
    revision,
    receipts,
    nextCursor: offset + receipts.length < results.length
      ? `${binding}.${receipts.at(-1)!.digest}`
      : null,
  };
}
