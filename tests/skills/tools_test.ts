/**
 * Tests for read_skill tool.
 *
 * Verifies that read_skill reads skill content correctly for both BUNDLED
 * and USER_PROVIDED types, returns appropriate errors for invalid input,
 * and — crucially — does not escalate session taint.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createSkillLoader } from "../../src/skills/loader.ts";
import {
  createSkillToolExecutor,
  getSkillToolDefinitions,
} from "../../src/skills/tools.ts";

const bundledDir = new URL("../../skills/bundled", import.meta.url).pathname;

function makeBundledLoader() {
  return createSkillLoader({
    directories: [bundledDir],
    dirTypes: { [bundledDir]: "bundled" },
  });
}

Deno.test("getSkillToolDefinitions: returns read_skill definition", () => {
  const defs = getSkillToolDefinitions();
  assertEquals(defs.length, 1);
  assertEquals(defs[0].name, "read_skill");
  assertEquals(defs[0].parameters.type.enum, ["BUNDLED", "USER_PROVIDED"]);
  assertEquals(defs[0].parameters.type.required, true);
  assertEquals(defs[0].parameters.skill_name.required, true);
});

Deno.test("read_skill: returns null for unknown tool names", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("some_other_tool", {
    type: "BUNDLED",
    skill_name: "weather",
  });
  assertEquals(result, null);
});

Deno.test("read_skill: reads a bundled skill successfully", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", {
    type: "BUNDLED",
    skill_name: "weather",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.found, true);
  assertEquals(parsed.skill_name, "weather");
  assertEquals(parsed.type, "BUNDLED");
  assertEquals(parsed.source, "bundled");
  assertStringIncludes(parsed.content, "weather");
  assertEquals(typeof parsed.classification_ceiling, "string");
  assertEquals(Array.isArray(parsed.requires_tools), true);
  assertEquals(Array.isArray(parsed.network_domains), true);
});

Deno.test("read_skill: not found returns available skill list", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", {
    type: "BUNDLED",
    skill_name: "nonexistent-skill",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.found, false);
  assertEquals(parsed.skill_name, "nonexistent-skill");
  assertEquals(parsed.type, "BUNDLED");
  assertStringIncludes(parsed.available, "weather");
});

Deno.test("read_skill: invalid type returns error message", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", {
    type: "INVALID",
    skill_name: "weather",
  });
  assertStringIncludes(result!, "Error:");
  assertStringIncludes(result!, "BUNDLED");
  assertStringIncludes(result!, "USER_PROVIDED");
});

Deno.test("read_skill: empty skill_name returns error message", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", {
    type: "BUNDLED",
    skill_name: "",
  });
  assertStringIncludes(result!, "Error:");
  assertStringIncludes(result!, "skill_name");
});

Deno.test("read_skill: missing skill_name returns error message", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", { type: "BUNDLED" });
  assertStringIncludes(result!, "Error:");
  assertStringIncludes(result!, "skill_name");
});

Deno.test(
  "read_skill: USER_PROVIDED returns not-found when only bundled skills loaded",
  async () => {
    const executor = createSkillToolExecutor({
      skillLoader: makeBundledLoader(),
    });
    const result = await executor("read_skill", {
      type: "USER_PROVIDED",
      skill_name: "weather",
    });

    const parsed = JSON.parse(result!);
    assertEquals(parsed.found, false);
    assertEquals(parsed.type, "USER_PROVIDED");
    // Bundled weather should not appear in USER_PROVIDED results
    assertEquals(parsed.available, "(none)");
  },
);

Deno.test("read_skill: USER_PROVIDED finds managed and workspace skills", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmpDir}/my-skill`);
    await Deno.writeTextFile(
      `${tmpDir}/my-skill/SKILL.md`,
      `---
name: my-skill
description: A user-provided test skill
classification_ceiling: INTERNAL
---
# My Skill
Does something useful.
`,
    );

    const loader = createSkillLoader({
      directories: [tmpDir],
      dirTypes: { [tmpDir]: "managed" },
    });
    const executor = createSkillToolExecutor({ skillLoader: loader });

    const result = await executor("read_skill", {
      type: "USER_PROVIDED",
      skill_name: "my-skill",
    });

    const parsed = JSON.parse(result!);
    assertEquals(parsed.found, true);
    assertEquals(parsed.skill_name, "my-skill");
    assertEquals(parsed.type, "USER_PROVIDED");
    assertEquals(parsed.source, "managed");
    assertEquals(parsed.classification_ceiling, "INTERNAL");
    assertStringIncludes(parsed.content, "Does something useful");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test(
  "read_skill: does not require or manipulate session taint",
  async () => {
    // The executor is constructed with no taint context and makes no taint
    // decisions. Session taint management belongs in the orchestrator layer.
    // This test verifies the executor works without any taint wiring.
    const executor = createSkillToolExecutor({
      skillLoader: makeBundledLoader(),
    });

    const result = await executor("read_skill", {
      type: "BUNDLED",
      skill_name: "weather",
    });

    const parsed = JSON.parse(result!);
    assertEquals(parsed.found, true);
    // No taint-related fields in the skill tool response
    assertEquals("taint" in parsed, false);
    assertEquals("session_taint" in parsed, false);
    assertEquals("escalated" in parsed, false);
  },
);

Deno.test("read_skill: skill_name is trimmed before lookup", async () => {
  const executor = createSkillToolExecutor({ skillLoader: makeBundledLoader() });
  const result = await executor("read_skill", {
    type: "BUNDLED",
    skill_name: "  weather  ",
  });

  const parsed = JSON.parse(result!);
  assertEquals(parsed.found, true);
  assertEquals(parsed.skill_name, "weather");
});
