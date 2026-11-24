/**
 * Link resolution tests — wikilink resolve, backlinks, outlinks.
 */

import { assert, assertEquals } from "@std/assert";
import { createVaultContext } from "../../../src/tools/obsidian/vault.ts";
import { createLinkResolver } from "../../../src/tools/obsidian/links.ts";
import type { VaultContext } from "../../../src/tools/obsidian/vault.ts";

/** Create a temp vault with .obsidian marker. */
async function makeTempVaultCtx(): Promise<
  { ctx: VaultContext; path: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian_links_" });
  await Deno.mkdir(`${dir}/.obsidian`);
  const result = await createVaultContext({
    vaultPath: dir,
    classification: "INTERNAL",
  });
  if (!result.ok) throw new Error(result.error);
  return { ctx: result.value, path: dir };
}

// --- resolveWikilink ---

Deno.test("LinkResolver.resolveWikilink: resolves exact match", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/Target Note.md`, "# Target");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.resolveWikilink("Target Note");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.resolvedPath, "Target Note.md");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.resolveWikilink: case-insensitive match", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/My Note.md`, "# My Note");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.resolveWikilink("my note");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.resolvedPath, "My Note.md");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.resolveWikilink: shortest path wins on conflict", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.mkdir(`${path}/deep/nested`, { recursive: true });
    await Deno.writeTextFile(`${path}/Note.md`, "# Top level");
    await Deno.writeTextFile(`${path}/deep/nested/Note.md`, "# Deep level");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.resolveWikilink("Note");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.resolvedPath, "Note.md");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.resolveWikilink: returns null for broken links", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const resolver = createLinkResolver(ctx);
    const result = await resolver.resolveWikilink("Nonexistent Note");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.resolvedPath, null);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- getBacklinks ---

Deno.test("LinkResolver.getBacklinks: finds notes linking to target", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/Target.md`, "# Target Note");
    await Deno.writeTextFile(
      `${path}/Source A.md`,
      "Links to [[Target]] here.",
    );
    await Deno.writeTextFile(
      `${path}/Source B.md`,
      "Also links to [[Target]] there.",
    );
    await Deno.writeTextFile(`${path}/Unrelated.md`, "No links here.");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getBacklinks("Target");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 2);
      const sourceNames = result.value.map((b) => b.sourceName).sort();
      assertEquals(sourceNames, ["Source A", "Source B"]);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.getBacklinks: returns empty for note with no backlinks", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/Lonely.md`, "# No one links to me");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getBacklinks("Lonely");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 0);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- getOutlinks ---

Deno.test("LinkResolver.getOutlinks: finds all wikilinks in a note", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/Source.md`,
      "Links to [[Alpha]] and [[Beta]] and [[Gamma]].",
    );
    await Deno.writeTextFile(`${path}/Alpha.md`, "# Alpha");
    await Deno.writeTextFile(`${path}/Beta.md`, "# Beta");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getOutlinks("Source.md");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 3);
      // Alpha and Beta should resolve, Gamma should be null
      const alpha = result.value.find((t) => t.link === "Alpha");
      const gamma = result.value.find((t) => t.link === "Gamma");
      assert(alpha);
      assertEquals(alpha!.resolvedPath, "Alpha.md");
      assert(gamma);
      assertEquals(gamma!.resolvedPath, null);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.getOutlinks: handles note with no links", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/Plain.md`, "Just plain text, no links.");
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getOutlinks("Plain.md");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 0);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.getOutlinks: rejects path traversal outside vault", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getOutlinks("../../etc/hosts");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path traversal rejected"));
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.getOutlinks: rejects absolute path outside vault", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const resolver = createLinkResolver(ctx);
    const result = await resolver.getOutlinks("/etc/hosts");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path traversal rejected"));
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("LinkResolver.getOutlinks: rejects note symlinked outside vault", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const outside = await Deno.makeTempDir({ prefix: "obsidian_outside_" });
    try {
      await Deno.writeTextFile(`${outside}/leak.md`, "[[Secret]] outside");
      await Deno.symlink(`${outside}/leak.md`, `${path}/sneaky.md`);
      const resolver = createLinkResolver(ctx);
      const result = await resolver.getOutlinks("sneaky.md");
      assertEquals(result.ok, false);
      if (!result.ok) {
        assert(result.error.includes("Path escapes vault boundary"));
      }
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});
