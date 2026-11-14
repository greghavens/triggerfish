/** Bounded SOCKSv5 CONNECT parsing for the local egress proxy. */

/** A requested TCP destination, before policy validation. */
export interface EgressTarget {
  readonly hostname: string;
  readonly port: number;
}

/** Read exactly size bytes without consuming the following protocol frame. */
async function readBytes(
  conn: Deno.Conn,
  size: number,
): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const count = await conn.read(bytes.subarray(offset));
    if (count === null) return null;
    offset += count;
  }
  return bytes;
}

/** Write a complete protocol frame, handling partial socket writes. */
export async function writeEgressFrame(
  conn: Deno.Conn,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

/** Negotiate the unauthenticated, loopback-only SOCKSv5 transport. */
async function negotiateMethod(conn: Deno.Conn): Promise<boolean> {
  const header = await readBytes(conn, 2);
  if (!header || header[0] !== 5 || header[1] === 0) return false;
  const methods = await readBytes(conn, header[1]);
  const allowed = methods?.includes(0) ?? false;
  await writeEgressFrame(conn, new Uint8Array([5, allowed ? 0 : 255]));
  return allowed;
}

/** Decode one bounded address frame. No DNS resolution occurs here. */
async function readHostname(
  conn: Deno.Conn,
  type: number,
): Promise<string | null> {
  if (type === 1) return (await readBytes(conn, 4))?.join(".") ?? null;
  if (type === 4) {
    const bytes = await readBytes(conn, 16);
    if (!bytes) return null;
    return Array.from(
      { length: 8 },
      (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16),
    ).join(":");
  }
  if (type !== 3) return null;
  const length = await readBytes(conn, 1);
  if (!length || length[0] === 0) return null;
  const bytes = await readBytes(conn, length[0]);
  if (!bytes) return null;
  const hostname = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return /^[a-z0-9._-]+$/i.test(hostname) ? hostname : null;
}

/** Read a SOCKSv5 CONNECT target. BIND and UDP ASSOCIATE are rejected. */
export async function readEgressTarget(
  conn: Deno.Conn,
): Promise<EgressTarget | null> {
  if (!await negotiateMethod(conn)) return null;
  const header = await readBytes(conn, 4);
  if (!header || header[0] !== 5 || header[1] !== 1 || header[2] !== 0) {
    return null;
  }
  const hostname = await readHostname(conn, header[3]);
  if (hostname === null) return null;
  const portBytes = await readBytes(conn, 2);
  if (!portBytes) return null;
  const port = (portBytes[0] << 8) | portBytes[1];
  return port > 0 ? { hostname, port } : null;
}

/** Send a SOCKSv5 success or policy-denied response. */
export function replyEgressTarget(
  conn: Deno.Conn,
  allowed: boolean,
): Promise<void> {
  return writeEgressFrame(
    conn,
    new Uint8Array([5, allowed ? 0 : 2, 0, 1, 0, 0, 0, 0, 0, 0]),
  );
}
