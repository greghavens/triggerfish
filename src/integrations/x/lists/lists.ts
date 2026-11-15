/**
 * X lists service — list CRUD and membership management.
 *
 * @module
 */

import type { XApiClient, XApiResult } from "../auth/types_auth.ts";
import type { XUserPage } from "../users/types_users.ts";
import type {
  ListsService,
  XCreateListOptions,
  XList,
  XListMembersOptions,
  XListPage,
} from "./types_lists.ts";

/** User fields for member listings. */
const USER_FIELDS =
  "id,username,name,description,profile_image_url,verified,public_metrics";

/** Raw X API v2 response for lists. */
interface XListListResponse {
  readonly data?: readonly XRawList[];
  readonly meta?: {
    readonly next_token?: string;
    readonly result_count?: number;
  };
}

/** Raw X API v2 response for a single list. */
interface XSingleListResponse {
  readonly data: XRawList;
}

/** Raw X API v2 response for user lists (members). */
interface XUserListResponse {
  readonly data?: readonly {
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
  }[];
  readonly meta?: {
    readonly next_token?: string;
  };
}

/** Raw list from X API v2. */
interface XRawList {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly private: boolean;
  readonly follower_count: number;
  readonly member_count: number;
  readonly owner_id: string;
  readonly created_at?: string;
}

/** Map a raw list into an XList domain object. */
function mapList(raw: XRawList): XList {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    private: raw.private,
    followerCount: raw.follower_count,
    memberCount: raw.member_count,
    ownerId: raw.owner_id,
    createdAt: raw.created_at,
  };
}

/**
 * Create an X lists service.
 *
 * @param client - Authenticated X API v2 client
 * @param authenticatedUserId - The ID of the authenticated user
 */
export function createListsService(
  client: XApiClient,
  authenticatedUserId: string,
): ListsService {
  return {
    async getLists(): Promise<XApiResult<XListPage>> {
      const result = await client.get<XListListResponse>(
        `/2/users/${encodeURIComponent(authenticatedUserId)}/owned_lists`,
        {
          "list.fields":
            "id,name,description,private,follower_count,member_count,owner_id,created_at",
        },
      );
      if (!result.ok) return result;

      const lists = (result.value.data ?? []).map(mapList);
      return {
        ok: true,
        value: { lists, nextToken: result.value.meta?.next_token },
      };
    },

    async getMembers(
      opts: XListMembersOptions,
    ): Promise<XApiResult<XUserPage>> {
      const params: Record<string, string> = {
        "user.fields": USER_FIELDS,
      };
      if (opts.maxResults) params.max_results = String(opts.maxResults);
      if (opts.nextToken) params.pagination_token = opts.nextToken;

      const result = await client.get<XUserListResponse>(
        `/2/lists/${encodeURIComponent(opts.listId)}/members`,
        params,
      );
      if (!result.ok) return result;

      const users = (result.value.data ?? []).map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        description: u.description,
        profileImageUrl: u.profile_image_url,
        verified: u.verified,
        publicMetrics: u.public_metrics,
      }));

      return {
        ok: true,
        value: { users, nextToken: result.value.meta?.next_token },
      };
    },

    async createList(opts: XCreateListOptions): Promise<XApiResult<XList>> {
      const body: Record<string, unknown> = { name: opts.name };
      if (opts.description) body.description = opts.description;
      if (opts.private !== undefined) body.private = opts.private;

      const result = await client.post<XSingleListResponse>(
        "/2/lists",
        body,
      );
      if (!result.ok) return result;
      return { ok: true, value: mapList(result.value.data) };
    },

    async addMember(
      listId: string,
      userId: string,
    ): Promise<XApiResult<{ readonly isMember: boolean }>> {
      const result = await client.post<{
        readonly data: { readonly is_member: boolean };
      }>(
        `/2/lists/${encodeURIComponent(listId)}/members`,
        { user_id: userId },
      );
      if (!result.ok) return result;
      return { ok: true, value: { isMember: result.value.data.is_member } };
    },

    async removeMember(
      listId: string,
      userId: string,
    ): Promise<XApiResult<{ readonly isMember: boolean }>> {
      const result = await client.del<{
        readonly data: { readonly is_member: boolean };
      }>(
        `/2/lists/${encodeURIComponent(listId)}/members/${
          encodeURIComponent(userId)
        }`,
      );
      if (!result.ok) return result;
      return { ok: true, value: { isMember: result.value.data.is_member } };
    },
  };
}
