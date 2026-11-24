/**
 * Shared types and helpers for X tool execution.
 *
 * @module
 */

import type { XApiTier } from "./auth/types_auth.ts";
import type { XQuotaTracker } from "./client/quota_tracker.ts";
import type { EngageService } from "./engage/types_engage.ts";
import type { ListsService } from "./lists/types_lists.ts";
import type { PostsService } from "./posts/types_posts.ts";
import type { UsersService } from "./users/types_users.ts";

/** Context required by the X tool executor. */
export interface XToolContext {
  readonly posts: PostsService;
  readonly users: UsersService;
  readonly engage: EngageService;
  readonly lists: ListsService;
  readonly quotaTracker: XQuotaTracker;
  readonly tier: XApiTier;
  /** Authenticated user's X user ID. */
  readonly authenticatedUserId: string;
}

/** Format an X API error for display to the agent. */
export function formatXError(error: {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}): string {
  const status = error.status ? ` (HTTP ${error.status})` : "";
  return `X API error${status}: ${error.message} [${error.code}]`;
}

/**
 * Actions unavailable on the free tier (require Basic+).
 *
 * x_posts create/delete are intentionally NOT blocked — the X API v2 free tier
 * allows write-only access (post creation). upload_media uses the v1.1 upload
 * endpoint which requires Basic access and is correctly blocked here.
 */
const FREE_TIER_BLOCKED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> =
  {
    x_posts: new Set([
      "search",
      "timeline",
      "get",
      "mentions",
      "user_posts",
      "upload_media",
    ]),
    x_users: new Set([
      "get",
      "followers",
      "following",
      "follow",
      "unfollow",
    ]),
    x_engage: new Set([
      "like",
      "unlike",
      "retweet",
      "unretweet",
      "bookmark",
      "unbookmark",
      "get_bookmarks",
    ]),
    x_lists: new Set([
      "get",
      "members",
      "create",
      "add_member",
      "remove_member",
    ]),
  };

/**
 * Check if an action is available on the configured tier.
 *
 * @returns null if allowed, or an error message if blocked
 */
export function enforceTierRestriction(
  toolName: string,
  action: string,
  tier: XApiTier,
): string | null {
  if (tier !== "free") return null;
  const blocked = FREE_TIER_BLOCKED_ACTIONS[toolName];
  if (blocked?.has(action)) {
    return `Action '${action}' on ${toolName} requires X API Basic tier or higher. ` +
      `Current tier: free. Upgrade at developer.x.com.`;
  }
  return null;
}
