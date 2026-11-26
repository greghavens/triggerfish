/** Assemble one finding report from responses for the same retained manifest. */
import {
  encodeSentinelFindingZip,
  SENTINEL_FINDING_ZIP_END_BYTES,
  sentinelFindingZipEntryBytes,
} from "../../../../src/sentinel/finding_export_zip.ts";

export type FindingDownloadFormat =
  | "csv"
  | "findings-json"
  | "markdown"
  | "md-zip";
type FindingDownloadLanguage = "en" | "es" | "ko" | "zh" | "ja";

type FindingDownloadSelection =
  | { readonly findingFilter: Record<string, unknown> }
  | { readonly findingIds: readonly string[] };

type FindingDownloadRequest = FindingDownloadSelection & {
  readonly revision: number;
  readonly format: FindingDownloadFormat;
  readonly language?: FindingDownloadLanguage;
  readonly findingZipEntries?: true;
  readonly findingPageSize?: number;
  readonly findingCursor?: string;
};

type FindingDownloadResult =
  | { readonly request: FindingDownloadRequest }
  | { readonly content: readonly (string | ArrayBuffer)[] }
  | { readonly error: string };

const maxBytes = 8 * 1024 * 1024;
const maxFindings = 4096;
const csvHeader =
  '"case_id","evidence_revision","finding_id","title","exact_record"\r\n';
const failed = {
  error: "The findings download could not be completed. Start a new export.",
} as const;

function countCsvRecords(content: string): number | undefined {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    // Escaped quotes arrive as a pair, restoring the current state.
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "\r" && content[index + 1] === "\n") {
      count++;
      index++;
    }
  }
  return quoted ? undefined : count;
}

export function createFindingDownload(
  caseId: string,
  revision: number,
  format: FindingDownloadFormat,
  selection: FindingDownloadSelection,
  language?: FindingDownloadLanguage,
) {
  const initial = {
    revision,
    format,
    ...selection,
    ...(language && { language }),
  };
  let pageSize: number | undefined;
  let digest: string | undefined;
  let total: number | undefined;
  let offset = 0;
  let cursor: string | undefined;
  let finished = false;
  const ids = new Set<string>();
  const encoder = new TextEncoder();
  const header = format === "csv"
    ? csvHeader
    : format === "findings-json"
    ? `{"version":1,"caseId":${
      JSON.stringify(caseId)
    },"revision":${revision},"findings":[`
    : "";
  const footer = format === "findings-json" ? "]}\n" : "";
  const pieces: string[] = header ? [header] : [];
  let markdownHeader: string | undefined;
  let bytes = format === "md-zip"
    ? SENTINEL_FINDING_ZIP_END_BYTES
    : encoder.encode(header + footer).byteLength;
  const next = () => ({
    request: {
      ...initial,
      findingPageSize: pageSize,
      ...(format === "md-zip" && { findingZipEntries: true as const }),
      ...(cursor !== undefined && { findingCursor: cursor }),
    },
  });

  function reject(): FindingDownloadResult {
    finished = true;
    return failed;
  }

  function accept(message: Record<string, unknown>): FindingDownloadResult {
    if (
      finished || message.caseId !== caseId || message.revision !== revision ||
      message.format !== format
    ) return reject();
    if (
      message.type === "error" && message.code === "finding_export_byte_limit"
    ) {
      if (pageSize === 1) return reject();
      pageSize = pageSize === undefined ? 16 : Math.floor(pageSize / 2);
      return next();
    }
    if (message.type !== "export" || typeof message.content !== "string") {
      return reject();
    }
    const { content } = message;
    if (pageSize === undefined) {
      if (
        message.findingPage !== undefined ||
        encoder.encode(content).byteLength > maxBytes
      ) return reject();
      if (format === "md-zip") {
        if (message.encoding !== "base64") return reject();
        try {
          const zip = Uint8Array.from(
            atob(content),
            (char) => char.charCodeAt(0),
          );
          if (zip.byteLength > maxBytes) return reject();
          finished = true;
          return { content: [zip.buffer] };
        } catch {
          return reject();
        }
      }
      finished = true;
      return { content: [content] };
    }
    const page = message.findingPage as Record<string, unknown> | undefined;
    if (
      !page || typeof page.manifestDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(page.manifestDigest) ||
      typeof page.total !== "number" || !Number.isInteger(page.total) ||
      page.total > maxFindings || page.total < offset ||
      page.offset !== offset ||
      page.count !== Math.min(pageSize, page.total - offset) ||
      (digest && digest !== page.manifestDigest) ||
      (total !== undefined && total !== page.total)
    ) return reject();
    digest = page.manifestDigest;
    total = page.total;
    const end = Math.min(offset + pageSize, total);
    const expected = end === total ? null : `finding-export:${digest}:${end}`;
    if (page.nextCursor !== expected) return reject();

    if (format === "md-zip") {
      if (message.encoding !== "markdown-entries") return reject();
      try {
        const entries = JSON.parse(content);
        if (
          !Array.isArray(entries) || entries.length !== end - offset ||
          entries.some((entry) => typeof entry !== "string" || !entry)
        ) return reject();
        for (const [index, entry] of entries.entries()) {
          bytes += sentinelFindingZipEntryBytes(
            offset + index,
            encoder.encode(entry).byteLength,
          );
          if (bytes > maxBytes) return reject();
          pieces.push(entry);
        }
      } catch {
        return reject();
      }
    } else {
      let piece: string;
      if (format === "csv") {
        if (!content.startsWith(csvHeader) || !content.endsWith("\r\n")) {
          return reject();
        }
        piece = content.slice(csvHeader.length);
        if (countCsvRecords(piece) !== end - offset) return reject();
      } else if (format === "markdown") {
        const lines = content.split("\n", 4);
        if (
          lines.length !== 4 || !lines[0].startsWith("# ") || lines[1] !== "" ||
          !lines[2].startsWith("- ") || !lines[3].startsWith("- ")
        ) return reject();
        const prelude = lines.join("\n") + "\n";
        if (
          !content.startsWith(prelude) ||
          (markdownHeader && markdownHeader !== prelude)
        ) return reject();
        piece = content.slice(prelude.length);
        if ([...piece.matchAll(/^## /gm)].length !== end - offset) {
          return reject();
        }
        if (!markdownHeader) {
          markdownHeader = prelude;
          bytes += encoder.encode(prelude).byteLength;
          pieces.push(prelude);
        }
      } else {
        try {
          const body = JSON.parse(content);
          if (
            body?.version !== 1 || body.caseId !== caseId ||
            body.revision !== revision ||
            !Array.isArray(body.findings) ||
            body.findings.length !== end - offset
          ) return reject();
          const records: string[] = [];
          for (const finding of body.findings) {
            if (
              typeof finding?.id !== "string" || !finding.id ||
              ids.has(finding.id)
            ) return reject();
            ids.add(finding.id);
            records.push(JSON.stringify(finding));
          }
          piece = (offset > 0 && records.length ? "," : "") + records.join(",");
        } catch {
          return reject();
        }
      }
      bytes += encoder.encode(piece).byteLength;
      if (bytes > maxBytes) return reject();
      pieces.push(piece);
    }
    offset = end;
    if (expected !== null) {
      cursor = expected;
      return next();
    }
    if (format === "md-zip") {
      const zip = encodeSentinelFindingZip(pieces, maxBytes);
      if (!zip) return reject();
      finished = true;
      return { content: [zip] };
    }
    finished = true;
    return { content: [...pieces, footer] };
  }

  return { initial, accept };
}
