/**
 * WhatsApp channel adapter wiring for gateway startup.
 *
 * @module
 */

import { parseClassification } from "../../../core/types/classification.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { UserId } from "../../../core/types/session.ts";
import type { ChannelMessage } from "../../../channels/types.ts";
import { createWhatsAppChannel } from "../../../channels/whatsapp/adapter.ts";
import { buildSendEvent } from "../../chat.ts";
import type { ChannelWiringDeps } from "./channels_shared.ts";
import type { NotificationService } from "../../notifications/notifications.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import { safeFetch } from "../../../tools/web/mod.ts";

const log = createLogger("startup-channels-whatsapp");

/** WhatsApp channel config from triggerfish.yaml (all credentials optional). */
export interface WhatsAppChannelConfig {
  readonly accessToken?: string;
  readonly phoneNumberId?: string;
  readonly verifyToken?: string;
  readonly appSecret?: string;
  readonly webhookPort?: number;
  readonly ownerPhone?: string;
  readonly classification?: string;
  readonly pairing?: boolean;
  readonly pairing_classification?: string;
  readonly user_classifications?: Record<string, string>;
  readonly respond_to_unclassified?: boolean;
}

/** Config with required credentials, after the caller has validated presence. */
export interface ValidatedWhatsAppConfig extends WhatsAppChannelConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly verifyToken: string;
}

/** Type guard to narrow WhatsAppChannelConfig to ValidatedWhatsAppConfig. */
export function isValidatedWhatsAppConfig(
  config: WhatsAppChannelConfig,
): config is ValidatedWhatsAppConfig {
  return Boolean(
    config.accessToken && config.phoneNumberId && config.verifyToken,
  );
}

/** Reset session and notify owner on /clear command. */
function handleWhatsAppClearCommand(
  adapter: ReturnType<typeof createWhatsAppChannel>,
  chatSession: ChannelWiringDeps["chatSession"],
  notificationService: NotificationService,
  sessionId: string | undefined,
): void {
  log.warn("WhatsApp session cleared by owner", {
    operation: "handleWhatsAppClearCommand",
    sessionId,
  });
  chatSession.clear();
  adapter.send({
    content:
      "Session cleared. Your context and taint level have been reset to PUBLIC.\n\nWhat would you like to do?",
    sessionId: sessionId,
  }).then(() => notificationService.flushPending("owner" as UserId))
    .catch((err) =>
      log.error("WhatsApp /clear session reset send failed", {
        operation: "handleWhatsAppClearCommand",
        err,
        sessionId,
      })
    );
}

/** Route an owner message through the main agent turn. */
function routeOwnerWhatsAppMessage(
  msg: ChannelMessage,
  adapter: ReturnType<typeof createWhatsAppChannel>,
  chatSession: ChannelWiringDeps["chatSession"],
): void {
  const sendEvent = buildSendEvent(adapter, "WhatsApp", msg);
  chatSession.executeAgentTurn(msg.content, sendEvent)
    .catch((err) =>
      log.error("WhatsApp owner executeAgentTurn failed", {
        operation: "executeAgentTurn",
        err,
        sessionId: msg.sessionId,
      })
    );
}

/** Route an external message through the channel message handler. */
function routeExternalWhatsAppMessage(
  msg: ChannelMessage,
  chatSession: ChannelWiringDeps["chatSession"],
): void {
  chatSession.handleChannelMessage(msg, "whatsapp")
    .catch((err) =>
      log.error("WhatsApp external handleChannelMessage failed", {
        operation: "handleChannelMessage",
        err,
        sessionId: msg.sessionId,
      })
    );
}

/** Handle incoming WhatsApp messages, dispatching commands and chat. */
function handleWhatsAppMessage(
  msg: ChannelMessage,
  adapter: ReturnType<typeof createWhatsAppChannel>,
  deps: ChannelWiringDeps,
): void {
  const { chatSession, notificationService } = deps;
  if (msg.content === "/clear" && msg.isOwner === true) {
    log.info("WhatsApp routing: /clear command from owner", {
      operation: "handleWhatsAppMessage",
      sessionId: msg.sessionId,
      isOwner: msg.isOwner,
    });
    handleWhatsAppClearCommand(
      adapter,
      chatSession,
      notificationService,
      msg.sessionId,
    );
    return;
  }
  if (msg.isOwner === true) {
    log.info("WhatsApp routing: owner message to agent", {
      operation: "handleWhatsAppMessage",
      sessionId: msg.sessionId,
      isOwner: true,
    });
    routeOwnerWhatsAppMessage(msg, adapter, chatSession);
  } else {
    log.info("WhatsApp routing: external message to channel handler", {
      operation: "handleWhatsAppMessage",
      sessionId: msg.sessionId,
      isOwner: false,
    });
    routeExternalWhatsAppMessage(msg, chatSession);
  }
}

