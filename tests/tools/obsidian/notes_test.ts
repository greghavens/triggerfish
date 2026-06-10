/**
 * Note CRUD tests — read, create, update, search, list.
 */

import { assert, assertEquals } from "@std/assert";
import { createVaultContext } from "../../../src/tools/obsidian/vault.ts";
import { createNoteStore } from "../../../src/tools/obsidian/notes/notes.ts";
import { walkNotes } from "../../../src/tools/obsidian/notes/note_walker.ts";
import type { ObsidianVaultConfig } from "../../../src/tools/obsidian/types.ts";
import type { VaultContext } from "../../../src/tools/obsidian/vault.ts";

/** Create a temp vault with .obsidian marker and return the context. */
async function makeTempVaultCtx(
  overrides?: Partial<ObsidianVaultConfig>,
): Promise<{ ctx: VaultContext; path: string }> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian_test_" });
  await Deno.mkdir(`${dir}/.obsidian`);
  const result = await createVaultContext({
    vaultPath: dir,
    classification: "INTERNAL",
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error);
  return { ctx: result.value, path: dir };
}

// --- Read ---

Deno.test("NoteStore.read: reads existing note", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/hello.md`, "# Hello\n\nWorld");
    const store = createNoteStore(ctx);
    const result = await store.read("hello.md");
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.name, "hello");
      assertEquals(result.value.content, "# Hello\n\nWorld");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.read: returns error for missing note", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.read("missing.md");
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.read: rejects excluded paths", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.read(".obsidian/config.json");
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Create ---

Deno.test("NoteStore.create: creates a new note", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "new-note.md",
      content: "# New Note\n\nContent here.",
    });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.name, "new-note");
    }
    // Verify file exists
    const content = await Deno.readTextFile(`${path}/new-note.md`);
    assertEquals(content, "# New Note\n\nContent here.");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.create: adds .md extension if missing", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "no-extension",
      content: "Hello",
    });
    assert(result.ok);
    // File should have .md extension
    const content = await Deno.readTextFile(`${path}/no-extension.md`);
    assertEquals(content, "Hello");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.create: creates parent directories", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "deep/nested/note.md",
      content: "Nested content",
    });
    assert(result.ok);
    const content = await Deno.readTextFile(`${path}/deep/nested/note.md`);
    assertEquals(content, "Nested content");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.create: fails if note already exists", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/existing.md`, "Old content");
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "existing.md",
      content: "New content",
    });
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.create: applies frontmatter", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "tagged.md",
      content: "# Tagged\n\nContent",
      frontmatter: { tags: ["project", "important"] },
    });
    assert(result.ok);
    const content = await Deno.readTextFile(`${path}/tagged.md`);
    assert(content.includes("tags:"));
    assert(content.includes("project"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.create: applies template", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.mkdir(`${path}/templates`);
    await Deno.writeTextFile(
      `${path}/templates/daily.md`,
      "---\ntype: daily\n---\n# {{date}}\n\n",
    );
    const store = createNoteStore(ctx);
    const result = await store.create({
      path: "from-template.md",
      content: "",
      template: "templates/daily.md",
    });
    assert(result.ok);
    if (result.ok) {
      assert(result.value.content.includes("type: daily"));
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Update ---

Deno.test("NoteStore.update: replaces content", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/updatable.md`, "Old content");
    const store = createNoteStore(ctx);
    const result = await store.update({
      path: "updatable.md",
      content: "New content",
    });
    assert(result.ok);
    const content = await Deno.readTextFile(`${path}/updatable.md`);
    assertEquals(content, "New content");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.update: appends text", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/appendable.md`, "First line");
    const store = createNoteStore(ctx);
    const result = await store.update({
      path: "appendable.md",
      append: "Second line",
    });
    assert(result.ok);
    const content = await Deno.readTextFile(`${path}/appendable.md`);
    assert(content.includes("First line"));
    assert(content.includes("Second line"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.update: prepends text", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/prependable.md`, "Original");
    const store = createNoteStore(ctx);
    const result = await store.update({
      path: "prependable.md",
      prepend: "Before",
    });
    assert(result.ok);
    const content = await Deno.readTextFile(`${path}/prependable.md`);
    assert(content.startsWith("Before"));
    assert(content.includes("Original"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.update: merges frontmatter preserving existing keys", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/fm-merge.md`,
      "---\ntitle: Original\nauthor: Alice\n---\nBody",
    );
    const store = createNoteStore(ctx);
    const result = await store.update({
      path: "fm-merge.md",
      frontmatter: { title: "Updated", status: "active" },
    });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.frontmatter.title, "Updated");
      assertEquals(result.value.frontmatter.author, "Alice");
      assertEquals(result.value.frontmatter.status, "active");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Search ---

Deno.test("NoteStore.search: finds notes by content", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/alpha.md`,
      "# Alpha\n\nContains unique-keyword here.",
    );
    await Deno.writeTextFile(`${path}/beta.md`, "# Beta\n\nNo match here.");
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "unique-keyword" });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0].name, "alpha");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.search: finds notes by filename", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/meeting-notes.md`,
      "# Meeting\n\nGeneric content.",
    );
    await Deno.writeTextFile(`${path}/todo.md`, "# Todo\n\nMore content.");
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "meeting" });
    assert(result.ok);
    if (result.ok) {
      assert(result.value.some((n) => n.name === "meeting-notes"));
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.search: case-insensitive matching", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/note.md`,
      "Contains UPPERCASE and lowercase.",
    );
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "uppercase" });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 1);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.search: filters by folder", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.mkdir(`${path}/projects`);
    await Deno.mkdir(`${path}/personal`);
    await Deno.writeTextFile(`${path}/projects/work.md`, "keyword");
    await Deno.writeTextFile(`${path}/personal/diary.md`, "keyword");
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "keyword", folder: "projects" });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assert(result.value[0].path.startsWith("projects/"));
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.search: skips excluded folders", async () => {
  const { ctx, path } = await makeTempVaultCtx({ excludeFolders: ["archive"] });
  try {
    await Deno.mkdir(`${path}/archive`);
    await Deno.writeTextFile(`${path}/archive/old.md`, "searchable");
    await Deno.writeTextFile(`${path}/current.md`, "searchable");
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "searchable" });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0].name, "current");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- List ---

