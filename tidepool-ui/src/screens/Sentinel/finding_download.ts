/** Assemble one finding report from responses for the same retained manifest. */
export type FindingDownloadFormat = "csv" | "findings-json";

type FindingDownloadSelection =
  | { readonly findingFilter: Record<string, unknown> }
  | { readonly findingIds: readonly string[] };

type FindingDownloadRequest = FindingDownloadSelection & {
  readonly revision: number;
  readonly format: FindingDownloadFormat;
  readonly findingPageSize?: number;
  readonly findingCursor?: string;
};

type FindingDownloadResult =
  | { readonly request: FindingDownloadRequest }
  | { readonly content: readonly string[] }
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
) {
  const initial = { revision, format, ...selection };
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
    : `{"version":1,"caseId":${
      JSON.stringify(caseId)
    },"revision":${revision},"findings":[`;
  const footer = format === "csv" ? "" : "]}\n";
  const pieces = [header];
  let bytes = encoder.encode(header + footer).byteLength;
  const next = () => ({
    request: {
      ...initial,
      findingPageSize: pageSize,
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

    let piece: string;
    if (format === "csv") {
      if (!content.startsWith(csvHeader) || !content.endsWith("\r\n")) {
        return reject();
      }
      piece = content.slice(csvHeader.length);
      if (countCsvRecords(piece) !== end - offset) return reject();
    } else {
      try {
        const body = JSON.parse(content);
        if (
          body?.version !== 1 || body.caseId !== caseId ||
          body.revision !== revision ||
          !Array.isArray(body.findings) || body.findings.length !== end - offset
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
    offset = end;
    if (expected !== null) {
      cursor = expected;
      return next();
    }
    finished = true;
    return { content: [...pieces, footer] };
  }

  return { initial, accept };
}
