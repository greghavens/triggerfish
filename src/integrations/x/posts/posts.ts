/**
 * X posts service — search, timeline, CRUD, and media upload.
 *
 * @module
 */

import type { XApiClient, XApiResult } from "../auth/types_auth.ts";
import type {
  PostsService,
  XCreatePostOptions,
  XMediaUploadResult,
  XPost,
  XPostPage,
  XSearchOptions,
  XTimelineOptions,
  XUserPostsOptions,
} from "./types_posts.ts";
import { uploadMediaToX } from "./posts_media.ts";

/** Standard tweet fields requested on every post query. */
const TWEET_FIELDS =
  "id,text,author_id,created_at,conversation_id,in_reply_to_user_id,referenced_tweets,public_metrics,attachments";

/** Standard user expansions for author info. */
const EXPANSIONS = "author_id,attachments.media_keys";

/** Media fields for attachment details. */
const MEDIA_FIELDS = "media_key,type,url,preview_image_url,alt_text";

/** User fields for expanded author data. */
const USER_FIELDS = "id,username,name";

/** Common query params for tweet lookups. */
function tweetQueryParams(): Record<string, string> {
  return {
    "tweet.fields": TWEET_FIELDS,
    expansions: EXPANSIONS,
    "media.fields": MEDIA_FIELDS,
    "user.fields": USER_FIELDS,
  };
}

/** Raw X API v2 response envelope for tweet lists. */
interface XTweetListResponse {
  readonly data?: readonly XRawTweet[];
  readonly includes?: {
    readonly users?: readonly XRawUser[];
    readonly media?: readonly XRawMedia[];
  };
  readonly meta?: {
    readonly next_token?: string;
    readonly result_count?: number;
  };
}

/** Raw X API v2 response envelope for a single tweet. */
interface XSingleTweetResponse {
  readonly data: XRawTweet;
  readonly includes?: {
    readonly users?: readonly XRawUser[];
    readonly media?: readonly XRawMedia[];
  };
}

/** Raw tweet from X API v2. */
interface XRawTweet {
  readonly id: string;
  readonly text: string;
  readonly author_id?: string;
  readonly created_at?: string;
  readonly conversation_id?: string;
  readonly in_reply_to_user_id?: string;
  readonly referenced_tweets?: readonly {
    readonly type: "quoted" | "replied_to" | "retweeted";
    readonly id: string;
  }[];
  readonly public_metrics?: {
    readonly retweet_count: number;
    readonly reply_count: number;
    readonly like_count: number;
    readonly quote_count: number;
    readonly bookmark_count: number;
    readonly impression_count: number;
  };
  readonly attachments?: {
    readonly media_keys?: readonly string[];
  };
}

/** Raw user from X API v2 includes. */
interface XRawUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
}

/** Raw media from X API v2 includes. */
interface XRawMedia {
  readonly media_key: string;
  readonly type: "photo" | "video" | "animated_gif";
  readonly url?: string;
  readonly preview_image_url?: string;
  readonly alt_text?: string;
}

/** Map a raw tweet + includes into an XPost domain object. */
function mapTweet(
  raw: XRawTweet,
  includes?: XSingleTweetResponse["includes"],
): XPost {
  const author = includes?.users?.find((u) => u.id === raw.author_id);
  const mediaKeys = raw.attachments?.media_keys ?? [];
  const media = mediaKeys
    .map((key) => includes?.media?.find((m) => m.media_key === key))
    .filter((m): m is XRawMedia => m !== undefined)
    .map((m) => ({
      mediaKey: m.media_key,
      type: m.type,
      url: m.url,
      previewImageUrl: m.preview_image_url,
      altText: m.alt_text,
    }));

  return {
    id: raw.id,
    text: raw.text,
    authorId: raw.author_id ?? "",
    authorUsername: author?.username,
    authorName: author?.name,
    createdAt: raw.created_at ?? "",
    conversationId: raw.conversation_id,
    inReplyToUserId: raw.in_reply_to_user_id,
    referencedTweets: raw.referenced_tweets,
    publicMetrics: raw.public_metrics,
    attachments: media.length > 0 ? media : undefined,
  };
}

