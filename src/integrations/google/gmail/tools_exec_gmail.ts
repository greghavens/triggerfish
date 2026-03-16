/**
 * Gmail tool executor.
 *
 * Handles dispatch for gmail_search, gmail_read, gmail_send, and gmail_label.
 *
 * @module
 */

import type { GmailService } from "../types.ts";

/** Validate that a value is a non-empty string. */
function requireNonEmptyString(
  value: unknown,
  field: string,
  tool: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `Error: ${tool} requires a non-empty '${field}' argument.`;
  }
  return null;
}

/** Parse a comma-separated string into a trimmed, non-empty array. */
function parseCommaSeparated(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Format gmail_search results into a JSON string. */
function formatSearchResults(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly from: string;
    readonly subject: string;
    readonly date: string;
    readonly snippet: string;
    readonly labelIds: readonly string[];
  }>,
): string {
  return JSON.stringify(
    messages.map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      date: m.date,
      snippet: m.snippet,
      labels: m.labelIds,
    })),
  );
}

/** Execute gmail_search tool. */
export async function queryGmailMessages(
  gmail: GmailService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(input.query, "query", "gmail_search");
  if (err) return err;

  const maxResults = typeof input.max_results === "number"
    ? input.max_results
    : 10;
  const result = await gmail.search({
    query: input.query as string,
    maxResults,
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  if (result.value.length === 0) {
    return `No emails found for query: "${input.query}"`;
  }
  return formatSearchResults(result.value);
}

/** @deprecated Use queryGmailMessages instead */
export const executeGmailSearch = queryGmailMessages;

/** Execute gmail_read tool. */
export async function readGmailMessage(
  gmail: GmailService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(
    input.message_id,
    "message_id",
    "gmail_read",
  );
  if (err) return err;

  const result = await gmail.read(input.message_id as string);
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    id: result.value.id,
    from: result.value.from,
    to: result.value.to,
    subject: result.value.subject,
    date: result.value.date,
    body: result.value.body,
    labels: result.value.labelIds,
  });
}

/** @deprecated Use readGmailMessage instead */
export const executeGmailRead = readGmailMessage;

/** Execute gmail_send tool. */
export async function sendGmailMessage(
  gmail: GmailService,
  input: Record<string, unknown>,
): Promise<string> {
  const toErr = requireNonEmptyString(input.to, "to", "gmail_send");
  if (toErr) return toErr;
  const subErr = requireNonEmptyString(input.subject, "subject", "gmail_send");
  if (subErr) return subErr;
  const bodyErr = requireNonEmptyString(input.body, "body", "gmail_send");
  if (bodyErr) return bodyErr;

  const result = await gmail.send({
    to: input.to as string,
    subject: input.subject as string,
    body: input.body as string,
    cc: typeof input.cc === "string" ? input.cc : undefined,
    bcc: typeof input.bcc === "string" ? input.bcc : undefined,
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({ sent: true, id: result.value.id });
}

/** @deprecated Use sendGmailMessage instead */
export const executeGmailSend = sendGmailMessage;

/** Execute gmail_label tool. */
export async function labelGmailMessage(
  gmail: GmailService,
  input: Record<string, unknown>,
): Promise<string> {
  const err = requireNonEmptyString(
    input.message_id,
    "message_id",
    "gmail_label",
  );
  if (err) return err;

  const result = await gmail.label({
    messageId: input.message_id as string,
    addLabelIds: parseCommaSeparated(input.add_labels),
    removeLabelIds: parseCommaSeparated(input.remove_labels),
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({ labeled: true, id: result.value.id });
}

/** @deprecated Use labelGmailMessage instead */
export const executeGmailLabel = labelGmailMessage;
