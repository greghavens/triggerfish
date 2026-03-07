/**
 * Tests for Triggerfish Cloud setup flows.
 *
 * Uses injected mock fetchers — no real network calls.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createCheckoutSession,
  pollDeviceCode,
  pollDeviceCodeLoop,
  PRODUCTION_GATEWAY_URL,
  requestDeviceCode,
  resolveGatewayUrl,
  SANDBOX_GATEWAY_URL,
  sendMagicLink,
  startCallbackServer,
  validateLicenseKey,
} from "../../src/dive/cloud.ts";

// ─── Mock fetcher helpers ────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetcher(status: number, body: unknown): typeof fetch {
  return (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(jsonResponse(status, body));
  };
}

function networkErrorFetcher(): typeof fetch {
  return (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.reject(new TypeError("Failed to fetch"));
  };
}

/**
 * Create a mock fetcher that captures the request URL and headers.
 */
function capturingFetcher(
  status: number,
  body: unknown,
): {
  fetcher: typeof fetch;
  readonly captured: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
} {
  const captured = {
    url: "",
    method: "",
    headers: {} as Record<string, string>,
    body: "",
  };
  const fetcher = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.url = typeof url === "string"
      ? url
      : url instanceof URL
      ? url.toString()
      : url.url;
    captured.method = init?.method ?? "GET";
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          captured.headers[k] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          captured.headers[k] = v;
        }
      } else {
        Object.assign(captured.headers, h);
      }
    }
    if (init?.body && typeof init.body === "string") {
      captured.body = init.body;
    }
    return Promise.resolve(jsonResponse(status, body));
  };
  return { fetcher, captured };
}

// ─── resolveGatewayUrl ───────────────────────────────────────────────────────

Deno.test("Cloud: resolveGatewayUrl returns sandbox for tf_test_ keys", () => {
  assertEquals(
    resolveGatewayUrl("tf_test_abc123"),
    SANDBOX_GATEWAY_URL,
  );
});

Deno.test("Cloud: resolveGatewayUrl returns production for tf_live_ keys", () => {
  assertEquals(
    resolveGatewayUrl("tf_live_abc123"),
    PRODUCTION_GATEWAY_URL,
  );
});

Deno.test("Cloud: resolveGatewayUrl returns production for unknown prefix", () => {
  assertEquals(
    resolveGatewayUrl("some_random_key"),
    PRODUCTION_GATEWAY_URL,
  );
});

// ─── createCheckoutSession ───────────────────────────────────────────────────

Deno.test("Cloud: createCheckoutSession sends correct request", async () => {
  const { fetcher, captured } = capturingFetcher(200, {
    checkout_url: "https://checkout.stripe.com/test",
  });

  const result = await createCheckoutSession(
    "https://api.test",
    "flow-123",
    9999,
    "pro",
    fetcher,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      result.value.checkout_url,
      "https://checkout.stripe.com/test",
    );
  }
  assertEquals(captured.url, "https://api.test/v1/setup/checkout-session");
  assertEquals(captured.method, "POST");
  assertStringIncludes(captured.body, '"flow_id":"flow-123"');
  assertStringIncludes(captured.body, '"port":9999');
  assertStringIncludes(captured.body, '"plan":"pro"');
});

Deno.test("Cloud: createCheckoutSession returns error on HTTP failure", async () => {
  const result = await createCheckoutSession(
    "https://api.test",
    "flow-123",
    9999,
    undefined,
    mockFetcher(400, { error: "plan_not_configured" }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "400");
  }
});

Deno.test("Cloud: createCheckoutSession returns error on network failure", async () => {
  const result = await createCheckoutSession(
    "https://api.test",
    "flow-123",
    9999,
    undefined,
    networkErrorFetcher(),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "Could not reach");
  }
});

// ─── sendMagicLink ───────────────────────────────────────────────────────────

Deno.test("Cloud: sendMagicLink sends correct request", async () => {
  const { fetcher, captured } = capturingFetcher(200, { sent: true });

  const result = await sendMagicLink(
    "https://api.test",
    "user@example.com",
    "flow-456",
    8888,
    fetcher,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.sent, true);
  }
  assertEquals(captured.url, "https://api.test/v1/setup/magic-link");
  assertEquals(captured.method, "POST");
  assertStringIncludes(captured.body, '"email":"user@example.com"');
  assertStringIncludes(captured.body, '"flow_id":"flow-456"');
  assertStringIncludes(captured.body, '"port":8888');
});

Deno.test("Cloud: sendMagicLink returns error on HTTP failure", async () => {
  const result = await sendMagicLink(
    "https://api.test",
    "user@example.com",
    "flow-456",
    8888,
    mockFetcher(500, { error: "internal" }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "500");
  }
});

// ─── requestDeviceCode ───────────────────────────────────────────────────────

Deno.test("Cloud: requestDeviceCode sends POST and parses response", async () => {
  const { fetcher, captured } = capturingFetcher(200, {
    code: "FISH-7K3M",
    expires_in: 600,
    verification_url: "https://trigger.fish/device",
    poll_url: "/v1/device/poll?code=FISH-7K3M",
  });

  const result = await requestDeviceCode("https://api.test", fetcher);

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.code, "FISH-7K3M");
    assertEquals(result.value.expires_in, 600);
    assertEquals(
      result.value.verification_url,
      "https://trigger.fish/device",
    );
  }
  assertEquals(captured.url, "https://api.test/v1/device/request");
  assertEquals(captured.method, "POST");
});