/** Register WhatsApp notification channel for owner. */
function registerWhatsAppNotifications(
  notificationService: NotificationService,
  adapter: ReturnType<typeof createWhatsAppChannel>,
  ownerPhone: string | undefined,
): void {
  if (!ownerPhone) return;
  notificationService.registerChannel({
    name: "whatsapp",
    send: (msg) =>
      adapter.send({ content: msg, sessionId: `whatsapp-${ownerPhone}` }),
  });
}

/** Wrap safeFetch into a standard fetch signature for adapter injection. */
async function ssrfSafeFetchWrapper(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const mergedInit: RequestInit = input instanceof Request
    ? {
      method: input.method,
      headers: input.headers,
      body: input.body,
      ...init,
    }
    : (init ?? {});
  const result = await safeFetch(url, mergedInit);
  if (!result.ok) {
    log.warn("WhatsApp SSRF-safe fetch blocked outbound request", {
      operation: "ssrfSafeFetchWrapper",
      url,
      error: result.error,
    });
    throw new Error(`SSRF-safe fetch blocked: ${result.error}`);
  }
  return result.value;
}

/** Parse and validate the classification level from config — throws if invalid. */
function resolveClassification(raw: string | undefined): ClassificationLevel {
  const input = raw ?? "PUBLIC";
  const result = parseClassification(input);
  if (result.ok) return result.value;
  throw new Error(
    `WhatsApp channel classification invalid — startup rejected: ${input}`,
  );
}

/** Parse and validate the pairing classification level — throws if invalid. */
function resolvePairingClassification(
  raw: string | undefined,
): ClassificationLevel {
  const input = raw ?? "INTERNAL";
  const result = parseClassification(input);
  if (result.ok) return result.value;
  throw new Error(
    `WhatsApp pairing_classification invalid — startup rejected: ${input}`,
  );
}

/** Create the WhatsApp channel adapter with SSRF-safe fetch. */
function buildWhatsAppAdapter(
  whatsappConfig: ValidatedWhatsAppConfig,
  classification: ClassificationLevel,
): ReturnType<typeof createWhatsAppChannel> {
  return createWhatsAppChannel({
    accessToken: whatsappConfig.accessToken,
    phoneNumberId: whatsappConfig.phoneNumberId,
    verifyToken: whatsappConfig.verifyToken,
    appSecret: whatsappConfig.appSecret,
    webhookPort: whatsappConfig.webhookPort,
    ownerPhone: whatsappConfig.ownerPhone,
    classification,
    fetchFn: ssrfSafeFetchWrapper,
  });
}

/** Register channel session, message handler, and notifications. */
async function registerWhatsAppSessionAndHandlers(
  whatsappAdapter: ReturnType<typeof createWhatsAppChannel>,
  whatsappConfig: ValidatedWhatsAppConfig,
  classification: ClassificationLevel,
  deps: ChannelWiringDeps,
): Promise<void> {
  await deps.chatSession.registerChannel("whatsapp", {
    adapter: whatsappAdapter,
    channelName: "WhatsApp",
    classification,
    userClassifications: whatsappConfig.user_classifications,
    respondToUnclassified: whatsappConfig.respond_to_unclassified,
    pairing: whatsappConfig.pairing,
    pairingClassification: resolvePairingClassification(
      whatsappConfig.pairing_classification,
    ),
  });
  whatsappAdapter.onMessage((msg) =>
    handleWhatsAppMessage(msg, whatsappAdapter, deps)
  );
  registerWhatsAppNotifications(
    deps.notificationService,
    whatsappAdapter,
    whatsappConfig.ownerPhone,
  );
}

/** Connect adapter and register in the channel adapter map. */
async function connectAndRegisterWhatsApp(
  whatsappAdapter: ReturnType<typeof createWhatsAppChannel>,
  channelAdapters: ChannelWiringDeps["channelAdapters"],
  classification: ClassificationLevel,
  webhookPort: number,
): Promise<void> {
  try {
    await whatsappAdapter.connect();
  } catch (err: unknown) {
    log.error("WhatsApp channel connect failed", {
      operation: "wireWhatsAppChannel",
      err,
      webhookPort,
    });
    throw err;
  }
  channelAdapters.set("whatsapp", {
    adapter: whatsappAdapter,
    classification,
    name: "WhatsApp",
  });
}

/** Wire and connect WhatsApp channel adapter. Caller must validate credentials. */
export async function wireWhatsAppChannel(
  whatsappConfig: ValidatedWhatsAppConfig,
  deps: ChannelWiringDeps,
): Promise<void> {
  const classification = resolveClassification(whatsappConfig.classification);
  const webhookPort = whatsappConfig.webhookPort ?? 8443;
  log.info("WhatsApp channel configured, connecting...", { webhookPort });
  const whatsappAdapter = buildWhatsAppAdapter(whatsappConfig, classification);
  await registerWhatsAppSessionAndHandlers(
    whatsappAdapter,
    whatsappConfig,
    classification,
    deps,
  );
  await connectAndRegisterWhatsApp(
    whatsappAdapter,
    deps.channelAdapters,
    classification,
    webhookPort,
  );
  log.info("WhatsApp channel connected", { webhookPort });
}
