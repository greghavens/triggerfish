/**
 * Email channel adapter via SMTP/IMAP.
 *
 * Sends replies via SMTP relay API and receives incoming messages
 * via IMAP polling. Uses the ImapClient abstraction for receive,
 * which can be swapped with a mock for testing.
 *
 * @module
 */

import { createLogger } from "../../core/logger/logger.ts";
import { safeFetch } from "../../core/security/mod.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
  MessageHandler,
} from "../types.ts";
import type { ImapClient } from "./imap.ts";
import { createImapClient } from "./imap.ts";

/** Configuration for the Email channel adapter. */
export interface EmailConfig {
  /** SMTP relay API endpoint (e.g. SendGrid, Mailgun). */
  readonly smtpApiUrl: string;
  /** API key for the SMTP relay service. */
  readonly smtpApiKey: string;
  /** IMAP server hostname for receiving. */
  readonly imapHost: string;
  /** IMAP server port. Default: 993 */
  readonly imapPort?: number;
  /** IMAP username (usually email address). */
  readonly imapUser: string;
  /** IMAP password or app-specific password. */
  readonly imapPassword: string;
  /** From address for outgoing emails. */
  readonly fromAddress: string;
  /** Poll interval in ms for checking new emails. Default: 30000 */
  readonly pollInterval?: number;
  /** Classification level for this channel. Default: CONFIDENTIAL */
  readonly classification?: ClassificationLevel;
  /** Owner's email address for isOwner checks. */
  readonly ownerEmail?: string;
  /** Injected IMAP client for testing. If not provided, a real client is created. */
  readonly _imapClient?: ImapClient;
}

// ─── Mutable email adapter state ────────────────────────────────────────────

const emailLog = createLogger("email");

/** Mutable state shared across email adapter helpers. */
interface EmailAdapterState {
  connected: boolean;
  handler: MessageHandler | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  readonly imapClient: ImapClient;
}

// ─── SMTP relay helpers ─────────────────────────────────────────────────────

/** Build the JSON body for an SMTP relay API request. */
function buildSmtpPayload(
  fromAddress: string,
  toAddress: string,
  content: string,
): string {
  return JSON.stringify({
    personalizations: [{ to: [{ email: toAddress }] }],
    from: { email: fromAddress },
    subject: "Triggerfish",
    content: [{ type: "text/plain", value: content }],
  });
}

/** Build the RequestInit for an SMTP relay API request. */
function buildSmtpRequest(
  config: EmailConfig,
  toAddress: string,
  content: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.smtpApiKey}`,
    },
    body: buildSmtpPayload(config.fromAddress, toAddress, content),
  };
}

/** Send an email via the SMTP relay HTTP API (SSRF-checked). */
async function sendSmtpRelay(
  config: EmailConfig,
  toAddress: string,
  content: string,
): Promise<void> {
  const result = await safeFetch(
    config.smtpApiUrl,
    buildSmtpRequest(config, toAddress, content),
  );
  if (!result.ok) {
    emailLog.warn("Email SMTP relay send blocked or failed", {
      smtpApiUrl: config.smtpApiUrl,
      reason: result.error,
    });
    throw new Error(`Email send failed: ${result.error}`);
  }
  if (!result.value.ok) {
    const err = await result.value.text();
    throw new Error(`Email send failed (${result.value.status}): ${err}`);
  }
}

// ─── Incoming email helpers ─────────────────────────────────────────────────

/** Determine if an email sender is the owner. */
function resolveEmailOwnership(
  senderAddress: string,
  ownerEmail: string | undefined,
): boolean {
  return ownerEmail !== undefined ? senderAddress === ownerEmail : true;
}

/** Dispatch a received email message to the registered handler. */
function dispatchEmailMessage(
  msgHandler: MessageHandler,
  ownerEmail: string | undefined,
  msg: {
    readonly from: string;
    readonly subject: string;
    readonly body: string;
  },
): void {
  const sessionId = `email-${msg.from}`;
  const isOwner = resolveEmailOwnership(msg.from, ownerEmail);
  emailLog.debug("Email received", {
    from: msg.from,
    subject: msg.subject,
    isOwner,
  });
  msgHandler({
    content: msg.body || msg.subject,
    sessionId,
    senderId: msg.from,
    isOwner,
    sessionTaint: isOwner ? undefined : ("PUBLIC" as ClassificationLevel),
  });
}

/** Poll the IMAP inbox for unseen messages and dispatch each. */
async function pollEmailInbox(
  adapterState: EmailAdapterState,
  ownerEmail: string | undefined,
): Promise<void> {
  if (!adapterState.handler) return;
  try {
    const messages = await adapterState.imapClient.fetchUnseen();
    for (const msg of messages) {
      dispatchEmailMessage(adapterState.handler, ownerEmail, msg);
    }
  } catch (err: unknown) {
    emailLog.warn("IMAP unseen email poll failed", { error: err });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an Email channel adapter.
 *
 * Sends via SMTP relay HTTP API and receives via IMAP polling.
 * Each email thread is mapped to a session ID based on the sender address.
 *
 * @param config - Email configuration.
 * @returns A ChannelAdapter wired to email.
 */
export function createEmailChannel(config: EmailConfig): ChannelAdapter {
  const classification = (config.classification ??
    "CONFIDENTIAL") as ClassificationLevel;
  const pollInterval = config.pollInterval ?? 30000;

  const adapterState: EmailAdapterState = {
    connected: false,
    handler: null,
    pollTimer: null,
    imapClient: config._imapClient ?? createImapClient({
      host: config.imapHost,
      port: config.imapPort ?? 993,
      user: config.imapUser,
      password: config.imapPassword,
      tls: true,
    }),
  };

  return {
    classification,
    isOwner: true,

    async connect(): Promise<void> {
      await adapterState.imapClient.connect();
      adapterState.pollTimer = setInterval(async () => {
        await pollEmailInbox(adapterState, config.ownerEmail);
      }, pollInterval);
      await pollEmailInbox(adapterState, config.ownerEmail);
      adapterState.connected = true;
      emailLog.info("Email adapter connected", { imapHost: config.imapHost });
    },

    async disconnect(): Promise<void> {
      if (adapterState.pollTimer) {
        clearInterval(adapterState.pollTimer);
        adapterState.pollTimer = null;
      }
      await adapterState.imapClient.disconnect();
      adapterState.connected = false;
      emailLog.info("Email adapter disconnected");
    },

    async send(message: ChannelMessage): Promise<void> {
      if (!message.sessionId) return;
      const toAddress = message.sessionId.replace("email-", "");
      await sendSmtpRelay(config, toAddress, message.content);
    },

    onMessage(msgHandler: MessageHandler): void {
      adapterState.handler = msgHandler;
    },

    status(): ChannelStatus {
      return { connected: adapterState.connected, channelType: "email" };
    },
  };
}
