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
import { verifyHmacSha256 } from "../../core/security/mod.ts";

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
  /**
   * Meta App Secret used to verify the `X-Hub-Signature-256` HMAC on inbound
   * webhooks. When unset, all webhook POSTs are rejected (fail closed) since
   * their authenticity cannot be established.
   */
  readonly appSecret?: string;
  /**
   * Optional fetch function for outbound HTTP requests.
   *
   * The wiring layer (gateway/startup) should inject a SSRF-safe fetch here
   * to prevent server-side request forgery. Defaults to the global `fetch`
   * if not provided.
   */
  readonly fetchFn?: typeof fetch;
}

/** WhatsApp Cloud API base URL. */
const WA_API_BASE = "https://graph.facebook.com/v18.0";

/** Mutable connection state shared between adapter methods. */
interface WhatsAppAdapterState {
  connected: boolean;
  readonly handlerRef: { current: MessageHandler | null };
  server: Deno.HttpServer | null;
}

/** Webhook secrets needed to authenticate inbound requests. */
interface WhatsAppWebhookSecrets {
  readonly verifyToken: string;
  readonly appSecret: string | undefined;
}

/** Handle an incoming WhatsApp webhook HTTP request. */
function handleWhatsAppWebhookRequest(
  req: Request,
  secrets: WhatsAppWebhookSecrets,
  onPayload: (body: Record<string, unknown>) => void,
): Response | Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/webhook") {
    return verifyWhatsAppWebhook(url, secrets.verifyToken);
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    return handleWhatsAppWebhookPost(req, secrets.appSecret, onPayload);
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * Verify the `X-Hub-Signature-256` HMAC over the raw webhook body.
 *
 * Fails closed: without a configured App Secret, or without a valid signature,
 * the request is rejected. Meta signs every genuine delivery, so an unsigned
 * or mis-signed POST is treated as a forgery attempt.
 */
async function verifyWhatsAppSignature(
  req: Request,
  rawBody: ArrayBuffer,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret) {
    log.error(
      "WhatsApp webhook rejected: appSecret not configured — cannot verify Meta signature",
      { operation: "verifyWhatsAppSignature" },
    );
    return false;
  }
  const header = req.headers.get("x-hub-signature-256") ?? "";
  const providedHex = header.startsWith("sha256=") ? header.slice(7) : "";
  if (!providedHex) {
    log.warn("WhatsApp webhook rejected: missing X-Hub-Signature-256 header", {
      operation: "verifyWhatsAppSignature",
    });
    return false;
  }
  const valid = await verifyHmacSha256(appSecret, rawBody, providedHex);
  if (!valid) {
    log.warn("WhatsApp webhook rejected: invalid X-Hub-Signature-256", {
      operation: "verifyWhatsAppSignature",
    });
  }
  return valid;
}

/** Verify the signature, then parse and dispatch a WhatsApp webhook POST. */
async function handleWhatsAppWebhookPost(
  req: Request,
  appSecret: string | undefined,
  onPayload: (body: Record<string, unknown>) => void,
): Promise<Response> {
  const rawBody = await req.arrayBuffer();
  if (!(await verifyWhatsAppSignature(req, rawBody, appSecret))) {
    return new Response("Forbidden", { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody)) as Record<
      string,
      unknown
    >;
  } catch {
    log.warn("WhatsApp webhook rejected: body is not valid JSON", {
      operation: "handleWhatsAppWebhookPost",
    });
    return new Response("Bad Request", { status: 400 });
  }
  onPayload(body);
  return new Response("OK", { status: 200 });
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
  const from = typeof msg.from === "string" ? msg.from : undefined;
  if (!from) return;
  const textObj = msg.text as { body: string } | undefined;
  if (!textObj?.body) return;
  // Fail safe: with no configured owner phone, no sender is the owner.
  const isOwner = ownerPhone !== undefined && from === ownerPhone;
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

/** Options for sending a WhatsApp text message. */
interface SendWhatsAppMessageOptions {
  readonly phone: string;
  readonly text: string;
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly doFetch: typeof fetch;
}

/** Send a text message via WhatsApp Cloud API. */
async function sendWhatsAppTextMessage(
  opts: SendWhatsAppMessageOptions,
): Promise<void> {
  const response = await opts.doFetch(
    `${WA_API_BASE}/${opts.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: opts.phone,
        type: "text",
        text: { body: opts.text },
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
  await sendWhatsAppTextMessage({
    phone,
    text,
    phoneNumberId: config.phoneNumberId,
    accessToken: config.accessToken,
    doFetch: config.fetchFn ?? fetch,
  });
  log.info("WhatsApp message delivered", {
    operation: "send",
    sessionId: message.sessionId,
  });
}

/** Start the webhook HTTP server and mark the adapter as connected. */
function connectWhatsAppWebhook(
  config: WhatsAppConfig,
  webhookPort: number,
  state: WhatsAppAdapterState,
): void {
  if (!config.ownerPhone) {
    log.warn(
      "WhatsApp adapter started without ownerPhone — no sender will be treated as owner",
      {
        operation: "connectWhatsAppWebhook",
      },
    );
  }
  if (!config.appSecret) {
    log.error(
      "WhatsApp adapter started without appSecret — inbound webhooks will be rejected until configured",
      {
        operation: "connectWhatsAppWebhook",
      },
    );
  }
  const secrets = {
    verifyToken: config.verifyToken,
    appSecret: config.appSecret,
  };
  state.server = Deno.serve(
    { port: webhookPort },
    (req) =>
      handleWhatsAppWebhookRequest(req, secrets, (body) => {
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
    // Ownership is decided per-message (ChannelMessage.isOwner), never here.
    isOwner: false,
    // deno-lint-ignore require-await
    connect: async () => connectWhatsAppWebhook(config, webhookPort, state),
    disconnect: () => disconnectWhatsAppWebhook(state),
    send: (message: ChannelMessage) =>
      sendWhatsAppChannelMessage(message, config).catch((err: unknown) => {
        log.error("WhatsApp message delivery failed", {
          operation: "send",
          err,
          sessionId: message.sessionId,
        });
        throw err;
      }),
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
