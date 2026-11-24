/**
 * X users tool action handlers.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { XToolContext } from "../tools_shared.ts";
import { formatXError } from "../tools_shared.ts";

const log = createLogger("x-tools-users");

/** Resolve user ID from username input, falling back to authenticated user. */
async function resolveUserIdFromInput(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<{ readonly userId: string } | string> {
  if (typeof input.username !== "string" || input.username.length === 0) {
    return { userId: ctx.authenticatedUserId };
  }
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", {
      operation: "resolveUserIdFromInput",
    });
    return quotaCheck.error;
  }
  const userResult = await ctx.users.getUser(input.username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "resolveUserIdFromInput",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();
  return { userId: userResult.value.id };
}

/** Handle x_users get action. */
export async function getXUser(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const username = input.username;
  if (typeof username !== "string" || username.length === 0) {
    return "x_users get: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXUser" });
    return quotaCheck.error;
  }

  const result = await ctx.users.getUser(username);
  if (!result.ok) {
    log.warn("X API call failed", { operation: "getXUser", err: result.error });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  return JSON.stringify(result.value);
}

/** Handle x_users followers action. */
export async function listXFollowers(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "listXFollowers" });
    return quotaCheck.error;
  }

  const resolved = await resolveUserIdFromInput(ctx, input);
  if (typeof resolved === "string") return resolved;
  const userId = resolved.userId;

  const result = await ctx.users.getFollowers({
    userId,
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "listXFollowers",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    users: result.value.users,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  return JSON.stringify(response);
}

/** Handle x_users following action. */
export async function listXFollowing(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "listXFollowing" });
    return quotaCheck.error;
  }

  const resolved = await resolveUserIdFromInput(ctx, input);
  if (typeof resolved === "string") return resolved;
  const userId = resolved.userId;

  const result = await ctx.users.getFollowing({
    userId,
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "listXFollowing",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  const response: Record<string, unknown> = {
    users: result.value.users,
  };
  if (result.value.nextToken) response.next_token = result.value.nextToken;
  return JSON.stringify(response);
}

/** Handle x_users follow action. */
export async function followXUser(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const username = input.username;
  if (typeof username !== "string" || username.length === 0) {
    return "x_users follow: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "followXUser" });
    return quotaCheck.error;
  }

  const readQuotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!readQuotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "followXUser" });
    return readQuotaCheck.error;
  }

  const userResult = await ctx.users.getUser(username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "followXUser:resolveUser",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();

  const result = await ctx.users.follow(userResult.value.id);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "followXUser",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    following: result.value.following,
    username,
  });
}

/** Handle x_users unfollow action. */
export async function unfollowXUser(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const username = input.username;
  if (typeof username !== "string" || username.length === 0) {
    return "x_users unfollow: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "unfollowXUser" });
    return quotaCheck.error;
  }

  const readQuotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!readQuotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "unfollowXUser" });
    return readQuotaCheck.error;
  }

  const userResult = await ctx.users.getUser(username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "unfollowXUser:resolveUser",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();

  const result = await ctx.users.unfollow(userResult.value.id);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "unfollowXUser",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    following: result.value.following,
    username,
  });
}
