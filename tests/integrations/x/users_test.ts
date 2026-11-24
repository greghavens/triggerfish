/**
 * Tests for X users service — profile lookup, follow/unfollow, followers.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createUsersService } from "../../../src/integrations/x/users/users.ts";
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

Deno.test("UsersService: getUser calls /2/users/by/username/{username}", async () => {
  const client = createMockClient({
    "/2/users/by/username/alice": {
      ok: true,
      value: {
        data: {
          id: "u1",
          username: "alice",
          name: "Alice",
          description: "Hello",
          verified: true,
        },
      },
    },
  });
  const svc = createUsersService(client, USER_ID);

  await svc.getUser("alice");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "GET");
  assertStringIncludes(client.calls[0].url, "/2/users/by/username/alice");
});

Deno.test("UsersService: getUser returns mapped XUser", async () => {
  const client = createMockClient({
    "/2/users/by/username/bob": {
      ok: true,
      value: {
        data: {
          id: "u2",
          username: "bob",
          name: "Bob Builder",
          description: "Building things",
          profile_image_url: "https://example.com/bob.jpg",
          verified: false,
          public_metrics: {
            followers_count: 100,
            following_count: 50,
            tweet_count: 500,
            listed_count: 3,
          },
          created_at: "2020-01-01T00:00:00Z",
          location: "NYC",
          url: "https://bob.dev",
          protected: false,
        },
      },
    },
  });
  const svc = createUsersService(client, USER_ID);

  const result = await svc.getUser("bob");

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.id, "u2");
  assertEquals(result.value.username, "bob");
  assertEquals(result.value.name, "Bob Builder");
  assertEquals(result.value.description, "Building things");
  assertEquals(result.value.profileImageUrl, "https://example.com/bob.jpg");
  assertEquals(result.value.verified, false);
  assertEquals(result.value.publicMetrics?.followers_count, 100);
  assertEquals(result.value.location, "NYC");
  assertEquals(result.value.url, "https://bob.dev");
  assertEquals(result.value.protected, false);
});

Deno.test("UsersService: follow calls POST /2/users/{id}/following", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/following`]: {
      ok: true,
      value: { data: { following: true } },
    },
  });
  const svc = createUsersService(client, USER_ID);

  const result = await svc.follow("target456");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/following`,
  );
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).target_user_id,
    "target456",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.following, true);
});

Deno.test("UsersService: unfollow calls DELETE /2/users/{source}/following/{target}", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/following/target789`]: {
      ok: true,
      value: { data: { following: false } },
    },
  });
  const svc = createUsersService(client, USER_ID);

  const result = await svc.unfollow("target789");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "DELETE");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/following/target789`,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.following, false);
});

Deno.test("UsersService: getFollowers calls /2/users/{id}/followers", async () => {
  const client = createMockClient({
    "/2/users/u1/followers": {
      ok: true,
      value: {
        data: [
          { id: "f1", username: "follower1", name: "Follower One" },
          { id: "f2", username: "follower2", name: "Follower Two" },
        ],
        meta: { result_count: 2, next_token: "page2" },
      },
    },
  });
  const svc = createUsersService(client, USER_ID);

  const result = await svc.getFollowers({ userId: "u1" });

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "GET");
  assertStringIncludes(client.calls[0].url, "/2/users/u1/followers");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.users.length, 2);
  assertEquals(result.value.users[0].username, "follower1");
  assertEquals(result.value.users[1].username, "follower2");
  assertEquals(result.value.nextToken, "page2");
});

Deno.test("UsersService: getUser returns error on API failure", async () => {
  const client = createMockClient({
    "/2/users/by/username/unknown": {
      ok: false,
      error: {
        code: "USER_NOT_FOUND",
        message: "User not found",
        status: 404,
      },
    },
  });
  const svc = createUsersService(client, USER_ID);

  const result = await svc.getUser("unknown");

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.code, "USER_NOT_FOUND");
  assertEquals(result.error.status, 404);
});
