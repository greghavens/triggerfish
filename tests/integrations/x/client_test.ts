/**
 * Tests for X API v2 authenticated HTTP client.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { XAuthManager } from "../../../src/integrations/x/auth/types_auth.ts";
import type { XRateLimiter } from "../../../src/integrations/x/client/rate_limiter.ts";
import { createXApiClient as _createXApiClient } from "../../../src/integrations/x/auth/client.ts";

/** No-op SSRF check for tests — always passes. */
function noopSsrfCheck(
  _hostname: string,
): Promise<{ ok: true; value: string }> {
  return Promise.resolve({ ok: true as const, value: "1.2.3.4" });
}

/** Test wrapper that injects the no-op SSRF check by default. */
function createXApiClient(
  authManager: XAuthManager,
  rateLimiter: XRateLimiter,
  opts?: {
    readonly fetchFn?: typeof globalThis.fetch;
    readonly baseUrl?: string;
  },
): ReturnType<typeof _createXApiClient> {
  return _createXApiClient(authManager, rateLimiter, {
    ...opts,
    ssrfCheck: noopSsrfCheck,
  });
}

function createMockAuthManager(token = "test-token"): XAuthManager {
  return {
    getConsentUrl: () =>
      Promise.resolve({
        ok: true,
        value: { url: "", codeVerifier: "", state: "" },
      }),
    exchangeCode: () => Promise.resolve({ ok: true, value: token }),
    getAccessToken: () => Promise.resolve({ ok: true, value: token }),
    forceRefresh: () => Promise.resolve({ ok: true, value: token }),
    storeTokens: () => Promise.resolve(),
    clearTokens: () => Promise.resolve(),
    hasTokens: () => Promise.resolve(true),
  };
}

function createMockRateLimiter(): XRateLimiter & {
  recorded: { endpoint: string; headers: Headers }[];
} {
  const recorded: { endpoint: string; headers: Headers }[] = [];
  return {
    recorded,
    recordResponse: (endpoint: string, headers: Headers) => {
      recorded.push({ endpoint, headers });
    },
    checkLimit: () => ({ ok: true as const }),
    reset: () => {},
  };
}

function mockFetch(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): typeof fetch {
  return (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
    );
  };
}

function capturingFetch(
  body: unknown,
  status = 200,
): { fetchFn: typeof fetch; captured: { url: string; init: RequestInit }[] } {
  const captured: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    captured.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { fetchFn, captured };
}

Deno.test("XAuthManager: get sends Bearer auth header", async () => {
  const { fetchFn, captured } = capturingFetch({ data: {} });
  const client = createXApiClient(
    createMockAuthManager("my-token"),
    createMockRateLimiter(),
    {
      fetchFn,
    },
  );

  await client.get("/2/tweets");

  assertEquals(captured.length, 1);
  const authHeader =
    (captured[0].init.headers as Record<string, string>)["Authorization"];
  assertEquals(authHeader, "Bearer my-token");
});

Deno.test("XAuthManager: get appends query params to URL", async () => {
  const { fetchFn, captured } = capturingFetch({ data: {} });
  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    { fetchFn },
  );

  await client.get("/2/tweets", {
    "tweet.fields": "created_at",
    max_results: "10",
  });

  assertStringIncludes(captured[0].url, "tweet.fields=created_at");
  assertStringIncludes(captured[0].url, "max_results=10");
});

Deno.test("XAuthManager: post sends JSON body with Content-Type header", async () => {
  const { fetchFn, captured } = capturingFetch({ data: { id: "123" } });
  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    { fetchFn },
  );

  await client.post("/2/tweets", { text: "Hello world" });

  assertEquals(captured[0].init.method, "POST");
  const headers = captured[0].init.headers as Record<string, string>;
  assertEquals(headers["Content-Type"], "application/json");
  assertEquals(captured[0].init.body, JSON.stringify({ text: "Hello world" }));
});

Deno.test("XAuthManager: del sends DELETE method", async () => {
  const { fetchFn, captured } = capturingFetch({ deleted: true });
  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    { fetchFn },
  );

  await client.del("/2/tweets/123");

  assertEquals(captured[0].init.method, "DELETE");
});

