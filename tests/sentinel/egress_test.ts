import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openSentinelContainment } from "../../src/sentinel/containment.ts";
import { createSentinelEgressChecker } from "../../src/sentinel/egress.ts";
import { createWebFetcher } from "../../src/tools/web/fetch.ts";
import { createDomainPolicy } from "../../src/tools/web/policy.ts";

Deno.test("Sentinel blocks a web-fetch redirect before contacting its destination", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "containment.db");
  const containment = openSentinelContainment(path);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, () =>
    new Response(null, {
      status: 302,
      headers: { Location: "https://blocked.invalid/" },
    }));
  try {
    containment.block({
      target: "blocked.invalid",
      reason: "Incident response",
      ttlSeconds: 60,
    });
    const checked: string[] = [];
    const domainPolicy = createDomainPolicy({
      allowlist: [],
      denylist: [],
      classificationMap: [],
    });
    const fetcher = createWebFetcher({
      domainPolicy,
      dnsChecker: createSentinelEgressChecker(path, (hostname) => {
        checked.push(hostname);
        return Promise.resolve({ ok: true, value: hostname });
      }),
    });
    assertEquals(await fetcher.fetch(`http://127.0.0.1:${server.addr.port}/`), {
      ok: false,
      error: "Fetch failed: Destination blocked by Sentinel: blocked.invalid",
    });
    assertEquals(checked.includes("blocked.invalid"), false);
  } finally {
    await server.shutdown();
    containment.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel fails closed when the configured policy database is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const checker = createSentinelEgressChecker(join(dir, "missing.db"), () => {
      throw new Error("Outbound check must not run");
    });
    assertEquals(await checker("example.com"), {
      ok: false,
      error: "Sentinel destination policy unavailable",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Sentinel blocks a redirect alias whose pinned address is quarantined", async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, "containment.db");
  const containment = openSentinelContainment(path);
  const alias = "alias.invalid";
  const address = "192.0.2.45";
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: `http://${alias}/` },
      }),
  );
  try {
    containment.block({
      target: address,
      reason: "Incident review",
      ttlSeconds: 60,
    });
    const checker = createSentinelEgressChecker(
      path,
      (hostname) =>
        Promise.resolve({
          ok: true,
          value: hostname === alias ? address : hostname,
        }),
    );
    const denied = {
      ok: false as const,
      error: `Destination blocked by Sentinel: ${address}`,
    };
    assertEquals(await checker(alias), denied);
    const fetcher = createWebFetcher({
      domainPolicy: createDomainPolicy({
        allowlist: [],
        denylist: [],
        classificationMap: [],
      }),
      dnsChecker: checker,
    });
    assertEquals(await fetcher.fetch(`http://127.0.0.1:${server.addr.port}/`), {
      ok: false,
      error: `Fetch failed: ${denied.error}`,
    });
  } finally {
    await server.shutdown();
    containment.close();
    await Deno.remove(dir, { recursive: true });
  }
});
