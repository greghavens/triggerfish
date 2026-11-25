/**
 * Phase 20: Skill author name validation (TOOLS-OTHER-5).
 *
 * The shared author rejects names outside the workspace skills directory
 * and publishes pending drafts without replacing existing skills.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { createSkillDraftApprovals } from "../../../src/tools/skills/draft_approvals.ts";
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
      const overwrite = await author.create({
        ...BASE_CREATE,
        name: "my-skill",
        content: "Replacement",
      });
      assertEquals(overwrite.ok, false);
      assertEquals(
        await Deno.readTextFile(join(dir, "my-skill", "SKILL.md")),
        md,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Skill creation upgrades a version-one registry and preserves existing approvals", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "skill-approvals.db");
    const registry = createSkillDraftApprovals(path);
    const digest = "a".repeat(64);
    const original = registry.record(dir, "legacy", digest, "owner");
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TABLE creations; PRAGMA user_version = 1;");
    } finally {
      db.close();
    }
    assertEquals(registry.list(dir).get("legacy")?.get(digest), original);
    assertEquals(registry.creation(dir, "pending"), undefined);
    const proposed = "b".repeat(64);
    const draft = "c".repeat(64);
    const creation = registry.reserveCreation(
      dir,
      "pending",
      proposed,
      draft,
      "owner",
    );
    assert(creation);
    assertEquals(registry.creation(dir, "pending"), creation);
    assertEquals(registry.list(dir).get("pending")?.size, 0);
    assertEquals(registry.list(dir).get("legacy")?.get(digest), original);
    assertEquals(
      registry.reserveCreation(
        dir,
        "pending",
        proposed,
        draft,
        "another-owner",
      ),
      creation,
    );
    assertEquals(
      registry.reserveCreation(dir, "pending", digest, draft, "owner"),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
