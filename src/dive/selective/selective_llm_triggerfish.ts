/**
 * Triggerfish Gateway license key setup for the selective wizard.
 *
 * Handles new customer checkout, returning customer magic link,
 * direct key paste, and license validation with retry.
 *
 * @module
 */

import { Input, Select } from "@cliffy/prompt";

import { createKeychain } from "../../core/secrets/keychain/keychain.ts";
import {
  openInBrowser,
  resolveGatewayUrl,
  startCallbackServer,
  verifyLicenseKey,
} from "../cloud.ts";

// ── License key collection ──────────────────────────────────────────────────

/** Collect a Triggerfish Gateway license key via interactive setup. */
export async function collectTriggerfishLicenseKey(
  existingKey: string,
): Promise<{ licenseKey: string; gatewayUrl: string }> {
  console.log("");
  console.log("  Triggerfish Gateway handles LLM routing, model selection,");
  console.log("  and includes web search — no other API keys needed.");
  console.log("");

  const setupMethod = await Select.prompt({
    message: "How would you like to set up Triggerfish Gateway?",
    options: [
      { name: "I'm a new customer — sign up", value: "new" },
      { name: "I'm a returning customer — get my key", value: "returning" },
      { name: "I already have a license key", value: "paste" },
      ...(existingKey.length > 0
        ? [{ name: "Keep existing key", value: "keep" }]
        : []),
    ],
  });

  if (setupMethod === "keep") {
    const resolved = await resolveExistingLicenseKey(existingKey);
    return { licenseKey: resolved, gatewayUrl: resolveGatewayUrl(resolved) };
  }

  if (setupMethod === "paste") {
    return await promptTriggerfishKeyDirect();
  }

  if (setupMethod === "new") {
    return await promptTriggerfishKeyViaCheckout();
  }

  return await promptTriggerfishKeyViaMagicLink();
}

/** Resolve an existing license key from a secret ref or return as-is. */
async function resolveExistingLicenseKey(key: string): Promise<string> {
  if (!key.startsWith("secret:")) return key;
  const store = createKeychain();
  const result = await store.getSecret(key.slice("secret:".length));
  return result.ok ? result.value : "";
}

/** Prompt the user to paste a license key directly. */
async function promptTriggerfishKeyDirect(): Promise<{
  licenseKey: string;
  gatewayUrl: string;
}> {
  const licenseKey = await Input.prompt({
    message: "Paste your license key (tf_live_... or tf_test_...)",
  });
  return { licenseKey, gatewayUrl: resolveGatewayUrl(licenseKey) };
}

/** Run the new-customer checkout flow and await the callback key. */
async function promptTriggerfishKeyViaCheckout(): Promise<{
  licenseKey: string;
  gatewayUrl: string;
}> {
  const gatewayUrl = Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
    "https://api.trigger.fish";
  const siteUrl = Deno.env.get("TRIGGERFISH_SITE_URL") ??
    "https://trigger.fish";
  const ac = new AbortController();
  const flowId = crypto.randomUUID();
  const server = startCallbackServer(ac.signal, flowId);

  try {
    const checkoutUrl =
      `${siteUrl}/setup/checkout?flow_id=${flowId}&port=${server.port}&gateway=${
        encodeURIComponent(gatewayUrl)
      }`;

    console.log("");
    console.log("  Opening the plan picker in your browser...");
    console.log("  Choose a plan and complete checkout.");
    await openInBrowser(checkoutUrl);
    console.log("  Waiting for setup to complete...");
    console.log("  (Press Ctrl+C to cancel)");
    console.log("");

    const licenseKey = await server.keyPromise;
    console.log("  \u2713 License key received!");
    // Let the callback response reach the browser before shutting down
    await new Promise((r) => setTimeout(r, 1000));
    return { licenseKey, gatewayUrl: resolveGatewayUrl(licenseKey) };
  } catch (err: unknown) {
    console.log("  Setup was cancelled or timed out.");
    console.log("  Falling back to manual key entry.");
    console.error("  Error details:", err);
    return await promptTriggerfishKeyDirect();
  } finally {
    ac.abort();
    await server.close();
  }
}

