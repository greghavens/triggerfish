/**
 * Tests for X posts service — search, timeline, CRUD operations.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createPostsService } from "../../../src/integrations/x/posts/posts.ts";
import type {
  XApiClient,
  XApiResult,
} from "../../../src/integrations/x/auth/types_auth.ts";

const USER_ID = "user123";

function createMockClient(
  responses: Record<string, XApiResult<unknown>>,
): XApiClient & { calls: { method: string; url: string; body?: unknown }[] } {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  function findResponse(url: string): XApiResult<unknown> {
    for (const [key, value] of Object.entries(responses)) {
      if (url.includes(key)) return value;
    }
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: `No mock for: ${url}` },
    };
  }
  return {
    calls,
    get: <T>(url: string, params?: Record<string, string>) => {
      const fullUrl = params ? `${url}?${new URLSearchParams(params)}` : url;
      calls.push({ method: "GET", url: fullUrl });
      return Promise.resolve(findResponse(url) as XApiResult<T>);
    },
    post: <T>(url: string, body: unknown) => {
      calls.push({ method: "POST", url, body });
      return Promise.resolve(findResponse(url) as XApiResult<T>);
    },
    postRaw: <T>(url: string, body: BodyInit) => {
      calls.push({ method: "POST_RAW", url, body });
      return Promise.resolve(findResponse(url) as XApiResult<T>);
    },
    put: <T>(url: string, body: unknown) => {
      calls.push({ method: "PUT", url, body });
      return Promise.resolve(findResponse(url) as XApiResult<T>);
    },
    del: <T>(url: string) => {
      calls.push({ method: "DELETE", url });
      return Promise.resolve(findResponse(url) as XApiResult<T>);
    },
  };
}

Deno.test("PostsService: search calls /2/tweets/search/recent with query param", async () => {
  const client = createMockClient({
    "/2/tweets/search/recent": {
      ok: true,
      value: { data: [], meta: { result_count: 0 } },
    },
  });
  const svc = createPostsService(client, USER_ID);

  await svc.search({ query: "deno lang" });

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "GET");
  assertStringIncludes(client.calls[0].url, "/2/tweets/search/recent");
  assertStringIncludes(client.calls[0].url, "query=deno+lang");
});

Deno.test("PostsService: search returns mapped XPost objects", async () => {
  const client = createMockClient({
    "/2/tweets/search/recent": {
      ok: true,
      value: {
        data: [
          {
            id: "t1",
            text: "hello world",
            author_id: "a1",
            created_at: "2026-01-01T00:00:00Z",
            conversation_id: "c1",
            public_metrics: {
              retweet_count: 5,
              reply_count: 2,
              like_count: 10,
              quote_count: 1,
              bookmark_count: 0,
              impression_count: 100,
            },
          },
        ],
        includes: {
          users: [{ id: "a1", username: "alice", name: "Alice" }],
        },
        meta: { result_count: 1, next_token: "abc123" },
      },
    },
  });
  const svc = createPostsService(client, USER_ID);

  const result = await svc.search({ query: "hello" });

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.posts.length, 1);
  assertEquals(result.value.posts[0].id, "t1");
  assertEquals(result.value.posts[0].text, "hello world");
  assertEquals(result.value.posts[0].authorId, "a1");
  assertEquals(result.value.posts[0].authorUsername, "alice");
  assertEquals(result.value.posts[0].authorName, "Alice");
  assertEquals(result.value.posts[0].createdAt, "2026-01-01T00:00:00Z");
  assertEquals(result.value.posts[0].publicMetrics?.like_count, 10);
  assertEquals(result.value.nextToken, "abc123");
});

Deno.test("PostsService: getPost calls /2/tweets/{id}", async () => {
  const client = createMockClient({
    "/2/tweets/t42": {
      ok: true,
      value: {
        data: {
          id: "t42",
          text: "specific tweet",
          author_id: "a2",
          created_at: "2026-02-01T00:00:00Z",
        },
        includes: {
          users: [{ id: "a2", username: "bob", name: "Bob" }],
        },
      },
    },
  });
  const svc = createPostsService(client, USER_ID);

  const result = await svc.getPost("t42");

  assertEquals(client.calls.length, 1);
  assertStringIncludes(client.calls[0].url, "/2/tweets/t42");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.id, "t42");
  assertEquals(result.value.text, "specific tweet");
  assertEquals(result.value.authorUsername, "bob");
});

Deno.test("PostsService: createPost calls POST /2/tweets with text body", async () => {
  const client = createMockClient({
    "/2/tweets": {
      ok: true,
      value: {
        data: { id: "new1", text: "my new post" },
      },
    },
  });
  const svc = createPostsService(client, USER_ID);

  const result = await svc.createPost({ text: "my new post" });

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertEquals(client.calls[0].url, "/2/tweets");
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).text,
    "my new post",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.id, "new1");
  assertEquals(result.value.text, "my new post");
});

Deno.test("PostsService: deletePost calls DELETE /2/tweets/{id}", async () => {
  const client = createMockClient({
    "/2/tweets/del1": {
      ok: true,
      value: { data: { deleted: true } },
    },
  });
  const svc = createPostsService(client, USER_ID);

  const result = await svc.deletePost("del1");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "DELETE");
  assertStringIncludes(client.calls[0].url, "/2/tweets/del1");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.deleted, true);
});

Deno.test("PostsService: search returns error on API failure", async () => {
  const client = createMockClient({
    "/2/tweets/search/recent": {
      ok: false,
      error: { code: "RATE_LIMIT", message: "Too many requests", status: 429 },
    },
  });
  const svc = createPostsService(client, USER_ID);

  const result = await svc.search({ query: "test" });

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.code, "RATE_LIMIT");
  assertEquals(result.error.status, 429);
});
