/**
 * Tests for settings screen types.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import { SETTINGS_SECTIONS } from "../../../src/tools/tidepool/screens/settings.ts";
import type {
  SettingsField,
  SettingsFormState,
} from "../../../src/tools/tidepool/screens/settings_fields.ts";

Deno.test("SETTINGS_SECTIONS contains 7 sections", () => {
  assertEquals(SETTINGS_SECTIONS.length, 7);
  assertEquals(SETTINGS_SECTIONS.includes("general"), true);
  assertEquals(SETTINGS_SECTIONS.includes("providers"), true);
  assertEquals(SETTINGS_SECTIONS.includes("channels"), true);
  assertEquals(SETTINGS_SECTIONS.includes("classification"), true);
  assertEquals(SETTINGS_SECTIONS.includes("scheduler"), true);
  assertEquals(SETTINGS_SECTIONS.includes("integrations"), true);
  assertEquals(SETTINGS_SECTIONS.includes("advanced"), true);
});

Deno.test("SettingsField types are valid", () => {
  const field: SettingsField = {
    key: "agent_name",
    label: "Agent Name",
    type: "text",
    placeholder: "My Agent",
  };
  assertEquals(field.type, "text");
});

Deno.test("SettingsFormState tracks dirty state", () => {
  const state: SettingsFormState = {
    section: "general",
    fields: [],
    values: {},
    dirty: false,
    errors: {},
  };
  assertEquals(state.dirty, false);
});

Deno.test("buildTidepoolHtml includes settings screen", async () => {
  const { buildTidepoolHtml } = await import(
    "../../../src/tools/tidepool/ui.ts"
  );
  const html = buildTidepoolHtml();
  assertEquals(html.includes("settings-screen"), true);
  assertEquals(html.includes("settings-sidebar"), true);
  assertEquals(html.includes("readonly-badge"), true);
});
