/**
 * Fail-closed owner determination tests (CHANNELS-1).
 *
 * resolveOwnerStatus is the single comparison shared by the Discord,
 * Telegram, Slack, and Email adapters: with no configured owner
 * identifier, NO sender may ever be treated as the owner.
 *
 * @module
 */
import { assertEquals } from "@std/assert";
import { resolveOwnerStatus } from "../../src/channels/owner_status.ts";

Deno.test("resolveOwnerStatus: unconfigured ownerId means no sender is owner (fail closed)", () => {
  assertEquals(resolveOwnerStatus("123456", undefined), false);
  assertEquals(resolveOwnerStatus(987654, undefined), false);
  assertEquals(resolveOwnerStatus("anyone@example.com", undefined), false);
});

Deno.test("resolveOwnerStatus: empty-string ownerId is treated as unconfigured", () => {
  assertEquals(resolveOwnerStatus("123456", ""), false);
});

Deno.test("resolveOwnerStatus: unknown sender is never the owner", () => {
  assertEquals(resolveOwnerStatus(undefined, "123456"), false);
  assertEquals(resolveOwnerStatus("", "123456"), false);
});

Deno.test("resolveOwnerStatus: matching identifiers grant owner status", () => {
  assertEquals(resolveOwnerStatus("123456", "123456"), true);
  assertEquals(
    resolveOwnerStatus("owner@example.com", "owner@example.com"),
    true,
  );
});

Deno.test("resolveOwnerStatus: numeric sender matches its YAML string form (Telegram)", () => {
  assertEquals(resolveOwnerStatus(123456, "123456"), true);
  assertEquals(resolveOwnerStatus(123456, 123456), true);
});

Deno.test("resolveOwnerStatus: mismatched identifiers are non-owner", () => {
  assertEquals(resolveOwnerStatus("attacker", "123456"), false);
  assertEquals(resolveOwnerStatus(999, 123456), false);
});
