/**
 * Tests for plugin loading, manifest validation, and export validation.
 *
 * @module
 */

import { assertEquals } from "@std/assert";
import {
  validatePluginExports,
  validatePluginManifest,
} from "../../src/plugin/loader.ts";

// ─── Manifest validation ──────────────────────────────────────────────────────

Deno.test("validatePluginManifest accepts valid manifest", () => {
  const result = validatePluginManifest({
    name: "test-plugin",
    version: "1.0.0",
    description: "A test plugin",
    classification: "PUBLIC",
    trust: "sandboxed",
    declaredEndpoints: [],
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.name, "test-plugin");
    assertEquals(result.value.classification, "PUBLIC");
    assertEquals(result.value.trust, "sandboxed");
  }
});

Deno.test("validatePluginManifest rejects non-object manifest", () => {
  const result = validatePluginManifest("not an object");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginManifest rejects invalid name pattern", () => {
  const result = validatePluginManifest({
    name: "Invalid_Name",
    version: "1.0.0",
    description: "Bad name",
    classification: "PUBLIC",
    trust: "sandboxed",
    declaredEndpoints: [],
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("name"), true);
});

Deno.test("validatePluginManifest rejects empty version", () => {
  const result = validatePluginManifest({
    name: "test",
    version: "",
    description: "Empty version",
    classification: "PUBLIC",
    trust: "sandboxed",
    declaredEndpoints: [],
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("version"), true);
});

Deno.test("validatePluginManifest rejects invalid classification", () => {
  const result = validatePluginManifest({
    name: "test",
    version: "1.0.0",
    description: "Bad classification",
    classification: "SUPER_SECRET",
    trust: "sandboxed",
    declaredEndpoints: [],
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("classification"), true);
});

Deno.test("validatePluginManifest rejects invalid trust level", () => {
  const result = validatePluginManifest({
    name: "test",
    version: "1.0.0",
    description: "Bad trust",
    classification: "PUBLIC",
    trust: "admin",
    declaredEndpoints: [],
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.includes("trust"), true);
});

Deno.test("validatePluginManifest rejects missing declaredEndpoints", () => {
  const result = validatePluginManifest({
    name: "test",
    version: "1.0.0",
    description: "No endpoints",
    classification: "PUBLIC",
    trust: "sandboxed",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.includes("declaredEndpoints"), true);
  }
});

Deno.test("validatePluginManifest accepts all classification levels", () => {
  for (const level of ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]) {
    const result = validatePluginManifest({
      name: "test",
      version: "1.0.0",
      description: "Level test",
      classification: level,
      trust: "sandboxed",
      declaredEndpoints: [],
    });
    assertEquals(result.ok, true, `Expected ${level} to be valid`);
  }
});

// ─── Export validation ─────────────────────────────────────────────────────────

function validExports() {
  return {
    manifest: {
      name: "test-plugin",
      version: "1.0.0",
      description: "A test plugin",
      classification: "PUBLIC",
      trust: "sandboxed",
      declaredEndpoints: [],
    },
    toolDefinitions: [
      { name: "do_thing", description: "Does a thing", parameters: {} },
    ],
    // deno-lint-ignore require-await
    createExecutor: () => async () => null,
  };
}

Deno.test("validatePluginExports accepts valid exports", () => {
  const result = validatePluginExports(validExports(), "/test/mod.ts");
  assertEquals(result.ok, true);
});

Deno.test("validatePluginExports rejects non-object", () => {
  const result = validatePluginExports(null, "/test/mod.ts");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginExports rejects missing toolDefinitions", () => {
  const exports = { ...validExports() };
  // deno-lint-ignore no-explicit-any
  delete (exports as any).toolDefinitions;
  const result = validatePluginExports(exports, "/test/mod.ts");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginExports rejects missing createExecutor", () => {
  const exports = { ...validExports() };
  // deno-lint-ignore no-explicit-any
  delete (exports as any).createExecutor;
  const result = validatePluginExports(exports, "/test/mod.ts");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginExports rejects tool definition missing name", () => {
  const exports = {
    ...validExports(),
    toolDefinitions: [{ description: "No name", parameters: {} }],
  };
  const result = validatePluginExports(exports, "/test/mod.ts");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginExports rejects non-string systemPrompt", () => {
  const exports = { ...validExports(), systemPrompt: 42 };
  const result = validatePluginExports(exports, "/test/mod.ts");
  assertEquals(result.ok, false);
});

Deno.test("validatePluginExports accepts optional string systemPrompt", () => {
  const exports = { ...validExports(), systemPrompt: "Use the tools." };
  const result = validatePluginExports(exports, "/test/mod.ts");
  assertEquals(result.ok, true);
});
