/**
 * Phase 13: CLI, Installation & Daemon Management
 * Tests MUST FAIL until cli/main.ts, cli/daemon.ts, and build system are implemented.
 * Aligned with design doc Section 29: standalone binary, OS-native daemons.
 */
import { assertEquals, assertExists, assert, assertStringIncludes } from "@std/assert";

// --- Command parsing ---

Deno.test({
  name: "CLI: parses 'run' command",
  // SQLite FFI library loaded on import — cannot be closed in test context
  sanitizeResources: false,
  fn: async () => {
    const { parseCommand } = await import("../../src/cli/main.ts");
    const cmd = parseCommand(["run"]);
    assertEquals(cmd.command, "run");
  },
});

Deno.test("CLI: parses 'start' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["start"]);
  assertEquals(cmd.command, "start");
});

Deno.test("CLI: parses 'stop' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["stop"]);
  assertEquals(cmd.command, "stop");
});

Deno.test("CLI: parses 'status' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["status"]);
  assertEquals(cmd.command, "status");
});

Deno.test("CLI: parses 'logs' command with --tail flag", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["logs", "--tail"]);
  assertEquals(cmd.command, "logs");
  assertEquals(cmd.flags.tail, true);
});

Deno.test("CLI: parses 'logs view' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["logs", "view"]);
  assertEquals(cmd.command, "logs");
  assertEquals(cmd.subcommand, "view");
});

Deno.test("CLI: parses 'logs view' subcommand with --tail flag", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["logs", "view", "--tail"]);
  assertEquals(cmd.command, "logs");
  assertEquals(cmd.subcommand, "view");
  assertEquals(cmd.flags.tail, true);
});

Deno.test("CLI: parses 'logs bundle' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["logs", "bundle"]);
  assertEquals(cmd.command, "logs");
  assertEquals(cmd.subcommand, "bundle");
});

Deno.test("CLI: parses 'tidepool url' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["tidepool", "url"]);
  assertEquals(cmd.command, "tidepool");
  assertEquals(cmd.subcommand, "url");
});

Deno.test("CLI: parses 'dive' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["dive"]);
  assertEquals(cmd.command, "dive");
});

Deno.test("CLI: parses 'patrol' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["patrol"]);
  assertEquals(cmd.command, "patrol");
});

Deno.test("CLI: parses 'config edit' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["config", "edit"]);
  assertEquals(cmd.command, "config");
  assertEquals(cmd.subcommand, "edit");
});

Deno.test("CLI: parses 'config validate' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["config", "validate"]);
  assertEquals(cmd.command, "config");
  assertEquals(cmd.subcommand, "validate");
});

Deno.test("CLI: parses 'config remove-channel signal' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["config", "remove-channel", "signal"]);
  assertEquals(cmd.command, "config");
  assertEquals(cmd.subcommand, "remove-channel");
  assertEquals(cmd.flags.channel_type, "signal");
});

Deno.test("CLI: parses 'config remove-channel' without type", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["config", "remove-channel"]);
  assertEquals(cmd.command, "config");
  assertEquals(cmd.subcommand, "remove-channel");
  assertEquals(cmd.flags.channel_type, undefined);
});

Deno.test("CLI: parses 'run-triggers' command", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["run-triggers"]);
  assertEquals(cmd.command, "run-triggers");
});

Deno.test("CLI: 'run-triggers' does not fall through to help (hidden debug command)", async () => {
  // run-triggers should parse as itself (not fall through to "help"),
  // confirming it is a known command even though it is absent from showHelp().
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["run-triggers"]);
  assertEquals(cmd.command, "run-triggers");
});

Deno.test("CLI: unknown command returns help suggestion", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["nonexistent"]);
  assertEquals(cmd.command, "help");
});

Deno.test("CLI: no args defaults to 'dive' when no config exists", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand([], { configExists: false });
  assertEquals(cmd.command, "dive");
});

Deno.test("CLI: --version flag shows version", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["--version"]);
  assertEquals(cmd.command, "version");
});

// --- Connect / Disconnect ---

Deno.test("CLI: parses 'connect google' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["connect", "google"]);
  assertEquals(cmd.command, "connect");
  assertEquals(cmd.subcommand, "google");
});

Deno.test("CLI: parses 'disconnect google' subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["disconnect", "google"]);
  assertEquals(cmd.command, "disconnect");
  assertEquals(cmd.subcommand, "google");
});

Deno.test("CLI: 'connect' without subcommand has no subcommand", async () => {
  const { parseCommand } = await import("../../src/cli/main.ts");
  const cmd = parseCommand(["connect"]);
  assertEquals(cmd.command, "connect");
  assertEquals(cmd.subcommand, undefined);
});

