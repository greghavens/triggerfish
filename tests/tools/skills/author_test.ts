/**
 * Phase 20: Skill author name validation (TOOLS-OTHER-5).
 *
 * The author is currently unwired; this guard ensures a hostile skill
 * name can never escape the workspace skills directory once it is wired.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createSkillAuthor } from "../../../src/tools/skills/author.ts";

function makeAuthor(skillsDir: string) {
  return createSkillAuthor({ skillsDir, userCeiling: "CONFIDENTIAL" });
}

const BASE_CREATE = {
  description: "test skill",
  classificationCeiling: "PUBLIC" as const,
  content: "# Test",
};

Deno.test("SkillAuthor: rejects path-traversal skill name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const author = makeAuthor(dir);
    const result = await author.create({ ...BASE_CREATE, name: "../../x" });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("invalid characters"));
    }
    // Nothing may have been written outside or inside the skills dir.
    const entries = [...Deno.readDirSync(dir)];
    assertEquals(entries.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SkillAuthor: rejects absolute-path skill name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const author = makeAuthor(dir);
    const result = await author.create({ ...BASE_CREATE, name: "/etc/x" });
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SkillAuthor: rejects uppercase and dotted skill names", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const author = makeAuthor(dir);
    assertEquals(
      (await author.create({ ...BASE_CREATE, name: "Bad" })).ok,
      false,
    );
    assertEquals(
      (await author.create({ ...BASE_CREATE, name: "a.b" })).ok,
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SkillAuthor: valid name creates a PENDING_APPROVAL skill", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const author = makeAuthor(dir);
    const result = await author.create({ ...BASE_CREATE, name: "my-skill" });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.status, "PENDING_APPROVAL");
      assertEquals(result.value.path, join(dir, "my-skill"));
      const md = await Deno.readTextFile(join(dir, "my-skill", "SKILL.md"));
      assert(md.includes("name: my-skill"));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
