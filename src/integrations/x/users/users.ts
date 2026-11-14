/**
 * X users service — profile lookup, followers, following, follow/unfollow.
 *
 * @module
 */

import type { XApiClient, XApiResult } from "../auth/types_auth.ts";
import type {
  UsersService,
  XFollowListOptions,
  XUser,
  XUserPage,
} from "./types_users.ts";

/** Standard user fields requested on every user query. */
const USER_FIELDS =
  "id,username,name,description,profile_image_url,verified,public_metrics,created_at,location,url,protected";

/** Raw X API v2 response for a single user. */
interface XSingleUserResponse {
  readonly data: XRawUser;
}

/** Raw X API v2 response for a user list. */
interface XUserListResponse {
  readonly data?: readonly XRawUser[];
  readonly meta?: {
    readonly next_token?: string;
    readonly result_count?: number;
  };
}

/** Raw user from X API v2. */
interface XRawUser {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly description?: string;
  readonly profile_image_url?: string;
  readonly verified?: boolean;
  readonly public_metrics?: {
    readonly followers_count: number;
    readonly following_count: number;
    readonly tweet_count: number;
    readonly listed_count: number;
  };
  readonly created_at?: string;
  readonly location?: string;
  readonly url?: string;
  readonly protected?: boolean;
}

/** Map a raw user into an XUser domain object. */
function mapUser(raw: XRawUser): XUser {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    description: raw.description,
    profileImageUrl: raw.profile_image_url,
    verified: raw.verified,
    publicMetrics: raw.public_metrics,
    createdAt: raw.created_at,
    location: raw.location,
    url: raw.url,
    protected: raw.protected,
  };
}

/** Map a user list response into an XUserPage. */
function mapUserList(response: XUserListResponse): XUserPage {
  const users = (response.data ?? []).map(mapUser);
  return { users, nextToken: response.meta?.next_token };
}

/**
 * Create an X users service.
 *
 * @param client - Authenticated X API v2 client
 * @param authenticatedUserId - The ID of the authenticated user
 */
export function createUsersService(
  client: XApiClient,
  authenticatedUserId: string,
): UsersService {
  return {
    async getUser(username: string): Promise<XApiResult<XUser>> {
      const result = await client.get<XSingleUserResponse>(
        `/2/users/by/username/${encodeURIComponent(username)}`,
        { "user.fields": USER_FIELDS },
      );
      if (!result.ok) return result;
      return { ok: true, value: mapUser(result.value.data) };
    },

    async getFollowers(
      opts: XFollowListOptions,
    ): Promise<XApiResult<XUserPage>> {
      const params: Record<string, string> = {
        "user.fields": USER_FIELDS,
      };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.pagination_token = opts.nextToken;

      const result = await client.get<XUserListResponse>(
        `/2/users/${encodeURIComponent(opts.userId)}/followers`,
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapUserList(result.value) };
    },

    async getFollowing(
      opts: XFollowListOptions,
    ): Promise<XApiResult<XUserPage>> {
      const params: Record<string, string> = {
        "user.fields": USER_FIELDS,
      };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.pagination_token = opts.nextToken;

      const result = await client.get<XUserListResponse>(
        `/2/users/${encodeURIComponent(opts.userId)}/following`,
        params,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapUserList(result.value) };
    },

    async follow(
      targetUserId: string,
    ): Promise<XApiResult<{ readonly following: boolean }>> {
      const result = await client.post<{
        readonly data: { readonly following: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/following`,
        { target_user_id: targetUserId },
      );
      if (!result.ok) return result;
      return { ok: true, value: { following: result.value.data.following } };
    },

    async unfollow(
      targetUserId: string,
    ): Promise<XApiResult<{ readonly following: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly following: boolean };
      }>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/following/${
          encodeURIComponent(targetUserId)
        }`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { following: result.value.data.following } };
    },
  };
}
