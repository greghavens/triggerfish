/**
 * X tool definitions — posts and users domains.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** Build the x_posts tool definition. */
export function buildXPostsDef(): ToolDefinition {
  return {
    name: "x_posts",
    description:
      "X (Twitter) post operations. Actions: search, timeline, get, mentions, user_posts, create, delete, upload_media.\n" +
      "- search: search recent posts. Params: query (required), max_results?, next_token?\n" +
      "- timeline: get home timeline. Params: max_results?, next_token?\n" +
      "- get: get a single post by ID. Params: post_id (required)\n" +
      "- mentions: get posts mentioning the authenticated user. Params: max_results?, since_id?\n" +
      "- user_posts: get posts by a specific user. Params: username (required), max_results?, next_token?\n" +
      "- create: create a new post (280 char limit, 25k for Premium). Params: text (required), reply_to?, quote?, media_ids?, poll_options?, poll_duration_minutes?\n" +
      "- delete: delete a post. Params: post_id (required)\n" +
      "- upload_media: upload media for attachment. Params: file_path (required), alt_text?",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: search, timeline, get, mentions, user_posts, create, delete, upload_media",
        required: true,
      },
      query: {
        type: "string",
        description: "Search query with X search operators (search)",
        required: false,
      },
      post_id: {
        type: "string",
        description: "Post ID (get, delete)",
        required: false,
      },
      username: {
        type: "string",
        description: "X username without @ (user_posts)",
        required: false,
      },
      text: {
        type: "string",
        description: "Post text content (create)",
        required: false,
      },
      reply_to: {
        type: "string",
        description: "Post ID to reply to (create)",
        required: false,
      },
      quote: {
        type: "string",
        description: "Post ID to quote (create)",
        required: false,
      },
      media_ids: {
        type: "array",
        description: "Media IDs from prior upload_media calls (create)",
        required: false,
      },
      poll_options: {
        type: "array",
        description: "Poll choices, 2-4 options (create)",
        required: false,
      },
      poll_duration_minutes: {
        type: "number",
        description: "Poll duration in minutes, 5-10080 (create)",
        required: false,
      },
      file_path: {
        type: "string",
        description: "Path to media file in agent workspace (upload_media)",
        required: false,
      },
      alt_text: {
        type: "string",
        description:
          "Alt text for accessibility, max 1000 chars (upload_media)",
        required: false,
      },
      max_results: {
        type: "number",
        description:
          "Results per page (search: 10-100, timeline/mentions/user_posts: 1-100)",
        required: false,
      },
      next_token: {
        type: "string",
        description: "Pagination token from previous call",
        required: false,
      },
      since_id: {
        type: "string",
        description: "Return results after this post ID (mentions)",
        required: false,
      },
    },
  };
}

/** Build the x_users tool definition. */
export function buildXUsersDef(): ToolDefinition {
  return {
    name: "x_users",
    description:
      "X (Twitter) user operations. Actions: get, followers, following, follow, unfollow.\n" +
      "- get: get user profile by username. Params: username (required)\n" +
      "- followers: list followers. Params: username?, max_results?, next_token?\n" +
      "- following: list accounts user follows. Params: username?, max_results?, next_token?\n" +
      "- follow: follow a user. Params: username (required)\n" +
      "- unfollow: unfollow a user. Params: username (required)",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: get, followers, following, follow, unfollow",
        required: true,
      },
      username: {
        type: "string",
        description: "X username without @ sign",
        required: false,
      },
      max_results: {
        type: "number",
        description: "Results per page (1-1000, default 100)",
        required: false,
      },
      next_token: {
        type: "string",
        description: "Pagination token from previous call",
        required: false,
      },
    },
  };
}
