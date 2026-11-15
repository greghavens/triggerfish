/**
 * Classification boundary tests — the most critical security tests.
 *
 * Verifies that:
 * - PUBLIC sessions cannot read CONFIDENTIAL notes
 * - CONFIDENTIAL sessions can read CONFIDENTIAL notes
 * - Write-down is prevented (RESTRICTED → INTERNAL folder)
 * - Per-folder classification overrides work correctly
 * - Lineage records are created for operations
 */

import { assert, assertEquals } from "@std/assert";
import {
  createVaultContext,
  getClassificationForPath,
} from "../../../src/tools/obsidian/vault.ts";
import { createNoteStore } from "../../../src/tools/obsidian/notes/notes.ts";
import { createDailyNoteManager } from "../../../src/tools/obsidian/daily.ts";
import { createLinkResolver } from "../../../src/tools/obsidian/links.ts";
import {
  createObsidianToolExecutor,
} from "../../../src/tools/obsidian/tools/tools.ts";
import type { ObsidianToolContext } from "../../../src/tools/obsidian/tools/tools_defs.ts";
import type { VaultContext } from "../../../src/tools/obsidian/vault.ts";
import type { ClassificationLevel } from "../../../src/core/types/classification.ts";
import { maxClassification } from "../../../src/core/types/classification.ts";
import type { SessionId } from "../../../src/core/types/session.ts";
import type {
  LineageCreateInput,
  LineageRecord,
  LineageStore,
} from "../../../src/core/session/lineage.ts";

/** Create a temp vault with classification-gated folders. */
async function makeClassifiedVault(): Promise<
  { ctx: VaultContext; path: string }
> {
  const dir = await Deno.makeTempDir({ prefix: "obsidian_class_" });
  await Deno.mkdir(`${dir}/.obsidian`);
  await Deno.mkdir(`${dir}/public`);
  await Deno.mkdir(`${dir}/confidential`);
  await Deno.mkdir(`${dir}/restricted`);
  await Deno.mkdir(`${dir}/internal`);

  await Deno.writeTextFile(
    `${dir}/public/readme.md`,
    "# Public Note\n\nPublic content.",
  );
  await Deno.writeTextFile(
    `${dir}/confidential/secret.md`,
    "# Secret\n\nConfidential data.",
  );
  await Deno.writeTextFile(
    `${dir}/restricted/top-secret.md`,
    "# Top Secret\n\nRestricted data.",
  );
  await Deno.writeTextFile(
    `${dir}/internal/work.md`,
    "# Work\n\nInternal content.",
  );

  const result = await createVaultContext({
    vaultPath: dir,
    classification: "INTERNAL",
    folderClassifications: {
      "public": "PUBLIC",
      "confidential": "CONFIDENTIAL",
      "restricted": "RESTRICTED",
      "internal": "INTERNAL",
    },
  });
  if (!result.ok) throw new Error(result.error);
  return { ctx: result.value, path: dir };
}

/** Create a mock lineage store that records calls. */
function createMockLineageStore(): {
  store: LineageStore;
  records: LineageRecord[];
} {
  const records: LineageRecord[] = [];
  let nextId = 1;

  const store: LineageStore = {
    create(input: LineageCreateInput): Promise<LineageRecord> {
      const record: LineageRecord = {
        lineage_id: `lineage-${nextId++}`,
        content_hash: `hash-${input.content}`,
        origin: input.origin,
        classification: input.classification,
        sessionId: input.sessionId,
        inputLineageIds: input.inputLineageIds,
        transformations: input.transformations,
        current_location: input.current_location,
      };
      records.push(record);
      return Promise.resolve(record);
    },
    get(_id: string): Promise<LineageRecord | null> {
      return Promise.resolve(null);
    },
    getBySession(_sid: SessionId): Promise<LineageRecord[]> {
      return Promise.resolve([]);
    },
    trace_forward(_id: string): Promise<LineageRecord[]> {
      return Promise.resolve([]);
    },
    trace_backward(_id: string): Promise<LineageRecord[]> {
      return Promise.resolve([]);
    },
    export(_sid: SessionId): Promise<LineageRecord[]> {
      return Promise.resolve([]);
    },
  };

  return { store, records };
}

