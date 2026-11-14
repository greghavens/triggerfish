/**
 * X engagement tool action handlers.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { XToolContext } from "../tools_shared.ts";
import { formatXError } from "../tools_shared.ts";

const log = createLogger("x-tools-engage");

/** Handle x_engage like action. */
export async function likeXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage like: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "likeXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.like(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "likeXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({ liked: result.value.liked, post_id: postId });
}

/** Handle x_engage unlike action. */
export async function unlikeXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage unlike: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "unlikeXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.unlike(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "unlikeXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({ liked: result.value.liked, post_id: postId });
}

/** Handle x_engage retweet action. */
export async function retweetXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage retweet: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "retweetXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.retweet(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "retweetXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    retweeted: result.value.retweeted,
    post_id: postId,
  });
}

/** Handle x_engage unretweet action. */
export async function unretweetXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage unretweet: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "unretweetXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.unretweet(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "unretweetXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    retweeted: result.value.retweeted,
    post_id: postId,
  });
}

/** Handle x_engage bookmark action. */
export async function bookmarkXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage bookmark: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "bookmarkXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.bookmark(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "bookmarkXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    bookmarked: result.value.bookmarked,
    post_id: postId,
  });
}

/** Handle x_engage unbookmark action. */
export async function unbookmarkXPost(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const postId = input.post_id;
  if (typeof postId !== "string" || postId.length === 0) {
    return "x_engage unbookmark: 'post_id' parameter is required.";
  }
  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "unbookmarkXPost" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.unbookmark(postId);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "unbookmarkXPost",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    bookmarked: result.value.bookmarked,
    post_id: postId,
  });
}

/** Handle x_engage get_bookmarks action. */
export async function getXBookmarks(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXBookmarks" });
    return quotaCheck.error;
  }

  const result = await ctx.engage.getBookmarks({
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXBookmarks",
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