// ─── pollDeviceCode ──────────────────────────────────────────────────────────

Deno.test("Cloud: pollDeviceCode returns pending status", async () => {
  const result = await pollDeviceCode(
    "https://api.test",
    "FISH-7K3M",
    mockFetcher(200, { status: "pending" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "pending");
  }
});

Deno.test("Cloud: pollDeviceCode returns complete with key", async () => {
  const result = await pollDeviceCode(
    "https://api.test",
    "FISH-7K3M",
    mockFetcher(200, { status: "complete", key: "tf_test_key123" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "complete");
    assertEquals(result.value.key, "tf_test_key123");
  }
});

Deno.test("Cloud: pollDeviceCode returns expired on 410", async () => {
  const result = await pollDeviceCode(
    "https://api.test",
    "FISH-7K3M",
    mockFetcher(410, { status: "expired" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.status, "expired");
  }
});

Deno.test("Cloud: pollDeviceCode sends code as query parameter", async () => {
  const { fetcher, captured } = capturingFetcher(200, { status: "pending" });

  await pollDeviceCode("https://api.test", "FISH-7K3M", fetcher);

  assertEquals(
    captured.url,
    "https://api.test/v1/device/poll?code=FISH-7K3M",
  );
});

// ─── pollDeviceCodeLoop ──────────────────────────────────────────────────────

Deno.test("Cloud: pollDeviceCodeLoop returns key on immediate completion", async () => {
  const result = await pollDeviceCodeLoop(
    "https://api.test",
    "FISH-7K3M",
    600,
    mockFetcher(200, { status: "complete", key: "tf_live_key456" }),
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, "tf_live_key456");
  }
});

Deno.test("Cloud: pollDeviceCodeLoop returns error on expired", async () => {
  const result = await pollDeviceCodeLoop(
    "https://api.test",
    "FISH-7K3M",
    600,
    mockFetcher(410, { status: "expired" }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "expired");
  }
});

// ─── validateLicenseKey ──────────────────────────────────────────────────────

Deno.test("Cloud: validateLicenseKey sends Bearer auth header", async () => {
  const { fetcher, captured } = capturingFetcher(200, {
    valid: true,
    plan: "pro",
    features: ["llm_proxy"],
  });

  const result = await validateLicenseKey(
    "https://api.test",
    "tf_test_key123",
    fetcher,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.valid, true);
    assertEquals(result.value.plan, "pro");
  }
  assertEquals(
    captured.url,
    "https://api.test/v1/license/validate",
  );
  assertEquals(
    captured.headers["Authorization"],
    "Bearer tf_test_key123",
  );
});

Deno.test("Cloud: validateLicenseKey returns error reason on 401", async () => {
  const result = await validateLicenseKey(
    "https://api.test",
    "tf_test_bad_key",
    mockFetcher(401, { valid: false, reason: "invalid_key" }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "invalid_key");
  }
});

Deno.test("Cloud: validateLicenseKey returns cancelled reason with portal_url", async () => {
  const result = await validateLicenseKey(
    "https://api.test",
    "tf_test_cancelled",
    mockFetcher(401, {
      valid: false,
      reason: "cancelled",
      portal_url: "https://billing.stripe.com/p/session/test",
    }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, "cancelled");
  }
});

Deno.test("Cloud: validateLicenseKey returns error on network failure", async () => {
  const result = await validateLicenseKey(
    "https://api.test",
    "tf_test_key",
    networkErrorFetcher(),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "Could not reach");
  }
});

// ─── startCallbackServer ─────────────────────────────────────────────────────

Deno.test("Cloud: callback server receives key from query param", async () => {
  const ac = new AbortController();
  const server = startCallbackServer(ac.signal);

  try {
    // Simulate the gateway redirect
    const resp = await fetch(
      `http://127.0.0.1:${server.port}/callback?key=tf_test_callback_key`,
    );
    assertEquals(resp.status, 200);
    const html = await resp.text();
    assertStringIncludes(html, "setup complete");

    const key = await server.keyPromise;
    assertEquals(key, "tf_test_callback_key");
  } finally {
    ac.abort();
    server.close();
  }
});

Deno.test("Cloud: callback server returns 404 for non-callback paths", async () => {
  const ac = new AbortController();
  const server = startCallbackServer(ac.signal);

  try {
    const resp = await fetch(`http://127.0.0.1:${server.port}/other`);
    assertEquals(resp.status, 404);
    await resp.text(); // consume body
  } finally {
    ac.abort();
    server.close();
  }
});

Deno.test("Cloud: callback server returns 404 when key param is missing", async () => {
  const ac = new AbortController();
  const server = startCallbackServer(ac.signal);

  try {
    const resp = await fetch(
      `http://127.0.0.1:${server.port}/callback`,
    );
    assertEquals(resp.status, 404);
    await resp.text(); // consume body
  } finally {
    ac.abort();
    server.close();
  }
});

Deno.test("Cloud: callback server listens on random port", () => {
  const ac = new AbortController();
  const server = startCallbackServer(ac.signal);

  try {
    // Port should be > 0 (allocated by OS)
    assertEquals(server.port > 0, true);
  } finally {
    ac.abort();
    server.close();
  }
});
