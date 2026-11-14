/**
 * Tests for X engagement service — likes, retweets, bookmarks.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createEngageService } from "../../../src/integrations/x/engage/engage.ts";
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

Deno.test("EngageService: like calls POST /2/users/{id}/likes", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/likes`]: {
      ok: true,
      value: { data: { liked: true } },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.like("tweet1");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertStringIncludes(client.calls[0].url, `/2/users/${USER_ID}/likes`);
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).tweet_id,
    "tweet1",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.liked, true);
});

Deno.test("EngageService: unlike calls DELETE /2/users/{id}/likes/{tweet_id}", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/likes/tweet2`]: {
      ok: true,
      value: { data: { liked: false } },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.unlike("tweet2");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "DELETE");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/likes/tweet2`,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.liked, false);
});

Deno.test("EngageService: retweet calls POST /2/users/{id}/retweets", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/retweets`]: {
      ok: true,
      value: { data: { retweeted: true } },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.retweet("tweet3");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/retweets`,
  );
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).tweet_id,
    "tweet3",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.retweeted, true);
});

Deno.test("EngageService: unretweet calls DELETE /2/users/{id}/retweets/{tweet_id}", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/retweets/tweet4`]: {
      ok: true,
      value: { data: { retweeted: false } },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.unretweet("tweet4");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "DELETE");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/retweets/tweet4`,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.retweeted, false);
});

Deno.test("EngageService: bookmark calls POST /2/users/{id}/bookmarks", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/bookmarks`]: {
      ok: true,
      value: { data: { bookmarked: true } },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.bookmark("tweet5");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/bookmarks`,
  );
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).tweet_id,
    "tweet5",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.bookmarked, true);
});

Deno.test("EngageService: getBookmarks calls GET /2/users/{id}/bookmarks", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/bookmarks`]: {
      ok: true,
      value: {
        data: [
          {
            id: "bm1",
            text: "bookmarked tweet",
            author_id: "a1",
            created_at: "2026-01-15T00:00:00Z",
            conversation_id: "c1",
            public_metrics: {
              retweet_count: 3,
              reply_count: 1,
              like_count: 7,
              quote_count: 0,
              bookmark_count: 2,
              impression_count: 50,
            },
          },
        ],
        meta: { next_token: "bm_next" },
      },
    },
  });
  const svc = createEngageService(client, USER_ID);

  const result = await svc.getBookmarks({});

  // getBookmarks uses GET, so find the GET call
  const getCalls = client.calls.filter((c) => c.method === "GET");
  assertEquals(getCalls.length, 1);
  assertStringIncludes(
    getCalls[0].url,
    `/2/users/${USER_ID}/bookmarks`,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.posts.length, 1);
  assertEquals(result.value.posts[0].id, "bm1");
  assertEquals(result.value.posts[0].text, "bookmarked tweet");
  assertEquals(result.value.posts[0].authorId, "a1");
  assertEquals(result.value.nextToken, "bm_next");
});
