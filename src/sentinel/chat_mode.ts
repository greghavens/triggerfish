/** Deterministic, read-only Sentinel commands for an authorized chat session. */

import type { buildSentinelProvenance } from "./provenance.ts";
import { loadSentinelGraph, type SentinelPathDirection } from "./graph.ts";

import {
  type SentinelReportLanguage,
  sentinelReportText,
} from "./report_language.ts";

export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_RESPONSE_LENGTH = 12000;
const MAX_CHAT_DEPTH = 10;
function sentinelHelp(t: ReturnType<typeof sentinelReportText>): string {
  return [
    t("Sentinel commands"),
    `report — ${t("List ranked findings")}`,
    `coverage — ${t("Show evidence and mitigation links")}`,
    `impact NODE [DEPTH] — ${t("Show dependent assets")}`,
    `trace NODE [DEPTH] — ${t("Walk linked graph records")}`,
    `path FROM TO [DEPTH] [both|outgoing|incoming] [--relation TYPE] [--limit N] — ${
      t("Find the shortest relationship path")
    }`,
    `path --provenance [--revision N] FROM TO [DEPTH] [DIRECTION] [--relation TYPE] [--limit N] — ${
      t("Trace saved assessment relationships")
    }`,
    `provenance find|show [--revision N] [--offset N] [--limit N] [TEXT_OR_ID] — ${
      t("Search or inspect saved graph records")
    }`,
    `assessment start/status/observations/history/stop — ${
      t("Coordinate an assessment")
    }`,
    `/sentinel case [CASE] — ${t("Show or select the assessment case")}`,
    `/sentinel status — ${t("Show session mode")}`,
    `/sentinel off — ${t("Return to normal chat")}`,
  ].join("\n");
}

export interface SentinelChatTurn {
  readonly enabled: boolean;
  readonly response: string;
}

/** Read a bounded JSON snapshot from a path supplied by the operator. */
export async function readSentinelChatSnapshot(path: string): Promise<unknown> {
  const info = await Deno.stat(path);
  if (!info.isFile || info.size > MAX_SNAPSHOT_BYTES) {
    throw new Error("Sentinel snapshot must be a regular file up to 1 MiB");
  }
  using file = await Deno.open(path, { read: true });
  const bytes = new Uint8Array(MAX_SNAPSHOT_BYTES + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = await file.read(bytes.subarray(length));
    if (count === null) break;
    length += count;
  }
  if (length === bytes.length) {
    throw new Error("Sentinel snapshot exceeds 1 MiB");
  }
  const json = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, length));
  return JSON.parse(json);
}

type Query =
  | { readonly name: "report" | "coverage" }
  | {
    readonly name: "impact" | "trace";
    readonly id: string;
    readonly depth: number;
  }
  | {
    readonly name: "path";
    readonly from: string;
    readonly to: string;
    readonly depth: number;
    readonly direction: SentinelPathDirection;
    readonly relation?: string;
    readonly limit?: number;
    readonly provenance: boolean;
    readonly revision?: number;
  }
  | {
    readonly name: "find_provenance" | "show_provenance";
    readonly text: string;
    readonly revision?: number;
    readonly offset: number;
    readonly limit: number;
  };

