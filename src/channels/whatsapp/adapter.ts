/**
 * WhatsApp channel adapter via WhatsApp Cloud API.
 *
 * Uses the official WhatsApp Business Cloud API (HTTP-based) rather than
 * unofficial libraries. Receives messages via webhook and sends via REST API.
 *
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("whatsapp");

/** Maximum message length for WhatsApp. */
const MAX_MESSAGE_LENGTH = 4096;

/** Configuration for the WhatsApp channel adapter. */
export interface WhatsAppConfig {
  /** WhatsApp Business API access token. */
  readonly accessToken: string;
  /** Phone number ID from Meta Business Dashboard. */
  readonly phoneNumberId: string;
  /** Webhook verify token for incoming messages. */
  readonly verifyToken: string;
  /** Port to listen for webhooks. Default: 8443 */
  readonly webhookPort?: number;
  /** Classification level for this channel. Default: PUBLIC */
  readonly classification?: ClassificationLevel;
  /** Owner's phone number (e.g. "15551234567"). */
  readonly ownerPhone?: string;
}

/** WhatsApp Cloud API base URL. */
const WA_API_BASE = "https://graph.facebook.com/v18.0";

/** Mutable connection state shared between adapter methods. */
interface WhatsAppAdapterState {
  connected: boolean;
  readonly handlerRef: { current: MessageHandler | null };
  server: Deno.HttpServer | null;
}

/** Handle an incoming WhatsApp webhook HTTP request. */
function handleWhatsAppWebhookRequest(
  req: Request,
  verifyToken: string,
  onPayload: (body: Record<string, unknown>) => void,
): Response | Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/webhook") {
    return verifyWhatsAppWebhook(url, verifyToken);
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    return req.json().then((body: Record<string, unknown>) => {
      onPayload(body);
      return new Response("OK", { status: 200 });
    });
  }
  return new Response("Not Found", { status: 404 });
}

/** Verify a WhatsApp webhook subscription challenge. */
function verifyWhatsAppWebhook(url: URL, verifyToken: string): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

/** Forward a single WhatsApp text message to the handler. */
function forwardWhatsAppTextMessage(
  msg: Record<string, unknown>,
  handler: MessageHandler,
  ownerPhone: string | undefined,
): void {
  if (msg.type !== "text") return;
  const from = msg.from as string;
  const textObj = msg.text as { body: string } | undefined;
  if (!textObj?.body) return;
  const isOwner = ownerPhone !== undefined ? from === ownerPhone : true;
  log.ext("DEBUG", "Message received", {
    from,
    type: msg.type as string,
  });
  handler({
    content: textObj.body,
    sessionId: `whatsapp-${from}`,
    senderId: from,
    isOwner,
    sessionTaint: isOwner ? undefined : ("PUBLIC" as ClassificationLevel),
    isGroup: false,
  });
}

/** Process incoming WhatsApp webhook payload from Meta. */
function dispatchWhatsAppWebhookMessages(
  body: Record<string, unknown>,
  handler: MessageHandler,
  ownerPhone: string | undefined,
): void {
  const entries = (body.entry ?? []) as Array<Record<string, unknown>>;
  for (const entry of entries) {
    const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;
      const messages = (value.messages ?? []) as Array<
        Record<string, unknown>
      >;
      for (const msg of messages) {
        forwardWhatsAppTextMessage(msg, handler, ownerPhone);
      }
    }
  }
}

/** Send a text message via WhatsApp Cloud API. */
async function sendWhatsAppTextMessage(
  phone: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `${WA_API_BASE}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      }),
    },
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${err}`);
  }
}

/** Truncate content to the WhatsApp message length limit. */
function truncateWhatsAppContent(content: string): string {
  return content.length > MAX_MESSAGE_LENGTH
    ? content.slice(0, MAX_MESSAGE_LENGTH)
    : content;
}

/** Send a WhatsApp message, extracting the phone from the session ID. */
async function sendWhatsAppChannelMessage(
  message: ChannelMessage,
  config: WhatsAppConfig,
): Promise<void> {
  if (!message.sessionId) return;
  const phone = message.sessionId.replace("whatsapp-", "");
  const text = truncateWhatsAppContent(message.content);
  await sendWhatsAppTextMessage(
    phone,
    text,
    config.phoneNumberId,
    config.accessToken,
  );
}

/** Start the webhook HTTP server and mark the adapter as connected. */
function connectWhatsAppWebhook(
  config: WhatsAppConfig,
  webhookPort: number,
  state: WhatsAppAdapterState,
): void {
  state.server = Deno.serve(
    { port: webhookPort },
    (req) =>
      handleWhatsAppWebhookRequest(req, config.verifyToken, (body) => {
        if (state.handlerRef.current) {
          dispatchWhatsAppWebhookMessages(
            body,
            state.handlerRef.current,
            config.ownerPhone,
          );
        }
      }),
  );
  state.connected = true;
  log.info("WhatsApp adapter connected", { port: webhookPort });
}

/** Shut down the webhook HTTP server and mark the adapter as disconnected. */
async function disconnectWhatsAppWebhook(
  state: WhatsAppAdapterState,
): Promise<void> {
  if (state.server) {
    await state.server.shutdown();
    state.server = null;
  }
  state.connected = false;
  log.info("WhatsApp adapter disconnected");
}

/** Assemble the ChannelAdapter method object for WhatsApp. */
function assembleWhatsAppAdapter(
  config: WhatsAppConfig,
  webhookPort: number,
  classification: ClassificationLevel,
  state: WhatsAppAdapterState,
): ChannelAdapter {
  return {
    classification,
    isOwner: true,
    // deno-lint-ignore require-await
    connect: async () => connectWhatsAppWebhook(config, webhookPort, state),
    disconnect: () => disconnectWhatsAppWebhook(state),
    send: (message: ChannelMessage) =>
      sendWhatsAppChannelMessage(message, config),
    onMessage(msgHandler: MessageHandler): void {
      state.handlerRef.current = msgHandler;
    },
    status: (): ChannelStatus => ({
      connected: state.connected,
      channelType: "whatsapp",
    }),
  };
}

/**
 * Create a WhatsApp channel adapter.
 *
 * Sends messages via the WhatsApp Cloud API and receives them via webhook.
 * The webhook server listens on the configured port for incoming message
 * notifications from Meta.
 *
 * @param config - WhatsApp configuration.
 * @returns A ChannelAdapter wired to WhatsApp.
 */
export function createWhatsAppChannel(config: WhatsAppConfig): ChannelAdapter {
  const classification = (config.classification ??
    "PUBLIC") as ClassificationLevel;
  const webhookPort = config.webhookPort ?? 8443;
  const state: WhatsAppAdapterState = {
    connected: false,
    handlerRef: { current: null },
    server: null,
  };
  return assembleWhatsAppAdapter(config, webhookPort, classification, state);
}