Deno.test("NoteStore.list: lists all notes", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/a.md`, "# A");
    await Deno.writeTextFile(`${path}/b.md`, "# B");
    await Deno.writeTextFile(`${path}/c.md`, "# C");
    const store = createNoteStore(ctx);
    const result = await store.list({});
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 3);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.list: sorts by name by default", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(`${path}/charlie.md`, "# C");
    await Deno.writeTextFile(`${path}/alpha.md`, "# A");
    await Deno.writeTextFile(`${path}/bravo.md`, "# B");
    const store = createNoteStore(ctx);
    const result = await store.list({});
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value[0].name, "alpha");
      assertEquals(result.value[1].name, "bravo");
      assertEquals(result.value[2].name, "charlie");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.list: respects maxResults", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    for (let i = 0; i < 10; i++) {
      await Deno.writeTextFile(`${path}/note-${i}.md`, `# Note ${i}`);
    }
    const store = createNoteStore(ctx);
    const result = await store.list({ maxResults: 3 });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 3);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("NoteStore.list: filters by tags", async () => {
  const { ctx, path } = await makeTempVaultCtx();
  try {
    await Deno.writeTextFile(
      `${path}/tagged.md`,
      "---\ntags:\n  - project\n---\n# Tagged",
    );
    await Deno.writeTextFile(`${path}/untagged.md`, "# Untagged");
    const store = createNoteStore(ctx);
    const result = await store.list({ tags: ["project"] });
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.length, 1);
      assertEquals(result.value[0].name, "tagged");
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Vault confinement (search/list folder) ---

/** Create a vault inside a parent dir that also holds an outside .md file. */
async function makeVaultWithOutsideNote(): Promise<
  { ctx: VaultContext; parent: string }
> {
  const parent = await Deno.makeTempDir({ prefix: "obsidian_escape_" });
  const vaultDir = `${parent}/vault`;
  await Deno.mkdir(`${vaultDir}/.obsidian`, { recursive: true });
  await Deno.mkdir(`${parent}/outside`);
  await Deno.writeTextFile(
    `${parent}/outside/leak.md`,
    "# Leak\n\nsecret content outside the vault",
  );
  const result = await createVaultContext({
    vaultPath: vaultDir,
    classification: "INTERNAL",
  });
  if (!result.ok) throw new Error(result.error);
  return { ctx: result.value, parent };
}

Deno.test("NoteStore.search: rejects folder escaping the vault", async () => {
  const { ctx, parent } = await makeVaultWithOutsideNote();
  try {
    const store = createNoteStore(ctx);
    const result = await store.search({
      query: "secret",
      folder: "../outside",
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path traversal rejected"));
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("NoteStore.search: rejects ../../etc folder traversal", async () => {
  const { ctx, parent } = await makeVaultWithOutsideNote();
  try {
    const store = createNoteStore(ctx);
    const result = await store.search({ query: "root", folder: "../../etc" });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path traversal rejected"));
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("NoteStore.list: rejects folder escaping the vault", async () => {
  const { ctx, parent } = await makeVaultWithOutsideNote();
  try {
    const store = createNoteStore(ctx);
    const result = await store.list({ folder: "../outside" });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path traversal rejected"));
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("NoteStore.search: rejects folder symlinked outside the vault", async () => {
  const { ctx, parent } = await makeVaultWithOutsideNote();
  try {
    await Deno.symlink(
      `${parent}/outside`,
      `${ctx.realVaultPath}/escape-hatch`,
    );
    const store = createNoteStore(ctx);
    const result = await store.search({
      query: "secret",
      folder: "escape-hatch",
    });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assert(result.error.includes("Path escapes vault boundary"));
    }
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("walkNotes: fails closed when folder escapes the vault", async () => {
  const { ctx, parent } = await makeVaultWithOutsideNote();
  try {
    const yielded = [];
    for await (const note of walkNotes(ctx, "../outside")) {
      yielded.push(note);
    }
    assertEquals(yielded.length, 0);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
