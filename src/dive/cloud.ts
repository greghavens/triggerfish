/**
 * Triggerfish Cloud setup flows.
 *
 * Handles new customer checkout, returning customer magic link,
 * device code flow (headless), and license key validation.
 * All API functions accept an injected fetcher for testability.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Production gateway URL. */
export const PRODUCTION_GATEWAY_URL = "https://api.trigger.fish";

/** Sandbox gateway URL (for tf_test_ keys). */
export const SANDBOX_GATEWAY_URL =
  "https://triggerfish-cloud-sandbox.fly.dev";

/** Interval between device code polls (ms). */
const DEVICE_POLL_INTERVAL_MS = 3000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Response from POST /v1/setup/checkout-session. */
export interface CheckoutSessionResponse {
  readonly checkout_url: string;
}

/** Response from POST /v1/device/request. */
export interface DeviceCodeResponse {
  readonly code: string;
  readonly expires_in: number;
  readonly verification_url: string;
  readonly poll_url: string;
}

/** Response from GET /v1/device/poll. */
export interface DevicePollResponse {
  readonly status: "pending" | "complete" | "expired";
  readonly key?: string;
}

/** Response from GET /v1/license/validate. */
export interface LicenseValidation {
  readonly valid: boolean;
  readonly plan?: string;
  readonly features?: readonly string[];
  readonly limits?: Readonly<Record<string, number>>;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly portal_url?: string;
  readonly customer_email?: string;
}

/** Result of a callback server awaiting a license key. */
export interface CallbackServer {
  /** Port the server is listening on. */
  readonly port: number;
  /** Resolves with the license key when callback is received. */
  readonly keyPromise: Promise<string>;
  /** Close the server. */
  readonly close: () => void;
}

/** Options for the cloud setup flow. */
export interface CloudSetupOptions {
  /** Gateway base URL. Defaults to production. */
  readonly gatewayUrl?: string;
  /** Injected fetch for testing. */
  readonly fetcher?: typeof fetch;
  /** Injected browser opener for testing. */
  readonly openUrl?: (url: string) => Promise<void>;
  /** Whether the environment has a browser available. */
  readonly hasBrowser?: boolean;
}

// ─── Callback Server ──────────────────────────────────────────────────────────

/**
 * Start a local HTTP server to receive the license key callback.
 *
 * The cloud gateway redirects the user's browser to
 * `http://127.0.0.1:PORT/callback?key=tf_...` after checkout or magic link.
 * This server catches that redirect and extracts the key.
 *
 * @param signal - Optional abort signal to stop the server
 * @returns A CallbackServer with port, key promise, and close function
 */
export function startCallbackServer(
  signal?: AbortSignal,
): CallbackServer {
  let resolveKey: (key: string) => void;
  let rejectKey: (err: Error) => void;
  const keyPromise = new Promise<string>((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });

  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const key = url.searchParams.get("key");
        if (key && key.length > 0) {
          resolveKey!(key);
          const html =
            "<html><body><h2>Triggerfish setup complete!</h2>" +
            "<p>You can close this tab and return to the terminal.</p>" +
            "</body></html>";
          return new Response(html, {
            headers: { "Content-Type": "text/html" },
          });
        }
      }
      return new Response("Not found", { status: 404 });
    },
  );

  const addr = server.addr as Deno.NetAddr;

  // If aborted before key arrives, silently reject (callers use Promise.race)
  signal?.addEventListener("abort", () => {
    rejectKey!(new Error("Callback server aborted"));
  });

  // Prevent unhandled rejection when abort fires after no one is awaiting
  keyPromise.catch(() => {});

  return {
    port: addr.port,
    keyPromise,
    close: () => server.shutdown(),
  };
}

// ─── API Client Functions ─────────────────────────────────────────────────────

/**
 * Create a Stripe checkout session for new customers.
 *
 * @param gatewayUrl - Gateway base URL
 * @param flowId - Unique flow identifier (UUID)
 * @param port - Local callback server port
 * @param plan - Plan name ("pro" or "power"), defaults to "pro"
 * @param fetcher - Injected fetch for testing
 */
