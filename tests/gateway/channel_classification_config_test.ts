/**
 * Tests for channel classification config validation at the trust boundary.
 *
 * `resolveChannelClassification` replaces the unchecked `as
 * ClassificationLevel` casts in the channel wiring files: valid levels pass
 * through, absent values use the channel's documented fallback, and
 * unparseable values fail closed to PUBLIC.
 */
import { assertEquals } from "@std/assert";
import { resolveChannelClassification } from "../../src/gateway/startup/channels/channels_shared.ts";

Deno.test("resolveChannelClassification: valid configured level passes through", () => {
  const level = resolveChannelClassification({
    channel: "telegram",
    field: "classification",
    raw: "CONFIDENTIAL",
    fallback: "PUBLIC",
  });
  assertEquals(level, "CONFIDENTIAL");
});

Deno.test("resolveChannelClassification: absent value uses channel fallback", () => {
  const level = resolveChannelClassification({
    channel: "googlechat",
    field: "classification",
    raw: undefined,
    fallback: "INTERNAL",
  });
  assertEquals(level, "INTERNAL");
});

Deno.test("resolveChannelClassification: typo fails closed to PUBLIC, not the fallback", () => {
  const level = resolveChannelClassification({
    channel: "googlechat",
    field: "classification",
    raw: "CONFIDENTAL",
    fallback: "INTERNAL",
  });
  assertEquals(level, "PUBLIC");
});

Deno.test("resolveChannelClassification: lowercase value is rejected (fail closed)", () => {
  const level = resolveChannelClassification({
    channel: "signal",
    field: "pairing_classification",
    raw: "internal",
    fallback: "INTERNAL",
  });
  assertEquals(level, "PUBLIC");
});
