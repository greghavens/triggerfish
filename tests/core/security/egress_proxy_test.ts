import { assert, assertEquals, assertRejects } from "@std/assert";
import { createEgressProxy } from "../../../src/core/security/egress_proxy.ts";
import { safeFetch } from "../../../src/core/security/safe_fetch.ts";

// Local origins stand in for the policy-approved public address. Production
// always uses resolveAndCheck, which rejects these loopback addresses.
const approveLocal = () =>
  Promise.resolve({ ok: true as const, value: "127.0.0.1" });

Deno.test("pinned fetch: unresolvable hostname reaches only the approved TCP address", async () => {
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      requests.push(request.url);
      return Response.json({ pinned: true });
    },
  );
  const url = `http://never-resolve.invalid:${server.addr.port}/data`;
  try {
    const response = await safeFetch(url, undefined, approveLocal);
    assert(response.ok);
    assertEquals(response.value.url, url);
    const clone = response.value.clone();
    assertEquals(clone.url, url);
    assertEquals(await response.value.json(), { pinned: true });
    assertEquals(await clone.json(), { pinned: true });
    assertEquals(requests, [url]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("egress proxy: default policy rejects private IP before reaching the origin", async () => {
  let requests = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      requests++;
      return new Response("private data");
    },
  );
  const proxy = createEgressProxy();
  assert(proxy.ok);
  const client = Deno.createHttpClient({ proxy: { url: proxy.value.url } });
  try {
    await assertRejects(
      () => fetch(`http://127.0.0.1:${server.addr.port}/secret`, { client }),
      TypeError,
    );
    await assertRejects(
      () => fetch(`http://[::1]:${server.addr.port}/secret`, { client }),
      TypeError,
    );
    assertEquals(requests, 0);
  } finally {
    client.close();
    await proxy.value.close();
    await server.shutdown();
  }
});

Deno.test("egress proxy: resolver cannot trigger another hostname lookup", async () => {
  const proxy = createEgressProxy(() =>
    Promise.resolve({ ok: true, value: "unvalidated.example" })
  );
  assert(proxy.ok);
  const client = Deno.createHttpClient({ proxy: { url: proxy.value.url } });
  try {
    await assertRejects(
      () => fetch("http://never-resolve.invalid/", { client }),
      TypeError,
    );
  } finally {
    client.close();
    await proxy.value.close();
  }
});

Deno.test("egress proxy: HTTPS preserves hostname verification through the checked tunnel", async () => {
  // Public test certificates only; the CA is trusted by this client, never globally.
  const ca = await Deno.readTextFile(
    new URL("./fixtures/egress-ca.pem", import.meta.url),
  );
  const cert = await Deno.readTextFile(
    new URL("./fixtures/egress-server.pem", import.meta.url),
  );
  const key = await Deno.readTextFile(
    new URL("./fixtures/egress-server-key.pem", import.meta.url),
  );
  let requests = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert,
    key,
    onListen() {},
  }, () => {
    requests++;
    return new Response("verified TLS");
  });
  const proxy = createEgressProxy(approveLocal);
  assert(proxy.ok);
  const client = Deno.createHttpClient({
    caCerts: [ca],
    proxy: { url: proxy.value.url },
    poolMaxIdlePerHost: 0,
  });
  try {
    const response = await fetch(
      `https://public.example.test:${server.addr.port}/`,
      { client },
    );
    assertEquals(await response.text(), "verified TLS");
    await assertRejects(
      () =>
        fetch(`https://wrong.example.test:${server.addr.port}/`, { client }),
      TypeError,
      "certificate",
    );
    assertEquals(requests, 1);
  } finally {
    client.close();
    await proxy.value.close();
    await server.shutdown();
  }
});

Deno.test("pinned fetch: cancellation closes a streaming tunnel", async () => {
  let cancelled = false;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ready\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  try {
    const response = await safeFetch(
      `http://never-resolve.invalid:${server.addr.port}/events`,
      undefined,
      approveLocal,
    );
    assert(response.ok);
    const reader = response.value.body!.getReader();
    assertEquals(
      new TextDecoder().decode((await reader.read()).value),
      "ready\n",
    );
    await reader.cancel();
  } finally {
    await server.shutdown();
  }
  assertEquals(cancelled, true);
});

Deno.test("pinned fetch: response consumption closes transport without truncation", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => new Response("complete response"),
  );
  try {
    const response = await safeFetch(
      `http://never-resolve.invalid:${server.addr.port}/`,
      undefined,
      approveLocal,
    );
    assert(response.ok);
    assertEquals(await response.value.text(), "complete response");
  } finally {
    await server.shutdown();
  }
});
