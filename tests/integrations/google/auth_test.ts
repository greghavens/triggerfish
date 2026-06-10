/**
 * Google OAuth2 auth manager tests.
 *
 * Tests consent URL generation, code exchange, token refresh,
 * revocation error handling, and store/clear/has operations.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMemorySecretStore } from "../../../src/core/secrets/keychain/keychain.ts";
import { createGoogleAuthManager } from "../../../src/integrations/google/auth/auth.ts";
import type {
  GoogleAuthConfig,
  GoogleTokens,
} from "../../../src/integrations/google/types.ts";

const TEST_CONFIG: GoogleAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:8765/callback",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

/** Create a mock fetch that returns a configurable response. */
function createMockFetch(
  status: number,
  body: Record<string, unknown>,
): typeof globalThis.fetch {
  return (_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

// ─── Consent URL ────────────────────────────────────────────────────────────

Deno.test("getConsentUrl: builds correct URL with all parameters", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  const result = await manager.getConsentUrl(TEST_CONFIG);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const url = result.value.url;

  assertStringIncludes(url, "accounts.google.com");
  assertStringIncludes(url, "client_id=test-client-id");
  assertStringIncludes(url, "redirect_uri=");
  assertStringIncludes(url, "response_type=code");
  assertStringIncludes(url, "access_type=offline");
  assertStringIncludes(url, "prompt=consent");
  assertStringIncludes(url, "scope=");
});

Deno.test("getConsentUrl: includes CSRF state and PKCE challenge params", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  const result = await manager.getConsentUrl(TEST_CONFIG);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const url = new URL(result.value.url);
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(typeof url.searchParams.get("state"), "string");
  assertEquals(typeof url.searchParams.get("code_challenge"), "string");
  assertEquals(url.searchParams.get("state"), result.value.state);
  assertEquals(result.value.codeVerifier.length > 0, true);
  // The challenge is a hash of the verifier, never the verifier itself
  assertEquals(
    url.searchParams.get("code_challenge") === result.value.codeVerifier,
    false,
  );
});

Deno.test("getConsentUrl: encodes multiple scopes", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  const config: GoogleAuthConfig = {
    ...TEST_CONFIG,
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  };

  const result = await manager.getConsentUrl(config);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Scopes are space-separated, URL-encoded
  assertStringIncludes(result.value.url, "scope=");
});

// ─── Code Exchange ──────────────────────────────────────────────────────────

Deno.test("exchangeCode: stores tokens on success", async () => {
  const secretStore = createMemorySecretStore();
  const mockFetch = createMockFetch(200, {
    access_token: "at_123",
    refresh_token: "rt_456",
    expires_in: 3600,
    scope: "email",
    token_type: "Bearer",
  });
  const manager = createGoogleAuthManager(secretStore, mockFetch);

  const result = await manager.exchangeCode(
    "auth-code-xyz",
    TEST_CONFIG,
    "test-verifier",
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "at_123");
  }
  assertEquals(await manager.hasTokens(), true);
});

Deno.test("exchangeCode: returns error on failure", async () => {
  const secretStore = createMemorySecretStore();
  const mockFetch = createMockFetch(400, { error: "invalid_grant" });
  const manager = createGoogleAuthManager(secretStore, mockFetch);

  const result = await manager.exchangeCode(
    "bad-code",
    TEST_CONFIG,
    "test-verifier",
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "TOKEN_EXCHANGE_FAILED");
  }
});

// ─── Access Token ───────────────────────────────────────────────────────────

Deno.test("getAccessToken: returns error when no tokens stored", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  const result = await manager.getAccessToken();

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "NO_TOKENS");
  }
});

Deno.test("getAccessToken: returns cached token when not expired", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  const tokens: GoogleTokens = {
    access_token: "fresh_token",
    refresh_token: "rt_456",
    expires_at: Date.now() + 3600 * 1000, // 1 hour from now
    scope: "email",
    token_type: "Bearer",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  };
  await manager.storeTokens(tokens);

  const result = await manager.getAccessToken();

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "fresh_token");
  }
});

Deno.test("getAccessToken: refreshes expired token using stored client credentials", async () => {
  const secretStore = createMemorySecretStore();
  let capturedBody = "";
  const mockFetch = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body as string ?? "";
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "refreshed_token",
          expires_in: 3600,
          scope: "email",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };
  const manager = createGoogleAuthManager(secretStore, mockFetch);

  // Store tokens with expired access token but valid refresh token + client creds
  await manager.storeTokens({
    access_token: "expired_token",
    refresh_token: "rt_stored",
    expires_at: Date.now() - 1000, // Already expired
    scope: "email",
    token_type: "Bearer",
    clientId: "stored-client-id",
    clientSecret: "stored-client-secret",
  });

  const result = await manager.getAccessToken();

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "refreshed_token");
  }
  // Verify the refresh request used client credentials from the stored tokens, not env vars
  assertStringIncludes(capturedBody, "client_id=stored-client-id");
  assertStringIncludes(capturedBody, "client_secret=stored-client-secret");
  assertStringIncludes(capturedBody, "refresh_token=rt_stored");
});

