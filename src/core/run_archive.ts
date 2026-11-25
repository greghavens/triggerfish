/** Verify and publish bounded private metadata archives without extracting paths. */

import { dirname, join, resolve } from "@std/path";
import { createHash } from "node:crypto";

export interface RunArchiveIdentity {
  readonly kind:
    | "sentinel"
    | "workflow"
    | "delegated"
    | "scheduled"
    | "owner_chat"
    | "team_delivery";
  readonly id: string;
  readonly runId: string;
  readonly revision?: number;
}

export interface RunArchiveArtifact {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RunArchiveManifest {
  readonly version: 1;
  readonly identity: RunArchiveIdentity;
  readonly artifacts: readonly RunArchiveArtifact[];
}

export interface VerifiedRunArchive {
  readonly manifest: RunArchiveManifest;
  readonly directory: string;
  artifactPath(name: string): string | undefined;
}

export interface RunArchiveVerification {
  readonly expectedKind?: RunArchiveIdentity["kind"];
  readonly permittedNames: readonly string[];
  readonly requiredNames?: readonly string[];
}

const manifestName = "manifest.json";
const maxManifestBytes = 64 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const maxArtifacts = 32;
const artifactName = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const identityPart = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid run archive manifest object.");
  }
  return raw as Record<string, unknown>;
}

function allowedKeys(raw: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function identityFor(raw: unknown): RunArchiveIdentity {
  const value = object(raw);
  const { kind, id, runId, revision } = value;
  if (
    !allowedKeys(value, ["kind", "id", "runId", "revision"]) ||
    (kind !== "sentinel" && kind !== "workflow" && kind !== "delegated" &&
      kind !== "scheduled" && kind !== "owner_chat" &&
      kind !== "team_delivery") ||
    typeof id !== "string" || !identityPart.test(id) ||
    typeof runId !== "string" || !identityPart.test(runId) ||
    (kind === "sentinel"
      ? typeof revision !== "number" || !Number.isSafeInteger(revision) ||
        revision < 1
      : revision !== undefined)
  ) throw new Error("Invalid run archive identity.");
  return {
    kind,
    id,
    runId,
    ...(revision !== undefined && { revision }),
  } as RunArchiveIdentity;
}

function namesFor(names: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const name of names) {
    if (
      typeof name !== "string" || !artifactName.test(name) ||
      name === manifestName || name.endsWith(".") || result.has(name)
    ) throw new Error("Invalid or duplicate run archive artifact name.");
    result.add(name);
  }
  if (result.size > maxArtifacts) {
    throw new Error("Run archive exceeds artifact count limit.");
  }
  return result;
}

function parseManifest(
  raw: unknown,
  options: RunArchiveVerification,
): RunArchiveManifest {
  const manifest = object(raw);
  if (
    !allowedKeys(manifest, ["version", "identity", "artifacts"]) ||
    manifest.version !== 1 || !Array.isArray(manifest.artifacts) ||
    !manifest.artifacts.length || manifest.artifacts.length > maxArtifacts
  ) throw new Error("Unsupported or invalid run archive manifest.");
  const identity = identityFor(manifest.identity);
  if (options.expectedKind && options.expectedKind !== identity.kind) {
    throw new Error("Run archive has the wrong kind.");
  }
  const permitted = namesFor(options.permittedNames);
  const required = namesFor(options.requiredNames ?? []);
  const seen = new Set<string>();
  let total = 0;
  const artifacts = manifest.artifacts.map((raw): RunArchiveArtifact => {
    const artifact = object(raw);
    const { name, bytes, sha256 } = artifact;
    if (
      !allowedKeys(artifact, ["name", "bytes", "sha256"]) ||
      typeof name !== "string" || !permitted.has(name) || seen.has(name) ||
      typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
      bytes > maxArtifactBytes || (total += bytes) > maxTotalBytes ||
      typeof sha256 !== "string" || !digest.test(sha256)
    ) throw new Error("Invalid run archive artifact declaration.");
    seen.add(name);
    return { name, bytes, sha256 };
  });
  if ([...required].some((name) => !seen.has(name))) {
    throw new Error("Run archive lacks a required artifact.");
  }
  return { version: 1, identity, artifacts };
}

async function directory(path: string, privateOnly = false) {
  const absolute = resolve(path);
  const info = await Deno.lstat(absolute);
  if (
    !info.isDirectory || info.isSymlink ||
    ((info.mode ?? 0) & (privateOnly ? 0o077 : 0o022)) !== 0
  ) {
    throw new Error("Run archive directory must be operator-controlled.");
  }
  for (
    let parent = dirname(absolute);
    dirname(parent) !== parent;
    parent = dirname(parent)
  ) {
    const ancestor = await Deno.lstat(parent);
    if (!ancestor.isDirectory || ancestor.isSymlink) {
      throw new Error("Run archive directory crosses an unsafe parent.");
    }
  }
}

function safeFile(info: Deno.FileInfo, limit: number): boolean {
  return info.isFile && !info.isSymlink && (info.nlink ?? 1) === 1 &&
    info.size <= limit;
}