/** Run the returning-customer magic link flow and await the callback key. */
async function promptTriggerfishKeyViaMagicLink(): Promise<{
  licenseKey: string;
  gatewayUrl: string;
}> {
  const gatewayUrl = Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
    "https://api.trigger.fish";
  const email = await Input.prompt({
    message: "Email address on your Triggerfish account",
  });

  const ac = new AbortController();
  const flowId = crypto.randomUUID();
  const server = startCallbackServer(ac.signal, flowId);

  try {
    const { sendMagicLink } = await import("../cloud.ts");
    const result = await sendMagicLink(
      gatewayUrl,
      email,
      flowId,
      server.port,
    );

    if (!result.ok) {
      console.log(`  \u2717 ${result.error}`);
      console.log("  Falling back to manual key entry.");
      return await promptTriggerfishKeyDirect();
    }

    console.log("");
    console.log("  Magic link sent! Check your email and click the link.");
    console.log("  Waiting for setup to complete...");
    console.log("  (Press Ctrl+C to cancel)");
    console.log("");

    const licenseKey = await server.keyPromise;
    console.log("  \u2713 License key received!");
    // Let the callback response reach the browser before shutting down
    await new Promise((r) => setTimeout(r, 1000));
    return { licenseKey, gatewayUrl: resolveGatewayUrl(licenseKey) };
  } catch (err: unknown) {
    console.log("  Setup was cancelled or timed out.");
    console.log("  Falling back to manual key entry.");
    console.error("  Error details:", err);
    return await promptTriggerfishKeyDirect();
  } finally {
    ac.abort();
    await server.close();
  }
}

// ── License key validation ──────────────────────────────────────────────────

/** Validate a Triggerfish license key with retry. */
export async function verifyTriggerfishKey(
  licenseKey: string,
  gatewayUrl: string,
): Promise<{ licenseKey: string; gatewayUrl: string }> {
  if (licenseKey.length === 0) return { licenseKey, gatewayUrl };

  let currentKey = licenseKey;
  let currentGateway = gatewayUrl;

  while (true) {
    console.log("");
    console.log("  Validating license key...");
    const result = await verifyLicenseKey(currentGateway, currentKey);

    if (result.ok && result.value.valid) {
      const plan = result.value.plan ?? "unknown";
      console.log(`  \u2713 License valid (plan: ${plan})`);
      return { licenseKey: currentKey, gatewayUrl: currentGateway };
    }

    const errorMsg = result.ok ? "License is not active" : result.error;
    console.log(`  \u2717 ${errorMsg}`);
    console.log("");

    const action = await Select.prompt({
      message: "What would you like to do?",
      options: [
        { name: "Re-enter license key", value: "reenter" },
        { name: "Keep this key anyway", value: "keep" },
      ],
    });

    if (action === "keep") {
      return { licenseKey: currentKey, gatewayUrl: currentGateway };
    }

    currentKey = await Input.prompt({
      message: "License key (tf_live_... or tf_test_...)",
    });
    currentGateway = resolveGatewayUrl(currentKey);
  }
}

/** Build models config for Triggerfish Gateway provider. */
export async function buildTriggerfishModelsConfig(
  licenseKey: string,
  gatewayUrl: string,
): Promise<Record<string, unknown>> {
  const providers: Record<string, Record<string, string>> = {};
  const cfg: Record<string, string> = {};
  if (gatewayUrl.length > 0) cfg["gatewayUrl"] = gatewayUrl;
  if (licenseKey.length > 0) {
    const store = createKeychain();
    await store.setSecret("cloud:licenseKey", licenseKey);
    cfg["licenseKey"] = "secret:cloud:licenseKey";
  }
  providers["triggerfish"] = cfg;

  return {
    primary: { provider: "triggerfish", model: "auto" },
    providers,
  };
}
