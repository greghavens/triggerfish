/** Interpret addresses already observed by a trusted DNS collector. */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { loadSentinelGraph } from "./graph.ts";

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

function id(kind: string, ...parts: string[]): string {
  return `dns:${kind}:${
    createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  }`;
}

function canonicalDnsAddress(address: string, version: number): string {
  return version === 6
    ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
    : address;
}

/** Extract positive A and AAAA answers already recorded by Zeek. */
export function importSentinelZeekDns(raw: unknown, source: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a Zeek DNS record");
  }
  const {
    query,
    qtype,
    qtype_name,
    qclass,
    rcode,
    rcode_name,
    rejected,
    TC,
    answers,
    ts,
  } = raw as Record<string, unknown>;
  if (
    rejected === true || TC === true || (qclass !== undefined && qclass !== 1)
  ) return;
  if ((rcode ?? (rcode_name === "NOERROR" ? 0 : undefined)) !== 0) return;
  const type = qtype ??
    (qtype_name === "A" ? 1 : qtype_name === "AAAA" ? 28 : undefined);
  const version = type === 1 ? 4 : type === 28 ? 6 : undefined;
  if (!version || answers === undefined) return;
  if (!Array.isArray(answers)) throw new Error("Invalid Zeek DNS answers");
  const addresses = [
    ...new Set(
      answers.flatMap((address) =>
        typeof address === "string" && !address.includes("%") &&
          isIP(address) === version
          ? [canonicalDnsAddress(address, version)]
          : []
      ),
    ),
  ].sort().slice(0, 16);
  if (!addresses.length) return;
  const time = typeof ts === "number" ? new Date(ts * 1000) : undefined;
  if (!time || !Number.isFinite(time.getTime())) {
    throw new Error("Invalid Zeek DNS timestamp");
  }
  return importSentinelDnsObservation({
    hostname: query,
    addresses,
    timestamp: time.toISOString(),
  }, source);
}

export function importSentinelDnsObservation(raw: unknown, source: string) {
  if (!source.trim() || source.length > 128) {
    throw new Error("Invalid DNS source");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a DNS observation object");
  }
  const { hostname, addresses, timestamp } = raw as Record<string, unknown>;
  const host = typeof hostname === "string"
    ? hostname.toLowerCase().replace(/\.$/, "")
    : "";
  if (
    !host || host.length > 253 ||
    !host.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) throw new Error("Invalid observed DNS hostname");
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 16) {
    throw new Error("Expected 1–16 observed DNS addresses");
  }
  const ips = [
    ...new Set(addresses.map((address: unknown) => {
      if (
        typeof address !== "string" || address.includes("%")
      ) throw new Error("Invalid observed IP address");
      const version = isIP(address);
      if (!version) throw new Error("Invalid observed IP address");
      return version === 6
        ? new URL(`http://[${address}]`).hostname.slice(1, -1)
        : address;
    })),
  ].sort();
  if (
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)
  ) {
    throw new Error("Expected an observed UTC timestamp");
  }
  const time = new Date(timestamp);
  const canonical = timestamp.includes(".")
    ? timestamp
    : timestamp.replace("Z", ".000Z");
  if (!Number.isFinite(time.valueOf()) || time.toISOString() !== canonical) {
    throw new Error("Invalid observed UTC timestamp");
  }

  const hostnameId = id("name", source, host);
  const evidenceId = id("evidence", source, host, canonical, ...ips);
  const snapshot: Snapshot = {
    version: 1,
    nodes: [
      { id: hostnameId, kind: "asset", label: host },
      {
        id: evidenceId,
        kind: "evidence",
        label: `DNS observation for ${host} at ${canonical}`,
      },
    ],
    edges: [{ from: evidenceId, to: hostnameId, relation: "observed_on" }],
  };
  for (const address of ips) {
    const addressId = id("address", source, address);
    snapshot.nodes.push({ id: addressId, kind: "asset", label: address });
    snapshot.edges.push(
      { from: hostnameId, to: addressId, relation: "resolved_to" },
      { from: evidenceId, to: addressId, relation: "observed_on" },
    );
  }
  return {
    snapshot,
    observation: {
      evidenceId,
      hostname: host,
      addresses: ips,
      timestamp: canonical,
    },
  };
}
