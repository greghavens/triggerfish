/** HTTP transport pinned to a validated TCP address, with end-to-end TLS. */

import { createEgressProxy } from "./egress_proxy.ts";
import type { EgressProxy } from "./egress_proxy.ts";

/** URL and literal destination IP approved by the outbound policy. */
export interface PinnedFetchTarget {
  readonly url: string;
  readonly address: string;
}

/** Normalize equivalent IPv6 spellings without a DNS lookup. */
function canonicalHostname(hostname: string): string {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare.includes(":")
    ? new URL(`http://[${bare}]/`).hostname
    : bare.toLowerCase();
}

/** Preserve native fetch metadata when replacing the response body for cleanup. */
function copyResponseMetadata(
  response: Response,
  original: Response,
): Response {
  Object.defineProperties(response, {
    url: { value: original.url },
    redirected: { value: original.redirected },
    type: { value: original.type },
    clone: {
      value: () =>
        copyResponseMetadata(Response.prototype.clone.call(response), original),
    },
  });
  return response;
}

/** Release transport resources when the body is consumed, cancelled, or errors. */
function wrapPinnedResponse(response: Response, proxy: EgressProxy): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await proxy.close();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (err) {
        await proxy.close();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await proxy.close();
      }
    },
  });
  return copyResponseMetadata(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    response,
  );
}

/** Fetch only through the approved IP; the URL hostname remains the TLS identity. */
export async function fetchPinnedTarget(
  target: PinnedFetchTarget,
  options?: RequestInit,
): Promise<Response> {
  const parsed = new URL(target.url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const proxy = createEgressProxy((hostname, requestedPort) =>
    Promise.resolve(
      canonicalHostname(hostname) === canonicalHostname(parsed.hostname) &&
        requestedPort === port
        ? { ok: true, value: target.address }
        : {
          ok: false,
          error: "Fetch transport destination does not match the approved URL",
        },
    )
  );
  if (!proxy.ok) throw new Error(proxy.error);
  const client = Deno.createHttpClient({
    proxy: { url: proxy.value.url },
    poolMaxIdlePerHost: 0,
  });
  try {
    const response = await fetch(target.url, {
      ...options,
      redirect: "manual",
      client,
    });
    if (!response.body) await proxy.value.close();
    return wrapPinnedResponse(response, proxy.value);
  } catch (err) {
    await proxy.value.close();
    throw err;
  } finally {
    proxy.value.stopAccepting();
    client.close();
  }
}
