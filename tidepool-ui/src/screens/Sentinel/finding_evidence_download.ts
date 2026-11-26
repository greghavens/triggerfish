/** Build an inert ZIP from one manifest and currently authorized retained pages. */
import {
  encodeSentinelFindingZip,
  type SentinelFindingZipRecord,
} from "../../../../src/sentinel/finding_export_zip.ts";
import {
  createTrafficDownload,
  trafficDownloadProof,
  type TrafficDownloadRequest,
  type TrafficDownloadSelection,
} from "./traffic_download.ts";

const unavailable = {
  error: "The finding evidence archive could not be verified.",
} as const;
const maxFileBytes = 8 * 1024 * 1024;
const maxAttachments = 8;

export function createFindingEvidenceDownload(
  scope: Omit<TrafficDownloadSelection, "trafficLinkId">,
) {
  const initial = {
    revision: scope.revision,
    findingIds: [scope.findingId],
    format: "md-zip",
    findingPageSize: 1,
    findingZipEntries: true,
  } as const;
  const exportRequest = { topic: "export", request: initial } as const;
  const trafficRequest = (
    request: TrafficDownloadRequest,
  ) => ({ topic: "finding_traffic_download_page", request } as const);
  type Part = {
    index: number;
    selection: TrafficDownloadSelection;
    trafficDigest: string;
    runId: string;
    proof?: NonNullable<ReturnType<typeof trafficDownloadProof>>;
    bytes?: ArrayBuffer;
  };
  const parts: Part[] = [];
  let manifest: Record<string, unknown> | undefined;
  let archive: SentinelFindingZipRecord | undefined;
  let phase: "manifest" | "payload" | "recheck" | "final" | "finished" =
    "manifest";
  let position = 0;
  let download: ReturnType<typeof createTrafficDownload> | undefined;

  function reject() {
    phase = "finished";
    parts.length = 0;
    archive = undefined;
    return unavailable;
  }

  function begin(part: Part) {
    download = createTrafficDownload(part.selection);
    return trafficRequest(download.initial);
  }

  return {
    initial,
    async accept(message: Record<string, unknown>) {
      if (phase === "finished") return unavailable;
      if (phase === "manifest" || phase === "final") {
        const page = message.findingPage as Record<string, unknown> | undefined;
        if (
          message.type !== "export" || message.caseId !== scope.caseId ||
          message.revision !== scope.revision || message.format !== "md-zip" ||
          message.encoding !== "finding-zip-entries-v2" ||
          typeof message.content !== "string" ||
          page?.offset !== 0 || page.total !== 1 || page.count !== 1 ||
          page.nextCursor !== null || typeof page.manifestDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(page.manifestDigest)
        ) return reject();
        if (phase === "final") {
          if (
            !manifest || !archive || manifest.digest !== page.manifestDigest ||
            manifest.content !== message.content
          ) return reject();
          const manifests = archive.manifests.map((manifest, index) => {
            const selected = parts.find((part) => part.index === index);
            return selected?.proof && selected.bytes
              ? JSON.stringify(
                {
                  ...JSON.parse(manifest),
                  retainedPayload: {
                    part: scope.payloadPart,
                    sha256: selected.proof.sha256,
                    byteLength: selected.bytes.byteLength,
                  },
                },
                null,
                2,
              ) + "\n"
              : manifest;
          });
          const bytes = encodeSentinelFindingZip([{
            ...archive,
            manifests,
            payloads: parts.map(({ index, bytes }) => ({
              linkIndex: index,
              part: scope.payloadPart,
              bytes: bytes!,
            })),
          }], maxFileBytes);
          reject();
          return bytes ? { content: bytes } : unavailable;
        }
        try {
          const entries = JSON.parse(message.content);
          if (!Array.isArray(entries) || entries.length !== 1) return reject();
          const { markdown, manifests } = entries[0];
          if (
            typeof markdown !== "string" || !Array.isArray(manifests) ||
            manifests.length > maxAttachments
          ) return reject();
          const ids = new Set<string>();
          for (const [index, raw] of manifests.entries()) {
            if (typeof raw !== "string") return reject();
            const item = JSON.parse(raw);
            if (
              item.version !== 1 || item.caseId !== scope.caseId ||
              item.findingId !== scope.findingId ||
              item.reportRevision !== scope.revision ||
              typeof item.runId !== "string" ||
              !/^[a-f0-9-]{36}$/.test(item.runId) ||
              item.evidenceRevision !== scope.revision ||
              typeof item.linkId !== "string" ||
              !/^finding-traffic-link:[a-f0-9]{64}$/.test(item.linkId) ||
              ids.has(item.linkId) || typeof item.trafficDigest !== "string" ||
              !/^[a-f0-9]{64}$/.test(item.trafficDigest)
            ) return reject();
            ids.add(item.linkId);
            if (!item.withdrawn) {
              parts.push({
                index,
                selection: { ...scope, trafficLinkId: item.linkId },
                trafficDigest: item.trafficDigest,
                runId: item.runId,
              });
            }
          }
          if (!parts.length) return reject();
          manifest = { digest: page.manifestDigest, content: message.content };
          archive = { markdown, manifests };
          phase = "payload";
          return begin(parts[0]);
        } catch {
          return reject();
        }
      }
      const part = parts[position];
      if (!part || !download) return reject();
      if (phase === "recheck") {
        if (
          trafficDownloadProof(
            part.selection,
            message,
            part.trafficDigest,
            part.runId,
          )?.binding !==
            part.proof?.binding
        ) return reject();
        if (++position < parts.length) return begin(parts[position]);
        phase = "final";
        return exportRequest;
      }
      if (!part.proof) {
        part.proof = trafficDownloadProof(
          part.selection,
          message,
          part.trafficDigest,
          part.runId,
        );
        if (!part.proof) return reject();
      }
      const response = await download.accept(message);
      if ("error" in response) return reject();
      if ("request" in response) return trafficRequest(response.request);
      part.bytes = response.content;
      if (++position < parts.length) return begin(parts[position]);
      phase = "recheck";
      position = 0;
      return begin(parts[0]);
    },
  };
}