Deno.test("XAuthManager: rate limiter blocks request when endpoint exhausted", async () => {
  const rateLimiter: XRateLimiter = {
    recordResponse: () => {},
    checkLimit: () => ({
      ok: false,
      error: {
        endpoint: "/2/tweets",
        resetAt: Math.floor(Date.now() / 1000) + 900,
        message: "X API rate limit exhausted for /2/tweets",
      },
    }),
    reset: () => {},
  };

  const client = createXApiClient(createMockAuthManager(), rateLimiter, {
    fetchFn: mockFetch({}),
  });

  const result = await client.get("/2/tweets");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.code, "RATE_LIMITED");
});

Deno.test("XAuthManager: records rate limit headers from response", async () => {
  const rateLimiter = createMockRateLimiter();
  const fetchFn = mockFetch({ data: {} }, 200, {
    "x-rate-limit-remaining": "149",
    "x-rate-limit-reset": "1700000000",
  });

  const client = createXApiClient(createMockAuthManager(), rateLimiter, {
    fetchFn,
  });
  await client.get("/2/tweets");

  assertEquals(rateLimiter.recorded.length, 1);
  assertEquals(
    rateLimiter.recorded[0].headers.get("x-rate-limit-remaining"),
    "149",
  );
  assertEquals(
    rateLimiter.recorded[0].headers.get("x-rate-limit-reset"),
    "1700000000",
  );
});

Deno.test("XAuthManager: retries on 401 with force-refreshed token", async () => {
  let callCount = 0;
  let tokenCallCount = 0;
  let forceRefreshCount = 0;
  const authManager: XAuthManager = {
    ...createMockAuthManager(),
    getAccessToken: () => {
      tokenCallCount++;
      return Promise.resolve({ ok: true, value: `token-${tokenCallCount}` });
    },
    forceRefresh: () => {
      forceRefreshCount++;
      return Promise.resolve({ ok: true, value: "refreshed-token" });
    },
  };

  const fetchFn: typeof fetch = (_url, _init?) => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: { id: "1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const client = createXApiClient(authManager, createMockRateLimiter(), {
    fetchFn,
  });
  const result = await client.get("/2/users/me");

  assertEquals(result.ok, true);
  assertEquals(callCount, 2);
  assertEquals(forceRefreshCount, 1);
  assertEquals(tokenCallCount, 2);
});

Deno.test("XAuthManager: parses X API error format with detail and title fields", async () => {
  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    {
      fetchFn: mockFetch(
        {
          detail: "Tweet not found",
          title: "Not Found Error",
          type: "about:blank",
        },
        404,
      ),
    },
  );

  const result = await client.get("/2/tweets/999");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.message, "Tweet not found");
  assertEquals(result.error.status, 404);
});

Deno.test("XAuthManager: handles 204 No Content as success", async () => {
  const fetchFn: typeof fetch = (_url, _init?) => {
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    { fetchFn },
  );
  const result = await client.del("/2/users/me/likes/123");

  assertEquals(result.ok, true);
});

Deno.test("XAuthManager: handles 429 rate limited response", async () => {
  const client = createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    {
      fetchFn: mockFetch(
        { detail: "Too Many Requests", title: "Rate Limit Exceeded" },
        429,
        { "retry-after": "300" },
      ),
    },
  );

  const result = await client.get("/2/tweets");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.status, 429);
  assertEquals(result.error.retryAfterSeconds, 300);
  assertStringIncludes(result.error.message, "Too Many Requests");
});

Deno.test("XAuthManager: blocks request when DNS resolves to private IP", async () => {
  const privateSsrfCheck = (_hostname: string) =>
    Promise.resolve({
      ok: false as const,
      error: "SSRF blocked: api.twitter.com resolves to private IP 127.0.0.1",
    });

  const client = _createXApiClient(
    createMockAuthManager(),
    createMockRateLimiter(),
    {
      fetchFn: mockFetch({}),
      ssrfCheck: privateSsrfCheck,
    },
  );

  const result = await client.get("/2/tweets");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.code, "SSRF_BLOCKED");
  assertStringIncludes(result.error.message, "private IP");
});
