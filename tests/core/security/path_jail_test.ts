/**
 * Tests for src/core/security/path_jail.ts
 *
 * Covers the prefix-ambiguity fix (the core bug), traversal attempts,
 * symlink-style absolute injection, and the resolveWithinJail helper.
 */
import { assertEquals } from "@std/assert";
import {
  isRealPathWithinJail,
  isWithinJail,
  resolveWithinJail,
} from "../../../src/core/security/path_jail.ts";

// --- isWithinJail ---

Deno.test("isWithinJail: exact match returns true", () => {
  assertEquals(isWithinJail("/jail", "/jail"), true);
});

Deno.test("isWithinJail: direct child returns true", () => {
  assertEquals(isWithinJail("/jail/file.txt", "/jail"), true);
});

Deno.test("isWithinJail: deeply nested child returns true", () => {
  assertEquals(isWithinJail("/jail/a/b/c/file.txt", "/jail"), true);
});

Deno.test("isWithinJail: sibling path with shared prefix returns false (prefix-ambiguity)", () => {
  // CRITICAL: this is the bug the fix targets
  assertEquals(isWithinJail("/jailbreak/secret", "/jail"), false);
});

Deno.test("isWithinJail: sibling workspace with shared prefix returns false", () => {
  assertEquals(
    isWithinJail("/workspaces/foomalicious/data", "/workspaces/foo"),
    false,
  );
});

Deno.test("isWithinJail: parent directory returns false", () => {
  assertEquals(isWithinJail("/", "/jail"), false);
});

Deno.test("isWithinJail: unrelated absolute path returns false", () => {
  assertEquals(isWithinJail("/etc/passwd", "/jail"), false);
});

// --- resolveWithinJail ---

Deno.test("resolveWithinJail: simple relative path succeeds", () => {
  const result = resolveWithinJail("/jail", "notes.txt");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "/jail/notes.txt");
});

Deno.test("resolveWithinJail: nested relative path succeeds", () => {
  const result = resolveWithinJail("/jail", "subdir/file.ts");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "/jail/subdir/file.ts");
});

Deno.test("resolveWithinJail: ../ traversal is blocked", () => {
  const result = resolveWithinJail("/jail", "../escape.txt");
  assertEquals(result.ok, false);
});

Deno.test("resolveWithinJail: ../../etc/passwd traversal is blocked", () => {
  const result = resolveWithinJail("/jail/sub", "../../etc/passwd");
  assertEquals(result.ok, false);
});

Deno.test("resolveWithinJail: absolute path escaping jail is blocked", () => {
  const result = resolveWithinJail("/jail", "/etc/passwd");
  assertEquals(result.ok, false);
});

Deno.test("resolveWithinJail: explicit jailDir accepted when within jail", () => {
  const result = resolveWithinJail("/jail/sub", "file.txt", "/jail");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "/jail/sub/file.txt");
});

Deno.test("resolveWithinJail: explicit jailDir blocks path escaping to base but within parent", () => {
  // base=/jail/sub, relative=../other.txt → resolves to /jail/other.txt
  // jailDir=/jail → /jail/other.txt IS within /jail → should succeed
  const result = resolveWithinJail("/jail/sub", "../other.txt", "/jail");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "/jail/other.txt");
});

Deno.test("resolveWithinJail: explicit jailDir blocks escape past jail", () => {
  const result = resolveWithinJail("/jail/sub", "../../etc/passwd", "/jail");
  assertEquals(result.ok, false);
});

// --- isRealPathWithinJail (symlink resolution) ---

Deno.test("isRealPathWithinJail: existing path inside the jail returns true", async () => {
  const jail = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${jail}/sub`);
    assertEquals(isRealPathWithinJail(`${jail}/sub`, jail), true);
  } finally {
    await Deno.remove(jail, { recursive: true });
  }
});

Deno.test("isRealPathWithinJail: not-yet-existing path inside the jail returns true", async () => {
  const jail = await Deno.makeTempDir();
  try {
    assertEquals(
      isRealPathWithinJail(`${jail}/new-dir/new-file.txt`, jail),
      true,
    );
  } finally {
    await Deno.remove(jail, { recursive: true });
  }
});

Deno.test("isRealPathWithinJail: symlink pointing outside the jail returns false", async () => {
  const jail = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.symlink(outside, `${jail}/escape-link`);
    assertEquals(isRealPathWithinJail(`${jail}/escape-link`, jail), false);
    assertEquals(
      isRealPathWithinJail(`${jail}/escape-link/secret.txt`, jail),
      false,
    );
  } finally {
    await Deno.remove(jail, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("isRealPathWithinJail: existing file behind an outside-pointing symlink returns false", async () => {
  const jail = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "outside data");
    await Deno.symlink(outside, `${jail}/escape-link`);
    assertEquals(
      isRealPathWithinJail(`${jail}/escape-link/secret.txt`, jail),
      false,
    );
  } finally {
    await Deno.remove(jail, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("isRealPathWithinJail: symlink pointing inside the jail returns true", async () => {
  const jail = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${jail}/real-dir`);
    await Deno.symlink(`${jail}/real-dir`, `${jail}/inner-link`);
    assertEquals(
      isRealPathWithinJail(`${jail}/inner-link/file.txt`, jail),
      true,
    );
  } finally {
    await Deno.remove(jail, { recursive: true });
  }
});

Deno.test("isRealPathWithinJail: missing jail directory returns false", () => {
  assertEquals(
    isRealPathWithinJail(
      "/nonexistent-jail-xyz/file.txt",
      "/nonexistent-jail-xyz",
    ),
    false,
  );
});

Deno.test("isRealPathWithinJail: jail referenced through a symlink contains its real children", async () => {
  const real = await Deno.makeTempDir();
  const linkParent = await Deno.makeTempDir();
  try {
    await Deno.symlink(real, `${linkParent}/jail-link`);
    assertEquals(
      isRealPathWithinJail(
        `${linkParent}/jail-link/file.txt`,
        `${linkParent}/jail-link`,
      ),
      true,
    );
  } finally {
    await Deno.remove(linkParent, { recursive: true });
    await Deno.remove(real, { recursive: true });
  }
});
