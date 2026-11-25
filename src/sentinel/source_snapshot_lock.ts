/** Serialize archive publication and audit across gateway processes. */
import { dirname, join } from "@std/path";

export function assertOperatorSourceDirectoryInfo(info: Deno.FileInfo): void {
  if (
    !info.isDirectory || info.isSymlink ||
    (info.mode !== null && (info.mode & 0o022) !== 0)
  ) {
    throw new Error(
      "Sentinel source archive must be an operator-controlled directory",
    );
  }
}

export async function operatorSourceDirectoryExists(
  path: string,
): Promise<boolean> {
  try {
    assertOperatorSourceDirectoryInfo(await Deno.lstat(path));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export function assertOperatorSourceSnapshotInfo(info: Deno.FileInfo): void {
  if (
    !info.isFile || info.isSymlink || (info.nlink ?? 1) !== 1 ||
    (info.mode !== null && (info.mode & 0o022) !== 0)
  ) {
    throw new Error(
      "Sentinel source snapshot must be an operator-controlled regular file",
    );
  }
}

export async function assertOperatorSourceSnapshot(
  path: string,
): Promise<void> {
  assertOperatorSourceSnapshotInfo(await Deno.lstat(path));
}

export async function withSentinelSourceSnapshotLock<T>(
  baseDir: string,
  exclusive: boolean,
  operation: () => T | Promise<T>,
): Promise<T> {
  const path = join(baseDir, "data", "sentinel-source-snapshots.lock");
  await Deno.mkdir(dirname(path), { mode: 0o700, recursive: true });
  using lock = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await lock.lock(exclusive);
  return await operation();
}
