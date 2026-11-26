/** Bounded, in-memory import of a workspace skill package. */

import { Buffer } from "node:buffer";
// @deno-types="npm:@types/yauzl@3.4.0"
import { fromBufferPromise } from "yauzl";
import {
  parseSkillReferences,
  validSkillReferencePath,
} from "./reference_documents.ts";

export const maxSkillZipBytes = 65_536;
const maxExpandedBytes = 32_768;

/** ZIP checksums use the reflected IEEE CRC-32 polynomial. */
export function skillZipChecksum(bytes: Uint8Array): number {
  let remainder = 0xffff_ffff;
  for (const byte of bytes) {
    remainder ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      remainder = (remainder >>> 1) ^ (remainder & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (remainder ^ 0xffff_ffff) >>> 0;
}

/** Decode one root SKILL.md plus text references, with an optional skill-name wrapper. */
export async function readSkillZip(bytes: Uint8Array, name: string) {
  if (bytes.length > maxSkillZipBytes) return;
  try {
    const archive = await fromBufferPromise(Buffer.from(bytes), {
      strictFileNames: true,
      validateEntrySizes: true,
    });
    try {
      if (archive.entryCount < 1 || archive.entryCount > 32) return;
      const entries = new Set<string>();
      const references: { path: string; content: string }[] = [];
      const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const wrapper = name + "/";
      let wrapped: boolean | undefined;
      let markdown: string | undefined;
      let size = 0;
      for await (const entry of archive.eachEntry()) {
        const savedPath = entry.fileName;
        const isWrapped = savedPath.startsWith(wrapper);
        if (
          entries.has(savedPath) ||
          (wrapped !== undefined && wrapped !== isWrapped)
        ) return;
        wrapped = isWrapped;
        entries.add(savedPath);
        const path = isWrapped ? savedPath.slice(wrapper.length) : savedPath;
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (savedPath.endsWith("/")) {
          if (
            entry.uncompressedSize !== 0 || (kind !== 0 && kind !== 0o040000) ||
            (path !== "" && !validSkillReferencePath(path + "index.txt"))
          ) return;
          continue;
        }
        const isMarkdown = path === "SKILL.md";
        if (
          (!isMarkdown && !validSkillReferencePath(path)) ||
          (kind !== 0 && kind !== 0o100000) ||
          ((entry.externalFileAttributes >>> 16) & 0o111) !== 0 ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
          entry.uncompressedSize > (isMarkdown ? maxExpandedBytes : 8192)
        ) return;
        size += entry.uncompressedSize;
        if (size > maxExpandedBytes) return;

        const stream = await archive.openReadStreamPromise(entry);
        const chunks: Uint8Array[] = [];
        let count = 0;
        for await (const chunk of stream) {
          count += chunk.length;
          if (count > entry.uncompressedSize) return;
          chunks.push(chunk);
        }
        if (count !== entry.uncompressedSize) return;
        const payload = Buffer.concat(chunks, count);
        if (skillZipChecksum(payload) !== entry.crc32) return;
        const content = utf8.decode(payload);
        if (isMarkdown) markdown = content;
        else references.push({ path, content });
      }
      const files = parseSkillReferences(references);
      if (markdown && files) return { markdown, files };
    } finally {
      archive.close();
    }
  } catch {
    // Malformed or unsupported packages are indistinguishable from a missing proposal.
  }
}