// ─── Store / Clear / Has ────────────────────────────────────────────────────

Deno.test("hasTokens: returns false when empty", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);
  assertEquals(await manager.hasTokens(), false);
});

Deno.test("storeTokens + hasTokens: returns true after store", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  await manager.storeTokens({
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 3600000,
    scope: "email",
    token_type: "Bearer",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });

  assertEquals(await manager.hasTokens(), true);
});

Deno.test("clearTokens: removes tokens", async () => {
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore);

  await manager.storeTokens({
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 3600000,
    scope: "email",
    token_type: "Bearer",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });
  assertEquals(await manager.hasTokens(), true);

  await manager.clearTokens();
  assertEquals(await manager.hasTokens(), false);
});

// ─── PKCE code exchange ─────────────────────────────────────────────────────

Deno.test("exchangeCode: sends code_verifier in the token POST body", async () => {
  let capturedBody = "";
  const mockFetch = (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = init?.body as string ?? "";
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "email",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore, mockFetch);

  await manager.exchangeCode("auth-code-123", TEST_CONFIG, "pkce-verifier");

  const params = new URLSearchParams(capturedBody);
  assertEquals(params.get("code_verifier"), "pkce-verifier");
  assertEquals(params.get("grant_type"), "authorization_code");
  assertEquals(params.get("code"), "auth-code-123");
});

Deno.test("exchangeCode: truncates raw error bodies to 200 chars", async () => {
  const longError = "x".repeat(5000);
  const mockFetch = (_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(longError, { status: 400 }));
  const secretStore = createMemorySecretStore();
  const manager = createGoogleAuthManager(secretStore, mockFetch);

  const result = await manager.exchangeCode("code", TEST_CONFIG, "verifier");

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.length < 300, true);
  }
});

// ─── Stored token validation ────────────────────────────────────────────────

Deno.test("getAccessToken: clears corrupt (non-JSON) stored tokens", async () => {
  const secretStore = createMemorySecretStore();
  await secretStore.setSecret("google:tokens", "not valid json{{{");
  const manager = createGoogleAuthManager(secretStore);

  const result = await manager.getAccessToken();

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "NO_TOKENS");
  assertEquals((await secretStore.getSecret("google:tokens")).ok, false);
});

Deno.test("getAccessToken: clears stored tokens missing required fields", async () => {
  const secretStore = createMemorySecretStore();
  await secretStore.setSecret(
    "google:tokens",
    JSON.stringify({ refresh_token: "rt-only" }),
  );
  const manager = createGoogleAuthManager(secretStore);

  const result = await manager.getAccessToken();

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "NO_TOKENS");
  assertEquals((await secretStore.getSecret("google:tokens")).ok, false);
});

// ─── OAuth callback handler (CSRF state + replay) ───────────────────────────

Deno.test("buildOAuthRequestHandler: rejects a state mismatch with 400", async () => {
  const { buildOAuthRequestHandler } = await import(
    "../../../src/cli/commands/connect_google.ts"
  );
  let rejected: Error | null = null;
  const handler = buildOAuthRequestHandler(
    () => {},
    (err) => {
      rejected = err;
    },
    () => "expected-state",
  );

  const response = handler(
    new Request("http://127.0.0.1/?code=abc&state=wrong-state"),
  );

  assertEquals(response.status, 400);
  assertEquals(rejected !== null, true);
  assertStringIncludes(String(rejected), "state mismatch");
});

Deno.test("buildOAuthRequestHandler: resolves the code when state matches", async () => {
  const { buildOAuthRequestHandler } = await import(
    "../../../src/cli/commands/connect_google.ts"
  );
  let resolvedCode: string | null = null;
  const handler = buildOAuthRequestHandler(
    (code) => {
      resolvedCode = code;
    },
    () => {},
    () => "expected-state",
  );

  const response = handler(
    new Request("http://127.0.0.1/?code=abc&state=expected-state"),
  );

  assertEquals(response.status, 200);
  assertEquals(resolvedCode, "abc");
});

Deno.test("buildOAuthRequestHandler: processes exactly one callback", async () => {
  const { buildOAuthRequestHandler } = await import(
    "../../../src/cli/commands/connect_google.ts"
  );
  let resolveCount = 0;
  const handler = buildOAuthRequestHandler(
    () => {
      resolveCount++;
    },
    () => {},
    () => "s",
  );

  handler(new Request("http://127.0.0.1/?code=first&state=s"));
  const second = handler(new Request("http://127.0.0.1/?code=second&state=s"));

  assertEquals(resolveCount, 1);
  assertStringIncludes(await second.text(), "already processed");
});

Deno.test("buildOAuthRequestHandler: rejects a callback before the state is known", async () => {
  const { buildOAuthRequestHandler } = await import(
    "../../../src/cli/commands/connect_google.ts"
  );
  let rejected: Error | null = null;
  const handler = buildOAuthRequestHandler(
    () => {},
    (err) => {
      rejected = err;
    },
    () => null,
  );

  const response = handler(
    new Request("http://127.0.0.1/?code=abc&state=anything"),
  );

  assertEquals(response.status, 400);
  assertEquals(rejected !== null, true);
});
