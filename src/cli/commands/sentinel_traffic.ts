/** Ingest bounded HTTP and DNS observations from trusted collectors. */
import { dirname } from "@std/path";
import { readSentinelChatSnapshot } from "../../sentinel/chat_mode.ts";
import { importSentinelSuricataDns } from "../../sentinel/feed_adapters.ts";
import { loadSentinelGraph } from "../../sentinel/graph.ts";
import {
  importSentinelHar,
  importSentinelSuricataHttp,
  importSentinelZeekHttp,
} from "../../sentinel/har.ts";
import { mergeSentinelSnapshots } from "../../sentinel/merge.ts";
import {
  importSentinelDnsObservation,
  importSentinelZeekDns,
} from "../../sentinel/passive_dns.ts";
import { sentinelDnsPath, sentinelTrafficPath } from "../../sentinel/paths.ts";
import { publishSentinelInput } from "../../sentinel/published_input.ts";
import { readJsonLines } from "./sentinel_telemetry.ts";

type Snapshot = ReturnType<typeof importSentinelHar>["snapshot"];

async function appendTrafficEvidence(
  output: string,
  snapshot: Snapshot,
  evidenceId: string,
  limit: number,
) {
  await Deno.mkdir(dirname(output), { mode: 0o700, recursive: true });
  using lock = await Deno.open(`${output}.lock`, {
    create: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(true);
  const raw = await readSentinelChatSnapshot(output).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (raw === undefined) {
    await publishSentinelInput(output, snapshot);
    return;
  }
  const previous = loadSentinelGraph(raw).snapshot();
  if (previous.nodes.some(({ id }) => id === evidenceId)) return;

  const retained = [
    ...previous.nodes.filter(({ kind }) => kind === "evidence").map(({ id }) =>
      id
    ),
    evidenceId,
  ].slice(-limit);
  const evidence = new Set(retained);
  const merged = mergeSentinelSnapshots([previous, snapshot]);
  const assets = new Map<string, Set<string>>();
  for (const { from, to, relation } of merged.edges) {
    if (relation !== "observed_on" || !evidence.has(from)) continue;
    const sources = assets.get(to) ?? new Set<string>();
    sources.add(from);
    assets.set(to, sources);
  }
  const nodes = new Map(merged.nodes.map((node) => [node.id, node]));
  await publishSentinelInput(output, {
    version: 1,
    // Keep evidence in publication order so future writers can trim the same window.
    nodes: [
      ...merged.nodes.filter(({ id }) => assets.has(id)),
      ...retained.map((id) => nodes.get(id)!),
    ],
    edges: merged.edges.filter(({ from, to, relation }) => {
      if (relation === "observed_on") return evidence.has(from);
      if (relation !== "resolved_to") return false;
      const sources = assets.get(from);
      const targets = assets.get(to);
      return sources && targets && [...sources].some((id) => targets.has(id));
    }),
  });
}

class TrafficPublishError extends Error {}

type TrafficFormat =
  | "har"
  | "dns"
  | "zeek-dns"
  | "zeek-http"
  | "suricata-dns"
  | "suricata-http";

function decodeTrafficEntry(
  entry: unknown,
  source: string,
  format: Exclude<TrafficFormat, "suricata-dns">,
) {
  switch (format) {
    case "suricata-http":
      return importSentinelSuricataHttp(entry, source);
    case "zeek-http":
      return importSentinelZeekHttp(entry, source);
    case "zeek-dns":
      return importSentinelZeekDns(entry, source);
    case "dns":
      return importSentinelDnsObservation(entry, source);
    default: {
      const { snapshot, observations } = importSentinelHar({
        log: { version: "1.2", entries: [entry] },
      }, source);
      return { snapshot, observation: observations[0] };
    }
  }
}

export async function ingestSentinelTraffic(
  stream: ReadableStream<Uint8Array>,
  source: string,
  snapshotPath?: string,
  format: TrafficFormat = "har",
): Promise<void> {
  const http = format === "har" || format === "zeek-http" ||
    format === "suricata-http";
  const output = snapshotPath
    ? (http ? sentinelTrafficPath : sentinelDnsPath)(snapshotPath)
    : undefined;
  await readJsonLines(stream, async (entry) => {
    const observations = format === "suricata-dns"
      ? importSentinelSuricataDns(entry, source)
      : [decodeTrafficEntry(entry, source, format)];
    for (const captured of observations) {
      if (!captured?.observation) continue;
      const { snapshot, observation } = captured;
      if (output) {
        try {
          await appendTrafficEvidence(
            output,
            snapshot,
            observation.evidenceId,
            http ? 100 : 50,
          );
        } catch (cause) {
          throw new TrafficPublishError(
            "Could not publish Sentinel traffic evidence",
            { cause },
          );
        }
      }
      console.log(JSON.stringify(observation));
    }
  }, (line, message, cause) => {
    if (cause instanceof TrafficPublishError) throw cause;
    console.error(JSON.stringify({ type: "traffic_error", line, message }));
  });
}
