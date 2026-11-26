/** Build a bounded, deterministic ZIP containing inert finding reports and attachment manifests. */
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
export const SENTINEL_FINDING_ZIP_END_BYTES = 22;
const encoder = new TextEncoder();
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

export interface SentinelFindingZipRecord {
  readonly markdown: string;
  readonly manifests: readonly string[];
}

function findingName(index: number): string {
  return `finding-${String(index + 1).padStart(2, "0")}`;
}

function recordEntries(record: SentinelFindingZipRecord, index: number) {
  const name = findingName(index);
  return [
    { name: `${name}.md`, body: record.markdown },
    ...record.manifests.map((body, link) => ({
      name: `evidence/${name}/link-${link + 1}/manifest.json`,
      body,
    })),
  ];
}

export function sentinelFindingZipRecordBytes(
  index: number,
  record: SentinelFindingZipRecord,
) {
  return recordEntries(record, index).reduce(
    (bytes, entry) =>
      bytes + LOCAL_HEADER + CENTRAL_HEADER + 2 * entry.name.length +
      encoder.encode(entry.body).byteLength,
    0,
  );
}

export function encodeSentinelFindingZip(
  records: readonly SentinelFindingZipRecord[],
  maxBytes: number,
  offset = 0,
): ArrayBuffer | undefined {
  const entries = records.flatMap((record, index) =>
    recordEntries(record, offset + index).map(({ name, body }) => ({
      name: encoder.encode(name),
      body: encoder.encode(body),
    }))
  );
  if (entries.length > 0xffff) return;
  let localSize = 0;
  let centralSize = 0;
  for (const { name, body } of entries) {
    localSize += LOCAL_HEADER + name.length + body.length;
    centralSize += CENTRAL_HEADER + name.length;
  }
  const size = localSize + centralSize + SENTINEL_FINDING_ZIP_END_BYTES;
  if (size > maxBytes) return;
  const bytes = new Uint8Array(size);
  const zip = new DataView(bytes.buffer);
  let local = 0;
  let central = localSize;
  for (const { name, body } of entries) {
    const checksum = crc32(body);
    // Local file header. Flags and compression are zero (stored).
    zip.setUint32(local, 0x04034b50, true);
    zip.setUint16(local + 4, 20, true);
    zip.setUint16(local + 12, DOS_EPOCH_DATE, true);
    zip.setUint32(local + 14, checksum, true);
    zip.setUint32(local + 18, body.length, true);
    zip.setUint32(local + 22, body.length, true);
    zip.setUint16(local + 26, name.length, true);
    bytes.set(name, local + LOCAL_HEADER);
    bytes.set(body, local + LOCAL_HEADER + name.length);

    // Central directory entry, linked to its local header offset.
    zip.setUint32(central, 0x02014b50, true);
    zip.setUint16(central + 4, 20, true);
    zip.setUint16(central + 6, 20, true);
    zip.setUint16(central + 14, DOS_EPOCH_DATE, true);
    zip.setUint32(central + 16, checksum, true);
    zip.setUint32(central + 20, body.length, true);
    zip.setUint32(central + 24, body.length, true);
    zip.setUint16(central + 28, name.length, true);
    zip.setUint32(central + 42, local, true);
    bytes.set(name, central + CENTRAL_HEADER);

    local += LOCAL_HEADER + name.length + body.length;
    central += CENTRAL_HEADER + name.length;
  }
  zip.setUint32(central, 0x06054b50, true);
  zip.setUint16(central + 8, entries.length, true);
  zip.setUint16(central + 10, entries.length, true);
  zip.setUint32(central + 12, centralSize, true);
  zip.setUint32(central + 16, localSize, true);
  return bytes.buffer;
}
