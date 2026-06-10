/**
 * @module
 *
 * CalDAV HTTP client read operation tests.
 *
 * Tests PROPFIND and REPORT operations with mock fetch,
 * including header verification, response parsing, and error handling.
 */
import { assertEquals } from "@std/assert";
import { createCalDavClient } from "../../../src/integrations/caldav/client.ts";
import { createSsrfCheckedFetch } from "../../../src/core/security/mod.ts";

/** Create a mock fetch function from a handler. */
function createMockFetch(
  handler: (url: string, init: RequestInit) => Response,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string"
      ? url
      : url instanceof URL
      ? url.toString()
      : url.url;
    return Promise.resolve(handler(urlStr, init ?? {}));
  }) as typeof fetch;
}

/** Create a 207 Multi-Status response with XML body. */
function multiStatusResponse(xml: string): Response {
  return new Response(xml, {
    status: 207,
    headers: { "Content-Type": "application/xml" },
  });
}

// ─── PROPFIND Tests ───────────────────────────────────────────────────────────

Deno.test("client: PROPFIND sends correct headers and parses response", async () => {
  let capturedHeaders: Record<string, string> = {};
  let capturedMethod = "";

  const mockFetch = createMockFetch((_url, init) => {
    capturedMethod = init.method ?? "";
    capturedHeaders = Object.fromEntries(
      Object.entries(init.headers ?? {}),
    );
    return multiStatusResponse(`
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/calendars/user/</d:href>
          <d:propstat>
            <d:prop>
              <d:displayname>My Calendar</d:displayname>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>
    `);
  });

  const client = createCalDavClient({
    baseUrl: "https://caldav.example.com",
    authHeaders: { Authorization: "Basic dGVzdDp0ZXN0" },
    fetchFn: mockFetch,
  });

  const result = await client.propfind("/calendars/user/", "1", [
    "displayname",
  ]);

  assertEquals(capturedMethod, "PROPFIND");
  assertEquals(capturedHeaders["Depth"], "1");
  assertEquals(
    capturedHeaders["Content-Type"],
    "application/xml; charset=utf-8",
  );
  assertEquals(capturedHeaders["Authorization"], "Basic dGVzdDp0ZXN0");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.responses.length, 1);
    assertEquals(result.value.responses[0].href, "/calendars/user/");
    assertEquals(
      result.value.responses[0].properties["displayname"],
      "My Calendar",
    );
  }
});

Deno.test("client: PROPFIND handles current-user-principal", async () => {
  const mockFetch = createMockFetch(() =>
    multiStatusResponse(`
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/</d:href>
          <d:propstat>
            <d:prop>
              <d:current-user-principal>
                <d:href>/principals/users/testuser/</d:href>
              </d:current-user-principal>
            </d:prop>
          </d:propstat>
        </d:response>
      </d:multistatus>
    `)
  );

  const client = createCalDavClient({
    baseUrl: "https://caldav.example.com",
    authHeaders: {},
    fetchFn: mockFetch,
  });

  const result = await client.propfind("/", "0", ["current-user-principal"]);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.responses[0].properties["current-user-principal"],
      "/principals/users/testuser/",
    );
  }
});

Deno.test("client: PROPFIND maps HTTP error to CalDavError", async () => {
  const mockFetch = createMockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );

  const client = createCalDavClient({
    baseUrl: "https://caldav.example.com",
    authHeaders: {},
    fetchFn: mockFetch,
  });

  const result = await client.propfind("/", "0", ["displayname"]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.status, 401);
  }
});

// ─── REPORT Tests ─────────────────────────────────────────────────────────────

Deno.test("client: REPORT sends correct body and parses calendar data", async () => {
  let capturedBody = "";

  const mockFetch = createMockFetch((_url, init) => {
    capturedBody = typeof init.body === "string" ? init.body : "";
    return multiStatusResponse(`
      <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/calendars/user/default/event1.ics</d:href>
          <d:propstat>
            <d:prop>
              <d:getetag>"etag-123"</d:getetag>
              <c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-uid-1
SUMMARY:Test Event
DTSTART:20250315T100000Z
DTEND:20250315T110000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
            </d:prop>
          </d:propstat>
        </d:response>
      </d:multistatus>
    `);
  });

  const client = createCalDavClient({
    baseUrl: "https://caldav.example.com",
    authHeaders: {},
    fetchFn: mockFetch,
  });

  const reportBody =
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:prop><d:getetag /><c:calendar-data /></d:prop>
    <c:filter><c:comp-filter name="VCALENDAR" /></c:filter>
  </c:calendar-query>`;

  const result = await client.report("/calendars/user/default/", reportBody);

  assertEquals(capturedBody.includes("calendar-query"), true);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.resources.length, 1);
    assertEquals(result.value.resources[0].etag, "etag-123");
    assertEquals(
      result.value.resources[0].calendarData.includes("VEVENT"),
      true,
    );
  }
});

// ─── SSRF-checked fetchFn ─────────────────────────────────────────────────────

Deno.test("client: PROPFIND is blocked by an SSRF-checked fetchFn", async () => {
  const blockChecker = (hostname: string) =>
    Promise.resolve({
      ok: false as const,
      error: `SSRF blocked: ${hostname} resolves to private IP`,
    });
  const client = createCalDavClient({
    baseUrl: "https://caldav.internal.example.com",
    authHeaders: {},
    fetchFn: createSsrfCheckedFetch(blockChecker),
  });

  const result = await client.propfind("/calendars/user/", "1", [
    "displayname",
  ]);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("Outbound fetch blocked"), true);
  }
});
