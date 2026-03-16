/**
 * Binary download with progress reporting and SHA256 checksum verification.
 * @module
 */

import { join } from "@std/path";
import { resolveBaseDir } from "../../config/paths.ts";
import { sha256File } from "./binary.ts";
import { type ReleaseMetadata, resolveAssetName } from "./release.ts";
import { createLogger } from "../../../core/logger/mod.ts";

const log = createLogger("cli.updater");

/** Report download progress to stderr. */
function reportDownloadProgress(
  downloaded: number,
  totalBytes: number,
): void {
  const mb = (downloaded / 1_048_576).toFixed(1);
  const enc = new TextEncoder();
  if (totalBytes > 0) {
    const pct = Math.round((downloaded / totalBytes) * 100);
    const totalMb = (totalBytes / 1_048_576).toFixed(1);
    Deno.stderr.writeSync(
      enc.encode(`\r  Downloading... ${mb}/${totalMb} MB (${pct}%)`),
    );
  } else {
    Deno.stderr.writeSync(enc.encode(`\r  Downloading... ${mb} MB`));
  }
}

/** Stream a response body to a file with progress. */
async function streamToFileWithProgress(
  body: ReadableStream<Uint8Array>,
  tmpPath: string,
  totalBytes: number,
): Promise<void> {
  const file = await Deno.open(tmpPath, {
    write: true,
    create: true,
    truncate: true,
  });
  let downloaded = 0;
  const reader = body.getReader();
  const writer = file.writable.getWriter();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    downloaded += value.byteLength;
    reportDownloadProgress(downloaded, totalBytes);
  }
  await writer.close();
  Deno.stderr.writeSync(new TextEncoder().encode("\n"));
}

/**
 * Download a binary from a URL to a temp path with progress.
 *
 * @returns null on success, or an error message string.
 */
async function downloadBinaryToFile(
  downloadUrl: string,
  tmpPath: string,
): Promise<string | null> {
  try {
    const resp = await fetch(downloadUrl);
    if (!resp.ok || !resp.body) {
      return `Download failed: HTTP ${resp.status}`;
    }
    const totalBytes = Number(resp.headers.get("content-length") ?? 0);
    await streamToFileWithProgress(resp.body, tmpPath, totalBytes);
    if (Deno.build.os !== "windows") await Deno.chmod(tmpPath, 0o755);
    return null;
  } catch (e) {
    try {
      await Deno.remove(tmpPath);
    } catch (err) {
      log.debug("Temp file cleanup failed after download error", { operation: "downloadBinaryToFile", err });
    }
    return `Download failed: ${e}`;
  }
}

/** Parse expected hash for our asset from checksums text. */
function parseExpectedHash(checksumsText: string): string | null {
  const assetName = resolveAssetName();
  const line = checksumsText.split("\n").find((l) => l.includes(assetName));
  if (!line) return null;
  return line.split(/\s+/)[0].toLowerCase();
}

/** Fetch and parse checksums file, returning expected hash or null. */
async function fetchExpectedHash(
  checksumsUrl: string,
): Promise<string | null> {
  const resp = await fetch(checksumsUrl);
  if (!resp.ok) {
    log.warn("Checksum file download failed", {
      operation: "downloadUpdate",
      status: resp.status,
      checksumsUrl,
    });
    console.log(
      "  Warning: could not download checksums, skipping verification.",
    );
    return null;
  }
  const text = await resp.text();
  const hash = parseExpectedHash(text);
  if (!hash) {
    log.warn("Asset not found in SHA256SUMS.txt", {
      operation: "downloadUpdate",
      checksumsUrl,
    });
    console.log(
      "  Warning: asset not found in SHA256SUMS.txt, skipping verification.",
    );
  }
  return hash;
}

/** Compare the actual file hash against the expected hash. */
async function compareFileHash(
  tmpPath: string,
  expectedHash: string,
): Promise<string | null> {
  const actualHash = await sha256File(tmpPath);
  if (actualHash !== expectedHash) {
    return `Checksum verification failed.\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`;
  }
  console.log("  Checksum verified.");
  return null;
}

/**
 * Verify SHA256 checksum of a downloaded binary.
 *
 * @returns null on success or when verification is skipped, or an error message.
 */
async function verifyBinaryChecksum(
  checksumsUrl: string | undefined,
  tmpPath: string,
): Promise<string | null> {
  if (!checksumsUrl) {
    log.warn("No SHA256SUMS.txt in release", { operation: "downloadUpdate" });
    console.log(
      "  Warning: no SHA256SUMS.txt in release, skipping checksum verification.",
    );
    return null;
  }
  console.log("  Verifying checksum...");
  try {
    const expectedHash = await fetchExpectedHash(checksumsUrl);
    if (!expectedHash) return null;
    return compareFileHash(tmpPath, expectedHash);
  } catch (err: unknown) {
    log.warn("Checksum verification exception", {
      operation: "downloadUpdate",
      err,
    });
    console.log("  Warning: checksum verification failed, skipping.");
    return null;
  }
}

/**
 * Download and verify the release binary.
 *
 * @returns The temp path to the downloaded binary, or an error message.
 */
export async function fetchAndVerifyRelease(
  metadata: ReleaseMetadata,
): Promise<{ tmpPath: string } | { error: string }> {
  const tmpPath = join(resolveBaseDir(), ".update-tmp");
  const dlError = await downloadBinaryToFile(metadata.downloadUrl, tmpPath);
  if (dlError) return { error: dlError };

  const csError = await verifyBinaryChecksum(metadata.checksumsUrl, tmpPath);
  if (csError) {
    try {
      await Deno.remove(tmpPath);
    } catch (err) {
      log.debug("Temp file cleanup failed after checksum error", { operation: "fetchAndVerifyRelease", err });
    }
    return { error: csError };
  }
  return { tmpPath };
}

/** @deprecated Use fetchAndVerifyRelease instead */
export const downloadAndVerifyRelease = fetchAndVerifyRelease;