/** Build a tool executor context at a given taint level. */
function buildToolCtx(
  vaultCtx: VaultContext,
  sessionTaint: ClassificationLevel,
  lineageStore?: LineageStore,
): ObsidianToolContext {
  const noteStore = createNoteStore(vaultCtx);
  return {
    vaultContext: vaultCtx,
    noteStore,
    dailyNoteManager: createDailyNoteManager(vaultCtx, noteStore),
    linkResolver: createLinkResolver(vaultCtx),
    getSessionTaint: () => sessionTaint,
    sessionId: "test-session" as SessionId,
    lineageStore,
  };
}

// --- Read classification enforcement ---

Deno.test("Classification: PUBLIC session blocked from reading CONFIDENTIAL note", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "PUBLIC");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_read", {
      name: "confidential/secret.md",
    });
    assert(result !== null);
    assert(result!.includes("Access denied"));
    assert(result!.includes("CONFIDENTIAL"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: CONFIDENTIAL session can read CONFIDENTIAL note", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "CONFIDENTIAL");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_read", {
      name: "confidential/secret.md",
    });
    assert(result !== null);
    assert(!result!.includes("Error"));
    const parsed = JSON.parse(result!);
    assertEquals(parsed.name, "secret");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: RESTRICTED session can read all classification levels", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "RESTRICTED");
    const executor = createObsidianToolExecutor(toolCtx);

    for (
      const notePath of [
        "public/readme.md",
        "internal/work.md",
        "confidential/secret.md",
        "restricted/top-secret.md",
      ]
    ) {
      const result = await executor("obsidian_read", { name: notePath });
      assert(result !== null);
      assert(!result!.includes("Error"), `Should be able to read ${notePath}`);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: PUBLIC session can only read PUBLIC notes", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "PUBLIC");
    const executor = createObsidianToolExecutor(toolCtx);

    // Should succeed
    const publicResult = await executor("obsidian_read", {
      name: "public/readme.md",
    });
    assert(publicResult !== null);
    assert(!publicResult!.includes("Error"));

    // Should fail
    for (
      const notePath of [
        "internal/work.md",
        "confidential/secret.md",
        "restricted/top-secret.md",
      ]
    ) {
      const result = await executor("obsidian_read", { name: notePath });
      assert(result !== null);
      assert(result!.includes("Access denied"), `Should not read ${notePath}`);
    }
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Write classification enforcement (write-down prevention) ---

Deno.test("Classification: RESTRICTED session blocked from writing to INTERNAL folder", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "RESTRICTED");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_write", {
      name: "internal/leaked.md",
      content: "This should not be written",
    });
    assert(result !== null);
    assert(result!.includes("Write-down prevented"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: CONFIDENTIAL session blocked from writing to PUBLIC folder", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "CONFIDENTIAL");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_write", {
      name: "public/leaked.md",
      content: "This should not be written",
    });
    assert(result !== null);
    assert(result!.includes("Write-down prevented"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: PUBLIC session can write to PUBLIC folder", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "PUBLIC");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_write", {
      name: "public/new-note.md",
      content: "Public content",
    });
    assert(result !== null);
    assert(!result!.includes("Error"));
    const parsed = JSON.parse(result!);
    assertEquals(parsed.written, true);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: INTERNAL session can write to CONFIDENTIAL folder", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "INTERNAL");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_write", {
      name: "confidential/promoted.md",
      content: "Promoted content",
    });
    assert(result !== null);
    assert(!result!.includes("Error"));
    const parsed = JSON.parse(result!);
    assertEquals(parsed.written, true);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Per-folder classification overrides ---

Deno.test("Classification: per-folder override takes precedence", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    // The vault default is INTERNAL, but "public" folder is overridden to PUBLIC
    assertEquals(getClassificationForPath(ctx, "public/anything.md"), "PUBLIC");
    assertEquals(
      getClassificationForPath(ctx, "confidential/anything.md"),
      "CONFIDENTIAL",
    );
    assertEquals(
      getClassificationForPath(ctx, "restricted/anything.md"),
      "RESTRICTED",
    );
    // Unmapped folder falls back to vault default
    assertEquals(
      getClassificationForPath(ctx, "unmapped/anything.md"),
      "INTERNAL",
    );
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Search and list respect classification ---

Deno.test("Classification: search filters out inaccessible notes", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "PUBLIC");
    const executor = createObsidianToolExecutor(toolCtx);
    // All notes contain "content" in some form
    const result = await executor("obsidian_search", { query: "content" });
    assert(result !== null);
    const parsed = JSON.parse(result!);
    // Only the PUBLIC note should be returned
    assert(
      parsed.results.every((r: { path: string }) =>
        r.path.startsWith("public/")
      ),
    );
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Outlinks classification gating (obsidian_links) ---

Deno.test("Classification: PUBLIC session blocked from CONFIDENTIAL outlinks", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    await Deno.writeTextFile(
      `${path}/confidential/linked.md`,
      "Links to [[secret]] here.",
    );
    const toolCtx = buildToolCtx(ctx, "PUBLIC");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_links", {
      note: "confidential/linked.md",
      direction: "outlinks",
    });
    assert(result !== null);
    assert(result!.includes("Access denied"));
    assert(result!.includes("CONFIDENTIAL"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: CONFIDENTIAL session can read CONFIDENTIAL outlinks", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    await Deno.writeTextFile(
      `${path}/confidential/linked.md`,
      "Links to [[secret]] here.",
    );
    const toolCtx = buildToolCtx(ctx, "CONFIDENTIAL");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_links", {
      note: "confidential/linked.md",
      direction: "outlinks",
    });
    assert(result !== null);
    assert(!result!.includes("Error"));
    const parsed = JSON.parse(result!);
    assertEquals(parsed.outlinks.length, 1);
    assertEquals(parsed.outlinks[0].link, "secret");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: obsidian_links outlinks rejects path traversal", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "RESTRICTED");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_links", {
      note: "../../etc/hosts",
      direction: "outlinks",
    });
    assert(result !== null);
    assert(result!.includes("Error"));
    assert(result!.includes("Path traversal rejected"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: obsidian_search rejects folder traversal", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "RESTRICTED");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_search", {
      query: "root",
      folder: "../../etc",
    });
    assert(result !== null);
    assert(result!.includes("Error"));
    assert(result!.includes("Path traversal rejected"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: obsidian_list rejects folder traversal", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const toolCtx = buildToolCtx(ctx, "RESTRICTED");
    const executor = createObsidianToolExecutor(toolCtx);
    const result = await executor("obsidian_list", { folder: "../../etc" });
    assert(result !== null);
    assert(result!.includes("Error"));
    assert(result!.includes("Path traversal rejected"));
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Lineage tracking ---

Deno.test("Classification: lineage record created on read", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const { store: lineageStore, records } = createMockLineageStore();
    const toolCtx = buildToolCtx(ctx, "RESTRICTED", lineageStore);
    const executor = createObsidianToolExecutor(toolCtx);

    await executor("obsidian_read", { name: "public/readme.md" });
    assertEquals(records.length, 1);
    assertEquals(records[0].origin.source_type, "obsidian_vault");
    assertEquals(records[0].origin.access_method, "obsidian_read");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Classification: lineage record created on write", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    const { store: lineageStore, records } = createMockLineageStore();
    const toolCtx = buildToolCtx(ctx, "PUBLIC", lineageStore);
    const executor = createObsidianToolExecutor(toolCtx);

    await executor("obsidian_write", {
      name: "public/new-lineage.md",
      content: "Tracked write",
    });
    assertEquals(records.length, 1);
    assertEquals(records[0].origin.source_type, "obsidian_vault");
    assertEquals(records[0].origin.access_method, "obsidian_write");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

// --- Tool executor auto-escalation tests ---
// These test the pattern used by createToolExecutor in main.ts:
// escalate session taint to vault classification BEFORE calling the plugin,
// so the plugin's getSessionTaint() already returns the escalated value.

Deno.test("Executor escalation: PUBLIC session escalated to INTERNAL sees INTERNAL notes", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    // Simulate: executor escalates taint to vault default (INTERNAL) before calling plugin
    let taint: ClassificationLevel = "PUBLIC";
    taint = maxClassification(taint, "INTERNAL"); // executor does this
    const toolCtx = buildToolCtx(ctx, taint);
    const executor = createObsidianToolExecutor(toolCtx);

    const result = await executor("obsidian_read", {
      name: "internal/work.md",
    });
    assert(result !== null);
    assert(
      !result!.includes("Error"),
      "Read should succeed after executor escalation",
    );
    const parsed = JSON.parse(result!);
    assertEquals(parsed.name, "work");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Executor escalation: write-down still prevented after escalation", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    // Executor escalates PUBLIC → INTERNAL, then write to PUBLIC folder = write-down
    let taint: ClassificationLevel = "PUBLIC";
    taint = maxClassification(taint, "INTERNAL"); // executor does this
    const toolCtx = buildToolCtx(ctx, taint);
    const executor = createObsidianToolExecutor(toolCtx);

    const result = await executor("obsidian_write", {
      name: "public/leaked.md",
      content: "Should be blocked",
    });
    assert(result !== null);
    assert(
      result!.includes("Write-down prevented"),
      "Write-down should still be blocked",
    );
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Executor escalation: search at INTERNAL sees PUBLIC + INTERNAL, not CONFIDENTIAL", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    // Executor escalates PUBLIC → INTERNAL (vault default) before search
    let taint: ClassificationLevel = "PUBLIC";
    taint = maxClassification(taint, "INTERNAL"); // executor does this
    const toolCtx = buildToolCtx(ctx, taint);
    const executor = createObsidianToolExecutor(toolCtx);

    const result = await executor("obsidian_search", { query: "content" });
    assert(result !== null);
    const parsed = JSON.parse(result!);
    const paths = parsed.results.map((r: { path: string }) => r.path);
    assert(
      paths.some((p: string) => p.startsWith("public/")),
      "Should include public notes",
    );
    assert(
      paths.some((p: string) => p.startsWith("internal/")),
      "Should include internal notes",
    );
    assert(
      !paths.some((p: string) => p.startsWith("confidential/")),
      "Should not include confidential notes",
    );
    assert(
      !paths.some((p: string) => p.startsWith("restricted/")),
      "Should not include restricted notes",
    );
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("Executor escalation: dynamic getter reflects taint changes across calls", async () => {
  const { ctx, path } = await makeClassifiedVault();
  try {
    // Simulate mutable session taint via closure — same pattern as main.ts
    let taint: ClassificationLevel = "PUBLIC";
    const noteStore = createNoteStore(ctx);
    const toolCtx: ObsidianToolContext = {
      vaultContext: ctx,
      noteStore,
      dailyNoteManager: createDailyNoteManager(ctx, noteStore),
      linkResolver: createLinkResolver(ctx),
      getSessionTaint: () => taint,
      sessionId: "test-session" as SessionId,
    };
    const executor = createObsidianToolExecutor(toolCtx);

    // At PUBLIC — cannot read INTERNAL
    const r1 = await executor("obsidian_read", { name: "internal/work.md" });
    assert(r1 !== null);
    assert(r1!.includes("Access denied"));

    // Executor escalates taint to INTERNAL (simulating tool executor behavior)
    taint = maxClassification(taint, "INTERNAL");

    // Now the same executor can read INTERNAL
    const r2 = await executor("obsidian_read", { name: "internal/work.md" });
    assert(r2 !== null);
    assert(!r2!.includes("Error"), "Should succeed after taint escalation");

    // Taint stays INTERNAL even when reading PUBLIC
    const r3 = await executor("obsidian_read", { name: "public/readme.md" });
    assert(r3 !== null);
    assert(!r3!.includes("Error"));
    assertEquals(taint, "INTERNAL");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});
