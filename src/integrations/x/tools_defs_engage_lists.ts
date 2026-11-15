/**
 * X tool definitions — engagement, lists, and quota.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Build the x_engage tool definition. */
export function buildXEngageDef(): ToolDefinition {
  return {
    name: "x_engage",
    description:
      "X (Twitter) engagement operations. Actions: like, unlike, retweet, unretweet, bookmark, unbookmark, get_bookmarks.\n" +
      "- like: like a post. Params: post_id (required)\n" +
      "- unlike: remove a like. Params: post_id (required)\n" +
      "- retweet: retweet a post. Params: post_id (required)\n" +
      "- unretweet: remove a retweet. Params: post_id (required)\n" +
      "- bookmark: bookmark a post. Params: post_id (required)\n" +
      "- unbookmark: remove a bookmark. Params: post_id (required)\n" +
      "- get_bookmarks: list bookmarked posts. Params: max_results?, next_token?",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: like, unlike, retweet, unretweet, bookmark, unbookmark, get_bookmarks",
        required: true,
      },
      post_id: {
        type: "string",
        description:
          "Post ID (like, unlike, retweet, unretweet, bookmark, unbookmark)",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Results per page for get_bookmarks (1-100, default 10)",
        required: false,
      },
      next_token: {
        type: "string",
        description: "Pagination token (get_bookmarks)",
        required: false,
      },
    },
  };
}

/** Build the x_lists tool definition. */
export function buildXListsDef(): ToolDefinition {
  return {
    name: "x_lists",
    description:
      "X (Twitter) list operations. Actions: get, members, create, add_member, remove_member.\n" +
      "- get: list owned lists. No params.\n" +
      "- members: get members of a list. Params: list_id (required), max_results?\n" +
      "- create: create a new list. Params: name (required), description?, private?\n" +
      "- add_member: add user to list. Params: list_id (required), username (required)\n" +
      "- remove_member: remove user from list. Params: list_id (required), username (required)",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: get, members, create, add_member, remove_member",
        required: true,
      },
      list_id: {
        type: "string",
        description: "List ID (members, add_member, remove_member)",
        required: false,
      },
      name: {
        type: "string",
        description: "List name, 1-25 characters (create)",
        required: false,
      },
      description: {
        type: "string",
        description: "List description, max 100 characters (create)",
        required: false,
      },
      private: {
        type: "boolean",
        description: "Whether the list is private (create, default: false)",
        required: false,
      },
      username: {
        type: "string",
        description: "X username without @ (add_member, remove_member)",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Results per page for members (1-100, default 100)",
        required: false,
      },
      next_token: {
        type: "string",
        description: "Pagination token (members)",
        required: false,
      },
    },
  };
}

/** Build the x_quota tool definition. */
export function buildXQuotaDef(): ToolDefinition {
  return {
    name: "x_quota",
    description:
      "Check remaining X API quota for the current billing period. " +
      "Shows read/write limits, consumption, and tier information.",
    parameters: {},
  };
}
