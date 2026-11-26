import { createHmac } from "node:crypto";
import type { ManagedNotificationProvider } from "../../core/managed_notification_channels.ts";
import {
  consumeStreamWithLimit,
  decodeStreamChunks,
} from "../../tools/web/fetch_content.ts";

function exactQuery(url: URL, key: string): boolean {
  const entries = [...url.searchParams.entries()];
  return entries.length === 1 && entries[0][0] === key && !!entries[0][1];
}

export function matchesNotificationProviderEndpoint(
  provider: ManagedNotificationProvider,
  url: URL,
): boolean {
  switch (provider) {
    case "webhook":
      return true;
    case "dingtalk":
      return url.origin === "https://oapi.dingtalk.com" &&
        url.pathname === "/robot/send" && exactQuery(url, "access_token");
    case "feishu":
      return url.origin === "https://open.feishu.cn" && !url.search &&
        /^\/open-apis\/bot\/v2\/hook\/[a-z0-9_-]{1,160}$/i.test(url.pathname);
    case "wecom":
      return url.origin === "https://qyapi.weixin.qq.com" &&
        url.pathname === "/cgi-bin/webhook/send" && exactQuery(url, "key");
  }
}

export function notificationProviderRequest(
  provider: ManagedNotificationProvider,
  endpoint: URL,
  body: string,
  signingSecret: string | undefined,
  now: number,
) {
  const target = new URL(endpoint);
  if (provider === "webhook") return { target, body };
  const title = "Triggerfish notification";
  // Event bodies are already minimized, classified JSON. Escape HTML and inline-code delimiters.
  const text = body.replace(
    /[<>`]/g,
    (value) => ({ "<": "&lt;", ">": "&gt;", "`": "&#96;" })[value]!,
  );
  if (provider === "dingtalk") {
    if (signingSecret) {
      const timestamp = String(now);
      const sign = createHmac("sha256", signingSecret)
        .update(`${timestamp}\n${signingSecret}`).digest("base64");
      target.searchParams.set("timestamp", timestamp);
      target.searchParams.set("sign", sign);
    }
    return {
      target,
      body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }),
    };
  }
  if (provider === "feishu") {
    const timestamp = String(Math.floor(now / 1000));
    const signing = signingSecret
      ? {
        timestamp,
        sign: createHmac("sha256", `${timestamp}\n${signingSecret}`).digest(
          "base64",
        ),
      }
      : {};
    return {
      target,
      body: JSON.stringify({
        msg_type: "interactive",
        ...signing,
        card: {
          header: { title: { tag: "plain_text", content: title } },
          elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
        },
      }),
    };
  }
  return {
    target,
    body: JSON.stringify({ msgtype: "markdown", markdown: { content: text } }),
  };
}

export async function notificationProviderOutcome(
  provider: ManagedNotificationProvider,
  response: Response,
): Promise<"delivered" | "rejected" | "rate_limited" | "uncertain"> {
  if (!response.ok || provider === "webhook") {
    await response.body?.cancel().catch(() => {});
    return response.ok ? "delivered" : "uncertain";
  }
  if (!response.body) return "uncertain";
  const reader = response.body.getReader();
  try {
    const { chunks, truncated } = await consumeStreamWithLimit(reader, 8192);
    if (truncated) return "uncertain";
    const ack = JSON.parse(decodeStreamChunks(chunks).text) as
      | Record<string, unknown>
      | null;
    if (!ack) return "uncertain";
    const fields = provider === "feishu"
      ? [ack.code, ack.StatusCode]
      : [ack.errcode];
    const reported = fields.filter((value) => value !== undefined);
    // Feishu's custom-bot contract documents 11232 as a send that failed
    // due to rate limiting. Conflicting acknowledgements grant no retry.
    if (
      provider === "feishu" && reported.length &&
      reported.every((value) => value === 11232)
    ) return "rate_limited";
    return reported.length &&
        reported.every((value) => typeof value === "number")
      ? reported.every((value) => value === 0) ? "delivered" : "rejected"
      : "uncertain";
  } finally {
    reader.releaseLock();
  }
}