// --- Config ---

Deno.test("Config: loads valid triggerfish.yaml", async () => {
  const { loadConfig } = await import("../../src/core/config.ts");
  const tmpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmpDir}/triggerfish.yaml`, `
models:
  primary:
    provider: anthropic
    model: claude-sonnet-4-20250514
  providers:
    anthropic:
      model: claude-sonnet-4-20250514
channels: {}
classification:
  mode: standard
`);
  const result = loadConfig(`${tmpDir}/triggerfish.yaml`);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.models.primary.provider, "anthropic");
    assertEquals(result.value.models.primary.model, "claude-sonnet-4-20250514");
  }
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("Config: rejects invalid YAML", async () => {
  const { loadConfig } = await import("../../src/core/config.ts");
  const tmpDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${tmpDir}/triggerfish.yaml`, "{{invalid yaml");
  const result = loadConfig(`${tmpDir}/triggerfish.yaml`);
  assertEquals(result.ok, false);
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("Config: validates required fields", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const result = validateConfig({});
  assertEquals(result.ok, false); // Missing models.primary
});

Deno.test("Config: accepts valid classification override", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const result = validateConfig({
    models: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
      providers: {
        anthropic: { model: "claude-sonnet-4-5" },
        openai: { model: "gpt-4o" },
      },
      classification: {
        RESTRICTED: { provider: "openai" },
      },
    },
  });
  assertEquals(result.ok, true);
});

Deno.test("Config: rejects unknown classification level", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const result = validateConfig({
    models: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
      providers: { anthropic: { model: "claude-sonnet-4-5" } },
      classification: {
        ULTRA_SECRET: { provider: "anthropic" },
      },
    },
  });
  assertEquals(result.ok, false);
  assert(result.ok === false && result.error.includes("unknown level"));
});

Deno.test("Config: rejects classification override with undeclared provider", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const result = validateConfig({
    models: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
      providers: { anthropic: { model: "claude-sonnet-4-5" } },
      classification: {
        RESTRICTED: { provider: "openai" },  // openai not in providers
      },
    },
  });
  assertEquals(result.ok, false);
  assert(result.ok === false && result.error.includes("not in models.providers"));
});

Deno.test("Config: accepts config without classification block (backward compat)", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const result = validateConfig({
    models: {
      primary: { provider: "anthropic", model: "claude-sonnet-4-5" },
      providers: { anthropic: { model: "claude-sonnet-4-5" } },
    },
  });
  assertEquals(result.ok, true);
});

// --- Daemon management ---

Deno.test("Daemon: detects current OS", async () => {
  const { detectDaemonManager } = await import("../../src/cli/daemon/daemon.ts");
  const manager = detectDaemonManager();
  assert(["launchd", "systemd", "windows-service", "unsupported"].includes(manager));
});

Deno.test("Daemon: generates launchd plist content", async () => {
  const { generateLaunchdPlist } = await import("../../src/cli/daemon/daemon.ts");
  const plist = generateLaunchdPlist({ binaryPath: "/usr/local/bin/triggerfish" });
  assertStringIncludes(plist, "dev.triggerfish.agent");
  assertStringIncludes(plist, "/usr/local/bin/triggerfish");
  assertStringIncludes(plist, "RunAtLoad");
});

Deno.test("Daemon: generates systemd unit content", async () => {
  const { generateSystemdUnit } = await import("../../src/cli/daemon/daemon.ts");
  const unit = generateSystemdUnit({ binaryPath: "/usr/local/bin/triggerfish" });
  assertStringIncludes(unit, "[Service]");
  assertStringIncludes(unit, "/usr/local/bin/triggerfish");
  assertStringIncludes(unit, "Restart=");
});

Deno.test("Daemon: logDir does not contain undefined", async () => {
  const { logDir } = await import("../../src/cli/daemon/daemon.ts");
  const dir = logDir();
  assert(!dir.includes("undefined"), `logDir() should not contain 'undefined', got: ${dir}`);
});

// --- Binary compilation (compile target exists) ---

Deno.test("deno.json: has compile task for standalone binary", async () => {
  const raw = await Deno.readTextFile("deno.json");
  const config = JSON.parse(raw);
  assertExists(config.tasks?.compile, "deno.json must have a 'compile' task");
});

// --- Makefile exists with required targets ---

Deno.test("Makefile: exists with build, install, release targets", async () => {
  const content = await Deno.readTextFile("Makefile");
  assertStringIncludes(content, "build:");
  assertStringIncludes(content, "install:");
  assertStringIncludes(content, "release:");
  assertStringIncludes(content, "test:");
});
