/**
 * Archive download and extraction utilities for Signal setup.
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { Result } from "../../../core/types/classification.ts";

const log = createLogger("signal");

/** Pipe a response body through `tar xzf` to extract a tar.gz archive. */
async function pipeBodyToTar(
  body: ReadableStream<Uint8Array>,
  destDir: string,
): Promise<Result<void, string>> {
  const tar = new Deno.Command("tar", {
    args: ["xzf", "-", "-C", destDir],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = tar.spawn();
  const writer = child.stdin.getWriter();

  for await (const chunk of body) {
    await writer.write(chunk);
  }
  await writer.close();

  const status = await child.status;
  if (!status.success) {
    const raw = await child.stderr.getReader().read();
    const stderr = new TextDecoder().decode(raw.value ?? new Uint8Array());
    return { ok: false, error: `tar extraction failed: ${stderr}` };
  }
  return { ok: true, value: undefined };
}

/** Write a response body to a temp zip then expand via PowerShell. */
async function writeAndExpandZip(
  body: ReadableStream<Uint8Array>,
  destDir: string,
): Promise<Result<void, string>> {
  const tmpZip = `${destDir}\\jre-download.zip`;
  const file = await Deno.open(tmpZip, {
    write: true,
    create: true,
    truncate: true,
  });
  for await (const chunk of body) {
    await file.write(chunk);
  }
  file.close();

  const psResult = await expandArchiveViaPowerShell(tmpZip, destDir);
  await removeTempZip(tmpZip);
  return psResult;
}

/** Run PowerShell Expand-Archive on a zip file. */
async function expandArchiveViaPowerShell(
  zipPath: string,
  destDir: string,
): Promise<Result<void, string>> {
  const ps = new Deno.Command("powershell", {
    args: [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const psOut = await ps.output();
  if (!psOut.success) {
    const stderr = new TextDecoder().decode(psOut.stderr);
    return { ok: false, error: `zip extraction failed: ${stderr}` };
  }
  return { ok: true, value: undefined };
}

/** Remove a temporary zip file, logging on failure. */
async function removeTempZip(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err: unknown) {
    log.debug("Temp zip cleanup failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Download a URL and extract the archive to a destination directory. */
export async function fetchAndExtractArchive(
  url: string,
  destDir: string,
  isWindows: boolean,
): Promise<Result<void, string>> {
  let resp: Response;
  try {
    resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok || !resp.body) {
      return { ok: false, error: `Download failed: HTTP ${resp.status}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Download failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (isWindows) {
    return writeAndExpandZip(resp.body, destDir);
  }
  return pipeBodyToTar(resp.body, destDir);
}

/** @deprecated Use fetchAndExtractArchive instead */
export const downloadAndExtractArchive = fetchAndExtractArchive;

/** List directory entries for debugging. */
export async function listDirectoryEntries(dirPath: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(dirPath)) entries.push(e.name);
  } catch (_err: unknown) {
    log.debug("Directory listing failed", { path: dirPath });
  }
  return entries;
}

/** Find the first existing file from a list of candidates. */
export async function locateFirstExistingPath(
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await Deno.stat(candidate);
      return candidate;
    } catch (_err: unknown) {
      log.debug("Binary candidate not found", { path: candidate });
    }
  }
  return null;
}
