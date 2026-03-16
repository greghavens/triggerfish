/**
 * Drive tool executor.
 *
 * Handles dispatch for drive_search and drive_read.
 *
 * @module
 */

import type { DriveService } from "../types.ts";

/** Validate that a value is a non-empty string. */
function requireNonEmptyString(
  value: unknown,
  field: string,
  tool: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `Error: ${tool} requires a non-empty '${field}' argument.`;
  }
  return null;
}

/** Format drive search results into a JSON string. */
function formatDriveResults(
  files: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly modifiedTime?: string;
    readonly webViewLink?: string;
  }>,
): string {
  return JSON.stringify(
    files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
    })),
  );
}

/** Execute drive_search tool. */
export async function queryGoogleDrive(
  drive: DriveService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(input.query, "query", "drive_search");
  if (err) return err;

  const maxResults = typeof input.max_results === "number"
    ? input.max_results
    : 10;
  const result = await drive.search({
    query: input.query as string,
    maxResults,
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  if (result.value.length === 0) {
    return `No files found for query: "${input.query}"`;
  }
  return formatDriveResults(result.value);
}

/** @deprecated Use queryGoogleDrive instead */
export const executeDriveSearch = queryGoogleDrive;

/** Execute drive_read tool. */
export async function readGoogleDriveFile(
  drive: DriveService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(input.file_id, "file_id", "drive_read");
  if (err) return err;

  const result = await drive.read(input.file_id as string);
  if (!result.ok) return `Error: ${result.error.message}`;

  return result.value;
}

/** @deprecated Use readGoogleDriveFile instead */
export const executeDriveRead = readGoogleDriveFile;