async function withBoundedFile<T>(
  path: string,
  limit: number,
  work: (file: Deno.FsFile) => Promise<T>,
) {
  const before = await Deno.lstat(path);
  if (!safeFile(before, limit)) {
    throw new Error("Run archive artifact is not a bounded regular file.");
  }
  using source = await Deno.open(path, { read: true });
  const opened = await source.stat();
  const after = await Deno.lstat(path);
  if (
    !safeFile(opened, limit) || !safeFile(after, limit) ||
    before.ino !== opened.ino || before.dev !== opened.dev ||
    after.ino !== opened.ino || after.dev !== opened.dev
  ) throw new Error("Run archive artifact changed while opening.");
  return await work(source);
}

async function copyArtifact(
  sourcePath: string,
  targetPath: string,
  limit: number,
) {
  return await withBoundedFile(sourcePath, limit, async (source) => {
    using target = await Deno.open(targetPath, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    const hash = createHash("sha256");
    const buffer = new Uint8Array(64 * 1024);
    let bytes = 0;
    while (true) {
      const read = await source.read(buffer);
      if (read === null) break;
      bytes += read;
      if (bytes > limit) {
        throw new Error("Run archive artifact exceeds declared size.");
      }
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      for (let written = 0; written < read;) {
        written += await target.write(chunk.subarray(written));
      }
    }
    await target.sync();
    return { bytes, sha256: hash.digest("hex") };
  });
}

async function readManifest(path: string, options: RunArchiveVerification) {
  return await withBoundedFile(path, maxManifestBytes, async (file) => {
    const buffer = new Uint8Array(maxManifestBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer.subarray(length));
      if (read === null) break;
      length += read;
    }
    if (length > maxManifestBytes) {
      throw new Error("Run archive manifest exceeds its size limit.");
    }
    try {
      return parseManifest(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, length),
          ),
        ),
        options,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Run archive manifest is malformed.");
      }
      throw error;
    }
  });
}

/** Stage all bytes, reserve an absent destination, and publish the manifest last. */
export async function writeRunArchive(
  archivePath: string,
  identity: RunArchiveIdentity,
  artifacts: readonly { readonly name: string; readonly sourcePath: string }[],
  permittedNames: readonly string[],
  beforePublish?: (manifest: RunArchiveManifest) => void,
): Promise<RunArchiveManifest> {
  const destination = resolve(archivePath);
  const parent = dirname(destination);
  await directory(parent);
  const permitted = namesFor(permittedNames);
  namesFor(artifacts.map(({ name }) => name));
  if (!artifacts.length || artifacts.some(({ name }) => !permitted.has(name))) {
    throw new Error("Run archive contains an unsupported artifact.");
  }
  const normalized = identityFor(identity);
  const staging = await Deno.makeTempDir({
    dir: parent,
    prefix: ".run-archive-",
  });
  let reserved = false;
  try {
    const entries: RunArchiveArtifact[] = [];
    let remaining = maxTotalBytes;
    for (const { name, sourcePath } of artifacts) {
      const copied = await copyArtifact(
        sourcePath,
        join(staging, name),
        Math.min(remaining, maxArtifactBytes),
      );
      entries.push({ name, ...copied });
      remaining -= copied.bytes;
    }
    const manifest = parseManifest({
      version: 1,
      identity: normalized,
      artifacts: entries.sort((a, b) => a.name.localeCompare(b.name)),
    }, { permittedNames });
    const pending = join(staging, manifestName);
    {
      using written = await Deno.open(pending, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      const encoded = new TextEncoder().encode(JSON.stringify(manifest));
      for (let offset = 0; offset < encoded.length;) {
        offset += await written.write(encoded.subarray(offset));
      }
      await written.sync();
    }
    beforePublish?.(manifest);
    await Deno.mkdir(destination, { mode: 0o700 });
    reserved = true;
    for (const { name } of entries) {
      await Deno.rename(join(staging, name), join(destination, name));
    }
    await Deno.rename(pending, join(destination, manifestName));
    reserved = false;
    return manifest;
  } finally {
    if (reserved) await Deno.remove(destination, { recursive: true });
    await Deno.remove(staging, { recursive: true });
  }
}

/** Copy a fully verified package into private staging before passing it to restore. */
export async function withVerifiedRunArchive<T>(
  archivePath: string,
  stagingParent: string,
  options: RunArchiveVerification,
  work: (archive: VerifiedRunArchive) => T | Promise<T>,
): Promise<T> {
  const source = resolve(archivePath);
  await directory(source, true);
  await directory(stagingParent);
  const manifest = await readManifest(join(source, manifestName), options);
  const expected = new Set([
    manifestName,
    ...manifest.artifacts.map(({ name }) => name),
  ]);
  for await (const entry of Deno.readDir(source)) {
    if (!entry.isFile || entry.isSymlink || !expected.delete(entry.name)) {
      throw new Error("Run archive has an unexpected artifact.");
    }
  }
  if (expected.size) throw new Error("Run archive is incomplete.");
  const staging = await Deno.makeTempDir({
    dir: stagingParent,
    prefix: ".run-archive-",
  });
  try {
    const paths = new Map<string, string>();
    for (const artifact of manifest.artifacts) {
      const target = join(staging, artifact.name);
      const verified = await copyArtifact(
        join(source, artifact.name),
        target,
        artifact.bytes,
      );
      if (
        verified.bytes !== artifact.bytes || verified.sha256 !== artifact.sha256
      ) {
        throw new Error(
          "Run archive artifact does not match the declared digest and size.",
        );
      }
      paths.set(artifact.name, target);
    }
    return await work({
      manifest,
      directory: staging,
      artifactPath: (name) => paths.get(name),
    });
  } finally {
    await Deno.remove(staging, { recursive: true });
  }
}
