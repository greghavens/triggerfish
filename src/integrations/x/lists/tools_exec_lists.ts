/**
 * X lists tool action handlers.
 *
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { XToolContext } from "../tools_shared.ts";
import { formatXError } from "../tools_shared.ts";

const log = createLogger("x-tools-lists");

/** Handle x_lists get action. */
export async function getXLists(
  ctx: XToolContext,
  _input: Record<string, unknown>,
): Promise<string> {
  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXLists" });
    return quotaCheck.error;
  }

  const result = await ctx.lists.getLists();
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXLists",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordRead();

  return JSON.stringify({ lists: result.value.lists });
}

/** Handle x_lists members action. */
export async function getXListMembers(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const listId = input.list_id;
  if (typeof listId !== "string" || listId.length === 0) {
    return "x_lists members: 'list_id' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!quotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "getXListMembers" });
    return quotaCheck.error;
  }

  const result = await ctx.lists.getMembers({
    listId,
    maxResults: typeof input.max_results === "number"
      ? input.max_results
      : undefined,
    nextToken: typeof input.next_token === "string"
      ? input.next_token
      : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "getXListMembers",
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

/** Handle x_lists create action. */
export async function createXList(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const name = input.name;
  if (typeof name !== "string" || name.length === 0) {
    return "x_lists create: 'name' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "createXList" });
    return quotaCheck.error;
  }

  const result = await ctx.lists.createList({
    name,
    description: typeof input.description === "string"
      ? input.description
      : undefined,
    private: typeof input.private === "boolean" ? input.private : undefined,
  });

  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "createXList",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify(result.value);
}

/** Handle x_lists add_member action. */
export async function addXListMember(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const listId = input.list_id;
  const username = input.username;
  if (typeof listId !== "string" || listId.length === 0) {
    return "x_lists add_member: 'list_id' parameter is required.";
  }
  if (typeof username !== "string" || username.length === 0) {
    return "x_lists add_member: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "addXListMember" });
    return quotaCheck.error;
  }

  const readQuotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!readQuotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "addXListMember" });
    return readQuotaCheck.error;
  }

  const userResult = await ctx.users.getUser(username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "addXListMember:resolveUser",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();

  const result = await ctx.lists.addMember(listId, userResult.value.id);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "addXListMember",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    is_member: result.value.isMember,
    list_id: listId,
    username,
  });
}

/** Handle x_lists remove_member action. */
export async function removeXListMember(
  ctx: XToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const listId = input.list_id;
  const username = input.username;
  if (typeof listId !== "string" || listId.length === 0) {
    return "x_lists remove_member: 'list_id' parameter is required.";
  }
  if (typeof username !== "string" || username.length === 0) {
    return "x_lists remove_member: 'username' parameter is required.";
  }

  const quotaCheck = await ctx.quotaTracker.checkWriteQuota();
  if (!quotaCheck.ok) {
    log.warn("X API write quota exhausted", { operation: "removeXListMember" });
    return quotaCheck.error;
  }

  const readQuotaCheck = await ctx.quotaTracker.checkReadQuota();
  if (!readQuotaCheck.ok) {
    log.warn("X API read quota exhausted", { operation: "removeXListMember" });
    return readQuotaCheck.error;
  }

  const userResult = await ctx.users.getUser(username);
  if (!userResult.ok) {
    log.warn("X API call failed", {
      operation: "removeXListMember:resolveUser",
      err: userResult.error,
    });
    return formatXError(userResult.error);
  }
  await ctx.quotaTracker.recordRead();

  const result = await ctx.lists.removeMember(listId, userResult.value.id);
  if (!result.ok) {
    log.warn("X API call failed", {
      operation: "removeXListMember",
      err: result.error,
    });
    return formatXError(result.error);
  }
  await ctx.quotaTracker.recordWrite();

  return JSON.stringify({
    is_member: result.value.isMember,
    list_id: listId,
    username,
  });
}
