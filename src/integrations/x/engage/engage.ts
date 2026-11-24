/**
 * X engagement service — likes, retweets, bookmarks.
 *
 * @module
 */

import type { XApiClient, XApiResult } from "../auth/types_auth.ts";
import type { XPostPage } from "../posts/types_posts.ts";
import type { EngageService, XBookmarkListOptions } from "./types_engage.ts";

/** Standard tweet fields for bookmark listing. */
const TWEET_FIELDS =
  "id,text,author_id,created_at,conversation_id,public_metrics";

/** Raw X API v2 response for tweet lists (bookmarks). */
interface XTweetListResponse {
  readonly data?: readonly {
    readonly id: string;
    readonly text: string;
    readonly author_id?: string;
    readonly created_at?: string;
    readonly conversation_id?: string;
    readonly public_metrics?: {
      readonly retweet_count: number;
      readonly reply_count: number;
      readonly like_count: number;
      readonly quote_count: number;
      readonly bookmark_count: number;
      readonly impression_count: number;
    };
  }[];
  readonly meta?: {
    readonly next_token?: string;
  };
}

/**
 * Create an X engagement service.
 *
 * @param client - Authenticated X API v2 client
 * @param authenticatedUserId - The ID of the authenticated user
 */
export function createEngageService(
  client: XApiClient,
  authenticatedUserId: string,
): EngageService {
  return {
    async like(
      postId: string,
    ): Promise<XApiResult<{ readonly liked: boolean }>> {
      const result = await client.post<{
        readonly data: { readonly liked: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/likes`,
        { tweet_id: postId },
      );
      if (!result.ok) return result;
      return { ok: true, value: { liked: result.value.data.liked } };
    },

    async unlike(
      postId: string,
    ): Promise<XApiResult<{ readonly liked: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly liked: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/likes/${
          encodeURIComponent(postId)
        }`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { liked: result.value.data.liked } };
    },

    async retweet(
      postId: string,
    ): Promise<XApiResult<{ readonly retweeted: boolean }>> {
      const result = await client.post<{
        readonly data: { readonly retweeted: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/retweets`,
        { tweet_id: postId },
      );
      if (!result.ok) return result;
      return { ok: true, value: { retweeted: result.value.data.retweeted } };
    },

    async unretweet(
      postId: string,
    ): Promise<XApiResult<{ readonly retweeted: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly retweeted: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/retweets/${
          encodeURIComponent(postId)
        }`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { retweeted: result.value.data.retweeted } };
    },

    async bookmark(
      postId: string,
    ): Promise<XApiResult<{ readonly bookmarked: boolean }>> {
      const result = await client.post<{
        readonly data: { readonly bookmarked: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/bookmarks`,
        { tweet_id: postId },
      );
      if (!result.ok) return result;
      return { ok: true, value: { bookmarked: result.value.data.bookmarked } };
    },

    async unbookmark(
      postId: string,
    ): Promise<XApiResult<{ readonly bookmarked: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly bookmarked: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/bookmarks/${
          encodeURIComponent(postId)
        }`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { bookmarked: result.value.data.bookmarked } };
    },

    async getBookmarks(
      opts: XBookmarkListOptions,
    ): Promise<XApiResult<XPostPage>> {
      const params: Record<string, string> = {
        "tweet.fields": TWEET_FIELDS,
      };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.pagination_token = opts.nextToken;

      const result = await client.get<XTweetListResponse>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/bookmarks`,
        params,
      );
      if (!result.ok) return result;

      const posts = (result.value.data ?? []).map((t) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id ?? "",
        createdAt: t.created_at ?? "",
        conversationId: t.conversation_id,
        publicMetrics: t.public_metrics,
      }));

      return {
        ok: true,
        value: {
          posts,
          nextToken: result.value.meta?.next_token,
        },
      };
    },
  };
}
