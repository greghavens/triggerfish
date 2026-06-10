/**
 * Google Workspace integration tests.
 *
 * Exercises the full pipeline: auth → client → services → executor
 * using a local mock HTTP server. No real Google credentials needed.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMemorySecretStore } from "../../../src/core/secrets/keychain/keychain.ts";
import { createGoogleAuthManager } from "../../../src/integrations/google/auth/auth.ts";
import { createGoogleApiClient } from "../../../src/integrations/google/auth/client.ts";
import { createGmailService } from "../../../src/integrations/google/gmail/gmail.ts";
import { createCalendarService } from "../../../src/integrations/google/calendar/calendar.ts";
import { createDriveService } from "../../../src/integrations/google/drive/drive.ts";
import { createGoogleToolExecutor } from "../../../src/integrations/google/tools.ts";
import { createTasksService } from "../../../src/integrations/google/tasks/tasks.ts";
import { createSheetsService } from "../../../src/integrations/google/sheets/sheets.ts";
import type {
  GoogleAuthConfig,
  GoogleTokens,
} from "../../../src/integrations/google/types.ts";
import type { SessionId } from "../../../src/core/types/session.ts";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";

// ─── Mock Google Server ─────────────────────────────────────────────────────

/** Create a mock Google API server on a random port. */
function createMockGoogleServer(): {
  server: Deno.HttpServer;
  baseUrl: string;
} {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      const url = new URL(req.url);
      const path = url.pathname;

      // OAuth token endpoint
      if (path === "/token" && req.method === "POST") {
        return new Response(
          JSON.stringify({
            access_token: "mock_access_token",
            refresh_token: "mock_refresh_token",
            expires_in: 3600,
            scope: "email",
            token_type: "Bearer",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Gmail: list messages
      if (
        path.includes("/gmail/v1/users/me/messages") &&
        !path.includes("/messages/msg")
      ) {
        return new Response(
          JSON.stringify({
            messages: [{ id: "msg1" }, { id: "msg2" }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Gmail: get message
      if (path.includes("/gmail/v1/users/me/messages/msg")) {
        const msgId = path.split("/").pop()!;
        return new Response(
          JSON.stringify({
            id: msgId,
            threadId: "t1",
            snippet: "Hello from integration test",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "alice@example.com" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: "Integration Test Email" },
                { name: "Date", value: "2025-01-20T10:00:00Z" },
              ],
              body: {
                data: btoa("This is the email body").replace(/\+/g, "-")
                  .replace(/\//g, "_"),
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Calendar: create event
      if (
        path.includes("/calendar/v3/calendars/primary/events") &&
        req.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            id: "evt_integration",
            summary: "Integration Meeting",
            start: { dateTime: "2025-01-20T14:00:00Z" },
            end: { dateTime: "2025-01-20T15:00:00Z" },
            htmlLink: "https://calendar.google.com/event/evt_integration",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Drive: get file metadata (Google Doc)
      if (
        path.match(/\/drive\/v3\/files\/doc1$/) && !url.searchParams.has("alt")
      ) {
        return new Response(
          JSON.stringify({
            id: "doc1",
            name: "Integration Doc",
            mimeType: "application/vnd.google-apps.document",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      // Drive: export Google Doc
      if (path.includes("/drive/v3/files/doc1/export")) {
        return new Response(
          JSON.stringify("Exported integration document content"),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Drive: search files
      if (path.includes("/drive/v3/files") && !path.includes("doc1")) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: "doc1",
                name: "Integration Doc",
                mimeType: "application/vnd.google-apps.document",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  const addr = server.addr as Deno.NetAddr;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/** Create a fetch function that rewrites Google API URLs to the mock server. */
function createMockFetch(baseUrl: string): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    let url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;

    // Rewrite Google API URLs to mock server
    url = url.replace("https://oauth2.googleapis.com", baseUrl);
    url = url.replace("https://gmail.googleapis.com", baseUrl);
    url = url.replace("https://www.googleapis.com", baseUrl);
    url = url.replace("https://accounts.google.com", baseUrl);
    url = url.replace("https://sheets.googleapis.com", baseUrl);

    return globalThis.fetch(url, init);
  };
}

const TEST_CONFIG: GoogleAuthConfig = {
  clientId: "integration-client-id",
  clientSecret: "integration-client-secret",
  redirectUri: "http://localhost:0/callback",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

Deno.test("integration: connect → gmail_search → disconnect", async () => {
  const { server, baseUrl } = createMockGoogleServer();
  const mockFetch = createMockFetch(baseUrl);

  try {
    const secretStore = createMemorySecretStore();
    const authManager = createGoogleAuthManager(secretStore, mockFetch);

    // Connect: exchange code for tokens
    const exchangeResult = await authManager.exchangeCode(
      "fake-auth-code",
      TEST_CONFIG,
      "test-verifier",
    );
    assertEquals(exchangeResult.ok, true);

    // Verify tokens are stored with client credentials
    assertEquals(await authManager.hasTokens(), true);
    const storedRaw = await secretStore.getSecret("google:tokens");
    assertEquals(storedRaw.ok, true);
    if (storedRaw.ok) {
      const stored = JSON.parse(storedRaw.value) as GoogleTokens;
      assertEquals(stored.clientId, "integration-client-id");
      assertEquals(stored.clientSecret, "integration-client-secret");
    }

    // Use: search Gmail
    const apiClient = createGoogleApiClient(authManager, mockFetch);
    const gmail = createGmailService(apiClient);

    const searchResult = await gmail.search({ query: "test" });
    assertEquals(searchResult.ok, true);
    if (searchResult.ok) {
      assertEquals(searchResult.value.length, 2);
      assertEquals(searchResult.value[0].from, "alice@example.com");
      assertEquals(searchResult.value[0].subject, "Integration Test Email");
    }

    // Disconnect: clear tokens
    await authManager.clearTokens();
    assertEquals(await authManager.hasTokens(), false);
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration: calendar_create returns event with link", async () => {
  const { server, baseUrl } = createMockGoogleServer();
  const mockFetch = createMockFetch(baseUrl);

  try {
    const secretStore = createMemorySecretStore();
    const authManager = createGoogleAuthManager(secretStore, mockFetch);
    await authManager.exchangeCode("fake-code", TEST_CONFIG, "test-verifier");

    const apiClient = createGoogleApiClient(authManager, mockFetch);
    const calendar = createCalendarService(apiClient);

    const result = await calendar.create({
      summary: "Integration Meeting",
      start: "2025-01-20T14:00:00Z",
      end: "2025-01-20T15:00:00Z",
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.id, "evt_integration");
      assertEquals(result.value.summary, "Integration Meeting");
      assertEquals(
        result.value.htmlLink,
        "https://calendar.google.com/event/evt_integration",
      );
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration: drive_read exports Google Doc", async () => {
  const { server, baseUrl } = createMockGoogleServer();
  const mockFetch = createMockFetch(baseUrl);

  try {
    const secretStore = createMemorySecretStore();
    const authManager = createGoogleAuthManager(secretStore, mockFetch);
    await authManager.exchangeCode("fake-code", TEST_CONFIG, "test-verifier");

    const apiClient = createGoogleApiClient(authManager, mockFetch);
    const drive = createDriveService(apiClient);

    const result = await drive.read("doc1");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "Exported integration document content");
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration: expired token triggers refresh using stored client creds", async () => {
  const { server, baseUrl } = createMockGoogleServer();
  let capturedRefreshBody = "";
  const interceptFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    let url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    url = url.replace("https://oauth2.googleapis.com", baseUrl);
    url = url.replace("https://gmail.googleapis.com", baseUrl);
    url = url.replace("https://www.googleapis.com", baseUrl);

    // Capture the refresh token request body
    if (url.includes("/token") && init?.body) {
      capturedRefreshBody = init.body as string;
    }
    return globalThis.fetch(url, init);
  };

  try {
    const secretStore = createMemorySecretStore();
    const authManager = createGoogleAuthManager(secretStore, interceptFetch);

    // Store tokens with expired access token
    await authManager.storeTokens({
      access_token: "expired_token",
      refresh_token: "rt_stored",
      expires_at: Date.now() - 10000, // Already expired
      scope: "email",
      token_type: "Bearer",
      clientId: "stored-cid",
      clientSecret: "stored-csecret",
    });

    // Getting an access token should trigger a refresh
    const result = await authManager.getAccessToken();
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, "mock_access_token");
    }

    // Verify refresh used stored client credentials, not env vars
    assertStringIncludes(capturedRefreshBody, "client_id=stored-cid");
    assertStringIncludes(capturedRefreshBody, "client_secret=stored-csecret");
    assertStringIncludes(capturedRefreshBody, "refresh_token=rt_stored");
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration: executor routes google_gmail search end-to-end", async () => {
  const { server, baseUrl } = createMockGoogleServer();
  const mockFetch = createMockFetch(baseUrl);

  try {
    const secretStore = createMemorySecretStore();
    const authManager = createGoogleAuthManager(secretStore, mockFetch);
    await authManager.exchangeCode("fake-code", TEST_CONFIG, "test-verifier");

    const apiClient = createGoogleApiClient(authManager, mockFetch);
    const executor = createGoogleToolExecutor({
      gmail: createGmailService(apiClient),
      calendar: createCalendarService(apiClient),
      tasks: createTasksService(apiClient),
      drive: createDriveService(apiClient),
      sheets: createSheetsService(apiClient),
      sessionTaint: () => "INTERNAL" as ClassificationLevel,
      sourceSessionId: "integration-session" as SessionId,
    });

    const result = await executor("google_gmail", {
      action: "search",
      query: "test",
    });
    assertEquals(result !== null, true);

    // Should contain email data from mock
    assertStringIncludes(result!, "alice@example.com");
    assertStringIncludes(result!, "Integration Test Email");
  } finally {
    await server.shutdown();
  }
});

Deno.test("integration: executor returns clear error when not connected", async () => {
  const secretStore = createMemorySecretStore();
  // Don't exchange any code — no tokens stored
  const authManager = createGoogleAuthManager(secretStore);
  const apiClient = createGoogleApiClient(authManager);
  const executor = createGoogleToolExecutor({
    gmail: createGmailService(apiClient),
    calendar: createCalendarService(apiClient),
    tasks: createTasksService(apiClient),
    drive: createDriveService(apiClient),
    sheets: createSheetsService(apiClient),
    sessionTaint: () => "INTERNAL" as ClassificationLevel,
    sourceSessionId: "no-auth-session" as SessionId,
  });

  const result = await executor("google_gmail", {
    action: "search",
    query: "test",
  });
  assertEquals(result !== null, true);
  assertStringIncludes(result!, "triggerfish connect google");
});
