/** Atomically publish a prepared restore reservation on GNU Linux. */

const atCurrentDirectory = -100;
const renameNoReplace = 1;
const linuxErrno = {
  exists: 17,
  invalid: 22,
  unimplemented: 38,
  unsupported: 95,
} as const;

function openLinuxRename() {
  try {
    return Deno.dlopen("libc.so.6", {
      renameat2: {
        parameters: ["i32", "buffer", "i32", "buffer", "u32"],
        result: "i32",
      },
      __errno_location: { parameters: [], result: "pointer" },
    });
  } catch {
    // The confined runtime or platform may have no usable libc binding.
    return undefined;
  }
}

/** False means the exclusive mkdir fallback is needed. A collision throws. */
export function publishSentinelRestoreReservation(
  prepared: string,
  destination: string,
): boolean {
  if (Deno.build.os !== "linux") return false;
  const library = openLinuxRename();
  if (!library) return false;
  try {
    const encode = new TextEncoder();
    const old = encode.encode(`${prepared}\0`);
    const next = encode.encode(`${destination}\0`);
    const errno = library.symbols.__errno_location();
    if (!errno) throw new Error("Unable to inspect restore reservation errors");
    const errnoView = new Deno.UnsafePointerView(errno);
    if (
      library.symbols.renameat2(
        atCurrentDirectory,
        old,
        atCurrentDirectory,
        next,
        renameNoReplace,
      ) === 0
    ) return true;
    const error = errnoView.getInt32();
    if (error === linuxErrno.exists) {
      throw new Deno.errors.AlreadyExists("The Sentinel case already exists");
    }
    if (
      error === linuxErrno.unimplemented || error === linuxErrno.unsupported ||
      error === linuxErrno.invalid
    ) return false;
    throw new Error(
      `Unable to publish Sentinel restore reservation (${error})`,
    );
  } finally {
    library.close();
  }
}
