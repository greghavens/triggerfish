/**
 * X posts tool action handlers.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { XToolContext } from "../tools_shared.ts";
import { formatXError } from "../tools_shared.ts";

const log = createLogger("x-tools-posts");

/** Handle x_posts search action. */
export async function searchXPosts(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const query = input.query;
  if (typeof query !== "string" || query.length === 0) {
    return "x_posts search: 'query' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "searchXPosts" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.search({
    query,
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "searchXPosts",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    posts: result.value.posts,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  if (quotaCheck.warning) response.warning = quotaCheck.warning;
  return JSON.stringify(response);
}

/** Handle x_posts timeline action. */
export async function getXTimeline(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXTimeline" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.timeline({
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXTimeline",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    posts: result.value.posts,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  if (quotaCheck.warning) response.warning = quotaCheck.warning;
  return JSON.stringify(response);
}

/** Handle x_posts get action. */
export async function getXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_posts get: 'post_id' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.getPost(postId);
  if (!result.ok) {
    log.warn("X API call failed", { operation: "getXPost", err: result.error });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  return JSON.stringify(result.value);
}

/** Handle x_posts mentions action. */
export async function getXMentions(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXMentions" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.mentions({
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    sinceId: typeof input.since_id === "string" ? input.since_id : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXMentions",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    posts: result.value.posts,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  return JSON.stringify(response);
}

/** Handle x_posts user_posts action. */
export async function getXUserPosts(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const username = input.username;
  if (typeof username !== "string" || username.length === 0) {
    return "x_posts user_posts: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXUserPosts" });
    return quotaCheck.error;
  }

  const userResult = await ctx.users.getUser(username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "getXUserPosts:resolveUser",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();

  const postsQuotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!postsQuotaCheck.ok) {
    log.warn("X API read quota exhausted", {
      operation: "getXUserPosts:posts",
    });
    return postsQuotaCheck.error;
  }

  const result = await ctx.posts.userPosts({
    userId: userResult.value.id,
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXUserPosts",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    posts: result.value.posts,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  return JSON.stringify(response);
}

/** Handle x_posts create action. */
export async function createXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const text = input.text;
  if (typeof text !== "string" || text.length === 0) {
    return "x_posts create: 'text' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "createXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.createPost({
    text,
    replyTo: typeof input.reply_to === "string" ? input.reply_to : undefined,
    quote: typeof input.quote === "string" ? input.quote : undefined,
    mediaIds: Array.isArray(input.media_ids)
      ? (input.media_ids as unknown[]).filter((v): v is string =>
        typeof v === "string"
      )
      : undefined,
    pollOptions: Array.isArray(input.poll_options)
      ? (input.poll_options as unknown[]).filter((v): v is string =>
        typeof v === "string"
      )
      : undefined,
    pollDurationMinutes: typeof input.poll_duration_minutes === "number"
      ? input.poll_duration_minutes
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "createXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify(result.value);
}

/** Handle x_posts delete action. */
export async function deleteXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_posts delete: 'post_id' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "deleteXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.posts.deletePost(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "deleteXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({ deleted: result.value.deleted, post_id: postId });
}

/** Handle x_posts upload_media action. */
export async function uploadXMedia(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    return "x_posts upload_media: 'file_path' parameter is required.";
  }
  if (filePath.startsWith("/") || filePath.includes("..")) {
    return "x_posts upload_media: file_path must be a relative path within the workspace (no absolute paths or '..' traversal).";
  }

  // Media upload uses the v1.1 endpoint which is not counted against the
  // v2 post write quota. No write quota check or increment here.
  const result = await ctx.posts.uploadMedia(
    filePath,
    typeof input.alt_text === "string" ? input.alt_text : undefined,
  );

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "uploadXMedia",
      err: result.error,
    });
    return formatXError(result.error);
  }

  const response: Record<string, unknown> = {
    media_id: result.value.mediaId,
    message:
      "Media uploaded. Pass this media_id in the media_ids array when creating a post.",
  };
  if (result.value.altTextApplied === false) {
    response.warning = "Alt text could not be applied to the uploaded media.";
  }
  return JSON.stringify(response);
}
