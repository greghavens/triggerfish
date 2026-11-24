/** Read a bounded JSON Lines feed from a security event exporter. */
import {
  createTelemetryDetector,
  normalizeSentinelTelemetryEvent,
} from "../../sentinel/telemetry.ts";

import {
  decodeSentinelFeedLine,
  type SentinelFeedFormat,
  type SentinelFeedOptions,
} from "../../sentinel/feed_adapters.ts";
import type { CefAlertSelector } from "../../sentinel/cef_adapter.ts";
import { createSentinelIndicatorDetector } from "../../sentinel/indicators.ts";

export type SentinelArchiveEncoding = "json" | "gzip";

const MAX_EVENT_BYTES = 64 * 1024;

export async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onRecord: (record: unknown, bytes: number) => void | Promise<void>,
  onError: (line: number, message: string, cause: unknown) => void,
  format: SentinelFeedFormat = "jsonl",
  source?: string,
  selectors?: readonly CefAlertSelector[],
  options?: SentinelFeedOptions,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = new Uint8Array(MAX_EVENT_BYTES);
  let length = 0;
  let oversized = false;
  let line = 0;

  async function emitLine() {
    line++;
    try {
      if (oversized) throw new Error("JSON line exceeds 64 KiB");
      const text = decoder.decode(buffer.subarray(0, length)).trim();
      if (text.length === 0) return;
      for (
        const event of decodeSentinelFeedLine(
          text,
          format,
          source,
          selectors,
          options,
        )
      ) {
        await onRecord(event, length);
      }
    } catch (error) {
      onError(
        line,
        error instanceof Error ? error.message : "Invalid record",
        error,
      );
    }
  }

  for await (const chunk of stream) {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!oversized) {
        const bytes = chunk.subarray(start, end);
        if (length + bytes.length > buffer.length) oversized = true;
        else {
          buffer.set(bytes, length);
          length += bytes.length;
        }
      }
      if (newline === -1) break;
      await emitLine();
      length = 0;
      oversized = false;
      start = end + 1;
    }
  }

  if (length || oversized) await emitLine();
}

async function readTelemetryFeed(
  stream: ReadableStream<Uint8Array>,
  onRecord: (record: unknown, bytes: number) => void | Promise<void>,
  onError: (line: number, message: string, cause: unknown) => void,
  format: SentinelFeedFormat,
  source?: string,
  selectors?: readonly CefAlertSelector[],
  archiveEncoding?: SentinelArchiveEncoding,
  options?: SentinelFeedOptions,
) {
  if (!archiveEncoding) {
    return await readJsonLines(
      stream,
      onRecord,
      onError,
      format,
      source,
      selectors,
      options,
    );
  }
  if (format !== "cloudtrail") throw new Error("Expected a CloudTrail archive");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  const input = archiveEncoding === "gzip"
    ? (stream as ReadableStream<BufferSource>).pipeThrough(
      new DecompressionStream("gzip"),
    )
    : stream;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) {
      throw new Error(
        "CloudTrail archive exceeds the 16 MiB uncompressed limit",
      );
    }
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
  for (
    const event of decodeSentinelFeedLine(
      chunks.join(""),
      format,
      source,
      selectors,
    )
  ) {
    await onRecord(event, size);
  }
}

export async function ingestSentinelTelemetry(
  stream: ReadableStream<Uint8Array>,
  format: SentinelFeedFormat,
  source?: string,
  selectors?: readonly CefAlertSelector[],
  publishPath?: string,
  archiveEncoding?: SentinelArchiveEncoding,
  options?: SentinelFeedOptions,
): Promise<void> {
  const detector = createTelemetryDetector();
  const publisher = publishPath
    ? await (await import("./sentinel_publish.ts"))
      .createLiveSentinelAlertPublisher(publishPath)
    : undefined;
  try {
    await readTelemetryFeed(
      stream,
      async (record) => {
        for (const alert of detector.ingest(record)) {
          if (!publisher || publisher.append(alert)) {
            console.log(JSON.stringify(alert));
          }
          const batch = publisher?.flushWhenFull();
          if (batch) await batch;
        }
      },
      (line, message) => {
        console.error(
          JSON.stringify({ type: "telemetry_error", line, message }),
        );
      },
      format,
      source,
      selectors,
      archiveEncoding,
      options,
    );
  } finally {
    await publisher?.finish();
  }
}

export async function readSentinelAlerts(
  stream: ReadableStream<Uint8Array>,
): Promise<unknown[]> {
  const records: unknown[] = [];
  let bytes = 0;
  await readJsonLines(stream, (record, size) => {
    bytes += size;
    if (records.length >= 10_000 || bytes > 16 * 1024 * 1024) {
      throw new Error("Case alert limit exceeded");
    }
    records.push(record);
  }, (line, message) => {
    throw new Error(`Alert line ${line}: ${message}`);
  });
  return records;
}

export async function ingestSentinelIndicators(
  stream: ReadableStream<Uint8Array>,
  rules: unknown,
): Promise<void> {
  const detector = createSentinelIndicatorDetector(rules);
  await readJsonLines(stream, (record) => {
    for (const alert of detector.ingest(record)) {
      console.log(JSON.stringify(alert));
    }
  }, (line, message) => {
    console.error(JSON.stringify({ type: "indicator_error", line, message }));
  });
}

export async function normalizeSentinelTelemetry(
  stream: ReadableStream<Uint8Array>,
  format: SentinelFeedFormat,
  source?: string,
  selectors?: readonly CefAlertSelector[],
  archiveEncoding?: SentinelArchiveEncoding,
  options?: SentinelFeedOptions,
): Promise<void> {
  await readTelemetryFeed(
    stream,
    (record) => {
      console.log(JSON.stringify(normalizeSentinelTelemetryEvent(record)));
    },
    (line, message) => {
      console.error(JSON.stringify({ type: "telemetry_error", line, message }));
    },
    format,
    source,
    selectors,
    archiveEncoding,
    options,
  );
}
