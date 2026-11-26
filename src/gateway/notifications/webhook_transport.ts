import type { ManagedNotificationChannel } from "../../core/managed_notification_channels.ts";
import type { SecretStore } from "../../core/secrets/backends/secret_store.ts";
import { fetchPinnedTarget } from "../../core/security/pinned_fetch.ts";
import { resolveAndCheck } from "../../core/security/ssrf.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import type { DomainPolicy } from "../../tools/web/policy.ts";
import {
  matchesNotificationProviderEndpoint,
  notificationProviderOutcome,
  notificationProviderRequest,
} from "./webhook_providers.ts";
import type { OperatorNotificationChannels } from "./operator_channels.ts";

/** Bind the reviewed origin to the current secret URL and outbound policy. */
export function createNotificationWebhookTransport(
  secrets: Pick<SecretStore, "getSecret">,
  domainPolicy: DomainPolicy,
  resolve = resolveAndCheck,
  fetchPinned = fetchPinnedTarget,
  now = Date.now,
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
    if (!secret.ok || secret.value.length > 4096) return;
    let target: URL;
    try {
      target = new URL(secret.value);
    } catch {
      return;
    }
    if (
      target.origin !== channel.destinationOrigin || target.username ||
      target.password || target.hash ||
      !matchesNotificationProviderEndpoint(channel.provider, target)
    ) return;

    let signingSecret: string | undefined;
    if (channel.signingSecretRef) {
      const signing = await secrets.getSecret(channel.signingSecretRef);
      if (!signing.ok || !signing.value || signing.value.length > 4096) return;
      signingSecret = signing.value;
    }
    const providerIdentity = channel.provider === "webhook"
      ? ""
      : `\0${channel.provider}\0${channel.signingSecretRef ?? ""}\0${
        signingSecret ?? ""
      }`;
    const hashed = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `triggerfish-notification-destination:\0${channel.id}\0${target.href}${providerIdentity}`,
      ),
    );
    const fingerprint = Array.from(
      new Uint8Array(hashed),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return { target, fingerprint, signingSecret };
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
      const request = notificationProviderRequest(
        channel.provider,
        selected.target,
        body,
        selected.signingSecret,
        now(),
      );
      const address = await resolve(request.target.hostname);
      if (
        !address.ok || !domainPolicy.isAllowed(request.target.href) ||
        !await authorize()
      ) return "blocked";

      try {
        const response = await fetchPinned(
          { url: request.target.href, address: address.value },
          {
            method: "POST",
            redirect: "manual",
            headers: { "Content-Type": "application/json" },
            body: request.body,
            signal: AbortSignal.timeout(10_000),
          },
        );
        return await notificationProviderOutcome(channel.provider, response);
      } catch {
        return "uncertain";
      }
    },
  };
}