/** Map a list response into an XPostPage. */
function mapTweetList(response: XTweetListResponse): XPostPage {
  const posts = (response.data ?? []).map((t) =>
    mapTweet(t, response.includes)
  );
  return { posts, nextToken: response.meta?.next_token };
}

/**
 * Create an X posts service.
 *
 * @param client - Authenticated X API v2 client
 * @param authenticatedUserId - The ID of the authenticated user (for timeline/mentions)
 */
export function createPostsService(
  client: XApiClient,
  authenticatedUserId: string,
  workspaceRoot?: string,
): PostsService {
  return {
    async search(opts: XSearchOptions): Promise<XApiResult<XPostPage>> {
      const params: Record<string, string> = {
        query: opts.query,
        ...tweetQueryParams(),
      };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.next_token = opts.nextToken;

      const result = await client.get<XTweetListResponse>(
        "/2/tweets/search/recent",
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapTweetList(result.value) };
    },

    async timeline(opts: XTimelineOptions): Promise<XApiResult<XPostPage>> {
      const params: Record<string, string> = { ...tweetQueryParams() };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.next_token = opts.nextToken;
      if (opts.sinceId) params.since_id = opts.sinceId;

      const result = await client.get<XTweetListResponse>(
        `/2/users/${
          encodeURIComponent(authenticatedUserId)
        }/timelines/reverse_chronological`,
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapTweetList(result.value) };
    },

    async getPost(postId: string): Promise<XApiResult<XPost>> {
      const result = await client.get<XSingleTweetResponse>(
        `/2/tweets/${encodeURIComponent(postId)}`,
        tweetQueryParams(),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: mapTweet(result.value.data, result.value.includes),
      };
    },

    async mentions(opts: XTimelineOptions): Promise<XApiResult<XPostPage>> {
      const params: Record<string, string> = { ...tweetQueryParams() };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.next_token = opts.nextToken;
      if (opts.sinceId) params.since_id = opts.sinceId;

      const result = await client.get<XTweetListResponse>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/mentions`,
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapTweetList(result.value) };
    },

    async userPosts(
      opts: XUserPostsOptions,
    ): Promise<XApiResult<XPostPage>> {
      const params: Record<string, string> = { ...tweetQueryParams() };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.next_token = opts.nextToken;

      const result = await client.get<XTweetListResponse>(
        `/2/users/${encodeURIComponent(opts.userId)}/tweets`,
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapTweetList(result.value) };
    },

    async createPost(opts: XCreatePostOptions): Promise<XApiResult<XPost>> {
      const body: Record<string, unknown> = { text: opts.text };
      if (opts.replyTo) {
        body.reply = { in_reply_to_tweet_id: opts.replyTo };
      }
      if (opts.quote) {
        body.quote_tweet_id = opts.quote;
      }
      if (opts.mediaIds && opts.mediaIds.length > 0) {
        body.media = { media_ids: opts.mediaIds };
      }
      if (opts.pollOptions && opts.pollOptions.length >= 2) {
        body.poll = {
          options: opts.pollOptions,
          duration_minutes: opts.pollDurationMinutes ?? 1440,
        };
      }

      const result = await client.post<XSingleTweetResponse>(
        "/2/tweets",
        body,
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: mapTweet(result.value.data, result.value.includes),
      };
    },

    async deletePost(
      postId: string,
    ): Promise<XApiResult<{ readonly deleted: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly deleted: boolean };
      }>(
        `/2/tweets/${encodeURIComponent(postId)}`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { deleted: result.value.data.deleted } };
    },

    uploadMedia(
      filePath: string,
      altText?: string,
    ): Promise<XApiResult<XMediaUploadResult>> {
      return uploadMediaToX(client, filePath, altText, workspaceRoot);
    },
  };
}
