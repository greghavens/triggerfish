import { assertEquals } from "@std/assert";
import { retainedInventoryProtocolVersion } from "../../../src/mcp/client/retained_inventory_http.ts";
import {
  fixtureInventoryCredential,
  fixtureInventoryResult,
} from "./scopesentry_inventory_responses.ts";

/** Route one approved fixture name through the normal pinned proxy and TLS. */
export async function startScopesentryHttpsFixture(callsPath: string) {
  const fixture = (name: string) =>
    Deno.readTextFile(
      new URL(`../../core/security/fixtures/${name}`, import.meta.url),
    );
  const [ca, cert, key] = await Promise.all([
    fixture("egress-ca.pem"),
    fixture("egress-server.pem"),
    fixture("egress-server-key.pem"),
  ]);
  const hostname = "public.example.test";
  const address = "8.8.8.8";
  let dnsAddress = address;
  const sessionId = "joined-native-transport";
  const operations: string[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert,
    key,
    onListen() {},
  }, async (request) => {
    const url = new URL(request.url);
    assertEquals(url.hostname, hostname);
    assertEquals(url.pathname, "/inventory");
    assertEquals(url.search, "");
    assertEquals(request.method, "POST");
    assertEquals(request.headers.get("x-api-key"), fixtureInventoryCredential);
    const { id, method, params } = await request.json();
    operations.push(method);
    if (method === "initialize") {
      assertEquals(request.headers.get("mcp-session-id"), null);
      assertEquals(params.protocolVersion, retainedInventoryProtocolVersion);
    } else {
      assertEquals(request.headers.get("mcp-session-id"), sessionId);
      assertEquals(
        request.headers.get("mcp-protocol-version"),
        retainedInventoryProtocolVersion,
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/call") {
      await Deno.writeTextFile(
        callsPath,
        JSON.stringify(params.arguments) + "\n",
        { append: true },
      );
    }
    const result = fixtureInventoryResult(
      method,
      params,
      true,
      retainedInventoryProtocolVersion,
    );
    return Response.json({ jsonrpc: "2.0", id, result }, {
      headers: method === "initialize"
        ? { "Mcp-Session-Id": sessionId }
        : undefined,
    });
  });
  const port = server.addr.port;
  const { resolveDns, connect, createHttpClient } = Deno;
  // The actual policy must approve the assigned IP. Only the final socket for
  // the fixture tuple is translated, and certificate verification stays on.
  Deno.resolveDns = ((host, rrtype, options) => {
    if (host === hostname) {
      return Promise.resolve(rrtype === "A" ? [dnsAddress] : []);
    }
    return resolveDns(host, rrtype, options);
  }) as typeof Deno.resolveDns;
  Deno.connect = ((options: Deno.ConnectOptions | Deno.UnixConnectOptions) => {
    if (
      "port" in options && options.port === port && options.hostname === address
    ) {
      return connect({ ...options, hostname: "127.0.0.1" });
    }
    return "port" in options ? connect(options) : connect(options);
  }) as typeof Deno.connect;
  Deno.createHttpClient = (options) =>
    createHttpClient(options.proxy ? { ...options, caCerts: [ca] } : options);
  return {
    url: `https://${hostname}:${port}/inventory`,
    operations,
    resolveToLoopback(blocked: boolean) {
      dnsAddress = blocked ? "127.0.0.1" : address;
    },
    async close() {
      Object.assign(Deno, { resolveDns, connect, createHttpClient });
      await server.shutdown();
    },
  };
}
