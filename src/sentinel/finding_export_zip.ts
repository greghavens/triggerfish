/** Build a bounded, deterministic ZIP with one inert Markdown entry per finding. */
import { Buffer } from "node:buffer";

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const DOS_EPOCH_DATE = 33;
const ZIP_CRC_POLYNOMIAL = 0xedb88320;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? ZIP_CRC_POLYNOMIAL : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeSentinelFindingZip(
  markdown: readonly string[],
  maxBytes: number,
  offset = 0,
): string | undefined {
  const entries = markdown.map((content, index) => ({
    name: Buffer.from(
      `finding-${String(offset + index + 1).padStart(2, "0")}.md`,
    ),
    body: Buffer.from(content),
  }));
  let localSize = 0;
  let centralSize = 0;
  for (const { name, body } of entries) {
    localSize += LOCAL_HEADER + name.length + body.length;
    centralSize += CENTRAL_HEADER + name.length;
  }
  const size = localSize + centralSize + END_RECORD;
  if (size > maxBytes) return;
  const zip = Buffer.alloc(size);
  let local = 0;
  let central = localSize;
  for (const { name, body } of entries) {
    const checksum = crc32(body);
    // Local file header. Flags and compression are zero (stored).
    zip.writeUInt32LE(0x04034b50, local);
    zip.writeUInt16LE(20, local + 4);
    zip.writeUInt16LE(DOS_EPOCH_DATE, local + 12);
    zip.writeUInt32LE(checksum, local + 14);
    zip.writeUInt32LE(body.length, local + 18);
    zip.writeUInt32LE(body.length, local + 22);
    zip.writeUInt16LE(name.length, local + 26);
    name.copy(zip, local + LOCAL_HEADER);
    body.copy(zip, local + LOCAL_HEADER + name.length);

    // Central directory entry, linked to its local header offset.
    zip.writeUInt32LE(0x02014b50, central);
    zip.writeUInt16LE(20, central + 4);
    zip.writeUInt16LE(20, central + 6);
    zip.writeUInt16LE(DOS_EPOCH_DATE, central + 14);
    zip.writeUInt32LE(checksum, central + 16);
    zip.writeUInt32LE(body.length, central + 20);
    zip.writeUInt32LE(body.length, central + 24);
    zip.writeUInt16LE(name.length, central + 28);
    zip.writeUInt32LE(local, central + 42);
    name.copy(zip, central + CENTRAL_HEADER);

    local += LOCAL_HEADER + name.length + body.length;
    central += CENTRAL_HEADER + name.length;
  }
  zip.writeUInt32LE(0x06054b50, central);
  zip.writeUInt16LE(entries.length, central + 8);
  zip.writeUInt16LE(entries.length, central + 10);
  zip.writeUInt32LE(centralSize, central + 12);
  zip.writeUInt32LE(localSize, central + 16);
  return zip.toString("base64");
}