function parseNodeId(token: string): string | undefined {
  try {
    const id = token.startsWith('"') ? JSON.parse(token) as string : token;
    return id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

function parseQuery(input: string): Query | undefined {
  if (input === "report" || input === "coverage") return { name: input };
  const provenanceLookup =
    /^provenance\s+(find|show)(?:\s+--revision\s+(\d+))?(?:\s+--offset\s+(\d+))?(?:\s+--limit\s+(\d+))?(?:\s+("(?:[^"\\]|\\.)*"|[^"\s]+))?$/
      .exec(input);
  if (provenanceLookup) {
    const [, action, revisionText, offsetText = "0", limitText = "5", token] =
      provenanceLookup;
    const revision = revisionText === undefined
      ? undefined
      : Number(revisionText);
    const offset = Number(offsetText);
    const limit = Number(limitText);
    const text = token === undefined ? "" : parseNodeId(token);
    if (
      text === undefined || (action === "show" && !text) ||
      text.length > (action === "show" ? 4096 : 256) ||
      !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 20 ||
      (revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 1))
    ) return undefined;
    return {
      name: action === "find" ? "find_provenance" : "show_provenance",
      text,
      revision,
      offset,
      limit,
    };
  }
  const path =
    /^path\s+(?:(--provenance)(?:\s+--revision\s+(\d+))?\s+)?("(?:[^"\\]|\\.)*"|[^"\s]+)\s+("(?:[^"\\]|\\.)*"|[^"\s]+)(?:\s+(\d+))?(?:\s+(both|outgoing|incoming))?(?:\s+--relation\s+([a-z_]{1,40}(?:,[a-z_]{1,40}){0,15}))?(?:\s+--limit\s+([1-9]|10))?$/
      .exec(input);
  if (path) {
    const [
      ,
      provenance,
      revisionText,
      fromToken,
      toToken,
      depthText = "2",
      direction = "both",
      relation,
      limit,
    ] = path;
    const revision = revisionText === undefined
      ? undefined
      : Number(revisionText);
    const from = parseNodeId(fromToken);
    const to = parseNodeId(toToken);
    const depth = Number(depthText);
    if (
      !from || !to || depth > MAX_CHAT_DEPTH ||
      (revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 1))
    ) return undefined;
    return {
      name: "path",
      from,
      to,
      depth,
      direction: direction as SentinelPathDirection,
      relation,
      limit: limit === undefined ? undefined : Number(limit),
      provenance: provenance !== undefined,
      revision,
    };
  }
  const match = /^(impact|trace)\s+("(?:[^"\\]|\\.)*"|[^"\s]+)(?:\s+(\d+))?$/
    .exec(input);
  if (!match) return undefined;
  const [, name, token, depthText = "2"] = match;
  const depth = Number(depthText);
  if (depth > MAX_CHAT_DEPTH) return undefined;

  const id = parseNodeId(token);
  if (!id) return undefined;
  return { name: name === "impact" ? "impact" : "trace", id, depth };
}

