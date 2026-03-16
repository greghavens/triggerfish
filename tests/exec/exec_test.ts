/**
 * Phase 11: Agent Execution Environment
 * Tests MUST FAIL until exec tools, workspace, and runner are implemented.
 * Tests write/run/read cycle, isolation, denied commands.
 * Extended with classification-partitioned workspace tests.
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createWorkspace } from "../../src/exec/workspace.ts";
import { createExecTools } from "../../src/exec/tools.ts";
import { createExecRunner } from "../../src/exec/runner.ts";
import { join } from "@std/path";

Deno.test("Workspace: creates isolated directory for agent", async () => {
  const ws = await createWorkspace({
    agentId: "test-agent",
    basePath: await Deno.makeTempDir(),
  });
  try {
    const stat = await Deno.stat(ws.path);
    assert(stat.isDirectory);
    assertExists(ws.scratchPath);
    assertExists(ws.integrationsPath);
    assertExists(ws.skillsPath);
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: write and read file in workspace", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws);
  try {
    const writeResult = await tools.write("test.ts", 'console.log("hello");\n');
    assertEquals(writeResult.ok, true);

    const readResult = await tools.read("test.ts");
    assertEquals(readResult.ok, true);
    if (readResult.ok) {
      assertStringIncludes(readResult.value, "hello");
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: run returns stdout, stderr, exit code", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws);
  try {
    const result = await tools.runCommand("echo hello");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.stdout, "hello");
      assertEquals(result.value.exitCode, 0);
      assert(typeof result.value.duration === "number");
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: run captures stderr and nonzero exit", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws);
  try {
    const result = await tools.runCommand("ls /nonexistent_directory_xyz");
    assertEquals(result.ok, true); // The tool succeeds in running, exit code is nonzero
    if (result.ok) {
      assert(result.value.exitCode !== 0);
      assert(result.value.stderr.length > 0);
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: write outside workspace is blocked", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws);
  try {
    const result = await tools.write("../../etc/evil.txt", "pwned");
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecRunner: blocks denied commands", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const runner = createExecRunner(ws, {
    denyList: ["rm -rf /", "sudo", "chmod 777"],
  });
  try {
    const result = await runner.executeCommand("sudo rm -rf /");
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: ls lists workspace files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws);
  try {
    await tools.write("file1.ts", "content1");
    await tools.write("file2.ts", "content2");
    const result = await tools.ls();
    assertEquals(result.ok, true);
    if (result.ok) {
      assert(result.value.some((f) => f.name === "file1.ts"));
      assert(result.value.some((f) => f.name === "file2.ts"));
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecRunner: logs all executions", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const runner = createExecRunner(ws);
  try {
    await runner.executeCommand("echo test");
    const history = await runner.getHistory();
    assert(history.length >= 1);
    assertExists(history[0].command);
    assertExists(history[0].timestamp);
  } finally {
    await ws.destroy();
  }
});

// --- Classification-partitioned workspace tests (spec §10.2, scenarios 8-12) ---

Deno.test("Workspace: creates classification directories on init", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test-cls", basePath: tmpDir });
  try {
    // Check classification directories exist
    assertExists(ws.internalPath);
    assertExists(ws.confidentialPath);
    assertExists(ws.restrictedPath);

    const internalStat = await Deno.stat(ws.internalPath);
    assert(internalStat.isDirectory);

    const confidentialStat = await Deno.stat(ws.confidentialPath);
    assert(confidentialStat.isDirectory);

    const restrictedStat = await Deno.stat(ws.restrictedPath);
    assert(restrictedStat.isDirectory);

    // Check subdirectories exist
    for (
      const dir of [ws.internalPath, ws.confidentialPath, ws.restrictedPath]
    ) {
      for (const sub of ["scratch", "integrations", "skills"]) {
        const stat = await Deno.stat(join(dir, sub));
        assert(stat.isDirectory);
      }
    }
  } finally {
    await ws.destroy();
  }
});

// Scenario 8: CONFIDENTIAL session writes to workspace → file lands in confidential/
Deno.test("Workspace: CONFIDENTIAL write resolves bare path to confidential/", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "notes.txt",
      "CONFIDENTIAL",
      "write",
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.absolutePath, "confidential");
      assertEquals(result.value.classification, "CONFIDENTIAL");
    }
  } finally {
    await ws.destroy();
  }
});

// Scenario 9: INTERNAL session reads confidential/report.txt → BLOCKED
Deno.test("Workspace: INTERNAL session cannot read confidential/ path", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "confidential/report.txt",
      "INTERNAL",
      "read",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

// Scenario 10: CONFIDENTIAL session reads internal/notes.txt → ALLOWED (read-down)
Deno.test("Workspace: CONFIDENTIAL session can read internal/ path (read-down)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "internal/notes.txt",
      "CONFIDENTIAL",
      "read",
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.classification, "INTERNAL");
    }
  } finally {
    await ws.destroy();
  }
});

// Scenario 11: RESTRICTED session writes to internal/ explicitly → BLOCKED (write-down)
Deno.test("Workspace: RESTRICTED session cannot write to internal/ (write-down)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "internal/notes.txt",
      "RESTRICTED",
      "write",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

// Scenario 12: CONFIDENTIAL session writes to bare path → resolves to confidential/
Deno.test("Workspace: bare path write resolves to session taint directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "notes.txt",
      "CONFIDENTIAL",
      "write",
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.absolutePath, "confidential");
      assert(result.value.absolutePath.endsWith("notes.txt"));
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: path traversal blocked in resolveClassifiedPath", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "../../etc/passwd",
      "CONFIDENTIAL",
      "read",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: PUBLIC session cannot access workspace files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "internal/notes.txt",
      "PUBLIC",
      "read",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: bare read searches readable levels for existing file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    // Write a file at INTERNAL level
    const encoder = new TextEncoder();
    await Deno.writeFile(
      join(ws.internalPath, "shared.txt"),
      encoder.encode("internal data"),
    );

    // CONFIDENTIAL session reads bare path "shared.txt" → finds it at INTERNAL
    const result = ws.resolveClassifiedPath(
      "shared.txt",
      "CONFIDENTIAL",
      "read",
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.classification, "INTERNAL");
      assertStringIncludes(result.value.absolutePath, "internal");
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace.containsPath: sibling workspace with shared prefix returns false", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "agent-foo", basePath: tmpDir });
  try {
    // /tmp/.../agent-foomalicious/secret is NOT within /tmp/.../agent-foo
    const sibling = ws.path + "malicious";
    assertEquals(ws.containsPath(sibling + "/secret.txt"), false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace.resolveClassifiedPath: ../ traversal attempt is blocked", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "../escape.txt",
      "INTERNAL",
      "write",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace.resolveClassifiedPath: absolute path escaping workspace is blocked", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  try {
    const result = ws.resolveClassifiedPath(
      "/etc/passwd",
      "CONFIDENTIAL",
      "read",
    );
    assertEquals(result.ok, false);
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: cwdOverride sets command working directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws, { cwdOverride: ws.confidentialPath });
  try {
    const result = await tools.runCommand("pwd");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.stdout.trim(), "confidential");
    }
  } finally {
    await ws.destroy();
  }
});

// --- cwdOverride sandbox confinement tests (regression: workspace root leak) ---

Deno.test("ExecTools: run_command with cwd '.' resolves to cwdOverride, not workspace root", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws, { cwdOverride: ws.publicPath });
  try {
    const result = await tools.runCommand("pwd", ".");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(
        result.value.stdout.trim(),
        "public",
      );
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: run_command with cwd '.' and PUBLIC override must not show classified dirs", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws, { cwdOverride: ws.publicPath });
  try {
    const result = await tools.runCommand("ls", ".");
    assertEquals(result.ok, true);
    if (result.ok) {
      const output = result.value.stdout;
      assert(
        !output.includes("confidential"),
        "PUBLIC cwd must not reveal confidential/",
      );
      assert(
        !output.includes("restricted"),
        "PUBLIC cwd must not reveal restricted/",
      );
      assert(
        !output.includes("internal"),
        "PUBLIC cwd must not reveal internal/",
      );
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: run_command with dynamic cwdOverride resolves cwd '.' per taint level", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  let currentPath = ws.publicPath;
  const tools = createExecTools(ws, { cwdOverride: () => currentPath });
  try {
    // PUBLIC taint → cwd "." should be public/
    const pubResult = await tools.runCommand("pwd", ".");
    assertEquals(pubResult.ok, true);
    if (pubResult.ok) {
      assertStringIncludes(pubResult.value.stdout.trim(), "public");
    }

    // Escalate to INTERNAL → cwd "." should be internal/
    currentPath = ws.internalPath;
    const intResult = await tools.runCommand("pwd", ".");
    assertEquals(intResult.ok, true);
    if (intResult.ok) {
      assertStringIncludes(intResult.value.stdout.trim(), "internal");
    }
  } finally {
    await ws.destroy();
  }
});

Deno.test("ExecTools: run_command with relative cwd resolves under cwdOverride", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({ agentId: "test", basePath: tmpDir });
  const tools = createExecTools(ws, { cwdOverride: ws.publicPath });
  try {
    // Create a subdir inside public/
    await Deno.mkdir(join(ws.publicPath, "myproject"), { recursive: true });
    const result = await tools.runCommand("pwd", "myproject");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value.stdout.trim(), "public/myproject");
    }
  } finally {
    await ws.destroy();
  }
});

// --- agentId sanitization tests ---

Deno.test("Workspace: agentId with newline is sanitized for path construction", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({
    agentId: "agent\ninjected",
    basePath: tmpDir,
  });
  try {
    assert(!ws.path.includes("\n"), "workspace path must not contain newline");
    assertEquals(ws.agentId, "agentinjected");
    const stat = await Deno.stat(ws.path);
    assert(stat.isDirectory);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: agentId with bidi override (U+202E) is sanitized", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({
    agentId: "agent\u202Eid",
    basePath: tmpDir,
  });
  try {
    assert(
      !ws.path.includes("\u202E"),
      "workspace path must not contain bidi override",
    );
    assertEquals(ws.agentId, "agentid");
    const stat = await Deno.stat(ws.path);
    assert(stat.isDirectory);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: agentId with zero-width space (U+200B) is sanitized", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({
    agentId: "agent\u200Bid",
    basePath: tmpDir,
  });
  try {
    assert(
      !ws.path.includes("\u200B"),
      "workspace path must not contain zero-width space",
    );
    assertEquals(ws.agentId, "agentid");
    const stat = await Deno.stat(ws.path);
    assert(stat.isDirectory);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: normal ASCII agentId is unchanged after sanitization", async () => {
  const tmpDir = await Deno.makeTempDir();
  const ws = await createWorkspace({
    agentId: "my-agent-123",
    basePath: tmpDir,
  });
  try {
    assertEquals(ws.agentId, "my-agent-123");
    assert(ws.path.endsWith("my-agent-123"));
    const stat = await Deno.stat(ws.path);
    assert(stat.isDirectory);
  } finally {
    await ws.destroy();
  }
});

Deno.test("Workspace: all-control-char agentId throws after sanitization", async () => {
  const tmpDir = await Deno.makeTempDir();
  await assertRejects(
    () => createWorkspace({ agentId: "\n\r\x00", basePath: tmpDir }),
    Error,
    "empty after sanitization",
  );
});
