/**
 * Triggerfish Gateway API client functions.
 *
 * Handles new customer checkout, returning customer magic link,
 * device code flow (headless), and license key validation.
 * All API functions accept an injected fetcher for testability.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";

/** Interval between device code polls (ms). */
const DEVICE_POLL_INTERVAL_MS = 3000;

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
      return {
        ok: false,
        error: `Checkout session failed (HTTP ${resp.status}): ${text}`,
      };
    }

    const data = await resp.json() as CheckoutSessionResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      return {
        ok: false,
        error: `Magic link request failed (HTTP ${resp.status}): ${text}`,
      };
    }

    const data = await resp.json() as { sent: boolean };
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      return {
        ok: false,
        error: `Device code request failed (HTTP ${resp.status}): ${text}`,
      };
    }

    const data = await resp.json() as DeviceCodeResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      return {
        ok: false,
        error: `Device poll failed (HTTP ${resp.status}): ${text}`,
      };
    }

    const data = await resp.json() as DevicePollResponse;
    return { ok: true, value: data };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Could not reach ${gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
export async function verifyLicenseKey(
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
      error: `Could not reach ${gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

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

/** @deprecated Use verifyLicenseKey instead */
export const validateLicenseKey = verifyLicenseKey;
