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
): OperatorNotificationChannels["sendWebhook"] {
  return async (channel, body, authorize) => {
    if (
      !domainPolicy.isAllowed(channel.destinationOrigin) ||
      !canFlowTo(
        channel.classification,
        domainPolicy.getClassification(channel.destinationOrigin),
      ) || !await authorize()
    ) return "blocked";

    const secret = await secrets.getSecret(channel.endpointRef);
    if (!secret.ok) return "blocked";
    let target: URL;
    try {
      target = new URL(secret.value);
    } catch {
      return "blocked";
    }
    if (
      target.origin !== channel.destinationOrigin || target.username ||
      target.password || target.hash
    ) return "blocked";
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
  };
}
