import type { ManagedNotificationChannel } from "../../core/managed_notification_channels.ts";
import type { SecretStore } from "../../core/secrets/backends/secret_store.ts";
import { fetchPinnedTarget } from "../../core/security/pinned_fetch.ts";
import { resolveAndCheck } from "../../core/security/ssrf.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import type { DomainPolicy } from "../../tools/web/policy.ts";
import type { OperatorNotificationChannels } from "./operator_channels.ts";

/** Bind the reviewed origin to the current secret URL and outbound policy. */
export function createNotificationWebhookTransport(
  secrets: Pick<SecretStore, "getSecret">,
  domainPolicy: DomainPolicy,
  resolve = resolveAndCheck,
  fetchPinned = fetchPinnedTarget,
): Pick<
  OperatorNotificationChannels,
  "bindWebhookDestination" | "sendWebhook"
> {
  async function destination(channel: ManagedNotificationChannel) {
    if (
      !domainPolicy.isAllowed(channel.destinationOrigin) ||
      !canFlowTo(
        channel.classification,
        domainPolicy.getClassification(channel.destinationOrigin),
      )
    ) return;
    const secret = await secrets.getSecret(channel.endpointRef);
    if (!secret.ok) return;
    let target: URL;
    try {
      target = new URL(secret.value);
    } catch {
      return;
    }
    if (
      target.origin !== channel.destinationOrigin || target.username ||
      target.password || target.hash
    ) return;
    const hashed = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `triggerfish-notification-destination:\0${channel.id}\0${target.href}`,
      ),
    );
    const fingerprint = Array.from(
      new Uint8Array(hashed),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return { target, fingerprint };
  }

  return {
    async bindWebhookDestination(channel) {
      return (await destination(channel))?.fingerprint;
    },
    async sendWebhook(channel, body, authorize) {
      if (!channel.endpointFingerprint || !await authorize()) return "blocked";
      const selected = await destination(channel);
      if (selected?.fingerprint !== channel.endpointFingerprint) {
        return "blocked";
      }
      const { target } = selected;
      const address = await resolve(target.hostname);
      if (
        !address.ok || !domainPolicy.isAllowed(target.href) ||
        !await authorize()
      ) return "blocked";

      try {
        const response = await fetchPinned(
          { url: target.href, address: address.value },
          {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(10_000),
          },
        );
        await response.body?.cancel().catch(() => {});
        return response.ok ? "delivered" : "uncertain";
      } catch {
        return "uncertain";
      }
    },
  };
}
