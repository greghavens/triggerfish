/** Assemble an exact retained attachment only after the entire body verifies. */
export type TrafficDownloadSelection = {
  readonly caseId: string;
  readonly revision: number;
  readonly currentRevision: number;
  readonly findingId: string;
  readonly trafficLinkId: string;
  readonly payloadPart: "headers" | "request" | "response";
};

type Selection = Omit<TrafficDownloadSelection, "caseId">;
export type TrafficDownloadRequest = Selection & { readonly offset: number };

const maxBytes = 64 * 1024;
const pageBytes = 1024;
const failed = {
  error: "The retained traffic download could not be verified.",
} as const;
const descriptorKey = {
  headers: "headersPayload",
  request: "requestPayload",
  response: "responsePayload",
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Bind an authenticated page to the exact stored payload descriptors. */
export function trafficDownloadProof(
  selection: TrafficDownloadSelection,
  message: Record<string, unknown>,
  trafficDigest: string,
  runId: string,
) {
  const page = record(message.page);
  const link = record(page?.link);
  const payload = record(page?.payload);
  const descriptor = record(payload?.[descriptorKey[selection.payloadPart]]);
  if (
    message.type !== "finding_traffic_download_page" ||
    message.caseId !== selection.caseId || message.revision !== selection.revision ||
    message.payloadPart !== selection.payloadPart ||
    page?.currentRevision !== selection.currentRevision ||
    page.runId !== runId || typeof page.scopeVersion !== "number" ||
    link?.caseId !== selection.caseId || link.evidenceRevision !== selection.revision ||
    link.findingId !== selection.findingId || link.id !== selection.trafficLinkId ||
    link.trafficDigest !== trafficDigest || payload?.offset !== 0 ||
    !descriptor || typeof descriptor.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) return;
  return {
    binding: JSON.stringify([page.runId, page.scopeVersion, trafficDigest, descriptor]),
    sha256: descriptor.sha256,
  };
}

export function createTrafficDownload(selection: TrafficDownloadSelection) {
  const { caseId, ...request } = selection;
  const initial = { ...request, offset: 0 };
  const encoder = new TextEncoder();
  let anchor: string | undefined;
  let body: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  let finished = false;
  return {
    initial,
    async accept(message: Record<string, unknown>): Promise<
      | { readonly request: TrafficDownloadRequest }
      | { readonly content: ArrayBuffer }
      | typeof failed
    > {
      const reject = () => {
        body = undefined;
        finished = true;
        return failed;
      };
      if (
        finished || message.type !== "finding_traffic_download_page" ||
        message.caseId !== caseId || message.revision !== request.revision ||
        message.payloadPart !== request.payloadPart
      ) return reject();
      const page = record(message.page);
      const link = record(page?.link);
      const payload = record(page?.payload);
      const descriptor = record(payload?.[descriptorKey[request.payloadPart]]);
      const size = descriptor?.byteLength;
      const sha256 = descriptor?.sha256;
      const encoding = descriptor?.encoding;
      if (
        !page || !link || !payload ||
        page.currentRevision !== request.currentRevision ||
        typeof page.runId !== "string" ||
        typeof page.scopeVersion !== "number" || !Number.isSafeInteger(page.scopeVersion) ||
        page.scopeVersion < 0 ||
        link.id !== request.trafficLinkId ||
        link.findingId !== request.findingId ||
        link.caseId !== caseId || link.evidenceRevision !== request.revision ||
        typeof link.trafficDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(link.trafficDigest) ||
        payload.offsetUnit !== "bytes" || payload.offset !== offset ||
        typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 ||
        size > maxBytes ||
        typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
        (encoding !== "utf-8" && encoding !== "base64")
      ) return reject();
      const binding = JSON.stringify([
        page.runId,
        page.scopeVersion,
        link.trafficDigest,
        encoding,
        size,
        sha256,
      ]);
      if (anchor !== undefined && anchor !== binding) return reject();
      anchor = binding;
      body ??= new Uint8Array(size);
      let bytes: Uint8Array;
      if (encoding === "utf-8") {
        if (
          typeof payload.text !== "string" || !payload.text.isWellFormed() ||
          payload.text.length > pageBytes || payload.base64 !== undefined
        ) return reject();
        bytes = encoder.encode(payload.text);
      } else {
        if (
          typeof payload.base64 !== "string" || payload.base64.length > 1368 ||
          payload.text !== undefined
        ) return reject();
        try {
          const raw = atob(payload.base64);
          if (btoa(raw) !== payload.base64) return reject();
          bytes = Uint8Array.from(raw, (item) => item.charCodeAt(0));
        } catch {
          return reject();
        }
      }
      const end = offset + bytes.length;
      if (
        bytes.length > pageBytes || end > size ||
        (end < size
          ? !bytes.length || payload.nextOffset !== end
          : payload.nextOffset !== null)
      ) {
        return reject();
      }
      body.set(bytes, offset);
      offset = end;
      if (end < size) return { request: { ...request, offset: end } };

      finished = true;
      const content = body.buffer;
      body = undefined;
      try {
        const digest = await crypto.subtle.digest("SHA-256", content);
        const actual = Array.from(
          new Uint8Array(digest),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
        return actual === sha256 ? { content } : failed;
      } catch {
        return failed;
      }
    },
  };
}
