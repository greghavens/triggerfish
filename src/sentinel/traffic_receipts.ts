/** Retained sanitized traffic receipts and exact archived assessment scope. */
/// <reference path="../core/sqlite_types.d.ts" />

import { dirname, join, resolve } from "@std/path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { redactCredentialText } from "../core/logger/redactor.ts";
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
  readonly reviewedResponseBody?: string;
  readonly reviewedRequestBody?: string;
  readonly reviewedHeaders?: string;
  readonly reviewedResponseBase64?: string;
}

export interface SentinelTrafficReceiptQuery {
  readonly assetId?: string;
  readonly family?: SentinelTrafficSource;
  readonly evidenceId?: string;
  readonly origin?: string;
  readonly authority?: string;
  readonly hostname?: string;
  readonly method?: string;
  readonly status?: number;
  readonly from?: string;
  readonly until?: string;
  readonly bodyContains?: string;
  readonly headerContains?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

const EVIDENCE_ID = /^(?:har|dns):evidence:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ASSET_ID = /^(?:har:asset|dns:(?:name|address)):[a-f0-9]{64}$/;
export interface SentinelHintTrafficReference {
  readonly evidenceId: string;
  readonly digest: string;
}
export function isSentinelHintTrafficReference(
  value: unknown,
): value is SentinelHintTrafficReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).length === 2 &&
    typeof ref.evidenceId === "string" && EVIDENCE_ID.test(ref.evidenceId) &&
    typeof ref.digest === "string" && DIGEST.test(ref.digest);
}

/** Legacy singular or a reviewed, ordered set of exact traffic references. */
export type SentinelHintTrafficSelection =
  | SentinelHintTrafficReference
  | readonly SentinelHintTrafficReference[];

export function isSentinelHintTrafficSelection(
  value: unknown,
): value is SentinelHintTrafficSelection {
  return isSentinelHintTrafficReference(value) ||
    (Array.isArray(value) && value.length >= 2 && value.length <= 4 &&
      value.every(isSentinelHintTrafficReference) &&
      new Set(value.map(({ evidenceId }) => evidenceId)).size === value.length);
}

export function sentinelHintTrafficReferences(
  selection: SentinelHintTrafficSelection | undefined,
): readonly SentinelHintTrafficReference[] {
  return !selection
    ? []
    : isSentinelHintTrafficReference(selection)
    ? [selection]
    : selection;
}

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

function validReviewedTrafficBody(body: unknown): body is string {
  return typeof body === "string" && body.isWellFormed() &&
    new TextEncoder().encode(body).byteLength <= 64 * 1024 &&
    !Array.from(body).some((char) => {
      const code = char.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    }) &&
    redactCredentialText(body) === body;
}

const reviewedHeaderNames = new Set([
  "accept",
  "accept-encoding",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "transfer-encoding",
]);

/** Retain a deterministic projection of approved headers in captured order. */
export function projectReviewedHarHeaders(request: unknown, response: unknown) {
  function pick(list: unknown) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > 256) {
      throw new Error("Invalid HAR header list.");
    }
    return list.flatMap((entry) => {
      const { name, value } = entry ?? {};
      if (
        typeof name !== "string" || !reviewedHeaderNames.has(name.toLowerCase())
      ) return [];
      if (
        typeof value !== "string" || value.length > 512 ||
        !/^[\t\x20-\x7e]*$/.test(value) ||
        !validReviewedTrafficBody(value)
      ) throw new Error("Invalid reviewed HAR header value.");
      return [{ name, value }];
    });
  }
  const projection = { request: pick(request), response: pick(response) };
  if (!projection.request.length && !projection.response.length) return;
  const text = JSON.stringify(projection);
  if (text.length > 8192) {
    throw new Error("Reviewed HAR headers exceed the receipt limit.");
  }
  return text;
}

function validReviewedHarHeaders(text: unknown): boolean {
  if (typeof text !== "string" || text.length > 8192) return false;
  try {
    const { request, response } = JSON.parse(text);
    return projectReviewedHarHeaders(request, response) === text;
  } catch {
    return false;
  }
}

function validReviewedResponseBytes(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 44_000) return false;
  const bytes = Buffer.from(value, "base64");
  const inspectable = bytes.toString("latin1");
  return bytes.length <= 32 * 1024 && bytes.toString("base64") === value &&
    redactCredentialText(inspectable) === inspectable;
}

