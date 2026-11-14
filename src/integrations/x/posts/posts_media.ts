/**
 * X media upload — handles file upload and alt text for X API v1.1 media endpoints.
 *
 * @module
 */

import { isAbsolute, relative, resolve } from "@std/path";
import { createLogger } from "../../../core/logger/logger.ts";
import type { XApiClient, XApiResult } from "../auth/types_auth.ts";
import type { XMediaUploadResult } from "./types_posts.ts";

const log = createLogger("x-media");

/**
 * Upload media to X and optionally set alt text.
 *
 * Uses the v1.1 upload endpoint (still required for v2 posts).
 * Reads the file, POSTs as multipart/form-data, then sets alt text
 * via a separate metadata/create call if provided.
 *
 * @param client - Authenticated X API client
 * @param filePath - Local path to the media file
 * @param altText - Optional alt text for accessibility
 */
export async function uploadMediaToX(
  client: XApiClient,
  filePath: string,
  altText?: string,
  workspaceRoot?: string,
): Promise<XApiResult<XMediaUploadResult>> {
  if (!workspaceRoot) {
    return {
      ok: false,
      error: {
        code: "NO_WORKSPACE",
        message: "Media upload requires a workspace root path",
      },
    };
  }
  const fileResult = await readMediaFile(filePath, workspaceRoot);
  if (!fileResult.ok) return fileResult;

  const formData = buildMediaFormData(fileResult.value, filePath);

  const result = await client.postRaw<{
    readonly media_id_string: string;
  }>(
    "https://upload.twitter.com/1.1/media/upload.json",
    formData,
  );

  if (!result.ok) return result;

  const mediaId = result.value.media_id_string;

  const altTextApplied = altText
    ? await setMediaAltText(client, mediaId, altText)
    : undefined;

  return { ok: true, value: { mediaId, altTextApplied } };
}

/** Read a media file from disk, returning a typed error on failure. */
async function readMediaFile(
  filePath: string,
  workspaceRoot: string,
): Promise<XApiResult<Uint8Array>> {
  const root = workspaceRoot;
  const resolved = resolve(root, filePath);
  const rel = relative(root, resolved);
  if (
    rel.startsWith("..") ||
    isAbsolute(resolved) && !resolved.startsWith(root + "/") &&
      resolved !== root
  ) {
    log.error("Media upload blocked: path escapes workspace", {
      operation: "readMediaFile",
      filePath,
      resolved,
      workspaceRoot: root,
    });
    return {
      ok: false,
      error: {
        code: "PATH_TRAVERSAL_BLOCKED",
        message: "Media upload blocked: file path resolves outside workspace",
      },
    };
  }
  try {
    const fileBytes = await Deno.readFile(resolved);
    return { ok: true, value: fileBytes };
  } catch (err: unknown) {
    log.warn("Media file read failed", {
      operation: "readMediaFile",
      filePath,
      err,
    });
    return {
      ok: false,
      error: {
        code: "FILE_READ_FAILED",
        message: `Media upload failed: cannot read file '${filePath}'`,
      },
    };
  }
}

/** Determine X media_category from file extension. */
function inferMediaCategory(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".gif")) return "tweet_gif";
  if (lower.endsWith(".mp4") || lower.endsWith(".mov")) return "tweet_video";
  return "tweet_image";
}

/** Build a multipart FormData payload for the media upload endpoint. */
function buildMediaFormData(
  fileBytes: Uint8Array,
  filePath: string,
): FormData {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBytes)]);
  formData.append("media", blob);
  formData.append("media_category", inferMediaCategory(filePath));
  return formData;
}

/** Set alt text on an uploaded media item via the metadata/create endpoint. */
async function setMediaAltText(
  client: XApiClient,
  mediaId: string,
  altText: string,
): Promise<boolean> {
  const result = await client.post(
    "https://upload.twitter.com/1.1/media/metadata/create.json",
    {
      media_id: mediaId,
      alt_text: { text: altText },
    },
  );
  if (!result.ok) {
    log.warn("X media alt text set failed, media uploaded without alt text", {
      operation: "setMediaAltText",
      mediaId,
      err: result.error,
    });
    return false;
  }
  return true;
}
