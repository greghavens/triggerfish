import { assertEquals } from "@std/assert";
import { createSlackChannel } from "../../src/channels/slack/adapter.ts";

Deno.test({
  name: "Slack factory does not authenticate or require network permissions",
  permissions: { net: false, env: true, read: true, sys: true },
  fn() {
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      signingSecret: "test-secret",
    });
    assertEquals(adapter.status(), { connected: false, channelType: "slack" });
    assertEquals(adapter.classification, "PUBLIC");
    assertEquals(adapter.isOwner, false);
  },
});
