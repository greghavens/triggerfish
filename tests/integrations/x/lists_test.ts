/**
 * Tests for X lists service — list CRUD and membership management.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createListsService } from "../../../src/integrations/x/lists/lists.ts";
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

Deno.test("ListsService: getLists calls /2/users/{id}/owned_lists", async () => {
  const client = createMockClient({
    [`/2/users/${USER_ID}/owned_lists`]: {
      ok: true,
      value: {
        data: [
          {
            id: "list1",
            name: "My List",
            description: "A test list",
            private: false,
            follower_count: 10,
            member_count: 5,
            owner_id: USER_ID,
            created_at: "2025-06-01T00:00:00Z",
          },
        ],
        meta: { result_count: 1 },
      },
    },
  });
  const svc = createListsService(client, USER_ID);

  const result = await svc.getLists();

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "GET");
  assertStringIncludes(
    client.calls[0].url,
    `/2/users/${USER_ID}/owned_lists`,
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.lists.length, 1);
  assertEquals(result.value.lists[0].id, "list1");
  assertEquals(result.value.lists[0].name, "My List");
  assertEquals(result.value.lists[0].description, "A test list");
  assertEquals(result.value.lists[0].private, false);
  assertEquals(result.value.lists[0].followerCount, 10);
  assertEquals(result.value.lists[0].memberCount, 5);
  assertEquals(result.value.lists[0].ownerId, USER_ID);
});

Deno.test("ListsService: createList calls POST /2/lists", async () => {
  const client = createMockClient({
    "/2/lists": {
      ok: true,
      value: {
        data: {
          id: "newlist1",
          name: "New List",
          description: "Fresh list",
          private: true,
          follower_count: 0,
          member_count: 0,
          owner_id: USER_ID,
        },
      },
    },
  });
  const svc = createListsService(client, USER_ID);

  const result = await svc.createList({
    name: "New List",
    description: "Fresh list",
    private: true,
  });

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertEquals(client.calls[0].url, "/2/lists");
  const body = client.calls[0].body as Record<string, unknown>;
  assertEquals(body.name, "New List");
  assertEquals(body.description, "Fresh list");
  assertEquals(body.private, true);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.id, "newlist1");
  assertEquals(result.value.name, "New List");
  assertEquals(result.value.private, true);
});

Deno.test("ListsService: addMember calls POST /2/lists/{id}/members", async () => {
  const client = createMockClient({
    "/2/lists/list1/members": {
      ok: true,
      value: { data: { is_member: true } },
    },
  });
  const svc = createListsService(client, USER_ID);

  const result = await svc.addMember("list1", "memberU1");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "POST");
  assertStringIncludes(client.calls[0].url, "/2/lists/list1/members");
  assertEquals(
    (client.calls[0].body as Record<string, unknown>).user_id,
    "memberU1",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isMember, true);
});

Deno.test("ListsService: removeMember calls DELETE /2/lists/{id}/members/{user_id}", async () => {
  const client = createMockClient({
    "/2/lists/list1/members/memberU2": {
      ok: true,
      value: { data: { is_member: false } },
    },
  });
  const svc = createListsService(client, USER_ID);

  const result = await svc.removeMember("list1", "memberU2");

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "DELETE");
  assertStringIncludes(
    client.calls[0].url,
    "/2/lists/list1/members/memberU2",
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.isMember, false);
});

Deno.test("ListsService: getMembers calls /2/lists/{id}/members", async () => {
  const client = createMockClient({
    "/2/lists/list2/members": {
      ok: true,
      value: {
        data: [
          {
            id: "m1",
            username: "member1",
            name: "Member One",
            description: "First member",
            verified: true,
          },
          {
            id: "m2",
            username: "member2",
            name: "Member Two",
          },
        ],
        meta: { next_token: "members_page2" },
      },
    },
  });
  const svc = createListsService(client, USER_ID);

  const result = await svc.getMembers({ listId: "list2" });

  assertEquals(client.calls.length, 1);
  assertEquals(client.calls[0].method, "GET");
  assertStringIncludes(client.calls[0].url, "/2/lists/list2/members");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.users.length, 2);
  assertEquals(result.value.users[0].id, "m1");
  assertEquals(result.value.users[0].username, "member1");
  assertEquals(result.value.users[0].name, "Member One");
  assertEquals(result.value.users[1].id, "m2");
  assertEquals(result.value.nextToken, "members_page2");
});
