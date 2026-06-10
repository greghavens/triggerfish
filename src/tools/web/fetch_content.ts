/**
 * Web fetch content streaming and extraction helpers.
 *
 * Handles HTTP response body streaming with byte limits,
 * chunk merging, Readability extraction, and HTML title parsing.
 *
 * @module
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import { safeFetchWithRedirects } from "../../core/security/safe_fetch.ts";
import type { FetchMode, FetchPageOptions } from "./fetch_types.ts";
import { MIN_READABILITY_LENGTH } from "./fetch_types.ts";

const log = createLogger("web.fetch");

/**
 * Read a ReadableStream in chunks, cancelling when totalBytes reaches maxBytes.
 * Returns collected chunks and a truncated flag.
 */
export async function consumeStreamWithLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly chunks: Uint8Array[]; readonly truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { chunks, truncated: false };
    const remaining = maxBytes - totalBytes;
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining));
      await reader.cancel();
      return { chunks, truncated: true };
    }
    chunks.push(value);
    totalBytes += value.length;
  }
}

/** Merge Uint8Array chunks into a single buffer and UTF-8 decode to string. */
export function decodeStreamChunks(
  chunks: Uint8Array[],
): { readonly text: string; readonly byteLength: number } {
  const byteLength = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(merged), byteLength };
}

/** Fetch a URL and stream the response body up to maxBytes. */
export async function fetchPageContent(
  options: FetchPageOptions,
): Promise<
  Result<
    {
      response: Response;
      rawBody: string;
      contentType: string;
      byteLength: number;
      bodyTruncated: boolean;
    },
    string
  >
> {
  const fetchResult = await safeFetchWithRedirects(
    options.url,
    {
      headers: {
        "User-Agent": options.userAgent,
        "Accept": "text/html,application/xhtml+xml,*/*",
      },
      signal: AbortSignal.timeout(options.timeout),
    },
    options.ssrfChecker,
  );
  if (!fetchResult.ok) {
    return { ok: false, error: `Fetch failed: ${fetchResult.error}` };
  }
  const response = fetchResult.value;
  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { ok: false, error: "Response body is not readable" };
  }
  let rawBody: string;
  let byteLength: number;
  let bodyTruncated: boolean;
  try {
    const { chunks, truncated } = await consumeStreamWithLimit(
      reader,
      options.maxBytes,
    );
    const decoded = decodeStreamChunks(chunks);
    rawBody = decoded.text;
    byteLength = decoded.byteLength;
    bodyTruncated = truncated;
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read response body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const contentType = response.headers.get("content-type") ?? "text/html";
  return {
    ok: true,
    value: { response, rawBody, contentType, byteLength, bodyTruncated },
  };
}

/**
 * Extract <title> from raw HTML using a simple regex.
 * Returns empty string if no title found.
 */
export function extractTitleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : "";
}

/** Extract readable content from HTML, falling back to raw on failure. */
export function extractPageContent(
  rawBody: string,
  contentType: string,
  mode: FetchMode,
): { readonly title: string; readonly content: string } {
  if (mode !== "readability" || !contentType.includes("text/html")) {
    return { title: extractTitleFromHtml(rawBody), content: rawBody };
  }
  try {
    // deno-lint-ignore no-explicit-any
    const { document } = parseHTML(rawBody) as any;
    const reader = new Readability(document);
    const article = reader.parse();
    if (
      article?.textContent &&
      article.textContent.length >= MIN_READABILITY_LENGTH
    ) {
      return { title: article.title ?? "", content: article.textContent };
    }
  } catch (err) {
    log.debug("Readability parse failed, falling back to raw content", {
      error: err,
    });
  }
  return { title: extractTitleFromHtml(rawBody), content: rawBody };
}
