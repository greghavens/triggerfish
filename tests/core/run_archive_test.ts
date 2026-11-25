import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  withVerifiedRunArchive,
  writeRunArchive,
} from "../../src/core/run_archive.ts";

const identity = {
  kind: "sentinel" as const,
  id: "case-a",
  runId: "run-fixture",
  revision: 7,
};
const permittedNames = ["sentinel.json", "sentinel-assessment.db"];
const requiredNames = [...permittedNames];
const verification = {
  expectedKind: "sentinel" as const,
  permittedNames,
  requiredNames,
};

async function setup(root: string, archive: string) {
  const sources = permittedNames.map((name) => ({
    name,
    sourcePath: join(root, name),
  }));
  for (const { name, sourcePath } of sources) {
    await Deno.writeTextFile(sourcePath, name);
  }
  const manifest = await writeRunArchive(
    archive,
    identity,
    sources,
    permittedNames,
  );
  return { sources, manifest };
}

Deno.test("Run archive publishes one exact verified private package and removes staging", async () => {
  const root = await Deno.makeTempDir();
  const archive = join(root, "package");
  try {
    const { manifest } = await setup(root, archive);
    assertEquals(manifest.identity, identity);
    assertEquals(manifest.artifacts.map(({ name }) => name), [
      "sentinel-assessment.db",
      "sentinel.json",
    ]);
    const returned = await withVerifiedRunArchive(
      archive,
      root,
      verification,
      async (verified) => {
        assertEquals(verified.manifest, manifest);
        assertEquals(verified.artifactPath("../sentinel.json"), undefined);
        for (const name of permittedNames) {
          const path = verified.artifactPath(name);
          assert(path);
          assertEquals(await Deno.readTextFile(path), name);
          if (Deno.build.os !== "windows") {
            assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
          }
        }
        await Deno.writeTextFile(
          join(archive, "sentinel.json"),
          "changed after staging",
        );
        assertEquals(
          await Deno.readTextFile(verified.artifactPath("sentinel.json")!),
          "sentinel.json",
        );
        return verified.directory;
      },
    );
    await assertRejects(() => Deno.stat(returned), Deno.errors.NotFound);
    await assertRejects(() =>
      withVerifiedRunArchive(archive, root, verification, () => {
        throw new Error("Changed package must not reach restore.");
      })
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Run archives reject incomplete, ambiguous, and corrupt packages before restore", async () => {
  const root = await Deno.makeTempDir();
  let callbacks = 0;
  try {
    const attempts = [
      (archive: string) =>
        Deno.writeTextFile(join(archive, "sentinel.json"), "SENTINEL.JSON"),
      (archive: string) => Deno.remove(join(archive, "sentinel.json")),
      (archive: string) =>
        Deno.writeTextFile(join(archive, "unknown"), "surprise"),
      async (archive: string) => {
        const linked = join(archive, "sentinel.json");
        await Deno.remove(linked);
        await Deno.symlink(join(root, "sentinel.json"), linked);
      },
      async (archive: string) => {
        const linked = join(archive, "sentinel.json");
        await Deno.remove(linked);
        const original = join(root, "hardlink-source");
        await Deno.writeTextFile(original, "sentinel.json");
        await Deno.link(original, linked);
      },
      async (archive: string) => {
        const location = join(archive, "manifest.json");
        const manifest = JSON.parse(await Deno.readTextFile(location));
        manifest.artifacts[0].name = "../sentinel.json";
        await Deno.writeTextFile(location, JSON.stringify(manifest));
      },
      async (archive: string) => {
        const location = join(archive, "manifest.json");
        const manifest = JSON.parse(await Deno.readTextFile(location));
        manifest.artifacts[0].bytes = 65 * 1024 * 1024;
        await Deno.writeTextFile(location, JSON.stringify(manifest));
      },
    ];
    for (const [index, mutate] of attempts.entries()) {
      const path = join(root, `corrupt-${index}`);
      await setup(root, path);
      await mutate(path);
      await assertRejects(() =>
        withVerifiedRunArchive(path, root, verification, () => {
          callbacks++;
        })
      );
    }
    assertEquals(callbacks, 0);
    const stages = [];
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith(".run-archive-")) stages.push(entry.name);
    }
    assertEquals(stages, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Archive writers never replace an existing destination or follow symlinks", async () => {
  const root = await Deno.makeTempDir();
  const archive = join(root, "package");
  try {
    const { sources, manifest } = await setup(root, archive);
    await Deno.writeTextFile(sources[0].sourcePath, "updated source");
    await assertRejects(
      () => writeRunArchive(archive, identity, sources, permittedNames),
      Deno.errors.AlreadyExists,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(archive, "manifest.json"))),
      manifest,
    );
    assertEquals(
      await Deno.readTextFile(join(archive, "sentinel.json")),
      "sentinel.json",
    );
    const alias = join(root, "alias");
    await Deno.symlink(archive, alias);
    await assertRejects(() =>
      withVerifiedRunArchive(alias, root, verification, () => undefined)
    );
    const linkedSource = join(root, "linked-file");
    await Deno.symlink(sources[0].sourcePath, linkedSource);
    await assertRejects(() =>
      writeRunArchive(join(root, "not-created"), identity, [{
        name: "sentinel.json",
        sourcePath: linkedSource,
      }], permittedNames)
    );
    await assertRejects(
      () => Deno.stat(join(root, "not-created")),
      Deno.errors.NotFound,
    );
    const simultaneous = join(root, "simultaneous");
    const competing = await Promise.allSettled([
      writeRunArchive(simultaneous, identity, sources, permittedNames),
      writeRunArchive(simultaneous, identity, sources, permittedNames),
    ]);
    assertEquals(
      competing.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    await withVerifiedRunArchive(
      simultaneous,
      root,
      verification,
      () => undefined,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