/** Record the sanitized output of the selected ingestion adapter before publishing its graph. */
export function recordSentinelTrafficReceipt(
  path: string,
  family: SentinelTrafficSource,
  snapshot: Snapshot,
  raw: TrafficObservation,
  reviewedResponseBody?: string,
  reviewedRequestBody?: string,
  reviewedHeaders?: string,
  reviewedResponseBase64?: string,
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
  if (
    [reviewedResponseBody, reviewedRequestBody].some((body) =>
      body !== undefined &&
      (family !== "har" || !validReviewedTrafficBody(body))
    )
  ) throw new Error("Invalid reviewed HAR body text.");
  if (
    reviewedHeaders !== undefined &&
    (family !== "har" || !validReviewedHarHeaders(reviewedHeaders))
  ) throw new Error("Invalid reviewed HAR headers.");
  if (
    reviewedResponseBase64 !== undefined &&
    (family !== "har" || reviewedResponseBody !== undefined ||
      !validReviewedResponseBytes(reviewedResponseBase64))
  ) throw new Error("Invalid reviewed HAR binary response.");
  const payload = {
    family,
    evidenceId,
    assetIds,
    observation,
    ...(reviewedResponseBody !== undefined && { reviewedResponseBody }),
    ...(reviewedRequestBody !== undefined && { reviewedRequestBody }),
    ...(reviewedHeaders !== undefined && { reviewedHeaders }),
    ...(reviewedResponseBase64 !== undefined && { reviewedResponseBase64 }),
  };
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

function receiptsAtRevision(
  path: string,
  revision: number,
  exactId?: string,
  allowedAssetIds?: ReadonlySet<string>,
  exactAssetId?: string,
) {
  if (!Number.isSafeInteger(revision) || revision <= 0) return;
  const saved = readSentinelAssessmentRevision(path, revision);
  const snapshot = saved?.result.sharedGraph.snapshot;
  if (!snapshot || !timestamp(saved.updatedAt)) return;
  const links = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.relation !== "observed_on") continue;
    const assets = links.get(edge.from) ?? [];
    assets.push(edge.to);
    links.set(edge.from, assets);
  }
  const candidates =
    (exactId
      ? [exactId]
      : snapshot.nodes.flatMap(({ id, kind }) =>
        kind === "evidence" && EVIDENCE_ID.test(id) ? [id] : []
      )).filter((id) => {
        const assets = links.get(id);
        if (exactAssetId !== undefined && !assets?.includes(exactAssetId)) {
          return false;
        }
        return allowedAssetIds === undefined ||
          (!!assets?.length &&
            assets.every((asset) => allowedAssetIds.has(asset)));
      });
  if (!candidates.length) return [];
  const db = openJournal(path, false);
  if (!db) return [];
  try {
    const nodes = new Map(
      snapshot.nodes.filter(({ kind }) => kind === "evidence").map((
        node,
      ) => [node.id, node]),
    );
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
          digest === hash([1, payload, proof]) &&
          (receipt.reviewedResponseBase64 === undefined ||
            (receipt.family === "har" &&
              receipt.reviewedResponseBody === undefined &&
              validReviewedResponseBytes(receipt.reviewedResponseBase64))) &&
          (receipt.reviewedHeaders === undefined ||
            (receipt.family === "har" &&
              validReviewedHarHeaders(receipt.reviewedHeaders))) &&
          [receipt.reviewedResponseBody, receipt.reviewedRequestBody].every((
            body,
          ) =>
            body === undefined || (receipt.family === "har" &&
              validReviewedTrafficBody(body))
          )
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
  allowedAssetIds?: ReadonlySet<string>,
) {
  if (!EVIDENCE_ID.test(exact.evidenceId) || !DIGEST.test(exact.digest)) {
    return undefined;
  }
  return receiptsAtRevision(
    path,
    revision,
    exact.evidenceId,
    allowedAssetIds,
    exactAssetId,
  )
    ?.find((
      { evidenceId, digest, assetIds },
    ) =>
      evidenceId === exact.evidenceId && digest === exact.digest &&
      (exactAssetId === undefined || assetIds.includes(exactAssetId))
    );
}

/** Stable metadata projection for exact traffic reads and retained citations. */
export function projectSentinelTrafficMetadata(
  receipt: SentinelTrafficReceipt,
  onlyAsset?: string,
) {
  const { digest, family, evidenceId, assetIds, observation } = receipt;
  return {
    digest,
    family,
    evidenceId,
    assetIds: onlyAsset ? [onlyAsset] : assetIds,
    observation: "origin" in observation
      ? {
        origin: observation.origin,
        method: observation.method,
        status: observation.status,
        ...(observation.startedAt && { startedAt: observation.startedAt }),
      }
      : {
        hostname: observation.hostname,
        addresses: observation.addresses,
        timestamp: observation.timestamp,
      },
  };
}

function validReviewedSearchPhrase(phrase: unknown): boolean {
  return phrase === undefined ||
    (typeof phrase === "string" && phrase.trim() === phrase &&
      phrase.length >= 3 && phrase.length <= 128 &&
      /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(phrase) &&
      redactCredentialText(phrase) === phrase);
}

function matchesReviewedHeader(text: string | undefined, phrase: string) {
  if (!text) return false;
  const { request, response } = JSON.parse(text) as {
    request: { name: string; value: string }[];
    response: { name: string; value: string }[];
  };
  return [...request, ...response].some(({ name, value }) =>
    name.toLowerCase().includes(phrase) || value.toLowerCase().includes(phrase)
  );
}