export async function createCheckoutSession(
  gatewayUrl: string,
  flowId: string,
  port: number,
  plan?: string,
  fetcher: typeof fetch = fetch,
): Promise<Result<CheckoutSessionResponse, string>> {
  try {
    const body: Record<string, unknown> = { flow_id: flowId, port };
    if (plan) body.plan = plan;

    const resp = await fetcher(`${gatewayUrl}/v1/setup/checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Checkout session failed (HTTP ${resp.status}): ${text}` };
    }

    const data = await resp.json() as CheckoutSessionResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Send a magic link email to a returning customer.
 *
 * @param gatewayUrl - Gateway base URL
 * @param email - Customer email address
 * @param flowId - Unique flow identifier (UUID)
 * @param port - Local callback server port
 * @param fetcher - Injected fetch for testing
 */
export async function sendMagicLink(
  gatewayUrl: string,
  email: string,
  flowId: string,
  port: number,
  fetcher: typeof fetch = fetch,
): Promise<Result<{ readonly sent: boolean }, string>> {
  try {
    const resp = await fetcher(`${gatewayUrl}/v1/setup/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, flow_id: flowId, port }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Magic link request failed (HTTP ${resp.status}): ${text}` };
    }

    const data = await resp.json() as { sent: boolean };
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Request a device code for headless environments.
 *
 * @param gatewayUrl - Gateway base URL
 * @param fetcher - Injected fetch for testing
 */
export async function requestDeviceCode(
  gatewayUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Result<DeviceCodeResponse, string>> {
  try {
    const resp = await fetcher(`${gatewayUrl}/v1/device/request`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Device code request failed (HTTP ${resp.status}): ${text}` };
    }

    const data = await resp.json() as DeviceCodeResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Poll for device code completion.
 *
 * @param gatewayUrl - Gateway base URL
 * @param code - Device code to poll
 * @param fetcher - Injected fetch for testing
 */
export async function pollDeviceCode(
  gatewayUrl: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<Result<DevicePollResponse, string>> {
  try {
    const resp = await fetcher(
      `${gatewayUrl}/v1/device/poll?code=${encodeURIComponent(code)}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (resp.status === 410) {
      return { ok: true, value: { status: "expired" } };
    }

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Device poll failed (HTTP ${resp.status}): ${text}` };
    }

    const data = await resp.json() as DevicePollResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate a license key against the cloud gateway.
 *
 * @param gatewayUrl - Gateway base URL
 * @param licenseKey - License key to validate (tf_test_... or tf_live_...)
 * @param fetcher - Injected fetch for testing
 */
export async function validateLicenseKey(
  gatewayUrl: string,
  licenseKey: string,
  fetcher: typeof fetch = fetch,
): Promise<Result<LicenseValidation, string>> {
  try {
    const resp = await fetcher(`${gatewayUrl}/v1/license/validate`, {
      headers: { "Authorization": `Bearer ${licenseKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    const data = await resp.json() as LicenseValidation;

    if (!resp.ok) {
      const reason = data.reason ?? "unknown";
      return { ok: false, error: reason };
    }

    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── Device Code Polling Loop ─────────────────────────────────────────────────

/**
 * Poll for device code completion in a loop until complete or expired.
 *
 * @param gatewayUrl - Gateway base URL
 * @param code - Device code to poll
 * @param expiresIn - Seconds until the code expires
 * @param fetcher - Injected fetch for testing
 * @param onPoll - Optional callback for each poll attempt (for UI updates)
 * @returns The license key, or an error
 */
export async function pollDeviceCodeLoop(
  gatewayUrl: string,
  code: string,
  expiresIn: number,
  fetcher: typeof fetch = fetch,
  onPoll?: () => void,
): Promise<Result<string, string>> {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    onPoll?.();

    const result = await pollDeviceCode(gatewayUrl, code, fetcher);
    if (!result.ok) {
      return result;
    }

    if (result.value.status === "complete" && result.value.key) {
      return { ok: true, value: result.value.key };
    }

    if (result.value.status === "expired") {
      return { ok: false, error: "Device code expired. Please try again." };
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, DEVICE_POLL_INTERVAL_MS));
  }

  return { ok: false, error: "Device code expired. Please try again." };
}

// ─── Browser Opener ───────────────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser.
 *
 * Uses platform-specific commands: `open` (macOS), `xdg-open` (Linux),
 * `start` (Windows).
 */
export async function openInBrowser(url: string): Promise<void> {
  const os = Deno.build.os;
  const cmd = os === "darwin"
    ? ["open", url]
    : os === "windows"
    ? ["cmd", "/c", "start", url]
    : ["xdg-open", url];

  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "null",
    stderr: "null",
  });
  const child = command.spawn();
  await child.status;
}

// ─── Gateway URL Resolution ──────────────────────────────────────────────────

/**
 * Determine the gateway URL based on a license key prefix.
 *
 * Keys prefixed with `tf_test_` use the sandbox gateway.
 * All other keys use the production gateway.
 */
export function resolveGatewayUrl(licenseKey: string): string {
  if (licenseKey.startsWith("tf_test_")) {
    return SANDBOX_GATEWAY_URL;
  }
  return PRODUCTION_GATEWAY_URL;
}
