/**
 * Tests for X OAuth 2.0 PKCE authentication manager.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMemorySecretStore } from "../../../src/core/secrets/keychain/keychain.ts";
import { createXAuthManager } from "../../../src/integrations/x/auth/auth.ts";
import type {
  XAuthConfig,
  XTokens,
} from "../../../src/integrations/x/auth/types_auth.ts";

const TEST_CONFIG: XAuthConfig = {
  clientId: "test-client",
  redirectUri: "http://127.0.0.1:3000/auth/x/callback",
  scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
};

function mockFetch(body: unknown, status = 200): typeof fetch {
  return (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

function createTestTokens(overrides: Partial<XTokens> = {}): XTokens {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_at: Date.now() + 600_000,
    scope: "tweet.read tweet.write users.read offline.access",
    token_type: "Bearer",
    clientId: "test-client",
    ...overrides,
  };
}

Deno.test("XAuthManager: getConsentUrl returns URL with required PKCE params", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(store);

  const result = await auth.getConsentUrl(TEST_CONFIG);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const url = new URL(result.value.url);
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("client_id"), "test-client");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:3000/auth/x/callback",
  );
  assertStringIncludes(url.searchParams.get("scope") ?? "", "tweet.read");
  assertEquals(typeof url.searchParams.get("state"), "string");
  assertEquals(typeof url.searchParams.get("code_challenge"), "string");
});

Deno.test("XAuthManager: getConsentUrl returns code_verifier string", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(store);

  const result = await auth.getConsentUrl(TEST_CONFIG);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  assertEquals(typeof result.value.codeVerifier, "string");
  assertEquals(result.value.codeVerifier.length > 0, true);
});

Deno.test("XAuthManager: exchangeCode sends POST with code_verifier and grant_type", async () => {
  let capturedInit: RequestInit | undefined;
  const mockFn: typeof fetch = (_url, init) => {
    capturedInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          scope: "tweet.read",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };

  const store = createMemorySecretStore();
  const auth = createXAuthManager(store, mockFn);

  await auth.exchangeCode("auth-code-123", TEST_CONFIG, "test-verifier");

  assertEquals(capturedInit?.method, "POST");
  const body = capturedInit?.body as string;
  const params = new URLSearchParams(body);
  assertEquals(params.get("code_verifier"), "test-verifier");
  assertEquals(params.get("grant_type"), "authorization_code");
  assertEquals(params.get("code"), "auth-code-123");
});

Deno.test("XAuthManager: exchangeCode stores tokens in secret store on success", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(
    store,
    mockFetch({
      access_token: "stored-access",
      refresh_token: "stored-refresh",
      expires_in: 7200,
      scope: "tweet.read",
      token_type: "Bearer",
    }),
  );

  const result = await auth.exchangeCode("auth-code", TEST_CONFIG, "verifier");
  assertEquals(result.ok, true);

  const stored = await store.getSecret("x:tokens");
  assertEquals(stored.ok, true);
  if (!stored.ok) return;

  const tokens = JSON.parse(stored.value) as XTokens;
  assertEquals(tokens.access_token, "stored-access");
  assertEquals(tokens.refresh_token, "stored-refresh");
});

Deno.test("XAuthManager: exchangeCode returns error on non-ok response", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(
    store,
    mockFetch({ error: "invalid_grant" }, 400),
  );

  const result = await auth.exchangeCode("bad-code", TEST_CONFIG, "verifier");
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(result.error.code, "TOKEN_EXCHANGE_FAILED");
  assertEquals(result.error.status, 400);
});

Deno.test("XAuthManager: getAccessToken returns NO_TOKENS error when no tokens stored", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(store);

  const result = await auth.getAccessToken();
  assertEquals(result.ok, false);
  if (result.ok) return;

  assertEquals(result.error.code, "NO_TOKENS");
});

Deno.test("XAuthManager: getAccessToken returns valid token when not expired", async () => {
  const store = createMemorySecretStore();
  const tokens = createTestTokens({ expires_at: Date.now() + 600_000 });
  await store.setSecret("x:tokens", JSON.stringify(tokens));

  const auth = createXAuthManager(store);
  const result = await auth.getAccessToken();

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "test-access-token");
});

Deno.test("XAuthManager: getAccessToken refreshes expired token", async () => {
  const store = createMemorySecretStore();
  const tokens = createTestTokens({ expires_at: Date.now() - 1000 });
  await store.setSecret("x:tokens", JSON.stringify(tokens));

  const auth = createXAuthManager(
    store,
    mockFetch({
      access_token: "refreshed-access",
      refresh_token: "refreshed-refresh",
      expires_in: 7200,
      scope: "tweet.read",
      token_type: "Bearer",
    }),
  );

  const result = await auth.getAccessToken();
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, "refreshed-access");
});

Deno.test("XAuthManager: getAccessToken returns REFRESH_REVOKED on 401 refresh response", async () => {
  const store = createMemorySecretStore();
  const tokens = createTestTokens({ expires_at: Date.now() - 1000 });
  await store.setSecret("x:tokens", JSON.stringify(tokens));

  const auth = createXAuthManager(
    store,
    mockFetch({ error: "invalid_token" }, 401),
  );

  const result = await auth.getAccessToken();
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.code, "REFRESH_REVOKED");
});

Deno.test("XAuthManager: hasTokens returns false initially and true after storing", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(store);

  assertEquals(await auth.hasTokens(), false);

  const tokens = createTestTokens();
  await auth.storeTokens(tokens);

  assertEquals(await auth.hasTokens(), true);
});

Deno.test("XAuthManager: clearTokens removes stored tokens", async () => {
  const store = createMemorySecretStore();
  const auth = createXAuthManager(store);

  const tokens = createTestTokens();
  await auth.storeTokens(tokens);
  assertEquals(await auth.hasTokens(), true);

  await auth.clearTokens();
  assertEquals(await auth.hasTokens(), false);
});