export function formatSentinelChatResult(
  value: unknown,
  language: SentinelReportLanguage = "en",
): string {
  // Keep graph labels inert in Markdown-rendering chat clients.
  const json = JSON.stringify(value, null, 2).replace(
    /[`<>&]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  if (json.length > MAX_RESPONSE_LENGTH) {
    return sentinelReportText(language)(
      "The result exceeds the chat output limit. Use a smaller trace depth or the Sentinel CLI to view it.",
    );
  }
  return "```json\n" + json + "\n```";
}

/** Return undefined for ordinary chat turns while Sentinel is off. */
export async function handleSentinelChatTurn(
  input: string,
  enabled: boolean,
  readSnapshot: () => Promise<unknown>,
  readProvenance?: (revision?: number) => Promise<
    {
      readonly revision: number;
      readonly graph: ReturnType<typeof buildSentinelProvenance>;
    } | undefined
  >,
  language: SentinelReportLanguage = "en",
): Promise<SentinelChatTurn | undefined> {
  const t = sentinelReportText(language);
  const format = (value: unknown) => formatSentinelChatResult(value, language);
  const text = input.trim();
  const command =
    enabled && /^\/sentinel\s+(?:path|provenance)(?:\s|$)/.test(text)
      ? text.slice("/sentinel".length).trimStart()
      : text;
  if (/^\/sentinel(?:\s|$)/.test(command)) {
    const [, action = enabled ? "off" : "on", ...rest] = command.split(/\s+/);
    if (rest.length === 0) {
      if (action === "on") return { enabled: true, response: sentinelHelp(t) };
      if (action === "off") {
        return { enabled: false, response: t("Sentinel mode is off.") };
      }
      if (action === "status") {
        return {
          enabled,
          response: t(
            enabled ? "Sentinel mode is on." : "Sentinel mode is off.",
          ),
        };
      }
    }
    return {
      enabled,
      response: t("Use /sentinel on, /sentinel off, or /sentinel status."),
    };
  }

  if (!enabled) return undefined;
  if (command === "help") return { enabled, response: sentinelHelp(t) };
  const query = parseQuery(command);
  if (!query) {
    return {
      enabled,
      response: `${
        t("Enter a Sentinel command. Chat depth is 0–{depth}.", {
          depth: MAX_CHAT_DEPTH,
        })
      }\n\n${sentinelHelp(t)}`,
    };
  }

  if (
    query.name === "find_provenance" || query.name === "show_provenance" ||
    (query.name === "path" && query.provenance)
  ) {
    try {
      const saved = await readProvenance?.(query.revision);
      if (!saved) {
        return {
          enabled,
          response: t(
            "The requested Sentinel assessment revision is unavailable.",
          ),
        };
      }
      if ("text" in query) {
        const { offset, limit } = query;
        if (query.name === "find_provenance") {
          const matches = saved.graph.searchNodes(query.text);
          const nodes = matches.slice(offset, offset + limit);
          const next = offset + nodes.length;
          return {
            enabled,
            response: format({
              revision: saved.revision,
              totalNodes: matches.length,
              offset,
              nextOffset: next < matches.length ? next : null,
              nodes,
            }),
          };
        }
        const record = saved.graph.inspect(query.text);
        if (!record) {
          return {
            enabled,
            response: t("The requested provenance node is unavailable."),
          };
        }
        const connections = record.connections.slice(offset, offset + limit);
        const next = offset + connections.length;
        return {
          enabled,
          response: format({
            revision: saved.revision,
            node: record.node,
            offset,
            totalConnections: record.connections.length,
            nextOffset: next < record.connections.length ? next : null,
            connections,
          }),
        };
      }
      if (query.limit !== undefined) {
        return {
          enabled,
          response: format({
            revision: saved.revision,
            ...saved.graph.alternatePaths(
              query.from,
              query.to,
              query.depth,
              query.direction,
              query.relation,
              query.limit,
            ),
          }),
        };
      }
      const path = saved.graph.shortestPath(
        query.from,
        query.to,
        query.depth,
        query.direction,
        query.relation,
      );
      return {
        enabled,
        response: format({ revision: saved.revision, path }),
      };
    } catch {
      return {
        enabled,
        response: t(
          "The requested Sentinel provenance or path endpoint is unavailable.",
        ),
      };
    }
  }

  let graph: ReturnType<typeof loadSentinelGraph>;
  try {
    graph = loadSentinelGraph(await readSnapshot());
  } catch {
    return {
      enabled,
      response: t(
        "The operator-managed Sentinel snapshot is unavailable or invalid.",
      ),
    };
  }

  if (query.name === "report") {
    return {
      enabled,
      response: format({ findings: graph.report() }),
    };
  }
  if (query.name === "coverage") {
    return {
      enabled,
      response: format(
        graph.coverage(
          graph.snapshot().edges.some(({ relation }) => relation === "verifies")
            ? new Date().toISOString()
            : undefined,
        ),
      ),
    };
  }

  if (query.name === "path") {
    try {
      if (query.limit !== undefined) {
        return {
          enabled,
          response: format(
            graph.alternatePaths(
              query.from,
              query.to,
              query.depth,
              query.direction,
              query.relation,
              query.limit,
            ),
          ),
        };
      }
      const path = graph.shortestPath(
        query.from,
        query.to,
        query.depth,
        query.direction,
        query.relation,
      );
      return { enabled, response: format({ path }) };
    } catch {
      return {
        enabled,
        response: t("A requested graph endpoint is unavailable."),
      };
    }
  }

  if ("id" in query) {
    try {
      const result = query.name === "impact"
        ? graph.impact(query.id, query.depth)
        : graph.trace(query.id, query.depth);
      return { enabled, response: format(result) };
    } catch {
      return {
        enabled,
        response: t("The requested node is unavailable for that query."),
      };
    }
  }
  return { enabled, response: sentinelHelp(t) };
}