function parseHttpAuthority(value: unknown) {
  if (
    typeof value !== "string" || value.length > 261 || value.trim() !== value
  ) {
    return;
  }
  const parts = /^(\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/i
    .exec(value);
  if (!parts) return;
  const [, host, rawPort] = parts;
  if (!host.startsWith("[") && !HOST.test(host.toLowerCase())) return;
  const port = rawPort === undefined ? undefined : Number(rawPort);
  if (port !== undefined && port > 65_535) return;
  const parsed = URL.parse(`http://${host}`);
  if (
    !parsed || (!host.startsWith("[") &&
      parsed.hostname !== host.toLowerCase())
  ) return;
  return { host: parsed.hostname, port };
}

function matchesHttpAuthority(
  origin: string,
  authority: NonNullable<ReturnType<typeof parseHttpAuthority>>,
) {
  const url = new URL(origin);
  return url.hostname === authority.host &&
    (authority.port === undefined ||
      authority.port ===
        Number(url.port || (url.protocol === "https:" ? 443 : 80)));
}

export function validSentinelTrafficReceiptQuery(
  query: SentinelTrafficReceiptQuery,
): boolean {
  const {
    family,
    assetId,
    evidenceId,
    hostname,
    origin,
    authority,
    method,
    status,
    from,
    until,
    bodyContains,
    headerContains,
    limit = 10,
    cursor,
  } = query;
  return !(
    (family !== undefined && !sentinelTrafficSources.includes(family)) ||
    (assetId !== undefined && !ASSET_ID.test(assetId)) ||
    (evidenceId !== undefined && !EVIDENCE_ID.test(evidenceId)) ||
    (hostname !== undefined &&
      (typeof hostname !== "string" || !HOST.test(hostname))) ||
    (origin !== undefined && !httpOrigin(origin)) ||
    (authority !== undefined && !parseHttpAuthority(authority)) ||
    (method !== undefined && !METHODS.has(method)) ||
    (status !== undefined &&
      (!Number.isInteger(status) ||
        (status !== 0 && (status < 100 || status > 599)))) ||
    (from !== undefined && !timestamp(from)) ||
    (until !== undefined && !timestamp(until)) ||
    (from !== undefined && until !== undefined && from >= until) ||
    !validReviewedSearchPhrase(bodyContains) ||
    !validReviewedSearchPhrase(headerContains) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE ||
    (cursor !== undefined &&
      (typeof cursor !== "string" ||
        !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(cursor)))
  );
}

/** Page scoped case history by immutable evidence ID and filter-bound cursor. */
export function readSentinelTrafficReceiptPage(
  path: string,
  revision: number,
  query: SentinelTrafficReceiptQuery = {},
  allowedAssetIds?: ReadonlySet<string>,
) {
  const {
    family,
    assetId,
    evidenceId,
    hostname,
    origin,
    authority,
    method,
    status,
    from,
    until,
    bodyContains,
    headerContains,
    limit = 10,
    cursor,
  } = query;
  if (!validSentinelTrafficReceiptQuery(query)) return undefined;
  const available = receiptsAtRevision(
    path,
    revision,
    evidenceId,
    allowedAssetIds,
  );
  if (!available) return undefined;
  const selectedAuthority = parseHttpAuthority(authority);
  const phrase = bodyContains?.toLowerCase();
  const header = headerContains?.toLowerCase();
  const results = available.filter(
    (
      {
        family: source,
        assetIds,
        observation,
        reviewedRequestBody,
        reviewedResponseBody,
        reviewedHeaders,
      },
    ) => {
      const http = "origin" in observation;
      const at = http ? observation.startedAt : observation.timestamp;
      return (family === undefined || source === family) &&
        (assetId === undefined || assetIds.includes(assetId)) &&
        (hostname === undefined ||
          (!http && observation.hostname === hostname)) &&
        (origin === undefined || (http && observation.origin === origin)) &&
        (selectedAuthority === undefined ||
          (http &&
            matchesHttpAuthority(observation.origin, selectedAuthority))) &&
        (method === undefined || (http && observation.method === method)) &&
        (status === undefined || (http && observation.status === status)) &&
        (from === undefined || (at !== undefined && at >= from)) &&
        (until === undefined || (at !== undefined && at < until)) &&
        (header === undefined ||
          matchesReviewedHeader(reviewedHeaders, header)) &&
        (phrase === undefined ||
          reviewedRequestBody?.toLowerCase().includes(phrase) === true ||
          reviewedResponseBody?.toLowerCase().includes(phrase) === true);
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
    ...(phrase === undefined ? [] : ["reviewed-text", phrase]),
    ...(header === undefined ? [] : ["reviewed-header", header]),
    ...(selectedAuthority === undefined
      ? []
      : ["http-authority", selectedAuthority.host, selectedAuthority.port]),
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
