import { assertEquals } from "@std/assert";
import { safeFetchWithRedirects } from "../../../src/core/security/safe_fetch.ts";

const allow = () => Promise.resolve({ ok: true as const, value: "8.8.8.8" });

async function captureRedirect(
  location: string,
  status: number,
  options: RequestInit,
): Promise<{ readonly calls: RequestInit[]; readonly ok: boolean }> {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (_input, init) => {
    calls.push(init ?? {});
    return Promise.resolve(
      calls.length === 1
        ? new Response(null, { status, headers: { location } })
        : new Response("ok"),
    );
  };
  try {
    const result = await safeFetchWithRedirects(
      "https://api.example/start",
      options,
      allow,
    );
    if (result.ok) await result.value.body?.cancel();
    return { calls, ok: result.ok };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("safe fetch: cross-origin redirect strips credentials without changing caller headers", async () => {
  const headers = new Headers({
    Authorization: "Bearer secret",
    Cookie: "session=secret",
    "Proxy-Authorization": "Basic secret",
  });
  const result = await captureRedirect("https://other.example/end", 302, {
    headers,
  });
  assertEquals(result.ok, true);
  const forwarded = new Headers(result.calls[1].headers);
  for (const name of ["Authorization", "Cookie", "Proxy-Authorization"]) {
    assertEquals(forwarded.has(name), false);
    assertEquals(headers.has(name), true);
  }
  assertEquals(result.calls[1].credentials, "omit");
});

Deno.test("safe fetch: same-origin redirect retains authentication", async () => {
  const result = await captureRedirect("/end", 307, {
    headers: { Authorization: "Bearer secret" },
  });
  assertEquals(result.ok, true);
  assertEquals(
    new Headers(result.calls[1].headers).get("Authorization"),
    "Bearer secret",
  );
});

Deno.test("safe fetch: 303 POST redirect becomes GET and drops request body headers", async () => {
  const result = await captureRedirect("/end", 303, {
    method: "POST",
    body: "secret",
    headers: { "Content-Type": "text/plain", "Content-Length": "6" },
  });
  assertEquals(result.ok, true);
  assertEquals(result.calls[1].method, "GET");
  assertEquals(result.calls[1].body, undefined);
  assertEquals(new Headers(result.calls[1].headers).has("Content-Type"), false);
  assertEquals(
    new Headers(result.calls[1].headers).has("Content-Length"),
    false,
  );
});

Deno.test("safe fetch: redirect cannot forward POST body to another origin", async () => {
  const result = await captureRedirect("https://other.example/end", 307, {
    method: "POST",
    body: "secret",
  });
  assertEquals(result.ok, false);
  assertEquals(result.calls.length, 1);
});

Deno.test("safe fetch: HTTPS redirect cannot downgrade to HTTP", async () => {
  const result = await captureRedirect("http://api.example/end", 302, {});
  assertEquals(result.ok, false);
  assertEquals(result.calls.length, 1);
});
